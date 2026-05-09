const mongoose = require('mongoose');
require('dotenv').config();

async function dropShipments() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB');
        
        await mongoose.connection.db.collection('shipments').drop();
        console.log('✅ Shipments collection dropped successfully! Fresh start ho gaya.');
    } catch (err) {
        if (err.message === 'ns not found') {
            console.log('ℹ️ Shipments collection already does not exist (already clean).');
        } else {
            console.error('❌ Error:', err.message);
        }
    } finally {
        mongoose.connection.close();
        console.log('Connection closed.');
    }
}

dropShipments();
