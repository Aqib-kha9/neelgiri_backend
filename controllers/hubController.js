/**
 * hubController.js
 *
 * Transit Hub Operations Controller
 *
 * In real courier companies (Delhivery, DTDC, BlueDart), parcels don't always
 * go directly from origin branch to destination branch. They pass through
 * TRANSIT HUBS — central sorting facilities where:
 *
 *   1. Inbound manifests arrive from multiple source branches
 *   2. Bags are opened and parcels are sorted by destination
 *   3. Parcels are re-bagged into new destination-specific bags
 *   4. New outbound manifests are created for the next leg
 *
 * This controller implements the full hub workflow:
 *   - receiveManifest: Accept an inbound manifest at the hub
 *   - openBag: Open a sealed bag for sorting
 *   - sortParcel: Scan & sort a parcel to its next destination
 *   - createOutboundBag: Create a new bag for sorted parcels
 *   - createOutboundManifest: Create a manifest for outbound bags
 *   - getHubDashboard: Hub overview with inbound/outbound stats
 *   - getPendingSort: Parcels waiting to be sorted
 *   - getSortHistory: Audit trail of all sorting operations
 */

const Branch = require('../models/Branch');
const Manifest = require('../models/Manifest');
const Bag = require('../models/Bag');
const Shipment = require('../models/Shipment');
const Exception = require('../models/Exception');
const Trip = require('../models/Trip');
const { logAudit } = require('../utils/auditLogger');
const { buildScopeQuery, getEffectiveBranchId } = require('../utils/scopeHelper');
const { generateBagId, generateManifestId, generateExceptionId } = require('../utils/idGenerator');
const { notifyExceptionRaised } = require('../utils/notificationHelper');

// ─── HELPER: Verify user is at a hub ─────────────────────────────
const verifyHubUser = async (req) => {
    const branchId = req.user.branchId;
    if (!branchId) {
        return { isHub: false, error: 'No branch assigned to user' };
    }
    const branch = await Branch.findById(branchId).select('name type isActive');
    if (!branch) {
        return { isHub: false, error: 'Branch not found' };
    }
    if (!branch.isActive) {
        return { isHub: false, error: 'Branch is inactive' };
    }
    // Allow all branch types to do hub operations (some small branches act as mini-hubs)
    // But flag if it's not explicitly a hub type
    return {
        isHub: true,
        branch,
        isDedicatedHub: ['hub', 'central_sorting_facility', 'regional_hub', 'metro_hub'].includes(branch.type)
    };
};

