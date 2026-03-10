const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    code: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        uppercase: true
    },
    partnerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    address: {
        street: String,
        city: String,
        state: String,
        pincode: String,
        country: { type: String, default: 'India' }
    },
    contact: {
        phone: String,
        email: String
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

// Optimize queries by partner
branchSchema.index({ partnerId: 1 });

module.exports = mongoose.model('Branch', branchSchema);
