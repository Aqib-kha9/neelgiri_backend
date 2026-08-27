const mongoose = require('mongoose');

const stockReconciliationSchema = new mongoose.Schema({
    reconciliationId: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },

    // Item details
    itemName: { type: String, required: true, trim: true, index: true },
    sku: { type: String, required: true, trim: true, index: true },
    category: { type: String, trim: true, default: 'GENERAL' },

    // Inventory link (optional - can reconcile against a specific inventory item)
    inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory' },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },

    // Quantities
    expectedQty: { type: Number, required: true, default: 0 },
    actualQty: { type: Number, default: null },
    variance: { type: Number, default: 0 },
    variancePercent: { type: Number, default: 0 },

    // Status workflow
    status: {
        type: String,
        enum: ['pending', 'in-progress', 'resolved', 'discrepancy'],
        default: 'pending',
        index: true
    },

    // Reconciliation metadata
    reconciledBy: { type: String, trim: true },
    reconciledDate: { type: Date },
    location: { type: String, trim: true },
    notes: { type: String, trim: true, default: '' },

    // Resolution
    resolutionNotes: { type: String, trim: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },

    // Adjustment applied to inventory
    adjustmentApplied: { type: Boolean, default: false },

    // Hierarchy / RBAC
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

// Pre-save hook to compute variance
stockReconciliationSchema.pre('save', function (next) {
    if (this.actualQty !== null && this.actualQty !== undefined) {
        this.variance = this.actualQty - this.expectedQty;
        this.variancePercent = this.expectedQty > 0
            ? Number(((this.variance / this.expectedQty) * 100).toFixed(2))
            : 0;
    }
    next();
});

stockReconciliationSchema.index({ sku: 1, status: 1 });
stockReconciliationSchema.index({ warehouseId: 1, status: 1 });

module.exports = mongoose.model('StockReconciliation', stockReconciliationSchema);