// ─── 1. RECEIVE INBOUND MANIFEST AT HUB ──────────────────────────
// @desc    Receive an inbound manifest at the transit hub
// @route   POST /api/hubs/manifests/:manifestId/receive
// @access  Branch Admin, Dispatcher
exports.receiveManifest = async (req, res) => {
    try {
        const { manifestId } = req.params;
        const { tripId, vehicleNumber, actualWeight } = req.body;

        const hubCheck = await verifyHubUser(req);
        if (!hubCheck.isHub) {
            return res.status(403).json({ message: hubCheck.error });
        }

        const hubBranchId = req.user.branchId;

        // Find the manifest — it must be destined for this hub
        const manifest = await Manifest.findOne({
            $or: [
                { manifestId },
                { _id: manifestId.match(/^[0-9a-fA-F]{24}$/) ? manifestId : undefined }
            ]
        }).populate('shipments', 'awb receiver status');

        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        // Verify this manifest is destined for this hub
        if (manifest.destinationBranch.toString() !== hubBranchId.toString()) {
            return res.status(403).json({
                message: 'This manifest is not destined for this hub',
                expectedBranch: manifest.destinationBranch,
                currentHub: hubBranchId
            });
        }

        // Check manifest is in a receivable state
        if (!['in_transit', 'arrived'].includes(manifest.status)) {
            return res.status(400).json({
                message: `Manifest must be in_transit or arrived to receive. Current: ${manifest.status}`
            });
        }

        // Update manifest to arrived (if not already)
        if (manifest.status === 'in_transit') {
            manifest.status = 'arrived';
            manifest.arrivedAt = new Date();
            manifest.arrivedBy = req.user._id;

            if (actualWeight) {
                manifest.stats.actualWeight = actualWeight;
            }

            manifest.history.push({
                status: 'arrived',
                timestamp: new Date(),
                updatedBy: req.user._id,
                remark: `Manifest arrived at hub ${hubCheck.branch.name}${vehicleNumber ? ` (Vehicle: ${vehicleNumber})` : ''}`
            });

            await manifest.save();
        }

        // Update all shipments with journey entry
        await Shipment.updateMany(
            { _id: { $in: manifest.shipments.map(s => s._id) } },
            {
                $set: { currentBranch: hubBranchId },
                $push: {
                    journey: {
                        leg: { $size: '$journey' } + 1,
                        type: 'transit_hub',
                        fromBranch: manifest.sourceBranch,
                        toBranch: hubBranchId,
                        manifestId: manifest.manifestId,
                        tripId: tripId || manifest.tripId,
                        timestamp: new Date(),
                        remark: `Arrived at transit hub ${hubCheck.branch.name}`
                    },
                    history: {
                        status: 'in_transit',
                        timestamp: new Date(),
                        branchId: hubBranchId,
                        updatedBy: req.user._id,
                        remark: `Arrived at hub ${hubCheck.branch.name} via manifest ${manifest.manifestId}`
                    }
                }
            }
        );

        // Update trip if provided
        if (tripId) {
            const trip = await Trip.findOne({
                $or: [
                    { tripId: tripId },
                    { _id: tripId.match(/^[0-9a-fA-F]{24}$/) ? tripId : undefined }
                ]
            });
            if (trip) {
                trip.status = 'arrived';
                trip.actualArrival = new Date();
                trip.history.push({
                    status: 'arrived',
                    timestamp: new Date(),
                    updatedBy: req.user._id,
                    location: hubCheck.branch.name,
                    remark: `Arrived at hub ${hubCheck.branch.name}`
                });
                await trip.save();
            }
        }

        logAudit(req, {
            action: 'HUB_RECEIVE_MANIFEST',
            resource: 'manifest',
            resourceId: manifest._id,
            description: `Received manifest ${manifest.manifestId} at hub ${hubCheck.branch.name}`
        });

        res.json({
            message: 'Manifest received at hub successfully',
            manifest,
            hub: hubCheck.branch,
            shipmentsCount: manifest.shipments.length,
            isDedicatedHub: hubCheck.isDedicatedHub
        });

    } catch (error) {
        console.error('Error receiving manifest at hub:', error);
        res.status(500).json({ message: 'Server Error receiving manifest' });
    }
};

