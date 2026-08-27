/**
 * attendanceController.js
 * Production-grade Attendance & Shift Management controller.
 *
 * Endpoints:
 *  Attendance:
 *    - getAttendance (paginated list with filters)
 *    - getAttendanceStats (present/absent/late/half-day counts)
 *    - getAttendanceById
 *    - checkIn (rider check-in with geo-location)
 *    - checkOut (rider check-out with geo-location)
 *    - createAttendance (manual entry)
 *    - updateAttendance
 *    - adjustAttendance (manual time adjustment with reason)
 *    - deleteAttendance (soft delete)
 *    - getRiderAttendanceHistory (rider-wise history)
 *    - bulkMarkAttendance (bulk mark absent/holiday/weekly-off)
 *
 *  Shifts:
 *    - getShifts
 *    - getShiftById
 *    - createShift
 *    - updateShift
 *    - deleteShift
 *
 *  Leave Requests:
 *    - getLeaveRequests
 *    - getLeaveRequestById
 *    - createLeaveRequest
 *    - approveLeaveRequest
 *    - rejectLeaveRequest
 *    - cancelLeaveRequest
 *    - deleteLeaveRequest
 */

const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const Shift = require('../models/Shift');
const LeaveRequest = require('../models/LeaveRequest');
const Driver = require('../models/Driver');
const DRS = require('../models/DRS');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');
const { generateAttendanceId, generateLeaveRequestId, generateShiftId } = require('../utils/idGenerator');

/* ============================================================
   ATTENDANCE
   ============================================================ */

