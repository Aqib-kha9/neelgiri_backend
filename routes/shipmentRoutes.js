const express = require('express');
const router = express.Router();
const shipmentController = require('../controllers/shipmentController');
const { protect } = require('../middleware/authMiddleware');

router.post('/inward', protect, shipmentController.inwardShipment);
router.post('/book', protect, shipmentController.createBooking);
router.post('/confirm-inward', protect, shipmentController.confirmShipmentInward);
router.post('/forward', protect, shipmentController.forwardShipment);

// Static routes first
router.get('/incoming', protect, shipmentController.getIncomingShipments);

// Specific dynamic routes
router.get('/:awb/tracking', protect, shipmentController.getShipmentTracking);
router.post('/:awb/complete', protect, shipmentController.completeShipment);

// Generic dynamic routes
router.get('/:awb', protect, shipmentController.getShipmentByAWB);
router.get('/', protect, shipmentController.getShipments);

module.exports = router;
