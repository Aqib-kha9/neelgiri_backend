const mongoose = require('mongoose');
const User = require('./models/User');
const Role = require('./models/Role');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);

        // 1. Find the user 'virat koli' (Destination Branch Admin/Dispatcher)
        const user = await User.findOne({ name: 'virat koli' }).populate('role');
        if (!user) {
            console.error('User virat koli not found');
            return;
        }

        console.log(`Testing API for User: ${user.name}, Branch: ${user.branchId}, Role: ${user.role.name}`);

        // 2. Generate Token
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
        console.log('Generated Token');

        // 3. Instead of fetch (might not be in node), we can just manually call the same logic as the controller
        // Import the controller logic manually
        const Manifest = require('./models/Manifest');
        const Branch = require('./models/Branch');

        // REPLICATE CONTROLLER LOGIC
        let effectiveRole = user.role.name;
        let filters = {};
        const type = 'inward';
        const status = 'in_transit';

        let branchIds = [user.branchId];

        if (type === 'inward') {
            if (branchIds.length > 0) {
                filters.destinationBranch = { $in: branchIds };
            }
            filters.status = status;
        }

        console.log('Simulated Filters:', JSON.stringify(filters, null, 2));

        const results = await Manifest.find(filters).populate('destinationBranch', 'name');
        console.log(`Query Results: ${results.length} manifests found`);
        results.forEach(m => {
            console.log(`- ${m.manifestId} | To: ${m.destinationBranch?.name} | Status: ${m.status}`);
        });

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
};

run();