// ─── 2. OPEN BAG FOR SORTING ─────────────────────────────────────
// @desc    Open a sealed bag at the hub for sorting
// @route   POST /api/hubs/bags/:bagId/open
// @access  Branch Admin, Dispatcher
exports.openBagForSorting = async (req, res) => {
    try {
        const { bagId } = req.params;
        const { reason } = req.body;

        const hubCheck = await verifyHubUser(req);
        if (!hubCheck.isHub) {
            return res.status(403).json({ message: hubCheck.error });
        }

        const bag = await Bag.findOne({
            $or: [
                { bagId },
                { _id: bagId.match(/^[0-9a-fA-F]{24}$/) ? bagId : undefined }
            ]
        }).populate('scannedShipments.shipment', 'awb receiver status');

        if (!bag) {
            return res.status(404).json({ message: 'Bag not found' });
        }

        // Verify bag is at this hub
        if (bag.currentBranch && bag.currentBranch.toString() !== req.user.branchId.toString()) {
            return res.status(403).json({ message: 'Bag is not at this hub' });
        }

        // Bag must be sealed or in_transit to open
        if (!['sealed', 'seal_verified', 'in_transit', 'arrived'].includes(bag.status)) {
            return res.status(400).json({
                message: `Bag must be sealed/seal_verified/in_transit/arrived to open. Current: ${bag.status}`
            });
        }

        // Check seal integrity
        const wasSealIntact = bag.isSealIntact !== false;

        bag.status = 'opened';
        bag.openedAt = new Date();
        bag.openedBy = req.user._id;
        bag.currentBranch = req.user.branchId;

        if (!wasSealIntact) {
            bag.sealBrokenReason = reason || 'Seal was already broken on arrival';
        }

        await bag.save();

        // If seal was broken, auto-create an exception
        if (!wasSealIntact) {
            const exception = new Exception({
                exceptionId: generateExceptionId(),
                type: 'PILFERAGE',
                title: `Seal Broken - Bag ${bag.bagId}`,
                severity: 'HIGH',
                status: 'OPEN',
                shipmentId: bag.scannedShipments[0]?.shipment?._id,
                awb: bag.scannedShipments[0]?.shipment?.awb,
                branchId: req.user.branchId,
                description: `Bag ${bag.bagId} seal was broken on arrival at hub ${hubCheck.branch.name}. Reason: ${bag.sealBrokenReason}`,
                reportedBy: req.user._id,
                createdBy: req.user._id
            });
            await exception.save();

            // Fire-and-forget: notify branch admin of seal-broken exception
            if (bag.scannedShipments[0]?.shipment) {
                notifyExceptionRaised(
                    { _id: bag.scannedShipments[0].shipment._id, awb: bag.scannedShipments[0].shipment.awb },
                    { type: 'PILFERAGE', severity: 'HIGH' },
                    req.user
                );
            }

            logAudit(req, {
                action: 'HUB_BAG_SEAL_BROKEN',
                resource: 'bag',
                resourceId: bag._id,
                description: `Bag ${bag.bagId} seal broken at hub. Exception ${exception.exceptionId} created.`
            });
        }

        logAudit(req, {
            action: 'HUB_OPEN_BAG',
            resource: 'bag',
            resourceId: bag._id,
            description: `Opened bag ${bag.bagId} for sorting at hub ${hubCheck.branch.name}. Seal intact: ${wasSealIntact}`
        });

        res.json({
            message: 'Bag opened for sorting',
            bag,
            sealIntact: wasSealIntact,
            parcelsToSort: bag.scannedShipments.length
        });

    } catch (error) {
        console.error('Error opening bag for sorting:', error);
        res.status(500).json({ message: 'Server Error opening bag' });
    }
};

