const mongoose = require('mongoose');

const localUri = 'mongodb://localhost:27017/delivery_db';
// Using the NEW URI provided by user
const atlasUri = 'Write Here DB';

// List of collections to migrate
// Note: Mongoose pluralizes model names. 
// User->users, Role->roles, Branch->branches, Shipment->shipments, 
// Manifest->manifests, DRS->drs, Bag->bags, Permission->permissions
const collections = [
    'roles',        // Import roles first (dependencies)
    'permissions',
    'users',        // Users depend on roles
    'branches',     // Branches depend on users (partners)
    'shipments',
    'manifests',
    'drs',
    'bags'
];

async function migrate() {
    console.log("🚀 Starting Migration: Local -> Atlas");
    console.log("-----------------------------------");

    try {
        const localConn = await mongoose.createConnection(localUri).asPromise();
        console.log("✅ Connected to Local DB");

        const atlasConn = await mongoose.createConnection(atlasUri).asPromise();
        console.log("✅ Connected to Atlas DB");

        console.log("\n📦 Copying Collections...");

        for (const colName of collections) {
            process.stdout.write(`   Processing '${colName}'... `);
            try {
                // 1. Fetch from Local
                const docs = await localConn.collection(colName).find().toArray();

                if (docs.length === 0) {
                    console.log("Empty (Skipping)");
                    continue;
                }

                // 2. Insert into Atlas
                // ordered: false ensures that if one fails (duplicate), others continue
                const result = await atlasConn.collection(colName).insertMany(docs, { ordered: false });
                console.log(`✅ Success! Copied ${result.insertedCount} docs.`);

            } catch (e) {
                if (e.code === 11000) {
                    // Duplicate key error is expected if we run this multiple times
                    // We can check how many were inserted despite error
                    console.log(`⚠️  Partial/Done. (Duplicates skipped)`);
                    if (e.result && e.result.nInserted > 0) {
                        console.log(`      -> Inserted ${e.result.nInserted} new docs.`);
                    }
                } else {
                    console.log(`❌ Failed: ${e.message}`);
                }
            }
        }

        console.log("\n-----------------------------------");
        console.log("🎉 Migration Finished Successfully!");

        await localConn.close();
        await atlasConn.close();
        process.exit(0);

    } catch (err) {
        console.error("\n💥 Critical Error:", err.message);
        process.exit(1);
    }
}

migrate();
