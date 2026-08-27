const express = require('express');
const router = express.Router();
const {
    getDrivers,
    getDriverStats,
    getDriverById,
    createDriver,
    updateDriver,
    deleteDriver,
    assignVehicle
} = require('../controllers/driverController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getDriverStats);
router.route('/')
    .get(protect, getDrivers)
    .post(protect, createDriver);

router.route('/:id')
    .get(protect, getDriverById)
    .put(protect, updateDriver)
    .delete(protect, deleteDriver);

router.route('/:id/assign-vehicle').put(protect, assignVehicle);

module.exports = router;
