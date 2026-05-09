const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const Rate = require('./models/Rate');

dotenv.config({ path: path.join(__dirname, './.env') });

const checkRates = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const rates = await Rate.find({});
        console.log(`Found ${rates.length} rates in total.`);

        rates.forEach(r => {
            console.log(`- [${r.isActive ? 'ACTIVE' : 'INACTIVE'}] Name: ${r.name}, Type: ${r.customerType}, Service: ${r.serviceType}, Valid: ${r.validFrom} to ${r.validTo}`);
        });

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

checkRates();
