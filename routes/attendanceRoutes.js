/**
 * attendanceRoutes.js
 * Routes for Attendance, Shifts, and Leave Requests.
 *
 * Route structure:
 *   /api/attendance
 *     GET    /stats                    - attendance stats for a date
 *     GET    /                         - paginated attendance list
 *     POST   /                         - create manual attendance
 *     POST   /bulk                     - bulk mark attendance
 *     POST   /check-in                 - rider check-in
 *     POST   /check-out                - rider check-out
 *     GET    /rider/:riderId/history   - rider attendance history
 *     GET    /:id                      - get by ID
 *     PUT    /:id                      - update
 *     PUT    /:id/adjust               - manual time adjustment
 *     DELETE /:id                      - soft delete
 *
 *   /api/attendance/shifts
 *     GET    /                         - list shifts
 *     POST   /                         - create shift
 *     GET    /:id                      - get shift by ID
 *     PUT    /:id                      - update shift
 *     DELETE /:id                      - delete shift
 *
 *   /api/attendance/leaves
 *     GET    /                         - list leave requests
 *     POST   /                         - create leave request
 *     GET    /:id                      - get by ID
 *     PUT    /:id/approve              - approve
 *     PUT    /:id/reject               - reject
 *     PUT    /:id/cancel               - cancel
 *     DELETE /:id                      - delete
 */

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/attendanceController');

// All routes require authentication
router.use(protect);

/* ---- Attendance ---- */
router.get('/stats', ctrl.getAttendanceStats);
router.get('/', ctrl.getAttendance);
router.post('/', ctrl.createAttendance);
router.post('/bulk', ctrl.bulkMarkAttendance);
router.post('/check-in', ctrl.checkIn);
router.post('/check-out', ctrl.checkOut);
router.get('/rider/:riderId/history', ctrl.getRiderAttendanceHistory);
router.get('/:id', ctrl.getAttendanceById);
router.put('/:id', ctrl.updateAttendance);
router.put('/:id/adjust', ctrl.adjustAttendance);
router.delete('/:id', ctrl.deleteAttendance);

/* ---- Shifts ---- */
router.get('/shifts', ctrl.getShifts);
router.post('/shifts', ctrl.createShift);
router.get('/shifts/:id', ctrl.getShiftById);
router.put('/shifts/:id', ctrl.updateShift);
router.delete('/shifts/:id', ctrl.deleteShift);

/* ---- Leave Requests ---- */
router.get('/leaves', ctrl.getLeaveRequests);
router.post('/leaves', ctrl.createLeaveRequest);
router.get('/leaves/:id', ctrl.getLeaveRequestById);
router.put('/leaves/:id/approve', ctrl.approveLeaveRequest);
router.put('/leaves/:id/reject', ctrl.rejectLeaveRequest);
router.put('/leaves/:id/cancel', ctrl.cancelLeaveRequest);
router.delete('/leaves/:id', ctrl.deleteLeaveRequest);

module.exports = router;
