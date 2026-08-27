const mongoose = require('mongoose');

const pincodeSchema = new mongoose.Schema({
    pincode: { type: String, required: true },
    officeName: { type: String }, // Area/Location name
    district: { type: String },
    state: { type: String },
    zone: { type: String },
    branchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        required: false // Commercial/tenant ownership and existing claim workflow
    },
    locationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Location',
        required: false,
        default: null // Operational facility responsible for pickup/delivery execution
    },
    isServiceable: { type: Boolean, default: false }, // Global Serviceability (Super Admin)
    isActiveForBranch: { type: Boolean, default: true }, // Local Serviceability (Partner/Branch Admin)
    isODA: { type: Boolean, default: false },
    isMetro: { type: Boolean, default: false },
    transitDays: { type: Number, default: 3 },
    latitude: { type: Number },
    longitude: { type: Number },
    
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, { timestamps: true });

pincodeSchema.index({ pincode: 1 });
pincodeSchema.index({ branchId: 1, locationId: 1 });
pincodeSchema.index({ locationId: 1, isServiceable: 1 });

module.exports = mongoose.model('Pincode', pincodeSchema);
