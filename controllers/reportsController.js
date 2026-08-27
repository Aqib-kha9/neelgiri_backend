const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const Invoice = require('../models/Invoice');
const Driver = require('../models/Driver');
const Partner = require('../models/Partner');
const Branch = require('../models/Branch');
const Exception = require('../models/Exception');
const Pod = require('../models/Pod');
const CreditDebitNote = require('../models/CreditDebitNote');
const { buildScopeQuery } = require('../utils/scopeHelper');

// Helper: build date range filter
const buildDateRange = (req) => {
    const { startDate, endDate, period } = req.query;
    const dateFilter = {};

    if (startDate && endDate) {
        dateFilter.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    } else if (period) {
        const now = new Date();
        let from = new Date();
        switch (period) {
            case 'TODAY':
                from.setHours(0, 0, 0, 0);
                break;
            case 'YESTERDAY':
                from.setDate(now.getDate() - 1);
                from.setHours(0, 0, 0, 0);
                dateFilter.createdAt = { $lt: new Date(now.getFullYear(), now.getMonth(), now.getDate()), $gte: from };
                return dateFilter;
            case 'WEEK':
                from.setDate(now.getDate() - 7);
                break;
            case 'MONTH':
                from.setMonth(now.getMonth() - 1);
                break;
            case 'QUARTER':
                from.setMonth(now.getMonth() - 3);
                break;
            case 'YEAR':
                from.setFullYear(now.getFullYear() - 1);
                break;
            default:
                return dateFilter;
        }
        dateFilter.createdAt = { $gte: from, $lte: now };
    }

    return dateFilter;
};

// ==================== DASHBOARD SUMMARY ====================
const getDashboardSummary = asyncHandler(async (req, res) => {
    const scopeQuery = buildScopeQuery(req.user) ?? {};
    const dateFilter = buildDateRange(req);
    const query = { ...scopeQuery, ...dateFilter };

    const [
        totalShipments,
        deliveredCount,
        inTransitCount,
        pendingCount,
        rtoCount,
        cancelledCount,
        revenueAgg,
        codAgg,
        exceptionCount,
        pendingPodCount
    ] = await Promise.all([
        Shipment.countDocuments(query),
        Shipment.countDocuments({ ...query, status: 'DELIVERED' }),
        Shipment.countDocuments({ ...query, status: { $in: ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'BAGGED', 'MANIFESTED'] } }),
        Shipment.countDocuments({ ...query, status: { $in: ['BOOKED', 'PICKUP_PENDING', 'PICKUP_DONE'] } }),
        Shipment.countDocuments({ ...query, status: 'RTO' }),
        Shipment.countDocuments({ ...query, status: 'CANCELLED' }),
        Shipment.aggregate([
            { $match: { ...query, status: { $ne: 'CANCELLED' } } },
            { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' }, totalFreight: { $sum: '$baseFreight' } } }
        ]),
        Shipment.aggregate([
            { $match: { ...query, paymentMode: 'COD', status: 'DELIVERED' } },
            { $group: { _id: null, codCollected: { $sum: '$codAmount' } } }
        ]),
        Exception.countDocuments({ ...scopeQuery, status: { $in: ['OPEN', 'INVESTIGATING', 'ESCALATED'] } }),
        Pod.countDocuments({ ...scopeQuery, verificationStatus: 'PENDING' })
    ]);

    const revenue = revenueAgg[0] || { totalRevenue: 0, totalFreight: 0 };
    const cod = codAgg[0] || { codCollected: 0 };

    const deliveryRate = totalShipments > 0 ? Math.round((deliveredCount / totalShipments) * 10000) / 100 : 0;
    const rtoRate = totalShipments > 0 ? Math.round((rtoCount / totalShipments) * 10000) / 100 : 0;

    res.json({
        shipments: {
            total: totalShipments,
            delivered: deliveredCount,
            inTransit: inTransitCount,
            pending: pendingCount,
            rto: rtoCount,
            cancelled: cancelledCount
        },
        revenue: {
            total: revenue.totalRevenue || 0,
            freight: revenue.totalFreight || 0,
            codCollected: cod.codCollected || 0
        },
        exceptions: {
            open: exceptionCount
        },
        pod: {
            pendingVerification: pendingPodCount
        },
        rates: {
            deliveryRate,
            rtoRate
        }
    });
});

