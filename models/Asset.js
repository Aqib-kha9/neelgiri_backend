const mongoose = require('mongoose');

const assetSchema = new mongoose.Schema({
    assetCode: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    type: {
        type: String,
        enum: ['SCANNER', 'PRINTER', 'COMPUTER', 'VEHICLE', 'WEIGHING_SCALE', 'FORKLIFT', 'CONVEYOR', 'RACK', 'OTHER'],
        default: 'OTHER',
        index: true
    },

    // Assignment
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedToName: { type: String, trim: true },
    assignedAt: { type: Date },

    // Location
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
    warehouseName: { type: String, trim: true },
    branchId: { type: mongoose.Schema.Types.Mixed },

    // Purchase info
    purchaseDate: { type: Date },
    purchasePrice: { type: Number, default: 0 },
    vendor: { type: String, trim: true },
    warrantyExpiry: { type: Date },

    // Depreciation
    depreciationRate: { type: Number, default: 15 }, // percentage per year
    currentValue: { type: Number, default: 0 },

    // Maintenance
    lastMaintenanceDate: { type: Date },
    nextMaintenanceDate: { type: Date },
    maintenanceHistory: [{
        date: { type: Date, default: Date.now },
        description: { type: String, trim: true },
        cost: { type: Number, default: 0 },
        performedBy: { type: String, trim: true }
    }],

    status: {
        type: String,
        enum: ['ACTIVE', 'ASSIGNED', 'MAINTENANCE', 'RETIRED', 'LOST'],
        default: 'ACTIVE',
        index: true
    },

    // Hierarchy / RBAC
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Asset', assetSchema);
