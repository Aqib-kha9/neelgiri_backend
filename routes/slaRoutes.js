/**
 * slaRoutes.js
 *
 * SLA / TAT monitoring API routes.
 */

const express = require('express');
const router = express.Router();
const slaController = require('../controllers/slaController');
const { protect } = require('../middleware/authMiddleware');

// ─── SLA Dashboard & Queries ─────────────────────────────────────
// NOTE: /stats, /approaching, /breached, /check, /config must be BEFORE /:awb
router.get('/stats', protect, slaController.getSLADashboard);
router.get('/approaching', protect, slaController.getApproaching);
router.get('/breached', protect, slaController.getBreached);
router.get('/config', protect, slaController.getSLAConfig);

// ─── SLA Actions ──────────────────────────────────────────────────
router.post('/check', protect, slaController.triggerBreachCheck);
router.put('/:awb', protect, slaController.updateShipmentSLA);

module.exports = router;
