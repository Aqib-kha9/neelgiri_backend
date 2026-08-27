const mongoose = require('mongoose');

const serviceabilitySchema = new mongoose.Schema({
    autoMapAddressPincode: { type: Boolean, default: false },
    defaultTransitDays: { type: Number, default: 3, min: 1, max: 30 }
}, { _id: false });

const locationSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, index: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: {
        type: String,
        enum: ['HUB', 'BRANCH', 'WAREHOUSE', 'TRANSIT_HUB', 'CROSS_DOCK', 'DELIVERY_CENTER', 'PICKUP_POINT'],
        default: 'HUB'
    },
    category: { type: String, enum: ['PRIMARY', 'SECONDARY', 'TERTIARY'], default: 'PRIMARY' },
    ownershipType: { type: String, enum: ['COCO', 'FOFO', 'PARTNER'], default: 'COCO' },
    gstin: { type: String, uppercase: true, trim: true },
    manager: { type: String, trim: true },

    address: {
        line1: { type: String, trim: true },
        line2: { type: String, trim: true },
        city: { type: String, trim: true },
        district: { type: String, trim: true },
        state: { type: String, trim: true },
        pincode: { type: String, trim: true },
        country: { type: String, default: 'India' }
    },
    coordinates: {
        latitude: { type: Number, min: -90, max: 90 },
        longitude: { type: Number, min: -180, max: 180 }
    },

    contact: {
        personName: { type: String, trim: true },
        phone: { type: String, trim: true },
        email: { type: String, lowercase: true, trim: true }
    },

    capacity: {
        maxShipments: { type: Number, default: 0, min: 0 },
        maxWeightKg: { type: Number, default: 0, min: 0 },
        storageAreaSqFt: { type: Number, default: 0, min: 0 },
        vehicleBays: { type: Number, default: 0, min: 0 }
    },

    facilities: {
        hasColdStorage: { type: Boolean, default: false },
        hasCCTV: { type: Boolean, default: false },
        hasFireSafety: { type: Boolean, default: false },
        hasLoadingDock: { type: Boolean, default: false },
        hasWeighbridge: { type: Boolean, default: false },
        hasBackupPower: { type: Boolean, default: false },
        hasSecurityStaff: { type: Boolean, default: false },
        is24x7: { type: Boolean, default: false }
    },
    services: [{ type: String, trim: true }],
    securityLevel: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM' },
    audit: {
        lastAuditDate: Date,
        nextAuditDate: Date
    },

    operatingHours: {
        openTime: { type: String, default: '09:00' },
        closeTime: { type: String, default: '18:00' },
        workingDays: [{ type: String, enum: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] }]
    },

    connectedRoutes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Route' }],
    parentLocation: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
    serviceability: { type: serviceabilitySchema, default: () => ({}) },

    status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'UNDER_MAINTENANCE'], default: 'ACTIVE' },

    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted: { type: Boolean, default: false }
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

locationSchema.index({ 'address.city': 1, 'address.state': 1 });
locationSchema.index({ 'address.pincode': 1 });

module.exports = mongoose.model('Location', locationSchema);
