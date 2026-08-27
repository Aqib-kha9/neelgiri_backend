/**
 * rtoRoutes.js
 *
 * Return-to-Origin (RTO) Workflow Routes
 *
 * Full RTO Lifecycle:
 *   1. Initiate RTO        → POST   /api/rto/initiate
 *   2. Create RTO Manifest → POST   /api/rto/manifest
 *   3. Dispatch RTO         → PUT    /api/rto/manifest/:manifestId/dispatch
 *   4. Receive RTO at Origin → PUT    /api/rto/manifest/:manifestId/receive
 *   5. Complete RTO         → PUT    /api/rto/complete/:awb
 *   6. Cancel RTO           → PUT    /api/rto/cancel/:awb
 *
 * Query / Dashboard:
 *   GET    /api/rto                - List all RTO shipments (with filters)
 *   GET    /api/rto/stats          - RTO statistics dashboard
 *   GET    /api/rto/:awb           - Get detailed RTO info for a shipment
 */

const express = require('express');
const router = express.Router();
const rtoController = require('../controllers/rtoController');
const { protect } = require('../middleware/authMiddleware');

// ─── RTO Lifecycle Operations ────────────────────────────────────
router.post('/initiate', protect, rtoController.initiateRTO);
router.post('/manifest', protect, rtoController.createRTOManifest);
router.put('/manifest/:manifestId/dispatch', protect, rtoController.dispatchRTO);
router.put('/manifest/:manifestId/receive', protect, rtoController.receiveRTO);
router.put('/complete/:awb', protect, rtoController.completeRTO);
router.put('/cancel/:awb', protect, rtoController.cancelRTO);

// ─── RTO Queries & Dashboard ──────────────────────────────────────
// NOTE: /stats must be defined BEFORE /:awb to avoid route conflict
router.get('/stats', protect, rtoController.getRTOStats);
router.get('/', protect, rtoController.getRTOShipments);
router.get('/:awb', protect, rtoController.getRTODetails);

module.exports = router;
