const express = require('express');
const router = express.Router();
const bagController = require('../controllers/bagController');
const { protect } = require('../middleware/authMiddleware');

// Create a new bag (open for scanning)
router.post('/', protect, bagController.createBag);

// Get all bags (with filtering)
router.get('/', protect, bagController.getBags);

// Get bag statistics
router.get('/stats', protect, bagController.getBagStats);

// Get single bag by ID
router.get('/:id', protect, bagController.getBagById);

// Scan a parcel INTO a bag
router.post('/:id/scan', protect, bagController.scanParcelIntoBag);

// Seal a bag (close for scanning)
router.put('/:id/seal', protect, bagController.sealBag);

// Verify seal at destination
router.put('/:id/verify-seal', protect, bagController.verifySeal);

// Open a sealed bag (for scan-out)
router.put('/:id/open', protect, bagController.openBag);

// Scan a parcel OUT of a bag (at destination)
router.post('/:id/scan-out', protect, bagController.scanParcelOutOfBag);

// Get bag reconciliation summary
router.get('/:id/reconciliation', protect, bagController.getBagReconciliation);

module.exports = router;
