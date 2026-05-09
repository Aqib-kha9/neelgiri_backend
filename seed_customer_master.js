const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config();

// Models (Defined inline to avoid path/export issues during seeding)
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },
    status: { type: String, enum: ['active', 'inactive', 'paused'], default: 'active' },
}, { timestamps: true });

const receiverSchema = new mongoose.Schema({
    id: String,
    name: String,
    address: String,
    city: String,
    pincode: String,
    mobileNo: String,
    email: String
});

const pickupLocationSchema = new mongoose.Schema({
    id: String,
    name: String,
    address: String,
    city: String,
    pincode: String,
    contactPerson: String,
    mobileNo: String
});

const customerSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    contactPerson: String,
    address1: String,
    address2: String,
    city: String,
    pincode: String,
    gstin: String,
    mobileNo: String,
    phoneO: String,
    phoneR: String,
    email: { type: String, required: true, lowercase: true, trim: true },
    receivers: [receiverSchema],
    pickupLocations: [pickupLocationSchema],
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    category: String,
    paymentMode: String,
    documentNo: String,
    remark: String,
    billingType: String,
    creditDays: Number,
    defaultPaymentMode: String,
    kycStatus: String,
    kycDocumentType: String,
    paymentTerms: String,
    contractId: String,
    customerType: { type: String, enum: ['REGULAR', 'GUEST'], default: 'REGULAR' },
    registrationSource: { type: String, enum: ['ADMIN', 'WEBSITE'], default: 'ADMIN' },
    rateCard: { type: mongoose.Schema.Types.ObjectId, ref: 'Rate' },
    portalAccess: { type: Boolean, default: false },
    portalEmail: String,
    allowedServices: [String],
    serviceableZones: [String],
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

const rateSchema = new mongoose.Schema({ name: String });

const User = mongoose.model('User', userSchema);
const Customer = mongoose.model('Customer', customerSchema);
const Rate = mongoose.model('Rate', rateSchema);

async function seed() {
    try {
        const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
        console.log(`📡 Attempting to connect to MongoDB...`);
        await mongoose.connect(uri);
        console.log('✅ Connected to MongoDB');

        // 1. Get a Rate Card
        console.log('🔍 Looking for a Rate Card...');
        const rateCard = await Rate.findOne({ name: /Corporate|Standard/i });
        if (!rateCard) {
            console.error('❌ No Rate Card found! Please seed rates first.');
            process.exit(1);
        }

        // 1.1 Get Customer Role
        const customerRole = await mongoose.model('Role', new mongoose.Schema({ name: String })).findOne({ name: 'customer' });
        if (!customerRole) {
            console.error('❌ "customer" role not found in DB!');
            process.exit(1);
        }

        // 2. Create Portal User
        const hashedPassword = await bcrypt.hash('customer123', 10);
        const userData = {
            name: "Deepanshu Logistics Pvt Ltd",
            email: "deepanshu@example.com",
            password: hashedPassword,
            role: customerRole._id,
            status: 'active'
        };

        const existingUser = await User.findOne({ email: userData.email });
        let user;
        if (existingUser) {
            await User.deleteOne({ email: userData.email });
            console.log('🗑️ Existing portal user deleted for re-seeding.');
        }
        user = await User.create(userData);
        console.log('👤 Portal User created.');

        // 3. Create Full Customer Record
        const customerData = {
            code: "CUST-001",
            name: "Deepanshu Logistics Pvt Ltd",
            contactPerson: "Deepanshu Sharma",
            gstin: "07AAACB1234A1Z5",
            
            // Contact Information
            mobileNo: "9876543210",
            phoneO: "011-23456789",
            phoneR: "011-98765432",
            email: "billing@deepanshu.com",

            // Billing Address
            address1: "Plot No. 45, Okhla Industrial Estate",
            address2: "Phase III, Near Metro Station",
            city: "New Delhi",
            pincode: "110020",

            // Billing & Payment
            billingType: "Prepaid",
            paymentTerms: "Net 30 Days",
            contractId: "CTR-2024-001",
            defaultPaymentMode: "Cash",
            paymentMode: "CREDIT", // Internal mode
            creditDays: 30,

            // KYC
            kycStatus: "Not Verified",
            kycDocumentType: "Aadhar Card",

            // Portal Access
            portalAccess: true,
            portalEmail: "deepanshu@example.com",
            userId: user._id,

            // Logistics Config
            rateCard: rateCard._id,
            allowedServices: ["Air Express", "Surface Standard", "Hyperlocal"],
            serviceableZones: ["North", "West", "South"],

            // Receivers (Master Data)
            receivers: [
                {
                    id: "rec_1",
                    name: "Rahul Mehra",
                    mobileNo: "9988776655",
                    email: "rahul@client.com",
                    pincode: "400001",
                    city: "Mumbai",
                    address: "123 Marine Drive, South Mumbai"
                }
            ],

            // Pickup Locations (Master Data)
            pickupLocations: [
                {
                    id: "pick_1",
                    name: "Main Warehouse",
                    contactPerson: "Amit Kumar",
                    mobileNo: "8877665544",
                    pincode: "110020",
                    city: "New Delhi",
                    address: "Warehouse No 5, Okhla Phase 3"
                }
            ],

            // Meta
            category: "Regular Customer",
            status: "active",
            customerType: "REGULAR",
            registrationSource: "ADMIN",
            documentNo: "DOC-2024-001",
            remark: "VIP Customer - Handle with care and premium service."
        };

        const existingCustomer = await Customer.findOne({ code: customerData.code });
        if (existingCustomer) {
            await Customer.deleteOne({ code: customerData.code });
            console.log('🗑️ Existing customer deleted.');
        }

        await Customer.create(customerData);
        console.log('✅ Comprehensive Customer Master seeded successfully!');

        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('❌ Error seeding data:', err);
        process.exit(1);
    }
}

seed();
