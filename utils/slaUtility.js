/**
 * slaUtility.js
 *
 * SLA / TAT (Turn-Around-Time) enforcement engine.
 *
 * In real courier companies, every shipment has a committed delivery SLA based on
 * service type (Express, Surface, Air, etc.) and distance. If a shipment crosses
 * its SLA deadline without being delivered, it's flagged as "breached" and
 * internal alerts are sent to branch admins / partner admins.
 *
 * This utility provides:
 *   1. setSLA(shipment, serviceType, transitDays) — sets slaHours & slaDeadline
 *   2. checkAndMarkBreaches() — scans active shipments, marks breaches, fires alerts
 *   3. startSLAMonitor(intervalMinutes) — starts a background interval timer
 *   4. stopSLAMonitor() — stops the background timer
 *   5. getSLAStats(query) — returns SLA compliance statistics
 *
 * SLA defaults by service type (in hours):
 *   EXPRESS    → 24 hours
 *   AIR        → 48 hours
 *   SURFACE    → 72 hours (default)
 *   SAME_DAY   → 8 hours
 *   NEXT_DAY   → 24 hours
 *   BULK       → 120 hours (5 days)
 */

const Shipment = require('../models/Shipment');
const Exception = require('../models/Exception');
const { generateExceptionId } = require('./idGenerator');
const { logAudit } = require('./auditLogger');
const { notifySLABreach } = require('./notificationHelper');

// ─── SLA Configuration ────────────────────────────────────────────
const SLA_DEFAULTS = {
    EXPRESS: 24,
    AIR: 48,
    SURFACE: 72,
    SAME_DAY: 8,
    NEXT_DAY: 24,
    BULK: 120,
    STANDARD: 72
};

// Terminal statuses — shipment is no longer "active" for SLA purposes
const TERMINAL_STATUSES = ['delivered', 'DELIVERED', 'rto', 'RTO', 'cancelled', 'CANCELLED', 'returned'];

// Statuses that are still in-transit / active
const ACTIVE_STATUSES = [
    'booked', 'BOOKED', 'picked_up', 'PICKED_UP',
    'in_transit', 'IN_TRANSIT', 'arrived_at_branch', 'ARRIVED_AT_BRANCH',
    'not_scheduled', 'NOT_SCHEDULED', 'out_for_delivery', 'OUT_FOR_DELIVERY',
    'delivery_failed', 'DELIVERY_FAILED', 'rto_initiated', 'RTO_INITIATED'
];

let slaMonitorInterval = null;

/**
 * Set SLA deadline on a shipment based on service type and/or transit days.
 *
 * @param {Object} shipment - Mongoose Shipment document (mutated in place)
 * @param {String} serviceType - EXPRESS, SURFACE, AIR, etc.
 * @param {Number} transitDays - Estimated transit days from autoRouter
 * @returns {Object} { slaHours, slaDeadline }
 */
function setSLA(shipment, serviceType, transitDays = null) {
    // Determine SLA hours: transit days override if provided (more accurate)
    let slaHours;

    if (transitDays && transitDays > 0) {
        slaHours = transitDays * 24;
    } else {
        const svc = (serviceType || shipment.serviceType || 'SURFACE').toUpperCase();
        slaHours = SLA_DEFAULTS[svc] || SLA_DEFAULTS.SURFACE;
    }

    // Minimum SLA of 8 hours (same-day minimum)
    slaHours = Math.max(slaHours, 8);

    const slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000);

    shipment.slaHours = slaHours;
    shipment.slaDeadline = slaDeadline;
    shipment.slaBreached = false;
    shipment.slaBreachedAt = null;

    return { slaHours, slaDeadline };
}

/**
 * Check a single shipment for SLA breach.
 * Returns true if the shipment was newly marked as breached.
 *
 * @param {Object} shipment - Mongoose Shipment document
 * @param {Object|null} user - User context for audit/notification (null for system)
 * @returns {Boolean} true if newly breached
 */
