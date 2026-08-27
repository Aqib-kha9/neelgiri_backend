const express = require('express');
const router = express.Router();
const {
    getVehicles,
    getVehicleStats,
    getVehicleById,
    createVehicle,
    updateVehicle,
    deleteVehicle,
    assignDriver
} = require('../controllers/vehicleController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getVehicleStats);
router.route('/')
    .get(protect, getVehicles)
    .post(protect, createVehicle);

router.route('/:id')
    .get(protect, getVehicleById)
    .put(protect, updateVehicle)
    .delete(protect, deleteVehicle);

router.route('/:id/assign-driver').put(protect, assignDriver);

module.exports = router;
