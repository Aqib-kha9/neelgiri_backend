const express = require('express');
const router = express.Router();
const {
    getWarehouses,
    getWarehouseStats,
    getWarehouseById,
    createWarehouse,
    updateWarehouse,
    deleteWarehouse
} = require('../controllers/warehouseController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getWarehouseStats);
router.route('/')
    .get(protect, getWarehouses)
    .post(protect, createWarehouse);

router.route('/:id')
    .get(protect, getWarehouseById)
    .put(protect, updateWarehouse)
    .delete(protect, deleteWarehouse);

module.exports = router;
