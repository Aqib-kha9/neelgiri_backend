const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        const uri = process.env.MONGO_URI || '';
        console.log(`📡 Attempting to connect to MongoDB...`);
        // Log masked URI for debugging
        if (uri) {
            const maskedUri = uri.replace(/:([^:@]+)@/, ':****@');
            console.log(`🔑 Using URI: ${maskedUri}`);
        } else {
            console.error('❌ MONGO_URI environment variable is missing!');
        }

        const conn = await mongoose.connect(uri);
        console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    } catch (error) {
        console.error('❌ Database Connection Error:');
        console.error(`Name: ${error.name}`);
        console.error(`Message: ${error.message}`);
        console.error(`Code: ${error.code}`);
        if (error.reason) console.error(`Reason: ${JSON.stringify(error.reason)}`);

        process.exit(1);
    }
};

module.exports = connectDB;
