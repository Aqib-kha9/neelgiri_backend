const mongoose = require('mongoose');

const slabSchema = new mongoose.Schema({
    slabName: String,
    minWeight: { type: Number, default: 0 },
    maxWeight: { type: Number, required: true },
    rate: { type: Number, required: true },
    rateType: { type: String, enum: ['FIXED', 'PER_KG'], default: 'PER_KG' }
});

const zoneRateSchema = new mongoose.Schema({
    fromZone: String,
    toZone: String,
    rate: Number,
    transitDays: Number,
    isActive: { type: Boolean, default: true }
});

const rateSchema = new mongoose.Schema({
    name: { type: String, required: true },
    customerType: { type: String, enum: ['CUSTOMER', 'AGENT', 'VENDOR', 'ALL'], default: 'ALL' },
    serviceType: { type: String, enum: ['SURFACE', 'AIR', 'EXPRESS', 'ALL'], default: 'SURFACE' },
    paymentMode: { type: String, enum: ['PREPAID', 'COD', 'CREDIT', 'ALL'], default: 'ALL' },
    volumetricDivisor: { type: Number, default: 5000 },
    odaCharge: { type: Number, default: 0 },
    
    slabs: [slabSchema],
    zones: [zoneRateSchema],
    
    fuelSurcharge: {
        percentage: { type: Number, default: 0 },
        minAmount: { type: Number, default: 0 },
        maxAmount: { type: Number, default: 0 }
    },
    
    fovCharge: {
        percentage: { type: Number, default: 0 },
        minAmount: { type: Number, default: 0 },
        maxAmount: { type: Number, default: 0 }
    },
    
    minCharge: {
        amount: { type: Number, default: 0 }
    },
    
    validFrom: Date,
    validTo: Date,
    isActive: { type: Boolean, default: true },
    
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, { timestamps: true });

module.exports = mongoose.model('Rate', rateSchema);