// ==================== DELIVERY PERFORMANCE ====================
const getDeliveryPerformance = asyncHandler(async (req, res) => {
    const scopeQuery = buildScopeQuery(req.user) ?? {};
    const dateFilter = buildDateRange(req);
    const query = { ...scopeQuery, ...dateFilter };

    const { groupBy } = req.query;
    const groupField = groupBy === 'BRANCH' ? '$currentBranch' : groupBy === 'CITY' ? '$receiver.city' : '$status';

    const performance = await Shipment.aggregate([
        { $match: query },
        {
            $group: {
                _id: groupField,
                totalOrders: { $sum: 1 },
                delivered: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $in: ['$status', ['UNDELIVERED', 'REFUSED', 'CANCELLED']] }, 1, 0] } },
                rto: { $sum: { $cond: [{ $eq: ['$status', 'RTO'] }, 1, 0] } },
                inTransit: { $sum: { $cond: [{ $in: ['$status', ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'BAGGED', 'MANIFESTED']] }, 1, 0] } },
                codAmount: { $sum: { $cond: [{ $eq: ['$paymentMode', 'COD'] }, '$codAmount', 0] } },
                totalRevenue: { $sum: '$totalAmount' }
            }
        },
        {
            $project: {
                zone: '$_id',
                totalOrders: 1,
                delivered: 1,
                failed: 1,
                rto: 1,
                inTransit: 1,
                codAmount: 1,
                totalRevenue: 1,
                deliveryRate: { $round: [{ $multiply: [{ $divide: ['$delivered', { $max: ['$totalOrders', 1] }] }, 100] }, 2] },
                failureRate: { $round: [{ $multiply: [{ $divide: ['$failed', { $max: ['$totalOrders', 1] }] }, 100] }, 2] }
            }
        },
        { $sort: { totalOrders: -1 } }
    ]);

    const totals = performance.reduce((acc, p) => ({
        totalOrders: acc.totalOrders + p.totalOrders,
        delivered: acc.delivered + p.delivered,
        failed: acc.failed + p.failed,
        rto: acc.rto + p.rto,
        codAmount: acc.codAmount + p.codAmount,
        totalRevenue: acc.totalRevenue + p.totalRevenue
    }), { totalOrders: 0, delivered: 0, failed: 0, rto: 0, codAmount: 0, totalRevenue: 0 });

    res.json({ performance, totals });
});

// ==================== RIDER PERFORMANCE ====================
const getRiderPerformance = asyncHandler(async (req, res) => {
    const scopeQuery = buildScopeQuery(req.user) ?? {};
    const dateFilter = buildDateRange(req);
    const query = { ...scopeQuery, ...dateFilter };

    const riders = await Shipment.aggregate([
        { $match: { ...query, status: 'DELIVERED' } },
        {
            $group: {
                _id: '$deliveryRiderId',
                riderName: { $first: '$deliveryRiderName' },
                ordersCompleted: { $sum: 1 },
                codCollected: { $sum: { $cond: [{ $eq: ['$paymentMode', 'COD'] }, '$codAmount', 0] } },
                revenue: { $sum: '$totalAmount' },
                failedAttempts: { $sum: { $cond: [{ $in: ['$status', ['UNDELIVERED', 'REFUSED']] }, 1, 0] } }
            }
        },
        { $sort: { ordersCompleted: -1 } }
    ]);

    // Enrich with driver data
    const enrichedRiders = await Promise.all(riders.map(async (r) => {
        if (!r._id) return { ...r, riderName: 'Unassigned', overallScore: 0 };
        const driver = await Driver.findById(r._id).select('driverCode name rating totalDeliveries');
        const successRate = r.ordersCompleted > 0 ? Math.round((r.ordersCompleted / (r.ordersCompleted + r.failedAttempts)) * 10000) / 100 : 0;
        return {
            ...r,
            riderName: r.riderName || (driver ? driver.name : 'Unknown'),
            driverCode: driver ? driver.driverCode : '',
            rating: driver ? driver.rating : 0,
            successRate,
            overallScore: Math.round((successRate * 0.6 + (driver?.rating || 0) * 20 * 0.4))
        };
    }));

    res.json(enrichedRiders);
});

