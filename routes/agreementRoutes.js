const express = require('express');
const router = express.Router();
const {
    getAgreements,
    getAgreementStats,
    getAgreementById,
    createAgreement,
    updateAgreement,
    approveAgreement,
    terminateAgreement,
    deleteAgreement
} = require('../controllers/customerServiceController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getAgreementStats);
router.route('/')
    .get(protect, getAgreements)
    .post(protect, createAgreement);

router.route('/:id')
    .get(protect, getAgreementById)
    .put(protect, updateAgreement)
    .delete(protect, deleteAgreement);

router.route('/:id/approve').put(protect, approveAgreement);
router.route('/:id/terminate').put(protect, terminateAgreement);

module.exports = router;
