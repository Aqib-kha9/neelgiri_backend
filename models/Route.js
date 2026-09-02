const mongoose = require('mongoose');

const routeStopSchema = new mongoose.Schema({
    hubId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
    hubCode: String,
    hubName: String,
    sequence: { type: Number, required: true },
    distanceFromPrevKm: { type: Number, default: 0 },
    transitTimeFromPrevMins: { type: Number, default: 0 },
    haltTimeMins: { type: Number, default: 0 }
}, { _id: true });

const routeSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, index: true },
    name: { type: String, trim: true },
    sourceCity: { type: String, required: true, trim: true },
    destinationCity: { type: String, required: true, trim: true },
    sourceHub: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
    sourceHubName: String,
    destinationHub: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
    destinationHubName: String,

    totalDistanceKm: { type: Number, default: 0 },
    totalTransitTimeHours: { type: Number, default: 0 },
    finalLegDistanceKm: { type: Number, default: 0, min: 0 },
    finalLegTransitTimeMins: { type: Number, default: 0, min: 0 },

    stops: [routeStopSchema],

    schedule: [{ type: String, enum: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN', 'DAILY'] }],
    departureTime: { type: String, default: '00:00' },

    status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'BLOCKED'], default: 'ACTIVE' },
    type: { type: String, enum: ['LINEHAUL', 'FEEDER', 'LAST_MILE'], default: 'LINEHAUL' },
    isReturnRoute: { type: Boolean, default: false },
    returnRouteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route' },

    baseCost: { type: Number, default: 0 },
    vehicleTypeRequired: { type: String, default: '' },

    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted: { type: Boolean, default: false }
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

// Pre-save: calculate the complete origin-to-destination movement, including the final leg.
routeSchema.pre('save', function () {
    const intermediateDistance = (this.stops || []).reduce(
        (sum, stop) => sum + (stop.distanceFromPrevKm || 0), 0
    );
    const intermediateMinutes = (this.stops || []).reduce(
        (sum, stop) => sum + (stop.transitTimeFromPrevMins || 0) + (stop.haltTimeMins || 0), 0
    );

    this.totalDistanceKm = intermediateDistance + (this.finalLegDistanceKm || 0);
    this.totalTransitTimeHours = Math.round(
        ((intermediateMinutes + (this.finalLegTransitTimeMins || 0)) / 60) * 100
    ) / 100;
});

module.exports = mongoose.model('Route', routeSchema);
