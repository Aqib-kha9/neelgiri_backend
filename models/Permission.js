const mongoose = require('mongoose');

const permissionSchema = new mongoose.Schema({
    resource: {
        type: String,
        required: true,
        trim: true
    },
    action: {
        type: String,
        required: true,
        enum: ['create', 'read', 'update', 'delete', 'manage'],
        trim: true
    },
    description: {
        type: String,
        required: true
    }
}, { timestamps: true });

// Compound index to ensure unique permission per resource+action
permissionSchema.index({ resource: 1, action: 1 }, { unique: true });

module.exports = mongoose.model('Permission', permissionSchema);
