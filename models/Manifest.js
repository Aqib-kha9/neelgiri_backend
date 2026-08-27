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
    // Enhanced: scanned shipments for inbound reconciliation
    scannedShipments: [{
        shipment: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment' },
        awb: String,
        scannedAt: { type: Date, default: Date.now },
        scannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        scanStatus: { type: String, enum: ['received', 'missing', 'damaged', 'extra'], default: 'received' }
    }],
    transportDetails: {
        mode: { type: String, enum: ['air', 'surface', 'train', 'ROAD', 'RAIL', 'AIR', 'WATER'], default: 'surface' },
        vehicleNo: String,
        driverName: String,
        driverPhone: String,
        vendor: String,
        remark: String
    },
    // Enhanced lifecycle status
    status: {
        type: String,
        enum: [
            'open',              // Being created, shipments being added
            'closed',            // Closed for adding, ready for vehicle assignment
            'vehicle_assigned',  // Vehicle/trip assigned
            'in_transit',        // Departed origin, on the way
            'delayed',           // Trip breakdown / delay — parcels held mid-transit
            'arrived',           // Arrived at destination branch
            'received',          // Inbound scan completed at destination
            'complete',          // Fully processed (legacy compat)
            'cancelled'          // Cancelled
        ],
        default: 'open'
    },
    bagTags: [{
        type: String // Optional: link to Bag Tag IDs
    }],
    // Enhanced: Trip linkage
    tripId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Trip'
    },
    tripCode: String,
    // Enhanced: lifecycle timestamps
    closedAt: { type: Date },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    vehicleAssignedAt: { type: Date },
    vehicleAssignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    departedAt: { type: Date },
    departedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    arrivedAt: { type: Date },
    arrivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receivedAt: { type: Date },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    stats: {
        totalShipments: { type: Number, default: 0 },
        totalWeight: { type: Number, default: 0 },
        receivedShipments: { type: Number, default: 0 },
        missingShipments: { type: Number, default: 0 },
        damagedShipments: { type: Number, default: 0 },
        extraShipments: { type: Number, default: 0 }
    },
    // Enhanced: reconciliation flags
    reconciliationStatus: {
        type: String,
        enum: ['pending', 'matched', 'mismatch', 'partial'],
        default: 'pending'
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

// Indexes
manifestSchema.index({ sourceBranch: 1, status: 1 });
manifestSchema.index({ destinationBranch: 1, status: 1 });
manifestSchema.index({ tripId: 1 });
manifestSchema.index({ partnerId: 1, branchId: 1 });
manifestSchema.index({ manifestId: 'text' });

module.exports = mongoose.model('Manifest', manifestSchema);
