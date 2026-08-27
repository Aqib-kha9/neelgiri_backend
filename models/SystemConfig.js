const mongoose = require('mongoose');

const configSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, index: true, trim: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    dataType: { type: String, enum: ['STRING', 'NUMBER', 'BOOLEAN', 'JSON', 'ARRAY'], default: 'STRING' },

    category: {
        type: String,
        enum: ['GENERAL', 'SHIPMENT', 'PRICING', 'NOTIFICATION', 'INTEGRATION', 'WORKFLOW', 'SECURITY', 'APPEARANCE'],
        default: 'GENERAL'
    },
    group: { type: String, default: 'general' },

    label: { type: String, trim: true },
    description: { type: String, trim: true },

    isSystem: { type: Boolean, default: false },
    isEditable: { type: Boolean, default: true },
    isEncrypted: { type: Boolean, default: false },

    validation: {
        min: Number,
        max: Number,
        pattern: String,
        allowedValues: [mongoose.Schema.Types.Mixed]
    },

    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

module.exports = mongoose.model('SystemConfig', configSchema);
