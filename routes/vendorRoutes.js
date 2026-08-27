const express = require('express');
const router = express.Router();
const {
    getVendors,
    getVendorStats,
    getVendorById,
    createVendor,
    updateVendor,
    deleteVendor
} = require('../controllers/partnerVendorController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getVendorStats);
router.route('/')
    .get(protect, getVendors)
    .post(protect, createVendor);

router.route('/:id')
    .get(protect, getVendorById)
    .put(protect, updateVendor)
    .delete(protect, deleteVendor);

module.exports = router;
