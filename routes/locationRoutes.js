const express = require('express');
const router = express.Router();
const {
    getLocations,
    getLocationStats,
    getLocationById,
    createLocation,
    updateLocation,
    deleteLocation
} = require('../controllers/masterController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getLocationStats);
router.route('/')
    .get(protect, getLocations)
    .post(protect, createLocation);

router.route('/:id')
    .get(protect, getLocationById)
    .put(protect, updateLocation)
    .delete(protect, deleteLocation);

module.exports = router;
