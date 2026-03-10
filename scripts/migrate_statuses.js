const mongoose = require('mongoose');
const Manifest = require('../models/Manifest');
const Shipment = require('../models/Shipment');
require('dotenv').config();

async function migrateStatuses() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/delivery_db');
        console.log('✅ Connected to database');

        // ===================================================================
        // MIGRATE MANIFESTS: in_transit/forwarded/created → complete
        // ===================================================================
        console.log('\n📦 Migrating Manifests...');

        const manifestsToMigrate = await Manifest.find({
            status: { $in: ['in_transit', 'forwarded', 'created', 'received', 'cancelled'] }
        });

        console.log(`Found ${manifestsToMigrate.length} manifests to migrate`);

        for (const manifest of manifestsToMigrate) {
            // Set status to 'complete'
            manifest.status = 'complete';

            // Add forwarded_at timestamp to history if missing
            if (manifest.history && manifest.history.length > 0) {
                const lastHistory = manifest.history[manifest.history.length - 1];
                if (!lastHistory.forwarded_at) {
                    lastHistory.forwarded_at = lastHistory.timestamp || manifest.createdAt;
                }
            }

            await manifest.save();
            console.log(`  ✓ Migrated manifest ${manifest.manifestId}: ${manifest.status}`);
        }

        // ===================================================================
        // MIGRATE SHIPMENTS: Map old statuses → standardized statuses
        // CRITICAL: 'inwarded' is LEGACY INPUT ONLY - will NOT exist after migration
        // ===================================================================
        console.log('\n📦 Migrating Shipments...');

        const statusMapping = {
            'created': 'not_scheduled',
            'inwarded': 'not_scheduled',      // LEGACY: Remove from system
            'forwarded': 'not_scheduled',
            'scheduled': 'scheduled',
            'out_for_delivery': 'in_progress',
            'delivered': 'complete',
            'completed': 'complete',
            'failed': 'paused',
            'rto': 'paused',
            'bagged': 'not_scheduled'
        };

        for (const [oldStatus, newStatus] of Object.entries(statusMapping)) {
            const result = await Shipment.updateMany(
                { status: oldStatus },
                { $set: { status: newStatus } }
            );
            console.log(`  ✓ Migrated ${result.modifiedCount} shipments: ${oldStatus} → ${newStatus}`);
        }

        console.log('\n✅ Migration completed successfully!');
        console.log('\n📊 Final Status Summary:');

        const manifestCount = await Manifest.countDocuments({ status: 'complete' });
        console.log(`  Manifests with 'complete' status: ${manifestCount}`);

        const shipmentCounts = await Shipment.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]);
        console.log('  Shipment status distribution:');
        shipmentCounts.forEach(s => console.log(`    - ${s._id}: ${s.count}`));

        process.exit(0);

    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

migrateStatuses();
