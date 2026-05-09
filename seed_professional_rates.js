const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load env
dotenv.config();

// Define Model directly to avoid import issues in seed script
const RateSchema = new mongoose.Schema({
    name: { type: String, required: true },
    customerType: { type: String, enum: ['ALL', 'CUSTOMER', 'AGENT', 'VENDOR'], default: 'ALL' },
    serviceType: { type: String, enum: ['ALL', 'SURFACE', 'AIR', 'EXPRESS'], default: 'SURFACE' },
    paymentMode: { type: String, enum: ['ALL', 'PREPAID', 'COD', 'CREDIT'], default: 'ALL' },
    slabs: [{
        slabName: String,
        minWeight: Number,
        maxWeight: Number,
        rate: Number,
        rateType: { type: String, enum: ['FIXED', 'PER_KG', 'SLAB'], default: 'PER_KG' }
    }],
    zones: [{
        fromZone: String,
        toZone: String,
        rate: Number,
        transitDays: Number,
        isActive: { type: Boolean, default: true }
    }],
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
    volumetricDivisor: { type: Number, default: 5000 },
    odaCharge: { type: Number, default: 0 },
    validFrom: { type: Date, default: Date.now },
    validTo: { type: Date, default: () => new Date(+new Date() + 365*24*60*60*1000) },
    isActive: { type: Boolean, default: true }
}, { timestamps: true });

const Rate = mongoose.models.Rate || mongoose.model('Rate', RateSchema);

