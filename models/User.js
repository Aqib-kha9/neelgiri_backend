const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    password: {
        type: String,
        required: true,
    },
    role: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Role',
        required: true
    },
    branchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null
    },
    status: {
        type: String,
        default: 'active'
    },
    phone: {
        type: String
    },
    // Hierarchy Fields
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    parentPartner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User', // The top-level Partner Admin for this user strict hierarchy
        default: null
    },
    // For Customers with multiple partners/accounts
    associations: [{
        partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
        roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },
        status: { type: String, default: 'active' },
        isInactive: { type: Boolean, default: false } // Soft disable for specific association
    }],
    isInactive: {
        type: Boolean,
        default: false // Global soft delete/disable
    },
    isPaused: {
        type: Boolean,
        default: false // Temporary suspension
    }
}, {
    timestamps: true
});

// Match user entered password to hashed password in database
userSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

// Encrypt password using bcrypt
// Encrypt password using bcrypt
userSchema.pre('save', async function () {
    if (!this.isModified('password')) {
        return;
    }

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

const User = mongoose.model('User', userSchema);

module.exports = User;
