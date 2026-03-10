const mongoose = require('mongoose');
const dotenv = require('dotenv');
const fs = require('fs');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Shipment = require('../models/Shipment');
const Role = require('../models/Role');

dotenv.config();

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');
    } catch (err) {
        console.error('Connection Error:', err);
        process.exit(1);
    }
};

const runDebug = async () => {
    await connectDB();

    try {
        const role = await Role.findOne({ name: 'partner_admin' });
        if (!role) {
            console.error('Role partner_admin not found');
            return;
        }

        const partners = await User.find({ role: role._id }).limit(5).select('name email parentPartner');

        const report = [];

        for (const partner of partners) {
            const pInfo = {
                name: partner.name,
                id: partner._id.toString(),
                email: partner.email,
                parentPartner: partner.parentPartner,
                branches: [],
                shipmentsFound: 0,
                totalShipmentsAnyStatus: 0,
                error: null
            };

            let partnerId = partner._id;
            if (partner.parentPartner) {
                pInfo.isSubAccount = true;
                partnerId = partner.parentPartner;
            }
            pInfo.effectivePartnerId = partnerId.toString();

            // Cast to ObjectId for robustness test
            // Mongoose should handle this, but let's see.
            // const partnerObjectId = new mongoose.Types.ObjectId(partnerId.toString());

            const branches = await Branch.find({ partnerId: partnerId });
            pInfo.branchCount = branches.length;
            pInfo.branches = branches.map(b => ({ name: b.name, id: b._id.toString() }));

            const branchIds = branches.map(b => b._id);

            if (branchIds.length === 0) {
                pInfo.error = 'No branches found';
                report.push(pInfo);
                continue;
            }

            // Using pure strings for ID comparison is unreliable in manual queries unless casted
            // But Mongoose model methods handle casting.

            const query = {
                destinationBranch: { $in: branchIds },
                status: { $in: ['not_scheduled', 'scheduled', 'in_progress', 'paused', 'complete'] }
            };

            pInfo.query = JSON.stringify(query);

            const count = await Shipment.countDocuments(query);
            pInfo.shipmentsFound = count;

            const totalAny = await Shipment.countDocuments({ destinationBranch: { $in: branchIds } });
            pInfo.totalShipmentsAnyStatus = totalAny;

            report.push(pInfo);
        }

        fs.writeFileSync('debug_results.json', JSON.stringify(report, null, 2));
        console.log('Debug report written to debug_results.json');

    } catch (error) {
        console.error('Debug Error:', error);
    } finally {
        await mongoose.disconnect();
    }
};

runDebug();
