const mongoose = require('mongoose');

const noteLineItemSchema = new mongoose.Schema({
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    invoiceNo: { type: String, trim: true },
    awb: { type: String, trim: true },
    description: { type: String, trim: true },
    amount: { type: Number, default: 0 },
    reason: { type: String, trim: true }
}, { _id: false });

const noteSchema = new mongoose.Schema({
    noteNo: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    noteType: {
        type: String,
        enum: ['CREDIT', 'DEBIT'],
        required: true,
        index: true
    },

    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    customerName: { type: String, trim: true },
    customerCode: { type: String, trim: true },

    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', index: true },
    invoiceNo: { type: String, trim: true },

    noteDate: { type: Date, default: Date.now, required: true },
    reason: { type: String, trim: true },

    lineItems: [noteLineItemSchema],

    subtotal: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },

    status: {
        type: String,
        enum: ['PENDING', 'APPROVED', 'APPLIED', 'REJECTED'],
        default: 'PENDING',
        index: true
    },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },

    notes: { type: String, trim: true },

    // Hierarchy / RBAC
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

noteSchema.index({ customerId: 1, noteType: 1 });

module.exports = mongoose.model('CreditDebitNote', noteSchema);
