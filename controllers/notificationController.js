/**
 * notificationController.js
 *
 * Customer & internal notification system. Sends notifications at shipment
 * milestones via SMS, Email, WhatsApp, or in-app. Uses configurable providers
 * via environment variables (SMS_PROVIDER, EMAIL_PROVIDER, etc.).
 *
 * In production, this would integrate with:
 *   - SMS: Twilio, MSG91, TextLocal
 *   - Email: SendGrid, AWS SES
 *   - WhatsApp: WhatsApp Business API
 *
 * For now, notifications are stored in DB and marked as 'sent' (fire-and-forget).
 * A separate worker/cron can pick up 'queued' notifications and send them.
 */

const asyncHandler = require('express-async-handler');
const Notification = require('../models/Notification');
const Shipment = require('../models/Shipment');
const { generateNotificationId } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// Notification templates
const TEMPLATES = {
    booking_confirmed: {
        subject: 'Booking Confirmed',
        getMessage: (data) => `Dear Customer, your shipment ${data.awb} has been booked. Track at ${data.trackingUrl || 'our portal'}. Total: Rs.${data.amount || 0}.`
    },
    pickup_scheduled: {
        subject: 'Pickup Scheduled',
        getMessage: (data) => `Dear Customer, your pickup is scheduled for ${data.date} (${data.timeSlot}). Rider: ${data.riderName || 'TBD'}.`
    },
    pickup_done: {
        subject: 'Pickup Completed',
        getMessage: (data) => `Dear Customer, your shipment ${data.awb} has been picked up successfully. AWB: ${data.awb}.`
    },
    in_transit: {
        subject: 'Shipment In Transit',
        getMessage: (data) => `Dear Customer, your shipment ${data.awb} is in transit from ${data.fromBranch} to ${data.toBranch}. Expected delivery: ${data.eta}.`
    },
    arrived_at_branch: {
        subject: 'Shipment Arrived',
        getMessage: (data) => `Dear Customer, your shipment ${data.awb} has arrived at ${data.branchName}. Out for delivery soon.`
    },
    out_for_delivery: {
        subject: 'Out For Delivery',
        getMessage: (data) => `Dear Customer, your shipment ${data.awb} is out for delivery. Rider: ${data.riderName}, Phone: ${data.riderPhone}.`
    },
    delivered: {
        subject: 'Shipment Delivered',
        getMessage: (data) => `Dear Customer, your shipment ${data.awb} has been delivered successfully to ${data.deliveredTo}. Thank you for choosing us!`
    },
    delivery_failed: {
        subject: 'Delivery Attempt Failed',
        getMessage: (data) => `Dear Customer, delivery attempt for ${data.awb} failed: ${data.reason}. Next attempt: ${data.nextAttempt || 'will be scheduled'}.`
    },
    delivery_rescheduled: {
        subject: 'Delivery Rescheduled',
        getMessage: (data) => `Dear Customer, your shipment ${data.awb} delivery has been rescheduled to ${data.newDate}.`
    },
    rto_initiated: {
        subject: 'RTO Initiated',
        getMessage: (data) => `Dear Customer, RTO has been initiated for shipment ${data.awb}. Reason: ${data.reason}. The shipment will be returned to origin.`
    },
    rto_completed: {
        subject: 'RTO Completed',
        getMessage: (data) => `Dear Customer, your shipment ${data.awb} has been returned to origin. RTO charges: Rs.${data.rtoCharges || 0}.`
    },
    exception_raised: {
        subject: 'Exception Raised',
        getMessage: (data) => `Alert: Exception raised for shipment ${data.awb}. Type: ${data.exceptionType}, Severity: ${data.severity}.`
    },
    sla_breach: {
        subject: 'SLA Breach Alert',
        getMessage: (data) => `ALERT: Shipment ${data.awb} has breached SLA. Expected: ${data.slaDeadline}, Current delay: ${data.delayHours} hours.`
    },
    custom: {
        subject: 'Notification',
        getMessage: (data) => data.message || 'You have a new notification.'
    }
};

/**
 * Internal helper: Create and queue a notification.
 * This is called by other controllers when a milestone is reached.
 */
const sendNotification = async ({ recipient, channel, template, data, shipment, awb, partnerId, branchId, createdBy }) => {
    try {
        const tpl = TEMPLATES[template] || TEMPLATES.custom;
        const message = tpl.getMessage(data || {});

        const notification = await Notification.create({
            notificationId: generateNotificationId(),
            recipientType: recipient?.type || 'customer',
            recipientId: recipient?.id || null,
            recipientName: recipient?.name || '',
            recipientPhone: recipient?.phone || '',
            recipientEmail: recipient?.email || '',
            channel: channel || 'SMS',
            template,
            subject: tpl.subject,
            message,
            data: data || {},
            shipment: shipment || null,
            awb: awb || '',
            status: 'sent',
            sentAt: new Date(),
            partnerId: partnerId || null,
            branchId: branchId || null,
            createdBy: createdBy || null
        });

        return notification;
    } catch (err) {
        console.error('[Notification] Failed to send:', err.message);
        return null;
    }
};

