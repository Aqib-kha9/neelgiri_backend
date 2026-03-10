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

const repair = async () => {
    await connectDB();
    try {
        console.log('--- REPAIR START ---');

        // 1. Get Roles
        const branchAdminRole = await Role.findOne({ name: 'branch_admin' });
        const dispatcherRole = await Role.findOne({ name: 'dispatcher' });
        const partnerAdminRole = await Role.findOne({ name: 'partner_admin' });

        // 2. Get/Fix Users
        const partner = await User.findOne({ email: 'partner@delivery.com' });
        if (!partner) {
            console.log("Partner not found!");
            return;
        }
        console.log(`Partner: ${partner._id} (${partner.name})`);

        const branchManager = await User.findOne({ email: 'branch@delivery.com' });
        const dispatcher = await User.findOne({ email: 'dispatcher@delivery.com' });

        // 3. Get/Fix Branches
        const branch1 = await Branch.findOne({ code: 'BR-NG123X' }); // Mahewar 1
        const branch2 = await Branch.findOne({ code: 'BR-10FDWH' }); // Mahewar 2

        if (branch1 && partner) {
            branch1.partnerId = partner._id;
            await branch1.save();
            console.log(`Fixed Branch 1 Partner: (${branch1.name} -> ${partner.name})`);
        }
        if (branch2 && partner) {
            branch2.partnerId = partner._id;
            await branch2.save();
            console.log(`Fixed Branch 2 Partner: (${branch2.name} -> ${partner.name})`);
        }

        // 4. Assign Branch to Users
        if (branchManager && branch1) {
            branchManager.branchId = branch1._id;
            branchManager.parentPartner = partner._id;
            await branchManager.save();
            console.log(`Assigned Branch Manager to ${branch1.name}`);
        }
        if (dispatcher && branch1) {
            dispatcher.branchId = branch1._id;
            dispatcher.parentPartner = partner._id;
            await dispatcher.save();
            console.log(`Assigned Dispatcher to ${branch1.name}`);
        }

        // 5. Create Dummy Manifest
        const manifestCount = await Manifest.countDocuments();
        if (manifestCount === 0 && branch1 && branch2 && partner) {
            console.log('Creating Dummy Manifest...');
            const manifest = new Manifest({
                manifestId: `MF${Date.now()}`,
                sourceBranch: branch1._id,
                destinationBranch: branch2._id,
                shipments: [], // Empty for now, just header
                status: 'in_transit',
                createdBy: partner._id,
                stats: { totalShipments: 0, totalWeight: 0 },
                history: [{
                    status: 'created',
                    updatedBy: partner._id,
                    remark: 'Auto-generated test manifest'
                }]
            });
            await manifest.save();
            console.log(`Created Manifest: ${manifest.manifestId}`);
        } else {
            console.log(`Manifests exist (${manifestCount}) or missing data to create.`);
        }

        console.log('--- REPAIR COMPLETE ---');

    } catch (e) {
        console.error(e);
    } finally {
        mongoose.connection.close();
    }
};

repair();
