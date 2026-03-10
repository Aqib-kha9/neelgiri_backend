const Manifest = require('../models/Manifest');
const Shipment = require('../models/Shipment');
const Branch = require('../models/Branch');
const Role = require('../models/Role');
const mongoose = require('mongoose');
const { generateManifestId } = require('../utils/idGenerator'); // Assuming you have this or will create basic one inline

const createManifest = async (req, res) => {
    try {
        const { destinationBranchId, transportDetails, shipments } = req.body;

        // 1. Validate
        if (!destinationBranchId || !shipments || !Array.isArray(shipments) || shipments.length === 0) {
            return res.status(400).json({ message: 'Destination and Shipments (Array) are required' });
        }

        // Determine Source Branch
        let sourceBranch = req.user.branchId;
        const role = req.user.role.name;

        if ((role === 'partner_admin' || role === 'partner' || role === 'super_admin') && req.body.sourceBranchId) {
            sourceBranch = req.body.sourceBranchId;
        }

        if (!sourceBranch) {
            if (role === 'partner_admin' || role === 'partner') {
                return res.status(400).json({ message: 'Source Branch is required for Partner Admin' });
            }
            sourceBranch = 'HEAD_OFFICE';
        }

        // 2. Process Shipments (Upsert)
        const shipmentIds = [];
        const validShipments = [];

        for (const shipmentData of shipments) {
            let shipment;
            // Check if existing by ID or AWB
            if (shipmentData._id) {
                shipment = await Shipment.findById(shipmentData._id);
            } else if (shipmentData.awb) {
                shipment = await Shipment.findOne({ awb: shipmentData.awb });
            }

            if (shipment) {
                // UPDATE Existing
                shipment.status = 'in_transit'; // CHANGED: Now in_transit, NOT not_scheduled
                shipment.destinationBranch = destinationBranchId;
                shipment.currentBranch = null; // In Transit

                // Update fields if provided (allow editing details during manifest creation)
                if (shipmentData.receiver) shipment.receiver = { ...shipment.receiver, ...shipmentData.receiver };
                if (shipmentData.weight) shipment.weight = shipmentData.weight;
                if (shipmentData.dimensions) shipment.dimensions = { ...shipment.dimensions, ...shipmentData.dimensions };

                shipment.history.push({
                    status: 'in_transit',
                    timestamp: new Date(),
                    branchId: sourceBranch,
                    updatedBy: req.user._id,
                    remark: `Added to Manifest (Forwarding to ${destinationBranchId})` // We'll append manifest ID later if needed, or just this is fine
                });
                await shipment.save();
                shipmentIds.push(shipment._id);
                validShipments.push(shipment);
            } else {
                // CREATE New
                shipment = new Shipment({
                    awb: shipmentData.awb,
                    receiver: shipmentData.receiver,
                    sender: shipmentData.sender, // If provided
                    weight: shipmentData.weight,
                    dimensions: shipmentData.dimensions,
                    status: 'in_transit', // Initial status is in_transit for manifest
                    destinationBranch: destinationBranchId,
                    currentBranch: null, // In Transit
                    createdBy: req.user._id,
                    history: [{
                        status: 'in_transit',
                        timestamp: new Date(),
                        branchId: sourceBranch,
                        updatedBy: req.user._id,
                        remark: `Created and Manifested (Forwarding to ${destinationBranchId})`
                    }]
                });
                await shipment.save();
                shipmentIds.push(shipment._id);
                validShipments.push(shipment);
            }
        }

        // 3. Generate ID
        const manifestId = `MF${Date.now()}`;

        // 4. Create Manifest
        console.log('[CreateManifest] Saving Manifest:', {
            manifestId,
            sourceBranch,
            destinationBranch: destinationBranchId,
            status: 'in_transit'
        });
        const manifest = new Manifest({
            manifestId,
            sourceBranch: sourceBranch,
            destinationBranch: destinationBranchId,
            shipments: shipmentIds, // Array of IDs
            transportDetails,
            status: 'in_transit', // Manifest itself is in_transit
            stats: {
                totalShipments: shipmentIds.length,
                totalWeight: validShipments.reduce((acc, s) => acc + (Number(s.weight) || 0), 0)
            },
            createdBy: req.user._id,
            history: [{
                status: 'in_transit',
                timestamp: new Date(),
                forwarded_at: new Date(),
                updatedBy: req.user._id,
                remark: 'Manifest Created & Forwarded'
            }]
        });

        const savedManifest = await manifest.save();

        // Optional: Update shipments history with actual Manifest ID if strict traceability needed
        // For performance, we skipped double-save, relying on the 'Added to Manifest' log + Manifest.shipments link.

        res.status(201).json(savedManifest);

    } catch (error) {
        console.error('Error creating manifest:', error);
        res.status(500).json({ message: 'Server Error creating manifest' });
    }
};

