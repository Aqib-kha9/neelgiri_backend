const mongoose = require('mongoose');
const Manifest = require('./models/Manifest');
const User = require('./models/User');
const Branch = require('./models/Branch');
const Role = require('./models/Role');
require('dotenv').config();

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('--- RAW DB AUDIT ---');

        const manifests = await Manifest.find({ status: 'in_transit' });
        console.log(`\nActive Manifests (in_transit): ${manifests.length}`);
        manifests.forEach(m => {
            console.log(`MF ID: ${m.manifestId}`);
            console.log(`  Destination Branch ID: ${m.destinationBranch} (Type: ${typeof m.destinationBranch})`);
        });

        const users = await User.find({}).populate('role');
        console.log('\nUsers Audit:');
        users.forEach(u => {
            if (u.role && (u.role.name === 'branch_admin' || u.role.name === 'dispatcher')) {
                console.log(`User: ${u.name}, BranchID: ${u.branchId} (Type: ${typeof u.branchId})`);
            }
        });

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
};

run();
