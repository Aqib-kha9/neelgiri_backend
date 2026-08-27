/**
 * notificationHelper.js
 *
 * Centralized notification trigger utility. Provides simple milestone-based
 * functions that any controller can call to fire customer/internal notifications.
 *
 * All functions are fire-and-forget (never throw, never block the main operation).
 * They look up shipment details automatically and call sendNotification().
 *
 * Usage:
 *   const { notifyBookingConfirmed, notifyPickupDone, ... } = require('../utils/notificationHelper');
 *   await notifyPickupDone(shipment, req.user);
 */

const Notification = require('../models/Notification');
const Shipment = require('../models/Shipment');
const { generateNotificationId } = require('./idGenerator');

/**
 * Core internal sender — wraps the notificationController.sendNotification
 * but auto-resolves customer details from the shipment.
 */
async function _send({ shipment, template, channel = 'SMS', data = {}, recipientOverride = null, createdBy = null }) {
    try {
        if (!shipment) return null;

        // If a string AWB is passed, look up the shipment
        if (typeof shipment === 'string') {
            shipment = await Shipment.findOne({ awb: shipment }).lean();
            if (!shipment) return null;
        }

        // Ensure we have a plain object (lean or toObject)
        const s = shipment.toObject ? shipment.toObject() : shipment;

        const recipient = recipientOverride || {
            type: 'customer',
            id: s.customerId || null,
            name: s.customerName || s.consigneeName || '',
            phone: s.customerPhone || s.consigneePhone || '',
            email: s.customerEmail || s.consigneeEmail || ''
        };

        const tpl = require('../controllers/notificationController').TEMPLATES[template] ||
                    require('../controllers/notificationController').TEMPLATES.custom;
        const message = tpl.getMessage({ ...data, awb: s.awb });

        const notification = await Notification.create({
            notificationId: generateNotificationId(),
            recipientType: recipient.type || 'customer',
            recipientId: recipient.id || null,
            recipientName: recipient.name || '',
            recipientPhone: recipient.phone || '',
            recipientEmail: recipient.email || '',
            channel,
            template,
            subject: tpl.subject,
            message,
            data: { ...data, awb: s.awb },
            shipment: s._id || null,
            awb: s.awb || '',
            status: 'sent',
            sentAt: new Date(),
            partnerId: s.partnerId || null,
            branchId: s.branchId || s.originBranch || null,
            createdBy: createdBy || null
        });

        return notification;
    } catch (err) {
        console.error(`[notificationHelper] Failed for template "${template}":`, err.message);
        return null;
    }
}

// ─── Milestone Notification Functions ─────────────────────────────

/**
 * Booking confirmed — sent when a shipment is created/booked.
 */
async function notifyBookingConfirmed(shipment, user = null) {
    return _send({
        shipment,
        template: 'booking_confirmed',
        channel: 'SMS',
        data: {
            awb: shipment.awb,
            amount: shipment.totalAmount || shipment.charges || 0,
            trackingUrl: process.env.TRACKING_URL || ''
        },
        createdBy: user?._id || null
    });
}

/**
 * Pickup scheduled — sent when a pickup is assigned to a rider.
 */
async function notifyPickupScheduled(shipment, pickupData, user = null) {
    return _send({
        shipment,
        template: 'pickup_scheduled',
        channel: 'SMS',
        data: {
            awb: shipment.awb,
            date: pickupData.date || '',
            timeSlot: pickupData.timeSlot || '',
            riderName: pickupData.riderName || 'TBD'
        },
        createdBy: user?._id || null
    });
}

/**
 * Pickup done — sent when rider marks pickup as completed.
 */
async function notifyPickupDone(shipment, user = null) {
    return _send({
        shipment,
        template: 'pickup_done',
        channel: 'SMS',
        data: { awb: shipment.awb },
        createdBy: user?._id || null
    });
}

/**
 * In transit — sent when manifest departs from origin branch.
 */
async function notifyInTransit(shipment, transitData, user = null) {
    return _send({
        shipment,
        template: 'in_transit',
        channel: 'SMS',
        data: {
            awb: shipment.awb,
            fromBranch: transitData.fromBranch || '',
            toBranch: transitData.toBranch || '',
            eta: transitData.eta || ''
        },
        createdBy: user?._id || null
    });
}

/**
 * Arrived at branch — sent when shipment arrives at destination branch.
 */
async function notifyArrivedAtBranch(shipment, branchName, user = null) {
    return _send({
        shipment,
        template: 'arrived_at_branch',
        channel: 'SMS',
        data: {
            awb: shipment.awb,
            branchName: branchName || 'destination branch'
        },
        createdBy: user?._id || null
    });
}

/**
 * Out for delivery — sent when DRS is created / shipment assigned to rider.
 */
async function notifyOutForDelivery(shipment, deliveryData, user = null) {
    return _send({
        shipment,
        template: 'out_for_delivery',
        channel: 'SMS',
        data: {
            awb: shipment.awb,
            riderName: deliveryData.riderName || '',
            riderPhone: deliveryData.riderPhone || ''
        },
        createdBy: user?._id || null
    });
}

