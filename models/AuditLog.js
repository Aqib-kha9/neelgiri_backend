const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
    action: {
        type: String,
        required: true,
        index: true // e.g. 'CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT'
    },
    resource: {
        type: String,
        required: true,
        index: true // e.g. 'shipment', 'invoice', 'driver'
    },
    resourceId: {
        type: mongoose.Schema.Types.Mixed,
        index: true
    },
    description: { type: String, default: '' },
    details: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    // Actor
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    userName: { type: String },
    userRole: { type: String },
    // Context
    ipAddress: { type: String },
    userAgent: { type: String },
    method: { type: String }, // HTTP method
    path: { type: String },   // request path
    // Scope
    partnerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    branchId: {
        type: mongoose.Schema.Types.Mixed,
        index: true
    },
    status: {
        type: String,
        enum: ['success', 'failure'],
        default: 'success'
    },
    errorMessage: { type: String }
}, {
    timestamps: { createdAt: true, updatedAt: false }
});

// Compound index for fast filtered queries
auditLogSchema.index({ resource: 1, action: 1, createdAt: -1 });
auditLogSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
