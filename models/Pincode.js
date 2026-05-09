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
        required: false // Optional until a branch activates it
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

module.exports = mongoose.model('Pincode', pincodeSchema);