/**
 * Delivered — sent when shipment is marked as delivered.
 */
async function notifyDelivered(shipment, deliveryData, user = null) {
    return _send({
        shipment,
        template: 'delivered',
        channel: 'SMS',
        data: {
            awb: shipment.awb,
            deliveredTo: deliveryData.deliveredTo || deliveryData.receivedBy || 'customer'
        },
        createdBy: user?._id || null
    });
}

/**
 * Delivery failed — sent when a delivery attempt fails.
 */
async function notifyDeliveryFailed(shipment, failData, user = null) {
    return _send({
        shipment,
        template: 'delivery_failed',
        channel: 'SMS',
        data: {
            awb: shipment.awb,
            reason: failData.reason || 'customer unavailable',
            nextAttempt: failData.nextAttempt || ''
        },
        createdBy: user?._id || null
    });
}

/**
 * Delivery rescheduled — sent when delivery is rescheduled to a new date.
 */
async function notifyDeliveryRescheduled(shipment, newDate, user = null) {
    return _send({
        shipment,
        template: 'delivery_rescheduled',
        channel: 'SMS',
        data: {
            awb: shipment.awb,
            newDate: newDate || ''
        },
        createdBy: user?._id || null
    });
}

/**
 * RTO initiated — sent when RTO process starts.
 */
async function notifyRTOInitiated(shipment, reason, user = null) {
    return _send({
        shipment,
        template: 'rto_initiated',
        channel: 'SMS',
        data: {
            awb: shipment.awb,
            reason: reason || 'max delivery attempts exhausted'
        },
        createdBy: user?._id || null
    });
}

/**
 * RTO completed — sent when RTO is completed at origin.
 */
async function notifyRTOCompleted(shipment, rtoCharges, user = null) {
    return _send({
        shipment,
        template: 'rto_completed',
        channel: 'SMS',
        data: {
            awb: shipment.awb,
            rtoCharges: rtoCharges || 0
        },
        createdBy: user?._id || null
    });
}

/**
 * Exception raised — internal alert sent to branch admin / super admin.
 */
async function notifyExceptionRaised(shipment, exceptionData, user = null) {
    // Send to customer
    await _send({
        shipment,
        template: 'exception_raised',
        channel: 'IN_APP',
        data: {
            awb: shipment.awb,
            exceptionType: exceptionData.type || 'OTHER',
            severity: exceptionData.severity || 'MEDIUM'
        },
        createdBy: user?._id || null
    });

    // Also send internal alert to branch admin
    return _send({
        shipment,
        template: 'exception_raised',
        channel: 'IN_APP',
        data: {
            awb: shipment.awb,
            exceptionType: exceptionData.type || 'OTHER',
            severity: exceptionData.severity || 'MEDIUM'
        },
        recipientOverride: {
            type: 'branch_admin',
            id: null,
            name: 'Branch Admin',
            phone: '',
            email: ''
        },
        createdBy: user?._id || null
    });
}

/**
 * SLA breach alert — internal alert sent to branch admin / partner admin.
 */
async function notifySLABreach(shipment, slaData, user = null) {
    return _send({
        shipment,
        template: 'sla_breach',
        channel: 'IN_APP',
        data: {
            awb: shipment.awb,
            slaDeadline: slaData.slaDeadline || '',
            delayHours: slaData.delayHours || 0
        },
        recipientOverride: {
            type: 'branch_admin',
            id: null,
            name: 'Branch Admin',
            phone: '',
            email: ''
        },
        createdBy: user?._id || null
    });
}

/**
 * Bulk notify — send the same notification to multiple shipments.
 * Useful for manifest departures (notify all shipments in manifest).
 *
 * @param {Array} shipments - Array of shipment objects or AWBs
 * @param {String} template - Notification template name
 * @param {Function} dataFn - Function(shipment) => data object
 * @param {Object} user - Request user
 */
async function notifyBulk(shipments, template, dataFn, user = null) {
    if (!shipments || !Array.isArray(shipments) || shipments.length === 0) return [];

    const results = [];
    for (const s of shipments) {
        try {
            const shipment = typeof s === 'string' ? await Shipment.findOne({ awb: s }).lean() : s;
            if (!shipment) continue;

            const data = dataFn ? dataFn(shipment) : {};
            const result = await _send({
                shipment,
                template,
                channel: 'SMS',
                data,
                createdBy: user?._id || null
            });
            results.push(result);
        } catch (err) {
            console.error(`[notificationHelper] Bulk notify error for template "${template}":`, err.message);
        }
    }
    return results;
}

module.exports = {
    // Core
    _send,
    notifyBulk,
    // Milestone functions
    notifyBookingConfirmed,
    notifyPickupScheduled,
    notifyPickupDone,
    notifyInTransit,
    notifyArrivedAtBranch,
    notifyOutForDelivery,
    notifyDelivered,
    notifyDeliveryFailed,
    notifyDeliveryRescheduled,
    notifyRTOInitiated,
    notifyRTOCompleted,
    notifyExceptionRaised,
    notifySLABreach
};