// ─── 3. SORT PARCEL TO NEXT DESTINATION ──────────────────────────
// @desc    Scan & sort a parcel to its next destination at the hub
// @route   POST /api/hubs/sort
// @access  Branch Admin, Dispatcher
exports.sortParcel = async (req, res) => {
    try {
        const { awb, sourceBagId, destinationBranchId, destinationPincode, remark } = req.body;

        if (!awb) {
            return res.status(400).json({ message: 'AWB is required' });
        }

        const hubCheck = await verifyHubUser(req);
        if (!hubCheck.isHub) {
            return res.status(403).json({ message: hubCheck.error });
        }

        const hubBranchId = req.user.branchId;

        // Find the shipment
        const shipment = await Shipment.findOne({ awb });
        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Verify shipment is at this hub
        if (shipment.currentBranch && shipment.currentBranch.toString() !== hubBranchId.toString()) {
            return res.status(403).json({
                message: 'Shipment is not at this hub',
                currentBranch: shipment.currentBranch
            });
        }

        // Determine destination branch
        let destBranchId = destinationBranchId;
        let destBranchName = '';
        let autoRouted = false;

        if (!destBranchId && destinationPincode) {
            // Auto-determine from pincode
            const Pincode = require('../models/Pincode');
            const pincodeDoc = await Pincode.findOne({ pincode: String(destinationPincode).trim() });
            if (pincodeDoc && pincodeDoc.branchId) {
                destBranchId = pincodeDoc.branchId;
                autoRouted = true;
            }
        }

        if (!destBranchId) {
            // Use shipment's original destination branch
            if (shipment.destinationBranch) {
                destBranchId = shipment.destinationBranch;
            } else {
                return res.status(400).json({
                    message: 'Cannot determine destination. Provide destinationBranchId or destinationPincode.'
                });
            }
        }

        const destBranch = await Branch.findById(destBranchId).select('name code type');
        destBranchName = destBranch ? destBranch.name : destBranchId;

        // Check if this is local (destination is this hub itself)
        const isLocal = destBranchId.toString() === hubBranchId.toString();

        // Update shipment with sorting journey entry
        shipment.journey = shipment.journey || [];
        shipment.journey.push({
            leg: shipment.journey.length + 1,
            type: 'transit_hub',
            fromBranch: hubBranchId,
            toBranch: destBranchId,
            timestamp: new Date(),
            remark: isLocal
                ? `Sorted for local delivery at ${hubCheck.branch.name}`
                : `Sorted to ${destBranchName} at hub ${hubCheck.branch.name}`
        });

        shipment.history.push({
            status: isLocal ? 'not_scheduled' : 'in_transit',
            timestamp: new Date(),
            branchId: hubBranchId,
            updatedBy: req.user._id,
            remark: isLocal
                ? `Sorted for local delivery at hub`
                : `Sorted at hub → next destination: ${destBranchName}${autoRouted ? ' (auto-routed via pincode)' : ''}`
        });

        if (isLocal) {
            shipment.status = 'not_scheduled';
            shipment.currentBranch = hubBranchId;
        }

        await shipment.save();

        // If source bag provided, mark parcel as sorted out of that bag
        if (sourceBagId) {
            const bag = await Bag.findOne({
                $or: [
                    { bagId: sourceBagId },
                    { _id: sourceBagId.match(/^[0-9a-fA-F]{24}$/) ? sourceBagId : undefined }
                ]
            });
            if (bag) {
                const scanEntry = bag.scannedShipments.find(s =>
                    s.shipment && s.shipment.toString() === shipment._id.toString()
                );
                if (scanEntry) {
                    scanEntry.scanStatus = 'received';
                    scanEntry.sortedAt = new Date();
                    scanEntry.sortedTo = destBranchId;
                }
                bag.markModified('scannedShipments');
                await bag.save();
            }
        }

        logAudit(req, {
            action: 'HUB_SORT_PARCEL',
            resource: 'shipment',
            resourceId: shipment._id,
            description: `Sorted parcel ${awb} at hub ${hubCheck.branch.name} → ${destBranchName}${isLocal ? ' (LOCAL)' : ''}`
        });

        res.json({
            message: 'Parcel sorted successfully',
            awb,
            sortedTo: {
                branchId: destBranchId,
                branchName: destBranchName,
                branchType: destBranch?.type || 'branch'
            },
            isLocal,
            autoRouted,
            nextStep: isLocal
                ? 'Parcel is ready for DRS assignment at this hub'
                : 'Parcel is ready for bagging into outbound manifest'
        });

    } catch (error) {
        console.error('Error sorting parcel at hub:', error);
        res.status(500).json({ message: 'Server Error sorting parcel' });
    }
};

