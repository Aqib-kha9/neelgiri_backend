const mongoose = require('mongoose');

const trackingPingSchema = new mongoose.Schema({
    trackingId: { type: String, required: true, index: true },
    awb: { type: String, index: true },
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    riderName: String,
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
    vehicleNumber: String,
    drsId: { type: String, index: true },

    location: {
        latitude: { type: Number, required: true },
        longitude: { type: Number, required: true },
        accuracy: Number,
        heading: Number,
        speed: { type: Number, default: 0 }
    },
    address: String,

    batteryLevel: Number,
    networkType: { type: String, default: 'UNKNOWN' },

    shipmentStatus: String,
    event: {
        type: String,
        enum: ['LOCATION_UPDATE', 'PICKUP', 'DELIVERY_START', 'DELIVERY_COMPLETE', 'DELIVERY_FAILED', 'RTO', 'PAUSE', 'RESUME', 'IDLE'],
        default: 'LOCATION_UPDATE'
    },
    remark: String,

    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

// Index for efficient querying
trackingPingSchema.index({ trackingId: 1, createdAt: -1 });
trackingPingSchema.index({ riderId: 1, createdAt: -1 });
trackingPingSchema.index({ awb: 1, createdAt: -1 });
trackingPingSchema.index({ location: '2dsphere' });

// Virtual for formatted location
trackingPingSchema.virtual('locationString').get(function () {
    return `${this.location.latitude.toFixed(6)}, ${this.location.longitude.toFixed(6)}`;
});

module.exports = mongoose.model('Tracking', trackingPingSchema);
