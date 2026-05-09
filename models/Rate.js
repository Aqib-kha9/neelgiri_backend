const mongoose = require('mongoose');

const slabSchema = new mongoose.Schema({
    slabName: String,
    minWeight: { type: Number, default: 0 },
    maxWeight: { type: Number, required: true },
    rate: { type: Number, required: true },
    rateType: { type: String, enum: ['FIXED', 'PER_KG'], default: 'PER_KG' }
}, { toJSON: { virtuals: true }, toObject: { virtuals: true } });



const rateSchema = new mongoose.Schema({
    name: { type: String, required: true },
    customerType: { type: String, enum: ['CUSTOMER', 'AGENT', 'VENDOR', 'ALL'], default: 'ALL' },
    serviceType: { type: String, enum: ['SURFACE', 'AIR', 'EXPRESS', 'ALL'], default: 'SURFACE' },
    paymentMode: { type: String, enum: ['PREPAID', 'COD', 'CREDIT', 'ALL'], default: 'ALL' },
    volumetricDivisor: { type: Number, default: 5000 },
    vehicleType: { type: String, default: '' },
    odaCharge: { type: Number, default: 0 },
    
    slabs: [slabSchema],
    
    fuelSurcharge: {
        percentage: { type: Number, default: 0 },
        minAmount: { type: Number, default: 0 },
        maxAmount: { type: Number, default: 0 },
        applicableFrom: { type: Number, default: 0 }
    },
    
    fovCharge: {
        percentage: { type: Number, default: 0 },
        minAmount: { type: Number, default: 0 },
        maxAmount: { type: Number, default: 0 }
    },
    
    codCharges: {
        percentage: { type: Number, default: 0 },
        minAmount: { type: Number, default: 0 },
        fixedCharge: { type: Number, default: 0 }
    },
    
    minCharge: {
        amount: { type: Number, default: 0 },
        applicableZones: [String]
    },

    additionalCharges: [{
        name: String,
        type: { type: String, enum: ['PERCENTAGE', 'FIXED'] },
        value: Number,
        description: String
    }],

    restrictions: {
        minWeight: { type: Number, default: 0 },
        maxWeight: { type: Number, default: 0 },
        allowedPackaging: [String],
        prohibitedItems: [String],
        specialInstructions: String
    },

    autoCalculate: {
        enabled: { type: Boolean, default: true },
        baseOn: { type: String, default: 'WEIGHT' },
        rounding: { type: String, default: 'UP' },
        roundingFactor: { type: Number, default: 0.5 }
    },

    // Production-Grade Distance Based Pricing
    distanceBuckets: [{
        name: String, // e.g., 'LOCAL', 'REGIONAL', 'NATIONAL'
        minDistance: Number,
        maxDistance: Number,
        baseWeight: { type: Number, default: 0.5 }, // e.g., first 500g
        baseRate: Number,
        additionalWeight: { type: Number, default: 0.5 }, // e.g., next 500g
        additionalRate: Number
    }],
    
    validFrom: Date,
    validTo: Date,
    isActive: { type: Boolean, default: true },
    
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

module.exports = mongoose.model('Rate', rateSchema);
