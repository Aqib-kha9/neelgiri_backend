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
    // Enhanced: scanned shipments with per-parcel scan tracking
    scannedShipments: [{
        shipment: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment' },
        awb: String,
        scannedAt: { type: Date, default: Date.now },
        scannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        scanStatus: { type: String, enum: ['scanned_in', 'missing', 'extra'], default: 'scanned_in' }
    }],
    status: {
        type: String,
        enum: ['open', 'sealed', 'seal_verified', 'manifested', 'in_transit', 'arrived', 'received', 'opened'],
        default: 'open'
    },
    weight: {
        type: Number,
        default: 0
    },
    // Enhanced: weight reconciliation
    declaredWeight: { type: Number, default: 0 },
    actualWeight: { type: Number, default: 0 },
    weightVerified: { type: Boolean, default: false },
    sealNumber: String,
    // Enhanced: seal lifecycle
    sealedAt: { type: Date },
    sealedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sealVerifiedAt: { type: Date },
    sealVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isSealIntact: { type: Boolean, default: null },
    sealBrokenReason: String,
    openedAt: { type: Date },
    openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Link to manifest
    manifestId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Manifest'
    },
    // Multi-tenant scoping
    partnerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Partner'
    },
    branchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch'
    },
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

// Indexes
bagSchema.index({ destinationBranch: 1, status: 1 });
bagSchema.index({ currentBranch: 1, status: 1 });
bagSchema.index({ sealNumber: 1 }, { sparse: true });
bagSchema.index({ partnerId: 1, branchId: 1 });

module.exports = mongoose.model('Bag', bagSchema);
