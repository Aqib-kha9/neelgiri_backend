const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const Branch = require('../models/Branch');
const Customer = require('../models/Customer');
const Manifest = require('../models/Manifest');
const Role = require('../models/Role'); // Import Role model
const DRS = require('../models/DRS'); // Import DRS for sync
const { autoRoute, findBranchForPincode } = require('../utils/autoRouter');
const { generateManifestId } = require('../utils/idGenerator');
const { logAudit } = require('../utils/auditLogger');
const { notifyBookingConfirmed, notifyInTransit, notifyArrivedAtBranch } = require('../utils/notificationHelper');
const { setSLA } = require('../utils/slaUtility');
const { validateShipmentData, validateStatusTransition, getValidNextStatuses } = require('../utils/validationGuards');
const { consumeAllocatedAwb } = require('../services/awbService');

// @desc    Forward a Shipment (Counter Manifest Send)
// @route   POST /api/shipments/forward
// @access  Branch Admin, Dispatcher
exports.forwardShipment = async (req, res) => {
    try {
        const { awb, destinationBranchId, receiver, weight, dimensions } = req.body;

        if (!awb) {
            return res.status(400).json({ message: 'AWB is required' });
        }

        const currentBranchId = req.user.branchId;
        const sourceBranch = req.body.sourceBranchId || req.user.branchId;

        // ─── AUTO-ROUTING INTEGRATION ───────────────────────────────
        // If destinationBranchId is not provided, auto-determine from receiver pincode
        let resolvedDestBranchId = destinationBranchId;
        let routingInfo = null;
        let autoRouteResult = null;

        if (!resolvedDestBranchId && receiver && receiver.pincode) {
            autoRouteResult = await autoRoute(
                req.body.originPincode || (req.user.pincode || ''),
                receiver.pincode
            );

            if (autoRouteResult.serviceable && autoRouteResult.destinationBranch) {
                resolvedDestBranchId = autoRouteResult.destinationBranch._id;
                routingInfo = {
                    originPincode: autoRouteResult.originPincode,
                    destinationPincode: autoRouteResult.destinationPincode,
                    isLocal: autoRouteResult.isLocal,
                    isODA: autoRouteResult.isODA,
                    estimatedTransitDays: autoRouteResult.estimatedTransitDays,
                    routeId: autoRouteResult.route ? autoRouteResult.route._id : null,
                    autoRouted: true
                };
            } else {
                return res.status(400).json({
                    message: 'Cannot auto-route shipment. No destination branch provided and auto-routing failed.',
                    autoRouteErrors: autoRouteResult.errors
                });
            }
        } else if (resolvedDestBranchId && receiver && receiver.pincode) {
            // Even if destination is provided, enrich routingInfo
            const destBranchResult = await findBranchForPincode(receiver.pincode);
            if (destBranchResult.found) {
                routingInfo = {
                    originPincode: req.body.originPincode || (req.user.pincode || ''),
                    destinationPincode: receiver.pincode,
                    isLocal: destBranchResult.branch._id.toString() === sourceBranch.toString(),
                    isODA: destBranchResult.isODA,
                    estimatedTransitDays: destBranchResult.transitDays,
                    routeId: null,
                    autoRouted: false
                };
            }
        }

        if (!resolvedDestBranchId) {
            return res.status(400).json({ message: 'Destination branch is required (provide destinationBranchId or receiver.pincode for auto-routing)' });
        }

        // Check if shipment exists
        let shipment = await Shipment.findOne({ awb });

        // Fetch Destination Branch Name for Remark
        const destBranchDoc = await Branch.findById(resolvedDestBranchId).select('name code');
        const destBranchName = destBranchDoc ? destBranchDoc.name : resolvedDestBranchId;

        // Generate proper manifest ID
        const manifestId = generateManifestId();

        if (shipment) {
            // Update existing shipment
            shipment.status = 'forwarded';
            shipment.destinationBranch = resolvedDestBranchId;
            shipment.currentBranch = null; // In transit

            // Update fields if provided
            if (receiver) shipment.receiver = { ...shipment.receiver, ...receiver };
            if (weight) shipment.weight = weight;
            if (dimensions) shipment.dimensions = { ...shipment.dimensions, ...dimensions };

            // Set routing info
            if (routingInfo) {
                shipment.routingInfo = routingInfo;
            }

            // Add journey entry
            shipment.journey = shipment.journey || [];
            shipment.journey.push({
                leg: shipment.journey.length + 1,
                type: 'manifest',
                fromBranch: sourceBranch,
                toBranch: resolvedDestBranchId,
                manifestId: manifestId,
                timestamp: new Date(),
                remark: `Forwarded to ${destBranchName}`
            });

            // Create Manifest for Counter Manifest
            const manifest = new Manifest({
                manifestId,
                sourceBranch: sourceBranch,
                destinationBranch: resolvedDestBranchId,
                shipments: [shipment._id],
                status: 'complete',
                createdBy: req.user._id,
                transportDetails: {
                    mode: 'surface',
                    remark: 'Counter Manifest (Direct)'
                },
                stats: {
                    totalShipments: 1,
                    totalWeight: shipment.weight || 0
                },
                history: [{
                    status: 'complete',
                    timestamp: new Date(),
                    forwarded_at: new Date(),
                    updatedBy: req.user._id,
                    remark: 'Direct Forward Manifest created automatically'
                }]
            });

            await manifest.save();

            shipment.status = 'not_scheduled';
            shipment.currentBranch = null; // In transit
            shipment.history.push({
                status: 'not_scheduled',
                timestamp: new Date(),
                remark: `Direct Forwarded to ${destBranchName} (Manifest: ${manifest.manifestId})`,
                branchId: sourceBranch,
                updatedBy: req.user._id
            });
            await shipment.save();

            logAudit(req, 'SHIPMENT_FORWARD', `Forwarded shipment ${awb} to ${destBranchName} via manifest ${manifest.manifestId}`);

            return res.json({
                message: 'Shipment forwarded and manifest created',
                shipment,
                manifestId: manifest.manifestId,
                autoRouted: routingInfo ? routingInfo.autoRouted : false,
                routingInfo
            });
        } else {
            // Create new shipment and forward
            shipment = new Shipment({
                awb,
                receiver,
                weight,
                dimensions,
                status: 'not_scheduled',
                destinationBranch: resolvedDestBranchId,
                currentBranch: null, // In transit
                originType: 'manual_forward',
                originBranchId: sourceBranch,
                createdBy: req.user._id,
                routingInfo: routingInfo || undefined,
                journey: [{
                    leg: 1,
                    type: 'manifest',
                    fromBranch: sourceBranch,
                    toBranch: resolvedDestBranchId,
                    manifestId: manifestId,
                    timestamp: new Date(),
                    remark: `Created and forwarded to ${destBranchName}`
                }],
                history: [{
                    status: 'not_scheduled',
                    timestamp: new Date(),
                    branchId: sourceBranch,
                    updatedBy: req.user._id,
                    remark: `Created and forwarded to branch ${destBranchName}`
                }]
            });

            await shipment.save();

            const manifest = new Manifest({
                manifestId,
                sourceBranch: sourceBranch,
                destinationBranch: resolvedDestBranchId,
                shipments: [shipment._id],
                status: 'complete',
                createdBy: req.user._id,
                transportDetails: {
                    mode: 'surface',
                    remark: 'Counter Manifest (Direct)'
                },
                stats: { totalShipments: 1, totalWeight: weight || 0 },
                history: [{
                    status: 'complete',
                    timestamp: new Date(),
                    forwarded_at: new Date(),
                    updatedBy: req.user._id,
                    remark: 'Direct Forward Manifest created automatically'
                }]
            });
            await manifest.save();

            logAudit(req, 'SHIPMENT_FORWARD', `Created and forwarded shipment ${awb} to ${destBranchName} via manifest ${manifest.manifestId}`);

            return res.status(201).json({
                message: 'Shipment created, forwarded and manifested',
                shipment,
                manifestId: manifest.manifestId,
                autoRouted: routingInfo ? routingInfo.autoRouted : false,
                routingInfo
            });
        }

    } catch (error) {
        console.error('Error forwarding shipment:', error);
        res.status(500).json({ message: 'Server Error processing forward' });
    }
};

