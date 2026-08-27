/**
 * PickupRequest.js
 *
 * Models a customer pickup request — the very first step in the courier
 * lifecycle. A customer (or branch staff on their behalf) raises a request
 * to have parcels collected from their location. A rider is then assigned
 * to perform a "pickup run", visits the customer, scans each parcel, and
 * brings them back to the origin branch.
 *
 * Lifecycle:
 *   requested → assigned → pickup_started → picked_up → completed
 *   (any stage before pickup_started can be → cancelled)
 */

const mongoose = require('mongoose');

const pickupShipmentSchema = new mongoose.Schema({
    awb: { type: String, trim: true, uppercase: true, default: null },
    shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment', default: null },
    weight: { type: Number, min: 0, default: 0 },
    description: { type: String, default: '' },
    scannedAt: { type: Date },
    scanStatus: {
        type: String,
        enum: ['pending', 'scanned', 'missed', 'rejected'],
        default: 'pending'
    }
}, { _id: false });

const pickupHistorySchema = new mongoose.Schema({
    status: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    remark: { type: String, default: '' }
}, { _id: false });

const pickupRequestSchema = new mongoose.Schema({
    pickupRequestId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    // Customer who requested the pickup
    customer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    customerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Customer'
    },
    // Pickup location details
    pickupAddress: {
        name: { type: String, required: true },
        phone: { type: String, required: true },
        addressLine1: { type: String, required: true },
        addressLine2: { type: String, default: '' },
        city: { type: String, required: true },
        state: { type: String, required: true },
        pincode: { type: String, required: true },
        landmark: { type: String, default: '' },
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null }
    },
    // Scheduling
    preferredDate: { type: Date, required: true },
    preferredTimeSlot: {
        type: String,
        enum: ['09-12', '12-15', '15-18', '18-21', 'ANY'],
        default: 'ANY'
    },
    actualPickupTime: { type: Date, default: null },
    // Assignment
    assignedRider: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    assignedBranch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null
    },
    // Booked shipments and pickup-first estimates
    shipments: [pickupShipmentSchema],
    estimatedPackageCount: { type: Number, min: 0, default: 0 },
    estimatedWeight: { type: Number, min: 0, default: 0 },
    totalShipments: { type: Number, min: 0, default: 0 },
    totalWeight: { type: Number, min: 0, default: 0 },
    priority: {
        type: String,
        enum: ['normal', 'high', 'urgent'],
        default: 'normal'
    },
    packageType: { type: String, trim: true, default: '' },
    // Status
    status: {
        type: String,
        enum: ['requested', 'assigned', 'pickup_started', 'picked_up', 'completed', 'cancelled'],
        default: 'requested',
        index: true
    },
    cancellationReason: { type: String, default: '' },
    completedAt: { type: Date, default: null },
    // Service details
    serviceType: {
        type: String,
        enum: ['SURFACE', 'AIR', 'EXPRESS', 'ALL'],
        default: 'SURFACE'
    },
    paymentMode: {
        type: String,
        enum: ['PREPAID', 'COD', 'CREDIT', 'ALL'],
        default: 'PREPAID'
    },
    // Multi-tenant scoping
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Audit trail
    history: [pickupHistorySchema],
    notes: { type: String, default: '' }
}, { timestamps: true });

// Indexes for efficient querying
pickupRequestSchema.index({ customer: 1, status: 1 });
pickupRequestSchema.index({ assignedRider: 1, status: 1 });
pickupRequestSchema.index({ assignedBranch: 1, status: 1 });
pickupRequestSchema.index({ preferredDate: 1 });
pickupRequestSchema.index({ partnerId: 1, branchId: 1 });

module.exports = mongoose.model('PickupRequest', pickupRequestSchema);
