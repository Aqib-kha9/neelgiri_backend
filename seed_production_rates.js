const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load env vars
dotenv.config({ path: path.join(__dirname, './.env') });

const Rate = require('./models/Rate');
const User = require('./models/User');
const Pincode = require('./models/Pincode');

const seedProductionData = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('📦 Connected to MongoDB for Production-Grade Seeding...');

        // 1. Clear existing rates and specific pincodes
        await Rate.deleteMany({});
        console.log('🗑️  Cleared existing rate rules.');

        const admin = await User.findOne({ role: { $ne: null } });
        const adminId = admin ? admin._id : new mongoose.Types.ObjectId();

        // 2. Seed/Update Pincodes with Geo-Data (Industry Standard)
        const samplePincodes = [
            { 
                pincode: "110001", officeName: "Connaught Place", district: "Delhi", state: "Delhi", zone: "NORTH", 
                isMetro: true, isODA: false, latitude: 28.6289, longitude: 77.2159, isServiceable: true 
            },
            { 
                pincode: "201301", officeName: "Noida Sector 1", district: "Gautam Buddha Nagar", state: "Uttar Pradesh", zone: "NORTH", 
                isMetro: false, isODA: false, latitude: 28.5800, longitude: 77.3000, isServiceable: true 
            },
            { 
                pincode: "226001", officeName: "Lucknow GPO", district: "Lucknow", state: "Uttar Pradesh", zone: "NORTH", 
                isMetro: false, isODA: false, latitude: 26.8467, longitude: 80.9462, isServiceable: true 
            },
            { 
                pincode: "400001", officeName: "Mumbai Fort", district: "Mumbai", state: "Maharashtra", zone: "WEST", 
                isMetro: true, isODA: false, latitude: 18.9217, longitude: 72.8333, isServiceable: true 
            },
            { 
                pincode: "560001", officeName: "Bangalore City", district: "Bangalore", state: "Karnataka", zone: "SOUTH", 
                isMetro: true, isODA: false, latitude: 12.9716, longitude: 77.5946, isServiceable: true 
            },
            { 
                pincode: "791111", officeName: "Itanagar Remote", district: "Papum Pare", state: "Arunachal Pradesh", zone: "EAST", 
                isMetro: false, isODA: true, latitude: 27.0844, longitude: 93.6053, isServiceable: true 
            }
        ];

        for (const p of samplePincodes) {
            await Pincode.findOneAndUpdate({ pincode: p.pincode }, p, { upsert: true });
        }
        console.log('📍 Updated Pincode Master with Geo-Data (Lat/Lng).');

        // 3. Create Industry-Standard Rate Card
        const productionRateCards = [
            {
                name: "E-Commerce Master (Shiprocket Model)",
                customerType: "ALL",
                serviceType: "SURFACE",
                paymentMode: "ALL",
                volumetricDivisor: 5000,
                odaCharge: 150,
                isActive: true,
                validFrom: "2024-01-01",
                validTo: "2026-12-31",
                createdBy: adminId,
                
                // Distance Based Buckets (Priority 1)
                distanceBuckets: [
                    { name: "LOCAL (0-50km)", minDistance: 0, maxDistance: 50, baseWeight: 0.5, baseRate: 35, additionalWeight: 0.5, additionalRate: 15 },
                    { name: "SHORT REGIONAL (50-200km)", minDistance: 50, maxDistance: 200, baseWeight: 0.5, baseRate: 45, additionalWeight: 0.5, additionalRate: 20 },
                    { name: "REGIONAL (200-500km)", minDistance: 200, maxDistance: 500, baseWeight: 0.5, baseRate: 55, additionalWeight: 0.5, additionalRate: 25 },
                    { name: "ZONAL (500-1000km)", minDistance: 500, maxDistance: 1000, baseWeight: 0.5, baseRate: 70, additionalWeight: 0.5, additionalRate: 30 },
                    { name: "NATIONAL (1000km+)", minDistance: 1000, maxDistance: 0, baseWeight: 0.5, baseRate: 90, additionalWeight: 0.5, additionalRate: 40 }
                ],

                // Surcharges
                fuelSurcharge: { percentage: 12, minAmount: 10, maxAmount: 1000, applicableFrom: 0 },
                fovCharge: { percentage: 2, minAmount: 50, maxAmount: 2000 },
                codCharges: { percentage: 2.5, minAmount: 40, fixedCharge: 0 },
                minCharge: { amount: 50, applicableZones: ["ALL"] },
                
                // Fallback Slabs (Priority 3)
                slabs: [
                    { slabName: "Global Bulk (>20kg)", minWeight: 20, maxWeight: 0, rate: 18, rateType: "PER_KG" }
                ],

                restrictions: {
                    minWeight: 0.1,
                    maxWeight: 30,
                    allowedPackaging: ["BOX", "PACKET"],
                    prohibitedItems: ["LIQUIDS", "FLAMMABLES"],
                    specialInstructions: "Standard e-commerce handling."
                },
                
                autoCalculate: { enabled: true, baseOn: "BOTH", rounding: "UP", roundingFactor: 0.5 }
            }
        ];

        await Rate.insertMany(productionRateCards);
        console.log('✅ Successfully seeded Shiprocket-grade Rate Matrix!');
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding error details:');
        console.error(error.message);
        process.exit(1);
    }
};

seedProductionData();
