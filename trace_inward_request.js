const mongoose = require('mongoose');
const Manifest = require('./models/Manifest');
const User = require('./models/User');
const Branch = require('./models/Branch');
require('dotenv').config();

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('=== COMPLETE INWARD PROCESSING TRACE ===\n');

        // Step 1: Find a destination branch user (like "virat koli")
        const destUser = await User.findOne({ name: 'virat koli' }).populate('role');
        if (!destUser) {
            console.log('ERROR: User "virat koli" not found');
            return;
        }

        console.log('STEP 1: User Context');
        console.log('User Name:', destUser.name);
        console.log('User Role:', destUser.role.name);
        console.log('User BranchId:', destUser.branchId);
        console.log('BranchId Type:', typeof destUser.branchId);
        console.log('BranchId Constructor:', destUser.branchId.constructor.name);

        // Step 2: Find what manifests SHOULD be visible
        console.log('\n\nSTEP 2: What manifests exist for this branch?');
        const allManifests = await Manifest.find({});
        console.log('Total manifests in DB:', allManifests.length);

        const manifestsForThisBranch = allManifests.filter(m => {
            const destId = m.destinationBranch;
            const userBranchId = destUser.branchId;
            const match = String(destId) === String(userBranchId);
            if (match) {
                console.log(`  ✓ ${m.manifestId} - Status: ${m.status}, Dest: ${destId}`);
            }
            return match;
        });
        console.log(`Manifests where destination = ${destUser.branchId}:`, manifestsForThisBranch.length);

        // Step 3: Simulate the EXACT query that the API would run
        console.log('\n\nSTEP 3: Simulating API Query (type=inward)');

        // This is what the controller CURRENTLY does
        let branchIds = [destUser.branchId];
        let filters = {
            destinationBranch: { $in: branchIds },
            status: 'in_transit'
        };

        console.log('Filter Object:', JSON.stringify(filters, null, 2));
        console.log('BranchIds array:', branchIds);
        console.log('BranchIds[0] type:', typeof branchIds[0]);

        const result1 = await Manifest.find(filters);
        console.log('Query Result Count:', result1.length);
        if (result1.length === 0) {
            console.log('❌ QUERY RETURNED EMPTY - THIS IS THE BUG');
        } else {
            console.log('✓ Query returned results:', result1.map(m => m.manifestId));
        }

        // Step 4: Try with explicit ObjectId casting
        console.log('\n\nSTEP 4: Testing with ObjectId Casting');
        const branchIdsCasted = branchIds.map(id => new mongoose.Types.ObjectId(id));
        const filtersCasted = {
            destinationBranch: { $in: branchIdsCasted },
            status: 'in_transit'
        };

        console.log('Casted Filter:', JSON.stringify(filtersCasted, null, 2));
        const result2 = await Manifest.find(filtersCasted);
        console.log('Casted Query Result Count:', result2.length);
        if (result2.length > 0) {
            console.log('✓ CASTING FIXED IT! Results:', result2.map(m => m.manifestId));
        }

        // Step 5: Try direct comparison (no $in)
        console.log('\n\nSTEP 5: Testing Direct Comparison (no $in)');
        const filtersDirect = {
            destinationBranch: destUser.branchId,
            status: 'in_transit'
        };
        const result3 = await Manifest.find(filtersDirect);
        console.log('Direct Query Result Count:', result3.length);
        if (result3.length > 0) {
            console.log('✓ Direct comparison works! Results:', result3.map(m => m.manifestId));
        }

    } catch (err) {
        console.error('ERROR:', err);
    } finally {
        await mongoose.disconnect();
    }
};

run();
