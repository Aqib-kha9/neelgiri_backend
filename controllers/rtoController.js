/**
 * RTO (Return to Origin) Controller
 * 
 * Full RTO workflow:
 * 1. initiateRTO - Start RTO process (manual or auto-triggered)
 * 2. createRTOManifest - Create manifest to ship parcel back to origin
 * 3. dispatchRTO - Mark RTO manifest as dispatched
 * 4. receiveRTO - Receive RTO at origin branch
 * 5. completeRTO - Complete RTO process (return to customer / dispose)
 * 6. cancelRTO - Cancel RTO if re-delivery possible
 * 7. getRTOShipments - List all RTO shipments
 * 8. getRTODetails - Get detailed RTO info for a shipment
 * 9. getRTOStats - RTO statistics dashboard
 */

const Shipment = require('../models/Shipment');
const Manifest = require('../models/Manifest');
const Bag = require('../models/Bag');
const Branch = require('../models/Branch');
const Exception = require('../models/Exception');
const { buildScopeQuery, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');
const { generateManifestId, generateExceptionId } = require('../utils/idGenerator');
const { notifyRTOInitiated, notifyRTOCompleted } = require('../utils/notificationHelper');
const { validateStatusTransition, getValidNextStatuses } = require('../utils/validationGuards');

// @desc    Initiate RTO for a shipment
// @route   POST /api/rto/initiate
// @access  Branch Admin, Dispatcher, Super Admin
exports.initiateRTO = async (req, res) => {
    try {
        const { awb, reason, charges, remark } = req.body;

        if (!awb) {
            return res.status(400).json({ message: 'AWB is required' });
        }

        if (!reason) {
            return res.status(400).json({ message: 'RTO reason is required' });
        }

        const shipment = await Shipment.findOne({ awb });
        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Check if RTO already initiated
        if (shipment.rtoStatus && shipment.rtoStatus !== 'none' && shipment.rtoStatus !== 'cancelled') {
            return res.status(400).json({
                message: `RTO already initiated. Current RTO status: ${shipment.rtoStatus}`,
                rtoStatus: shipment.rtoStatus
            });
        }

        // Check if shipment is in a valid state for RTO
        // ─── PHASE 4.3: Centralized status transition validation ───
        const validStatuses = ['delivery_failed', 'rto_initiated', 'paused', 'out_for_delivery', 'pending_for_branch_approval'];
        if (!validStatuses.includes(shipment.status) && shipment.status !== 'rto_initiated') {
            const transitionCheck = validateStatusTransition(shipment.status, 'rto_initiated');
            return res.status(400).json({
                message: `Shipment cannot be RTO'd from status: ${shipment.status}. Valid statuses: ${validStatuses.join(', ')}`,
                validNextStatuses: getValidNextStatuses(shipment.status),
                reason: transitionCheck.reason
            });
        }

        // Determine origin branch (where the shipment needs to return to)
        const originBranchId = shipment.originBranchId || shipment.branchId;
        if (!originBranchId) {
            return res.status(400).json({ message: 'Shipment has no origin branch for RTO' });
        }

        // Update shipment with RTO info
        await Shipment.updateOne(
            { awb },
            {
                $set: {
                    status: 'rto_initiated',
                    rtoStatus: 'initiated',
                    rtoReason: reason,
                    rtoInitiatedAt: new Date(),
                    rtoInitiatedBy: req.user._id,
                    rtoCharges: charges || 0
                },
                $push: {
                    history: {
                        status: 'rto_initiated',
                        branchId: req.user.branchId || originBranchId,
                        updatedBy: req.user._id,
                        remark: remark || `RTO initiated: ${reason}`
                    },
                    journey: {
                        leg: (shipment.journey?.length || 0) + 1,
                        type: 'rto',
                        fromBranch: req.user.branchId || shipment.currentBranch,
                        toBranch: originBranchId,
                        timestamp: new Date(),
                        remark: `RTO initiated - Reason: ${reason}`
                    }
                }
            }
        );

        // Create exception for RTO tracking
        try {
            const exceptionId = await generateExceptionId();
            await Exception.create({
                exceptionId,
                awb,
                shipmentId: shipment._id,
                type: 'RTO_MANUAL',
                title: `RTO Initiated - ${awb}`,
                description: `RTO initiated by ${req.user.name || 'user'}. Reason: ${reason}. Charges: ₹${charges || 0}`,
                severity: 'HIGH',
                status: 'OPEN',
                category: 'OPERATIONAL',
                branchId: req.user.branchId || originBranchId,
                partnerId: shipment.partnerId,
                createdBy: req.user._id
            });
        } catch (excErr) {
            console.error('Failed to create RTO exception:', excErr.message);
        }

        // Audit log
        logAudit({
            action: 'RTO_INITIATE',
            entity: 'Shipment',
            entityId: shipment._id,
            awb,
            userId: req.user._id,
            userRole: req.user.role?.name,
            branchId: req.user.branchId,
            details: { reason, charges, remark }
        });

        // Fire-and-forget: notify customer of RTO initiation
        notifyRTOInitiated(shipment, reason, req.user);

        res.json({
            message: 'RTO initiated successfully',
            awb,
            rtoStatus: 'initiated',
            originBranchId,
            nextStep: 'Create RTO manifest to ship parcel back to origin branch'
        });

    } catch (error) {
        console.error('Error initiating RTO:', error);
        res.status(500).json({ message: 'Server Error initiating RTO', error: error.message });
    }
};

// @desc    Create RTO manifest to ship parcel back to origin
// @route   POST /api/rto/manifest
// @access  Branch Admin, Dispatcher
exports.createRTOManifest = async (req, res) => {
    try {
        const { awbs, transportDetails, bagId } = req.body;

        if (!awbs || !Array.isArray(awbs) || awbs.length === 0) {
            return res.status(400).json({ message: 'AWBs array is required' });
        }

        const currentBranchId = getEffectiveBranchId(req);
        if (!currentBranchId) {
            return res.status(400).json({ message: 'Branch ID is required to create RTO manifest' });
        }

        // Validate all shipments are in RTO initiated state
        const shipments = await Shipment.find({ awb: { $in: awbs } });
        if (shipments.length !== awbs.length) {
            const found = shipments.map(s => s.awb);
            const missing = awbs.filter(a => !found.includes(a));
            return res.status(404).json({
                message: `Some shipments not found: ${missing.join(', ')}`
            });
        }

        const invalidShipments = shipments.filter(s => s.rtoStatus !== 'initiated');
        if (invalidShipments.length > 0) {
            return res.status(400).json({
                message: `Some shipments are not in RTO initiated state`,
                invalidShipments: invalidShipments.map(s => ({ awb: s.awb, rtoStatus: s.rtoStatus }))
            });
        }

        // All RTO shipments should go to their respective origin branches
        // For simplicity, group by origin branch (if all go to same origin, one manifest)
        const originBranches = [...new Set(shipments.map(s => (s.originBranchId || s.branchId).toString()))];
        
        if (originBranches.length > 1) {
            return res.status(400).json({
                message: 'All RTO shipments must have the same origin branch for a single manifest',
                originBranches: originBranches
            });
        }

        const destinationBranchId = originBranches[0];

        // Create RTO manifest
        const manifestId = generateManifestId();
        const manifest = new Manifest({
            manifestId,
            sourceBranch: currentBranchId,
            destinationBranch: destinationBranchId,
            shipments: shipments.map(s => s._id),
            transportDetails: transportDetails || { mode: 'surface' },
            status: 'open',
            stats: {
                totalShipments: shipments.length,
                totalWeight: shipments.reduce((sum, s) => sum + (s.weight || 0), 0)
            }
        });

        // Link bag if provided
        if (bagId) {
            const bag = await Bag.findById(bagId);
            if (bag) {
                manifest.bagTags = [bag.bagId || bag._id];
            }
        }

        await manifest.save();

        // Update all shipments with RTO manifest ID and status
        await Shipment.updateMany(
            { awb: { $in: awbs } },
            {
                $set: {
                    status: 'rto_in_transit',
                    rtoStatus: 'in_transit',
                    rtoManifestId: manifest._id
                },
                $push: {
                    history: {
                        status: 'rto_in_transit',
                        branchId: currentBranchId,
                        updatedBy: req.user._id,
                        remark: `RTO manifest created: ${manifestId}`
                    },
                    journey: {
                        leg: { $add: [{ $size: '$journey' }, 1] },
                        type: 'rto',
                        fromBranch: currentBranchId,
                        toBranch: destinationBranchId,
                        manifestId: manifest._id,
                        timestamp: new Date(),
                        remark: `RTO manifest created: ${manifestId}`
                    }
                }
            }
        );

        // Audit log
        logAudit({
            action: 'RTO_MANIFEST_CREATE',
            entity: 'Manifest',
            entityId: manifest._id,
            manifestId,
            userId: req.user._id,
            userRole: req.user.role?.name,
            branchId: currentBranchId,
            details: { awbs, destinationBranchId, transportDetails }
        });

        res.status(201).json({
            message: 'RTO manifest created successfully',
            manifestId,
            manifest,
            shipmentCount: shipments.length,
            destinationBranchId
        });

    } catch (error) {
        console.error('Error creating RTO manifest:', error);
        res.status(500).json({ message: 'Server Error creating RTO manifest', error: error.message });
    }
};

// @desc    Dispatch RTO manifest (mark as in transit)
// @route   PUT /api/rto/manifest/:manifestId/dispatch
// @access  Branch Admin, Dispatcher
exports.dispatchRTO = async (req, res) => {
    try {
        const { manifestId } = req.params;
        const { vehicleNo, driverName, driverPhone, tripId } = req.body;

        let manifest;
        if (manifestId.match(/^[0-9a-fA-F]{24}$/)) {
            manifest = await Manifest.findById(manifestId);
        } else {
            manifest = await Manifest.findOne({ manifestId });
        }

        if (!manifest) {
            return res.status(404).json({ message: 'RTO manifest not found' });
        }

        if (!['open', 'closed', 'vehicle_assigned'].includes(manifest.status)) {
            return res.status(400).json({
                message: `Cannot dispatch manifest in status: ${manifest.status}`
            });
        }

        // Update manifest
        manifest.status = 'in_transit';
        manifest.departedAt = new Date();
        manifest.departedBy = req.user._id;
        if (vehicleNo) manifest.transportDetails.vehicleNo = vehicleNo;
        if (driverName) manifest.transportDetails.driverName = driverName;
        if (driverPhone) manifest.transportDetails.driverPhone = driverPhone;
        if (tripId) manifest.tripId = tripId;

        await manifest.save();

        // Update all shipments in manifest
        await Shipment.updateMany(
            { _id: { $in: manifest.shipments } },
            {
                $set: { status: 'rto_in_transit', rtoStatus: 'in_transit' },
                $push: {
                    history: {
                        status: 'rto_in_transit',
                        branchId: manifest.sourceBranch,
                        updatedBy: req.user._id,
                        remark: `RTO manifest dispatched: ${manifest.manifestId}`
                    }
                }
            }
        );

        logAudit({
            action: 'RTO_DISPATCH',
            entity: 'Manifest',
            entityId: manifest._id,
            manifestId: manifest.manifestId,
            userId: req.user._id,
            userRole: req.user.role?.name,
            branchId: manifest.sourceBranch,
            details: { vehicleNo, driverName, tripId }
        });

        res.json({
            message: 'RTO manifest dispatched successfully',
            manifestId: manifest.manifestId,
            status: manifest.status
        });

    } catch (error) {
        console.error('Error dispatching RTO:', error);
        res.status(500).json({ message: 'Server Error dispatching RTO', error: error.message });
    }
};

// @desc    Receive RTO at origin branch
// @route   PUT /api/rto/manifest/:manifestId/receive
// @access  Branch Admin, Dispatcher
exports.receiveRTO = async (req, res) => {
    try {
        const { manifestId } = req.params;
        const { scannedAwbs, remark } = req.body;

        let manifest;
        if (manifestId.match(/^[0-9a-fA-F]{24}$/)) {
            manifest = await Manifest.findById(manifestId);
        } else {
            manifest = await Manifest.findOne({ manifestId });
        }

        if (!manifest) {
            return res.status(404).json({ message: 'RTO manifest not found' });
        }

        if (!['in_transit', 'arrived'].includes(manifest.status)) {
            return res.status(400).json({
                message: `Cannot receive manifest in status: ${manifest.status}. Manifest must be in transit.`
            });
        }

        // Mark manifest as arrived
        manifest.status = 'arrived';
        manifest.arrivedAt = new Date();
        manifest.arrivedBy = req.user._id;

        // Process scanned AWBs
        let receivedCount = 0;
        let missingCount = 0;
        let damagedCount = 0;

        if (scannedAwbs && Array.isArray(scannedAwbs)) {
            const shipments = await Shipment.find({ _id: { $in: manifest.shipments } });

            for (const awb of scannedAwbs) {
                const shipment = shipments.find(s => s.awb === awb);
                if (shipment) {
                    manifest.scannedShipments.push({
                        shipment: shipment._id,
                        awb,
                        scannedAt: new Date(),
                        scannedBy: req.user._id,
                        scanStatus: 'received'
                    });
                    receivedCount++;
                }
            }

            // Check for missing shipments
            const scannedAwbsSet = new Set(scannedAwbs);
            for (const shipment of shipments) {
                if (!scannedAwbsSet.has(shipment.awb)) {
                    manifest.scannedShipments.push({
                        shipment: shipment._id,
                        awb: shipment.awb,
                        scannedAt: new Date(),
                        scannedBy: req.user._id,
                        scanStatus: 'missing'
                    });
                    missingCount++;
                }
            }
        } else {
            // No scanning - mark all as received
            const shipments = await Shipment.find({ _id: { $in: manifest.shipments } });
            for (const shipment of shipments) {
                manifest.scannedShipments.push({
                    shipment: shipment._id,
                    awb: shipment.awb,
                    scannedAt: new Date(),
                    scannedBy: req.user._id,
                    scanStatus: 'received'
                });
                receivedCount++;
            }
        }

        manifest.stats.receivedShipments = receivedCount;
        manifest.stats.missingShipments = missingCount;
        manifest.stats.damagedShipments = damagedCount;

        await manifest.save();

        // Update all received shipments
        await Shipment.updateMany(
            { _id: { $in: manifest.shipments } },
            {
                $set: {
                    status: 'rto_received',
                    rtoStatus: 'received_at_origin',
                    rtoReceivedAt: new Date(),
                    currentBranch: manifest.destinationBranch
                },
                $push: {
                    history: {
                        status: 'rto_received',
                        branchId: manifest.destinationBranch,
                        updatedBy: req.user._id,
                        remark: remark || `RTO received at origin branch. Manifest: ${manifest.manifestId}`
                    },
                    journey: {
                        leg: { $add: [{ $size: '$journey' }, 1] },
                        type: 'rto',
                        fromBranch: manifest.sourceBranch,
                        toBranch: manifest.destinationBranch,
                        manifestId: manifest._id,
                        timestamp: new Date(),
                        remark: `RTO received at origin branch`
                    }
                }
            }
        );

        // Create exception for missing shipments
        if (missingCount > 0) {
            try {
                const exceptionId = await generateExceptionId();
                await Exception.create({
                    exceptionId,
                    type: 'LOST',
                    title: `RTO Manifest ${manifest.manifestId} - ${missingCount} missing shipments`,
                    description: `${missingCount} shipments missing from RTO manifest ${manifest.manifestId}`,
                    severity: 'CRITICAL',
                    status: 'OPEN',
                    category: 'OPERATIONAL',
                    branchId: manifest.destinationBranch,
                    createdBy: req.user._id
                });
            } catch (excErr) {
                console.error('Failed to create missing shipment exception:', excErr.message);
            }
        }

        logAudit({
            action: 'RTO_RECEIVE',
            entity: 'Manifest',
            entityId: manifest._id,
            manifestId: manifest.manifestId,
            userId: req.user._id,
            userRole: req.user.role?.name,
            branchId: manifest.destinationBranch,
            details: { receivedCount, missingCount, damagedCount }
        });

        res.json({
            message: 'RTO received at origin branch',
            manifestId: manifest.manifestId,
            stats: {
                total: manifest.stats.totalShipments,
                received: receivedCount,
                missing: missingCount,
                damaged: damagedCount
            }
        });

    } catch (error) {
        console.error('Error receiving RTO:', error);
        res.status(500).json({ message: 'Server Error receiving RTO', error: error.message });
    }
};

// @desc    Complete RTO process
// @route   PUT /api/rto/complete/:awb
// @access  Branch Admin, Super Admin
exports.completeRTO = async (req, res) => {
    try {
        const { awb } = req.params;
        const { disposalType, remark } = req.body;

        // disposalType: 'returned_to_customer', 'disposed', 'held_at_branch', 're_shipped'

        const shipment = await Shipment.findOne({ awb });
        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        if (shipment.rtoStatus !== 'received_at_origin') {
            return res.status(400).json({
                message: `Cannot complete RTO. Shipment must be received at origin first. Current RTO status: ${shipment.rtoStatus}`
            });
        }

        await Shipment.updateOne(
            { awb },
            {
                $set: {
                    status: 'rto_completed',
                    rtoStatus: 'completed',
                    rtoCompletedAt: new Date()
                },
                $push: {
                    history: {
                        status: 'rto_completed',
                        branchId: req.user.branchId || shipment.originBranchId,
                        updatedBy: req.user._id,
                        remark: remark || `RTO completed. Disposal: ${disposalType || 'returned_to_customer'}`
                    },
                    journey: {
                        leg: (shipment.journey?.length || 0) + 1,
                        type: 'rto',
                        fromBranch: shipment.currentBranch,
                        toBranch: shipment.originBranchId,
                        timestamp: new Date(),
                        remark: `RTO completed - ${disposalType || 'returned_to_customer'}`
                    }
                }
            }
        );

        // Close the RTO exception
        await Exception.updateOne(
            { awb, type: { $in: ['RTO_AUTO', 'RTO_MANUAL'] }, status: 'OPEN' },
            {
                $set: {
                    status: 'CLOSED',
                    resolvedBy: req.user._id,
                    resolvedAt: new Date(),
                    resolution: `RTO completed. Disposal: ${disposalType || 'returned_to_customer'}`
                }
            }
        );

        logAudit({
            action: 'RTO_COMPLETE',
            entity: 'Shipment',
            entityId: shipment._id,
            awb,
            userId: req.user._id,
            userRole: req.user.role?.name,
            branchId: req.user.branchId,
            details: { disposalType, remark }
        });

        // Fire-and-forget: notify customer of RTO completion
        notifyRTOCompleted(shipment, shipment.rtoCharges, req.user);

        res.json({
            message: 'RTO completed successfully',
            awb,
            rtoStatus: 'completed',
            disposalType: disposalType || 'returned_to_customer'
        });

    } catch (error) {
        console.error('Error completing RTO:', error);
        res.status(500).json({ message: 'Server Error completing RTO', error: error.message });
    }
};

// @desc    Cancel RTO (if re-delivery is possible)
// @route   PUT /api/rto/cancel/:awb
// @access  Branch Admin, Super Admin
exports.cancelRTO = async (req, res) => {
    try {
        const { awb } = req.params;
        const { reason, remark } = req.body;

        if (!reason) {
            return res.status(400).json({ message: 'Cancellation reason is required' });
        }

        const shipment = await Shipment.findOne({ awb });
        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Can only cancel RTO if it's initiated but not yet in transit
        if (!['initiated'].includes(shipment.rtoStatus)) {
            return res.status(400).json({
                message: `Cannot cancel RTO in status: ${shipment.rtoStatus}. Can only cancel if RTO is in 'initiated' state.`
            });
        }

        await Shipment.updateOne(
            { awb },
            {
                $set: {
                    status: 'not_scheduled',
                    rtoStatus: 'cancelled',
                    rtoReason: `CANCELLED: ${reason}`
                },
                $push: {
                    history: {
                        status: 'not_scheduled',
                        branchId: req.user.branchId || shipment.currentBranch,
                        updatedBy: req.user._id,
                        remark: remark || `RTO cancelled: ${reason}`
                    }
                }
            }
        );

        // Close the RTO exception
        await Exception.updateOne(
            { awb, type: { $in: ['RTO_AUTO', 'RTO_MANUAL'] }, status: 'OPEN' },
            {
                $set: {
                    status: 'CLOSED',
                    resolvedBy: req.user._id,
                    resolvedAt: new Date(),
                    resolution: `RTO cancelled: ${reason}`
                }
            }
        );

        logAudit({
            action: 'RTO_CANCEL',
            entity: 'Shipment',
            entityId: shipment._id,
            awb,
            userId: req.user._id,
            userRole: req.user.role?.name,
            branchId: req.user.branchId,
            details: { reason, remark }
        });

        res.json({
            message: 'RTO cancelled successfully. Shipment available for re-delivery.',
            awb,
            status: 'not_scheduled',
            rtoStatus: 'cancelled'
        });

    } catch (error) {
        console.error('Error cancelling RTO:', error);
        res.status(500).json({ message: 'Server Error cancelling RTO', error: error.message });
    }
};

// @desc    Get all RTO shipments
// @route   GET /api/rto
// @access  Private
exports.getRTOShipments = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        let query = { rtoStatus: { $ne: 'none' } };

        // Apply scope
        const scopeQuery = buildScopeQuery(req, 'Shipment');
        if (scopeQuery && Object.keys(scopeQuery).length > 0) {
            Object.assign(query, scopeQuery);
        }

        // Filter by RTO status
        if (status && status !== 'all') {
            query.rtoStatus = status;
        }

        const shipments = await Shipment.find(query)
            .select('awb sender receiver status rtoStatus rtoReason rtoInitiatedAt rtoReceivedAt rtoCompletedAt rtoCharges deliveryAttempts maxDeliveryAttempts currentBranch originBranchId destinationBranch')
            .populate('currentBranch', 'name city')
            .populate('originBranchId', 'name city')
            .sort({ rtoInitiatedAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        const total = await Shipment.countDocuments(query);

        res.json({
            shipments,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('Error fetching RTO shipments:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Get RTO details for a specific shipment
// @route   GET /api/rto/:awb
// @access  Private
exports.getRTODetails = async (req, res) => {
    try {
        const { awb } = req.params;

        const shipment = await Shipment.findOne({ awb })
            .populate('originBranchId', 'name city address')
            .populate('destinationBranch', 'name city address')
            .populate('currentBranch', 'name city address')
            .populate('rtoManifestId', 'manifestId status sourceBranch destinationBranch departedAt arrivedAt')
            .populate('rtoInitiatedBy', 'name')
            .populate('deliveryAttemptHistory.drsId', 'drsId')
            .populate('deliveryAttemptHistory.riderId', 'name');

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Get related exceptions
        const exceptions = await Exception.find({ awb })
            .select('exceptionId type title status severity createdAt resolvedAt')
            .sort({ createdAt: -1 });

        res.json({
            shipment: {
                awb: shipment.awb,
                sender: shipment.sender,
                receiver: shipment.receiver,
                status: shipment.status,
                currentBranch: shipment.currentBranch,
                originBranch: shipment.originBranchId,
                destinationBranch: shipment.destinationBranch
            },
            rto: {
                rtoStatus: shipment.rtoStatus,
                rtoReason: shipment.rtoReason,
                rtoInitiatedAt: shipment.rtoInitiatedAt,
                rtoInitiatedBy: shipment.rtoInitiatedBy,
                rtoManifest: shipment.rtoManifestId,
                rtoReceivedAt: shipment.rtoReceivedAt,
                rtoCompletedAt: shipment.rtoCompletedAt,
                rtoCharges: shipment.rtoCharges
            },
            deliveryAttempts: {
                attempts: shipment.deliveryAttempts,
                maxAttempts: shipment.maxDeliveryAttempts,
                history: shipment.deliveryAttemptHistory
            },
            journey: shipment.journey,
            exceptions
        });

    } catch (error) {
        console.error('Error fetching RTO details:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Get RTO statistics
// @route   GET /api/rto/stats
// @access  Private
exports.getRTOStats = async (req, res) => {
    try {
        let matchStage = { rtoStatus: { $ne: 'none' } };

        // Apply scope
        const scopeQuery = buildScopeQuery(req, 'Shipment');
        if (scopeQuery && Object.keys(scopeQuery).length > 0) {
            Object.assign(matchStage, scopeQuery);
        }

        const stats = await Shipment.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: '$rtoStatus',
                    count: { $sum: 1 },
                    totalCharges: { $sum: '$rtoCharges' }
                }
            }
        ]);

        // Get total shipments for RTO rate calculation
        const totalShipments = await Shipment.countDocuments({
            ...scopeQuery,
            rtoStatus: { $ne: 'none' }
        });

        const allShipments = await Shipment.countDocuments(scopeQuery || {});
        const rtoRate = allShipments > 0 ? ((totalShipments / allShipments) * 100).toFixed(2) : 0;

        // Format stats
        const statsMap = {};
        stats.forEach(s => {
            statsMap[s._id] = { count: s.count, totalCharges: s.totalCharges };
        });

        res.json({
            totalRTOShipments: totalShipments,
            rtoRate: `${rtoRate}%`,
            byStatus: {
                initiated: statsMap['initiated'] || { count: 0, totalCharges: 0 },
                in_transit: statsMap['in_transit'] || { count: 0, totalCharges: 0 },
                received_at_origin: statsMap['received_at_origin'] || { count: 0, totalCharges: 0 },
                completed: statsMap['completed'] || { count: 0, totalCharges: 0 },
                cancelled: statsMap['cancelled'] || { count: 0, totalCharges: 0 }
            }
        });

    } catch (error) {
        console.error('Error fetching RTO stats:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};
