const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
    getCODRecords,
    depositCOD,
    getPaymentCollections,
    getSettlements,
    createSettlement,
    processSettlement,
    getTallyLogs,
    triggerTallySync
} = require('../controllers/paymentController');

// COD Management
router.route('/cod').get(protect, getCODRecords);
router.route('/cod/:riderId/deposit').post(protect, depositCOD);

// Payment Collection
router.route('/collection').get(protect, getPaymentCollections);

// Settlement Reports
router.route('/settlements').get(protect, getSettlements).post(protect, createSettlement);
router.route('/settlements/:id/process').put(protect, processSettlement);

// Tally Integration
router.route('/tally/logs').get(protect, getTallyLogs);
router.route('/tally/sync').post(protect, triggerTallySync);

module.exports = router;
