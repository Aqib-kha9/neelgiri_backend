const mongoose = require('mongoose');

const localUri = 'mongodb://localhost:27017/delivery_db';
const atlasUri = 'Write DB String Here';

const collections = ['users', 'roles', 'branches', 'shipments', 'manifests', 'drs'];

async function check() {
    console.log("🔍 Checking Database Status...");

    // Check Local
    console.log("\n🏠 Connecting to LOCAL DB...");
    try {
        const localConn = await mongoose.createConnection(localUri).asPromise();
        console.log("✅ Local Connected.");
        for (const col of collections) {
            const count = await localConn.collection(col).countDocuments();
            console.log(`   - ${col}: ${count}`);
        }
        await localConn.close();
    } catch (e) {
        console.log("❌ Local Connect Failed:", e.message);
    }

    // Check Atlas
    console.log("\n☁️ Connecting to ATLAS DB...");
    try {
        const atlasConn = await mongoose.createConnection(atlasUri).asPromise();
        console.log("✅ Atlas Connected.");
        for (const col of collections) {
            const count = await atlasConn.collection(col).countDocuments();
            console.log(`   - ${col}: ${count}`);
        }
        await atlasConn.close();
    } catch (e) {
        console.log("❌ Atlas Connect Failed:", e.message);
        console.log("   (Check if IP 0.0.0.0/0 is whitelisted in Atlas)");
    }
}

check();
