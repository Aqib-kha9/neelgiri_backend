const express = require('express');
const router = express.Router();
const {
    getTickets,
    getTicketStats,
    getTicketById,
    createTicket,
    updateTicket,
    assignTicket,
    addComment,
    resolveTicket,
    closeTicket,
    deleteTicket
} = require('../controllers/customerServiceController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getTicketStats);
router.route('/')
    .get(protect, getTickets)
    .post(protect, createTicket);

router.route('/:id')
    .get(protect, getTicketById)
    .put(protect, updateTicket)
    .delete(protect, deleteTicket);

router.route('/:id/assign').put(protect, assignTicket);
router.route('/:id/comments').post(protect, addComment);
router.route('/:id/resolve').put(protect, resolveTicket);
router.route('/:id/close').put(protect, closeTicket);

module.exports = router;