// @desc    Get attendance records (paginated, filtered)
// @route   GET /api/attendance
// @access  Private
exports.getAttendance = async (req, res) => {
    try {
        const scope = buildScopeQuery(req.user);
        if (scope === null) return res.json({ data: [], total: 0, page: 1, pages: 1 });

        const {
            page = 1,
            limit = 20,
            search,
            status,
            shift,
            date,
            startDate,
            endDate,
            riderId,
            branchId
        } = req.query;

        const query = { isDeleted: false, ...scope };

        // Date filter
        if (date) {
            const dayStart = new Date(date);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(date);
            dayEnd.setHours(23, 59, 59, 999);
            query.date = { $gte: dayStart, $lte: dayEnd };
        } else if (startDate && endDate) {
            const s = new Date(startDate); s.setHours(0, 0, 0, 0);
            const e = new Date(endDate); e.setHours(23, 59, 59, 999);
            query.date = { $gte: s, $lte: e };
        }

        if (status) query.status = status;
        if (shift) query.shift = shift;
        if (riderId) query.riderId = riderId;
        if (branchId) query.branchId = branchId;

        if (search) {
            query.$or = [
                { riderName: { $regex: search, $options: 'i' } },
                { riderCode: { $regex: search, $options: 'i' } }
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [total, records] = await Promise.all([
            Attendance.countDocuments(query),
            Attendance.find(query)
                .populate('riderId', 'name code phone')
                .sort({ date: -1, checkIn: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean()
        ]);

        res.json({
            data: records,
            total,
            page: parseInt(page),
            pages: Math.ceil(total / parseInt(limit))
        });
    } catch (err) {
        console.error('[getAttendance] Error:', err);
        res.status(500).json({ message: 'Server error fetching attendance' });
    }
};

// @desc    Get attendance stats
// @route   GET /api/attendance/stats
// @access  Private
exports.getAttendanceStats = async (req, res) => {
    try {
        const scope = buildScopeQuery(req.user);
        if (scope === null) return res.json({});

        const { date } = req.query;
        const targetDate = date ? new Date(date) : new Date();
        const dayStart = new Date(targetDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(targetDate);
        dayEnd.setHours(23, 59, 59, 999);

        const query = { isDeleted: false, ...scope, date: { $gte: dayStart, $lte: dayEnd } };

        const [present, absent, late, halfDay, onLeave, total] = await Promise.all([
            Attendance.countDocuments({ ...query, status: 'present' }),
            Attendance.countDocuments({ ...query, status: 'absent' }),
            Attendance.countDocuments({ ...query, status: 'late' }),
            Attendance.countDocuments({ ...query, status: 'half-day' }),
            Attendance.countDocuments({ ...query, status: 'on_leave' }),
            Attendance.countDocuments(query)
        ]);

        // Shift coverage
        const shiftBreakdown = await Attendance.aggregate([
            { $match: { ...query } },
            { $group: { _id: '$shift', count: { $sum: 1 } } }
        ]);

        // Average late minutes
        const lateAgg = await Attendance.aggregate([
            { $match: { ...query, status: 'late' } },
            { $group: { _id: null, avgLateMins: { $avg: '$lateByMins' }, totalLate: { $sum: 1 } } }
        ]);

        // Total overtime
        const overtimeAgg = await Attendance.aggregate([
            { $match: { ...query, overtimeMins: { $gt: 0 } } },
            { $group: { _id: null, totalOvertimeMins: { $sum: '$overtimeMins' }, count: { $sum: 1 } } }
        ]);

        res.json({
            date: targetDate.toISOString().split('T')[0],
            total,
            present,
            absent,
            late,
            halfDay,
            onLeave,
            attendanceRate: total > 0 ? (((present + late + halfDay) / total) * 100).toFixed(1) : 0,
            shiftBreakdown: shiftBreakdown.reduce((acc, s) => {
                acc[s._id] = s.count;
                return acc;
            }, {}),
            avgLateMins: lateAgg.length > 0 ? Math.round(lateAgg[0].avgLateMins) : 0,
            totalOvertimeMins: overtimeAgg.length > 0 ? overtimeAgg[0].totalOvertimeMins : 0,
            overtimeCount: overtimeAgg.length > 0 ? overtimeAgg[0].count : 0
        });
    } catch (err) {
        console.error('[getAttendanceStats] Error:', err);
        res.status(500).json({ message: 'Server error fetching attendance stats' });
    }
};

// @desc    Get attendance by ID
// @route   GET /api/attendance/:id
// @access  Private
exports.getAttendanceById = async (req, res) => {
    try {
        const record = await Attendance.findById(req.params.id)
            .populate('riderId', 'name code phone')
            .populate('drsIds', 'drsId status stats')
            .populate('vehicleId', 'vehicleNumber type');

        if (!record || record.isDeleted) {
            return res.status(404).json({ message: 'Attendance record not found' });
        }

        res.json(record);
    } catch (err) {
        console.error('[getAttendanceById] Error:', err);
        res.status(500).json({ message: 'Server error fetching attendance record' });
    }
};

// @desc    Rider check-in
// @route   POST /api/attendance/check-in
// @access  Private
exports.checkIn = async (req, res) => {
    try {
        const { riderId, shift, latitude, longitude, address, vehicleId } = req.body;

        if (!riderId) {
            return res.status(400).json({ message: 'riderId is required' });
        }

        const rider = await Driver.findById(riderId);
        if (!rider) {
            return res.status(404).json({ message: 'Rider not found' });
        }

        // Check if already checked in today
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const existing = await Attendance.findOne({
            riderId,
            date: { $gte: today, $lt: tomorrow },
            isDeleted: false
        });

        if (existing && existing.checkIn) {
            return res.status(400).json({ message: 'Already checked in today', record: existing });
        }

        // Find shift config
        let shiftConfig = null;
        if (shift) {
            shiftConfig = await Shift.findOne({
                name: shift,
                isDeleted: false,
                $or: [
                    { partnerId: getEffectivePartnerId(req.user) },
                    { partnerId: null }
                ]
            });
        }

        const now = new Date();
        const expectedStartTime = shiftConfig?.startTime || (shift === 'evening' ? '14:00' : shift === 'night' ? '22:00' : '08:00');

        // Calculate late by minutes
        const [expH, expM] = expectedStartTime.split(':').map(Number);
        const expectedDate = new Date(now);
        expectedDate.setHours(expH, expM, 0, 0);
        const lateByMins = now > expectedDate ? Math.floor((now - expectedDate) / 60000) : 0;

        let record;
        if (existing) {
            // Update existing record (was marked absent/holiday)
            existing.checkIn = now;
            existing.status = lateByMins > (shiftConfig?.gracePeriodMins || 15) ? 'late' : 'present';
            existing.lateByMins = lateByMins;
            existing.shift = shift || existing.shift;
            existing.expectedStartTime = expectedStartTime;
            existing.expectedEndTime = shiftConfig?.endTime || (shift === 'evening' ? '22:00' : shift === 'night' ? '06:00' : '17:00');
            if (latitude && longitude) {
                existing.checkInLocation = { latitude, longitude, address };
            }
            if (vehicleId) {
                existing.vehicleId = vehicleId;
            }
            record = await existing.save();
        } else {
            record = await Attendance.create({
                attendanceId: generateAttendanceId(),
                riderId,
                riderName: rider.name,
                riderCode: rider.code,
                userId: rider.userId || null,
                date: today,
                shift: shift || 'morning',
                shiftId: shiftConfig?._id,
                expectedStartTime,
                expectedEndTime: shiftConfig?.endTime || '17:00',
                checkIn: now,
                checkInLocation: latitude && longitude ? { latitude, longitude, address } : undefined,
                status: lateByMins > (shiftConfig?.gracePeriodMins || 15) ? 'late' : 'present',
                lateByMins,
                vehicleId: vehicleId || null,
                partnerId: getEffectivePartnerId(req.user) || rider.partnerId,
                branchId: getEffectiveBranchId(req.user) || rider.branchId,
                createdBy: req.user._id
            });
        }

        await logAudit(req, {
            action: 'CHECK_IN',
            resource: 'attendance',
            resourceId: record._id,
            description: `Rider ${rider.name} checked in at ${now.toLocaleTimeString()}`,
            details: { riderId, shift, lateByMins, location: { latitude, longitude } }
        });

        res.status(201).json(record);
    } catch (err) {
        console.error('[checkIn] Error:', err);
        res.status(500).json({ message: 'Server error during check-in' });
    }
};

// @desc    Rider check-out
// @route   POST /api/attendance/check-out
// @access  Private
exports.checkOut = async (req, res) => {
    try {
        const { riderId, latitude, longitude, address } = req.body;

        if (!riderId) {
            return res.status(400).json({ message: 'riderId is required' });
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const record = await Attendance.findOne({
            riderId,
            date: { $gte: today, $lt: tomorrow },
            isDeleted: false
        });

        if (!record) {
            return res.status(404).json({ message: 'No check-in record found for today' });
        }

        if (!record.checkIn) {
            return res.status(400).json({ message: 'Rider has not checked in yet' });
        }

        if (record.checkOut) {
            return res.status(400).json({ message: 'Already checked out today' });
        }

        const now = new Date();
        record.checkOut = now;
        if (latitude && longitude) {
            record.checkOutLocation = { latitude, longitude, address };
        }

        // Fetch DRS stats for today
        const todayDRS = await DRS.find({
            rider: riderId,
            scheduledDate: { $gte: today, $lt: tomorrow },
            isDeleted: false
        }).select('drsId status stats');

        if (todayDRS.length > 0) {
            record.drsIds = todayDRS.map(d => d._id);
            record.deliveriesCount = todayDRS.reduce((sum, d) => sum + (d.stats?.total || 0), 0);
            record.deliveriesDelivered = todayDRS.reduce((sum, d) => sum + (d.stats?.delivered || 0), 0);
            record.deliveriesFailed = todayDRS.reduce((sum, d) => sum + (d.stats?.failed || 0), 0);
        }

        await record.save();

        await logAudit(req, {
            action: 'CHECK_OUT',
            resource: 'attendance',
            resourceId: record._id,
            description: `Rider checked out at ${now.toLocaleTimeString()}`,
            details: { riderId, workingHoursMins: record.workingHoursMins, overtimeMins: record.overtimeMins }
        });

        res.json(record);
    } catch (err) {
        console.error('[checkOut] Error:', err);
        res.status(500).json({ message: 'Server error during check-out' });
    }
};

// @desc    Create attendance record (manual)
// @route   POST /api/attendance
// @access  Private
exports.createAttendance = async (req, res) => {
    try {
        const {
            riderId,
            date,
            shift,
            checkIn,
            checkOut,
            status,
            vehicleId,
            remarks,
            leaveType
        } = req.body;

        if (!riderId || !date) {
            return res.status(400).json({ message: 'riderId and date are required' });
        }

        const rider = await Driver.findById(riderId);
        if (!rider) {
            return res.status(404).json({ message: 'Rider not found' });
        }

        // Check for duplicate
        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(date);
        dayEnd.setHours(23, 59, 59, 999);

        const existing = await Attendance.findOne({
            riderId,
            date: { $gte: dayStart, $lte: dayEnd },
            isDeleted: false
        });

        if (existing) {
            return res.status(409).json({ message: 'Attendance already exists for this rider on this date' });
        }

        const record = await Attendance.create({
            attendanceId: generateAttendanceId(),
            riderId,
            riderName: rider.name,
            riderCode: rider.code,
            userId: rider.userId || null,
            date: dayStart,
            shift: shift || 'morning',
            checkIn: checkIn ? new Date(checkIn) : null,
            checkOut: checkOut ? new Date(checkOut) : null,
            status: status || 'absent',
            vehicleId: vehicleId || null,
            remarks: remarks || '',
            leaveType: leaveType || null,
            partnerId: getEffectivePartnerId(req.user) || rider.partnerId,
            branchId: getEffectiveBranchId(req.user) || rider.branchId,
            createdBy: req.user._id
        });

        await logAudit(req, {
            action: 'CREATE',
            resource: 'attendance',
            resourceId: record._id,
            description: `Created attendance record for ${rider.name} on ${dayStart.toISOString().split('T')[0]}`,
            details: { riderId, date, shift, status }
        });

        res.status(201).json(record);
    } catch (err) {
        console.error('[createAttendance] Error:', err);
        res.status(500).json({ message: 'Server error creating attendance record' });
    }
};

// @desc    Update attendance record
// @route   PUT /api/attendance/:id
// @access  Private
exports.updateAttendance = async (req, res) => {
    try {
        const record = await Attendance.findById(req.params.id);
        if (!record || record.isDeleted) {
            return res.status(404).json({ message: 'Attendance record not found' });
        }

        const allowedFields = [
            'shift', 'checkIn', 'checkOut', 'status', 'vehicleId',
            'remarks', 'leaveType', 'expectedStartTime', 'expectedEndTime'
        ];

        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) {
                record[field] = req.body[field];
            }
        });

        await record.save();

        await logAudit(req, {
            action: 'UPDATE',
            resource: 'attendance',
            resourceId: record._id,
            description: `Updated attendance record`,
            details: req.body
        });

        res.json(record);
    } catch (err) {
        console.error('[updateAttendance] Error:', err);
        res.status(500).json({ message: 'Server error updating attendance record' });
    }
};

// @desc    Adjust attendance (manual time adjustment with reason)
// @route   PUT /api/attendance/:id/adjust
// @access  Private
exports.adjustAttendance = async (req, res) => {
    try {
        const { field, newValue, reason } = req.body;

        if (!field || !reason) {
            return res.status(400).json({ message: 'field and reason are required' });
        }

        const record = await Attendance.findById(req.params.id);
        if (!record || record.isDeleted) {
            return res.status(404).json({ message: 'Attendance record not found' });
        }

        const oldValue = record[field];
        record[field] = newValue;
        record.isAdjusted = true;
        record.adjustments.push({
            adjustedBy: req.user._id,
            field,
            oldValue,
            newValue,
            reason
        });

        await record.save();

        await logAudit(req, {
            action: 'ADJUST',
            resource: 'attendance',
            resourceId: record._id,
            description: `Adjusted ${field} for attendance record`,
            details: { field, oldValue, newValue, reason }
        });

        res.json(record);
    } catch (err) {
        console.error('[adjustAttendance] Error:', err);
        res.status(500).json({ message: 'Server error adjusting attendance' });
    }
};

// @desc    Delete attendance (soft delete)
// @route   DELETE /api/attendance/:id
// @access  Private
exports.deleteAttendance = async (req, res) => {
    try {
        const record = await Attendance.findById(req.params.id);
        if (!record || record.isDeleted) {
            return res.status(404).json({ message: 'Attendance record not found' });
        }

        record.isDeleted = true;
        record.deletedBy = req.user._id;
        await record.save();

        await logAudit(req, {
            action: 'DELETE',
            resource: 'attendance',
            resourceId: record._id,
            description: `Deleted attendance record`
        });

        res.json({ message: 'Attendance record deleted successfully' });
    } catch (err) {
        console.error('[deleteAttendance] Error:', err);
        res.status(500).json({ message: 'Server error deleting attendance record' });
    }
};

// @desc    Get rider attendance history
// @route   GET /api/attendance/rider/:riderId/history
// @access  Private
exports.getRiderAttendanceHistory = async (req, res) => {
    try {
        const { riderId } = req.params;
        const { startDate, endDate, limit = 30 } = req.query;

        const query = { riderId, isDeleted: false };

        if (startDate && endDate) {
            const s = new Date(startDate); s.setHours(0, 0, 0, 0);
            const e = new Date(endDate); e.setHours(23, 59, 59, 999);
            query.date = { $gte: s, $lte: e };
        }

        const records = await Attendance.find(query)
            .sort({ date: -1 })
            .limit(parseInt(limit))
            .lean();

        // Summary stats
        const stats = await Attendance.aggregate([
            { $match: query },
            {
                $group: {
                    _id: null,
                    totalDays: { $sum: 1 },
                    presentDays: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
                    lateDays: { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } },
                    absentDays: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
                    halfDays: { $sum: { $cond: [{ $eq: ['$status', 'half-day'] }, 1, 0] } },
                    leaveDays: { $sum: { $cond: [{ $eq: ['$status', 'on_leave'] }, 1, 0] } },
                    totalWorkingMins: { $sum: '$workingHoursMins' },
                    totalOvertimeMins: { $sum: '$overtimeMins' },
                    totalLateMins: { $sum: '$lateByMins' },
                    totalDeliveries: { $sum: '$deliveriesDelivered' }
                }
            }
        ]);

        res.json({
            records,
            summary: stats[0] || {
                totalDays: 0, presentDays: 0, lateDays: 0, absentDays: 0,
                halfDays: 0, leaveDays: 0, totalWorkingMins: 0,
                totalOvertimeMins: 0, totalLateMins: 0, totalDeliveries: 0
            }
        });
    } catch (err) {
        console.error('[getRiderAttendanceHistory] Error:', err);
        res.status(500).json({ message: 'Server error fetching rider attendance history' });
    }
};

// @desc    Bulk mark attendance (absent/holiday/weekly-off)
// @route   POST /api/attendance/bulk
// @access  Private
exports.bulkMarkAttendance = async (req, res) => {
    try {
        const { riderIds, date, status, shift, remarks } = req.body;

        if (!riderIds || !Array.isArray(riderIds) || riderIds.length === 0) {
            return res.status(400).json({ message: 'riderIds array is required' });
        }
        if (!date || !status) {
            return res.status(400).json({ message: 'date and status are required' });
        }

        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(date);
        dayEnd.setHours(23, 59, 59, 999);

        const results = [];

        for (const riderId of riderIds) {
            const rider = await Driver.findById(riderId);
            if (!rider) continue;

            // Check existing
            const existing = await Attendance.findOne({
                riderId,
                date: { $gte: dayStart, $lte: dayEnd },
                isDeleted: false
            });

            if (existing) {
                existing.status = status;
                existing.shift = shift || existing.shift;
                if (remarks) existing.remarks = remarks;
                await existing.save();
                results.push(existing);
            } else {
                const record = await Attendance.create({
                    attendanceId: generateAttendanceId(),
                    riderId,
                    riderName: rider.name,
                    riderCode: rider.code,
                    userId: rider.userId || null,
                    date: dayStart,
                    shift: shift || 'morning',
                    status,
                    remarks: remarks || '',
                    partnerId: getEffectivePartnerId(req.user) || rider.partnerId,
                    branchId: getEffectiveBranchId(req.user) || rider.branchId,
                    createdBy: req.user._id
                });
                results.push(record);
            }
        }

        await logAudit(req, {
            action: 'BULK_CREATE',
            resource: 'attendance',
            description: `Bulk marked ${results.length} attendance records as ${status}`,
            details: { riderIds, date, status, count: results.length }
        });

        res.status(201).json({
            message: `${results.length} attendance records updated`,
            count: results.length,
            data: results
        });
    } catch (err) {
        console.error('[bulkMarkAttendance] Error:', err);
        res.status(500).json({ message: 'Server error during bulk attendance marking' });
    }
};

/* ============================================================
   SHIFTS
   ============================================================ */

// @desc    Get all shifts
// @route   GET /api/attendance/shifts
// @access  Private
exports.getShifts = async (req, res) => {
    try {
        const scope = buildScopeQuery(req.user);
        if (scope === null) return res.json([]);

        const query = { isDeleted: false, ...scope };
        const shifts = await Shift.find(query).sort({ startTime: 1 }).lean();

        res.json(shifts);
    } catch (err) {
        console.error('[getShifts] Error:', err);
        res.status(500).json({ message: 'Server error fetching shifts' });
    }
};

// @desc    Get shift by ID
// @route   GET /api/attendance/shifts/:id
// @access  Private
exports.getShiftById = async (req, res) => {
    try {
        const shift = await Shift.findById(req.params.id);
        if (!shift || shift.isDeleted) {
            return res.status(404).json({ message: 'Shift not found' });
        }
        res.json(shift);
    } catch (err) {
        console.error('[getShiftById] Error:', err);
        res.status(500).json({ message: 'Server error fetching shift' });
    }
};

// @desc    Create shift
// @route   POST /api/attendance/shifts
// @access  Private
exports.createShift = async (req, res) => {
    try {
        const { name, label, startTime, endTime, gracePeriodMins, breakDurationMins } = req.body;

        if (!name || !label || !startTime || !endTime) {
            return res.status(400).json({ message: 'name, label, startTime, endTime are required' });
        }

        const shift = await Shift.create({
            name,
            label,
            startTime,
            endTime,
            gracePeriodMins: gracePeriodMins || 15,
            breakDurationMins: breakDurationMins || 30,
            partnerId: getEffectivePartnerId(req.user),
            branchId: getEffectiveBranchId(req.user),
            createdBy: req.user._id
        });

        await logAudit(req, {
            action: 'CREATE',
            resource: 'shift',
            resourceId: shift._id,
            description: `Created shift: ${label}`,
            details: req.body
        });

        res.status(201).json(shift);
    } catch (err) {
        console.error('[createShift] Error:', err);
        res.status(500).json({ message: 'Server error creating shift' });
    }
};

// @desc    Update shift
// @route   PUT /api/attendance/shifts/:id
// @access  Private
exports.updateShift = async (req, res) => {
    try {
        const shift = await Shift.findById(req.params.id);
        if (!shift || shift.isDeleted) {
            return res.status(404).json({ message: 'Shift not found' });
        }

        const allowedFields = [
            'name', 'label', 'startTime', 'endTime', 'gracePeriodMins',
            'halfDayThresholdMins', 'fullDayThresholdMins', 'breakDurationMins',
            'overtimeThresholdMins', 'color', 'isActive'
        ];

        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) {
                shift[field] = req.body[field];
            }
        });

        await shift.save();

        await logAudit(req, {
            action: 'UPDATE',
            resource: 'shift',
            resourceId: shift._id,
            description: `Updated shift: ${shift.label}`,
            details: req.body
        });

        res.json(shift);
    } catch (err) {
        console.error('[updateShift] Error:', err);
        res.status(500).json({ message: 'Server error updating shift' });
    }
};

