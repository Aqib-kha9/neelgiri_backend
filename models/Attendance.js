const mongoose = require('mongoose');

/**
 * Attendance.js
 * Tracks daily rider/staff attendance with check-in/check-out times,
 * working hours, overtime, breaks, and status (present/absent/late/half-day).
 * Production-grade: supports manual adjustments, geo-fenced check-in, and leave integration.
 */

const breakSchema = new mongoose.Schema({
    startTime: { type: Date },
    endTime: { type: Date },
    durationMins: { type: Number, default: 0 },
    type: {
        type: String,
        enum: ['lunch', 'tea', 'rest', 'other'],
        default: 'lunch'
    },
    note: { type: String }
}, { _id: false });

const adjustmentSchema = new mongoose.Schema({
    adjustedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    adjustedAt: { type: Date, default: Date.now },
    field: { type: String }, // 'checkIn' | 'checkOut' | 'status' | 'workingHours'
    oldValue: { type: mongoose.Schema.Types.Mixed },
    newValue: { type: mongoose.Schema.Types.Mixed },
    reason: { type: String, required: true }
}, { _id: false });

const attendanceSchema = new mongoose.Schema({
    attendanceId: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true
    },

    // Rider / Staff reference
    riderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Driver',
        required: true,
        index: true
    },
    riderName: { type: String, required: true, trim: true },
    riderCode: { type: String, trim: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // linked User account

    // Date (the working day)
    date: {
        type: Date,
        required: true,
        index: true
    },

    // Shift
    shift: {
        type: String,
        enum: ['morning', 'evening', 'night', 'general', 'custom'],
        default: 'morning'
    },
    shiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
    expectedStartTime: { type: String }, // "08:00"
    expectedEndTime: { type: String },   // "17:00"

    // Check-in / Check-out
    checkIn: { type: Date, default: null },
    checkOut: { type: Date, default: null },
    checkInLocation: {
        latitude: { type: Number },
        longitude: { type: Number },
        address: { type: String }
    },
    checkOutLocation: {
        latitude: { type: Number },
        longitude: { type: Number },
        address: { type: String }
    },

    // Working hours (computed)
    workingHoursMins: { type: Number, default: 0 },
    overtimeMins: { type: Number, default: 0 },
    lateByMins: { type: Number, default: 0 },
    earlyLeaveMins: { type: Number, default: 0 },

    // Breaks
    breaks: [breakSchema],
    totalBreakMins: { type: Number, default: 0 },

    // Status
    status: {
        type: String,
        enum: ['present', 'absent', 'late', 'half-day', 'on_leave', 'holiday', 'weekly_off'],
        default: 'absent',
        index: true
    },

    // Leave reference (if on leave)
    leaveType: {
        type: String,
        enum: ['casual', 'sick', 'earned', 'unpaid', 'comp_off', 'maternity', null],
        default: null
    },
    leaveRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveRequest' },

    // DRS / Deliveries done on this day
    drsIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'DRS' }],
    deliveriesCount: { type: Number, default: 0 },
    deliveriesDelivered: { type: Number, default: 0 },
    deliveriesFailed: { type: Number, default: 0 },

    // Vehicle assigned
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
    vehicleCode: { type: String },

    // Remarks
    remarks: { type: String, trim: true },

    // Manual adjustments history
    adjustments: [adjustmentSchema],
    isAdjusted: { type: Boolean, default: false },

    // Scope
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

// Compound indexes
attendanceSchema.index({ riderId: 1, date: -1 });
attendanceSchema.index({ partnerId: 1, date: -1 });
attendanceSchema.index({ branchId: 1, date: -1 });
attendanceSchema.index({ status: 1, date: -1 });

/**
 * Pre-save: compute working hours, overtime, late, early leave
 */
attendanceSchema.pre('save', function (next) {
    // Compute working hours from check-in to check-out
    if (this.checkIn && this.checkOut) {
        const diffMs = this.checkOut - this.checkIn;
        const totalMins = Math.floor(diffMs / 60000);
        this.workingHoursMins = Math.max(0, totalMins - (this.totalBreakMins || 0));

        // Determine status based on shift thresholds
        if (this.status !== 'on_leave' && this.status !== 'holiday' && this.status !== 'weekly_off') {
            if (this.workingHoursMins < 240) {
                // Less than 4 hours
                if (this.workingHoursMins > 0) {
                    this.status = 'half-day';
                }
            } else {
                this.status = this.lateByMins > 0 ? 'late' : 'present';
            }
        }

        // Compute overtime (beyond 9 hours = 540 mins)
        if (this.workingHoursMins > 540) {
            this.overtimeMins = this.workingHoursMins - 540;
        }

        // Compute late by minutes
        if (this.expectedStartTime && this.checkIn) {
            const [expH, expM] = this.expectedStartTime.split(':').map(Number);
            const checkInDate = new Date(this.checkIn);
            const expectedDate = new Date(checkInDate);
            expectedDate.setHours(expH, expM, 0, 0);
            const lateMs = checkInDate - expectedDate;
            if (lateMs > 0) {
                this.lateByMins = Math.floor(lateMs / 60000);
            }
        }

        // Compute early leave
        if (this.expectedEndTime && this.checkOut) {
            const [expH, expM] = this.expectedEndTime.split(':').map(Number);
            const checkOutDate = new Date(this.checkOut);
            const expectedDate = new Date(checkOutDate);
            expectedDate.setHours(expH, expM, 0, 0);
            const earlyMs = expectedDate - checkOutDate;
            if (earlyMs > 0) {
                this.earlyLeaveMins = Math.floor(earlyMs / 60000);
            }
        }
    }

    next();
});

/**
 * Virtual: formatted working hours (e.g. "8h 30m")
 */
attendanceSchema.virtual('totalHours').get(function () {
    const mins = this.workingHoursMins || 0;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
});

/**
 * Virtual: formatted check-in time
 */
attendanceSchema.virtual('checkInTime').get(function () {
    if (!this.checkIn) return '-';
    return this.checkIn.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
});

/**
 * Virtual: formatted check-out time
 */
attendanceSchema.virtual('checkOutTime').get(function () {
    if (!this.checkOut) return '-';
    return this.checkOut.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
});

attendanceSchema.set('toJSON', { virtuals: true });
attendanceSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
