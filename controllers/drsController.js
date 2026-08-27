const DRS = require('../models/DRS');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Shipment = require('../models/Shipment');
const Exception = require('../models/Exception');
const { logAudit } = require('../utils/auditLogger');
const { generateExceptionId } = require('../utils/idGenerator');
const { notifyDelivered, notifyDeliveryFailed, notifyRTOInitiated, notifyOutForDelivery } = require('../utils/notificationHelper');
const { validateStatusTransition, getValidNextStatuses } = require('../utils/validationGuards');

// Helper to generate DRS ID
const generateDRSId = async () => {
    const date = new Date();
    const prefix = `DRS${date.getFullYear().toString().substr(-2)}${(date.getMonth() + 1).toString().padStart(2, '0')}`;
    // Simple logic for now, in production use atomic counter
    const count = await DRS.countDocuments({ drsId: { $regex: prefix } });
    return `${prefix}-${(count + 1).toString().padStart(4, '0')}`;
};

// @desc    Create new DRS
// @route   POST /api/drs/create
// @access  Branch Admin, Dispatcher, Super Admin
exports.createDRS = async (req, res) => {
    try {
        const { riderId, vehicleMode, pincodes, shipments, scheduledDate, startDate, endDate } = req.body;

        // Validation
        if (!riderId || !shipments) {
            return res.status(400).json({ message: 'Rider and Shipments are required' });
        }

        // Generate ID
        const drsId = await generateDRSId();

        // Determine initial status
        let status = 'scheduled';

        // NEW: Integrate with Shipment Model
        // 1. Verify all shipments exist and are in valid state (e.g., inwarded, rto) if enforcing strict flow
        // For now, assuming provided 'shipments' array contains AWB strings.

        const awbList = shipments.map(s => (typeof s === 'string' ? s : s.awb));

        // Update Shipments Status to 'scheduled'
        await Shipment.updateMany(
            { awb: { $in: awbList } },
            {
                $set: { status: 'scheduled' },
                $push: {
                    history: {
                        status: 'scheduled',
                        branchId: req.body.branchId || req.user.branchId || 'HEAD_OFFICE',
                        updatedBy: req.user._id,
                        remark: `Added to DRS ${drsId}`
                    }
                }
            }
        );

        const newDRS = new DRS({
            drsId,
            rider: riderId,
            branchId: req.body.branchId || req.user.branchId || 'HEAD_OFFICE', // Allow passing branchId (for partner/super admin)
            vehicleMode,
            pincodes: pincodes || [],
            shipments: shipments.map(s => ({ awb: typeof s === 'string' ? s : s.awb, status: 'pending' })),
            status,
            scheduledDate: scheduledDate ? new Date(scheduledDate) : new Date(),
            startDate: startDate ? new Date(startDate) : null,
            endDate: endDate ? new Date(endDate) : null,
            stats: {
                totalShipments: shipments.length,
                pendingShipments: shipments.length
            },
            createdBy: req.user._id
        });

        const savedDRS = await newDRS.save();
        res.status(201).json(savedDRS);

    } catch (error) {
        console.error('Error creating DRS:', error);
        res.status(500).json({ message: 'Server Error creating DRS' });
    }
};

// @desc    Get All DRS (Scoped by Role)
// @route   GET /api/drs/list
// @access  Private
exports.getAllDRS = async (req, res) => {
    try {
        let matchStage = {};

        // Role-based Scoping
        const roleName = req.user.role.name;

        if (roleName === 'super_admin') {
            // Super Admin sees ALL DRS across all branches
        } else if (roleName === 'partner_admin' || roleName === 'partner') {
            const partnerBranches = await Branch.find({ partnerId: req.user._id }).select('_id');
            const branchIds = partnerBranches.map(b => b._id.toString());
            matchStage.branchId = { $in: branchIds };
        } else if (roleName === 'branch_admin' || roleName === 'dispatcher' || roleName === 'branch') {
            if (req.user.branchId) {
                matchStage.branchId = req.user.branchId.toString();
            }
        } else if (roleName === 'rider') {
            matchStage.rider = req.user._id;
        }

        // CRITICAL: Exclude deleted DRS
        matchStage.status = { $ne: 'deleted' };

        // Filter by Status if requested
        if (req.query.status && req.query.status !== 'all') {
            matchStage.status = req.query.status;
        }

        const drsList = await DRS.aggregate([
            { $match: matchStage },
            { $sort: { createdAt: -1 } },
            // Lookup Rider
            {
                $lookup: {
                    from: 'users',
                    localField: 'rider',
                    foreignField: '_id',
                    as: 'rider'
                }
            },
            { $unwind: { path: '$rider', preserveNullAndEmptyArrays: true } },
            // Lookup Shipments (CRITICAL for Pincode/Inward dates)
            {
                $lookup: {
                    from: 'shipments',
                    let: { drsShipments: '$shipments' }, // Pass the DRS shipments array
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $in: ['$awb', '$$drsShipments.awb'] // Match AWBs from the DRS array
                                }
                            }
                        },
                        {
                            $project: {
                                awb: 1,
                                'receiver.pincode': 1,
                                createdAt: 1, // Inward Date
                                deliveredAt: 1, // Completion Date
                                // We don't need status here as the DRS has the 'current' status for that run
                            }
                        }
                    ],
                    as: 'shipmentDetails'
                }
            },
            // Merge details back into the shipments array
            {
                $addFields: {
                    shipments: {
                        $map: {
                            input: '$shipments',
                            as: 's',
                            in: {
                                $mergeObjects: [
                                    '$$s',
                                    {
                                        $arrayElemAt: [
                                            {
                                                $filter: {
                                                    input: '$shipmentDetails',
                                                    as: 'sd',
                                                    cond: { $eq: ['$$sd.awb', '$$s.awb'] }
                                                }
                                            },
                                            0
                                        ]
                                    }
                                ]
                            }
                        }
                    }
                }
            },
            // Cleanup lookup
            { $project: { shipmentDetails: 0 } },
            // Populate Branch (Simulated via lookup if needed, but usually ID is enough or separate call)
            // Keeping it simple since original code populated branchId
            {
                $lookup: {
                    from: 'branches',
                    let: { drsBranchId: '$branchId' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $eq: [{ $toString: '$_id' }, '$$drsBranchId']
                                }
                            }
                        }
                    ],
                    as: 'branchId'
                }
            },
            { $unwind: { path: '$branchId', preserveNullAndEmptyArrays: true } }
        ]);

        res.json(drsList);
    } catch (error) {
        console.error('Error fetching DRS:', error);
        res.status(500).json({ message: 'Server Error fetching DRS' });
    }
};

