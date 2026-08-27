const express = require('express');
const router = express.Router();
const {
    getInventory,
    getInventoryStats,
    getInventoryById,
    createInventory,
    updateInventory,
    stockTransaction,
    deleteInventory
} = require('../controllers/warehouseController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getInventoryStats);
router.route('/')
    .get(protect, getInventory)
    .post(protect, createInventory);

router.route('/:id')
    .get(protect, getInventoryById)
    .put(protect, updateInventory)
    .delete(protect, deleteInventory);

router.route('/:id/transaction').post(protect, stockTransaction);

module.exports = router;
