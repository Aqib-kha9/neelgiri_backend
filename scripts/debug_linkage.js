const mongoose = require('mongoose');
const dotenv = require('dotenv');
const fs = require('fs');

const User = require('../models/User');
const Branch = require('../models/Branch');
const Shipment = require('../models/Shipment');

dotenv.config();

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
    } catch (err) {
        fs.writeFileSync('linkage_results.txt', `Connection Error: ${err.message}`);
        process.exit(1);
    }
};

const runAnalysis = async () => {
    await connectDB();
    const log = [];
    const logMsg = (msg) => log.push(msg);

    try {
        logMsg('--- DATA LINKAGE ANALYSIS (LEAN MODE) ---');

        // 1. Find a recent "not_scheduled" shipment
        const shipment = await Shipment.findOne({ status: 'not_scheduled' }).sort({ updatedAt: -1 }).lean();

        const targetShipment = shipment || await Shipment.findOne().sort({ updatedAt: -1 }).lean();

        if (!targetShipment) {
            logMsg('No Shipments found in DB.');
            fs.writeFileSync('linkage_results.txt', log.join('\n'));
            return;
        }

        logMsg(`1. Target Shipment: ${targetShipment.awb}`);
        logMsg(`   Status: ${targetShipment.status}`);
        logMsg(`   Destination Branch ID: ${targetShipment.destinationBranch}`);

        // 2. Find the Branch
        const branch = await Branch.findById(targetShipment.destinationBranch).lean();
        if (!branch) {
            logMsg(`   ERROR: Branch not found for ID: ${targetShipment.destinationBranch}`);
        } else {
            logMsg(`2. Branch Found: "${branch.name}"`);
            logMsg(`   Branch ID: ${branch._id}`);
            logMsg(`   Linked Partner ID Raw: ${branch.partnerId}`);

            // 3. Find the Partner User linked to this Branch
            if (branch.partnerId) {
                const linkedPartner = await User.findById(branch.partnerId).populate('role').lean();
                if (!linkedPartner) {
                    logMsg(`   ERROR: User not found for ID: ${branch.partnerId}`);
                } else {
                    logMsg(`3. Linked Partner Found: "${linkedPartner.name}"`);
                    logMsg(`   User ID: ${linkedPartner._id}`);
                    // Fetch role name manually since population in lean is tricky if not set up
                    // But we can just query Role
                    if (linkedPartner.role) {
                        const role = await mongoose.model('Role').findById(linkedPartner.role).lean();
                        logMsg(`   Role: ${role ? role.name : 'Unknown'}`);
                    }
                }
            } else {
                logMsg('   ERROR: Branch has NO partnerId field set.');
            }
        }

        fs.writeFileSync('linkage_results.txt', log.join('\n'));
        console.log('Analysis complete. Results in linkage_results.txt');

    } catch (error) {
        logMsg(`Analysis Error: ${error.stack}`);
        fs.writeFileSync('linkage_results.txt', log.join('\n'));
    } finally {
        await mongoose.disconnect();
    }
};

runAnalysis();
