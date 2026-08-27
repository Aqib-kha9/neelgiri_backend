const express = require('express');
const router = express.Router();
const {
    getAwbSeries,
    getAwbStats,
    getAllAllocations,
    getUsage,
    getAwbSeriesById,
    createAwbSeries,
    updateAwbSeries,
    deleteAwbSeries,
    allocateRange,
    consumeAwb,
    getAllocations
} = require('../controllers/awbController');
const { protect } = require('../middleware/authMiddleware');

router.get('/stats', protect, getAwbStats);
router.get('/allocations', protect, getAllAllocations);
router.get('/usage', protect, getUsage);
router.route('/')
    .get(protect, getAwbSeries)
    .post(protect, createAwbSeries);

router.route('/:id')
    .get(protect, getAwbSeriesById)
    .put(protect, updateAwbSeries)
    .delete(protect, deleteAwbSeries);

router.route('/:id/allocate').post(protect, allocateRange);
router.route('/:id/consume').post(protect, consumeAwb);
router.route('/:id/allocations').get(protect, getAllocations);

module.exports = router;