// @desc    Update DRS (General Info)
// @route   PUT /api/drs/:id
// @access  Private
exports.updateDRS = async (req, res) => {
    try {
        const { riderId, vehicleMode, pincodes, shipments, scheduledDate, startDate, endDate } = req.body;

        let drs;
        if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            drs = await DRS.findById(req.params.id);
        } else {
            drs = await DRS.findOne({ drsId: req.params.id });
        }

        if (!drs) {
            return res.status(404).json({ message: 'DRS not found' });
        }

        // Update basic fields
        if (riderId) drs.rider = riderId;
        if (vehicleMode) drs.vehicleMode = vehicleMode;
        if (pincodes) drs.pincodes = pincodes;

        // HANDLE SHIPMENT UPDATES CORRECTLY
        if (shipments) {
            // 1. Identify Removed Shipments
            const newAwbList = shipments.map(s => (typeof s === 'string' ? s : s.awb));
            const existingShipments = drs.shipments.map(s => (typeof s === 'string' ? s : s.awb));

            console.log(`[DRS Update] Updating ${req.params.id}. Old Count: ${existingShipments.length}, New Count: ${newAwbList.length}`);

            // 1. Detect Removed Shipments
            const removedShipments = existingShipments.filter(oldS => !newAwbList.includes(oldS));

            if (removedShipments.length > 0) {
                console.log(`[DRS Update] Removed Shipments: ${removedShipments.join(', ')}`);
                // Reset their status to 'inwarded' (Available for other DRS)
                // Also need to set currentBranch back to drs.branchId? Assuming they were staying at branch.
                // When added to DRS, they are scheduled/out_for_delivery.

                await Shipment.updateMany(
                    { awb: { $in: removedShipments } },
                    {
                        $set: { status: 'not_scheduled' },
                        $push: {
                            history: {
                                status: 'not_scheduled',
                                branchId: req.user.branchId, // Assuming update is done by branch admin
                                updatedBy: req.user._id,
                                remark: `Removed from DRS ${drs.drsId}`
                            }
                        }
                    }
                );
            }

            // 2. Detect NEW Added Shipments
            const addedShipments = newAwbList.filter(newS => !existingShipments.includes(newS));

            if (addedShipments.length > 0) {
                console.log(`[DRS Update] Added Shipments: ${addedShipments.join(', ')}`);
                await Shipment.updateMany(
                    { awb: { $in: addedShipments } },
                    {
                        $set: { status: 'scheduled' },
                        $push: {
                            history: {
                                status: 'scheduled',
                                branchId: req.user.branchId,
                                updatedBy: req.user._id,
                                remark: `Added to DRS ${drs.drsId}`
                            }
                        }
                    }
                );
            }
            // 4. Update DRS Shipment List (Preserve existing statuses for kept items)
            drs.shipments = shipments.map(s => {
                const awb = typeof s === 'string' ? s : s.awb;

                // If it's a new item, default to pending
                if (addedShipments.includes(awb)) {
                    return { awb, status: 'pending' };
                }

                // If existing, try to find old state to preserve custom statuses (like delivered)
                const oldState = drs.shipments.find(old => old.awb === awb);
                if (oldState) {
                    return {
                        awb,
                        status: oldState.status,
                        deliveredAt: oldState.deliveredAt,
                        rescheduledDate: oldState.rescheduledDate
                    };
                }

                // Fallback (shouldn't happen for existing items)
                return { awb, status: 'pending' };
            });

            // Update stats
            drs.stats.totalShipments = drs.shipments.length;
            drs.stats.completedShipments = drs.shipments.filter(s => s.status === 'delivered' || s.status === 'completed').length;
            drs.stats.pendingShipments = drs.shipments.filter(s => ['pending', 'in_transit'].includes(s.status)).length;
        }

        // CRITICAL: Handle date edit for active DRS
        if (scheduledDate && drs.status === 'in_progress') {
            const newDate = new Date(scheduledDate);
            newDate.setHours(0, 0, 0, 0);

            const currentDate = new Date();
            currentDate.setHours(0, 0, 0, 0);

            if (newDate > currentDate) {
                // Future date: Mark shipments as "scheduled_for_later"
                let rescheduleCount = 0;
                for (let i = 0; i < drs.shipments.length; i++) {
                    const s = drs.shipments[i];
                    const status = s.status ? s.status.toLowerCase().trim() : '';

                    if (['pending', 'in_progress'].includes(status)) {
                        s.status = 'scheduled_for_later';
                        s.rescheduledDate = newDate;
                        rescheduleCount++;
                    }
                }

                drs.rescheduledDate = newDate;
                drs.isRescheduled = true;
                drs.scheduledDate = newDate;

                drs.markModified('shipments');
                console.log(`✅ Date Impact: Rescheduled ${rescheduleCount} shipments to ${newDate.toDateString()}`);
            } else {
                // Revert Logic
                let revertCount = 0;
                for (let i = 0; i < drs.shipments.length; i++) {
                    const s = drs.shipments[i];
                    if (s.status === 'scheduled_for_later') {
                        s.status = 'pending';
                        s.rescheduledDate = undefined;
                        revertCount++;
                    }
                }

                drs.isRescheduled = false;
                drs.rescheduledDate = undefined;
                drs.scheduledDate = newDate;

                drs.markModified('shipments');
                console.log(`✅ Date Impact: Reverted ${revertCount} shipments to Pending`);
            }
        } else if (scheduledDate) {
            drs.scheduledDate = new Date(scheduledDate);
        }

        if (startDate) drs.startDate = new Date(startDate);
        if (endDate) drs.endDate = new Date(endDate);

        await drs.save();
        res.json(drs);

    } catch (error) {
        console.error('Error updating DRS:', error);
        res.status(500).json({ message: 'Server Error updating DRS' });
    }
};

