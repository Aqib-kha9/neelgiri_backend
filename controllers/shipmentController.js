const Shipment = require('../models/Shipment');
const Branch = require('../models/Branch');
const Manifest = require('../models/Manifest');
const Role = require('../models/Role'); // Import Role model
const DRS = require('../models/DRS'); // Import DRS for sync

// @desc    Forward a Shipment (Counter Manifest Send)
// @route   POST /api/shipments/forward
// @access  Branch Admin, Dispatcher
exports.forwardShipment = async (req, res) => {
    try {
        const { awb, destinationBranchId, receiver, weight, dimensions } = req.body;

        if (!awb || !destinationBranchId) {
            return res.status(400).json({ message: 'AWB and destination branch are required' });
        }

        const currentBranchId = req.user.branchId;

        // Check if shipment exists
        let shipment = await Shipment.findOne({ awb });

        // Fetch Destination Branch Name for Remark
        const destBranchDoc = await Branch.findById(destinationBranchId).select('name');
        const destBranchName = destBranchDoc ? destBranchDoc.name : destinationBranchId;

        if (shipment) {
            // Update existing shipment
            shipment.status = 'forwarded';
            shipment.destinationBranch = destinationBranchId;
            shipment.currentBranch = null; // In transit

            // Update fields if provided
            if (receiver) shipment.receiver = { ...shipment.receiver, ...receiver };
            if (weight) shipment.weight = weight;
            if (dimensions) shipment.dimensions = { ...shipment.dimensions, ...dimensions };

            const sourceBranch = req.body.sourceBranchId || req.user.branchId;

            // Create Manifest for Counter Manifest
            const manifest = new Manifest({
                manifestId: `MFD${Date.now()}`,
                sourceBranch: sourceBranch,
                destinationBranch: destinationBranchId,
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

            return res.json({ message: 'Shipment forwarded and manifest created', shipment, manifestId: manifest.manifestId });
        } else {
            // Create new shipment and forward
            shipment = new Shipment({
                awb,
                receiver,
                weight,
                dimensions,
                status: 'not_scheduled',
                destinationBranch: destinationBranchId,
                currentBranch: null, // In transit
                originType: 'manual_forward',
                originBranchId: req.body.sourceBranchId || req.user.branchId,
                createdBy: req.user._id,
                history: [{
                    status: 'not_scheduled',
                    timestamp: new Date(),
                    branchId: req.body.sourceBranchId || req.user.branchId,
                    updatedBy: req.user._id,
                    remark: `Created and forwarded to branch ${destBranchName}`
                }]
            });

            await shipment.save();

            const sourceBranch = req.body.sourceBranchId || req.user.branchId;
            const manifest = new Manifest({
                manifestId: `MFD${Date.now()}`,
                sourceBranch: sourceBranch,
                destinationBranch: destinationBranchId,
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

            return res.status(201).json({ message: 'Shipment created, forwarded and manifested', shipment, manifestId: manifest.manifestId });
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
        let query = {};

        // Branch Scoping
        if (req.user.branchId) {
            query.$or = [
                { currentBranch: req.user.branchId },
                { destinationBranch: req.user.branchId, status: 'not_scheduled' }
            ];
        }

        // Status Filter
        if (status) {
            const statusArray = status.split(',');
            const statusQuery = statusArray.length > 1 ? { status: { $in: statusArray } } : { status };

            if (query.$or) {
                // If we already have a branch filter, we need to wrap the status in an $and
                // BUT wait, if we have $or logic for branch permissions, simply adding it to the root object might break the OR?
                // Mongoose/Mongo logic: { $or: [...], status: ... } implies ($or conditions) AND status. This is correct.
                // However, let's overlap the status query into the main query object safely.
                Object.assign(query, statusQuery);
            } else {
                query = { ...query, ...statusQuery };
            }

            // CRITICAL FIX: For completed shipments, ONLY show manually/directly completed ones
            // Rider-completed shipments should ONLY appear in DRS History
            if (statusArray.includes('complete')) {
                query.completedVia = { $in: ['manual', 'branch_direct'] };
            }
        }

        // AWB Search
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
        const shipment = await Shipment.findOne({ awb: req.params.awb });
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

// @desc    Create Booking (Customer Portal)
// @route   POST /api/shipments/book
// @access  Private
exports.createBooking = async (req, res) => {
    try {
        const { receiver, weight, dimensions, contents, paymentMode, codAmount, declaredValue, mode } = req.body;

        const awb = `AWB${Date.now()}${Math.floor(Math.random() * 100)}`;
        
        const shipment = new Shipment({
            awb,
            sender: {
                name: req.user.name,
                phone: req.user.phone || '',
                address: req.user.address || '',
                pincode: req.user.pincode || '',
                email: req.user.email
            },
            receiver,
            weight,
            dimensions,
            contents,
            paymentMode: paymentMode.toLowerCase(),
            codAmount,
            declaredValue,
            status: 'not_scheduled',
            originType: 'customer_portal',
            createdBy: req.user._id,
            history: [{
                status: 'not_scheduled',
                timestamp: new Date(),
                updatedBy: req.user._id,
                remark: 'Booked via Customer Portal'
            }]
        });

        await shipment.save();
        res.status(201).json({ message: 'Booking successful', awb: shipment.awb, shipment });
    } catch (error) {
        console.error('Error creating customer booking:', error);
        res.status(500).json({ message: 'Server Error creating booking' });
    }
};
