const mongoose = require('mongoose');

const vendorServiceSchema = new mongoose.Schema({
    serviceType: {
        type: String,
        enum: ['TRANSPORT', 'WAREHOUSING', 'PACKAGING', 'LAST_MILE', 'FIRST_MILE', 'CUSTOM_CLEARANCE', 'INSURANCE', 'OTHER'],
        required: true
    },
    serviceName: { type: String, trim: true },
    rate: { type: Number, default: 0 },
    rateUnit: { type: String, enum: ['PER_KG', 'PER_SHIPMENT', 'PER_KM', 'PER_DAY', 'PERCENTAGE', 'FIXED'], default: 'PER_SHIPMENT' },
    coverageAreas: [{ type: String, trim: true }]
}, { _id: false });

const vendorSchema = new mongoose.Schema({
    vendorCode: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },

    // Business details
    companyName: { type: String, required: true, trim: true },
    vendorType: {
        type: String,
        enum: ['TRANSPORTER', 'WAREHOUSE', '3PL', 'PACKAGING', 'TECHNOLOGY', 'OTHER'],
        default: 'TRANSPORTER',
        index: true
    },
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

    // Services offered
    services: [vendorServiceSchema],

    // Agreement
    agreementNo: { type: String, trim: true },
    agreementStartDate: { type: Date },
    agreementEndDate: { type: Date },
    agreementDocument: { type: String },

    // Banking
    bankDetails: {
        bankName: { type: String, trim: true },
        accountName: { type: String, trim: true },
        accountNumber: { type: String, trim: true },
        ifsc: { type: String, trim: true, uppercase: true },
        branch: { type: String, trim: true }
    },

    // Performance metrics
    metrics: {
        totalShipments: { type: Number, default: 0 },
        onTimeDeliveryRate: { type: Number, default: 0 },
        totalBilled: { type: Number, default: 0 },
        totalPaid: { type: Number, default: 0 },
        rating: { type: Number, default: 0 }
    },

    // Documents
    documents: [{
        name: { type: String, trim: true },
        url: { type: String },
        uploadedAt: { type: Date, default: Date.now }
    }],

    status: {
        type: String,
        enum: ['ACTIVE', 'SUSPENDED', 'TERMINATED', 'PENDING'],
        default: 'PENDING',
        index: true
    },

    // Hierarchy / RBAC
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Vendor', vendorSchema);
