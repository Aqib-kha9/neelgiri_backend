const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const dotenv = require('dotenv');
const User = require('./models/User');

dotenv.config();

const fixPassword = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const email = 'deepanshu@gmail.com';
        const password = '123123';

        const user = await User.findOne({ email });

        if (!user) {
            console.log('User not found');
            process.exit(1);
        }

        console.log('User found. Updating password to:', password);
        user.password = password;
        await user.save();

        console.log('Password updated.');
        console.log('New Hash:', user.password);

        // Verify immediately
        const isMatch = await bcrypt.compare(password, user.password);
        console.log(`Verification: Comparing '${password}' with new hash:`, isMatch);

        process.exit();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
};

fixPassword();