async function checkShipmentSLA(shipment, user = null) {
    // Skip if already breached or no deadline set
    if (shipment.slaBreached) return false;
    if (!shipment.slaDeadline) return false;

    // Skip terminal statuses
    if (TERMINAL_STATUSES.includes(shipment.status)) return false;

    const now = new Date();

    // Check if deadline has passed
    if (now > shipment.slaDeadline) {
        const delayHours = Math.round((now - shipment.slaDeadline) / (60 * 60 * 1000));

        // Mark as breached
        shipment.slaBreached = true;
        shipment.slaBreachedAt = now;

        await shipment.save();

        // Create an exception for the SLA breach
        try {
            const exception = new Exception({
                exceptionId: generateExceptionId(),
                type: 'SLA_BREACH',
                title: `SLA Breach - AWB ${shipment.awb}`,
                severity: delayHours > 48 ? 'CRITICAL' : delayHours > 24 ? 'HIGH' : 'MEDIUM',
                status: 'OPEN',
                shipmentId: shipment._id,
                awb: shipment.awb,
                branchId: shipment.currentBranch || shipment.originBranch || shipment.branchId,
                partnerId: shipment.partnerId,
                description: `Shipment ${shipment.awb} has breached SLA. Deadline: ${shipment.slaDeadline.toISOString()}, Delay: ${delayHours} hours. Current status: ${shipment.status}`,
                reportedBy: user?._id || null,
                createdBy: user?._id || null
            });
            await exception.save();
        } catch (excErr) {
            console.error(`[slaUtility] Failed to create SLA breach exception for ${shipment.awb}:`, excErr.message);
        }

        // Fire-and-forget: notify branch admin
        try {
            await notifySLABreach(
                shipment,
                {
                    slaDeadline: shipment.slaDeadline.toISOString(),
                    delayHours
                },
                user
            );
        } catch (notifErr) {
            console.error(`[slaUtility] Failed to send SLA breach notification for ${shipment.awb}:`, notifErr.message);
        }

        // Audit log
        try {
            logAudit({
                action: 'SLA_BREACH_DETECTED',
                entity: 'Shipment',
                entityId: shipment._id,
                awb: shipment.awb,
                userId: user?._id || null,
                userRole: 'SYSTEM',
                details: {
                    slaDeadline: shipment.slaDeadline,
                    delayHours,
                    currentStatus: shipment.status
                }
            });
        } catch (auditErr) {
            console.error(`[slaUtility] Failed to log SLA breach audit for ${shipment.awb}:`, auditErr.message);
        }

        return true;
    }

    return false;
}

/**
 * Scan all active shipments and mark SLA breaches.
 * This is the main function called by the background monitor.
 *
 * @param {Object|null} user - User context (null for system-generated)
 * @returns {Object} { checked, breached, errors }
 */
async function checkAndMarkBreaches(user = null) {
    const startTime = Date.now();
    let checked = 0;
    let breached = 0;
    let errors = 0;

    try {
        // Find all active shipments with SLA deadlines that haven't been breached yet
        const query = {
            slaBreached: { $ne: true },
            slaDeadline: { $exists: true, $ne: null },
            status: { $nin: TERMINAL_STATUSES }
        };

        const shipments = await Shipment.find(query)
            .select('awb status slaDeadline slaBreached slaBreachedAt currentBranch originBranch partnerId branchId')
            .lean();

        checked = shipments.length;

        // Filter to only those actually breached (deadline < now)
        const now = new Date();
        const breachedShipments = shipments.filter(s =>
            s.slaDeadline && new Date(s.slaDeadline) < now
        );

        // Process each breached shipment
        for (const s of breachedShipments) {
            try {
                const delayHours = Math.round((now - new Date(s.slaDeadline)) / (60 * 60 * 1000));

                // Update the shipment
                await Shipment.updateOne(
                    { _id: s._id, slaBreached: { $ne: true } },
                    {
                        $set: {
                            slaBreached: true,
                            slaBreachedAt: now
                        }
                    }
                );

                breached++;

                // Create exception (fire-and-forget)
                try {
                    const exception = new Exception({
                        exceptionId: generateExceptionId(),
                        type: 'SLA_BREACH',
                        title: `SLA Breach - AWB ${s.awb}`,
                        severity: delayHours > 48 ? 'CRITICAL' : delayHours > 24 ? 'HIGH' : 'MEDIUM',
                        status: 'OPEN',
                        shipmentId: s._id,
                        awb: s.awb,
                        branchId: s.currentBranch || s.originBranch || s.branchId,
                        partnerId: s.partnerId,
                        description: `Shipment ${s.awb} has breached SLA. Deadline: ${new Date(s.slaDeadline).toISOString()}, Delay: ${delayHours} hours. Current status: ${s.status}`,
                        reportedBy: user?._id || null,
                        createdBy: user?._id || null
                    });
                    await exception.save();
                } catch (excErr) {
                    console.error(`[slaUtility] Exception creation failed for ${s.awb}:`, excErr.message);
                }

                // Notify (fire-and-forget)
                try {
                    await notifySLABreach(
                        s,
                        {
                            slaDeadline: new Date(s.slaDeadline).toISOString(),
                            delayHours
                        },
                        user
                    );
                } catch (notifErr) {
                    console.error(`[slaUtility] Notification failed for ${s.awb}:`, notifErr.message);
                }

                // Audit log (fire-and-forget)
                try {
                    logAudit({
                        action: 'SLA_BREACH_DETECTED',
                        entity: 'Shipment',
                        entityId: s._id,
                        awb: s.awb,
                        userId: user?._id || null,
                        userRole: 'SYSTEM',
                        details: {
                            slaDeadline: s.slaDeadline,
                            delayHours,
                            currentStatus: s.status
                        }
                    });
                } catch (auditErr) {
                    console.error(`[slaUtility] Audit log failed for ${s.awb}:`, auditErr.message);
                }
            } catch (err) {
                errors++;
                console.error(`[slaUtility] Error processing SLA breach for ${s.awb}:`, err.message);
            }
        }

        const elapsed = Date.now() - startTime;
        console.log(`[slaUtility] SLA check complete: ${checked} checked, ${breached} newly breached, ${errors} errors (${elapsed}ms)`);

        return { checked, breached, errors };
    } catch (error) {
        console.error('[slaUtility] Fatal error in checkAndMarkBreaches:', error.message);
        return { checked, breached, errors: errors + 1 };
    }
}

