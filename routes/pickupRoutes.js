const express = require('express');
const router = express.Router();
const {
    createPickupRequest,
    getAvailableShipments,
    getPickupRequests,
    getPickupRequestById,
    getPickupRiders,
    assignRider,
    startPickupRun,
    scanParcelAtPickup,
    markParcelMissed,
    completePickupRun,
    cancelPickupRequest,
    getPickupStats
} = require('../controllers/pickupController');
const { protect } = require('../middleware/authMiddleware');
const { roleCheck } = require('../middleware/roleMiddleware');
const {
    pickupCreators,
    pickupOperators,
    pickupExecutors
} = require('../utils/pickupPolicy');

// Route: /api/pickups

router.route('/stats').get(protect, getPickupStats);
router.get('/available-shipments', protect, roleCheck(pickupCreators), getAvailableShipments);
router.get('/riders', protect, roleCheck(pickupOperators), getPickupRiders);
router.route('/')
    .get(protect, getPickupRequests)
    .post(protect, roleCheck(pickupCreators), createPickupRequest);

router.route('/:id')
    .get(protect, getPickupRequestById);

router.put('/:id/assign', protect, roleCheck(pickupOperators), assignRider);
router.put('/:id/start', protect, roleCheck(pickupExecutors), startPickupRun);
router.post('/:id/scan', protect, roleCheck(pickupExecutors), scanParcelAtPickup);
router.post('/:id/miss', protect, roleCheck(pickupExecutors), markParcelMissed);
router.put('/:id/complete', protect, roleCheck(pickupExecutors), completePickupRun);
router.put('/:id/cancel', protect, roleCheck([...pickupOperators, 'customer']), cancelPickupRequest);

module.exports = router;
