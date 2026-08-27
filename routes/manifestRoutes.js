const express = require('express');
const router = express.Router();
const manifestController = require('../controllers/manifestController');
const { protect } = require('../middleware/authMiddleware');

// Create a new manifest (open status)
router.post('/', protect, manifestController.createManifest);

// Get all manifests (with filtering)
router.get('/', protect, manifestController.getManifests);

// Get manifest statistics
router.get('/stats', protect, manifestController.getManifestStats);

// Get single manifest by ID
router.get('/:id', protect, manifestController.getManifestById);

// Add shipments to an open manifest
router.post('/:id/shipments', protect, manifestController.addShipmentsToManifest);

// Close manifest (lock for vehicle assignment)
router.put('/:id/close', protect, manifestController.closeManifest);

// Assign vehicle/driver/trip to manifest
router.put('/:id/assign-vehicle', protect, manifestController.assignVehicle);

// Depart manifest (mark as in_transit)
router.put('/:id/depart', protect, manifestController.departManifest);

// Mark manifest as arrived at destination
router.put('/:id/arrive', protect, manifestController.arriveManifest);

// Inbound scan a parcel at destination
router.post('/:id/inbound-scan', protect, manifestController.inboundScan);

// Complete manifest (finalize after inbound scan)
router.put('/:id/complete', protect, manifestController.completeManifest);

// Get manifest reconciliation summary
router.get('/:id/reconciliation', protect, manifestController.getManifestReconciliation);

// Legacy: Update manifest status
router.put('/:id/status', protect, manifestController.updateManifestStatus);

module.exports = router;
