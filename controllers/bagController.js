/**
 * bagController.js
 *
 * Enhanced Bag workflow controller implementing real courier company operations:
 *   1. Create open bag (destination branch selected)
 *   2. Scan parcels INTO the bag (scan-in) — each AWB validated & tracked
 *   3. Seal the bag (seal number assigned, weight recorded)
 *   4. Verify seal at destination (seal intact check)
 *   5. Open bag & scan parcels OUT (scan-out) — reconciliation against scan-in
 *
 * This replaces the simplistic "create bag + auto-manifest" approach with a
 * proper physical bagging workflow used by Delhivery / DTDC / BlueDart.
 */

const Bag = require('../models/Bag');
const Shipment = require('../models/Shipment');
const Manifest = require('../models/Manifest');
const Branch = require('../models/Branch');
const { generateBagId, generateManifestId } = require('../utils/idGenerator');
const { buildScopeQuery } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// =====================================================
// @desc    Create a new open Bag (start bagging session)
// @route   POST /api/bags
// @access  Private (branch_admin, dispatcher)
// =====================================================
const createBag = async (req, res) => {
    try {
        const { destinationBranchId, sealNumber, weight, awbs, sourceBranchId } = req.body;

        if (!destinationBranchId) {
            return res.status(400).json({ message: 'Destination branch is required' });
        }

        const sourceBranch = sourceBranchId || req.user.branchId;
        if (!sourceBranch) {
            return res.status(400).json({ message: 'Source branch is required' });
        }

        const bagId = generateBagId();

        const bag = new Bag({
            bagId,
            sourceBranch,
            destinationBranch: destinationBranchId,
            shipments: [],
            scannedShipments: [],
            status: 'open',
            declaredWeight: parseFloat(weight) || 0,
            weight: parseFloat(weight) || 0,
            sealNumber: sealNumber || null,
            currentBranch: sourceBranch,
            createdBy: req.user._id,
            history: [{
                status: 'open',
                updatedBy: req.user._id,
                remark: 'Bag created (open for scanning)'
            }]
        });

        // If AWBs provided upfront, scan them in immediately
        if (awbs && Array.isArray(awbs) && awbs.length > 0) {
            const shipments = await Shipment.find({ awb: { $in: awbs } });

            if (shipments.length !== awbs.length) {
                const foundAwbs = shipments.map(s => s.awb);
                const missing = awbs.filter(a => !foundAwbs.includes(a));
                return res.status(400).json({
                    message: 'Some shipments not found',
                    missingAwbs: missing
                });
            }

            for (const shipment of shipments) {
                bag.shipments.push(shipment._id);
                bag.scannedShipments.push({
                    shipment: shipment._id,
                    awb: shipment.awb,
                    scannedBy: req.user._id,
                    scanStatus: 'scanned_in'
                });
            }

            bag.declaredWeight = shipments.reduce((acc, s) => acc + (Number(s.weight) || 0), 0);
            bag.weight = bag.declaredWeight;
        }

        await bag.save();

        // Update shipments to reflect bagging
        if (bag.shipments.length > 0) {
            await Shipment.updateMany(
                { _id: { $in: bag.shipments } },
                {
                    $push: {
                        journey: {
                            leg: 1,
                            type: 'bagging',
                            bagId: bag._id,
                            toBranch: destinationBranchId,
                            timestamp: new Date(),
                            remark: `Added to Bag ${bag.bagId}`
                        }
                    }
                }
            );
        }

        await logAudit(req, 'BAG_CREATE', 'Bag', bag._id, `Created bag ${bag.bagId} with ${bag.shipments.length} shipments`);

        res.status(201).json({
            message: 'Bag created successfully',
            bag
        });

    } catch (error) {
        console.error('Error creating bag:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Scan a parcel INTO a bag (add shipment to open bag)
// @route   POST /api/bags/:id/scan
// @access  Private
// =====================================================
const scanParcelIntoBag = async (req, res) => {
    try {
        const { id } = req.params;
        const { awb } = req.body;

        if (!awb) {
            return res.status(400).json({ message: 'AWB is required' });
        }

        const bag = await Bag.findById(id);
        if (!bag) {
            return res.status(404).json({ message: 'Bag not found' });
        }

        if (bag.status !== 'open') {
            return res.status(400).json({
                message: `Cannot scan into a bag that is ${bag.status}. Bag must be 'open'.`,
                currentStatus: bag.status
            });
        }

        // Find shipment by AWB
        const shipment = await Shipment.findOne({ awb: awb.trim() });
        if (!shipment) {
            return res.status(404).json({ message: `Shipment with AWB ${awb} not found` });
        }

        // Check for duplicate scan
        const alreadyScanned = bag.scannedShipments.find(
            s => s.awb === awb.trim() && s.scanStatus === 'scanned_in'
        );
        if (alreadyScanned) {
            return res.status(409).json({ message: `AWB ${awb} already scanned into this bag` });
        }

        // Add to bag
        bag.shipments.push(shipment._id);
        bag.scannedShipments.push({
            shipment: shipment._id,
            awb: shipment.awb,
            scannedBy: req.user._id,
            scanStatus: 'scanned_in'
        });

        // Update weight
        bag.declaredWeight = (bag.declaredWeight || 0) + (Number(shipment.weight) || 0);
        bag.weight = bag.declaredWeight;

        bag.history.push({
            status: 'open',
            updatedBy: req.user._id,
            remark: `Scanned AWB ${awb} into bag`
        });

        await bag.save();

        // Update shipment journey
        await Shipment.updateOne(
            { _id: shipment._id },
            {
                $push: {
                    journey: {
                        leg: 1,
                        type: 'bagging',
                        bagId: bag._id,
                        toBranch: bag.destinationBranch,
                        timestamp: new Date(),
                        remark: `Scanned into Bag ${bag.bagId}`
                    }
                }
            }
        );

        res.json({
            message: 'Parcel scanned into bag',
            awb: shipment.awb,
            bagId: bag.bagId,
            totalShipments: bag.shipments.length,
            totalWeight: bag.declaredWeight
        });

    } catch (error) {
        console.error('Error scanning parcel into bag:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Seal a bag (close for scanning, assign seal number)
// @route   PUT /api/bags/:id/seal
// @access  Private
// =====================================================
const sealBag = async (req, res) => {
    try {
        const { id } = req.params;
        const { sealNumber, actualWeight } = req.body;

        const bag = await Bag.findById(id);
        if (!bag) {
            return res.status(404).json({ message: 'Bag not found' });
        }

        if (bag.status !== 'open') {
            return res.status(400).json({
                message: `Bag is already ${bag.status}. Only open bags can be sealed.`,
                currentStatus: bag.status
            });
        }

        if (bag.shipments.length === 0) {
            return res.status(400).json({ message: 'Cannot seal an empty bag. Add at least one parcel.' });
        }

        if (!sealNumber) {
            return res.status(400).json({ message: 'Seal number is required to seal the bag' });
        }

        bag.status = 'sealed';
        bag.sealNumber = sealNumber;
        bag.sealedAt = new Date();
        bag.sealedBy = req.user._id;

        if (actualWeight !== undefined && actualWeight !== null) {
            bag.actualWeight = parseFloat(actualWeight);
            bag.weightVerified = Math.abs(bag.actualWeight - bag.declaredWeight) < 0.5; // 500g tolerance
        }

        bag.history.push({
            status: 'sealed',
            updatedBy: req.user._id,
            remark: `Bag sealed with seal number ${sealNumber}. ${bag.shipments.length} parcels, ${bag.declaredWeight}kg.`
        });

        await bag.save();

        await logAudit(req, 'BAG_SEAL', 'Bag', bag._id, `Sealed bag ${bag.bagId} with seal ${sealNumber}`);

        res.json({
            message: 'Bag sealed successfully',
            bagId: bag.bagId,
            sealNumber: bag.sealNumber,
            totalShipments: bag.shipments.length,
            declaredWeight: bag.declaredWeight,
            actualWeight: bag.actualWeight,
            weightVerified: bag.weightVerified
        });

    } catch (error) {
        console.error('Error sealing bag:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Verify seal at destination (seal intact check)
// @route   PUT /api/bags/:id/verify-seal
// @access  Private
// =====================================================
const verifySeal = async (req, res) => {
    try {
        const { id } = req.params;
        const { isSealIntact, sealBrokenReason } = req.body;

        const bag = await Bag.findById(id);
        if (!bag) {
            return res.status(404).json({ message: 'Bag not found' });
        }

        if (!['sealed', 'seal_verified', 'arrived', 'in_transit'].includes(bag.status)) {
            return res.status(400).json({
                message: `Cannot verify seal on a bag that is ${bag.status}`,
                currentStatus: bag.status
            });
        }

        bag.isSealIntact = isSealIntact;
        bag.sealVerifiedAt = new Date();
        bag.sealVerifiedBy = req.user._id;

        if (!isSealIntact) {
            bag.sealBrokenReason = sealBrokenReason || 'Seal broken (reason not specified)';
            bag.status = 'seal_verified'; // Flagged for investigation
        } else {
            bag.status = 'seal_verified';
        }

        bag.history.push({
            status: bag.status,
            updatedBy: req.user._id,
            remark: isSealIntact
                ? 'Seal verified intact at destination'
                : `Seal BROKEN at destination: ${bag.sealBrokenReason}`
        });

        await bag.save();

        // If seal is broken, create an exception (auto-flag)
        if (!isSealIntact) {
            try {
                const Exception = require('../models/Exception');
                const { generateExceptionId } = require('../utils/idGenerator');
                const exception = new Exception({
                    exceptionId: generateExceptionId(),
                    type: 'SEAL_BROKEN',
                    severity: 'HIGH',
                    entity: 'Bag',
                    entityId: bag._id,
                    title: `Broken seal on Bag ${bag.bagId}`,
                    description: `Seal ${bag.sealNumber} was found broken. Reason: ${bag.sealBrokenReason}`,
                    status: 'OPEN',
                    branchId: req.user.branchId,
                    createdBy: req.user._id
                });
                await exception.save();
            } catch (excErr) {
                console.error('Failed to create seal-broken exception:', excErr);
            }
        }

        await logAudit(req, 'BAG_VERIFY_SEAL', 'Bag', bag._id, `Verified seal on bag ${bag.bagId}: ${isSealIntact ? 'INTACT' : 'BROKEN'}`);

        res.json({
            message: isSealIntact ? 'Seal verified intact' : 'Seal broken — exception created',
            bagId: bag.bagId,
            isSealIntact: bag.isSealIntact,
            status: bag.status
        });

    } catch (error) {
        console.error('Error verifying seal:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Open a sealed bag at destination (for scan-out)
// @route   PUT /api/bags/:id/open
// @access  Private
// =====================================================
const openBag = async (req, res) => {
    try {
        const { id } = req.params;
        const { remark } = req.body;

        const bag = await Bag.findById(id);
        if (!bag) {
            return res.status(404).json({ message: 'Bag not found' });
        }

        if (!['sealed', 'seal_verified', 'arrived'].includes(bag.status)) {
            return res.status(400).json({
                message: `Cannot open a bag that is ${bag.status}`,
                currentStatus: bag.status
            });
        }

        bag.status = 'opened';
        bag.openedAt = new Date();
        bag.openedBy = req.user._id;

        bag.history.push({
            status: 'opened',
            updatedBy: req.user._id,
            remark: remark || 'Bag opened for parcel scan-out at destination'
        });

        await bag.save();

        res.json({
            message: 'Bag opened for scan-out',
            bagId: bag.bagId,
            expectedShipments: bag.shipments.length
        });

    } catch (error) {
        console.error('Error opening bag:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Scan a parcel OUT of a bag (at destination)
// @route   POST /api/bags/:id/scan-out
// @access  Private
// =====================================================
const scanParcelOutOfBag = async (req, res) => {
    try {
        const { id } = req.params;
        const { awb, scanStatus } = req.body; // scanStatus: received, missing, damaged, extra

        if (!awb) {
            return res.status(400).json({ message: 'AWB is required' });
        }

        const bag = await Bag.findById(id);
        if (!bag) {
            return res.status(404).json({ message: 'Bag not found' });
        }

        if (!['opened', 'seal_verified', 'arrived'].includes(bag.status)) {
            return res.status(400).json({
                message: `Cannot scan out from a bag that is ${bag.status}. Open the bag first.`,
                currentStatus: bag.status
            });
        }

        // Check if this AWB was expected in the bag
        const expectedShipment = bag.scannedShipments.find(s => s.awb === awb.trim());
        const isExtra = !expectedShipment;

        if (isExtra) {
            // Extra parcel — not in the bag's manifest
            const shipment = await Shipment.findOne({ awb: awb.trim() });
            bag.scannedShipments.push({
                shipment: shipment ? shipment._id : null,
                awb: awb.trim(),
                scannedBy: req.user._id,
                scanStatus: 'extra'
            });
        } else {
            // Mark as received (or damaged/missing)
            expectedShipment.scanStatus = scanStatus || 'received';
            expectedShipment.scannedAt = new Date();
            expectedShipment.scannedBy = req.user._id;
        }

        // Update shipment status
        const shipment = await Shipment.findOne({ awb: awb.trim() });
        if (shipment) {
            shipment.status = 'received';
            shipment.currentBranch = req.user.branchId;
            shipment.history.push({
                status: 'received',
                timestamp: new Date(),
                branchId: req.user.branchId,
                updatedBy: req.user._id,
                remark: `Scanned out of Bag ${bag.bagId} at destination`
            });
            shipment.journey.push({
                leg: 1,
                type: 'destination_inbound',
                bagId: bag._id,
                toBranch: req.user.branchId,
                timestamp: new Date(),
                remark: `Scanned out of Bag ${bag.bagId}`
            });
            await shipment.save();
        }

        bag.history.push({
            status: bag.status,
            updatedBy: req.user._id,
            remark: `Scanned out AWB ${awb} (${isExtra ? 'EXTRA' : scanStatus || 'received'})`
        });

        await bag.save();

        // Check if all expected parcels have been scanned out
        const expectedCount = bag.shipments.length;
        const scannedOutCount = bag.scannedShipments.filter(
            s => s.scanStatus !== 'scanned_in' && s.scanStatus !== 'extra'
        ).length;

        const allScanned = scannedOutCount >= expectedCount;

        res.json({
            message: `Parcel ${awb} scanned out`,
            awb,
            scanStatus: isExtra ? 'extra' : (scanStatus || 'received'),
            expectedCount,
            scannedOutCount,
            allScanned,
            bagId: bag.bagId
        });

    } catch (error) {
        console.error('Error scanning parcel out of bag:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Get bag reconciliation summary (expected vs received)
// @route   GET /api/bags/:id/reconciliation
// @access  Private
// =====================================================
const getBagReconciliation = async (req, res) => {
    try {
        const { id } = req.params;

        const bag = await Bag.findById(id)
            .populate('shipments', 'awb receiver weight status')
            .populate('scannedShipments.shipment', 'awb receiver weight');

        if (!bag) {
            return res.status(404).json({ message: 'Bag not found' });
        }

        const expected = bag.shipments.length;
        const received = bag.scannedShipments.filter(s => s.scanStatus === 'received').length;
        const missing = bag.scannedShipments.filter(s => s.scanStatus === 'missing').length;
        const damaged = bag.scannedShipments.filter(s => s.scanStatus === 'damaged').length;
        const extra = bag.scannedShipments.filter(s => s.scanStatus === 'extra').length;
        const notScanned = bag.scannedShipments.filter(s => s.scanStatus === 'scanned_in').length;

        const reconciliationStatus = expected === received ? 'matched' : (received === 0 ? 'pending' : 'partial');

        res.json({
            bagId: bag.bagId,
            sealNumber: bag.sealNumber,
            status: bag.status,
            expected,
            received,
            missing,
            damaged,
            extra,
            notScanned,
            reconciliationStatus,
            weight: {
                declared: bag.declaredWeight,
                actual: bag.actualWeight,
                verified: bag.weightVerified
            },
            shipments: bag.scannedShipments
        });

    } catch (error) {
        console.error('Error getting bag reconciliation:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Get Bags (with filtering & scoping)
// @route   GET /api/bags
// @access  Private
// =====================================================
const getBags = async (req, res) => {
    try {
        const { status, destinationBranchId, sourceBranchId, sealNumber, bagId } = req.query;
        let query = {};

        // Branch scoping
        if (req.user.branchId) {
            query.$or = [
                { currentBranch: req.user.branchId },
                { sourceBranch: req.user.branchId },
                { destinationBranch: req.user.branchId }
            ];
        }

        if (status) {
            query.status = { $in: status.split(',') };
        }

        if (destinationBranchId) {
            query.destinationBranch = destinationBranchId;
        }

        if (sourceBranchId) {
            query.sourceBranch = sourceBranchId;
        }

        if (sealNumber) {
            query.sealNumber = { $regex: sealNumber, $options: 'i' };
        }

        if (bagId) {
            query.bagId = { $regex: bagId, $options: 'i' };
        }

        const bags = await Bag.find(query)
            .populate('destinationBranch', 'name code')
            .populate('sourceBranch', 'name code')
            .populate('shipments', 'awb receiver weight status')
            .sort({ createdAt: -1 });

        res.json(bags);

    } catch (error) {
        console.error('Error fetching bags:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Get single Bag by ID
// @route   GET /api/bags/:id
// @access  Private
// =====================================================
const getBagById = async (req, res) => {
    try {
        const bag = await Bag.findById(req.params.id)
            .populate('destinationBranch', 'name code address')
            .populate('sourceBranch', 'name code address')
            .populate('shipments', 'awb receiver sender weight status paymentMode codAmount')
            .populate('scannedShipments.shipment', 'awb receiver weight')
            .populate('createdBy', 'name email')
            .populate('sealedBy', 'name')
            .populate('sealVerifiedBy', 'name')
            .populate('openedBy', 'name');

        if (!bag) {
            return res.status(404).json({ message: 'Bag not found' });
        }

        res.json(bag);
    } catch (error) {
        console.error('Error fetching bag:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Get bag statistics
// @route   GET /api/bags/stats
// @access  Private
// =====================================================
const getBagStats = async (req, res) => {
    try {
        let matchQuery = {};
        if (req.user.branchId) {
            matchQuery.$or = [
                { currentBranch: req.user.branchId },
                { sourceBranch: req.user.branchId },
                { destinationBranch: req.user.branchId }
            ];
        }

        const stats = await Bag.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 },
                    totalWeight: { $sum: '$weight' },
                    totalShipments: { $sum: { $size: '$shipments' } }
                }
            }
        ]);

        const totalBags = await Bag.countDocuments(matchQuery);

        res.json({
            totalBags,
            byStatus: stats
        });

    } catch (error) {
        console.error('Error fetching bag stats:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

module.exports = {
    createBag,
    scanParcelIntoBag,
    sealBag,
    verifySeal,
    openBag,
    scanParcelOutOfBag,
    getBagReconciliation,
    getBags,
    getBagById,
    getBagStats
};
