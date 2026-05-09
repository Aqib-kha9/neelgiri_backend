const mongoose = require('mongoose');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

// Load env
dotenv.config();

const Pincode = require('./models/Pincode');
const Customer = require('./models/Customer');
const Rate = require('./models/Rate');
const User = require('./models/User');

const logFile = path.join(__dirname, 'test_output.txt');
fs.writeFileSync(logFile, '');

const log = (msg) => {
    console.log(msg);
    fs.appendFileSync(logFile, msg + '\n');
};

async function look() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        log('Connected to DB');

        log('\n--- SERVICEABLE PINCODES ---');
        const pincodes = await Pincode.find({ isServiceable: true, branchId: { $ne: null } }).limit(10).sort({ pincode: 1 });
        pincodes.forEach(p => log(`Pincode: ${p.pincode}, City: ${p.city || p.officeName}, Zone: ${p.zone}, Branch: ${p.branchId}`));

        log('\n--- CUSTOMERS & RATE CARDS ---');
        const customers = await Customer.find({}).limit(10).populate('userId', 'name email');
        for (const c of customers) {
            const rc = c.rateCard ? await Rate.findById(c.rateCard) : null;
            log(`Customer: ${c.userId?.name}, Email: ${c.userId?.email}, RateCard: ${rc ? rc.name : 'NONE'}`);
        }

        log('\n--- ALL RATE CARDS ---');
        const rates = await Rate.find({}).limit(10);
        rates.forEach(r => log(`ID: ${r._id}, Name: ${r.name}`));

        await mongoose.disconnect();
    } catch (err) {
        log('ERROR: ' + err.toString());
    }
}

look();
