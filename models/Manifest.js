const mongoose = require('mongoose');

const manifestSchema = new mongoose.Schema({
    manifestId: {
        type: String,
        required: true,
        unique: true
    },
    sourceBranch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        required: true
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
    transportDetails: {
        mode: { type: String, enum: ['air', 'surface', 'train'], default: 'surface' },
        vehicleNo: String,
        driverName: String,
        driverPhone: String,
        vendor: String
    },
    status: {
        type: String,
        enum: [
            'complete',
            'in_transit',
            'received'
        ],
        default: 'in_transit'
    },
    bagTags: [{
        type: String // Optional: link to Bag Tag IDs
    }],
    stats: {
        totalShipments: { type: Number, default: 0 },
        totalWeight: { type: Number, default: 0 }
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    history: [{
        status: String,
        timestamp: { type: Date, default: Date.now },
        forwarded_at: Date,
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        remark: String
    }]
}, {
    timestamps: true
});

module.exports = mongoose.model('Manifest', manifestSchema);