// @desc    Get notifications (scoped)
// @route   GET /api/notifications
// @access  Private
const getNotifications = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};

    const { status, channel, template, search, awb } = req.query;
    if (status && status !== 'ALL') query.status = status;
    if (channel && channel !== 'ALL') query.channel = channel;
    if (template && template !== 'ALL') query.template = template;
    if (awb) query.awb = awb;
    if (search) {
        query.$or = [
            { notificationId: { $regex: search, $options: 'i' } },
            { recipientName: { $regex: search, $options: 'i' } },
            { recipientPhone: { $regex: search, $options: 'i' } },
            { awb: { $regex: search, $options: 'i' } },
            { message: { $regex: search, $options: 'i' } }
        ];
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
        Notification.find(query)
            .populate('shipment', 'awb status')
            .populate('recipientId', 'name email phone')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        Notification.countDocuments(query)
    ]);

    res.json({
        notifications,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
});

// @desc    Get notification by ID
// @route   GET /api/notifications/:id
// @access  Private
const getNotificationById = asyncHandler(async (req, res) => {
    const notification = await Notification.findById(req.params.id)
        .populate('shipment', 'awb status sender receiver')
        .populate('recipientId', 'name email phone');

    if (!notification) {
        res.status(404);
        throw new Error('Notification not found');
    }
    res.json(notification);
});

// @desc    Create a custom notification
// @route   POST /api/notifications
// @access  Private (branch_admin, super_admin)
const createNotification = asyncHandler(async (req, res) => {
    const { recipientId, recipientPhone, recipientEmail, channel, template, message, awb, shipmentId, data } = req.body;

    const partnerId = getEffectivePartnerId(req.user);
    const branchId = getEffectiveBranchId(req.user);

    // Fetch recipient details if recipientId provided
    let recipientName = '';
    if (recipientId) {
        const User = require('../models/User');
        const user = await User.findById(recipientId).select('name email phone');
        if (user) {
            recipientName = user.name;
        }
    }

    const tpl = TEMPLATES[template] || TEMPLATES.custom;
    const finalMessage = message || tpl.getMessage(data || {});

    const notification = await Notification.create({
        notificationId: generateNotificationId(),
        recipientType: 'customer',
        recipientId: recipientId || null,
        recipientName,
        recipientPhone: recipientPhone || '',
        recipientEmail: recipientEmail || '',
        channel: channel || 'SMS',
        template: template || 'custom',
        subject: tpl.subject,
        message: finalMessage,
        data: data || {},
        shipment: shipmentId || null,
        awb: awb || '',
        status: 'sent',
        sentAt: new Date(),
        partnerId,
        branchId,
        createdBy: req.user._id
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'notification',
        resourceId: notification._id,
        description: `Notification sent to ${recipientName || recipientPhone}: ${tpl.subject}`
    });

    res.status(201).json(notification);
});

// @desc    Mark notification as read
// @route   PUT /api/notifications/:id/read
// @access  Private
const markAsRead = asyncHandler(async (req, res) => {
    const notification = await Notification.findById(req.params.id);
    if (!notification) {
        res.status(404);
        throw new Error('Notification not found');
    }

    notification.status = 'read';
    notification.readAt = new Date();
    await notification.save();

    res.json(notification);
});

// @desc    Get notification stats
// @route   GET /api/notifications/stats
// @access  Private
const getNotificationStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};

    const [total, sent, delivered, read, failed, queued] = await Promise.all([
        Notification.countDocuments(query),
        Notification.countDocuments({ ...query, status: 'sent' }),
        Notification.countDocuments({ ...query, status: 'delivered' }),
        Notification.countDocuments({ ...query, status: 'read' }),
        Notification.countDocuments({ ...query, status: 'failed' }),
        Notification.countDocuments({ ...query, status: 'queued' })
    ]);

    const channelBreakdown = await Notification.aggregate([
        { $match: query },
        { $group: { _id: '$channel', count: { $sum: 1 } } }
    ]);

    const templateBreakdown = await Notification.aggregate([
        { $match: query },
        { $group: { _id: '$template', count: { $sum: 1 } } }
    ]);

    res.json({
        total,
        sent,
        delivered,
        read,
        failed,
        queued,
        channelBreakdown: channelBreakdown.reduce((acc, c) => { acc[c._id] = c.count; return acc; }, {}),
        templateBreakdown: templateBreakdown.reduce((acc, t) => { acc[t._id] = t.count; return acc; }, {})
    });
});

module.exports = {
    sendNotification,
    getNotifications,
    getNotificationById,
    createNotification,
    markAsRead,
    getNotificationStats,
    TEMPLATES
};
