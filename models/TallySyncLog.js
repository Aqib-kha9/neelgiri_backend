const mongoose = require('mongoose');

const tallySyncLogSchema = new mongoose.Schema({
    syncId: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true,
        index: true
    },
    type: {
        type: String,
        enum: ['invoice', 'payment', 'credit_note', 'ledger', 'stock'],
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: ['success', 'failed', 'processing'],
        default: 'processing',
        index: true
    },
    recordsSynced: {
        type: Number,
        default: 0
    },
    recordsFailed: {
        type: Number,
        default: 0
    },
    details: {
        type: String,
        trim: true
    },
    errorMessage: {
        type: String,
        trim: true
    },
    triggeredBy: {
        type: String,
        default: 'System (Auto)'
    },
    triggeredByUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    syncDurationMs: {
        type: Number,
        default: 0
    },
    partnerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    branchId: {
        type: mongoose.Schema.Types.Mixed,
        index: true
    }
}, { timestamps: true });

tallySyncLogSchema.index({ createdAt: -1 });
tallySyncLogSchema.index({ type: 1, status: 1 });

module.exports = mongoose.model('TallySyncLog', tallySyncLogSchema);
