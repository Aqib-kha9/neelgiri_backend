const mongoose = require('mongoose');

const bagSchema = new mongoose.Schema({
    bagId: {
        type: String,
        required: true,
        unique: true
    },
    sourceBranch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch'
    },
    destinationBranch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        required: true
    },
    shipments: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Shipment'
    }],
    status: {
        type: String,
        enum: ['open', 'sealed', 'manifested', 'received'],
        default: 'open'
    },
    weight: {
        type: Number,
        default: 0
    },
    sealNumber: String,
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    currentBranch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch'
    },
    history: [{
        status: String,
        timestamp: { type: Date, default: Date.now },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        remark: String
    }]
}, {
    timestamps: true
});

module.exports = mongoose.model('Bag', bagSchema);
