/**
 * auditLogRoutes.js
 * Routes for viewing, filtering, and exporting audit logs.
 *
 * Route structure:
 *   /api/audit-logs
 *     GET    /stats                              - audit log stats
 *     GET    /export                             - export logs (CSV/JSON)
 *     GET    /                                   - paginated, filtered list
 *     GET    /resource/:resource/:resourceId     - logs by resource
 *     GET    /user/:userId                       - logs by user
 *     GET    /:id                                - get by ID
 *     DELETE /cleanup                            - retention cleanup (super_admin)
 */

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { roleCheck } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/auditLogController');

// All routes require authentication
router.use(protect);

// Stats and export must come before /:id
router.get('/stats', ctrl.getAuditLogStats);
router.get('/export', ctrl.exportAuditLogs);
router.get('/resource/:resource/:resourceId', ctrl.getAuditLogsByResource);
router.get('/user/:userId', ctrl.getAuditLogsByUser);

// Cleanup - super_admin only
router.delete('/cleanup', roleCheck(['super_admin']), ctrl.deleteOldLogs);

// Standard CRUD
router.get('/', ctrl.getAuditLogs);
router.get('/:id', ctrl.getAuditLogById);

module.exports = router;
