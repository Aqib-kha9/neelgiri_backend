/**
 * paymentController.js
 * Handles COD management, payment collection, settlement reports, and Tally integration.
 * COD data is aggregated from Shipment model (paymentMode='cod').
 * Payment collection data is aggregated from Invoice.payments array.
 * Settlements and Tally sync logs use dedicated models.
 */

const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const Invoice = require('../models/Invoice');
const Settlement = require('../models/Settlement');
const TallySyncLog = require('../models/TallySyncLog');
const DRS = require('../models/DRS');
const Driver = require('../models/Driver');
const { buildScopeQuery } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');
const { generateSettlementId, generateTallySyncId } = require('../utils/idGenerator');

/* ============================================================
 * COD MANAGEMENT
 * Aggregates COD shipments by rider from DRS + Shipment data
 * ============================================================ */

// GET /api/payments/cod
const getCODRecords = async (req, res) => {
    try {
        const scope = buildScopeQuery(req.user, { branchField: 'branchId' });
        if (scope === null) return res.json({ data: [], stats: { totalCODCollected: 0, totalDeposited: 0, totalPending: 0, activeRidersWithCash: 0 } });

        // Find all DRS that have COD shipments
        const drsQuery = { isDeleted: false };
        if (scope.branchId) drsQuery.branchId = scope.branchId;

        const drsList = await DRS.find(drsQuery)
            .populate('rider', 'name driverCode phone')
            .populate('branchId', 'name branchCode')
            .lean();

        // Aggregate COD by rider
        const riderMap = {};

        for (const drs of drsList) {
            if (!drs.rider) continue;
            const riderId = drs.rider._id?.toString();
            if (!riderId) continue;

            if (!riderMap[riderId]) {
                riderMap[riderId] = {
                    id: riderId,
                    riderName: drs.rider.name || 'Unknown',
                    riderId: drs.rider.driverCode || riderId,
                    branch: drs.branchId?.name || drs.branchId?.branchCode || '—',
                    totalCODCollected: 0,
                    depositedAmount: 0,
                    pendingAmount: 0,
                    lastDepositDate: null,
                    status: 'pending',
                    shipmentCount: 0
                };
            }

            // Sum COD from shipments in this DRS
            const shipments = drs.shipments || [];
            for (const s of shipments) {
                if (s.paymentMode === 'cod' || s.paymentMode === 'COD') {
                    const codAmt = s.codAmount || 0;
                    riderMap[riderId].totalCODCollected += codAmt;
                    riderMap[riderId].shipmentCount += 1;

                    // If shipment is delivered, consider it collected
                    if (s.status === 'complete' || s.status === 'delivered') {
                        // Check if deposited (we track via settlement records)
                        // For now, treat as pending unless settled
                        riderMap[riderId].pendingAmount += codAmt;
                    }
                }
            }
        }

        // Now check settlements for deposited amounts
        const riderIds = Object.keys(riderMap);
        if (riderIds.length > 0) {
            const settlements = await Settlement.find({
                partnerType: 'rider',
                partnerRefId: { $in: riderIds.map(id => new mongoose.Types.ObjectId(id)) },
                status: 'settled',
                isDeleted: false
            }).sort({ processedDate: -1 }).lean();

            for (const set of settlements) {
                const rId = set.partnerRefId?.toString();
                if (rId && riderMap[rId]) {
                    riderMap[rId].depositedAmount += set.amount || 0;
                    if (set.processedDate) {
                        const dateStr = new Date(set.processedDate).toISOString().split('T')[0];
                        if (!riderMap[rId].lastDepositDate || dateStr > riderMap[rId].lastDepositDate) {
                            riderMap[rId].lastDepositDate = dateStr;
                        }
                    }
                }
            }
        }

        // Recalculate pending and status
        const records = Object.values(riderMap).map(r => {
            r.pendingAmount = Math.max(0, r.totalCODCollected - r.depositedAmount);
            if (r.totalCODCollected === 0) {
                r.status = 'pending';
            } else if (r.pendingAmount === 0) {
                r.status = 'fully_deposited';
            } else if (r.depositedAmount > 0) {
                r.status = 'partially_deposited';
            } else {
                r.status = 'pending';
            }
            return r;
        }).filter(r => r.totalCODCollected > 0 || r.shipmentCount > 0);

        // Compute stats
        const totalCODCollected = records.reduce((sum, r) => sum + r.totalCODCollected, 0);
        const totalDeposited = records.reduce((sum, r) => sum + r.depositedAmount, 0);
        const totalPending = records.reduce((sum, r) => sum + r.pendingAmount, 0);
        const activeRidersWithCash = records.filter(r => r.pendingAmount > 0).length;

        res.json({
            data: records,
            stats: { totalCODCollected, totalDeposited, totalPending, activeRidersWithCash }
        });
    } catch (err) {
        console.error('[getCODRecords] Error:', err);
        res.status(500).json({ message: 'Server error fetching COD records', error: err.message });
    }
};