// @desc    Get Incoming Shipments (Inward Processing View)
// @route   GET /api/shipments/incoming
// @access  Private
exports.getIncomingShipments = async (req, res) => {
    try {
        let query = {
            status: { $in: ['not_scheduled', 'scheduled', 'in_progress', 'paused', 'complete'] }
        };

        // ---------------------------------------------------------
        // ROBUST ROLE RESOLUTION (FIXED)
        // ---------------------------------------------------------
        let effectiveRole = null;
        if (req.user.role && req.user.role.name) {
            effectiveRole = req.user.role.name;
        } else if (req.user.role) {
            const roleDoc = await Role.findById(req.user.role);
            if (roleDoc) effectiveRole = roleDoc.name;
        }

        console.log(`[Incoming] User: ${req.user.name} | Role: ${effectiveRole} | ID: ${req.user._id}`);

        if (effectiveRole === 'super_admin') {
            // No destination filter - fetch ALL incoming
        } else if (effectiveRole === 'partner_admin' || effectiveRole === 'partner') {
            // PARTNER SCOPE (FIXED)
            // 1. Determine Partner ID (Parent or Self)
            const User = require('../models/User');
            let partnerId = req.user._id;

            // Check if user has a parent partner (is a sub-account)
            const fullUser = await User.findById(req.user._id).select('parentPartner');
            if (fullUser && fullUser.parentPartner) {
                partnerId = fullUser.parentPartner;
            }

            // Strategy A: Direct Branch Linkage (Branch.partnerId)
            const directBranches = await Branch.find({ partnerId: partnerId }).select('_id');

            // Strategy B: Hierarchy Linkage (User.createdBy) -> Safety net for broken links
            // Find all users created by this partner who have a branch assigned (Branch Admins/Dispatchers)
            const childUsers = await User.find({
                createdBy: partnerId,
                branchId: { $ne: null }
            }).select('branchId');

            // Collect all unique Branch IDs
            const branchIdSet = new Set();
            directBranches.forEach(b => branchIdSet.add(b._id.toString()));
            childUsers.forEach(u => {
                if (u.branchId) branchIdSet.add(u.branchId.toString());
            });

            const allBranchIds = Array.from(branchIdSet);

            if (allBranchIds.length === 0) {
                console.warn(`[Incoming] Partner Admin ${req.user.name} has NO branches linked (Direct or Hierarchy). PartnerID: ${partnerId}`);
                // Proceed with empty list to return empty array naturally
            }

            // 3. Query: Destination Must be in Partner's Branches
            query.destinationBranch = { $in: allBranchIds };
            console.log(`[Incoming] Partner Scope - PartnerId: ${partnerId}, Combined Branches: ${allBranchIds.length} (Direct: ${directBranches.length}, Hierarchy: ${childUsers.length})`);

        } else {
            // BRANCH SCOPE (Dispatcher / Branch Admin)
            if (!req.user.branchId) {
                console.warn(`[Incoming] Access Denied - No Branch ID for User: ${req.user.name}`);
                return res.json([]);
            }
            query.destinationBranch = req.user.branchId;
        }

        // Find shipments
        const shipments = await Shipment.find(query)
            .populate('destinationBranch', 'name code')
            .sort({ updatedAt: -1 });

        // Group by source branch (from history)
        const grouped = {};

        for (const shipment of shipments) {
            // Find the not_scheduled event (checking new status first)
            let forwardEvent = shipment.history.find(h => h.status === 'not_scheduled');

            // Fallback for old data: check for 'forwarded' status
            if (!forwardEvent) {
                forwardEvent = shipment.history.find(h => h.status === 'forwarded');
            }

            const sourceBranchId = forwardEvent?.branchId?.toString() || 'unknown';

            if (!grouped[sourceBranchId]) {
                grouped[sourceBranchId] = {
                    sourceBranchId,
                    sourceBranch: null,
                    shipments: []
                };
            }

            grouped[sourceBranchId].shipments.push(shipment);
        }

        // Populate source branch details
        for (const key in grouped) {
            if (key !== 'unknown') {
                const branch = await Branch.findById(key).select('name code');
                grouped[key].sourceBranch = branch;
            }
        }

        res.json(Object.values(grouped));

    } catch (error) {
        console.error('Error fetching incoming shipments:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Inward a Shipment (Create or Update from Counter)
// @route   POST /api/shipments/inward
// @access  Branch Admin, Dispatcher
exports.inwardShipment = async (req, res) => {
    try {
        const { awb, sender, receiver, weight, contents, paymentMode, codAmount } = req.body;

        if (!awb) {
            return res.status(400).json({ message: 'AWB is required' });
        }

        // Check if shipment exists
        let shipment = await Shipment.findOne({ awb });

        const currentBranchId = req.user.branchId || null;

        if (shipment) {
            // Update existing shipment
            // Status remains/becomes 'not_scheduled' (Available)
            // If it was somehow 'scheduled' or 'in_progress' and arrived here, we reset it?
            // Assuming Inward happens before DRS.
            shipment.status = 'not_scheduled';
            shipment.currentBranch = currentBranchId;

            // Update fields if provided
            if (sender) shipment.sender = { ...shipment.sender, ...sender };
            if (receiver) shipment.receiver = { ...shipment.receiver, ...receiver };
            if (weight) shipment.weight = weight;
            if (contents) shipment.contents = contents;
            if (paymentMode) shipment.paymentMode = paymentMode;
            if (codAmount) shipment.codAmount = codAmount;

            shipment.history.push({
                status: 'not_scheduled',
                timestamp: new Date(),
                branchId: currentBranchId,
                updatedBy: req.user._id,
                remark: 'Inwarded at Counter (Received)'
            });

            await shipment.save();
            return res.json({ message: 'Shipment inwarded successfully', shipment });
        } else {
            // Create new shipment
            shipment = new Shipment({
                awb,
                sender,
                receiver,
                weight,
                contents,
                paymentMode,
                codAmount,
                status: 'not_scheduled',
                currentBranch: currentBranchId,
                originType: 'counter_inward',
                originBranchId: currentBranchId,
                createdBy: req.user._id,
                history: [{
                    status: 'not_scheduled',
                    timestamp: new Date(),
                    branchId: currentBranchId,
                    updatedBy: req.user._id,
                    remark: 'Created & Inwarded at Counter'
                }]
            });

            await shipment.save();

            // Fire-and-forget: notify customer of booking confirmation
            notifyBookingConfirmed(shipment, req.user);

            return res.status(201).json({ message: 'Shipment created and inwarded', shipment });
        }

    } catch (error) {
        console.error('Error inwarding shipment:', error);
        res.status(500).json({ message: 'Server Error processing inward' });
    }
};

// @desc    Get Shipments by Status
// @route   GET /api/shipments
// @access  Private
exports.getShipments = async (req, res) => {
    try {
        const { status, awb } = req.query;
        const roleName = req.user?.role?.name || req.user?.role;
        const query = {};

        if (roleName === 'customer') {
            query.createdBy = req.user._id;
        } else if (roleName === 'partner_admin' || roleName === 'partner') {
            query.$or = [
                { partnerId: req.user._id },
                { branchId: { $in: await Branch.find({ partnerId: req.user._id }).distinct('_id') } }
            ];
        } else if (req.user.branchId) {
            query.$or = [
                { branchId: req.user.branchId },
                { originBranchId: req.user.branchId },
                { currentBranch: req.user.branchId },
                { destinationBranch: req.user.branchId }
            ];
        } else if (roleName !== 'super_admin') {
            query._id = null;
        }

        if (status) {
            const statusArray = status.split(',').filter(Boolean);
            query.status = statusArray.length > 1 ? { $in: statusArray } : statusArray[0];
            if (statusArray.includes('complete')) {
                query.completedVia = { $in: ['manual', 'branch_direct'] };
            }
        }

        if (awb) {
            query.awb = { $regex: awb, $options: 'i' };
        }

        const shipments = await Shipment.find(query).sort({ updatedAt: -1 });
        res.json(shipments);
    } catch (error) {
        console.error('Error fetching shipments:', error);
        res.status(500).json({ message: 'Server Error fetching shipments' });
    }
};

// @desc    Get Single Shipment Details
// @route   GET /api/shipments/:awb
// @access  Private
exports.getShipmentByAWB = async (req, res) => {
    try {
        const roleName = req.user?.role?.name || req.user?.role;
        const query = { awb: req.params.awb };

        if (roleName === 'customer') {
            query.createdBy = req.user._id;
        } else if (roleName === 'partner_admin' || roleName === 'partner') {
            query.partnerId = req.user._id;
        } else if (req.user.branchId) {
            query.$or = [
                { branchId: req.user.branchId },
                { originBranchId: req.user.branchId },
                { currentBranch: req.user.branchId },
                { destinationBranch: req.user.branchId }
            ];
        } else if (roleName !== 'super_admin') {
            query._id = null;
        }

        const shipment = await Shipment.findOne(query);
        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }
        res.json(shipment);
    } catch (error) {
        console.error('Error fetching shipment:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};
// @desc    Force Complete a Shipment (Branch Action)
// @route   POST /api/shipments/:awb/complete
// @access  Branch Admin, Dispatcher
exports.completeShipment = async (req, res) => {
    try {
        const { awb } = req.params;

        if (!awb) {
            return res.status(400).json({ message: 'AWB is required' });
        }

        const shipment = await Shipment.findOne({ awb });

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // ALLOW: complete if not terminal (complete/delivered)
        if (['complete', 'delivered'].includes(shipment.status)) {
            return res.status(400).json({
                message: 'Shipment is already completed.',
                currentStatus: shipment.status
            });
        }

        shipment.status = 'complete';
        shipment.deliveredAt = new Date();
        // CRITICAL: Mark as manually completed or direct branch approve
        // This ensures it appears in Completed section, NOT just DRS History
        shipment.completedVia = req.body.completedVia || 'manual';

        // Add history entry
        shipment.history.push({
            status: 'complete',
            timestamp: new Date(),
            branchId: req.user.branchId,
            updatedBy: req.user._id,
            remark: 'Manually completed from Available Shipments'
        });

        await shipment.save();

        // NEW: Sync with DRS if it's part of one
        try {
            const DRS = require('../models/DRS');
            // Find any active DRS containing this shipment
            const targetDRS = await DRS.findOne({
                'shipments.awb': awb,
                status: { $in: ['scheduled', 'in_progress', 'paused'] }
            });

            if (targetDRS) {
                const sIdx = targetDRS.shipments.findIndex(s => s.awb === awb);
                if (sIdx !== -1) {
                    targetDRS.shipments[sIdx].status = 'delivered'; // Mark as delivered in DRS
                    targetDRS.shipments[sIdx].deliveredAt = new Date();

                    // Recalculate stats
                    targetDRS.stats.completedShipments = targetDRS.shipments.filter(s => s.status === 'delivered' || s.status === 'completed').length;
                    targetDRS.stats.pendingShipments = targetDRS.shipments.filter(s => ['pending', 'in_transit'].includes(s.status)).length;

                    // Auto-complete check
                    const allResolved = !targetDRS.shipments.some(s => ['pending', 'in_transit'].includes(s.status));
                    if (allResolved) {
                        targetDRS.status = 'completed';
                        targetDRS.endDate = new Date();
                    }

                    targetDRS.markModified('shipments');
                    await targetDRS.save();
                    console.log(`[DRS Sync] Updated DRS ${targetDRS.drsId} due to direct shipment completion`);
                }
            }
        } catch (syncError) {
            console.error('[DRS Sync Error]', syncError);
            // Don't fail the whole request if sync fails
        }

        res.json({ message: 'Shipment marked as completed', shipment });

    } catch (error) {
        console.error('Error completing shipment:', error);
        res.status(500).json({ message: 'Server Error completing shipment' });
    }
};

// @desc    Confirm Shipment Inward (Manifest Item Received)
// @route   POST /api/shipments/confirm-inward
// @access  Branch Admin, Dispatcher
exports.confirmShipmentInward = async (req, res) => {
    try {
        const { shipmentId, awb } = req.body;

        let query = {};
        if (shipmentId) query._id = shipmentId;
        else if (awb) query.awb = awb;
        else return res.status(400).json({ message: 'Shipment ID or AWB required' });

        const shipment = await Shipment.findOne(query);
        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Update Status
        shipment.status = 'not_scheduled'; // Ready for DRS
        shipment.currentBranch = req.user.branchId; // Now officially at this branch

        // Add History
        shipment.history.push({
            status: 'not_scheduled',
            timestamp: new Date(),
            branchId: req.user.branchId,
            updatedBy: req.user._id,
            remark: 'Inward Confirmed (Received at Branch)'
        });

        await shipment.save();

        res.json({ message: 'Shipment inward confirmed', shipment });

    } catch (error) {
        console.error('Error confirming inward:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get Full Shipment Details (for Tracking Dialog)
// @route   GET /api/shipments/:awb/tracking
// @access  Private
exports.getShipmentTracking = async (req, res) => {
    try {
        const { awb } = req.params;

        const shipment = await Shipment.findOne({ awb })
            .populate('originBranchId', 'name branchCode')
            .populate('destinationBranch', 'name branchCode')
            .populate({
                path: 'history.branchId',
                select: 'name branchCode',
                model: 'Branch'
            })
            .populate({
                path: 'history.updatedBy',
                select: 'name email role'
            })
            .lean();

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        res.json(shipment);

    } catch (error) {
        console.error('Error fetching tracking details:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

const { calculateFreight } = require('../utils/pricingCalculator');

const bookingResponse = (shipment, replayed = false) => ({
    message: replayed ? 'Existing booking returned' : 'Booking successful',
    awb: shipment.awb,
    shipment,
    idempotentReplay: replayed,
    autoRouted: Boolean(shipment.routingInfo?.autoRouted),
    routingInfo: shipment.routingInfo,
    serviceability: { serviceable: true, errors: [], warnings: [] },
    pricing: {
        baseFreight: shipment.baseFreight || 0,
        fuelSurcharge: shipment.fuelSurcharge || 0,
        odaSurcharge: shipment.odaCharge || 0,
        insuranceAmount: shipment.fovCharge || 0,
        codCharge: shipment.codCharge || 0,
        taxAmount: shipment.taxAmount || 0,
        netAmount: shipment.totalAmount || 0,
        chargeableWeight: shipment.chargeableWeight || 0
    }
});

// @desc    Create Booking (Customer Portal)
// @route   POST /api/shipments/book
// @access  Private
exports.createBooking = async (req, res) => {
    let bookingSession;
    let normalizedIdempotencyKey = '';
    try {
        const {
            sender,
            receiver,
            weight,
            dimensions,
            contents,
            packageType,
            category,
            isFragile,
            insuranceRequired,
            fovPercentage,
            paymentMode,
            codAmount,
            declaredValue,
            mode,
            customerId,
            senderInvoiceNo,
            eWayBill,
            additionalDocNos,
            attachments,
            termsAccepted,
            termsVersion,
            idempotencyKey
        } = req.body || {};
        const roleName = req.user?.role?.name || req.user?.role;
        const normalizedPaymentMode = String(paymentMode || '').trim().toLowerCase();
        const normalizedMode = String(mode || 'SURFACE').trim().toUpperCase();
        const normalizedPackageType = String(packageType || 'BOX').trim().toUpperCase();
        const normalizedWeight = Number(weight);
        const normalizedDeclaredValue = Number(declaredValue || 0);
        const normalizedCodAmount = normalizedPaymentMode === 'cod' ? Number(codAmount) : 0;
        const normalizedFovPercentage = insuranceRequired === true && fovPercentage !== undefined && fovPercentage !== null
            ? Number(fovPercentage)
            : null;
        const normalizedDimensions = {
            length: Number(dimensions?.length || 0),
            width: Number(dimensions?.width ?? dimensions?.breadth ?? 0),
            height: Number(dimensions?.height || 0)
        };
        normalizedIdempotencyKey = String(idempotencyKey || '').trim();

        if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalizedIdempotencyKey)) {
            return res.status(400).json({
                message: 'A valid idempotency key (8-128 safe characters) is required'
            });
        }

        const existingBooking = await Shipment.findOne({
            createdBy: req.user._id,
            bookingIdempotencyKey: normalizedIdempotencyKey
        });
        if (existingBooking) {
            return res.status(200).json(bookingResponse(existingBooking, true));
        }

        const customerQuery = roleName === 'customer'
            ? { userId: req.user._id }
            : customerId
                ? { _id: customerId }
                : { userId: req.user._id };
        const customer = await Customer.findOne(customerQuery)
            .select('_id userId branchId partnerId customerType status name mobileNo address1 pincode email gstin rateCard allowedServices')
            .lean();

        if (roleName === 'customer' && (!customer || customer.status === 'inactive')) {
            return res.status(403).json({ message: 'An active customer profile is required to create a booking' });
        }
        if (customerId && !customer) {
            return res.status(404).json({ message: 'Customer profile not found' });
        }
        if (customer && customer.status === 'inactive') {
            return res.status(400).json({ message: 'Selected customer profile is inactive' });
        }
        if (customer && roleName !== 'customer') {
            const effectivePartnerId = req.user.parentPartner || req.user.createdBy ||
                (['partner_admin', 'partner'].includes(roleName) ? req.user._id : null);
            if (effectivePartnerId && customer.partnerId && customer.partnerId.toString() !== effectivePartnerId.toString()) {
                return res.status(403).json({ message: 'Selected customer is outside your partner scope' });
            }
            if (req.user.branchId && customer.branchId && customer.branchId.toString() !== req.user.branchId.toString()) {
                return res.status(403).json({ message: 'Selected customer is outside your branch scope' });
            }
        }

        const effectiveSender = sender || {
            name: customer?.name || req.user.name,
            phone: customer?.mobileNo || req.user.phone || '',
            address: customer?.address1 || req.user.address || '',
            pincode: customer?.pincode || req.user.pincode || '',
            email: customer?.email || req.user.email,
            gstin: customer?.gstin || ''
        };

        if (attachments !== undefined && !Array.isArray(attachments)) {
            return res.status(400).json({ message: 'Attachments must be an array' });
        }
        if (Array.isArray(attachments) && attachments.some((attachment) => !attachment || typeof attachment !== 'object' || Array.isArray(attachment))) {
            return res.status(400).json({ message: 'Each attachment must be an object' });
        }
        const normalizedAttachments = Array.isArray(attachments)
            ? attachments.map((attachment) => ({
                url: String(attachment.url || '').trim(),
                type: String(attachment.type || '').trim().toLowerCase(),
                originalname: attachment.originalname
                    ? String(attachment.originalname).trim().slice(0, 255)
                    : undefined,
                mimetype: attachment.mimetype
                    ? String(attachment.mimetype).trim().toLowerCase()
                    : undefined,
                size: attachment.size === undefined || attachment.size === null
                    ? undefined
                    : Number(attachment.size)
            }))
            : attachments;
        const normalizedAdditionalDocNos = Array.isArray(additionalDocNos)
            ? additionalDocNos
                .map((value) => String(value || '').trim())
                .filter(Boolean)
                .slice(0, 20)
            : [];
        const canonicalSender = {
            ...effectiveSender,
            name: String(effectiveSender.name || '').trim(),
            phone: String(effectiveSender.phone || '').trim(),
            address: String(effectiveSender.address || '').trim(),
            pincode: String(effectiveSender.pincode || '').trim(),
            city: String(effectiveSender.city || '').trim(),
            state: String(effectiveSender.state || '').trim(),
            email: effectiveSender.email ? String(effectiveSender.email).trim().toLowerCase() : undefined,
            gstin: effectiveSender.gstin ? String(effectiveSender.gstin).trim().toUpperCase() : undefined
        };
        const canonicalReceiver = {
            ...receiver,
            name: String(receiver?.name || '').trim(),
            phone: String(receiver?.phone || '').trim(),
            address: String(receiver?.address || '').trim(),
            pincode: String(receiver?.pincode || '').trim(),
            city: String(receiver?.city || '').trim(),
            state: String(receiver?.state || '').trim(),
            email: receiver?.email ? String(receiver.email).trim().toLowerCase() : undefined,
            gstin: receiver?.gstin ? String(receiver.gstin).trim().toUpperCase() : undefined
        };

        if (customer?.allowedServices?.length > 0) {
            const allowedServices = customer.allowedServices.map((service) => String(service).trim().toUpperCase());
            if (!allowedServices.includes('ALL') && !allowedServices.includes(normalizedMode)) {
                return res.status(403).json({ message: `${normalizedMode} service is not enabled for this customer` });
            }
        }

        const validation = validateShipmentData({
            sender: canonicalSender,
            receiver: canonicalReceiver,
            weight: normalizedWeight,
            dimensions: normalizedDimensions,
            contents: String(contents || '').trim(),
            packageType: normalizedPackageType,
            category: String(category || 'General').trim(),
            mode: normalizedMode,
            paymentMode: normalizedPaymentMode,
            codAmount: normalizedCodAmount,
            declaredValue: normalizedDeclaredValue,
            insuranceRequired: insuranceRequired === true,
            fovPercentage: normalizedFovPercentage,
            eWayBill: eWayBill ? String(eWayBill).trim() : undefined,
            attachments: normalizedAttachments,
            termsAccepted,
            termsVersion
        });
        if (!validation.valid) {
            return res.status(400).json({
                message: 'Shipment validation failed',
                errors: validation.errors
            });
        }

        const autoRouteResult = await autoRoute(canonicalSender.pincode, canonicalReceiver.pincode);
        if (!autoRouteResult.serviceable || !autoRouteResult.originBranch || !autoRouteResult.destinationBranch) {
            return res.status(400).json({
                message: 'Shipment route is not serviceable',
                errors: autoRouteResult.errors || ['No active route found for the supplied pincodes']
            });
        }

        const originBranchId = autoRouteResult.originBranch._id;
        const destinationBranchId = autoRouteResult.destinationBranch._id;
        const routingInfo = {
            originPincode: autoRouteResult.originPincode,
            destinationPincode: autoRouteResult.destinationPincode,
            isLocal: autoRouteResult.isLocal,
            isODA: autoRouteResult.isODA,
            estimatedTransitDays: autoRouteResult.estimatedTransitDays,
            routeId: autoRouteResult.route ? autoRouteResult.route._id : null,
            autoRouted: true
        };

        const pricing = await calculateFreight({
            rateCardId: customer?.rateCard || undefined,
            weight: normalizedWeight,
            length: normalizedDimensions.length,
            breadth: normalizedDimensions.width,
            height: normalizedDimensions.height,
            serviceType: normalizedMode,
            sourcePincode: canonicalSender.pincode,
            destPincode: canonicalReceiver.pincode,
            declaredValue: normalizedDeclaredValue,
            codAmount: normalizedCodAmount,
            customerId: customer?._id,
            customerType: 'CUSTOMER',
            isCOD: normalizedPaymentMode === 'cod',
            insuranceRequested: insuranceRequired === true,
            fovPercentage: normalizedFovPercentage
        });

        const targetIds = [
            req.user._id,
            req.user.branchId,
            req.user.parentPartner,
            req.user.createdBy,
            customer && customer._id,
            customer && customer.branchId,
            customer && customer.partnerId,
            originBranchId,
            destinationBranchId
        ];

        bookingSession = await mongoose.startSession();
        bookingSession.startTransaction();
        const issuedAwb = await consumeAllocatedAwb({ targetIds, session: bookingSession });
        const awb = issuedAwb.awbNumber;
        const slaConfig = setSLA({}, normalizedMode, autoRouteResult.estimatedTransitDays);
        const originType = roleName === 'customer' ? 'customer_portal' : 'counter_inward';
        const shipment = new Shipment({
            awb,
            sender: canonicalSender,
            receiver: canonicalReceiver,
            weight: normalizedWeight,
            dimensions: normalizedDimensions,
            contents: String(contents || '').trim(),
            packageType: normalizedPackageType,
            category: String(category || 'General').trim(),
            isFragile: isFragile === true,
            insuranceRequired: insuranceRequired === true,
            fovPercentage: normalizedFovPercentage,
            paymentMode: normalizedPaymentMode,
            codAmount: normalizedCodAmount,
            declaredValue: normalizedDeclaredValue,
            status: 'not_scheduled',
            originType,
            originBranchId,
            currentBranch: originBranchId,
            destinationBranch: destinationBranchId,
            branchId: customer?.branchId || req.user.branchId || originBranchId,
            partnerId: customer?.partnerId || req.user.parentPartner || req.user.createdBy,
            customerId: customer?._id || null,
            createdBy: req.user._id,
            eWayBill: eWayBill ? String(eWayBill).trim() : undefined,
            senderInvoiceNo: senderInvoiceNo ? String(senderInvoiceNo).trim() : undefined,
            additionalDocNos: normalizedAdditionalDocNos,
            attachments: normalizedAttachments,
            termsAccepted: termsAccepted === true,
            termsVersion: termsVersion ? String(termsVersion).trim() : undefined,
            termsAcceptedAt: termsAccepted === true ? new Date() : undefined,
            bookingIdempotencyKey: normalizedIdempotencyKey,
            routingInfo,
            slaHours: slaConfig.slaHours,
            slaDeadline: slaConfig.slaDeadline,
            chargeableWeight: pricing.chargeableWeight,
            baseFreight: pricing.baseFreight,
            fuelSurcharge: pricing.fuelSurcharge,
            fovCharge: pricing.fovCharge,
            odaCharge: pricing.odaSurcharge || 0,
            codCharge: pricing.codCharge || 0,
            taxAmount: pricing.gstAmount,
            totalAmount: pricing.totalAmount,
            history: [{
                status: 'not_scheduled',
                timestamp: new Date(),
                branchId: originBranchId,
                updatedBy: req.user._id,
                remark: `Booking created via ${originType}`
            }]
        });

        await shipment.save({ session: bookingSession });
        await bookingSession.commitTransaction();

        await logAudit(req, {
            action: 'CREATE',
            resource: 'shipment',
            resourceId: shipment._id,
            description: `New booking ${awb} created`,
            details: { awbSeriesId: issuedAwb.seriesId, allocationId: issuedAwb.allocationId, originBranchId, destinationBranchId }
        });

        res.status(201).json(bookingResponse(shipment));
    } catch (error) {
        if (bookingSession && bookingSession.inTransaction()) {
            await bookingSession.abortTransaction();
        }
        if (error?.code === 11000 && normalizedIdempotencyKey) {
            const existingBooking = await Shipment.findOne({
                createdBy: req.user._id,
                bookingIdempotencyKey: normalizedIdempotencyKey
            });
            if (existingBooking) {
                return res.status(200).json(bookingResponse(existingBooking, true));
            }
        }
        console.error('Error creating customer booking:', error);
        res.status(error.statusCode || 500).json({ message: error.message || 'Server Error creating booking' });
    } finally {
        if (bookingSession) await bookingSession.endSession();
    }
};

// @desc    Auto-Route a shipment (preview routing without creating)
// @route   GET /api/shipments/auto-route
// @access  Private
exports.autoRouteShipment = async (req, res) => {
    try {
        const { originPincode, destinationPincode } = req.query;

        if (!originPincode || !destinationPincode) {
            return res.status(400).json({ message: 'originPincode and destinationPincode are required' });
        }

        const result = await autoRoute(originPincode, destinationPincode);

        res.json({
            originPincode,
            destinationPincode,
            serviceable: result.serviceable,
            isLocal: result.isLocal,
            isODA: result.isODA,
            estimatedTransitDays: result.estimatedTransitDays,
            originBranch: result.originBranch,
            destinationBranch: result.destinationBranch,
            route: result.route ? {
                _id: result.route._id,
                name: result.route.name,
                sourceCity: result.route.sourceCity,
                destinationCity: result.route.destinationCity,
                totalDistanceKm: result.route.totalDistanceKm,
                totalTransitTimeHours: result.route.totalTransitTimeHours
            } : null,
            errors: result.errors,
            warnings: result.warnings
        });
    } catch (error) {
        console.error('Error auto-routing shipment:', error);
        res.status(500).json({ message: 'Server Error during auto-routing' });
    }
};