const getManifests = async (req, res) => {
    try {
        // ---------------------------------------------------------
        // ROBUST ROLE RESOLUTION
        // ---------------------------------------------------------
        let effectiveRole = null;
        if (req.user.role && req.user.role.name) {
            effectiveRole = req.user.role.name;
        } else if (req.user.role) {
            // Fallback: Check DB if role is just an ID
            const roleDoc = await Role.findById(req.user.role);
            if (roleDoc) effectiveRole = roleDoc.name;
        }

        console.log(`[Manifests] User: ${req.user.name} | Role: ${effectiveRole} | BranchId: ${req.user.branchId}`);

        // ---------------------------------------------------------
        // FILTER CONSTRUCTION
        // ---------------------------------------------------------
        let filters = {};
        const { type, status, manifestId } = req.query;

        // Resolve Target Branches for filtering
        let branchIds = [];
        if (effectiveRole === 'super_admin') {
            // No branch restriction
        } else if (effectiveRole === 'partner_admin' || effectiveRole === 'partner') {
            const User = require('../models/User');
            const fullUser = await User.findById(req.user._id).select('parentPartner');
            const partnerId = (fullUser && fullUser.parentPartner) ? fullUser.parentPartner : req.user._id;
            const branches = await Branch.find({ partnerId: partnerId }).select('_id');
            branchIds = branches.map(b => b._id);

            if (branchIds.length === 0) return res.json([]);
        } else if (['branch_admin', 'branch', 'dispatcher', 'branch_manager'].includes(effectiveRole)) {
            if (!req.user.branchId) return res.json([]);
            branchIds = [req.user.branchId];
        } else {
            return res.json([]);
        }

        // Apply Scope-based Filtering
        if (type === 'inward') {
            // INWARD: Only manifests where branchIds are the DESTINATION
            if (branchIds.length > 0) {
                filters.destinationBranch = { $in: branchIds };
            }
            // Inward usually implies in_transit manifests but can be received for history
            if (status) {
                filters.status = status;
            } else {
                filters.status = 'in_transit'; // Default to active inward
            }
        } else if (type === 'outward') {
            // OUTWARD: Only manifests where branchIds are the SOURCE
            if (branchIds.length > 0) {
                filters.sourceBranch = { $in: branchIds };
            }
            if (status) filters.status = status;
        } else {
            // FALLBACK / HISTORY (If no type specified)
            // Branch Admins see ONLY what they SENT (User Rule A)
            if (effectiveRole === 'super_admin') {
                // Admin sees all
            } else if (branchIds.length > 0) {
                // Rule: Each branch sees ONLY its OWN created manifest history
                filters.sourceBranch = { $in: branchIds };
            }
            if (status) filters.status = status;
        }

        if (manifestId) {
            filters.manifestId = { $regex: manifestId, $options: 'i' };
        }

        const logMsg = `[Manifests] User BranchID: ${req.user.branchId} | Purpose: ${type || 'history'} | Filters: ${JSON.stringify(filters)}\n`;
        console.log(logMsg);
        try {
            const fs = require('fs');
            const path = require('path');
            fs.appendFileSync(path.join(__dirname, '../server_log.txt'), logMsg);
        } catch (e) { }

        const allSample = await Manifest.find({}).limit(3);
        console.log('[Manifests] DB Sample:', allSample.map(m => ({ id: m.manifestId, to: m.destinationBranch, status: m.status })));

        const manifests = await Manifest.find(filters)
            .populate('sourceBranch', 'name code')
            .populate('destinationBranch', 'name code')
            .populate('createdBy', 'name email')
            .populate('shipments', 'awb receiver weight status')
            .populate('history.updatedBy', 'name')
            .sort({ createdAt: -1 });

        res.json(manifests);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

const updateManifestStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, remark } = req.body;

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        manifest.status = status;
        manifest.history.push({
            status,
            timestamp: new Date(),
            updatedBy: req.user._id,
            remark: remark || `Status updated to ${status}`
        });

        if (status === 'received') {
            // Update all associated shipments
            await Shipment.updateMany(
                { _id: { $in: manifest.shipments } },
                {
                    $set: {
                        status: 'received',
                        currentBranch: req.user.branchId
                    },
                    $push: {
                        history: {
                            status: 'received',
                            branchId: req.user.branchId,
                            updatedBy: req.user._id,
                            remark: `Received via Manifest ${manifest.manifestId}`
                        }
                    }
                }
            );
        } else if (status === 'in_transit') {
            // Maybe update shipments to indicate in transit?
            // Already done at creation, but can reinforce.
        }

        const updatedManifest = await manifest.save();
        res.json(updatedManifest);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = {
    createManifest,
    getManifests,
    updateManifestStatus
};
