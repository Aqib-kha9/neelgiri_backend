const mongoose = require('mongoose');
const Manifest = require('./models/Manifest'); // Adjust path if needed
const User = require('./models/User');
const Role = require('./models/Role');
require('dotenv').config();

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB');

        // 1. Find a Branch Admin User (or Dispatcher)
        // Adjust the role name to what is actually in DB
        const role = await Role.findOne({ name: 'branch_admin' });
        if (!role) {
            console.log('Role branch_admin not found');
            return;
        }

        const user = await User.findOne({ role: role._id }).populate('role');
        if (!user) {
            console.log('No user found with branch_admin role');
            return;
        }

        console.log(`Testing with User: ${user.name} (${user.email})`);
        console.log(`User Branch ID: ${user.branchId}`);
        console.log(`User Role: ${user.role.name}`);

        // 2. Simulate the Filter Logic
        let filters = {};

        // Branch Scope
        filters.$or = [
            { sourceBranch: user.branchId },
            { destinationBranch: user.branchId }
        ];

        console.log('Query Filters:', JSON.stringify(filters, null, 2));

        // 3. Run Query
        const manifests = await Manifest.find(filters).limit(5);
        console.log(`Found ${manifests.length} manifests for this user.`);

        manifests.forEach(m => {
            console.log(`- [${m.manifestId}] From: ${m.sourceBranch} To: ${m.destinationBranch} Status: ${m.status}`);
            const srcMatch = String(m.sourceBranch) === String(user.branchId);
            const dstMatch = String(m.destinationBranch) === String(user.branchId);
            console.log(`  Matches User Branch? Source: ${srcMatch}, Dest: ${dstMatch}`);
        });

        // 4. Check for ALL manifests (Leak Check)
        const allManifests = await Manifest.find({}).limit(1);
        console.log('Total Random Manifest Sample:', allManifests.length);
        if (allManifests.length > 0) {
            const m = allManifests[0];
            const srcMatch = String(m.sourceBranch) === String(user.branchId);
            const dstMatch = String(m.destinationBranch) === String(user.branchId);
            if (!srcMatch && !dstMatch) {
                console.log(`[ALERT] There are manifests in DB that definitely DO NOT belong to this user. e.g. ${m.manifestId}`);
            }
        }

    } catch (e) {
        console.error(e);
    } finally {
        await mongoose.disconnect();
    }
};

run();
