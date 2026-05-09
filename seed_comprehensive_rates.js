const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load env vars
dotenv.config({ path: path.join(__dirname, './.env') });

const Rate = require('./models/Rate');
const User = require('./models/User');

const seedComprehensiveRates = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('📦 Connected to MongoDB for Professional Seeding...');

        // Clear existing rates
        await Rate.deleteMany({});
        console.log('🗑️  Cleared existing rate rules.');

        // Get an admin user to be the creator
        const admin = await User.findOne({ role: { $ne: null } }); // Just get any user for ID
        const adminId = admin ? admin._id : new mongoose.Types.ObjectId();

        const rates = [
            {
                name: "Standard Retail Rates (Surface)",
                customerType: "CUSTOMER",
                serviceType: "SURFACE",
                paymentMode: "ALL",
                vehicleType: "",
                volumetricDivisor: 5000,
                odaCharge: 150,
                isActive: true,
                validFrom: "2024-01-01",
                validTo: "2026-12-31",
                createdBy: adminId,
                
                // Weight Slabs
                slabs: [
                    { slabName: "Document (0-0.5kg)", minWeight: 0, maxWeight: 0.5, rate: 45, rateType: "FIXED" },
                    { slabName: "Small Parcel (0.5-2kg)", minWeight: 0.5, maxWeight: 2, rate: 80, rateType: "FIXED" },
                    { slabName: "Standard (2-10kg)", minWeight: 2, maxWeight: 10, rate: 35, rateType: "PER_KG" },
                    { slabName: "Bulk (10kg+)", minWeight: 10, maxWeight: 0, rate: 25, rateType: "PER_KG" }
                ],
                
                // Distance Buckets (Professional Standard)
                distanceBuckets: [
                    { name: "LOCAL (0-50km)", minDistance: 0, maxDistance: 50, baseWeight: 0.5, baseRate: 40, additionalWeight: 0.5, additionalRate: 15 },
                    { name: "REGIONAL (50-500km)", minDistance: 50, maxDistance: 500, baseWeight: 0.5, baseRate: 60, additionalWeight: 0.5, additionalRate: 25 },
                    { name: "NATIONAL (500km+)", minDistance: 500, maxDistance: 0, baseWeight: 0.5, baseRate: 100, additionalWeight: 0.5, additionalRate: 45 }
                ],
                
                fuelSurcharge: { percentage: 10, minAmount: 20, maxAmount: 500, applicableFrom: 0 },
                fovCharge: { percentage: 2, minAmount: 50, maxAmount: 2000 },
                codCharges: { percentage: 2, minAmount: 50, fixedCharge: 0 },
                minCharge: { amount: 100, applicableZones: ["ALL"] },
                
                additionalCharges: [
                    { name: "Door Pickup", type: "FIXED", value: 50, description: "Residential pickup charge" },
                    { name: "Handling Fee", type: "PERCENTAGE", value: 5, description: "Fragile handling" }
                ],
                
                restrictions: {
                    minWeight: 0.1,
                    maxWeight: 70,
                    allowedPackaging: ["BOX", "PACKET", "TUBE"],
                    prohibitedItems: ["LIQUIDS", "FLAMMABLES", "BATTERIES"],
                    specialInstructions: "Retail shipments usually processed at counter."
                },
                
                autoCalculate: { enabled: true, baseOn: "BOTH", rounding: "UP", roundingFactor: 0.5 }
            },
            {
                name: "SME Corporate Logistics (Surface)",
                customerType: "VENDOR",
                serviceType: "SURFACE",
                paymentMode: "CREDIT",
                vehicleType: "Tata Ace",
                volumetricDivisor: 6000,
                odaCharge: 100,
                isActive: true,
                validFrom: "2024-01-01",
                validTo: "2026-12-31",
                createdBy: adminId,
                
                slabs: [
                    { slabName: "Base Slab (0-20kg)", minWeight: 0, maxWeight: 20, rate: 450, rateType: "FIXED" },
                    { slabName: "Regular (20-100kg)", minWeight: 20, maxWeight: 100, rate: 18, rateType: "PER_KG" },
                    { slabName: "Volume (100kg+)", minWeight: 100, maxWeight: 0, rate: 12, rateType: "PER_KG" }
                ],
                
                distanceBuckets: [
                    { name: "INTRACITY", minDistance: 0, maxDistance: 50, baseWeight: 1, baseRate: 150, additionalWeight: 1, additionalRate: 20 },
                    { name: "INTERCITY (ZONAL)", minDistance: 50, maxDistance: 1000, baseWeight: 1, baseRate: 350, additionalWeight: 1, additionalRate: 35 }
                ],
                
                fuelSurcharge: { percentage: 15, minAmount: 100, maxAmount: 5000, applicableFrom: 5 },
                fovCharge: { percentage: 1.5, minAmount: 100, maxAmount: 10000 },
                codCharges: { percentage: 1, minAmount: 100, fixedCharge: 50 },
                minCharge: { amount: 500, applicableZones: ["SOUTH", "EAST"] }, // Regional min charges
                
                additionalCharges: [
                    { name: "Appointment Delivery", type: "FIXED", value: 250, description: "Commercial appointment required" },
                    { name: "Loading/Unloading", type: "FIXED", value: 500, description: "Manual labor charge" }
                ],
                
                restrictions: {
                    minWeight: 5,
                    maxWeight: 500,
                    allowedPackaging: ["PALLET", "CRATE", "WOODEN_BOX"],
                    prohibitedItems: ["CORROSIVES", "BIOHAZARDS"],
                    specialInstructions: "Check for GST invoice before pickup."
                },
                
                autoCalculate: { enabled: true, baseOn: "WEIGHT", rounding: "UP", roundingFactor: 1 }
            },
            {
                name: "Priority Express (Air)",
                customerType: "ALL",
                serviceType: "AIR",
                paymentMode: "ALL",
                vehicleType: "",
                volumetricDivisor: 4500, // Strict air density
                odaCharge: 300,
                isActive: true,
                validFrom: "2024-01-01",
                validTo: "2026-12-31",
                createdBy: adminId,
                
                slabs: [
                    { slabName: "Priority Doc (0-1kg)", minWeight: 0, maxWeight: 1, rate: 250, rateType: "FIXED" },
                    { slabName: "Express Heavy (1kg+)", minWeight: 1, maxWeight: 0, rate: 180, rateType: "PER_KG" }
                ],
                
                distanceBuckets: [
                    { name: "DOMESTIC EXPRESS", minDistance: 0, maxDistance: 5000, baseWeight: 0.5, baseRate: 250, additionalWeight: 0.5, additionalRate: 150 }
                ],
                
                fuelSurcharge: { percentage: 25, minAmount: 50, maxAmount: 2000, applicableFrom: 0 },
                fovCharge: { percentage: 5, minAmount: 200, maxAmount: 5000 },
                codCharges: { percentage: 5, minAmount: 200, fixedCharge: 100 },
                minCharge: { amount: 250, applicableZones: ["ALL"] },
                
                additionalCharges: [
                    { name: "Next Flight Out", type: "FIXED", value: 1000, description: "NFO Priority" },
                    { name: "Holiday Delivery", type: "PERCENTAGE", value: 50, description: "Urgent processing" }
                ],
                
                restrictions: {
                    minWeight: 0.1,
                    maxWeight: 32, // Airline limit per piece
                    allowedPackaging: ["ENVELOPE", "BOX"],
                    prohibitedItems: ["ELECTRONICS_WITH_BATTERIES", "POWDERS"],
                    specialInstructions: "Airway Bill mandatory for all pieces."
                },
                
                autoCalculate: { enabled: true, baseOn: "BOTH", rounding: "NEAR", roundingFactor: 0.1 }
            },
            {
                name: "E-Commerce fulfillment (B2C)",
                customerType: "CUSTOMER",
                serviceType: "SURFACE",
                paymentMode: "ALL",
                vehicleType: "Bike",
                volumetricDivisor: 5000,
                odaCharge: 50,
                isActive: true,
                validFrom: "2024-01-01",
                validTo: "2026-12-31",
                createdBy: adminId,
                
                slabs: [
                    { slabName: "Last Mile Pack (0-2kg)", minWeight: 0, maxWeight: 2, rate: 55, rateType: "FIXED" },
                    { slabName: "Heavy Basket (2-5kg)", minWeight: 2, maxWeight: 5, rate: 15, rateType: "PER_KG" }
                ],
                
                distanceBuckets: [
                    { name: "METRO-to-METRO", minDistance: 0, maxDistance: 2000, baseWeight: 0.25, baseRate: 35, additionalWeight: 0.25, additionalRate: 10 }
                ],
                
                fuelSurcharge: { percentage: 5, minAmount: 5, maxAmount: 50, applicableFrom: 0 },
                fovCharge: { percentage: 1, minAmount: 10, maxAmount: 100 },
                codCharges: { percentage: 2, minAmount: 25, fixedCharge: 15 },
                minCharge: { amount: 45, applicableZones: ["ALL"] },
                
                additionalCharges: [
                    { name: "Cash Collection", type: "FIXED", value: 10, description: "Payment processing" },
                    { name: "Return Service", type: "PERCENTAGE", value: 40, description: "RTO Processing fee" }
                ],
                
                restrictions: {
                    minWeight: 0.01,
                    maxWeight: 15,
                    allowedPackaging: ["POLY_BAG", "BOX", "BUBBLE_WRAP"],
                    prohibitedItems: ["JEWELLERY", "CURRENCY"],
                    specialInstructions: "OTP verification required on delivery."
                },
                
                autoCalculate: { enabled: true, baseOn: "BOTH", rounding: "UP", roundingFactor: 0.01 }
            },
            {
                name: "Heavy Industrial Haulage",
                customerType: "VENDOR",
                serviceType: "ALL",
                paymentMode: "CREDIT",
                vehicleType: "14FT Truck",
                volumetricDivisor: 8000, // Freight specific
                odaCharge: 500,
                isActive: true,
                validFrom: "2024-01-01",
                validTo: "2026-12-31",
                createdBy: adminId,
                
                slabs: [
                    { slabName: "Half Truck (0-5000kg)", minWeight: 0, maxWeight: 5000, rate: 15000, rateType: "FIXED" },
                    { slabName: "Full Load (5000kg+)", minWeight: 5000, maxWeight: 0, rate: 8, rateType: "PER_KG" }
                ],
                
                distanceBuckets: [
                    { name: "HEAVY HAULAGE", minDistance: 0, maxDistance: 0, baseWeight: 1000, baseRate: 15000, additionalWeight: 1000, additionalRate: 5000 }
                ],
                
                fuelSurcharge: { percentage: 18, minAmount: 1000, maxAmount: 50000, applicableFrom: 500 },
                fovCharge: { percentage: 0.5, minAmount: 500, maxAmount: 50000 },
                codCharges: { percentage: 0, minAmount: 0, fixedCharge: 0 },
                minCharge: { amount: 15000, applicableZones: ["ALL"] },
                
                additionalCharges: [
                    { name: "Checkpost Duty", type: "FIXED", value: 2500, description: "Interstate tax processing" },
                    { name: "Escort Service", type: "FIXED", value: 5000, description: "Security for high-value" }
                ],
                
                restrictions: {
                    minWeight: 1000,
                    maxWeight: 15000,
                    allowedPackaging: ["CONTAINER", "IRON_FRAME"],
                    prohibitedItems: ["AMMUNITION", "STOLEN_GOODS"],
                    specialInstructions: "Requires specialized loading crane."
                },
                
                autoCalculate: { enabled: true, baseOn: "WEIGHT", rounding: "UP", roundingFactor: 100 }
            }
        ];

        await Rate.insertMany(rates);
        console.log('✅ Successfully seeded 5 comprehensive professional rate rules!');
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding error details:');
        console.error(error.message);
        if (error.errors) {
            Object.keys(error.errors).forEach(key => {
                console.error(`Field ${key}: ${error.errors[key].message}`);
            });
        }
        process.exit(1);
    }
};

seedComprehensiveRates();