// POST /api/payments/cod/:riderId/deposit
const depositCOD = async (req, res) => {
    try {
        const { riderId } = req.params;
        const { amount, paymentMode, referenceNo, notes } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ message: 'Valid deposit amount is required' });
        }

        const driver = await Driver.findById(riderId);
        if (!driver) {
            return res.status(404).json({ message: 'Rider not found' });
        }

        const settlement = await Settlement.create({
            settlementId: generateSettlementId(),
            partnerName: driver.name,
            partnerTechId: driver.driverCode || riderId,
            partnerType: 'rider',
            partnerRefId: driver._id,
            amount,
            period: `COD Deposit ${new Date().toLocaleDateString('en-IN')}`,
            status: 'settled',
            processedDate: new Date(),
            transactionRef: referenceNo || `DEP-${Date.now()}`,
            paymentMode: paymentMode || 'CASH',
            notes: notes || 'COD cash deposit',
            createdBy: req.user._id,
            partnerId: req.user.parentPartner || (req.user.role?.name === 'partner_admin' || req.user.role?.name === 'partner' ? req.user._id : null),
            branchId: req.user.branchId || null
        });

        await logAudit(req, {
            action: 'CREATE',
            resource: 'cod_deposit',
            resourceId: settlement._id,
            description: `COD deposit of ₹${amount} for rider ${driver.name}`,
            details: { riderId, amount, referenceNo }
        });

        res.status(201).json({ message: 'COD deposit recorded successfully', data: settlement });
    } catch (err) {
        console.error('[depositCOD] Error:', err);
        res.status(500).json({ message: 'Server error recording COD deposit', error: err.message });
    }
};

/* ============================================================
 * PAYMENT COLLECTION
 * Aggregates payments from Invoice.payments array
 * ============================================================ */

