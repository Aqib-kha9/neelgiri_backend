const express = require('express');
const router = express.Router();
const {
    getNotifications,
    getNotificationById,
    createNotification,
    markAsRead,
    getNotificationStats
} = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

// Route: /api/notifications

router.route('/stats').get(protect, getNotificationStats);
router.route('/')
    .get(protect, getNotifications)
    .post(protect, createNotification);

router.route('/:id')
    .get(protect, getNotificationById);

router.put('/:id/read', protect, markAsRead);

module.exports = router;