/**
 * Start the background SLA monitor.
 * Runs checkAndMarkBreaches() at the specified interval.
 *
 * @param {Number} intervalMinutes - Check interval in minutes (default: 15)
 */
function startSLAMonitor(intervalMinutes = 15) {
    if (slaMonitorInterval) {
        console.log('[slaUtility] SLA monitor is already running');
        return;
    }

    const intervalMs = intervalMinutes * 60 * 1000;

    console.log(`[slaUtility] Starting SLA monitor (every ${intervalMinutes} minutes)`);

    // Run immediately on start
    checkAndMarkBreaches().catch(err => {
        console.error('[slaUtility] Initial SLA check failed:', err.message);
    });

    // Schedule periodic checks
    slaMonitorInterval = setInterval(() => {
        checkAndMarkBreaches().catch(err => {
            console.error('[slaUtility] Periodic SLA check failed:', err.message);
        });
    }, intervalMs);
}

/**
 * Stop the background SLA monitor.
 */
function stopSLAMonitor() {
    if (slaMonitorInterval) {
        clearInterval(slaMonitorInterval);
        slaMonitorInterval = null;
        console.log('[slaUtility] SLA monitor stopped');
    }
}

/**
 * Get SLA compliance statistics for a given scope.
 *
 * @param {Object} query - MongoDB query filter (partnerId, branchId, etc.)
 * @returns {Object} SLA stats
 */
async function getSLAStats(query = {}) {
    const baseQuery = { slaDeadline: { $exists: true, $ne: null } };

    const [total, breached, delivered, deliveredOnTime, deliveredLate] = await Promise.all([
        Shipment.countDocuments({ ...baseQuery, ...query }),
        Shipment.countDocuments({ ...baseQuery, ...query, slaBreached: true }),
        Shipment.countDocuments({ ...baseQuery, ...query, status: { $in: ['delivered', 'DELIVERED'] } }),
        Shipment.countDocuments({
            ...baseQuery, ...query,
            status: { $in: ['delivered', 'DELIVERED'] },
            slaBreached: { $ne: true }
        }),
        Shipment.countDocuments({
            ...baseQuery, ...query,
            status: { $in: ['delivered', 'DELIVERED'] },
            slaBreached: true
        })
    ]);

    const active = total - delivered;
    const complianceRate = delivered > 0 ? Math.round((deliveredOnTime / delivered) * 10000) / 100 : 0;
    const breachRate = total > 0 ? Math.round((breached / total) * 10000) / 100 : 0;

    return {
        total,
        active,
        delivered,
        deliveredOnTime,
        deliveredLate,
        breached,
        complianceRate,
        breachRate
    };
}

/**
 * Get list of shipments that are approaching SLA breach (within X hours).
 *
 * @param {Number} withinHours - Hours until deadline (default: 6)
 * @param {Object} query - Additional query filter
 * @returns {Array} Shipments approaching breach
 */
async function getApproachingBreaches(withinHours = 6, query = {}) {
    const now = new Date();
    const threshold = new Date(now.getTime() + withinHours * 60 * 60 * 1000);

    return Shipment.find({
        slaBreached: { $ne: true },
        slaDeadline: { $exists: true, $ne: null, $gte: now, $lte: threshold },
        status: { $nin: TERMINAL_STATUSES },
        ...query
    })
    .select('awb status slaDeadline slaHours currentBranch originBranch destinationBranch receiver sender')
    .populate('currentBranch originBranch destinationBranch', 'name code')
    .sort({ slaDeadline: 1 })
    .lean();
}

module.exports = {
    SLA_DEFAULTS,
    TERMINAL_STATUSES,
    ACTIVE_STATUSES,
    setSLA,
    checkShipmentSLA,
    checkAndMarkBreaches,
    startSLAMonitor,
    stopSLAMonitor,
    getSLAStats,
    getApproachingBreaches
};
