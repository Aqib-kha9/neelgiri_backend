const mongoose = require('mongoose');
const Manifest = require('./models/Manifest');
const Shipment = require('./models/Shipment');
const Branch = require('./models/Branch');
require('dotenv').config();

const verifyManifests = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/delivery_app');
        console.log('Connected to DB');

        console.log('\n--- Checking Recent Manifests ---');
        const manifests = await Manifest.find({})
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('sourceBranch', 'name')
            .populate('destinationBranch', 'name');

        if (manifests.length === 0) {
            console.log('No manifests found.');
        } else {
            for (const m of manifests) {
                console.log(`\nManifest: ${m.manifestId}`);
                console.log(`Status: ${m.status}`);
                console.log(`Source: ${m.sourceBranch?.name} (${m.sourceBranch?._id})`);
                console.log(`Destination: ${m.destinationBranch?.name} (${m.destinationBranch?._id})`);
                console.log(`Type of Destination ID stored: ${typeof m.destinationBranch}`);
                console.log(`Shipment Count: ${m.shipments.length}`);

                // Check Shipments status
                const shipment = await Shipment.findById(m.shipments[0]);
                if (shipment) {
                    console.log(`Sample Shipment Status: ${shipment.status}`);
                    console.log(`Sample Shipment Current Branch: ${shipment.currentBranch}`);
                }
            }
        }

    } catch (error) {
        console.error(error);
    } finally {
        await mongoose.connection.close();
    }
};

verifyManifests();