// @desc    Update DRS Status
// @route   PUT /api/drs/:id/status
// @access  Private (Rider typically)
exports.updateDRSStatus = async (req, res) => {
    try {
        const { status } = req.body;

        let drs;
        if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            drs = await DRS.findById(req.params.id);
        } else {
            drs = await DRS.findOne({ drsId: req.params.id });
        }

        if (!drs) {
            return res.status(404).json({ message: 'DRS not found' });
        }

        drs.status = status;

        if (status === 'in_progress' && !drs.startDate) {
            drs.startDate = new Date();

            // SYNC: Update all associated shipments to 'in_progress'
            const awbsToUpdate = drs.shipments.map(s => typeof s === 'string' ? s : s.awb);

            if (awbsToUpdate.length > 0) {
                await Shipment.updateMany(
                    { awb: { $in: awbsToUpdate }, status: 'scheduled' }, // Only update scheduled ones
                    {
                        $set: { status: 'in_progress' },
                        $push: {
                            history: {
                                status: 'in_progress',
                                branchId: drs.branchId || 'HEAD_OFFICE',
                                updatedBy: req.user._id,
                                remark: `DRS ${drs.drsId} Started`
                            }
                        }
                    }
                );
            }
        }

        if (status === 'completed' && !drs.endDate) {
            drs.endDate = new Date();
        }

        await drs.save();
        res.json(drs);

    } catch (error) {
        console.error('Error updating DRS status:', error);
        res.status(500).json({ message: 'Server Error updating DRS status' });
    }
};

