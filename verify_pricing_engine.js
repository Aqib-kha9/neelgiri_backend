const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const { calculateFreight } = require('./utils/pricingCalculator');

dotenv.config({ path: path.join(__dirname, './.env') });

const verifyPricing = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const rateCardId = "69b0a2b11ea40115535d87e0"; // From previous step

        const scenarios = [
            { 
                label: "SCENARIO 1: LOCAL (Delhi to Delhi)", 
                data: { originPincode: "110001", destinationPincode: "110001", weight: 2, length: 1, width: 1, height: 1, rateCardId } 
            },
            { 
                label: "SCENARIO 2: ZONAL (Delhi to Lucknow)", 
                data: { originPincode: "110001", destinationPincode: "226001", weight: 2, length: 1, width: 1, height: 1, rateCardId } 
            },
            { 
                label: "SCENARIO 3: NATIONAL (Delhi to Mumbai)", 
                data: { originPincode: "110001", destinationPincode: "400001", weight: 2, length: 1, width: 1, height: 1, rateCardId } 
            },
            { 
                label: "SCENARIO 4: ODA / REMOTE (Delhi to Itanagar)", 
                data: { originPincode: "110001", destinationPincode: "791111", weight: 2, length: 1, width: 1, height: 1, rateCardId } 
            }
        ];

        console.log('\n🚀 Starting Shiprocket-Grade Pricing Verification...\n');

        for (const scenario of scenarios) {
            console.log(`--- ${scenario.label} ---`);
            const result = await calculateFreight(scenario.data);
            console.log(`Distance: ${result.distance.toFixed(2)} KM`);
            console.log(`Bucket Applied: ${result.appliedBucket}`);
            console.log(`Chargeable Weight: ${result.chargeableWeight} KG`);
            console.log(`Base Freight: ₹${result.baseFreight}`);
            console.log(`ODA Surcharge: ₹${result.odaSurcharge}`);
            console.log(`Total Amount (incl. GST): ₹${result.totalAmount.toFixed(2)}`);
            console.log('Breakdown:');
            result.breakdown.forEach(item => console.log(`  - ${item.label}: ₹${item.value.toFixed(2)}`));
            console.log('\n');
        }

        process.exit(0);
    } catch (error) {
        console.error('❌ Verification Error:', error);
        process.exit(1);
    }
};

verifyPricing();