// @desc    Delete shift (soft delete)
// @route   DELETE /api/attendance/shifts/:id
// @access  Private
exports.deleteShift = async (req, res) => {
    try {
        const shift = await Shift.findById(req.params.id);
        if (!shift || shift.isDeleted) {
            return res.status(404).json({ message: 'Shift not found' });
        }

        shift.isDeleted = true;
        await shift.save();

        await logAudit(req, {
            action: 'DELETE',
            resource: 'shift',
            resourceId: shift._id,
            description: `Deleted shift: ${shift.label}`
        });

        res.json({ message: 'Shift deleted successfully' });
    } catch (err) {
        console.error('[deleteShift] Error:', err);
        res.status(500).json({ message: 'Server error deleting shift' });
    }
};

/* ============================================================
   LEAVE REQUESTS
   ============================================================ */

// @desc    Get leave requests
// @route   GET /api/attendance/leaves
// @access  Private
exports.getLeaveRequests = async (req, res) => {
    try {
        const scope = buildScopeQuery(req.user);
        if (scope === null) return res.json({ data: [], total: 0, page: 1, pages: 1 });

        const {
            page = 1,
            limit = 20,
            search,
            status,
            leaveType,
            riderId
        } = req.query;

        const query = { isDeleted: false, ...scope };

        if (status) query.status = status;
        if (leaveType) query.leaveType = leaveType;
        if (riderId) query.riderId = riderId;

        if (search) {
            query.$or = [
                { riderName: { $regex: search, $options: 'i' } },
                { riderCode: { $regex: search, $options: 'i' } }
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [total, records] = await Promise.all([
            LeaveRequest.countDocuments(query),
            LeaveRequest.find(query)
                .populate('riderId', 'name code phone')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean()
        ]);

        res.json({
            data: records,
            total,
            page: parseInt(page),
            pages: Math.ceil(total / parseInt(limit))
        });
    } catch (err) {
        console.error('[getLeaveRequests] Error:', err);
        res.status(500).json({ message: 'Server error fetching leave requests' });
    }
};

// @desc    Get leave request by ID
// @route   GET /api/attendance/leaves/:id
// @access  Private
exports.getLeaveRequestById = async (req, res) => {
    try {
        const record = await LeaveRequest.findById(req.params.id)
            .populate('riderId', 'name code phone');

        if (!record || record.isDeleted) {
            return res.status(404).json({ message: 'Leave request not found' });
        }

        res.json(record);
    } catch (err) {
        console.error('[getLeaveRequestById] Error:', err);
        res.status(500).json({ message: 'Server error fetching leave request' });
    }
};

// @desc    Create leave request
// @route   POST /api/attendance/leaves
// @access  Private
exports.createLeaveRequest = async (req, res) => {
    try {
        const { riderId, leaveType, startDate, endDate, totalDays, reason, attachments } = req.body;

        if (!riderId || !leaveType || !startDate || !endDate || !reason) {
            return res.status(400).json({ message: 'riderId, leaveType, startDate, endDate, reason are required' });
        }

        const rider = await Driver.findById(riderId);
        if (!rider) {
            return res.status(404).json({ message: 'Rider not found' });
        }

        // Calculate total days if not provided
        let days = totalDays;
        if (!days) {
            const s = new Date(startDate);
            const e = new Date(endDate);
            days = Math.ceil((e - s) / (1000 * 60 * 60 * 24)) + 1;
        }

        const record = await LeaveRequest.create({
            leaveRequestId: generateLeaveRequestId(),
            riderId,
            riderName: rider.name,
            riderCode: rider.code,
            userId: rider.userId || null,
            leaveType,
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            totalDays: days,
            reason,
            attachments: attachments || [],
            partnerId: getEffectivePartnerId(req.user) || rider.partnerId,
            branchId: getEffectiveBranchId(req.user) || rider.branchId,
            createdBy: req.user._id
        });

        await logAudit(req, {
            action: 'CREATE',
            resource: 'leave_request',
            resourceId: record._id,
            description: `Created leave request for ${rider.name} (${leaveType}, ${days} days)`,
            details: req.body
        });

        res.status(201).json(record);
    } catch (err) {
        console.error('[createLeaveRequest] Error:', err);
        res.status(500).json({ message: 'Server error creating leave request' });
    }
};

// @desc    Approve leave request
// @route   PUT /api/attendance/leaves/:id/approve
// @access  Private
exports.approveLeaveRequest = async (req, res) => {
    try {
        const { approvalNote } = req.body;

        const record = await LeaveRequest.findById(req.params.id);
        if (!record || record.isDeleted) {
            return res.status(404).json({ message: 'Leave request not found' });
        }

        if (record.status !== 'pending') {
            return res.status(400).json({ message: `Leave request is already ${record.status}` });
        }

        record.status = 'approved';
        record.approvedBy = req.user._id;
        record.approvedAt = new Date();
        record.approvalNote = approvalNote || '';

        await record.save();

        // Auto-create attendance records for leave days
        const start = new Date(record.startDate);
        const end = new Date(record.endDate);
        const rider = await Driver.findById(record.riderId);

        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            const dayStart = new Date(d);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(d);
            dayEnd.setHours(23, 59, 59, 999);

            const existing = await Attendance.findOne({
                riderId: record.riderId,
                date: { $gte: dayStart, $lte: dayEnd },
                isDeleted: false
            });

            if (existing) {
                existing.status = 'on_leave';
                existing.leaveType = record.leaveType;
                existing.leaveRequestId = record._id;
                await existing.save();
            } else {
                await Attendance.create({
                    attendanceId: generateAttendanceId(),
                    riderId: record.riderId,
                    riderName: record.riderName,
                    riderCode: record.riderCode,
                    userId: record.userId,
                    date: dayStart,
                    status: 'on_leave',
                    leaveType: record.leaveType,
                    leaveRequestId: record._id,
                    partnerId: record.partnerId,
                    branchId: record.branchId,
                    createdBy: req.user._id
                });
            }
        }

        await logAudit(req, {
            action: 'APPROVE',
            resource: 'leave_request',
            resourceId: record._id,
            description: `Approved leave request for ${rider?.name || record.riderName}`,
            details: { approvalNote, totalDays: record.totalDays }
        });

        res.json(record);
    } catch (err) {
        console.error('[approveLeaveRequest] Error:', err);
        res.status(500).json({ message: 'Server error approving leave request' });
    }
};

// @desc    Reject leave request
// @route   PUT /api/attendance/leaves/:id/reject
// @access  Private
exports.rejectLeaveRequest = async (req, res) => {
    try {
        const { rejectedReason } = req.body;

        if (!rejectedReason) {
            return res.status(400).json({ message: 'rejectedReason is required' });
        }

        const record = await LeaveRequest.findById(req.params.id);
        if (!record || record.isDeleted) {
            return res.status(404).json({ message: 'Leave request not found' });
        }

        if (record.status !== 'pending') {
            return res.status(400).json({ message: `Leave request is already ${record.status}` });
        }

        record.status = 'rejected';
        record.approvedBy = req.user._id;
        record.approvedAt = new Date();
        record.rejectedReason = rejectedReason;

        await record.save();

        await logAudit(req, {
            action: 'REJECT',
            resource: 'leave_request',
            resourceId: record._id,
            description: `Rejected leave request for ${record.riderName}`,
            details: { rejectedReason }
        });

        res.json(record);
    } catch (err) {
        console.error('[rejectLeaveRequest] Error:', err);
        res.status(500).json({ message: 'Server error rejecting leave request' });
    }
};

// @desc    Cancel leave request
// @route   PUT /api/attendance/leaves/:id/cancel
// @access  Private
exports.cancelLeaveRequest = async (req, res) => {
    try {
        const record = await LeaveRequest.findById(req.params.id);
        if (!record || record.isDeleted) {
            return res.status(404).json({ message: 'Leave request not found' });
        }

        if (!['pending', 'approved'].includes(record.status)) {
            return res.status(400).json({ message: `Cannot cancel a ${record.status} leave request` });
        }

        record.status = 'cancelled';
        await record.save();

        // Remove linked attendance leave records
        await Attendance.updateMany(
            { leaveRequestId: record._id },
            { $unset: { leaveRequestId: '', leaveType: '' }, $set: { status: 'absent' } }
        );

        await logAudit(req, {
            action: 'CANCEL',
            resource: 'leave_request',
            resourceId: record._id,
            description: `Cancelled leave request for ${record.riderName}`
        });

        res.json(record);
    } catch (err) {
        console.error('[cancelLeaveRequest] Error:', err);
        res.status(500).json({ message: 'Server error cancelling leave request' });
    }
};

// @desc    Delete leave request (soft delete)
// @route   DELETE /api/attendance/leaves/:id
// @access  Private
exports.deleteLeaveRequest = async (req, res) => {
    try {
        const record = await LeaveRequest.findById(req.params.id);
        if (!record || record.isDeleted) {
            return res.status(404).json({ message: 'Leave request not found' });
        }

        record.isDeleted = true;
        await record.save();

        await logAudit(req, {
            action: 'DELETE',
            resource: 'leave_request',
            resourceId: record._id,
            description: `Deleted leave request for ${record.riderName}`
        });

        res.json({ message: 'Leave request deleted successfully' });
    } catch (err) {
        console.error('[deleteLeaveRequest] Error:', err);
        res.status(500).json({ message: 'Server error deleting leave request' });
    }
};