// ==================== PARTNER PERFORMANCE ====================
const getPartnerPerformance = asyncHandler(async (req, res) => {
    const scopeQuery = buildScopeQuery(req.user) ?? {};
    const dateFilter = buildDateRange(req);
    const query = { ...scopeQuery, ...dateFilter };

    const partners = await Shipment.aggregate([
        { $match: query },
        {
            $group: {
                _id: '$partnerId',
                partnerName: { $first: '$partnerName' },
                totalOrders: { $sum: 1 },
                delivered: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $in: ['$status', ['UNDELIVERED', 'REFUSED', 'CANCELLED']] }, 1, 0] } },
                revenue: { $sum: '$totalAmount' }
            }
        },
        {
            $project: {
                partnerName: 1,
                totalOrders: 1,
                delivered: 1,
                failed: 1,
                revenue: 1,
                deliverySuccessRate: { $round: [{ $multiply: [{ $divide: ['$delivered', { $max: ['$totalOrders', 1] }] }, 100] }, 2] }
            }
        },
        { $sort: { totalOrders: -1 } }
    ]);

    // Enrich with partner data
    const enriched = await Promise.all(partners.map(async (p) => {
        if (!p._id) return { ...p, rating: 0, status: 'active', location: '' };
        const partner = await Partner.findById(p._id).select('partnerCode companyName status metrics.rating address');
        return {
            ...p,
            partnerName: p.partnerName || (partner ? partner.companyName : 'Unknown'),
            partnerCode: partner ? partner.partnerCode : '',
            rating: partner ? (partner.metrics?.rating || 0) : 0,
            status: partner ? partner.status?.toLowerCase() : 'active',
            location: partner ? `${partner.address?.city || ''}, ${partner.address?.state || ''}` : ''
        };
    }));

    res.json(enriched);
});

// ==================== REVENUE REPORT ====================
const getRevenueReport = asyncHandler(async (req, res) => {
    const scopeQuery = buildScopeQuery(req.user) ?? {};
    const dateFilter = buildDateRange(req);
    const query = { ...scopeQuery, ...dateFilter };

    const { groupBy } = req.query;
    const groupId = groupBy === 'MONTH'
        ? { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }
        : groupBy === 'WEEK'
            ? { year: { $year: '$createdAt' }, week: { $week: '$createdAt' } }
            : { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } };

    const revenue = await Shipment.aggregate([
        { $match: { ...query, status: { $ne: 'CANCELLED' } } },
        {
            $group: {
                _id: groupId,
                totalRevenue: { $sum: '$totalAmount' },
                codCollected: { $sum: { $cond: [{ $eq: ['$paymentMode', 'COD'] }, '$codAmount', 0] } },
                onlinePayments: { $sum: { $cond: [{ $eq: ['$paymentMode', 'PREPAID'] }, '$totalAmount', 0] } },
                pendingCod: { $sum: { $cond: [{ $and: [{ $eq: ['$paymentMode', 'COD'] }, { $ne: ['$status', 'DELIVERED'] }] }, '$codAmount', 0] } },
                totalShipments: { $sum: 1 }
            }
        },
        { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.week': 1 } }
    ]);

    // Calculate growth
    const withGrowth = revenue.map((r, i) => {
        const prev = i > 0 ? revenue[i - 1].totalRevenue : r.totalRevenue;
        const growth = prev > 0 ? Math.round(((r.totalRevenue - prev) / prev) * 10000) / 100 : 0;
        const period = r._id.day
            ? `${r._id.year}-${String(r._id.month).padStart(2, '0')}-${String(r._id.day).padStart(2, '0')}`
            : `${r._id.year}-${String(r._id.month).padStart(2, '0')}`;
        return {
            period,
            totalRevenue: r.totalRevenue,
            codCollected: r.codCollected,
            onlinePayments: r.onlinePayments,
            pendingCod: r.pendingCod,
            totalShipments: r.totalShipments,
            growth
        };
    });

    res.json(withGrowth);
});

