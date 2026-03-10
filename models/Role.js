const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    displayName: {
        type: String,
        required: true
    },
    permissions: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Permission'
    }],
    description: {
        type: String,
        default: ''
    },
    isSystem: {
        type: Boolean,
        default: false, // true for super_admin, etc. (cannot be deleted)
    }
}, { timestamps: true });

module.exports = mongoose.model('Role', roleSchema);
