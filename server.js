// server.js - Updated to include new shipment payment modes
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');

dotenv.config();

connectDB();

const app = express();

// CORS Configuration for Production
const corsOptions = {
    origin: [
        'https://delivery-beta-olive.vercel.app',
        'http://localhost:3000',
        'http://localhost:3001'
    ],
    credentials: true,
    optionsSuccessStatus: 200
};

// Middleware
app.use(express.json());
app.use(cors(corsOptions));
app.use('/public', express.static('public'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/rbac', require('./routes/rbacRoutes'));
app.use('/api/drs', require('./routes/drsRoutes'));
app.use('/api/branches', require('./routes/branchRoutes'));
app.use('/api/shipments', require('./routes/shipmentRoutes'));
app.use('/api/manifests', require('./routes/manifestRoutes'));
app.use('/api/bags', require('./routes/bagRoutes'));
app.use('/api/customers', require('./routes/customerRoutes'));
app.use('/api/rates', require('./routes/rateRoutes'));
app.use('/api/pincodes', require('./routes/pincodeRoutes'));
app.use('/api/places', require('./routes/placesRoutes'));

// Drivers & Vehicles
app.use('/api/drivers', require('./routes/driverRoutes'));
app.use('/api/vehicles', require('./routes/vehicleRoutes'));

// AWB Series
app.use('/api/awb-series', require('./routes/awbRoutes'));

// POD (Proof of Delivery)
app.use('/api/pods', require('./routes/podRoutes'));

// Warehouse, Inventory & Assets
app.use('/api/warehouses', require('./routes/warehouseRoutes'));
app.use('/api/inventory', require('./routes/inventoryRoutes'));
app.use('/api/assets', require('./routes/assetRoutes'));

// Stock Reconciliation
app.use('/api/reconciliations', require('./routes/reconciliationRoutes'));

// Master Data
app.use('/api/routes', require('./routes/routeRoutes'));
app.use('/api/locations', require('./routes/locationRoutes'));
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/configs', require('./routes/configRoutes'));

// Reports & Analytics
app.use('/api/reports', require('./routes/reportsRoutes'));

// Live Tracking
app.use('/api/tracking', require('./routes/trackingRoutes'));

// Customer Service (Tickets & Agreements)
app.use('/api/tickets', require('./routes/ticketRoutes'));
app.use('/api/agreements', require('./routes/agreementRoutes'));

// Attendance & Shifts
app.use('/api/attendance', require('./routes/attendanceRoutes'));

// Audit Logs
app.use('/api/audit-logs', require('./routes/auditLogRoutes'));

// Exceptions
app.use('/api/exceptions', require('./routes/exceptionRoutes'));

// Pickups (Pickup Request Workflow)
app.use('/api/pickups', require('./routes/pickupRoutes'));

// Trips (Line-Haul / Vehicle Movement)
app.use('/api/trips', require('./routes/tripRoutes'));

// Notifications (Customer & Internal Alerts)
app.use('/api/notifications', require('./routes/notificationRoutes'));

// Transit Hub Operations
app.use('/api/hubs', require('./routes/hubRoutes'));

// Return-to-Origin (RTO) Workflow
app.use('/api/rto', require('./routes/rtoRoutes'));

// SLA / TAT Monitoring
app.use('/api/sla', require('./routes/slaRoutes'));

// Invoices
app.use('/api/invoices', require('./routes/invoiceRoutes'));

// Payments (COD, Collection, Settlements, Tally)
app.use('/api/payments', require('./routes/paymentRoutes'));

// Vendors & Partners
app.use('/api/vendors', require('./routes/vendorRoutes'));
app.use('/api/partners', require('./routes/partnerRoutes'));

app.get('/', (req, res) => {
    res.send('Delivery API is running...');
});

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.statusCode || err.status || (res.statusCode >= 400 ? res.statusCode : 500);
    if (status >= 500) console.error(err);
    return res.status(status).json({
        message: err.message || 'Internal server error'
    });
});

const PORT = process.env.PORT || 5000;

// ─── Start SLA Monitor (background breach detection) ────────────
const { startSLAMonitor } = require('./utils/slaUtility');
const SLA_CHECK_INTERVAL = parseInt(process.env.SLA_CHECK_INTERVAL_MINUTES) || 15;

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);

    // Start background SLA monitor (checks every N minutes)
    startSLAMonitor(SLA_CHECK_INTERVAL);
});
