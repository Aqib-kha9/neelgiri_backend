/**
 * manifestController.js
 *
 * Enhanced Manifest lifecycle controller implementing real courier operations:
 *
 *   LIFECYCLE:
 *   open → closed → vehicle_assigned → in_transit → arrived → received → complete
 *
 *   1. createManifest      — Create manifest with shipments (status: open)
 *   2. addShipments         — Add more shipments while open
 *   3. closeManifest        — Lock manifest (no more shipments can be added)
 *   4. assignVehicle         — Assign vehicle/driver/trip to manifest
 *   5. departManifest       — Mark as departed (in_transit)
 *   6. arriveManifest       — Mark as arrived at destination
 *   7. inboundScan           — Scan each parcel at destination (reconciliation)
 *   8. completeManifest     — Finalize after all parcels scanned
 *
 *   Also includes: weight reconciliation, over/under count handling,
 *   auto-exception creation for discrepancies.
 */

const Manifest = require('../models/Manifest');
const Shipment = require('../models/Shipment');
const Branch = require('../models/Branch');
const Trip = require('../models/Trip');
const Role = require('../models/Role');
const Exception = require('../models/Exception');
const { generateManifestId, generateExceptionId } = require('../utils/idGenerator');
const { logAudit } = require('../utils/auditLogger');
const { notifyInTransit, notifyArrivedAtBranch, notifyBulk } = require('../utils/notificationHelper');

// Helper: create exception for discrepancies
const createDiscrepancyException = async (manifest, type, description, req) => {
    try {
        const exception = new Exception({
            exceptionId: generateExceptionId(),
            type: type || 'OTHER',
            severity: 'HIGH',
            category: 'OPERATIONAL',
            title: `Manifest ${manifest.manifestId} — ${type}`,
            description,
            status: 'OPEN',
            location: {
                branchId: req.user.branchId,
                branchName: req.user.branchName || ''
            },
            branchId: req.user.branchId,
            createdBy: req.user._id
        });
        await exception.save();
        return exception;
    } catch (err) {
        console.error('Failed to create discrepancy exception:', err);
        return null;
    }
};

