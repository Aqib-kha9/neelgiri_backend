const mongoose = require('mongoose');

const partnerCommissionSchema = new mongoose.Schema({
    type: { type: String, enum: ['PERCENTAGE', 'FIXED', 'SLAB'], default: 'PERCENTAGE' },
    rate: { type: Number, default: 0 }, // percentage or fixed amount
    slabs: [{
        minVolume: { type: Number, default: 0 },
        maxVolume: { type: Number },
        rate: { type: Number, default: 0 }
    }],
    effectiveFrom: { type: Date, default: Date.now },
    effectiveTill: { type: Date }
}, { _id: false });

const partnerSchema = new mongoose.Schema({
    partnerCode: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Business details
    companyName: { type: String, required: true, trim: true },
    contactPerson: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    gstin: { type: String, trim: true, uppercase: true },
    pan: { type: String, trim: true, uppercase: true },

    address: {
        line1: { type: String, trim: true },
        line2: { type: String, trim: true },
        city: { type: String, trim: true },
        state: { type: String, trim: true },
        pincode: { type: String, trim: true },
        country: { type: String, default: 'India', trim: true }
    },

    // Agreement
    agreementNo: { type: String, trim: true },
    agreementStartDate: { type: Date },
    agreementEndDate: { type: Date },
    agreementDocument: { type: String }, // file URL

    // Commission / revenue share
    commission: partnerCommissionSchema,

    // Banking
    bankDetails: {
        bankName: { type: String, trim: true },
        accountName: { type: String, trim: true },
        accountNumber: { type: String, trim: true },
        ifsc: { type: String, trim: true, uppercase: true },
        branch: { type: String, trim: true }
    },

    // Performance metrics (computed)
    metrics: {
        totalShipments: { type: Number, default: 0 },
        deliveredShipments: { type: Number, default: 0 },
        totalRevenue: { type: Number, default: 0 },
        totalCommission: { type: Number, default: 0 },
        rating: { type: Number, default: 0 }
    },

    status: {
        type: String,
        enum: ['ACTIVE', 'SUSPENDED', 'TERMINATED', 'PENDING'],
        default: 'PENDING',
        index: true
    },

    // Hierarchy / RBAC
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Partner', partnerSchema);
