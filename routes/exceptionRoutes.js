const express = require('express');
const router = express.Router();
const {
    getExceptions,
    getExceptionStats,
    getExceptionById,
    createException,
    updateException,
    resolveException,
    escalateException,
    closeException,
    addAction,
    deleteException
} = require('../controllers/exceptionController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getExceptionStats);
router.route('/')
    .get(protect, getExceptions)
    .post(protect, createException);

router.route('/:id')
    .get(protect, getExceptionById)
    .put(protect, updateException)
    .delete(protect, deleteException);

router.route('/:id/resolve').put(protect, resolveException);
router.route('/:id/escalate').put(protect, escalateException);
router.route('/:id/close').put(protect, closeException);
router.route('/:id/actions').post(protect, addAction);

module.exports = router;
