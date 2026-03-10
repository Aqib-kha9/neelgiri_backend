const fs = require('fs');
const csv = require('csv-parser');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const Pincode = require('./models/Pincode');

dotenv.config();
connectDB();

const filePath = './5c2f62fe-5afa-4119-a499-fec9d604d5bd (1).csv';
const BATCH_SIZE = 1000;

const circleToZone = (circle) => {
    if (!circle) return 'OTHER';
    circle = circle.toLowerCase();
    if (circle.includes('delhi') || circle.includes('haryana') || circle.includes('punjab') || circle.includes('rajasthan') || circle.includes('uttar pradesh') || circle.includes('uttarakhand') || circle.includes('jammu') || circle.includes('himachal')) return 'NORTH';
    if (circle.includes('telangana') || circle.includes('andhra') || circle.includes('karnataka') || circle.includes('tamil nadu') || circle.includes('kerala')) return 'SOUTH';
    if (circle.includes('maharashtra') || circle.includes('gujarat') || circle.includes('goa')) return 'WEST';
    if (circle.includes('west bengal') || circle.includes('bihar') || circle.includes('jharkhand') || circle.includes('odisha')) return 'EAST';
    if (circle.includes('madhya pradesh') || circle.includes('chhattisgarh')) return 'CENTRAL';
    if (circle.includes('north east') || circle.includes('assam')) return 'NORTHEAST';
    return 'OTHER';
};

const importData = async () => {
    try {
        console.log('🚀 Starting Pincode Import...');
        
        // Clear existing data
        await Pincode.deleteMany();
        console.log('🗑️  Existing pincodes cleared');

        let batch = [];
        let totalProcessed = 0;

        const stream = fs.createReadStream(filePath)
            .pipe(csv());

        for await (const row of stream) {
            const lat = row.latitude === 'NA' ? null : parseFloat(row.latitude);
            const lng = row.longitude === 'NA' ? null : parseFloat(row.longitude);

            batch.push({
                insertOne: {
                    document: {
                        pincode: row.pincode,
                        officeName: row.officename,
                        district: row.district,
                        state: row.statename,
                        zone: circleToZone(row.circlename),
                        latitude: isNaN(lat) ? null : lat,
                        longitude: isNaN(lng) ? null : lng,
                        isServiceable: false
                    }
                }
            });

            if (batch.length >= BATCH_SIZE) {
                try {
                    await Pincode.bulkWrite(batch, { ordered: false });
                    totalProcessed += batch.length;
                    if (totalProcessed % 5000 === 0) {
                        console.log(`📦 Processed: ${totalProcessed} records`);
                    }
                    batch = [];
                } catch (bulkError) {
                    console.error(`\n❌ Error at ${totalProcessed}:`, bulkError.message);
                    batch = [];
                }
            }
        }

        if (batch.length > 0) {
            await Pincode.bulkWrite(batch, { ordered: false });
            totalProcessed += batch.length;
            console.log(`\n📦 Final count: ${totalProcessed} records`);
        }

        console.log('✅ Import Completed Successfully!');
        process.exit();
    } catch (error) {
        console.error('❌ Error during import:', error);
        process.exit(1);
    }
};

importData();
