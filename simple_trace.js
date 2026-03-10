const mongoose = require('mongoose');
const Manifest = require('./models/Manifest');
const User = require('./models/User');
require('dotenv').config();

async function run() {
    await mongoose.connect(process.env.MONGO_URI);

    console.log('=== INWARD PROCESSING DEBUG ===\n');

    // Get the destination user
    const user = await User.findOne({ name: 'virat koli' }).populate('role');
    console.log('1. USER INFO:');
    console.log('   Name:', user.name);
    console.log('   BranchId:', user.branchId);
    console.log('   Type:', user.branchId.constructor.name);

    // Check manifests
    console.log('\n2. MANIFESTS IN DB:');
    const all = await Manifest.find({ status: 'in_transit' });
    console.log('   Total in_transit:', all.length);
    all.forEach(m => {
        console.log(`   - ${m.manifestId}: dest=${m.destinationBranch}`);
    });

    // Test query WITHOUT $in
    console.log('\n3. QUERY TEST (Direct):');
    const test1 = await Manifest.find({
        destinationBranch: user.branchId,
        status: 'in_transit'
    });
    console.log('   Result:', test1.length, 'manifests');

    // Test query WITH $in (current code)
    console.log('\n4. QUERY TEST (With $in):');
    const test2 = await Manifest.find({
        destinationBranch: { $in: [user.branchId] },
        status: 'in_transit'
    });
    console.log('   Result:', test2.length, 'manifests');

    // Test with casting
    console.log('\n5. QUERY TEST (With ObjectId cast):');
    const test3 = await Manifest.find({
        destinationBranch: { $in: [new mongoose.Types.ObjectId(user.branchId)] },
        status: 'in_transit'
    });
    console.log('   Result:', test3.length, 'manifests');

    await mongoose.disconnect();
}

run().catch(console.error);
