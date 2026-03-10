const mongoose = require('mongoose');
const Manifest = require('./models/Manifest');
const User = require('./models/User');
const Branch = require('./models/Branch');
const Role = require('./models/Role');
require('dotenv').config();

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('--- DB Audit: Manifest Inward Visibility ---');

        // 1. Get all manifests
        const manifests = await Manifest.find({})
            .populate('sourceBranch', 'name')
            .populate('destinationBranch', 'name');

        console.log(`Found ${manifests.length} total manifests`);
        manifests.forEach(m => {
            console.log(`- [${m.manifestId}] Status: ${m.status}, To: ${m.destinationBranch?.name} (${m.destinationBranch?._id})`);
        });

        // 2. Get all Users
        const users = await User.find({}).populate('role');
        console.log('\n--- User Branch Audit ---');
        users.forEach(u => {
            const roleName = u.role ? u.role.name : 'NO_ROLE';
            console.log(`User: ${u.name}, Role: ${roleName}, BranchID: ${u.branchId}`);
        });

        // 3. Match
        console.log('\n--- Matching Active Manifests with Potential Receivers ---');
        const activeManifests = manifests.filter(m => m.status === 'in_transit');
        activeManifests.forEach(m => {
            const destId = m.destinationBranch?._id;
            if (destId) {
                const receivers = users.filter(u => u.branchId && String(u.branchId) === String(destId));
                console.log(`Manifest ${m.manifestId} (Sent to ${m.destinationBranch?.name || 'Unknown'})`);
                console.log(`  Users who should see it (${receivers.length}): ${receivers.map(r => r.name).join(', ') || 'NONE'}`);
            }
        });

    } catch (err) {
        console.error('Audit Error:', err);
    } finally {
        await mongoose.disconnect();
    }
};

run();
