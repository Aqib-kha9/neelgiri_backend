const mongoose = require('mongoose');
require('dotenv').config();

const receiverSchema = new mongoose.Schema({ name: String, pincode: String });
const pickupLocationSchema = new mongoose.Schema({ name: String, pincode: String });
const customerSchema = new mongoose.Schema({
    code: String,
    name: String,
    gstin: String,
    portalAccess: Boolean,
    receivers: [receiverSchema],
    pickupLocations: [pickupLocationSchema],
    rateCard: mongoose.Schema.Types.ObjectId
});

const Customer = mongoose.model('Customer', customerSchema);

async function verify() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const customer = await Customer.findOne({ code: 'CUST-001' }).populate('rateCard');
        if (!customer) {
            console.error('❌ Customer not found!');
        } else {
            console.log('✅ Customer Found:', customer.name);
            console.log('GSTIN:', customer.gstin);
            console.log('Portal Access:', customer.portalAccess);
            console.log('Receivers Count:', customer.receivers.length);
            console.log('Pickup Locations Count:', customer.pickupLocations.length);
            console.log('Assigned Rate Card:', customer.rateCard ? customer.rateCard.name : 'None');
            
            if (customer.receivers.length > 0) {
                console.log('Sample Receiver:', customer.receivers[0].name, '(', customer.receivers[0].pincode, ')');
            }
        }
        await mongoose.disconnect();
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
verify();