// ─── 4. CREATE OUTBOUND BAG ──────────────────────────────────────
// @desc    Create a new outbound bag at the hub for sorted parcels
// @route   POST /api/hubs/bags/outbound
// @access  Branch Admin, Dispatcher
exports.createOutboundBag = async (req, res) => {
    try {
        const { destinationBranchId, destinationPincode, awbs, sealNumber, declaredWeight } = req.body;

        const hubCheck = await verifyHubUser(req);
        if (!hubCheck.isHub) {
            return res.status(403).json({ message: hubCheck.error });
        }

        if (!awbs || !Array.isArray(awbs) || awbs.length === 0) {
            return res.status(400).json({ message: 'At least one AWB is required' });
        }

        // Determine destination
        let destBranchId = destinationBranchId;
        let destBranchName = '';

        if (!destBranchId && destinationPincode) {
            const Pincode = require('../models/Pincode');
            const pincodeDoc = await Pincode.findOne({ pincode: String(destinationPincode).trim() });
            if (pincodeDoc && pincodeDoc.branchId) {
                destBranchId = pincodeDoc.branchId;
            }
        }

        if (!destBranchId) {
            return res.status(400).json({ message: 'Destination branch or pincode is required' });
        }

        const destBranch = await Branch.findById(destBranchId).select('name code');
        destBranchName = destBranch ? destBranch.name : destBranchId;

        // Verify all shipments are at this hub and sorted
        const shipments = await Shipment.find({ awb: { $in: awbs } });
        if (shipments.length !== awbs.length) {
            const foundAwbs = shipments.map(s => s.awb);
            const missing = awbs.filter(a => !foundAwbs.includes(a));
            return res.status(400).json({
                message: 'Some shipments not found',
                missingAwbs: missing
            });
        }

        // Verify shipments are at this hub
        const notAtHub = shipments.filter(s =>
            s.currentBranch && s.currentBranch.toString() !== req.user.branchId.toString()
        );
        if (notAtHub.length > 0) {
            return res.status(400).json({
                message: 'Some shipments are not at this hub',
                notAtHub: notAtHub.map(s => s.awb)
            });
        }

        // Create the outbound bag
        const bagId = generateBagId();
        const bag = new Bag({
            bagId,
            sealNumber: sealNumber || `SEAL${Date.now()}`,
            sourceBranch: req.user.branchId,
            destinationBranch: destBranchId,
            currentBranch: req.user.branchId,
            status: 'open',
            declaredWeight: declaredWeight || 0,
            weightVerified: false,
            createdBy: req.user._id,
            partnerId: req.user.parentPartner || req.user._id,
            branchId: req.user.branchId,
            scannedShipments: shipments.map(s => ({
                shipment: s._id,
                awb: s.awb,
                scannedAt: new Date(),
                scannedBy: req.user._id,
                scanStatus: 'scanned_in'
            }))
        });

        // Update shipments with bagging journey entry
        for (const shipment of shipments) {
            shipment.journey = shipment.journey || [];
            shipment.journey.push({
                leg: shipment.journey.length + 1,
                type: 'bagging',
                fromBranch: req.user.branchId,
                toBranch: destBranchId,
                bagId: bagId,
                timestamp: new Date(),
                remark: `Bagged into ${bagId} at hub for ${destBranchName}`
            });
        }

        await Bag.bulkSave ? await Bag.bulkSave([]) : null; // no-op, just in case
        await bag.save();
        await Shipment.bulkSave(shipments);

        logAudit(req, {
            action: 'HUB_CREATE_OUTBOUND_BAG',
            resource: 'bag',
            resourceId: bag._id,
            description: `Created outbound bag ${bagId} at hub for ${destBranchName} with ${shipments.length} parcels`
        });

        res.status(201).json({
            message: 'Outbound bag created successfully',
            bag,
            destinationBranch: destBranchName,
            parcelsCount: shipments.length
        });

    } catch (error) {
        console.error('Error creating outbound bag:', error);
        res.status(500).json({ message: 'Server Error creating outbound bag' });
    }
};

