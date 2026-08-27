const mongoose = require('mongoose');

const warehouseSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    type: {
        type: String,
        enum: ['HUB', 'FULFILLMENT', 'TRANSIT', 'CROSS_DOCK', 'STORAGE', 'RETURN_CENTER'],
        default: 'HUB',
        index: true
    },

    address: {
        line1: { type: String, trim: true },
        line2: { type: String, trim: true },
        city: { type: String, trim: true },
        state: { type: String, trim: true },
        pincode: { type: String, trim: true },
        country: { type: String, default: 'India', trim: true }
    },

    // Capacity
    totalArea: { type: Number, default: 0 }, // sq ft
    usedArea: { type: Number, default: 0 },
    capacityUtilization: { type: Number, default: 0 }, // percentage

    // Contact
    contactPerson: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },

    // Operating hours
    operatingHours: {
        open: { type: String, default: '09:00' },
        close: { type: String, default: '18:00' },
        daysOfWeek: [{ type: Number, min: 0, max: 6 }] // 0=Sunday
    },

    // Facilities
    facilities: {
        hasColdStorage: { type: Boolean, default: false },
        hasHazardousStorage: { type: Boolean, default: false },
        hasCCTV: { type: Boolean, default: true },
        hasFireSafety: { type: Boolean, default: true },
        hasLoadingDock: { type: Boolean, default: true },
        hasWeighbridge: { type: Boolean, default: false }
    },

    status: {
        type: String,
        enum: ['ACTIVE', 'INACTIVE', 'MAINTENANCE'],
        default: 'ACTIVE',
        index: true
    },

    // Hierarchy / RBAC
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Warehouse', warehouseSchema);
