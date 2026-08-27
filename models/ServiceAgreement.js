const mongoose = require('mongoose');

const serviceItemSchema = new mongoose.Schema({
    serviceName: { type: String, required: true },
    serviceType: { type: String, enum: ['SURFACE', 'AIR', 'EXPRESS', 'BOTH', 'ALL'], default: 'ALL' },
    rate: { type: Number, default: 0 },
    rateType: { type: String, enum: ['PER_KG', 'PER_SHIPMENT', 'PER_KM', 'FIXED', 'SLAB'], default: 'PER_KG' },
    minCharge: { type: Number, default: 0 },
    description: String
}, { _id: true });

const serviceAgreementSchema = new mongoose.Schema({
    agreementNo: { type: String, required: true, unique: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true },

    agreementType: {
        type: String,
        enum: ['Standard', 'Premium', 'Enterprise', 'Custom'],
        default: 'Standard'
    },

    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    autoRenew: { type: Boolean, default: false },
    renewalPeriodMonths: { type: Number, default: 12 },

    billing: {
        billingCycle: { type: String, enum: ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'], default: 'MONTHLY' },
        paymentTerms: { type: String, default: 'Net 30' },
        creditLimit: { type: Number, default: 0 },
        creditDays: { type: Number, default: 30 }
    },

    volume: {
        monthlyVolume: { type: Number, default: 0 },
        minMonthlyVolume: { type: Number, default: 0 },
        maxMonthlyVolume: { type: Number, default: 0 }
    },

    pricing: {
        ratePerDelivery: { type: Number, default: 0 },
        ratePerKg: { type: Number, default: 0 },
        discountPercentage: { type: Number, default: 0 },
        fuelSurchargeApplicable: { type: Boolean, default: true },
        codChargesApplicable: { type: Boolean, default: true }
    },

    serviceItems: [serviceItemSchema],

    specialTerms: { type: String, default: '' },
    termsAndConditions: { type: String, default: '' },

    documents: [{
        name: String,
        url: String,
        uploadedAt: { type: Date, default: Date.now }
    }],

    status: {
        type: String,
        enum: ['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED', 'SUSPENDED', 'PENDING_APPROVAL'],
        default: 'DRAFT'
    },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    terminatedAt: Date,
    terminationReason: String,

    metrics: {
        totalShipments: { type: Number, default: 0 },
        totalRevenue: { type: Number, default: 0 },
        lastBillingDate: Date
    },

    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted: { type: Boolean, default: false }
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

serviceAgreementSchema.virtual('isActive').get(function () {
    if (this.status !== 'ACTIVE') return false;
    const now = new Date();
    return now >= this.startDate && now <= this.endDate;
});

serviceAgreementSchema.virtual('daysToExpiry').get(function () {
    if (!this.endDate) return null;
    const diff = new Date(this.endDate).getTime() - Date.now();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
});

module.exports = mongoose.model('ServiceAgreement', serviceAgreementSchema);
