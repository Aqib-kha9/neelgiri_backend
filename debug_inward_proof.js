const mongoose = require('mongoose');
const Manifest = require('./models/Manifest');
const User = require('./models/User');
require('dotenv').config();

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('--- DATA VALIDATION PROOF ---');

        // 1. FIELD NAME PROOF
        const manifest = await Manifest.findOne({});
        if (!manifest) {
            console.log('❌ NO MANIFESTS FOUND IN DB');
            return;
        }

        console.log('\n1) EXACT FIELD NAME IN DB:');
        const keys = Object.keys(manifest.toObject());
        console.log('Fields available in Manifest document:', keys);
        const hasDestBranch = keys.includes('destinationBranch');
        const hasToBranchId = keys.includes('toBranchId');
        console.log(`Found "destinationBranch": ${hasDestBranch}`);
        console.log(`Found "toBranchId": ${hasToBranchId}`);
        console.log(`-> ACTUAL FIELD TO QUERY: ${hasDestBranch ? 'destinationBranch' : (hasToBranchId ? 'toBranchId' : 'UNKNOWN')}`);

        // 2. STATUS VALUE PROOF
        console.log('\n2) EXACT STATUS VALUE IN DB:');
        console.log(`Current Manifest ID: ${manifest.manifestId}`);
        console.log(`Stored Status: "${manifest.status}"`);
        console.log(`Status Type: ${typeof manifest.status}`);

        // 3. OBJECTID COMPARISON PROOF
        console.log('\n3) OBJECTID COMPARISON TEST:');
        const branchIdFromDoc = manifest.destinationBranch;
        const branchIdString = branchIdFromDoc.toString();
        const branchIdCasted = new mongoose.Types.ObjectId(branchIdString);

        console.log(`Raw ID from DB: ${branchIdFromDoc} (Type: ${typeof branchIdFromDoc})`);
        console.log(`Casted ID: ${branchIdCasted} (Type: ${typeof branchIdCasted})`);

        // TEST QUERY
        const testFilters = {
            destinationBranch: branchIdCasted, // Explicitly using casted ObjectId
            status: manifest.status
        };
        console.log('Testing Query with Filters:', JSON.stringify(testFilters));
        const testResult = await Manifest.findOne(testFilters);
        console.log(`Query Result found: ${testResult ? 'YES (Success)' : 'NO (Failed)'}`);

        // 4. USER CONTEXT PROOF
        const user = await User.findOne({ branchId: { $ne: null } });
        if (user) {
            console.log('\n4) USER CONTEXT LOG:');
            console.log(`User Name: ${user.name}`);
            console.log(`User.branchId in DB: ${user.branchId} (Type: ${typeof user.branchId})`);
        }

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
};

run();
