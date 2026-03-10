const mongoose = require('mongoose');
const User = require('./models/User');
const Branch = require('./models/Branch');
const Role = require('./models/Role');
const Manifest = require('./models/Manifest');
const Shipment = require('./models/Shipment');
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

const seedShipment = async () => {
    await connectDB();
    try {
        console.log('--- SEED SHIPMENT START ---');

        const branch1 = await Branch.findOne({ code: 'BR-NG123X' }); // Mahewar 1
        const branch2 = await Branch.findOne({ code: 'BR-10FDWH' }); // Mahewar 2
        const partner = await User.findOne({ email: 'partner@delivery.com' });

        // Find the manifest we just created
        const manifest = await Manifest.findOne({ sourceBranch: branch1._id });

        if (!manifest) {
            console.log("Manifest not found (run repair_data.js first)");
            return;
        }

        // Check if shipment exists
        const awb = 'AWB-TEST-001';
        let shipment = await Shipment.findOne({ awb });

        if (!shipment) {
            shipment = new Shipment({
                awb: awb,
                sender: { name: 'Test Sender', phone: '9999999999' },
                receiver: { name: 'Test Receiver', phone: '8888888888', pincode: '123456' },
                weight: 5,
                status: 'forwarded', // Important for Inward Processing
                destinationBranch: branch2._id, // Going to Branch 2
                currentBranch: null, // In transit
                createdBy: partner._id,
                history: [{
                    status: 'forwarded',
                    branchId: branch1._id, // From Branch 1
                    updatedBy: partner._id,
                    remark: 'Seeded for Testing'
                }]
            });
            await shipment.save();
            console.log(`Created Shipment: ${awb}`);

            // Link to Manifest
            manifest.shipments.push(shipment._id);
            await manifest.save();
            console.log(`Linked Shipment to Manifest ${manifest.manifestId}`);
        } else {
            console.log(`Shipment ${awb} already exists.`);
        }

        console.log('--- SEED SHIPMENT COMPLETE ---');

    } catch (e) {
        console.error(e);
    } finally {
        mongoose.connection.close();
    }
};

seedShipment();
