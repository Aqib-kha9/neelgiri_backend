const mongoose = require('mongoose');

const driverSchema = new mongoose.Schema({
    code: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true
    },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    licenseNo: { type: String, required: true, trim: true },
    licenseExpiry: { type: Date },
    aadharNo: { type: String, trim: true },
    panCard: { type: String, trim: true },

    status: {
        type: String,
        enum: ['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'SUSPENDED'],
        default: 'ACTIVE',
        index: true
    },
    verificationStatus: {
        type: String,
        enum: ['VERIFIED', 'PENDING', 'REJECTED'],
        default: 'PENDING'
    },

    // Assignment
    currentVehicleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Vehicle',
        default: null
    },
    hubId: { type: String }, // Home base branch id (string for parity with DRS.branchId)

    // Personal
    rating: { type: Number, default: 5, min: 0, max: 5 },
    dateOfJoining: { type: Date },
    fatherName: { type: String },
    address: { type: String },
    bloodGroup: { type: String },

    emergencyContact: {
        name: { type: String },
        phone: { type: String },
        relation: { type: String }
    },
    bankDetails: {
        accountNo: { type: String },
        ifscCode: { type: String },
        bankName: { type: String }
    },

    // Documents (uploaded file urls)
    documents: [{
        type: { type: String, enum: ['license', 'aadhar', 'pan', 'photo', 'police_verification', 'other'] },
        url: String,
        uploadedAt: { type: Date, default: Date.now }
    }],

    // Hierarchy / RBAC
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

driverSchema.index({ partnerId: 1, status: 1 });
driverSchema.index({ name: 'text', phone: 'text', code: 'text' });

module.exports = mongoose.model('Driver', driverSchema);
