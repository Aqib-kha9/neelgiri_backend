const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema({
    code: {
        type: String,
        unique: true,
        uppercase: true,
        trim: true
    },
    regNo: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true
    },
    type: {
        type: String,
        enum: ['TRUCK_10T', 'TRUCK_5T', 'PICKUP_VAN', 'BIKE', 'CONTAINER_32FT', 'TEMPO', 'MINI_TRUCK'],
        default: 'TRUCK_10T'
    },
    make: { type: String, trim: true },
    model: { type: String, trim: true },
    year: { type: Number },

    driverName: { type: String },
    driverPhone: { type: String },
    assignedDriverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Driver',
        default: null
    },

    capacity: { type: Number, default: 0 }, // kg
    volumetricCapacity: { type: Number, default: 0 }, // cft

    status: {
        type: String,
        enum: ['AVAILABLE', 'IN_TRANSIT', 'MAINTENANCE', 'BREAKDOWN'],
        default: 'AVAILABLE',
        index: true
    },
    currentLocation: { type: String },

    // Compliance
    insuranceExpiry: { type: Date },
    fitnessExpiry: { type: Date },
    pollutionCertExpiry: { type: Date },
    permitType: {
        type: String,
        enum: ['NATIONAL', 'STATE'],
        default: 'NATIONAL'
    },
    permitExpiry: { type: Date },

    fuelType: {
        type: String,
        enum: ['DIESEL', 'PETROL', 'CNG', 'ELECTRIC'],
        default: 'DIESEL'
    },
    ownershipType: {
        type: String,
        enum: ['OWNED', 'LEASED', 'MARKET'],
        default: 'OWNED'
    },

    // Telematics
    gpsDeviceId: { type: String },
    lastServiceDate: { type: Date },
    nextServiceDue: { type: Date },

    // Documents
    documents: [{
        type: { type: String, enum: ['rc', 'insurance', 'fitness', 'pollution', 'permit', 'photo', 'other'] },
        url: String,
        uploadedAt: { type: Date, default: Date.now }
    }],

    // Hierarchy / RBAC
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

vehicleSchema.index({ partnerId: 1, status: 1 });
vehicleSchema.index({ regNo: 'text', make: 'text' });

module.exports = mongoose.model('Vehicle', vehicleSchema);