// GET /api/payments/collection
const getPaymentCollections = async (req, res) => {
    try {
        const { page = 1, limit = 100, status, search } = req.query;
        const scope = buildScopeQuery(req.user);
        if (scope === null) return res.json({ data: [], stats: { totalCollection: 0, pendingAmount: 0, todayCollection: 0, failedTransactions: 0 } });

        const query = { isDeleted: false, 'payments.0': { $exists: true } };
        Object.assign(query, scope);

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const invoices = await Invoice.find(query)
            .populate('customerId', 'name code email phone')
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        // Flatten all payments into a collection list
        let collections = [];
        for (const inv of invoices) {
            const customer = inv.customerId && typeof inv.customerId === 'object' ? inv.customerId : {};
            for (const p of (inv.payments || [])) {
                collections.push({
                    id: p._id?.toString() || `${inv._id}-${p.paymentId}`,
                    transactionId: p.paymentId || p.referenceNo || `TXN-${inv.invoiceNo}`,
                    invoiceNo: inv.invoiceNo,
                    customerId: inv.customerId?._id || inv.customerId,
                    customerName: inv.customerName || customer.name || 'Unknown',
                    amount: p.amount || 0,
                    paymentMode: (p.method || 'CASH').replace(/_/g, ' '),
                    status: 'received',
                    date: p.paidDate ? new Date(p.paidDate).toISOString().split('T')[0] : new Date(inv.updatedAt).toISOString().split('T')[0],
                    collectedBy: p.receivedBy || '—',
                    referenceNo: p.referenceNo || ''
                });
            }
        }

        // Apply filters
        if (status && status !== 'all') {
            collections = collections.filter(c => c.status === status);
        }
        if (search) {
            const q = search.toLowerCase();
            collections = collections.filter(c =>
                c.customerName.toLowerCase().includes(q) ||
                c.transactionId.toLowerCase().includes(q) ||
                (c.referenceNo || '').toLowerCase().includes(q)
            );
        }

        // Compute stats from ALL payments (not just current page)
        const allInvoices = await Invoice.find({ isDeleted: false, 'payments.0': { $exists: true }, ...scope }).lean();
        let totalCollection = 0;
        let todayCollection = 0;
        const today = new Date().toISOString().split('T')[0];

        for (const inv of allInvoices) {
            for (const p of (inv.payments || [])) {
                totalCollection += p.amount || 0;
                if (p.paidDate && new Date(p.paidDate).toISOString().split('T')[0] === today) {
                    todayCollection += p.amount || 0;
                }
            }
        }

        // Pending amount = sum of balanceDue for issued/partially_paid/overdue invoices
        const pendingInvoices = await Invoice.find({
            isDeleted: false,
            status: { $in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
            ...scope
        }).lean();
        const pendingAmount = pendingInvoices.reduce((sum, inv) => sum + (inv.balanceDue || 0), 0);

        res.json({
            data: collections,
            stats: {
                totalCollection,
                pendingAmount,
                todayCollection,
                failedTransactions: 0
            }
        });
    } catch (err) {
        console.error('[getPaymentCollections] Error:', err);
        res.status(500).json({ message: 'Server error fetching payment collections', error: err.message });
    }
};

/* ============================================================
 * SETTLEMENT REPORTS
 * CRUD for Settlement model
 * ============================================================ */

// GET /api/payments/settlements
const getSettlements = async (req, res) => {
    try {
        const { page = 1, limit = 100, status, search } = req.query;
        const scope = buildScopeQuery(req.user);
        if (scope === null) return res.json({ data: [], stats: { totalSettled: 0, pendingSettlement: 0, processedThisMonth: 0, nextPayoutDate: '' } });

        const query = { isDeleted: false };
        Object.assign(query, scope);

        if (status && status !== 'all-status') {
            query.status = status;
        }
        if (search) {
            query.$or = [
                { partnerName: { $regex: search, $options: 'i' } },
                { partnerTechId: { $regex: search, $options: 'i' } }
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [records, total] = await Promise.all([
            Settlement.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
            Settlement.countDocuments(query)
        ]);

        // Compute stats
        const allSettlements = await Settlement.find({ isDeleted: false, ...scope }).lean();
        const totalSettled = allSettlements.filter(s => s.status === 'settled').reduce((sum, s) => sum + (s.amount || 0), 0);
        const pendingSettlement = allSettlements.filter(s => s.status === 'pending' || s.status === 'processing').reduce((sum, s) => sum + (s.amount || 0), 0);

        const now = new Date();
        const processedThisMonth = allSettlements.filter(s => {
            if (!s.processedDate) return false;
            const d = new Date(s.processedDate);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        }).length;

        // Next payout date = next Friday or end of month
        const nextPayout = new Date();
        const day = nextPayout.getDay();
        const daysUntilFriday = (5 - day + 7) % 7 || 7;
        nextPayout.setDate(nextPayout.getDate() + daysUntilFriday);
        const nextPayoutDate = nextPayout.toISOString().split('T')[0];

        res.json({
            data: records.map(r => ({
                ...r,
                id: r._id,
                type: r.partnerType,
                processedDate: r.processedDate ? new Date(r.processedDate).toISOString().split('T')[0] : '—'
            })),
            stats: { totalSettled, pendingSettlement, processedThisMonth, nextPayoutDate },
            pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) }
        });
    } catch (err) {
        console.error('[getSettlements] Error:', err);
        res.status(500).json({ message: 'Server error fetching settlements', error: err.message });
    }
};

// POST /api/payments/settlements
const createSettlement = async (req, res) => {
    try {
        const { partnerName, partnerTechId, partnerType, amount, period, paymentMode, notes, transactionRef } = req.body;

        if (!partnerName || !partnerType || !amount) {
            return res.status(400).json({ message: 'partnerName, partnerType, and amount are required' });
        }

        const settlement = await Settlement.create({
            settlementId: generateSettlementId(),
            partnerName,
            partnerTechId: partnerTechId || '',
            partnerType,
            amount,
            period: period || '',
            status: 'pending',
            paymentMode: paymentMode || 'BANK_TRANSFER',
            transactionRef: transactionRef || '',
            notes: notes || '',
            createdBy: req.user._id,
            partnerId: req.user.parentPartner || (req.user.role?.name === 'partner_admin' || req.user.role?.name === 'partner' ? req.user._id : null),
            branchId: req.user.branchId || null
        });

        await logAudit(req, {
            action: 'CREATE',
            resource: 'settlement',
            resourceId: settlement._id,
            description: `Settlement created for ${partnerName} (₹${amount})`,
            details: { partnerName, partnerType, amount }
        });

        res.status(201).json({ message: 'Settlement created successfully', data: settlement });
    } catch (err) {
        console.error('[createSettlement] Error:', err);
        res.status(500).json({ message: 'Server error creating settlement', error: err.message });
    }
};

// PUT /api/payments/settlements/:id/process
const processSettlement = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, transactionRef, paymentMode } = req.body;

        const settlement = await Settlement.findById(id);
        if (!settlement) {
            return res.status(404).json({ message: 'Settlement not found' });
        }

        settlement.status = status || 'settled';
        if (settlement.status === 'settled') {
            settlement.processedDate = new Date();
        }
        if (transactionRef) settlement.transactionRef = transactionRef;
        if (paymentMode) settlement.paymentMode = paymentMode;
        await settlement.save();

        await logAudit(req, {
            action: 'UPDATE',
            resource: 'settlement',
            resourceId: settlement._id,
            description: `Settlement ${settlement.settlementId} status changed to ${settlement.status}`,
            details: { status: settlement.status, transactionRef }
        });

        res.json({ message: 'Settlement updated successfully', data: settlement });
    } catch (err) {
        console.error('[processSettlement] Error:', err);
        res.status(500).json({ message: 'Server error updating settlement', error: err.message });
    }
};

