const express = require('express');
const router = express.Router();
const {
    getReconciliations,
    getReconciliationStats,
    getReconciliationById,
    createReconciliation,
    updateReconciliation,
    resolveReconciliation,
    deleteReconciliation
} = require('../controllers/reconciliationController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getReconciliationStats);
router.route('/')
    .get(protect, getReconciliations)
    .post(protect, createReconciliation);

router.route('/:id')
    .get(protect, getReconciliationById)
    .put(protect, updateReconciliation)
    .delete(protect, deleteReconciliation);

router.route('/:id/resolve').put(protect, resolveReconciliation);

module.exports = router;
