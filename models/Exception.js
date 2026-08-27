const mongoose = require('mongoose');

const exceptionActionSchema = new mongoose.Schema({
    action: { type: String, trim: true },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    performedAt: { type: Date, default: Date.now },
    remarks: { type: String, trim: true }
}, { _id: false });

const exceptionSchema = new mongoose.Schema({
    exceptionId: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },

    shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment', index: true },
    awb: { type: String, trim: true, index: true },

    // Exception classification
    type: {
        type: String,
        enum: [
            'DAMAGED', 'LOST', 'PILFERAGE', 'SHORT_DELIVERY',
            'WRONG_DELIVERY', 'ADDRESS_ISSUE', 'WEIGHT_DISCREPANCY',
            'PAYMENT_ISSUE', 'DELAY', 'REFUSED', 'OTHER',
            'RTO_AUTO', 'RTO_MANUAL', 'DELIVERY_FAILED', 'SEAL_BROKEN',
            'BAG_TAMPERED', 'MAX_ATTEMPTS_EXHAUSTED'
        ],
        required: true,
        index: true
    },
    severity: {
        type: String,
        enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
        default: 'MEDIUM',
        index: true
    },
    category: {
        type: String,
        enum: ['OPERATIONAL', 'CUSTOMER', 'VENDOR', 'SYSTEM', 'FINANCIAL'],
        default: 'OPERATIONAL'
    },

    // Details
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    reportedBy: { type: String, trim: true }, // who reported (customer/staff/partner)

    // Location where exception occurred
    location: {
        branchId: { type: mongoose.Schema.Types.Mixed },
        branchName: { type: String, trim: true },
        city: { type: String, trim: true }
    },

    // Financial impact
    financialImpact: {
        claimAmount: { type: Number, default: 0 },
        approvedAmount: { type: Number, default: 0 },
        recoveredAmount: { type: Number, default: 0 }
    },

    // Attachments (photos of damage, etc.)
    attachments: [{
        url: { type: String, required: true },
        type: { type: String, enum: ['image', 'document'], default: 'image' },
        uploadedAt: { type: Date, default: Date.now }
    }],

    // Resolution
    status: {
        type: String,
        enum: ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED', 'ESCALATED'],
        default: 'OPEN',
        index: true
    },
    resolution: { type: String, trim: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },

    // Escalation
    escalatedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    escalatedAt: { type: Date },
    escalationReason: { type: String, trim: true },

    // Action history
    actions: [exceptionActionSchema],

    // Hierarchy / RBAC
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

exceptionSchema.index({ shipmentId: 1, status: 1 });
exceptionSchema.index({ type: 1, severity: 1 });

module.exports = mongoose.model('Exception', exceptionSchema);