// @desc    Update Shipment Status
// @route   PUT /api/drs/:id/shipment/status
// @access  Private (Rider)
exports.updateShipmentStatus = async (req, res) => {
    try {
        const { awb, status, failureReason, remark, nextAttemptDate } = req.body;

        if (!awb || !status) {
            return res.status(400).json({ message: 'AWB and status are required' });
        }

        let targetDRS;
        if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            targetDRS = await DRS.findById(req.params.id);
        } else {
            targetDRS = await DRS.findOne({ drsId: req.params.id });
        }

        if (!targetDRS) return res.status(404).json({ message: 'DRS not found' });

        const shipmentIndex = targetDRS.shipments.findIndex(s => s.awb === awb);
        if (shipmentIndex === -1) {
            return res.status(404).json({ message: 'Shipment not found in this DRS' });
        }

        // Fetch the shipment to check/update delivery attempts
        const shipment = await Shipment.findOne({ awb });
        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found in database' });
        }

        // =====================================================
        // PHASE 4.3: Status Transition Validation Guard
        // =====================================================
        // Map rider-facing status to internal status for validation
        const statusMap = {
            'delivered': 'delivered',
            'failed': 'delivery_failed',
            'undelivered': 'delivery_failed',
            'out_for_delivery': 'out_for_delivery',
            'rto_initiated': 'rto_initiated',
            'cancelled': 'cancelled'
        };
        const targetInternalStatus = statusMap[status] || status;
        const transitionCheck = validateStatusTransition(shipment.status, targetInternalStatus);
        if (!transitionCheck.valid) {
            return res.status(409).json({
                message: 'Invalid status transition',
                currentStatus: shipment.status,
                attemptedStatus: targetInternalStatus,
                validNextStatuses: getValidNextStatuses(shipment.status),
                reason: transitionCheck.reason
            });
        }

        // =====================================================
        // PHASE 3.1: Delivery Attempt Tracking & Re-attempt Logic
        // =====================================================
        let rtoAutoInitiated = false;
        let attemptOutcome = null;
        let mappedStatus = null;

        if (status === 'delivered') {
            // Successful delivery
            attemptOutcome = 'delivered';
            mappedStatus = 'pending_for_branch_approval';

            // Record successful delivery attempt
            const attemptNumber = (shipment.deliveryAttempts || 0) + 1;
            await Shipment.updateOne(
                { awb },
                {
                    $set: {
                        status: mappedStatus,
                        deliveredAt: new Date()
                    },
                    $push: {
                        deliveryAttemptHistory: {
                            attemptNumber,
                            date: new Date(),
                            drsId: targetDRS._id,
                            riderId: targetDRS.rider,
                            riderName: req.user.name || 'Rider',
                            outcome: 'delivered',
                            remark: remark || 'Delivery successful',
                            nextAttemptDate: null
                        },
                        history: {
                            status: mappedStatus,
                            branchId: targetDRS.branchId || 'HEAD_OFFICE',
                            updatedBy: req.user._id,
                            remark: `Delivery successful - Attempt #${attemptNumber} (DRS: ${targetDRS.drsId})`
                        },
                        journey: {
                            leg: (shipment.journey?.length || 0) + 1,
                            type: 'last_mile',
                            fromBranch: targetDRS.branchId,
                            toBranch: targetDRS.branchId,
                            drsId: targetDRS._id,
                            timestamp: new Date(),
                            remark: `Delivery attempt #${attemptNumber} - SUCCESS (DRS: ${targetDRS.drsId})`
                        }
                    }
                }
            );
        } else if (['failed', 'undelivered'].includes(status)) {
            // Failed delivery attempt
            attemptOutcome = 'failed';
            const attemptNumber = (shipment.deliveryAttempts || 0) + 1;
            const maxAttempts = shipment.maxDeliveryAttempts || 3;

            // Determine outcome category
            let outcomeCategory = 'failed';
            if (failureReason) {
                const reason = failureReason.toLowerCase();
                if (reason.includes('customer') && reason.includes('unavailable')) outcomeCategory = 'customer_unavailable';
                else if (reason.includes('wrong') && reason.includes('address')) outcomeCategory = 'wrong_address';
                else if (reason.includes('refus')) outcomeCategory = 'refused';
                else if (reason.includes('reschedul')) outcomeCategory = 'rescheduled';
            }

            // Check if max attempts reached → auto-initiate RTO
            if (attemptNumber >= maxAttempts) {
                // AUTO-INITIATE RTO
                rtoAutoInitiated = true;
                mappedStatus = 'rto_initiated';

                await Shipment.updateOne(
                    { awb },
                    {
                        $set: {
                            status: 'rto_initiated',
                            rtoStatus: 'initiated',
                            rtoReason: `Max delivery attempts (${maxAttempts}) exhausted. Last failure: ${failureReason || 'N/A'}`,
                            rtoInitiatedAt: new Date(),
                            rtoInitiatedBy: req.user._id
                        },
                        $inc: { deliveryAttempts: 1 },
                        $push: {
                            deliveryAttemptHistory: {
                                attemptNumber,
                                date: new Date(),
                                drsId: targetDRS._id,
                                riderId: targetDRS.rider,
                                riderName: req.user.name || 'Rider',
                                outcome: outcomeCategory,
                                failureReason: failureReason || 'Delivery failed',
                                remark: remark || `Attempt #${attemptNumber} failed - RTO auto-initiated`,
                                nextAttemptDate: null
                            },
                            history: {
                                status: 'rto_initiated',
                                branchId: targetDRS.branchId || 'HEAD_OFFICE',
                                updatedBy: req.user._id,
                                remark: `RTO auto-initiated after ${attemptNumber}/${maxAttempts} failed attempts (DRS: ${targetDRS.drsId})`
                            },
                            journey: {
                                leg: (shipment.journey?.length || 0) + 1,
                                type: 'rto',
                                fromBranch: targetDRS.branchId,
                                toBranch: shipment.originBranchId,
                                drsId: targetDRS._id,
                                timestamp: new Date(),
                                remark: `RTO initiated - ${attemptNumber}/${maxAttempts} attempts exhausted (DRS: ${targetDRS.drsId})`
                            }
                        }
                    }
                );

                // Auto-create Exception for RTO
                try {
                    const exceptionId = await generateExceptionId();
                    await Exception.create({
                        exceptionId,
                        awb,
                        shipmentId: shipment._id,
                        type: 'RTO_AUTO',
                        title: `RTO Auto-Initiated - ${maxAttempts} attempts exhausted`,
                        description: `RTO auto-initiated: ${maxAttempts} delivery attempts exhausted. Last failure reason: ${failureReason || 'N/A'}. Shipment will be returned to origin branch.`,
                        severity: 'HIGH',
                        status: 'OPEN',
                        branchId: targetDRS.branchId,
                        partnerId: shipment.partnerId,
                        createdBy: req.user._id
                    });
                } catch (excErr) {
                    console.error('Failed to create RTO exception:', excErr.message);
                }

                // Update DRS shipment status to 'failed' (finalized)
                targetDRS.shipments[shipmentIndex].status = 'failed';
                targetDRS.shipments[shipmentIndex].deliveredAt = undefined;
            } else {
                // Still have attempts remaining → mark as delivery_failed, available for re-attempt
                mappedStatus = 'delivery_failed';

                // Calculate next attempt date (default: next business day)
                const nextDate = nextAttemptDate ? new Date(nextAttemptDate) : new Date(Date.now() + 24 * 60 * 60 * 1000);

                await Shipment.updateOne(
                    { awb },
                    {
                        $set: {
                            status: 'delivery_failed',
                            deliveredAt: undefined
                        },
                        $inc: { deliveryAttempts: 1 },
                        $push: {
                            deliveryAttemptHistory: {
                                attemptNumber,
                                date: new Date(),
                                drsId: targetDRS._id,
                                riderId: targetDRS.rider,
                                riderName: req.user.name || 'Rider',
                                outcome: outcomeCategory,
                                failureReason: failureReason || 'Delivery failed',
                                remark: remark || `Attempt #${attemptNumber} failed - ${maxAttempts - attemptNumber} attempts remaining`,
                                nextAttemptDate: nextDate
                            },
                            history: {
                                status: 'delivery_failed',
                                branchId: targetDRS.branchId || 'HEAD_OFFICE',
                                updatedBy: req.user._id,
                                remark: `Delivery attempt #${attemptNumber}/${maxAttempts} failed (DRS: ${targetDRS.drsId}). Next attempt: ${nextDate.toDateString()}`
                            },
                            journey: {
                                leg: (shipment.journey?.length || 0) + 1,
                                type: 'last_mile',
                                fromBranch: targetDRS.branchId,
                                toBranch: targetDRS.branchId,
                                drsId: targetDRS._id,
                                timestamp: new Date(),
                                remark: `Delivery attempt #${attemptNumber} - FAILED: ${failureReason || 'N/A'} (DRS: ${targetDRS.drsId})`
                            }
                        }
                    }
                );

                // Update DRS shipment status to 'failed' (will be available for re-attempt)
                targetDRS.shipments[shipmentIndex].status = 'failed';
                targetDRS.shipments[shipmentIndex].deliveredAt = undefined;
            }
        } else {
            // Other statuses (pending, in_transit, etc.)
            const shipmentStatusMap = {
                'undelivered': 'paused',
                'failed': 'paused',
                'pending': 'scheduled',
                'in_transit': 'in_progress'
            };
            mappedStatus = shipmentStatusMap[status] || 'in_progress';

            // Update internal DRS shipment status
            const internalStatus = status === 'delivered' ? 'pending_for_branch_approval' : status;
            targetDRS.shipments[shipmentIndex].status = internalStatus;

            if (['pending', 'in_transit'].includes(status)) {
                targetDRS.shipments[shipmentIndex].deliveredAt = undefined;
            }

            await Shipment.updateOne(
                { awb },
                {
                    $set: {
                        status: mappedStatus,
                        deliveredAt: status === 'delivered' ? new Date() : undefined,
                    },
                    $push: {
                        history: {
                            status: mappedStatus,
                            branchId: targetDRS.branchId || 'HEAD_OFFICE',
                            updatedBy: req.user._id,
                            remark: `Status updated via Rider Task (DRS: ${targetDRS.drsId})`
                        }
                    }
                }
            );
        }

        // For 'delivered' status, update DRS internal status
        if (status === 'delivered') {
            targetDRS.shipments[shipmentIndex].status = 'pending_for_branch_approval';
            targetDRS.shipments[shipmentIndex].deliveredAt = new Date();
        }

        // Recalculate ALL stats for accuracy
        const total = targetDRS.shipments.length;
        const completedCount = targetDRS.shipments.filter(s => s.status === 'completed').length;
        const pendingApprovalCount = targetDRS.shipments.filter(s => s.status === 'pending_for_branch_approval').length;
        const pending = targetDRS.shipments.filter(s => ['pending', 'in_transit'].includes(s.status)).length;

        targetDRS.stats.totalShipments = total;
        targetDRS.stats.completedShipments = completedCount;
        targetDRS.stats.pendingShipments = pending;

        // Auto-Complete DRS Check
        const isAllFinalized = !targetDRS.shipments.some(s => ['pending', 'in_transit', 'pending_for_branch_approval'].includes(s.status));

        if (isAllFinalized && ['scheduled', 'in_progress', 'paused'].includes(targetDRS.status)) {
            targetDRS.status = 'completed';
            targetDRS.endDate = new Date();
        } else if (!isAllFinalized && targetDRS.status === 'completed') {
            targetDRS.status = 'in_progress';
            targetDRS.endDate = null;
        }

        // CRITICAL: Tell Mongoose the array changed
        targetDRS.markModified('shipments');
        await targetDRS.save();

        // Audit log
        logAudit({
            action: 'SHIPMENT_STATUS_UPDATE',
            entity: 'Shipment',
            entityId: shipment._id,
            awb,
            userId: req.user._id,
            userRole: req.user.role?.name,
            branchId: targetDRS.branchId,
            details: { status, mappedStatus, failureReason, rtoAutoInitiated, drsId: targetDRS.drsId }
        });

        // Fire-and-forget: notify customer based on delivery outcome
        if (attemptOutcome === 'delivered') {
            notifyDelivered(shipment, { deliveredTo: req.body.deliveredTo || 'customer' }, req.user);
        } else if (attemptOutcome === 'failed') {
            if (rtoAutoInitiated) {
                notifyRTOInitiated(shipment, `Max delivery attempts exhausted. Last failure: ${failureReason || 'N/A'}`, req.user);
            } else {
                const nextDate = nextAttemptDate ? new Date(nextAttemptDate) : new Date(Date.now() + 24 * 60 * 60 * 1000);
                notifyDeliveryFailed(shipment, { reason: failureReason || 'Delivery failed', nextAttempt: nextDate.toDateString() }, req.user);
            }
        }

        res.json({
            ...targetDRS.toObject(),
            _deliveryAttemptInfo: {
                outcome: attemptOutcome,
                rtoAutoInitiated,
                deliveryAttempts: (shipment.deliveryAttempts || 0) + (['failed', 'undelivered', 'delivered'].includes(status) ? 1 : 0),
                maxDeliveryAttempts: shipment.maxDeliveryAttempts || 3,
                attemptsRemaining: Math.max(0, (shipment.maxDeliveryAttempts || 3) - ((shipment.deliveryAttempts || 0) + (['failed', 'undelivered'].includes(status) ? 1 : 0)))
            }
        });

    } catch (error) {
        console.error('Error updating Shipment status:', error);
        res.status(500).json({ message: 'Server Error updating Shipment Status', error: error.message });
    }
};