// ─── 5. CREATE OUTBOUND MANIFEST ─────────────────────────────────
// @desc    Create an outbound manifest from the hub for sorted bags
// @route   POST /api/hubs/manifests/outbound
// @access  Branch Admin, Dispatcher
exports.createOutboundManifest = async (req, res) => {
    try {
        const { destinationBranchId, bagIds, transportMode, vehicleNumber, driverName, driverPhone, remark } = req.body;

        const hubCheck = await verifyHubUser(req);
        if (!hubCheck.isHub) {
            return res.status(403).json({ message: hubCheck.error });
        }

        if (!destinationBranchId) {
            return res.status(400).json({ message: 'Destination branch is required' });
        }

        if (!bagIds || !Array.isArray(bagIds) || bagIds.length === 0) {
            return res.status(400).json({ message: 'At least one bag is required' });
        }

        const destBranch = await Branch.findById(destinationBranchId).select('name code');
        if (!destBranch) {
            return res.status(404).json({ message: 'Destination branch not found' });
        }

        // Fetch all bags
        const bags = await Bag.find({
            $or: [
                { bagId: { $in: bagIds } },
                { _id: { $in: bagIds.filter(id => id.match(/^[0-9a-fA-F]{24}$/)) } }
            ]
        });

        if (bags.length === 0) {
            return res.status(404).json({ message: 'No bags found' });
        }

        // Verify all bags are sealed and at this hub
        const invalidBags = bags.filter(b =>
            !['sealed', 'seal_verified'].includes(b.status) ||
            (b.currentBranch && b.currentBranch.toString() !== req.user.branchId.toString())
        );
        if (invalidBags.length > 0) {
            return res.status(400).json({
                message: 'Some bags are not sealed or not at this hub',
                invalidBags: invalidBags.map(b => ({ bagId: b.bagId, status: b.status }))
            });
        }

        // Collect all shipments from bags
        const allShipmentIds = [];
        const allShipmentAwbs = [];
        let totalWeight = 0;

        for (const bag of bags) {
            for (const scan of bag.scannedShipments) {
                if (scan.shipment) {
                    allShipmentIds.push(scan.shipment);
                    allShipmentAwbs.push(scan.awb);
                }
            }
            totalWeight += bag.declaredWeight || 0;
            bag.status = 'manifested';
            bag.manifestId = null; // will be set after manifest save
        }

        // Create the manifest
        const manifestId = generateManifestId();
        const manifest = new Manifest({
            manifestId,
            sourceBranch: req.user.branchId,
            destinationBranch: destinationBranchId,
            shipments: allShipmentIds,
            bags: bags.map(b => b._id),
            status: 'open',
            createdBy: req.user._id,
            transportDetails: {
                mode: transportMode || 'surface',
                vehicleNumber: vehicleNumber || '',
                driverName: driverName || '',
                driverPhone: driverPhone || '',
                remark: remark || 'Outbound manifest from hub'
            },
            stats: {
                totalShipments: allShipmentIds.length,
                totalBags: bags.length,
                totalWeight
            },
            history: [{
                status: 'open',
                timestamp: new Date(),
                updatedBy: req.user._id,
                remark: `Outbound manifest created at hub ${hubCheck.branch.name} for ${destBranch.name}`
            }],
            partnerId: req.user.parentPartner || req.user._id,
            branchId: req.user.branchId
        });

        await manifest.save();

        // Link bags to manifest
        await Bag.updateMany(
            { _id: { $in: bags.map(b => b._id) } },
            {
                $set: {
                    manifestId: manifest._id,
                    status: 'manifested'
                }
            }
        );

        // Update shipments with journey entry
        await Shipment.updateMany(
            { _id: { $in: allShipmentIds } },
            {
                $push: {
                    journey: {
                        leg: { $size: '$journey' } + 1,
                        type: 'manifest',
                        fromBranch: req.user.branchId,
                        toBranch: destinationBranchId,
                        manifestId: manifestId,
                        timestamp: new Date(),
                        remark: `Added to outbound manifest ${manifestId} at hub for ${destBranch.name}`
                    },
                    history: {
                        status: 'in_transit',
                        timestamp: new Date(),
                        branchId: req.user.branchId,
                        updatedBy: req.user._id,
                        remark: `Outbound manifest ${manifestId} created at hub for ${destBranch.name}`
                    }
                },
                $set: { currentBranch: null } // In transit
            }
        );

        logAudit(req, {
            action: 'HUB_CREATE_OUTBOUND_MANIFEST',
            resource: 'manifest',
            resourceId: manifest._id,
            description: `Created outbound manifest ${manifestId} at hub ${hubCheck.branch.name} for ${destBranch.name} with ${bags.length} bags, ${allShipmentIds.length} parcels`
        });

        res.status(201).json({
            message: 'Outbound manifest created successfully',
            manifest,
            destinationBranch: destBranch.name,
            bagsCount: bags.length,
            parcelsCount: allShipmentIds.length
        });

    } catch (error) {
        console.error('Error creating outbound manifest:', error);
        res.status(500).json({ message: 'Server Error creating outbound manifest' });
    }
};

