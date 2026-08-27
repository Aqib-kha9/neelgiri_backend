/**
 * hubRoutes.js
 *
 * Transit Hub Operations Routes
 *
 * Endpoints:
 *   GET    /api/hubs                          - List all hubs
 *   GET    /api/hubs/dashboard                - Hub dashboard with stats
 *   GET    /api/hubs/pending-sort             - Parcels waiting to be sorted
 *   GET    /api/hubs/sort-history             - Audit trail of sorting operations
 *   POST   /api/hubs/manifests/:manifestId/receive  - Receive inbound manifest
 *   POST   /api/hubs/bags/:bagId/open         - Open bag for sorting
 *   POST   /api/hubs/sort                     - Sort a parcel to next destination
 *   POST   /api/hubs/bags/outbound            - Create outbound bag
 *   POST   /api/hubs/manifests/outbound       - Create outbound manifest
 *   PUT    /api/hubs/:branchId/convert        - Convert branch to hub type
 */

const express = require('express');
const router = express.Router();
const hubController = require('../controllers/hubController');
const { protect } = require('../middleware/authMiddleware');

// ─── Hub Management ──────────────────────────────────────────────
router.get('/', protect, hubController.getAllHubs);
router.get('/dashboard', protect, hubController.getHubDashboard);
router.get('/pending-sort', protect, hubController.getPendingSort);
router.get('/sort-history', protect, hubController.getSortHistory);
router.put('/:branchId/convert', protect, hubController.convertToHub);

// ─── Inbound Operations ──────────────────────────────────────────
router.post('/manifests/:manifestId/receive', protect, hubController.receiveManifest);
router.post('/bags/:bagId/open', protect, hubController.openBagForSorting);

// ─── Sorting Operations ───────────────────────────────────────────
router.post('/sort', protect, hubController.sortParcel);

// ─── Outbound Operations ──────────────────────────────────────────
router.post('/bags/outbound', protect, hubController.createOutboundBag);
router.post('/manifests/outbound', protect, hubController.createOutboundManifest);

module.exports = router;
