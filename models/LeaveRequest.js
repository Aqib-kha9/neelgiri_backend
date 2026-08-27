const mongoose = require('mongoose');

/**
 * LeaveRequest.js
 * Manages rider/staff leave requests with approval workflow.
 * Integrates with Attendance to auto-mark leave days.
 */
const leaveRequestSchema = new mongoose.Schema({
    leaveRequestId: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true
    },

    riderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Driver',
        required: true,
        index: true
    },
    riderName: { type: String, required: true, trim: true },
    riderCode: { type: String, trim: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    leaveType: {
        type: String,
        required: true,
        enum: ['casual', 'sick', 'earned', 'unpaid', 'comp_off', 'maternity']
    },

    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    totalDays: { type: Number, required: true, min: 0.5 },

    reason: { type: String, required: true, trim: true },

    // Approval workflow
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'cancelled'],
        default: 'pending',
        index: true
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    approvalNote: { type: String },
    rejectedReason: { type: String },

    // Attachments (medical certificate, etc.)
    attachments: [{
        type: { type: String },
        url: { type: String },
        uploadedAt: { type: Date, default: Date.now }
    }],

    // Scope
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

leaveRequestSchema.index({ riderId: 1, startDate: -1 });
leaveRequestSchema.index({ partnerId: 1, status: 1 });

module.exports = mongoose.model('LeaveRequest', leaveRequestSchema);