// @desc    Reschedule delivery for a failed shipment (re-attempt)
// @route   POST /api/drs/:id/reschedule
// @access  Branch Admin, Dispatcher
exports.rescheduleDelivery = async (req, res) => {
    try {
        const { awb, newDrsId, scheduledDate } = req.body;

        if (!awb) {
            return res.status(400).json({ message: 'AWB is required' });
        }

        const shipment = await Shipment.findOne({ awb });
        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Verify shipment is in a re-attemptable state
        if (!['delivery_failed', 'paused'].includes(shipment.status)) {
            return res.status(400).json({
                message: `Shipment cannot be rescheduled. Current status: ${shipment.status}. Only failed/paused shipments can be rescheduled.`
            });
        }

        // Check attempt limit
        const currentAttempts = shipment.deliveryAttempts || 0;
        const maxAttempts = shipment.maxDeliveryAttempts || 3;

        if (currentAttempts >= maxAttempts) {
            return res.status(400).json({
                message: `Cannot reschedule. Maximum delivery attempts (${maxAttempts}) exhausted. Please initiate RTO.`,
                deliveryAttempts: currentAttempts,
                maxDeliveryAttempts: maxAttempts
            });
        }

        // If newDrsId provided, move shipment to new DRS
        if (newDrsId) {
            let newDRS;
            if (newDrsId.match(/^[0-9a-fA-F]{24}$/)) {
                newDRS = await DRS.findById(newDrsId);
            } else {
                newDRS = await DRS.findOne({ drsId: newDrsId });
            }

            if (!newDRS) {
                return res.status(404).json({ message: 'New DRS not found' });
            }

            // Check if shipment already in new DRS
            const alreadyInDRS = newDRS.shipments.find(s => s.awb === awb);
            if (!alreadyInDRS) {
                newDRS.shipments.push({ awb, status: 'pending' });
                newDRS.stats.totalShipments = newDRS.shipments.length;
                newDRS.stats.pendingShipments = newDRS.shipments.filter(s => ['pending', 'in_transit'].includes(s.status)).length;
                newDRS.markModified('shipments');
                await newDRS.save();
            }
        }

        // Update shipment status back to scheduled
        await Shipment.updateOne(
            { awb },
            {
                $set: {
                    status: 'scheduled',
                    deliveredAt: undefined
                },
                $push: {
                    history: {
                        status: 'scheduled',
                        branchId: req.user.branchId || 'HEAD_OFFICE',
                        updatedBy: req.user._id,
                        remark: `Delivery rescheduled - Attempt #${currentAttempts + 1}/${maxAttempts}${newDrsId ? ` (New DRS: ${newDrsId})` : ''}`
                    }
                }
            }
        );

        logAudit({
            action: 'DELIVERY_RESCHEDULE',
            entity: 'Shipment',
            entityId: shipment._id,
            awb,
            userId: req.user._id,
            userRole: req.user.role?.name,
            branchId: req.user.branchId,
            details: { attemptNumber: currentAttempts + 1, newDrsId, scheduledDate }
        });

        res.json({
            message: 'Delivery rescheduled successfully',
            awb,
            nextAttemptNumber: currentAttempts + 1,
            attemptsRemaining: maxAttempts - currentAttempts - 1
        });

    } catch (error) {
        console.error('Error rescheduling delivery:', error);
        res.status(500).json({ message: 'Server Error rescheduling delivery', error: error.message });
    }
};

