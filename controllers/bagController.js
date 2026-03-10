const Bag = require('../models/Bag');
const Shipment = require('../models/Shipment');
const Manifest = require('../models/Manifest');

// @desc    Create a new Bag
// @route   POST /api/bags/create
// @access  Private
const createBag = async (req, res) => {
    try {
        const { destinationBranchId, sealNumber, weight, awbs } = req.body;

        if (!destinationBranchId || !awbs || awbs.length === 0) {
            return res.status(400).json({ message: 'Destination and AWBs are required' });
        }

        // Find shipments by AWBs
        const shipments = await Shipment.find({ awb: { $in: awbs } });

        if (shipments.length !== awbs.length) {
            return res.status(400).json({ message: 'Some shipments not found' });
        }

        const shipmentIds = shipments.map(s => s._id);

        // Generate Bag ID
        const bagId = `BAG${Date.now()}`;

        const bag = new Bag({
            bagId,
            destinationBranch: destinationBranchId,
            shipments: shipmentIds,
            sealNumber,
            weight: parseFloat(weight) || 0,
            status: 'sealed',
            currentBranch: req.body.sourceBranchId || req.user.branchId,
            createdBy: req.user._id,
            history: [{
                status: 'sealed',
                updatedBy: req.user._id,
                remark: 'Bag created and sealed'
            }]
        });

        await bag.save();

        const sourceBranch = req.body.sourceBranchId || req.user.branchId;

        // Create Manifest for Bag
        const manifest = new Manifest({
            manifestId: `MFB${Date.now()}`,
            sourceBranch: sourceBranch,
            destinationBranch: destinationBranchId,
            shipments: shipmentIds,
            bagTags: [bag.bagId],
            status: 'in_transit',
            createdBy: req.user._id,
            stats: { totalShipments: shipmentIds.length, totalWeight: parseFloat(weight) || 0 },
            history: [{
                status: 'created',
                updatedBy: req.user._id,
                remark: `Manifest created for Bag ${bag.bagId}`
            }]
        });
        await manifest.save();

        res.status(201).json({ bag, manifestId: manifest.manifestId });

    } catch (error) {
        console.error('Error creating bag:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get Bags
// @route   GET /api/bags
// @access  Private
const getBags = async (req, res) => {
    try {
        const { status } = req.query;
        let query = {};

        // Branch scoping
        if (req.user.branchId) {
            query.currentBranch = req.user.branchId;
        }

        if (status) {
            query.status = { $in: status.split(',') };
        }

        const bags = await Bag.find(query)
            .populate('destinationBranch', 'name code')
            .populate('shipments')
            .sort({ createdAt: -1 });

        res.json(bags);

    } catch (error) {
        console.error('Error fetching bags:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = {
    createBag,
    getBags
};
