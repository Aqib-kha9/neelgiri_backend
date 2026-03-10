const mongoose = require('mongoose');

const shipmentSchema = new mongoose.Schema({
    awb: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    sender: {
        name: String,
        phone: String,
        address: String,
        pincode: String,
        email: String
    },
    receiver: {
        name: String,
        phone: String,
        address: String,
        pincode: String,
        email: String
    },
    weight: {
        type: Number, // in kg
        default: 0
    },
    dimensions: {
        length: Number,
        width: Number,
        height: Number
    },
    contents: String,
    declaredValue: Number,
    paymentMode: {
        type: String,
        enum: ['prepaid', 'cod'],
        default: 'prepaid'
    },
    codAmount: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: [
            'not_scheduled',  // Available for DRS assignment
            'scheduled',      // Assigned to DRS
            'in_progress',    // Rider actively delivering
            'paused',         // DRS paused
            'complete',       // Successfully delivered/completed
            'in_transit',     // Moving between branches
            'forwarded',      // Sent from source
            'received',       // Recieved at destination
            'pending_for_branch_approval' // Rider marked delivered, waiting for branch
        ],
        default: 'not_scheduled'
    },
    originType: {
        type: String,
        enum: ['manual_forward', 'drs_pickup', 'counter_inward', 'customer_portal'],
        default: 'counter_inward'
    },
    originBranchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch'
    },
    completedVia: {
        type: String,
        enum: ['manual', 'rider', 'branch_direct', null],
        default: null,
        // 'manual' = Completed from Available Shipments (three-dot menu)
        // 'branch_direct' = Direct Approve from DRS/Manifest
        // 'rider' = Completed by rider as part of DRS completion
        // null = Not yet completed
    },
    currentBranch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch'
    },
    destinationBranch: {
        type: mongoose.Schema.Types.ObjectId, // If known
        ref: 'Branch'
    },
    history: [{
        status: String,
        branchId: { type: mongoose.Schema.Types.Mixed }, // Changed from ObjectId to Mixed to support string codes (e.g. 'HEAD_OFFICE') and numeric IDs
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        timestamp: { type: Date, default: Date.now },
        remark: String
    }],
    deliveredAt: {
        type: Date
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, { timestamps: true });

// Indexes
shipmentSchema.index({ currentBranch: 1, status: 1 });
shipmentSchema.index({ 'receiver.pincode': 1 });

module.exports = mongoose.model('Shipment', shipmentSchema);