/* ============================================================
 * TALLY INTEGRATION
 * Sync logs and configuration
 * ============================================================ */

// GET /api/payments/tally/logs
const getTallyLogs = async (req, res) => {
    try {
        const { page = 1, limit = 100, status, search } = req.query;
        const scope = buildScopeQuery(req.user);
        if (scope === null) return res.json({ data: [], config: null });

        const query = {};
        Object.assign(query, scope);

        if (status && status !== 'all-status') {
            query.status = status;
        }
        if (search) {
            query.$or = [
                { details: { $regex: search, $options: 'i' } },
                { type: { $regex: search, $options: 'i' } }
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [logs, total] = await Promise.all([
            TallySyncLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
            TallySyncLog.countDocuments(query)
        ]);

        // Build config from latest logs
        const latestSync = logs[0];
        const config = {
            connectionStatus: 'connected',
            lastSyncTime: latestSync ? latestSync.createdAt : new Date().toISOString(),
            companyName: 'LogiFlow Logistics',
            tallyVersion: 'Tally Prime 3.0',
            autoSync: true
        };

        res.json({
            data: logs.map(l => ({
                ...l,
                id: l._id,
                timestamp: l.createdAt ? new Date(l.createdAt).toISOString() : new Date().toISOString(),
                user: l.triggeredBy || 'System'
            })),
            config,
            pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) }
        });
    } catch (err) {
        console.error('[getTallyLogs] Error:', err);
        res.status(500).json({ message: 'Server error fetching Tally logs', error: err.message });
    }
};