// ==================== SETTLEMENT REPORT ====================
const getSettlementReport = asyncHandler(async (req, res) => {
    const scopeQuery = buildScopeQuery(req.user) ?? {};
    const dateFilter = buildDateRange(req);
    const query = { ...scopeQuery, ...dateFilter };

    const settlements = await Invoice.aggregate([
        { $match: { ...query, status: { $in: ['PAID', 'PARTIALLY_PAID'] } } },
        { $unwind: '$payments' },
        {
            $match: {
                'payments.paidDate': dateFilter.createdAt ? dateFilter.createdAt : {}
            }
        },
        {
            $group: {
                _id: '$partnerId',
                partnerName: { $first: '$partnerName' },
                totalAmount: { $sum: '$payments.amount' },
                count: { $sum: 1 }
            }
        },
        { $sort: { totalAmount: -1 } }
    ]);

    res.json(settlements.map((s, i) => ({
        id: `SET-${Date.now()}-${i}`,
        partnerName: s.partnerName || 'Unknown',
        amount: s.totalAmount,
        status: 'Settled',
        transactionId: `TXN-${s._id || Date.now()}`,
        method: 'Bank Transfer',
        count: s.count
    })));
});

// ==================== GST COMPLIANCE REPORT ====================
const getGstReport = asyncHandler(async (req, res) => {
    const scopeQuery = buildScopeQuery(req.user) ?? {};
    const dateFilter = buildDateRange(req);
    const query = { ...scopeQuery, ...dateFilter };

    const gstData = await Shipment.aggregate([
        { $match: { ...query, status: { $ne: 'CANCELLED' } } },
        {
            $group: {
                _id: null,
                totalTaxableValue: { $sum: '$baseFreight' },
                totalTaxAmount: { $sum: '$taxAmount' },
                totalInvoiceValue: { $sum: '$totalAmount' },
                totalShipments: { $sum: 1 },
                cgst: { $sum: { $multiply: ['$taxAmount', 0.5] } },
                sgst: { $sum: { $multiply: ['$taxAmount', 0.5] } },
                igst: { $sum: '$taxAmount' }
            }
        }
    ]);

    const monthlyBreakdown = await Shipment.aggregate([
        { $match: { ...query, status: { $ne: 'CANCELLED' } } },
        {
            $group: {
                _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
                taxableValue: { $sum: '$baseFreight' },
                taxAmount: { $sum: '$taxAmount' },
                invoiceValue: { $sum: '$totalAmount' },
                shipmentCount: { $sum: 1 }
            }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    const summary = gstData[0] || {
        totalTaxableValue: 0,
        totalTaxAmount: 0,
        totalInvoiceValue: 0,
        totalShipments: 0,
        cgst: 0,
        sgst: 0,
        igst: 0
    };

    res.json({
        summary,
        monthlyBreakdown: monthlyBreakdown.map(m => ({
            period: `${m._id.year}-${String(m._id.month).padStart(2, '0')}`,
            taxableValue: m.taxableValue,
            taxAmount: m.taxAmount,
            invoiceValue: m.invoiceValue,
            shipmentCount: m.shipmentCount
        }))
    });
});

// ==================== EXCEPTION REPORT ====================
const getExceptionReport = asyncHandler(async (req, res) => {
    const scopeQuery = buildScopeQuery(req.user) ?? {};
    const dateFilter = buildDateRange(req);
    const query = { ...scopeQuery, ...dateFilter };

    const [typeBreakdown, severityBreakdown, statusBreakdown, financialImpact] = await Promise.all([
        Exception.aggregate([
            { $match: query },
            { $group: { _id: '$type', count: { $sum: 1 }, totalClaim: { $sum: '$financialImpact.claimAmount' }, totalRecovered: { $sum: '$financialImpact.recoveredAmount' } } },
            { $sort: { count: -1 } }
        ]),
        Exception.aggregate([
            { $match: query },
            { $group: { _id: '$severity', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]),
        Exception.aggregate([
            { $match: query },
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]),
        Exception.aggregate([
            { $match: query },
            {
                $group: {
                    _id: null,
                    totalClaimAmount: { $sum: '$financialImpact.claimAmount' },
                    totalApprovedAmount: { $sum: '$financialImpact.approvedAmount' },
                    totalRecoveredAmount: { $sum: '$financialImpact.recoveredAmount' }
                }
            }
        ])
    ]);

    const financial = financialImpact[0] || { totalClaimAmount: 0, totalApprovedAmount: 0, totalRecoveredAmount: 0 };

    res.json({
        typeBreakdown,
        severityBreakdown,
        statusBreakdown,
        financialImpact: financial
    });
});

// ==================== SLA REPORT ====================
const getSlaReport = asyncHandler(async (req, res) => {
    const scopeQuery = buildScopeQuery(req.user) ?? {};
    const dateFilter = buildDateRange(req);
    const query = { ...scopeQuery, ...dateFilter };

    // SLA: delivered shipments and their delivery time
    const slaData = await Shipment.aggregate([
        { $match: { ...query, status: 'DELIVERED' } },
        {
            $addFields: {
                deliveryTimeHours: {
                    $divide: [
                        { $subtract: ['$updatedAt', '$createdAt'] },
                        3600000
                    ]
                }
            }
        },
        {
            $group: {
                _id: null,
                totalDelivered: { $sum: 1 },
                avgDeliveryHours: { $avg: '$deliveryTimeHours' },
                within24h: { $sum: { $cond: [{ $lte: ['$deliveryTimeHours', 24] }, 1, 0] } },
                within48h: { $sum: { $cond: [{ $lte: ['$deliveryTimeHours', 48] }, 1, 0] } },
                within72h: { $sum: { $cond: [{ $lte: ['$deliveryTimeHours', 72] }, 1, 0] } },
                breached72h: { $sum: { $cond: [{ $gt: ['$deliveryTimeHours', 72] }, 1, 0] } }
            }
        }
    ]);

    const sla = slaData[0] || { totalDelivered: 0, avgDeliveryHours: 0, within24h: 0, within48h: 0, within72h: 0, breached72h: 0 };

    res.json({
        totalDelivered: sla.totalDelivered,
        avgDeliveryHours: Math.round(sla.avgDeliveryHours * 100) / 100,
        within24h: sla.within24h,
        within48h: sla.within48h,
        within72h: sla.within72h,
        breached: sla.breached72h,
        slaComplianceRate: sla.totalDelivered > 0 ? Math.round((sla.within72h / sla.totalDelivered) * 10000) / 100 : 0
    });
});

// ==================== SHIPMENT STATUS DISTRIBUTION ====================
const getShipmentStatusDistribution = asyncHandler(async (req, res) => {
    const scopeQuery = buildScopeQuery(req.user) ?? {};
    const dateFilter = buildDateRange(req);
    const query = { ...scopeQuery, ...dateFilter };

    const distribution = await Shipment.aggregate([
        { $match: query },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
    ]);

    res.json(distribution.map(d => ({ status: d._id, count: d.count })));
});

// ==================== TREND ANALYSIS ====================
const getTrendAnalysis = asyncHandler(async (req, res) => {
    const scopeQuery = buildScopeQuery(req.user) ?? {};
    const { days } = req.query;
    const numDays = parseInt(days) || 30;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - numDays);

    const query = { ...scopeQuery, createdAt: { $gte: startDate } };

    const trends = await Shipment.aggregate([
        { $match: query },
        {
            $group: {
                _id: {
                    year: { $year: '$createdAt' },
                    month: { $month: '$createdAt' },
                    day: { $dayOfMonth: '$createdAt' }
                },
                totalShipments: { $sum: 1 },
                delivered: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, 1, 0] } },
                revenue: { $sum: '$totalAmount' }
            }
        },
        { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]);

    res.json(trends.map(t => ({
        date: `${t._id.year}-${String(t._id.month).padStart(2, '0')}-${String(t._id.day).padStart(2, '0')}`,
        totalShipments: t.totalShipments,
        delivered: t.delivered,
        revenue: t.revenue
    })));
});

module.exports = {
    getDashboardSummary,
    getDeliveryPerformance,
    getRiderPerformance,
    getPartnerPerformance,
    getRevenueReport,
    getSettlementReport,
    getGstReport,
    getExceptionReport,
    getSlaReport,
    getShipmentStatusDistribution,
    getTrendAnalysis
};
