const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');
const Role = require('./models/Role');
const Branch = require('./models/Branch');

dotenv.config();

const analyze = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('connected to db');

        // 1. Fetch potential Admin Roles
        const baRoles = await Role.find({
            name: { $in: ['branch_admin', 'branch', 'branch_manager'] }
        });
        console.log('Branch Admin Roles found:', baRoles.map(r => `${r.name} (${r._id})`));
        const baRoleIds = baRoles.map(r => r._id);

        // 2. Fetch All Branches
        const branches = await Branch.find({}).lean();
        console.log(`Total Branches: ${branches.length}`);

        // 3. Analyze Users linked to these branches
        const branchIds = branches.map(b => b._id);
        const branchCodes = branches.map(b => b.code);

        // Fetch ALL users who might be admins (filter layout later)
        // using NATIVE collection to see raw types
        const allUsers = await User.collection.find({}).toArray();

        console.log(`Total Users in DB: ${allUsers.length}`);

        let adminsFoundCount = 0;

        for (const branch of branches) {
            console.log(`\n--- Analyzing Branch: ${branch.name} (${branch.code}) ---`);
            const bIdStr = branch._id.toString();

            // Find users linked to this branch
            const usersLinked = allUsers.filter(u => {
                const uBid = u.branchId;
                if (!uBid) return false;
                return uBid.toString() === bIdStr || uBid === branch.code;
            });

            console.log(`Users linked to this branch: ${usersLinked.length}`);

            // Check if any is admin
            const admins = usersLinked.filter(u => {
                // Check Role
                // Role might be ID or String in DB?
                let roleMatch = false;
                if (u.role) {
                    const rStr = u.role.toString();
                    // Match against IDs
                    if (baRoleIds.find(id => id.toString() === rStr)) roleMatch = true;
                    // Match against Names (legacy)
                    if (['branch_admin', 'branch'].includes(rStr)) roleMatch = true;
                }
                return roleMatch;
            });

            if (admins.length > 0) {
                console.log(`✅ Admin Found: ${admins.map(a => `${a.name} (Role: ${a.role}, BranchIdType: ${typeof a.branchId})`).join(', ')}`);
                adminsFoundCount++;
            } else {
                console.log(`❌ NO Admin Found via Logic.`);
                // Dump one user to see why
                if (usersLinked.length > 0) {
                    const example = usersLinked[0];
                    console.log(`   Example User: ${example.name}, Role: ${example.role}, BranchId: ${example.branchId} (Type: ${typeof example.branchId})`);
                }
            }
        }

        console.log(`\nSummary: Found Admins for ${adminsFoundCount} / ${branches.length} branches.`);

        process.exit();
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

analyze();