// ─── 6. GET HUB DASHBOARD ─────────────────────────────────────────
// @desc    Get hub dashboard with inbound/outbound stats
// @route   GET /api/hubs/dashboard
// @access  Branch Admin, Dispatcher
exports.getHubDashboard = async (req, res) => {
    try {
        const hubCheck = await verifyHubUser(req);
        if (!hubCheck.isHub) {
            return res.status(403).json({ message: hubCheck.error });
        }

        const hubBranchId = req.user.branchId;

        // Inbound manifests (destined for this hub)
        const inboundManifests = await Manifest.find({
            destinationBranch: hubBranchId,
            status: { $in: ['in_transit', 'arrived', 'received'] }
        }).populate('sourceBranch', 'name code').sort({ createdAt: -1 }).limit(20);

        // Outbound manifests (from this hub)
        const outboundManifests = await Manifest.find({
            sourceBranch: hubBranchId,
            status: { $in: ['open', 'closed', 'vehicle_assigned', 'in_transit'] }
        }).populate('destinationBranch', 'name code').sort({ createdAt: -1 }).limit(20);

        // Bags at hub
        const bagsAtHub = await Bag.find({
            currentBranch: hubBranchId,
            status: { $in: ['arrived', 'opened', 'sealed', 'manifested'] }
        }).populate('destinationBranch', 'name code').sort({ updatedAt: -1 }).limit(50);

        // Shipments at hub waiting for sorting
        const shipmentsAtHub = await Shipment.find({
            currentBranch: hubBranchId,
            status: { $in: ['in_transit', 'not_scheduled'] }
        }).select('awb receiver status createdAt').sort({ createdAt: -1 }).limit(100);

        // Stats
        const stats = {
            inboundPending: inboundManifests.filter(m => m.status === 'in_transit').length,
            inboundArrived: inboundManifests.filter(m => m.status === 'arrived').length,
            outboundOpen: outboundManifests.filter(m => m.status === 'open').length,
            outboundInTransit: outboundManifests.filter(m => m.status === 'in_transit').length,
            bagsAtHub: bagsAtHub.length,
            parcelsAtHub: shipmentsAtHub.length,
            parcelsAwaitingSort: shipmentsAtHub.filter(s => s.status === 'in_transit').length,
            parcelsReadyForDRS: shipmentsAtHub.filter(s => s.status === 'not_scheduled').length
        };

        res.json({
            hub: hubCheck.branch,
            isDedicatedHub: hubCheck.isDedicatedHub,
            stats,
            inboundManifests,
            outboundManifests,
            bagsAtHub,
            shipmentsAtHub: shipmentsAtHub.length
        });

    } catch (error) {
        console.error('Error fetching hub dashboard:', error);
        res.status(500).json({ message: 'Server Error fetching hub dashboard' });
    }
};

// ─── 7. GET PARCELS PENDING SORT ──────────────────────────────────
// @desc    Get parcels waiting to be sorted at the hub
// @route   GET /api/hubs/pending-sort
// @access  Branch Admin, Dispatcher
exports.getPendingSort = async (req, res) => {
    try {
        const hubCheck = await verifyHubUser(req);
        if (!hubCheck.isHub) {
            return res.status(403).json({ message: hubCheck.error });
        }

        const hubBranchId = req.user.branchId;

        // Shipments that arrived at hub but haven't been sorted yet
        // (status is in_transit, meaning they arrived but haven't been marked not_scheduled)
        const query = {
            currentBranch: hubBranchId,
            status: 'in_transit'
        };

        // Add scoping for partner/branch
        const scope = buildScopeQuery(req.user);
        if (scope) {
            Object.assign(query, scope);
        }

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        const [shipments, total] = await Promise.all([
            Shipment.find(query)
                .select('awb sender receiver weight status createdAt destinationBranch routingInfo')
                .populate('destinationBranch', 'name code')
                .sort({ createdAt: 1 }) // Oldest first (FIFO sorting)
                .skip(skip)
                .limit(limit),
            Shipment.countDocuments(query)
        ]);

        res.json({
            hub: hubCheck.branch.name,
            pendingCount: total,
            page,
            totalPages: Math.ceil(total / limit),
            shipments
        });

    } catch (error) {
        console.error('Error fetching pending sort:', error);
        res.status(500).json({ message: 'Server Error fetching pending sort' });
    }
};

