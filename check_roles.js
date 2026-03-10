const mongoose = require('mongoose');
require('dotenv').config({ path: './.env' }); // Adjust path if needed
const Role = require('./models/Role'); // Adjust path if needed

const checkRoles = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/delivery_app_db'); // Use local fallback if env missing
        console.log('Connected to DB');

        const roles = await Role.find({});
        console.log('Available Roles:');
        roles.forEach(r => console.log(`- Name: ${r.name}, Display: ${r.displayName}`));

        process.exit();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
};

checkRoles();
