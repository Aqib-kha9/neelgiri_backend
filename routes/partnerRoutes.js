const express = require('express');
const router = express.Router();
const {
    getPartners,
    getPartnerStats,
    getPartnerById,
    createPartner,
    updatePartner,
    deletePartner
} = require('../controllers/partnerVendorController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getPartnerStats);
router.route('/')
    .get(protect, getPartners)
    .post(protect, createPartner);

router.route('/:id')
    .get(protect, getPartnerById)
    .put(protect, updatePartner)
    .delete(protect, deletePartner);

module.exports = router;