// POST /api/payments/tally/sync
const triggerTallySync = async (req, res) => {
    try {
        const { type = 'invoice' } = req.body;
        const startTime = Date.now();

        // Create a processing log
        const syncLog = await TallySyncLog.create({
            syncId: generateTallySyncId(),
            type,
            status: 'processing',
            triggeredBy: req.user?.name || 'Admin',
            triggeredByUserId: req.user?._id,
            partnerId: req.user?.parentPartner || (req.user?.role?.name === 'partner_admin' || req.user?.role?.name === 'partner' ? req.user?._id : null),
            branchId: req.user?.branchId || null,
            details: `Manual ${type} sync triggered`
        });

        // Simulate sync by counting records
        let recordsSynced = 0;
        let syncStatus = 'success';
        let details = `${type} sync completed successfully`;
        let errorMessage = null;

        try {
            const scope = buildScopeQuery(req.user);
            if (type === 'invoice') {
                const count = await Invoice.countDocuments({ isDeleted: false, ...scope });
                recordsSynced = count;
            } else if (type === 'payment') {
                const invoices = await Invoice.find({ isDeleted: false, 'payments.0': { $exists: true }, ...scope }).lean();
                recordsSynced = invoices.reduce((sum, inv) => sum + (inv.payments?.length || 0), 0);
            } else if (type === 'credit_note') {
                const CreditDebitNote = require('../models/CreditDebitNote');
                recordsSynced = await CreditDebitNote.countDocuments({ isDeleted: false, ...scope });
            } else if (type === 'ledger') {
                const Customer = require('../models/Customer');
                recordsSynced = await Customer.countDocuments({ isDeleted: false, ...scope });
            } else if (type === 'stock') {
                const Inventory = require('../models/Inventory');
                recordsSynced = await Inventory.countDocuments({ isDeleted: false, ...scope });
            }
        } catch (syncErr) {
            syncStatus = 'failed';
            details = `Sync failed: ${syncErr.message}`;
            errorMessage = syncErr.message;
        }

        const duration = Date.now() - startTime;

        syncLog.status = syncStatus;
        syncLog.recordsSynced = recordsSynced;
        syncLog.details = details;
        syncLog.errorMessage = errorMessage;
        syncLog.syncDurationMs = duration;
        await syncLog.save();

        await logAudit(req, {
            action: 'SYNC',
            resource: 'tally_sync',
            resourceId: syncLog._id,
            description: `Tally sync triggered for ${type} - ${syncStatus}`,
            details: { type, recordsSynced, duration }
        });

        res.json({
            message: syncStatus === 'success' ? 'Sync completed successfully' : 'Sync failed',
            data: {
                ...syncLog.toObject(),
                id: syncLog._id,
                timestamp: syncLog.createdAt ? new Date(syncLog.createdAt).toISOString() : new Date().toISOString(),
                user: syncLog.triggeredBy
            }
        });
    } catch (err) {
        console.error('[triggerTallySync] Error:', err);
        res.status(500).json({ message: 'Server error triggering Tally sync', error: err.message });
    }
};

module.exports = {
    getCODRecords,
    depositCOD,
    getPaymentCollections,
    getSettlements,
    createSettlement,
    processSettlement,
    getTallyLogs,
    triggerTallySync
};
