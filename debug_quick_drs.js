const mongoose = require('mongoose');
const dotenv = require('dotenv');
const DRS = require('./models/DRS');
const User = require('./models/User');
const Role = require('./models/Role'); // Explicitly require Role

dotenv.config();

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('DB Connected');

        // 1. Get Last Created DRS
        const drs = await DRS.findOne().sort({ createdAt: -1 });
        if (!drs) {
            console.log('No DRS found.');
            return;
        }

        console.log('--- Last DRS ---');
        console.log(`ID: ${drs._id}`);
        console.log(`DRS ID: ${drs.drsId}`);
        console.log(`Rider Field: ${drs.rider} (Type: ${typeof drs.rider})`);

        if (drs.rider) {
            const user = await User.findById(drs.rider);
            if (user) {
                console.log(`Rider User Found: ${user.name}`);
                console.log(`Rider Role ID: ${user.role}`);

                const role = await Role.findById(user.role);
                if (role) {
                    console.log(`Role Name: '${role.name}'`);
                } else {
                    console.log('Role not found for user');
                }
            } else {
                console.log('User not found for ID: ' + drs.rider);
            }
        }

    } catch (e) {
        console.error('Error:', e);
    } finally {
        await mongoose.disconnect();
    }
};

run();