// =====================================================
// @desc    Create a new Manifest (open status)
// @route   POST /api/manifests
// @access  Private
// =====================================================
const createManifest = async (req, res) => {
    try {
        const { destinationBranchId, transportDetails, shipments, sourceBranchId, bagTags } = req.body;

        if (!destinationBranchId || !shipments || !Array.isArray(shipments) || shipments.length === 0) {
            return res.status(400).json({ message: 'Destination and Shipments (Array) are required' });
        }

        // Determine Source Branch
        let sourceBranch = sourceBranchId || req.user.branchId;
        const role = req.user.role && req.user.role.name ? req.user.role.name : req.user.role;

        if ((role === 'partner_admin' || role === 'partner' || role === 'super_admin') && sourceBranchId) {
            sourceBranch = sourceBranchId;
        }

        if (!sourceBranch) {
            if (role === 'partner_admin' || role === 'partner') {
                return res.status(400).json({ message: 'Source Branch is required for Partner Admin' });
            }
            sourceBranch = 'HEAD_OFFICE';
        }

        // Process Shipments (Upsert)
        const shipmentIds = [];
        const validShipments = [];

        for (const shipmentData of shipments) {
            let shipment;
            if (shipmentData._id) {
                shipment = await Shipment.findById(shipmentData._id);
            } else if (shipmentData.awb) {
                shipment = await Shipment.findOne({ awb: shipmentData.awb });
            }

            if (shipment) {
                // UPDATE Existing
                shipment.status = 'in_transit';
                shipment.destinationBranch = destinationBranchId;
                shipment.currentBranch = null;

                if (shipmentData.receiver) shipment.receiver = { ...shipment.receiver, ...shipmentData.receiver };
                if (shipmentData.weight) shipment.weight = shipmentData.weight;
                if (shipmentData.dimensions) shipment.dimensions = { ...shipment.dimensions, ...shipmentData.dimensions };

                shipment.history.push({
                    status: 'in_transit',
                    timestamp: new Date(),
                    branchId: sourceBranch,
                    updatedBy: req.user._id,
                    remark: `Added to Manifest (Forwarding to ${destinationBranchId})`
                });
                // Add journey entry (Phase 2.1)
                shipment.journey.push({
                    leg: 1,
                    type: 'manifest',
                    fromBranch: sourceBranch,
                    toBranch: destinationBranchId,
                    timestamp: new Date(),
                    remark: 'Added to manifest for forwarding'
                });
                await shipment.save();
                shipmentIds.push(shipment._id);
                validShipments.push(shipment);
            } else {
                // CREATE New
                shipment = new Shipment({
                    awb: shipmentData.awb,
                    receiver: shipmentData.receiver,
                    sender: shipmentData.sender,
                    weight: shipmentData.weight,
                    dimensions: shipmentData.dimensions,
                    status: 'in_transit',
                    destinationBranch: destinationBranchId,
                    currentBranch: null,
                    createdBy: req.user._id,
                    history: [{
                        status: 'in_transit',
                        timestamp: new Date(),
                        branchId: sourceBranch,
                        updatedBy: req.user._id,
                        remark: `Created and Manifested (Forwarding to ${destinationBranchId})`
                    }],
                    journey: [{
                        leg: 1,
                        type: 'manifest',
                        fromBranch: sourceBranch,
                        toBranch: destinationBranchId,
                        timestamp: new Date(),
                        remark: 'Created and manifested for forwarding'
                    }]
                });
                await shipment.save();
                shipmentIds.push(shipment._id);
                validShipments.push(shipment);
            }
        }

        const manifestId = generateManifestId();

        const manifest = new Manifest({
            manifestId,
            sourceBranch: sourceBranch,
            destinationBranch: destinationBranchId,
            shipments: shipmentIds,
            transportDetails: transportDetails || { mode: 'surface' },
            status: 'open', // Start as open — can add more shipments
            bagTags: bagTags || [],
            stats: {
                totalShipments: shipmentIds.length,
                totalWeight: validShipments.reduce((acc, s) => acc + (Number(s.weight) || 0), 0)
            },
            createdBy: req.user._id,
            history: [{
                status: 'open',
                timestamp: new Date(),
                updatedBy: req.user._id,
                remark: 'Manifest Created (Open for adding shipments)'
            }]
        });

        const savedManifest = await manifest.save();

        await logAudit(req, 'MANIFEST_CREATE', 'Manifest', savedManifest._id, `Created manifest ${manifestId} with ${shipmentIds.length} shipments`);

        res.status(201).json(savedManifest);

    } catch (error) {
        console.error('Error creating manifest:', error);
        res.status(500).json({ message: 'Server Error creating manifest', error: error.message });
    }
};

