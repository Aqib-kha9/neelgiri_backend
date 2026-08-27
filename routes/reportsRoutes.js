const express = require('express');
const router = express.Router();
const {
    getDashboardSummary,
    getDeliveryPerformance,
    getRiderPerformance,
    getPartnerPerformance,
    getRevenueReport,
    getSettlementReport,
    getGstReport,
    getExceptionReport,
    getSlaReport,
    getShipmentStatusDistribution,
    getTrendAnalysis
} = require('../controllers/reportsController');
const { protect } = require('../middleware/authMiddleware');

router.route('/dashboard').get(protect, getDashboardSummary);
router.route('/delivery-performance').get(protect, getDeliveryPerformance);
router.route('/rider-performance').get(protect, getRiderPerformance);
router.route('/partner-performance').get(protect, getPartnerPerformance);
router.route('/revenue').get(protect, getRevenueReport);
router.route('/settlement').get(protect, getSettlementReport);
router.route('/gst').get(protect, getGstReport);
router.route('/exceptions').get(protect, getExceptionReport);
router.route('/sla').get(protect, getSlaReport);
router.route('/status-distribution').get(protect, getShipmentStatusDistribution);
router.route('/trends').get(protect, getTrendAnalysis);

module.exports = router;