// @desc    Get delivery attempt history for a shipment
// @route   GET /api/drs/attempts/:awb
// @access  Private
exports.getDeliveryAttempts = async (req, res) => {
    try {
        const { awb } = req.params;

        const shipment = await Shipment.findOne({ awb })
            .select('awb deliveryAttempts maxDeliveryAttempts deliveryAttemptHistory status rtoStatus')
            .populate('deliveryAttemptHistory.drsId', 'drsId')
            .populate('deliveryAttemptHistory.riderId', 'name');

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        res.json({
            awb: shipment.awb,
            currentStatus: shipment.status,
            rtoStatus: shipment.rtoStatus,
            deliveryAttempts: shipment.deliveryAttempts,
            maxDeliveryAttempts: shipment.maxDeliveryAttempts,
            attemptsRemaining: Math.max(0, shipment.maxDeliveryAttempts - shipment.deliveryAttempts),
            attemptHistory: shipment.deliveryAttemptHistory
        });

    } catch (error) {
        console.error('Error fetching delivery attempts:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Delete DRS (Soft Delete)
// @route   DELETE /api/drs/:id
// @access  Branch Admin, Dispatcher, Super Admin
exports.deleteDRS = async (req, res) => {
    try {
        let drs;
        if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            drs = await DRS.findById(req.params.id);
        } else {
            drs = await DRS.findOne({ drsId: req.params.id });
        }

        if (!drs) {
            return res.status(404).json({ message: 'DRS not found' });
        }

        // RBAC: Only allow deletion if user has access to this branch's DRS
        if (['branch_admin', 'dispatcher', 'partner_admin', 'partner'].includes(req.user.role.name)) {
            if (req.user.role.name === 'partner_admin' || req.user.role.name === 'partner') {
                const partnerBranches = await Branch.find({ partnerId: req.user._id }).select('_id');
                const branchIds = partnerBranches.map(b => b._id.toString());
                if (!branchIds.includes(drs.branchId.toString())) {
                    return res.status(403).json({ message: 'Not authorized to delete this DRS' });
                }
            } else {
                if (drs.branchId.toString() !== req.user.branchId.toString()) {
                    return res.status(403).json({ message: 'Not authorized to delete this DRS' });
                }
            }
        }

        // 1. Release all NON-COMPLETED shipments back to 'not_scheduled'
        const awbList = drs.shipments
            .filter(s => !['delivered', 'completed', 'complete'].includes(s.status?.toLowerCase()))
            .map(s => s.awb);

        if (awbList.length > 0) {
            await Shipment.updateMany(
                { awb: { $in: awbList } },
                {
                    $set: { status: 'not_scheduled' }, // Ready for new DRS
                    $push: {
                        history: {
                            status: 'not_scheduled',
                            branchId: drs.branchId || 'HEAD_OFFICE',
                            updatedBy: req.user._id,
                            remark: `Released from deleted DRS ${drs.drsId}`
                        }
                    }
                }
            );
            console.log(`✅ Released ${awbList.length} incomplete shipments from deleted DRS ${drs.drsId}`);
        } else {
            console.log(`ℹ️ No incomplete shipments to release from deleted DRS ${drs.drsId}`);
        }

        // Soft delete: Mark as deleted instead of removing
        drs.status = 'deleted';
        drs.deletedAt = new Date();
        drs.deletedBy = req.user._id;
        await drs.save();

        res.json({ message: 'DRS deleted successfully' });

    } catch (error) {
        console.error('Error deleting DRS:', error);
        res.status(500).json({ message: 'Server Error deleting DRS' });
    }
};

// @desc    Pause DRS
// @route   PUT /api/drs/:id/pause
// @access  Branch Admin, Dispatcher, Rider
exports.pauseDRS = async (req, res) => {
    try {
        let drs;
        if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            drs = await DRS.findById(req.params.id);
        } else {
            drs = await DRS.findOne({ drsId: req.params.id });
        }

        if (!drs) {
            return res.status(404).json({ message: 'DRS not found' });
        }

        // Check if already paused
        if (drs.status === 'paused') {
            return res.status(400).json({ message: 'DRS is already paused' });
        }

        // Determine pause type
        const pauseType = ['branch_admin', 'dispatcher', 'super_admin', 'partner_admin', 'partner'].includes(req.user.role.name)
            ? 'admin'
            : 'rider';

        drs.status = 'paused';
        drs.pausedBy = req.user._id;
        drs.pausedAt = new Date();
        drs.pauseType = pauseType;

        await drs.save();

        console.log(`⏸️  DRS ${drs.drsId} paused by ${req.user.name} (${pauseType})`);
        res.json({ message: 'DRS paused successfully', pauseType });

    } catch (error) {
        console.error('Error pausing DRS:', error);
        res.status(500).json({ message: 'Server Error pausing DRS' });
    }
};

// @desc    Resume DRS
// @route   PUT /api/drs/:id/resume
// @access  Branch Admin, Dispatcher, Rider (with restrictions)
exports.resumeDRS = async (req, res) => {
    try {
        let drs;
        if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            drs = await DRS.findById(req.params.id).populate('pausedBy', 'name role');
        } else {
            drs = await DRS.findOne({ drsId: req.params.id }).populate('pausedBy', 'name role');
        }

        if (!drs) {
            return res.status(404).json({ message: 'DRS not found' });
        }

        if (drs.status !== 'paused') {
            return res.status(400).json({ message: 'DRS is not paused' });
        }

        // CRITICAL: Check if rider can resume
        if (req.user.role.name === 'rider' && drs.pauseType === 'admin') {
            return res.status(403).json({
                message: 'This DRS was paused by admin. Please contact your dispatcher to resume.',
                pausedBy: drs.pausedBy?.name || 'Admin'
            });
        }

        // Determine previous status (default to in_progress if was active)
        const previousStatus = drs.startDate ? 'in_progress' : 'scheduled';

        drs.status = previousStatus;
        drs.pausedBy = undefined;
        drs.pausedAt = undefined;
        drs.pauseType = undefined;

        await drs.save();

        console.log(`▶️  DRS ${drs.drsId} resumed by ${req.user.name}`);
        res.json({ message: 'DRS resumed successfully' });

    } catch (error) {
        console.error('Error resuming DRS:', error);
        res.status(500).json({ message: 'Server Error resuming DRS' });
    }
};

