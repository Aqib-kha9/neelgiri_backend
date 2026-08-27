const express = require('express');
const router = express.Router();
const {
    getAssets,
    getAssetStats,
    getAssetById,
    createAsset,
    updateAsset,
    assignAsset,
    deleteAsset
} = require('../controllers/warehouseController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getAssetStats);
router.route('/')
    .get(protect, getAssets)
    .post(protect, createAsset);

router.route('/:id')
    .get(protect, getAssetById)
    .put(protect, updateAsset)
    .delete(protect, deleteAsset);

router.route('/:id/assign').put(protect, assignAsset);

module.exports = router;
