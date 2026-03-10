const mongoose = require('mongoose');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const Rate = require('./models/Rate');

dotenv.config();
connectDB();

const rates = [
    {
        name: "Standard Corporate Rates",
        customerType: "CUSTOMER",
        serviceType: "SURFACE",
        paymentMode: "ALL",
        volumetricDivisor: 4500,
        slabs: [
            { slabName: "0-1 kg", minWeight: 0, maxWeight: 1, rate: 50, rateType: "FIXED" },
            { slabName: "1-5 kg", minWeight: 1, maxWeight: 5, rate: 20, rateType: "PER_KG" },
            { slabName: "5-10 kg", minWeight: 5, maxWeight: 10, rate: 18, rateType: "PER_KG" },
            { slabName: "10-20 kg", minWeight: 10, maxWeight: 20, rate: 15, rateType: "PER_KG" }
        ],
        zones: [
            { fromZone: "DELHI", toZone: "MUMBAI", rate: 120, transitDays: 3 },
            { fromZone: "DELHI", toZone: "BANGALORE", rate: 150, transitDays: 4 },
            { fromZone: "DELHI", toZone: "CHENNAI", rate: 180, transitDays: 5 }
        ],
        fuelSurcharge: { percentage: 5, minAmount: 10, maxAmount: 100 },
        fovCharge: { percentage: 2, minAmount: 20, maxAmount: 500 },
        minCharge: { amount: 30 },
        isActive: true
    },
    {
        name: "Express Air Freight",
        customerType: "AGENT",
        serviceType: "AIR",
        paymentMode: "PREPAID",
        volumetricDivisor: 5000,
        slabs: [
            { slabName: "0-0.5 kg", minWeight: 0, maxWeight: 0.5, rate: 100, rateType: "FIXED" },
            { slabName: "0.5-5 kg", minWeight: 0.5, maxWeight: 5, rate: 40, rateType: "PER_KG" }
        ],
        zones: [
            { fromZone: "DELHI", toZone: "MUMBAI", rate: 200, transitDays: 1 },
            { fromZone: "DELHI", toZone: "BANGALORE", rate: 250, transitDays: 1 }
        ],
        fuelSurcharge: { percentage: 8, minAmount: 15, maxAmount: 150 },
        fovCharge: { percentage: 2.5, minAmount: 25, maxAmount: 1000 },
        minCharge: { amount: 50 },
        isActive: true
    }
];

const seedRates = async () => {
    try {
        await Rate.deleteMany();
        console.log('🗑️  Rates cleared');
        await Rate.insertMany(rates);
        console.log('✅ Rates seeded successfully');
        process.exit();
    } catch (error) {
        console.error(`❌ Error seeding rates: ${error}`);
        process.exit(1);
    }
};

seedRates();
