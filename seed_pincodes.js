const mongoose = require('mongoose');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const Pincode = require('./models/Pincode');

dotenv.config();
connectDB();

const pincodes = [
    {
        pincode: "110001",
        city: "Delhi",
        state: "Delhi",
        zone: "NORTH",
        branchId: "6960b9b0cf51192ddf36d83a",
        isServiceable: true,
        transitDays: 1
    },
    {
        pincode: "400001",
        city: "Mumbai",
        state: "Maharashtra",
        zone: "WEST",
        branchId: "6960afd3cf51192ddf36d7e7",
        isServiceable: true,
        transitDays: 2
    },
    {
        pincode: "560001",
        city: "Bangalore",
        state: "Karnataka",
        zone: "SOUTH",
        branchId: "6962003a51a4989d65f4cbb4",
        isServiceable: true,
        transitDays: 3
    }
];

const seedPincodes = async () => {
    try {
        await Pincode.deleteMany();
        console.log('🗑️  Pincodes cleared');
        await Pincode.insertMany(pincodes);
        console.log('✅ Pincodes seeded successfully');
        process.exit();
    } catch (error) {
        console.error(`❌ Error seeding pincodes: ${error}`);
        process.exit(1);
    }
};

seedPincodes();
