const mongoose = require('mongoose');

const inventoryTransactionSchema = new mongoose.Schema({
    type: { type: String, enum: ['INWARD', 'OUTWARD', 'ADJUSTMENT', 'TRANSFER'], required: true },
    quantity: { type: Number, required: true },
    reference: { type: String, trim: true }, // PO number, shipment, etc.
    remarks: { type: String, trim: true },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    performedAt: { type: Date, default: Date.now }
}, { _id: false });

const inventorySchema = new mongoose.Schema({
    skuCode: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    category: {
        type: String,
        enum: ['PACKAGING', 'LABEL', 'CONSUMABLE', 'EQUIPMENT', 'SPARE_PART', 'STATIONERY', 'OTHER'],
        default: 'PACKAGING',
        index: true
    },

    // Stock levels
    quantity: { type: Number, default: 0 },
    reservedQuantity: { type: Number, default: 0 },
    availableQuantity: { type: Number, default: 0 },
    reorderLevel: { type: Number, default: 0 },
    maxLevel: { type: Number, default: 0 },

    // Unit
    unit: { type: String, enum: ['PIECE', 'BOX', 'ROLL', 'KG', 'LITER', 'SET'], default: 'PIECE' },

    // Pricing
    unitCost: { type: Number, default: 0 },
    totalValue: { type: Number, default: 0 },

    // Location
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', index: true },
    warehouseName: { type: String, trim: true },
    storageLocation: { type: String, trim: true }, // rack/bin code

    // Transaction history
    transactions: [inventoryTransactionSchema],

    status: {
        type: String,
        enum: ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'DISCONTINUED'],
        default: 'IN_STOCK',
        index: true
    },

    // Hierarchy / RBAC
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

// Pre-save: compute available and total value
inventorySchema.pre('save', function (next) {
    this.availableQuantity = (this.quantity || 0) - (this.reservedQuantity || 0);
    this.totalValue = (this.quantity || 0) * (this.unitCost || 0);

    if (this.quantity <= 0) {
        this.status = 'OUT_OF_STOCK';
    } else if (this.reorderLevel > 0 && this.quantity <= this.reorderLevel) {
        this.status = 'LOW_STOCK';
    } else {
        this.status = 'IN_STOCK';
    }
    next();
});

module.exports = mongoose.model('Inventory', inventorySchema);