// =====================================================
// @desc    Add shipments to an open manifest
// @route   POST /api/manifests/:id/shipments
// @access  Private
// =====================================================
const addShipmentsToManifest = async (req, res) => {
    try {
        const { id } = req.params;
        const { shipments } = req.body;

        if (!shipments || !Array.isArray(shipments) || shipments.length === 0) {
            return res.status(400).json({ message: 'Shipments array is required' });
        }

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        if (manifest.status !== 'open') {
            return res.status(400).json({
                message: `Cannot add shipments to a manifest that is ${manifest.status}. Manifest must be 'open'.`,
                currentStatus: manifest.status
            });
        }

        const newShipmentIds = [];
        for (const shipmentData of shipments) {
            let shipment;
            if (shipmentData._id) {
                shipment = await Shipment.findById(shipmentData._id);
            } else if (shipmentData.awb) {
                shipment = await Shipment.findOne({ awb: shipmentData.awb });
            }

            if (shipment) {
                // Check if already in manifest
                if (manifest.shipments.includes(shipment._id)) {
                    continue; // Skip duplicates
                }

                shipment.status = 'in_transit';
                shipment.destinationBranch = manifest.destinationBranch;
                shipment.currentBranch = null;
                shipment.history.push({
                    status: 'in_transit',
                    timestamp: new Date(),
                    branchId: manifest.sourceBranch,
                    updatedBy: req.user._id,
                    remark: `Added to Manifest ${manifest.manifestId}`
                });
                shipment.journey.push({
                    leg: 1,
                    type: 'manifest',
                    fromBranch: manifest.sourceBranch,
                    toBranch: manifest.destinationBranch,
                    timestamp: new Date(),
                    remark: `Added to manifest ${manifest.manifestId}`
                });
                await shipment.save();

                manifest.shipments.push(shipment._id);
                newShipmentIds.push(shipment._id);
            }
        }

        // Update stats
        manifest.stats.totalShipments = manifest.shipments.length;
        const allShipments = await Shipment.find({ _id: { $in: manifest.shipments } });
        manifest.stats.totalWeight = allShipments.reduce((acc, s) => acc + (Number(s.weight) || 0), 0);

        manifest.history.push({
            status: 'open',
            timestamp: new Date(),
            updatedBy: req.user._id,
            remark: `Added ${newShipmentIds.length} shipments to manifest`
        });

        await manifest.save();

        res.json({
            message: `${newShipmentIds.length} shipments added to manifest`,
            manifestId: manifest.manifestId,
            totalShipments: manifest.shipments.length
        });

    } catch (error) {
        console.error('Error adding shipments to manifest:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Close a manifest (lock for vehicle assignment)
// @route   PUT /api/manifests/:id/close
// @access  Private
// =====================================================
const closeManifest = async (req, res) => {
    try {
        const { id } = req.params;
        const { actualWeight } = req.body;

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        if (manifest.status !== 'open') {
            return res.status(400).json({
                message: `Manifest is already ${manifest.status}. Only open manifests can be closed.`,
                currentStatus: manifest.status
            });
        }

        if (manifest.shipments.length === 0) {
            return res.status(400).json({ message: 'Cannot close an empty manifest' });
        }

        manifest.status = 'closed';
        manifest.closedAt = new Date();
        manifest.closedBy = req.user._id;

        // Weight reconciliation (Phase 4.1)
        if (actualWeight !== undefined && actualWeight !== null) {
            const declaredWeight = manifest.stats.totalWeight || 0;
            const weightDiff = Math.abs(parseFloat(actualWeight) - declaredWeight);
            if (weightDiff > 1) { // More than 1kg difference
                await createDiscrepancyException(
                    manifest,
                    'WEIGHT_DISCREPANCY',
                    `Weight mismatch on manifest ${manifest.manifestId}: Declared ${declaredWeight}kg, Actual ${actualWeight}kg (diff: ${weightDiff.toFixed(2)}kg)`,
                    req
                );
            }
        }

        manifest.history.push({
            status: 'closed',
            timestamp: new Date(),
            updatedBy: req.user._id,
            remark: `Manifest closed. ${manifest.shipments.length} shipments, ${manifest.stats.totalWeight}kg.`
        });

        await manifest.save();

        await logAudit(req, 'MANIFEST_CLOSE', 'Manifest', manifest._id, `Closed manifest ${manifest.manifestId}`);

        res.json({
            message: 'Manifest closed successfully',
            manifestId: manifest.manifestId,
            status: manifest.status,
            totalShipments: manifest.shipments.length,
            totalWeight: manifest.stats.totalWeight
        });

    } catch (error) {
        console.error('Error closing manifest:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Assign vehicle/driver/trip to a closed manifest
// @route   PUT /api/manifests/:id/assign-vehicle
// @access  Private
// =====================================================
const assignVehicle = async (req, res) => {
    try {
        const { id } = req.params;
        const { tripId, vehicleNo, driverName, driverPhone, vendor, mode } = req.body;

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        if (!['closed', 'vehicle_assigned'].includes(manifest.status)) {
            return res.status(400).json({
                message: `Cannot assign vehicle to a manifest that is ${manifest.status}. Close the manifest first.`,
                currentStatus: manifest.status
            });
        }

        // Link to trip if provided
        if (tripId) {
            const trip = await Trip.findById(tripId);
            if (!trip) {
                return res.status(404).json({ message: 'Trip not found' });
            }

            // Add manifest to trip if not already there
            if (!trip.manifests.includes(manifest._id)) {
                trip.manifests.push(manifest._id);
                trip.totalManifests = trip.manifests.length;
                trip.totalShipments = (trip.totalShipments || 0) + manifest.shipments.length;
                trip.totalWeight = (trip.totalWeight || 0) + (manifest.stats.totalWeight || 0);
                await trip.save();
            }

            manifest.tripId = trip._id;
            manifest.tripCode = trip.tripId;
        }

        manifest.status = 'vehicle_assigned';
        manifest.vehicleAssignedAt = new Date();
        manifest.vehicleAssignedBy = req.user._id;

        // Update transport details
        manifest.transportDetails = {
            ...manifest.transportDetails,
            vehicleNo: vehicleNo || manifest.transportDetails.vehicleNo,
            driverName: driverName || manifest.transportDetails.driverName,
            driverPhone: driverPhone || manifest.transportDetails.driverPhone,
            vendor: vendor || manifest.transportDetails.vendor,
            mode: mode || manifest.transportDetails.mode || 'surface'
        };

        manifest.history.push({
            status: 'vehicle_assigned',
            timestamp: new Date(),
            updatedBy: req.user._id,
            remark: `Vehicle assigned: ${vehicleNo || 'N/A'}, Driver: ${driverName || 'N/A'}${tripId ? `, Trip: ${manifest.tripCode}` : ''}`
        });

        await manifest.save();

        await logAudit(req, 'MANIFEST_ASSIGN_VEHICLE', 'Manifest', manifest._id, `Assigned vehicle ${vehicleNo} to manifest ${manifest.manifestId}`);

        res.json({
            message: 'Vehicle assigned to manifest',
            manifestId: manifest.manifestId,
            status: manifest.status,
            transportDetails: manifest.transportDetails,
            tripId: manifest.tripId
        });

    } catch (error) {
        console.error('Error assigning vehicle:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Depart a manifest (mark as in_transit)
// @route   PUT /api/manifests/:id/depart
// @access  Private
// =====================================================
const departManifest = async (req, res) => {
    try {
        const { id } = req.params;

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        if (!['vehicle_assigned', 'closed'].includes(manifest.status)) {
            return res.status(400).json({
                message: `Cannot depart a manifest that is ${manifest.status}. Assign a vehicle first.`,
                currentStatus: manifest.status
            });
        }

        manifest.status = 'in_transit';
        manifest.departedAt = new Date();
        manifest.departedBy = req.user._id;

        manifest.history.push({
            status: 'in_transit',
            timestamp: new Date(),
            forwarded_at: new Date(),
            updatedBy: req.user._id,
            remark: 'Manifest departed origin branch'
        });

        await manifest.save();

        // Update all shipments to in_transit with journey entry
        await Shipment.updateMany(
            { _id: { $in: manifest.shipments } },
            {
                $set: { status: 'in_transit', currentBranch: null },
                $push: {
                    history: {
                        status: 'in_transit',
                        timestamp: new Date(),
                        branchId: manifest.sourceBranch,
                        updatedBy: req.user._id,
                        remark: `Departed via Manifest ${manifest.manifestId}`
                    },
                    journey: {
                        leg: 1,
                        type: 'line_haul',
                        fromBranch: manifest.sourceBranch,
                        toBranch: manifest.destinationBranch,
                        manifestId: manifest._id,
                        tripId: manifest.tripId,
                        timestamp: new Date(),
                        remark: `Line-haul departed via manifest ${manifest.manifestId}`
                    }
                }
            }
        );

        await logAudit(req, 'MANIFEST_DEPART', 'Manifest', manifest._id, `Manifest ${manifest.manifestId} departed`);

        // Fire-and-forget: notify all customers that shipment is in transit
        const sourceBranchDoc = await Branch.findById(manifest.sourceBranch).select('name');
        const destBranchDoc = await Branch.findById(manifest.destinationBranch).select('name');
        const shipmentsInManifest = await Shipment.find({ _id: { $in: manifest.shipments } }).select('awb');
        notifyBulk(
            shipmentsInManifest,
            'in_transit',
            (s) => ({
                awb: s.awb,
                fromBranch: sourceBranchDoc?.name || 'origin',
                toBranch: destBranchDoc?.name || 'destination',
                eta: ''
            }),
            req.user
        );

        res.json({
            message: 'Manifest departed successfully',
            manifestId: manifest.manifestId,
            status: manifest.status,
            departedAt: manifest.departedAt
        });

    } catch (error) {
        console.error('Error departing manifest:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Mark manifest as arrived at destination
// @route   PUT /api/manifests/:id/arrive
// @access  Private
// =====================================================
const arriveManifest = async (req, res) => {
    try {
        const { id } = req.params;
        const { actualWeight } = req.body;

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        if (!['in_transit', 'vehicle_assigned'].includes(manifest.status)) {
            return res.status(400).json({
                message: `Cannot arrive a manifest that is ${manifest.status}.`,
                currentStatus: manifest.status
            });
        }

        manifest.status = 'arrived';
        manifest.arrivedAt = new Date();
        manifest.arrivedBy = req.user._id;

        // Weight reconciliation at arrival (Phase 4.1)
        if (actualWeight !== undefined && actualWeight !== null) {
            const declaredWeight = manifest.stats.totalWeight || 0;
            const weightDiff = Math.abs(parseFloat(actualWeight) - declaredWeight);
            if (weightDiff > 1) {
                await createDiscrepancyException(
                    manifest,
                    'WEIGHT_DISCREPANCY',
                    `Weight mismatch on arrival of manifest ${manifest.manifestId}: Declared ${declaredWeight}kg, Actual ${actualWeight}kg (diff: ${weightDiff.toFixed(2)}kg)`,
                    req
                );
            }
        }

        manifest.history.push({
            status: 'arrived',
            timestamp: new Date(),
            updatedBy: req.user._id,
            remark: 'Manifest arrived at destination branch'
        });

        await manifest.save();

        // Update shipments — arrived at destination
        await Shipment.updateMany(
            { _id: { $in: manifest.shipments } },
            {
                $push: {
                    history: {
                        status: 'received',
                        timestamp: new Date(),
                        branchId: manifest.destinationBranch,
                        updatedBy: req.user._id,
                        remark: `Arrived at destination via Manifest ${manifest.manifestId}`
                    },
                    journey: {
                        leg: 1,
                        type: 'destination_inbound',
                        manifestId: manifest._id,
                        toBranch: manifest.destinationBranch,
                        timestamp: new Date(),
                        remark: `Arrived at destination via manifest ${manifest.manifestId}`
                    }
                }
            }
        );

        await logAudit(req, 'MANIFEST_ARRIVE', 'Manifest', manifest._id, `Manifest ${manifest.manifestId} arrived at destination`);

        // Fire-and-forget: notify all customers that shipment arrived at destination branch
        const destBranchDoc = await Branch.findById(manifest.destinationBranch).select('name');
        const arrivedShipments = await Shipment.find({ _id: { $in: manifest.shipments } }).select('awb');
        notifyBulk(
            arrivedShipments,
            'arrived_at_branch',
            (s) => ({
                awb: s.awb,
                branchName: destBranchDoc?.name || 'destination branch'
            }),
            req.user
        );

        res.json({
            message: 'Manifest arrived at destination',
            manifestId: manifest.manifestId,
            status: manifest.status,
            arrivedAt: manifest.arrivedAt,
            readyForInboundScan: true
        });

    } catch (error) {
        console.error('Error arriving manifest:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Inbound scan a parcel at destination (Phase 1.6)
// @route   POST /api/manifests/:id/inbound-scan
// @access  Private
// =====================================================
const inboundScan = async (req, res) => {
    try {
        const { id } = req.params;
        const { awb, scanStatus, remark } = req.body;

        if (!awb) {
            return res.status(400).json({ message: 'AWB is required' });
        }

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        if (!['arrived', 'received', 'complete'].includes(manifest.status)) {
            return res.status(400).json({
                message: `Cannot inbound scan on a manifest that is ${manifest.status}. Manifest must be 'arrived'.`,
                currentStatus: manifest.status
            });
        }

        // Find the shipment
        const shipment = await Shipment.findOne({ awb: awb.trim() });
        if (!shipment) {
            return res.status(404).json({ message: `Shipment with AWB ${awb} not found` });
        }

        // Check if this shipment is expected in this manifest
        const isExpected = manifest.shipments.includes(shipment._id);
        const finalScanStatus = isExpected ? (scanStatus || 'received') : 'extra';

        // Check for duplicate scan
        const alreadyScanned = manifest.scannedShipments.find(s => s.awb === awb.trim());
        if (alreadyScanned) {
            return res.status(409).json({ message: `AWB ${awb} already scanned (status: ${alreadyScanned.scanStatus})` });
        }

        // Add to scanned shipments
        manifest.scannedShipments.push({
            shipment: shipment._id,
            awb: shipment.awb,
            scannedBy: req.user._id,
            scanStatus: finalScanStatus
        });

        // Update stats
        manifest.stats.receivedShipments = manifest.scannedShipments.filter(s => s.scanStatus === 'received').length;
        manifest.stats.missingShipments = manifest.scannedShipments.filter(s => s.scanStatus === 'missing').length;
        manifest.stats.damagedShipments = manifest.scannedShipments.filter(s => s.scanStatus === 'damaged').length;
        manifest.stats.extraShipments = manifest.scannedShipments.filter(s => s.scanStatus === 'extra').length;

        // Update shipment status
        shipment.status = 'received';
        shipment.currentBranch = req.user.branchId || manifest.destinationBranch;
        shipment.history.push({
            status: 'received',
            timestamp: new Date(),
            branchId: req.user.branchId || manifest.destinationBranch,
            updatedBy: req.user._id,
            remark: remark || `Inbound scanned via Manifest ${manifest.manifestId} (${finalScanStatus})`
        });
        shipment.journey.push({
            leg: 1,
            type: 'destination_inbound',
            manifestId: manifest._id,
            toBranch: req.user.branchId || manifest.destinationBranch,
            timestamp: new Date(),
            remark: `Inbound scanned: ${finalScanStatus}`
        });
        await shipment.save();

        // Create exception for damaged parcels
        if (finalScanStatus === 'damaged') {
            await createDiscrepancyException(
                manifest,
                'DAMAGED',
                `Shipment ${awb} found DAMAGED during inbound scan of manifest ${manifest.manifestId}`,
                req
            );
        }

        // Create exception for extra parcels (over-count, Phase 4.4)
        if (finalScanStatus === 'extra') {
            await createDiscrepancyException(
                manifest,
                'OTHER',
                `Unexpected shipment ${awb} scanned during inbound of manifest ${manifest.manifestId} (not in manifest's shipment list)`,
                req
            );
        }

        manifest.history.push({
            status: manifest.status,
            timestamp: new Date(),
            updatedBy: req.user._id,
            remark: `Inbound scanned AWB ${awb} (${finalScanStatus})`
        });

        await manifest.save();

        // Check if all expected shipments have been scanned
        const expectedCount = manifest.shipments.length;
        const scannedCount = manifest.scannedShipments.filter(s => s.scanStatus !== 'extra').length;
        const allScanned = scannedCount >= expectedCount;

        // Auto-detect missing shipments (Phase 4.4)
        if (allScanned) {
            const missingShipments = manifest.shipments.filter(shipId => {
                return !manifest.scannedShipments.some(s =>
                    s.shipment && s.shipment.toString() === shipId.toString() && s.scanStatus !== 'extra'
                );
            });

            if (missingShipments.length > 0) {
                // Mark as missing
                for (const missingId of missingShipments) {
                    const missingShipment = await Shipment.findById(missingId);
                    if (missingShipment) {
                        manifest.scannedShipments.push({
                            shipment: missingId,
                            awb: missingShipment.awb,
                            scannedBy: req.user._id,
                            scanStatus: 'missing'
                        });

                        await createDiscrepancyException(
                            manifest,
                            'LOST',
                            `Shipment ${missingShipment.awb} is MISSING from manifest ${manifest.manifestId} (expected but not received)`,
                            req
                        );
                    }
                }
                manifest.stats.missingShipments = missingShipments.length;
                manifest.reconciliationStatus = 'mismatch';
                await manifest.save();
            } else if (manifest.stats.extraShipments === 0) {
                manifest.reconciliationStatus = 'matched';
            } else {
                manifest.reconciliationStatus = 'partial';
            }
        }

        res.json({
            message: `AWB ${awb} scanned (${finalScanStatus})`,
            awb,
            scanStatus: finalScanStatus,
            expectedCount,
            scannedCount,
            allScanned,
            reconciliationStatus: manifest.reconciliationStatus,
            stats: manifest.stats
        });

    } catch (error) {
        console.error('Error during inbound scan:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Complete manifest (finalize after inbound scan)
// @route   PUT /api/manifests/:id/complete
// @access  Private
// =====================================================
const completeManifest = async (req, res) => {
    try {
        const { id } = req.params;

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        if (!['arrived', 'received'].includes(manifest.status)) {
            return res.status(400).json({
                message: `Cannot complete a manifest that is ${manifest.status}.`,
                currentStatus: manifest.status
            });
        }

        // Check if all shipments have been scanned
        const expectedCount = manifest.shipments.length;
        const scannedCount = manifest.scannedShipments.filter(s => s.scanStatus !== 'extra').length;

        if (scannedCount < expectedCount) {
            return res.status(400).json({
                message: `Cannot complete manifest. ${expectedCount - scannedCount} shipments still not scanned.`,
                expectedCount,
                scannedCount,
                unscannedCount: expectedCount - scannedCount
            });
        }

        manifest.status = 'received';
        manifest.receivedAt = new Date();
        manifest.receivedBy = req.user._id;

        // Final reconciliation status
        if (manifest.stats.missingShipments > 0 || manifest.stats.extraShipments > 0) {
            manifest.reconciliationStatus = 'mismatch';
        } else if (manifest.stats.damagedShipments > 0) {
            manifest.reconciliationStatus = 'partial';
        } else {
            manifest.reconciliationStatus = 'matched';
        }

        manifest.history.push({
            status: 'received',
            timestamp: new Date(),
            updatedBy: req.user._id,
            remark: `Manifest completed. Received: ${manifest.stats.receivedShipments}, Missing: ${manifest.stats.missingShipments}, Damaged: ${manifest.stats.damagedShipments}, Extra: ${manifest.stats.extraShipments}`
        });

        await manifest.save();

        await logAudit(req, 'MANIFEST_COMPLETE', 'Manifest', manifest._id, `Completed manifest ${manifest.manifestId}. Reconciliation: ${manifest.reconciliationStatus}`);

        res.json({
            message: 'Manifest completed',
            manifestId: manifest.manifestId,
            status: manifest.status,
            reconciliationStatus: manifest.reconciliationStatus,
            stats: manifest.stats
        });

    } catch (error) {
        console.error('Error completing manifest:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Get manifest reconciliation summary
// @route   GET /api/manifests/:id/reconciliation
// @access  Private
// =====================================================
const getManifestReconciliation = async (req, res) => {
    try {
        const { id } = req.params;

        const manifest = await Manifest.findById(id)
            .populate('shipments', 'awb receiver weight status')
            .populate('scannedShipments.shipment', 'awb receiver weight')
            .populate('sourceBranch', 'name code')
            .populate('destinationBranch', 'name code');

        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        const expected = manifest.shipments.length;
        const received = manifest.stats.receivedShipments || 0;
        const missing = manifest.stats.missingShipments || 0;
        const damaged = manifest.stats.damagedShipments || 0;
        const extra = manifest.stats.extraShipments || 0;

        // Find unscanned shipments
        const scannedIds = manifest.scannedShipments.map(s => s.shipment?.toString());
        const unscannedShipments = manifest.shipments.filter(
            shipId => !scannedIds.includes(shipId.toString())
        );

        res.json({
            manifestId: manifest.manifestId,
            status: manifest.status,
            reconciliationStatus: manifest.reconciliationStatus,
            sourceBranch: manifest.sourceBranch,
            destinationBranch: manifest.destinationBranch,
            expected,
            received,
            missing,
            damaged,
            extra,
            unscanned: unscannedShipments.length,
            weight: {
                declared: manifest.stats.totalWeight,
            },
            scannedShipments: manifest.scannedShipments,
            transportDetails: manifest.transportDetails,
            tripId: manifest.tripId,
            timeline: {
                created: manifest.createdAt,
                closed: manifest.closedAt,
                vehicleAssigned: manifest.vehicleAssignedAt,
                departed: manifest.departedAt,
                arrived: manifest.arrivedAt,
                received: manifest.receivedAt
            }
        });

    } catch (error) {
        console.error('Error getting manifest reconciliation:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// =====================================================
// @desc    Get Manifests (with filtering & scoping)
// @route   GET /api/manifests
// @access  Private
// =====================================================
const getManifests = async (req, res) => {
    try {
        let effectiveRole = null;
        if (req.user.role && req.user.role.name) {
            effectiveRole = req.user.role.name;
        } else if (req.user.role) {
            const roleDoc = await Role.findById(req.user.role);
            if (roleDoc) effectiveRole = roleDoc.name;
        }

        let filters = {};
        const { type, status, manifestId, sourceBranchId, destinationBranchId, tripId } = req.query;

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
            if (branchIds.length > 0) {
                filters.destinationBranch = { $in: branchIds };
            }
            if (status) {
                filters.status = status;
            } else {
                filters.status = { $in: ['in_transit', 'arrived', 'received'] };
            }
        } else if (type === 'outward') {
            if (branchIds.length > 0) {
                filters.sourceBranch = { $in: branchIds };
            }
            if (status) filters.status = status;
        } else {
            if (effectiveRole === 'super_admin') {
                // Admin sees all
            } else if (branchIds.length > 0) {
                filters.$or = [
                    { sourceBranch: { $in: branchIds } },
                    { destinationBranch: { $in: branchIds } }
                ];
            }
            if (status) filters.status = status;
        }

        if (manifestId) {
            filters.manifestId = { $regex: manifestId, $options: 'i' };
        }

        if (sourceBranchId) {
            filters.sourceBranch = sourceBranchId;
        }

        if (destinationBranchId) {
            filters.destinationBranch = destinationBranchId;
        }

        if (tripId) {
            filters.tripId = tripId;
        }

        const manifests = await Manifest.find(filters)
            .populate('sourceBranch', 'name code')
            .populate('destinationBranch', 'name code')
            .populate('createdBy', 'name email')
            .populate('shipments', 'awb receiver weight status')
            .populate('tripId', 'tripId vehicleNumber driverName status')
            .populate('history.updatedBy', 'name')
            .sort({ createdAt: -1 });

        res.json(manifests);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// =====================================================
// @desc    Get single Manifest by ID
// @route   GET /api/manifests/:id
// @access  Private
// =====================================================
const getManifestById = async (req, res) => {
    try {
        const manifest = await Manifest.findById(req.params.id)
            .populate('sourceBranch', 'name code address')
            .populate('destinationBranch', 'name code address')
            .populate('shipments', 'awb receiver sender weight status paymentMode codAmount')
            .populate('scannedShipments.shipment', 'awb receiver weight')
            .populate('tripId', 'tripId vehicleNumber driverName driverPhone status')
            .populate('createdBy', 'name email')
            .populate('history.updatedBy', 'name');

        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        res.json(manifest);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// =====================================================
// @desc    Update manifest status (legacy compat — simplified)
// @route   PUT /api/manifests/:id/status
// @access  Private
// =====================================================
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
        }

        const updatedManifest = await manifest.save();
        res.json(updatedManifest);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// =====================================================
// @desc    Get manifest statistics
// @route   GET /api/manifests/stats
// @access  Private
// =====================================================
const getManifestStats = async (req, res) => {
    try {
        let matchQuery = {};
        if (req.user.branchId) {
            matchQuery.$or = [
                { sourceBranch: req.user.branchId },
                { destinationBranch: req.user.branchId }
            ];
        }

        const stats = await Manifest.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 },
                    totalShipments: { $sum: '$stats.totalShipments' },
                    totalWeight: { $sum: '$stats.totalWeight' }
                }
            }
        ]);

        const totalManifests = await Manifest.countDocuments(matchQuery);

        res.json({
            totalManifests,
            byStatus: stats
        });

    } catch (error) {
        console.error('Error fetching manifest stats:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

module.exports = {
    createManifest,
    addShipmentsToManifest,
    closeManifest,
    assignVehicle,
    departManifest,
    arriveManifest,
    inboundScan,
    completeManifest,
    getManifestReconciliation,
    getManifests,
    getManifestById,
    updateManifestStatus,
    getManifestStats
};