/**
 * @desc    Approve a single delivery (Branch Admin Action)
 * @route   POST /api/drs/:id/approve-delivery
 * @access  Private (Branch Admin/Partner Admin)
 */
const approveDelivery = async (req, res) => {
    try {
        const { id } = req.params; // DRS ID or _id
        const { awb, type } = req.body; // Added type='direct'

        if (!awb) return res.status(400).json({ message: 'AWB is required' });

        let targetDRS;
        if (id.match(/^[0-9a-fA-F]{24}$/)) {
            targetDRS = await DRS.findById(id);
        } else {
            targetDRS = await DRS.findOne({ drsId: id });
        }

        if (!targetDRS) return res.status(404).json({ message: 'DRS not found' });

        const shipmentIndex = targetDRS.shipments.findIndex(s => s.awb === awb);
        if (shipmentIndex === -1) {
            return res.status(404).json({ message: 'Shipment not found in this DRS' });
        }

        const shipment = await Shipment.findOne({ awb });
        if (!shipment) return res.status(404).json({ message: 'Shipment not found' });

        // DIRECT APPROVE LOGIC
        if (type === 'direct') {
            // Allow direct completion from any non-final status
            if (['complete', 'delivered'].includes(shipment.status)) {
                return res.json({ message: 'Already completed', shipment });
            }

            await Shipment.updateOne(
                { awb },
                {
                    $set: {
                        status: 'complete',
                        completedVia: 'branch_direct',
                        deliveredAt: new Date()
                    },
                    $push: {
                        history: {
                            status: 'complete',
                            branchId: targetDRS.branchId || 'HEAD_OFFICE',
                            updatedBy: req.user._id,
                            remark: `Directly approved by branch (DRS: ${targetDRS.drsId})`
                        }
                    }
                }
            );
            targetDRS.shipments[shipmentIndex].status = 'completed';
            targetDRS.shipments[shipmentIndex].deliveredAt = new Date();
        } else {
            // STANDARD RIDER APPROVAL
            // Update Shipment record
            await Shipment.updateOne(
                { awb },
                {
                    $set: { status: 'complete', completedVia: 'rider', deliveredAt: new Date() },
                    $push: {
                        history: {
                            status: 'complete',
                            branchId: targetDRS.branchId || 'HEAD_OFFICE',
                            updatedBy: req.user._id,
                            remark: `Delivery approved by branch (DRS: ${targetDRS.drsId})`
                        }
                    }
                }
            );
            // Update Shipment in DRS
            targetDRS.shipments[shipmentIndex].status = 'completed';
            targetDRS.shipments[shipmentIndex].deliveredAt = new Date();
        }

        // Recalculate DRS stats
        targetDRS.stats.completedShipments = targetDRS.shipments.filter(s => s.status === 'completed').length;
        targetDRS.stats.pendingShipments = targetDRS.shipments.filter(s => ['pending', 'in_transit'].includes(s.status)).length;

        // Check for DRS auto-completion after approval
        const isAllFinalized = !targetDRS.shipments.some(s => ['pending', 'in_transit', 'pending_for_branch_approval'].includes(s.status));
        if (isAllFinalized && targetDRS.status !== 'completed') {
            targetDRS.status = 'completed';
            targetDRS.endDate = new Date();
        }

        targetDRS.markModified('shipments');
        await targetDRS.save();

        res.json({ message: 'Delivery approved successfully', shipment: targetDRS.shipments[shipmentIndex] });
    } catch (error) {
        console.error('Error approving delivery:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * @desc    Approve ALL pending deliveries in a DRS
 * @route   POST /api/drs/:id/approve-all
 * @access  Private (Branch Admin/Partner Admin)
 */
const approveAllDeliveries = async (req, res) => {
    try {
        let targetDRS;
        if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            targetDRS = await DRS.findById(req.params.id);
        } else {
            targetDRS = await DRS.findOne({ drsId: req.params.id });
        }

        const { type } = req.body; // Added type check

        if (!targetDRS) return res.status(404).json({ message: 'DRS not found' });

        let pendingShipments;
        if (type === 'direct') {
            // Direct Approve: All shipments that are NOT already completed
            pendingShipments = targetDRS.shipments.filter(s => s.status !== 'completed');
        } else {
            // Standard: Only those delivered by rider or pending approval
            pendingShipments = targetDRS.shipments.filter(s => ['delivered', 'pending_for_branch_approval', 'pending_approval'].includes(s.status));
        }

        if (pendingShipments.length === 0) {
            return res.status(400).json({ message: 'No pending deliveries to approve' });
        }

        const awbs = pendingShipments.map(s => s.awb);

        // Bulk update Shipment models
        await Shipment.updateMany(
            { awb: { $in: awbs } },
            {
                $set: {
                    status: 'complete',
                    completedVia: type === 'direct' ? 'branch_direct' : 'rider',
                    deliveredAt: new Date()
                },
                $push: {
                    history: {
                        status: 'complete',
                        branchId: targetDRS.branchId || 'HEAD_OFFICE',
                        updatedBy: req.user._id,
                        remark: type === 'direct' ? 'Bulk direct approval by branch' : 'Bulk delivery approval by branch'
                    }
                }
            }
        );

        // Update DRS internal statuses
        targetDRS.shipments.forEach(s => {
            if (awbs.includes(s.awb)) {
                s.status = 'completed';
                s.deliveredAt = new Date();
            }
        });

        // Recalculate stats
        targetDRS.stats.completedShipments = targetDRS.shipments.filter(s => s.status === 'completed').length;
        targetDRS.stats.pendingShipments = targetDRS.shipments.filter(s => ['pending', 'in_transit'].includes(s.status)).length;

        // Check for DRS auto-completion
        const isAllFinalized = !targetDRS.shipments.some(s => ['pending', 'in_transit', 'pending_for_branch_approval'].includes(s.status));
        if (isAllFinalized) {
            targetDRS.status = 'completed';
            targetDRS.endDate = new Date();
        }

        targetDRS.markModified('shipments');
        await targetDRS.save();

        res.json({ message: `Approved ${pendingShipments.length} deliveries` });

    } catch (error) {
        console.error('Error approving all deliveries:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

module.exports = {
    createDRS: exports.createDRS,
    getAllDRS: exports.getAllDRS,
    updateDRS: exports.updateDRS,
    updateDRSStatus: exports.updateDRSStatus,
    updateShipmentStatus: exports.updateShipmentStatus,
    deleteDRS: exports.deleteDRS,
    pauseDRS: exports.pauseDRS,
    resumeDRS: exports.resumeDRS,
    approveDelivery,
    approveAllDeliveries,
    rescheduleDelivery: exports.rescheduleDelivery,
    getDeliveryAttempts: exports.getDeliveryAttempts
};
