const mongoose = require('mongoose');
const User = require('./models/User');
const Branch = require('./models/Branch');
const Role = require('./models/Role');
const Manifest = require('./models/Manifest');
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

const runDiagnostics = async () => {
    await connectDB();

    try {
        console.log('--- DIAGNOSTICS START ---');

        // 1. Roles
        console.log('\n[ROLES]');
        const roles = await Role.find({});
        roles.forEach(r => console.log(`- ID: ${r._id}, Name: "${r.name}", Display: "${r.displayName}"`));

        // 2. Sample Users (One of each Role)
        console.log('\n[SAMPLE USERS]');
        for (const role of roles) {
            const user = await User.findOne({ role: role._id }).populate('role branchId parentPartner');
            if (user) {
                console.log(`- Role: ${role.name}`);
                console.log(`  Name: ${user.name} (${user.email})`);
                console.log(`  User ID: ${user._id}`);
                console.log(`  Branch: ${user.branchId ? `${user.branchId.name} (${user.branchId._id})` : 'NULL'}`);
                console.log(`  ParentPartner: ${user.parentPartner ? user.parentPartner.name : 'NULL'}`);
            } else {
                console.log(`- Role: ${role.name} -> No users found`);
            }
        }

        // 3. Manifests
        console.log('\n[MANIFESTS]');
        const manifests = await Manifest.find({}).sort({ createdAt: -1 }).limit(5)
            .populate('sourceBranch destinationBranch');

        if (manifests.length === 0) {
            console.log("No manifests found in DB.");
        } else {
            manifests.forEach(m => {
                console.log(`- Manifest: ${m.manifestId} (${m.status})`);
                console.log(`  Source: ${m.sourceBranch ? m.sourceBranch.name : 'NULL'} (${m.sourceBranch?._id})`);
                console.log(`  Dest:   ${m.destinationBranch ? m.destinationBranch.name : 'NULL'} (${m.destinationBranch?._id})`);
                console.log(`  CreatedBy: ${m.createdBy}`);
            });
        }

        console.log('--- DIAGNOSTICS END ---');

    } catch (error) {
        console.error("Error:", error);
    } finally {
        mongoose.connection.close();
    }
};

runDiagnostics();