const rates = [
    {
        name: "Retail/Walking Customer (Standard)",
        customerType: "ALL",
        serviceType: "SURFACE",
        paymentMode: "ALL",
        volumetricDivisor: 4500,
        slabs: [
            { slabName: "Up to 0.5kg", minWeight: 0, maxWeight: 0.5, rate: 150, rateType: "FIXED" },
            { slabName: "0.5kg - 5kg", minWeight: 0.5, maxWeight: 5, rate: 100, rateType: "PER_KG" },
            { slabName: "Above 5kg", minWeight: 5, maxWeight: 1000, rate: 80, rateType: "PER_KG" }
        ],
        zones: [
            { fromZone: "NORTH", toZone: "NORTH", rate: 50, transitDays: 2 },
            { fromZone: "NORTH", toZone: "SOUTH", rate: 150, transitDays: 4 },
            { fromZone: "NORTH", toZone: "EAST", rate: 130, transitDays: 4 },
            { fromZone: "NORTH", toZone: "WEST", rate: 120, transitDays: 3 }
        ],
        fuelSurcharge: { percentage: 20, minAmount: 10, maxAmount: 500 },
        fovCharge: { percentage: 2, minAmount: 25, maxAmount: 2000 },
        minCharge: { amount: 150 },
        odaCharge: 750,
        isActive: true
    },
    {
        name: "SME Corporate (Silver)",
        customerType: "CUSTOMER",
        serviceType: "SURFACE",
        paymentMode: "CREDIT",
        volumetricDivisor: 5000,
        slabs: [
            { slabName: "Base (0-2kg)", minWeight: 0, maxWeight: 2, rate: 80, rateType: "FIXED" },
            { slabName: "Standard (2-20kg)", minWeight: 2, maxWeight: 20, rate: 30, rateType: "PER_KG" },
            { slabName: "Bulk (>20kg)", minWeight: 20, maxWeight: 5000, rate: 15, rateType: "PER_KG" }
        ],
        zones: [
            { fromZone: "NORTH", toZone: "NORTH", rate: 20, transitDays: 2 },
            { fromZone: "NORTH", toZone: "SOUTH", rate: 60, transitDays: 4 },
            { fromZone: "NORTH", toZone: "EAST", rate: 55, transitDays: 4 },
            { fromZone: "NORTH", toZone: "WEST", rate: 45, transitDays: 3 }
        ],
        fuelSurcharge: { percentage: 12, minAmount: 0, maxAmount: 0 },
        fovCharge: { percentage: 1, minAmount: 15, maxAmount: 1000 },
        minCharge: { amount: 80 },
        odaCharge: 450,
        isActive: true
    },
    {
        name: "Premium Enterprise (Gold)",
        customerType: "CUSTOMER",
        serviceType: "SURFACE",
        paymentMode: "CREDIT",
        volumetricDivisor: 6000,
        slabs: [
            { slabName: "Flat Rate (0-5kg)", minWeight: 0, maxWeight: 5, rate: 40, rateType: "FIXED" },
            { slabName: "Incremental (5-50kg)", minWeight: 5, maxWeight: 50, rate: 12, rateType: "PER_KG" },
            { slabName: "Heavy (>50kg)", minWeight: 50, maxWeight: 10000, rate: 8, rateType: "PER_KG" }
        ],
        zones: [
            { fromZone: "NORTH", toZone: "NORTH", rate: 10, transitDays: 1 },
            { fromZone: "NORTH", toZone: "SOUTH", rate: 35, transitDays: 3 },
            { fromZone: "NORTH", toZone: "EAST", rate: 30, transitDays: 3 },
            { fromZone: "NORTH", toZone: "WEST", rate: 25, transitDays: 2 }
        ],
        fuelSurcharge: { percentage: 5, minAmount: 0, maxAmount: 0 },
        fovCharge: { percentage: 0.5, minAmount: 10, maxAmount: 500 },
        minCharge: { amount: 40 },
        odaCharge: 250,
        isActive: true
    },
    {
        name: "Priority Air Express",
        customerType: "ALL",
        serviceType: "EXPRESS",
        paymentMode: "ALL",
        volumetricDivisor: 5000,
        slabs: [
            { slabName: "Air Base (0.5kg)", minWeight: 0, maxWeight: 0.5, rate: 350, rateType: "FIXED" },
            { slabName: "Air Per Kg (0.5-10kg)", minWeight: 0.5, maxWeight: 10, rate: 180, rateType: "PER_KG" },
            { slabName: "Air Bulk (>10kg)", minWeight: 10, maxWeight: 1000, rate: 120, rateType: "PER_KG" }
        ],
        zones: [
            { fromZone: "NORTH", toZone: "NORTH", rate: 100, transitDays: 1 },
            { fromZone: "NORTH", toZone: "SOUTH", rate: 250, transitDays: 1 },
            { fromZone: "NORTH", toZone: "EAST", rate: 240, transitDays: 1 },
            { fromZone: "NORTH", toZone: "WEST", rate: 220, transitDays: 1 }
        ],
        fuelSurcharge: { percentage: 25, minAmount: 50, maxAmount: 1000 },
        fovCharge: { percentage: 3, minAmount: 50, maxAmount: 5000 },
        minCharge: { amount: 350 },
        odaCharge: 1200,
        isActive: true
    },
    {
        name: "E-commerce B2C Specialist",
        customerType: "VENDOR",
        serviceType: "SURFACE",
        paymentMode: "COD",
        volumetricDivisor: 4500,
        slabs: [
            { slabName: "First 500g", minWeight: 0, maxWeight: 0.5, rate: 35, rateType: "FIXED" },
            { slabName: "Addl 500g", minWeight: 0.5, maxWeight: 5, rate: 28, rateType: "PER_KG" },
            { slabName: "Heavier Slabs", minWeight: 5, maxWeight: 50, rate: 22, rateType: "PER_KG" }
        ],
        zones: [
            { fromZone: "NORTH", toZone: "NORTH", rate: 15, transitDays: 2 },
            { fromZone: "NORTH", toZone: "SOUTH", rate: 45, transitDays: 3 },
            { fromZone: "NORTH", toZone: "EAST", rate: 40, transitDays: 3 },
            { fromZone: "NORTH", toZone: "WEST", rate: 35, transitDays: 2 }
        ],
        fuelSurcharge: { percentage: 10, minAmount: 5, maxAmount: 100 },
        fovCharge: { percentage: 1, minAmount: 10, maxAmount: 1000 },
        codCharges: { percentage: 2, minAmount: 40, fixedCharge: 50 },
        minCharge: { amount: 35 },
        odaCharge: 500,
        isActive: true
    }
];

const seedRates = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB');
        
        await Rate.deleteMany();
        console.log('🗑️  Old Rates cleared');
        
        await Rate.insertMany(rates);
        console.log('✅ 5 Professional Rate Cards seeded successfully');
        
        await mongoose.disconnect();
        process.exit();
    } catch (error) {
        console.error(`❌ Error seeding rates: ${error}`);
        process.exit(1);
    }
};

seedRates();
