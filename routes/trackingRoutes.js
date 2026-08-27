const express = require('express');
const router = express.Router();
const {
    updateLocation,
    getTrackingByAwb,
    getActiveRiders,
    getRiderTracking,
    getTrackingStats,
    getTrackingByDrs,
    getNearbyRiders
} = require('../controllers/trackingController');
const { protect } = require('../middleware/authMiddleware');

// Static routes first
router.route('/stats').get(protect, getTrackingStats);
router.route('/active-riders').get(protect, getActiveRiders);
router.route('/nearby').get(protect, getNearbyRiders);
router.route('/location').post(protect, updateLocation);
router.route('/awb/:awb').get(protect, getTrackingByAwb);
router.route('/rider/:riderId').get(protect, getRiderTracking);
router.route('/drs/:drsId').get(protect, getTrackingByDrs);

module.exports = router;
