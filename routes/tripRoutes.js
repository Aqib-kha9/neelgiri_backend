const express = require('express');
const router = express.Router();
const {
    createTrip,
    getTrips,
    getTripById,
    addManifestsToTrip,
    startLoading,
    departTrip,
    markInTransit,
    arriveAtStop,
    departFromStop,
    arriveTrip,
    completeTrip,
    markBreakdown,
    reassignVehicle,
    transferManifests,
    cancelTrip,
    getTripStats
} = require('../controllers/tripController');
const { protect } = require('../middleware/authMiddleware');

// Route: /api/trips

router.route('/stats').get(protect, getTripStats);
router.route('/')
    .get(protect, getTrips)
    .post(protect, createTrip);

router.route('/:id')
    .get(protect, getTripById);

router.post('/:id/manifests', protect, addManifestsToTrip);
router.put('/:id/start-loading', protect, startLoading);
router.put('/:id/depart', protect, departTrip);
router.put('/:id/in-transit', protect, markInTransit);
router.put('/:id/arrive-stop', protect, arriveAtStop);
router.put('/:id/depart-stop', protect, departFromStop);
router.put('/:id/arrive', protect, arriveTrip);
router.put('/:id/complete', protect, completeTrip);
router.put('/:id/breakdown', protect, markBreakdown);
router.put('/:id/reassign', protect, reassignVehicle);
router.post('/:id/transfer-manifests', protect, transferManifests);
router.put('/:id/cancel', protect, cancelTrip);

module.exports = router;
