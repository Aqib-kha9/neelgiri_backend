const mongoose = require('mongoose');

const settlementSchema = new mongoose.Schema({
    settlementId: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true,
        index: true
    },
    partnerName: {
        type: String,
        trim: true,
        required: true
    },
    partnerTechId: {
        type: String,
        trim: true,
        index: true
    },
    partnerType: {
        type: String,
        enum: ['vendor', 'rider', 'partner'],
        required: true,
        index: true
    },
    partnerRefId: {
        type: mongoose.Schema.Types.ObjectId,
        refPath: 'partnerType'
    },
    amount: {
        type: Number,
        default: 0
    },
    periodStart: {
        type: Date
    },
    periodEnd: {
        type: Date
    },
    period: {
        type: String,
        trim: true
    },
    status: {
        type: String,
        enum: ['settled', 'processing', 'hold', 'pending'],
        default: 'pending',
        index: true
    },
    processedDate: {
        type: Date
    },
    transactionRef: {
        type: String,
        trim: true
    },
    paymentMode: {
        type: String,
        enum: ['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'ADJUSTMENT'],
        default: 'BANK_TRANSFER'
    },
    notes: {
        type: String,
        trim: true
    },
    lineItems: [{
        description: String,
        amount: Number,
        referenceNo: String
    }],
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    partnerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    branchId: {
        type: mongoose.Schema.Types.Mixed,
        index: true
    },
    isDeleted: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

settlementSchema.index({ partnerType: 1, status: 1 });
settlementSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Settlement', settlementSchema);
