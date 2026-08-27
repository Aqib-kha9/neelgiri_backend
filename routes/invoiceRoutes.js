const express = require('express');
const router = express.Router();
const {
    getInvoices,
    getInvoiceStats,
    getInvoiceById,
    createInvoice,
    generateInvoiceFromShipments,
    updateInvoice,
    issueInvoice,
    recordPayment,
    cancelInvoice,
    deleteInvoice,
    getNotes,
    createNote,
    approveNote
} = require('../controllers/invoiceController');
const { protect } = require('../middleware/authMiddleware');

// Stats and notes routes must come before /:id
router.route('/stats').get(protect, getInvoiceStats);
router.route('/generate').post(protect, generateInvoiceFromShipments);
router.route('/notes').get(protect, getNotes).post(protect, createNote);
router.route('/notes/:id/approve').put(protect, approveNote);

router.route('/')
    .get(protect, getInvoices)
    .post(protect, createInvoice);

router.route('/:id')
    .get(protect, getInvoiceById)
    .put(protect, updateInvoice)
    .delete(protect, deleteInvoice);

router.route('/:id/issue').put(protect, issueInvoice);
router.route('/:id/cancel').put(protect, cancelInvoice);
router.route('/:id/payments').post(protect, recordPayment);

module.exports = router;
