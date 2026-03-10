const mongoose = require('mongoose');

const drsSchema = new mongoose.Schema({
    drsId: {
        type: String,
        required: true,
        unique: true
    },
    rider: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    branchId: {
        type: String,
        required: true
    },
    vehicleMode: {
        type: String,
        enum: ['bike', 'delivery_van', 'walk_in', 'other'],
        default: 'bike'
    },
    status: {
        type: String,
        enum: ['draft', 'scheduled', 'in_progress', 'paused', 'completed', 'deleted'],
        default: 'draft'
    },
    // Pause/Resume Tracking
    pausedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    pausedAt: Date,
    pauseType: {
        type: String,
        enum: ['rider', 'admin'],
        default: 'rider'
    },
    // Delete Tracking
    deletedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    deletedAt: Date,
    // Reschedule Tracking
    isRescheduled: {
        type: Boolean,
        default: false
    },
    rescheduledDate: Date,
    // Scheduling Fields
    scheduledDate: {
        type: Date,
        default: null // Used for single date
    },
    startDate: {
        type: Date, // Used for date range
        default: null
    },
    endDate: {
        type: Date, // Used for date range
        default: null
    },
    shipments: [{
        awb: String,
        status: { type: String, default: 'pending' }, // pending, delivered, rto, failed, scheduled_for_later
        deliveredAt: Date,
        rescheduledDate: Date // For future-dated shipments
    }],
    pincodes: [String],
    startLocation: {
        type: Object, // GeoJSON or simple lat/lng
        default: null
    },
    endLocation: {
        type: Object,
        default: null
    },
    stats: {
        totalShipments: { type: Number, default: 0 },
        completedShipments: { type: Number, default: 0 },
        pendingShipments: { type: Number, default: 0 },
        totalCOD: { type: Number, default: 0 },
        collectedCOD: { type: Number, default: 0 }
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, { timestamps: true });

// Index for efficient querying by rider and status
drsSchema.index({ rider: 1, status: 1 });
drsSchema.index({ branchId: 1 });
drsSchema.index({ scheduledDate: 1 });

module.exports = mongoose.model('DRS', drsSchema);
