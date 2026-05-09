const mongoose = require('mongoose');

const receiverSchema = new mongoose.Schema({
    id: String, // Could be UUID or shortid
    name: String,
    address: String,
    address2: String,
    landmark: String,
    city: String,
    state: String,
    pincode: String,
    mobileNo: String,
    email: String
});

const pickupLocationSchema = new mongoose.Schema({
    id: String,
    name: String,
    address: String,
    address2: String,
    landmark: String,
    city: String,
    state: String,
    pincode: String,
    contactPerson: String,
    mobileNo: String,
    email: String
});

const customerSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    contactPerson: String,
    address1: String,
    address2: String,
    city: String,
    station: String,
    pincode: String,
    gstin: String,
    mobileNo: String,
    phoneO: String,
    phoneR: String,
    email: { type: String, required: true, lowercase: true, trim: true },
    
    // Complex fields
    hasReceiver: { type: Boolean, default: false },
    receivers: [receiverSchema],
    usePickupLocation: { type: Boolean, default: false },
    pickupLocations: [pickupLocationSchema],

    // Configuration
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    fuelCharges: { type: Number, default: 0 },
    fovCharges: { type: Number, default: 0 },
    quotationType: String,
    awt: { type: Number, default: 0 },
    category: String,
    paymentMode: String,
    accountGroup: String,
    isInterStateDealer: { type: Boolean, default: false },
    documentNo: String,
    bookedBy: String,
    bookedDate: Date,
    remark: String,
    billingType: String,
    creditDays: Number,
    defaultPaymentMode: String,
    kycStatus: String,
    kycDocumentType: String,
    kycDocumentNumber: String,
    creditLimit: Number,
    paymentTerms: String,
    contractId: String,
    customerType: { type: String, enum: ['REGULAR', 'GUEST'], default: 'REGULAR' },
    registrationSource: { type: String, enum: ['ADMIN', 'WEBSITE'], default: 'ADMIN' },
    rateCard: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Rate'
    },

    // Portal setup
    portalAccess: { type: Boolean, default: false },
    portalEmail: String,
    allowedServices: [String],
    serviceableZones: [String],
    apiAccess: { type: Boolean, default: false },
    apiKey: String,
    webhookUrl: String,

    // Hierarchy / RBAC Links
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    partnerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    branchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch'
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User' // Linked portal user account if portalAccess is true
    }
}, {
    timestamps: true
});

const Customer = mongoose.model('Customer', customerSchema);
module.exports = Customer;
