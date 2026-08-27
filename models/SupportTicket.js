const mongoose = require('mongoose');

const ticketCommentSchema = new mongoose.Schema({
    commentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    commentByName: String,
    comment: { type: String, required: true },
    isInternal: { type: Boolean, default: false },
    attachments: [String]
}, { timestamps: true });

const supportTicketSchema = new mongoose.Schema({
    ticketNo: { type: String, required: true, unique: true, index: true },
    subject: { type: String, required: true, trim: true },
    description: { type: String, required: true },

    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String, required: true },
    customerEmail: { type: String, trim: true },
    customerPhone: { type: String, trim: true },

    awb: { type: String, default: '' },
    orderId: { type: String, default: '' },

    category: {
        type: String,
        enum: ['DELIVERY_ISSUE', 'PICKUP_ISSUE', 'DAMAGED', 'LOST', 'DELAY', 'BILLING', 'ADDRESS_CHANGE', 'RTO', 'REFUND', 'OTHER'],
        default: 'OTHER'
    },
    priority: {
        type: String,
        enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
        default: 'MEDIUM'
    },
    status: {
        type: String,
        enum: ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED', 'REOPENED'],
        default: 'OPEN'
    },

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedToName: String,

    sla: {
        responseDueAt: Date,
        resolutionDueAt: Date,
        respondedAt: Date,
        resolvedAt: Date
    },

    comments: [ticketCommentSchema],
    attachments: [String],

    resolution: {
        resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        resolvedByName: String,
        resolutionNote: String,
        resolvedAt: Date,
        resolutionType: { type: String, enum: ['RESOLVED', 'WONT_FIX', 'DUPLICATE', 'INVALID'], default: 'RESOLVED' }
    },

    rating: { type: Number, min: 1, max: 5, default: null },
    feedback: String,

    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted: { type: Boolean, default: false }
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

supportTicketSchema.virtual('isOverdue').get(function () {
    if (this.status === 'CLOSED' || this.status === 'RESOLVED') return false;
    if (this.sla && this.sla.resolutionDueAt) {
        return new Date() > this.sla.resolutionDueAt;
    }
    return false;
});

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
