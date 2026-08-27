/**
 * Notification.js
 *
 * Customer & internal notification system. Captures every notification
 * sent at shipment milestones (booking, pickup, in-transit, out-for-delivery,
 * delivered, RTO, etc.). Supports SMS, Email, and WhatsApp channels.
 *
 * Lifecycle: queued → sent → delivered → read (or → failed)
 */

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    notificationId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    // Recipient
    recipientType: {
        type: String,
        enum: ['customer', 'rider', 'branch_admin', 'partner_admin', 'super_admin', 'internal'],
        default: 'customer'
    },
    recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    recipientName: { type: String, default: '' },
    recipientPhone: { type: String, default: '' },
    recipientEmail: { type: String, default: '' },
    // Channel
    channel: {
        type: String,
        enum: ['SMS', 'EMAIL', 'WHATSAPP', 'IN_APP'],
        required: true
    },
    // Content
    template: {
        type: String,
        enum: [
            'booking_confirmed',
            'pickup_scheduled',
            'pickup_done',
            'in_transit',
            'arrived_at_branch',
            'out_for_delivery',
            'delivered',
            'delivery_failed',
            'delivery_rescheduled',
            'rto_initiated',
            'rto_completed',
            'exception_raised',
            'sla_breach',
            'custom'
        ],
        default: 'custom'
    },
    subject: { type: String, default: '' },
    message: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Related entity
    shipment: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment', default: null },
    awb: { type: String, default: '' },
    // Status
    status: {
        type: String,
        enum: ['queued', 'sent', 'delivered', 'read', 'failed'],
        default: 'queued',
        index: true
    },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    failureReason: { type: String, default: '' },
    retryCount: { type: Number, default: 0 },
    // Multi-tenant scoping
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

// Indexes
notificationSchema.index({ recipientId: 1, status: 1 });
notificationSchema.index({ awb: 1 });
notificationSchema.index({ channel: 1, status: 1 });
notificationSchema.index({ partnerId: 1, branchId: 1 });
notificationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
