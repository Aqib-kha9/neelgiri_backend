const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    code: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        uppercase: true
    },
    partnerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    ownershipType: {
        type: String,
        enum: ['company', 'partner'],
        default: function () {
            return this.partnerId ? 'partner' : 'company';
        },
        validate: {
            validator: function (value) {
                return value !== 'partner' || Boolean(this.partnerId);
            },
            message: 'Partner-owned branches require a partnerId'
        }
    },
    // Branch type — distinguishes regular delivery branches from transit hubs
    type: {
        type: String,
        enum: ['branch', 'hub', 'central_sorting_facility', 'regional_hub', 'metro_hub'],
        default: 'branch'
    },
    // Hub-specific: which branches this hub serves as a transit point
    servesBranches: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch'
    }],
    // Hub-specific: connected hubs for multi-leg routing
    connectedHubs: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch'
    }],
    // Hub capacity & operational metadata
    hubCapacity: {
        maxBagsPerDay: { type: Number, default: 0 },
        maxManifestsPerDay: { type: Number, default: 0 },
        sortingLines: { type: Number, default: 1 }
    },
    // Operating hours
    operatingHours: {
        open: { type: String, default: '09:00' },
        close: { type: String, default: '21:00' },
        is24x7: { type: Boolean, default: false }
    },
    address: {
        street: String,
        city: String,
        state: String,
        pincode: String,
        country: { type: String, default: 'India' }
    },
    contact: {
        phone: String,
        email: String
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

// Optimize queries by ownership and operational type
branchSchema.index({ partnerId: 1 }, { sparse: true });
branchSchema.index({ ownershipType: 1, isActive: 1 });
branchSchema.index({ type: 1, isActive: 1 });
branchSchema.index({ 'address.city': 1 });

module.exports = mongoose.model('Branch', branchSchema);
