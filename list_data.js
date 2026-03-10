const mongoose = require('mongoose');
const User = require('./models/User');
const Branch = require('./models/Branch');
const Role = require('./models/Role');
require('dotenv').config();

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
};

const fs = require('fs');
const path = require('path');

const log = (msg) => {
    fs.appendFileSync(path.join(__dirname, 'debug_output.txt'), msg + '\n');
};

const listData = async () => {
    await connectDB();
    try {
        // Clear previous output
        fs.writeFileSync(path.join(__dirname, 'debug_output.txt'), '');

        log('--- BRANCHES ---');
        const branches = await Branch.find({});
        branches.forEach(b => log(`Branch: ${b.name}, ID: ${b._id}, Code: ${b.code}`));

        log('\n--- ROLES ---');
        const roles = await Role.find({});
        roles.forEach(r => log(`Role: "${r.name}" (ID: ${r._id})`));

        log('\n--- USERS (One per Role) ---');
        for (const role of roles) {
            const user = await User.findOne({ role: role._id }).select('name email role branchId parentPartner');
            if (user) {
                log(`User: ${user.name} (${user.email})`);
                log(`  Role: ${role.name}`);
                log(`  Branch: ${user.branchId}`);
                log(`  ParentPartner: ${user.parentPartner}`);
            }
        }
    } catch (e) {
        log(e.toString());
    } finally {
        mongoose.connection.close();
    }
};

listData();