// ─── 8. GET SORT HISTORY ─────────────────────────────────────────
// @desc    Get audit trail of all sorting operations at the hub
// @route   GET /api/hubs/sort-history
// @access  Branch Admin, Dispatcher
exports.getSortHistory = async (req, res) => {
    try {
        const hubCheck = await verifyHubUser(req);
        if (!hubCheck.isHub) {
            return res.status(403).json({ message: hubCheck.error });
        }

        const hubBranchId = req.user.branchId;
        const { startDate, endDate } = req.query;

        // Build date filter
        const dateFilter = {};
        if (startDate) dateFilter.$gte = new Date(startDate);
        if (endDate) dateFilter.$lte = new Date(endDate);

        // Find shipments with transit_hub journey entries at this hub
        const query = {
            'journey.type': 'transit_hub',
            'journey.fromBranch': hubBranchId
        };

        if (Object.keys(dateFilter).length > 0) {
            query['journey.timestamp'] = dateFilter;
        }

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        const [shipments, total] = await Promise.all([
            Shipment.find(query)
                .select('awb receiver journey status')
                .populate('destinationBranch', 'name code')
                .sort({ updatedAt: -1 })
                .skip(skip)
                .limit(limit),
            Shipment.countDocuments(query)
        ]);

        // Extract only the relevant journey entries
        const sortEvents = [];
        for (const shipment of shipments) {
            for (const leg of shipment.journey) {
                if (leg.type === 'transit_hub' &&
                    leg.fromBranch &&
                    leg.fromBranch.toString() === hubBranchId.toString()) {
                    sortEvents.push({
                        awb: shipment.awb,
                        receiver: shipment.receiver,
                        sortedAt: leg.timestamp,
                        fromBranch: leg.fromBranch,
                        toBranch: leg.toBranch,
                        remark: leg.remark,
                        shipmentStatus: shipment.status
                    });
                }
            }
        }

        res.json({
            hub: hubCheck.branch.name,
            totalSorts: total,
            page,
            totalPages: Math.ceil(total / limit),
            sortEvents: sortEvents.sort((a, b) => new Date(b.sortedAt) - new Date(a.sortedAt))
        });

    } catch (error) {
        console.error('Error fetching sort history:', error);
        res.status(500).json({ message: 'Server Error fetching sort history' });
    }
};

// ─── 9. GET ALL HUBS ──────────────────────────────────────────────
// @desc    Get all hubs (branches of type hub/csf/regional/metro)
// @route   GET /api/hubs
// @access  Private
exports.getAllHubs = async (req, res) => {
    try {
        const scope = buildScopeQuery(req.user);
        if (scope === null) {
            return res.json([]);
        }

        const query = {
            type: { $in: ['hub', 'central_sorting_facility', 'regional_hub', 'metro_hub'] },
            isActive: true,
            ...scope
        };

        const hubs = await Branch.find(query)
            .select('name code type address contact operatingHours hubCapacity servesBranches connectedHubs')
            .sort({ type: 1, name: 1 });

        res.json(hubs);
    } catch (error) {
        console.error('Error fetching hubs:', error);
        res.status(500).json({ message: 'Server Error fetching hubs' });
    }
};

// ─── 10. UPDATE BRANCH TO HUB TYPE ────────────────────────────────
// @desc    Convert a regular branch to a hub type
// @route   PUT /api/hubs/:branchId/convert
// @access  Super Admin, Partner Admin
exports.convertToHub = async (req, res) => {
    try {
        const { branchId } = req.params;
        const { type, hubCapacity, operatingHours, servesBranches, connectedHubs } = req.body;

        // Only super_admin or partner_admin can convert
        const roleName = req.user.role?.name;
        if (!['super_admin', 'partner_admin', 'partner'].includes(roleName)) {
            return res.status(403).json({ message: 'Only admins can convert branches to hubs' });
        }

        const branch = await Branch.findById(branchId);
        if (!branch) {
            return res.status(404).json({ message: 'Branch not found' });
        }

        // Partner admin can only convert their own branches
        if (roleName !== 'super_admin' && (!branch.partnerId || branch.partnerId.toString() !== req.user._id.toString())) {
            return res.status(403).json({ message: 'Not authorized to modify this branch' });
        }

        // Update fields
        if (type) branch.type = type;
        if (hubCapacity) branch.hubCapacity = hubCapacity;
        if (operatingHours) branch.operatingHours = operatingHours;
        if (servesBranches) branch.servesBranches = servesBranches;
        if (connectedHubs) branch.connectedHubs = connectedHubs;

        await branch.save();

        logAudit(req, {
            action: 'BRANCH_CONVERT_TO_HUB',
            resource: 'branch',
            resourceId: branch._id,
            description: `Converted branch ${branch.name} (${branch.code}) to type ${branch.type}`
        });

        res.json({
            message: 'Branch converted to hub successfully',
            branch
        });

    } catch (error) {
        console.error('Error converting branch to hub:', error);
        res.status(500).json({ message: 'Server Error converting branch' });
    }
};
