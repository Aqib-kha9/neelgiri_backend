const express = require('express');
const router = express.Router();
const drsController = require('../controllers/drsController');
const { protect } = require('../middleware/authMiddleware');

// Route: /api/drs

router.post('/create', protect, drsController.createDRS);
router.get('/list', protect, drsController.getAllDRS);
router.put('/:id', protect, drsController.updateDRS);
router.put('/:id/status', protect, drsController.updateDRSStatus);
router.put('/:id/shipment/status', protect, drsController.updateShipmentStatus);
router.delete('/:id', protect, drsController.deleteDRS);
router.put('/:id/pause', protect, drsController.pauseDRS);
router.put('/:id/resume', protect, drsController.resumeDRS);
router.post('/:id/approve-delivery', protect, drsController.approveDelivery);
router.post('/:id/approve-all', protect, drsController.approveAllDeliveries);

module.exports = router;
