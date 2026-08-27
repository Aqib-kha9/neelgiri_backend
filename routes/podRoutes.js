const express = require('express');
const router = express.Router();
const {
    getPods,
    getPodStats,
    getPodById,
    getPodByAwb,
    capturePod,
    updatePod,
    verifyPod,
    deletePod
} = require('../controllers/podController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getPodStats);
router.route('/awb/:awb').get(protect, getPodByAwb);
router.route('/')
    .get(protect, getPods)
    .post(protect, capturePod);

router.route('/:id')
    .get(protect, getPodById)
    .put(protect, updatePod)
    .delete(protect, deletePod);

router.route('/:id/verify').put(protect, verifyPod);

module.exports = router;
