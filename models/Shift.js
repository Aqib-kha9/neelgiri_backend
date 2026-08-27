const mongoose = require('mongoose');

/**
 * Shift.js
 * Defines work shifts (morning / evening / night) with start/end times,
 * grace period for late marking, and break configuration.
 * Production-grade: supports per-branch shift overrides.
 */
const shiftSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
        enum: ['morning', 'evening', 'night', 'general', 'custom']
    },
    label: { type: String, required: true, trim: true }, // e.g. "Morning Shift"
    startTime: {
        type: String,
        required: true,
        trim: true // "08:00"
    },
    endTime: {
        type: String,
        required: true,
        trim: true // "17:00"
    },
    gracePeriodMins: {
        type: Number,
        default: 15 // minutes after startTime before marking late
    },
    halfDayThresholdMins: {
        type: Number,
        default: 240 // 4 hours = half day
    },
    fullDayThresholdMins: {
        type: Number,
        default: 420 // 7 hours = full day
    },
    breakDurationMins: {
        type: Number,
        default: 30
    },
    overtimeThresholdMins: {
        type: Number,
        default: 540 // 9 hours = overtime starts
    },
    color: { type: String, default: '#3b82f6' }, // for UI display
    isActive: { type: Boolean, default: true },

    // Scope
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

shiftSchema.index({ partnerId: 1, name: 1, branchId: 1 });

module.exports = mongoose.model('Shift', shiftSchema);
