/**
 * Trip.js
 *
 * A Trip ties together a Vehicle, a Driver, a Route and one or more Manifests.
 * It represents the physical movement of parcels from one location to another
 * via a vehicle. This is the backbone of line-haul / feeder transport.
 *
 * Lifecycle:
 *   planned → loading → departed → in_transit → arrived → completed
 *   (can be → breakdown → reassigned at any transit stage)
 *   (can be → cancelled before departed)
 */

const mongoose = require('mongoose');

const tripStopSchema = new mongoose.Schema({
    location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
    locationName: { type: String, default: '' },
    sequence: { type: Number, default: 0 },
    arrivalTime: { type: Date, default: null },
    departureTime: { type: Date, default: null },
    status: {
        type: String,
        enum: ['pending', 'arrived', 'departed', 'skipped'],
        default: 'pending'
    }
}, { _id: false });

const tripHistorySchema = new mongoose.Schema({
    status: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    location: { type: String, default: '' },
    remark: { type: String, default: '' }
}, { _id: false });

const tripSchema = new mongoose.Schema({
    tripId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    // Vehicle & Driver assignment
    vehicle: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Vehicle',
        default: null
    },
    vehicleNumber: { type: String, default: '' },
    driver: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Driver',
        default: null
    },
    driverName: { type: String, default: '' },
    driverPhone: { type: String, default: '' },
    // Route
    route: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Route',
        default: null
    },
    routeCode: { type: String, default: '' },
    // Origin & Destination
    originBranch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        required: true
    },
    originBranchName: { type: String, default: '' },
    destinationBranch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        required: true
    },
    destinationBranchName: { type: String, default: '' },
    // Manifests carried on this trip
    manifests: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Manifest'
    }],
    // Trip stops (from route, can be overridden)
    stops: [tripStopSchema],
    // Scheduling
    plannedDeparture: { type: Date, default: null },
    actualDeparture: { type: Date, default: null },
    actualArrival: { type: Date, default: null },
    estimatedArrival: { type: Date, default: null },
    // Status
    status: {
        type: String,
        enum: ['planned', 'loading', 'departed', 'in_transit', 'arrived', 'completed', 'breakdown', 'cancelled'],
        default: 'planned',
        index: true
    },
    // Breakdown tracking
    breakdownReason: { type: String, default: '' },
    breakdownAt: { type: Date, default: null },
    reassignedToTrip: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', default: null },
    // Transport details
    transportMode: {
        type: String,
        enum: ['ROAD', 'RAIL', 'AIR', 'WATER'],
        default: 'ROAD'
    },
    vendor: { type: String, default: '' },
    // Stats
    totalManifests: { type: Number, default: 0 },
    totalShipments: { type: Number, default: 0 },
    totalWeight: { type: Number, default: 0 },
    // Multi-tenant scoping
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Audit trail
    history: [tripHistorySchema],
    notes: { type: String, default: '' }
}, { timestamps: true });

// Indexes
tripSchema.index({ originBranch: 1, destinationBranch: 1, status: 1 });
tripSchema.index({ vehicle: 1, status: 1 });
tripSchema.index({ driver: 1, status: 1 });
tripSchema.index({ partnerId: 1, branchId: 1 });
tripSchema.index({ plannedDeparture: 1 });

module.exports = mongoose.model('Trip', tripSchema);
