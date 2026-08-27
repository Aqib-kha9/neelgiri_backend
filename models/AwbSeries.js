const mongoose = require('mongoose');

const awbAllocationSchema = new mongoose.Schema({
    startNumber: { type: Number, required: true },
    endNumber: { type: Number, required: true },
    allocatedToType: {
        type: String,
        enum: ['branch', 'customer', 'partner'],
        default: 'branch'
    },
    allocatedToId: { type: mongoose.Schema.Types.Mixed },
    allocatedToName: { type: String, default: 'Legacy allocation', trim: true },
    allocatedToCode: { type: String, trim: true },
    allocatedAt: { type: Date, default: Date.now },
    allocatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    consumedCount: { type: Number, default: 0, min: 0 },
    lastConsumedNumber: {
        type: Number,
        default: function () {
            return this.startNumber - 1;
        }
    }
});

const awbSeriesSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    prefix: { type: String, required: true, uppercase: true, trim: true }, // e.g. 'AWB'
    name: { type: String, required: true, trim: true },
    description: { type: String },

    startNumber: { type: Number, required: true },
    endNumber: { type: Number, required: true },
    numberWidth: {
        type: Number,
        min: 1,
        default: function () {
            return String(this.endNumber || 0).length;
        }
    },
    currentNumber: { type: Number, default: 0 }, // first number after the highest allocated range

    // Pool of numbers allocated to sub-entities
    allocations: [awbAllocationSchema],

    status: {
        type: String,
        enum: ['ACTIVE', 'EXHAUSTED', 'INACTIVE'],
        default: 'ACTIVE',
        index: true
    },

    // Hierarchy / RBAC
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

// Virtual: total capacity
awbSeriesSchema.virtual('totalCapacity').get(function () {
    return this.endNumber - this.startNumber + 1;
});

// Virtual: total allocated
awbSeriesSchema.virtual('totalAllocated').get(function () {
    return (this.allocations || []).reduce((sum, a) => sum + (a.endNumber - a.startNumber + 1), 0);
});

// Virtual: total consumed
awbSeriesSchema.virtual('totalConsumed').get(function () {
    return (this.allocations || []).reduce((sum, a) => sum + (a.consumedCount || 0), 0);
});

awbSeriesSchema.virtual('totalUnallocated').get(function () {
    return Math.max(0, this.totalCapacity - this.totalAllocated);
});

awbSeriesSchema.virtual('totalAvailable').get(function () {
    return Math.max(0, this.totalAllocated - this.totalConsumed);
});

awbSeriesSchema.set('toJSON', { virtuals: true });
awbSeriesSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('AwbSeries', awbSeriesSchema);
