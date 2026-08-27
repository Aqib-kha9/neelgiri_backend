const asyncHandler = require('express-async-handler');
const SupportTicket = require('../models/SupportTicket');
const ServiceAgreement = require('../models/ServiceAgreement');
const { generateTicketNo, generateAgreementNo } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// ==================== SUPPORT TICKETS ====================

const getTickets = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, status, priority, category, customerId } = req.query;
    if (search) {
        query.$or = [
            { ticketNo: { $regex: search, $options: 'i' } },
            { subject: { $regex: search, $options: 'i' } },
            { customerName: { $regex: search, $options: 'i' } },
            { awb: { $regex: search, $options: 'i' } }
        ];
    }
    if (status && status !== 'ALL') query.status = status;
    if (priority && priority !== 'ALL') query.priority = priority;
    if (category && category !== 'ALL') query.category = category;
    if (customerId) query.customerId = customerId;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [total, tickets] = await Promise.all([
        SupportTicket.countDocuments(query),
        SupportTicket.find(query)
            .populate('customerId', 'name customerId')
            .populate('assignedTo', 'name email')
            .populate('createdBy', 'name email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
    ]);

    res.json({
        tickets,
        page,
        pages: Math.ceil(total / limit),
        total
    });
});

const getTicketStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, open, inProgress, resolved, closed, urgent] = await Promise.all([
        SupportTicket.countDocuments(query),
        SupportTicket.countDocuments({ ...query, status: 'OPEN' }),
        SupportTicket.countDocuments({ ...query, status: 'IN_PROGRESS' }),
        SupportTicket.countDocuments({ ...query, status: 'RESOLVED' }),
        SupportTicket.countDocuments({ ...query, status: 'CLOSED' }),
        SupportTicket.countDocuments({ ...query, priority: 'URGENT', status: { $ne: 'CLOSED' } })
    ]);

    const categoryBreakdown = await SupportTicket.aggregate([
        { $match: query },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
    ]);

    const avgResolutionAgg = await SupportTicket.aggregate([
        { $match: { ...query, status: 'CLOSED', 'resolution.resolvedAt': { $exists: true } } },
        {
            $project: {
                resolutionTime: {
                    $divide: [
                        { $subtract: ['$resolution.resolvedAt', '$createdAt'] },
                        3600000
                    ]
                }
            }
        },
        { $group: { _id: null, avgResolutionHours: { $avg: '$resolutionTime' } } }
    ]);

    res.json({
        total,
        open,
        inProgress,
        resolved,
        closed,
        urgent,
        categoryBreakdown: categoryBreakdown.map(c => ({ category: c._id, count: c.count })),
        avgResolutionHours: avgResolutionAgg[0] ? Math.round(avgResolutionAgg[0].avgResolutionHours * 100) / 100 : 0
    });
});

const getTicketById = asyncHandler(async (req, res) => {
    const ticket = await SupportTicket.findById(req.params.id)
        .populate('customerId', 'name customerId phone email')
        .populate('assignedTo', 'name email')
        .populate('createdBy', 'name email')
        .populate('comments.commentBy', 'name email')
        .populate('resolution.resolvedBy', 'name email');
    if (!ticket) {
        res.status(404);
        throw new Error('Ticket not found');
    }
    res.json(ticket);
});

const createTicket = asyncHandler(async (req, res) => {
    const ticketData = {
        ...req.body,
        ticketNo: generateTicketNo(),
        partnerId: getEffectivePartnerId(req.user),
        branchId: getEffectiveBranchId(req.user),
        createdBy: req.user._id
    };

    // Set SLA based on priority
    const now = new Date();
    const slaHours = {
        URGENT: { response: 1, resolution: 4 },
        HIGH: { response: 2, resolution: 8 },
        MEDIUM: { response: 4, resolution: 24 },
        LOW: { response: 8, resolution: 48 }
    };
    const sla = slaHours[req.body.priority] || slaHours.MEDIUM;
    ticketData.sla = {
        responseDueAt: new Date(now.getTime() + sla.response * 60 * 60 * 1000),
        resolutionDueAt: new Date(now.getTime() + sla.resolution * 60 * 60 * 1000)
    };

    const ticket = await SupportTicket.create(ticketData);

    await logAudit(req, {
        action: 'CREATE',
        resource: 'support_ticket',
        resourceId: ticket._id,
        description: `Ticket ${ticket.ticketNo} created: ${ticket.subject}`
    });

    res.status(201).json(ticket);
});

const updateTicket = asyncHandler(async (req, res) => {
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) {
        res.status(404);
        throw new Error('Ticket not found');
    }

    Object.assign(ticket, req.body);
    await ticket.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'support_ticket',
        resourceId: ticket._id,
        description: `Ticket ${ticket.ticketNo} updated`
    });

    res.json(ticket);
});

const assignTicket = asyncHandler(async (req, res) => {
    const { assignedToId, assignedToName } = req.body;
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) {
        res.status(404);
        throw new Error('Ticket not found');
    }

    ticket.assignedTo = assignedToId;
    ticket.assignedToName = assignedToName;
    if (ticket.status === 'OPEN') {
        ticket.status = 'IN_PROGRESS';
        ticket.sla.respondedAt = new Date();
    }
    await ticket.save();

    await logAudit(req, {
        action: 'ASSIGN',
        resource: 'support_ticket',
        resourceId: ticket._id,
        description: `Ticket ${ticket.ticketNo} assigned to ${assignedToName}`
    });

    res.json(ticket);
});

const addComment = asyncHandler(async (req, res) => {
    const { comment, isInternal } = req.body;
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) {
        res.status(404);
        throw new Error('Ticket not found');
    }

    ticket.comments.push({
        commentBy: req.user._id,
        commentByName: req.user.name,
        comment,
        isInternal: isInternal || false
    });

    if (ticket.status === 'WAITING_CUSTOMER') {
        ticket.status = 'IN_PROGRESS';
    }

    await ticket.save();

    await logAudit(req, {
        action: 'COMMENT',
        resource: 'support_ticket',
        resourceId: ticket._id,
        description: `Comment added to ticket ${ticket.ticketNo}`
    });

    res.json(ticket);
});

const resolveTicket = asyncHandler(async (req, res) => {
    const { resolutionNote, resolutionType } = req.body;
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) {
        res.status(404);
        throw new Error('Ticket not found');
    }

    ticket.status = 'RESOLVED';
    ticket.resolution = {
        resolvedBy: req.user._id,
        resolvedByName: req.user.name,
        resolutionNote,
        resolvedAt: new Date(),
        resolutionType: resolutionType || 'RESOLVED'
    };
    ticket.sla.resolvedAt = new Date();
    await ticket.save();

    await logAudit(req, {
        action: 'RESOLVE',
        resource: 'support_ticket',
        resourceId: ticket._id,
        description: `Ticket ${ticket.ticketNo} resolved`
    });

    res.json(ticket);
});

const closeTicket = asyncHandler(async (req, res) => {
    const { rating, feedback } = req.body;
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) {
        res.status(404);
        throw new Error('Ticket not found');
    }

    if (ticket.status !== 'RESOLVED') {
        res.status(400);
        throw new Error('Only resolved tickets can be closed');
    }

    ticket.status = 'CLOSED';
    if (rating) ticket.rating = rating;
    if (feedback) ticket.feedback = feedback;
    await ticket.save();

    await logAudit(req, {
        action: 'CLOSE',
        resource: 'support_ticket',
        resourceId: ticket._id,
        description: `Ticket ${ticket.ticketNo} closed`
    });

    res.json(ticket);
});

const deleteTicket = asyncHandler(async (req, res) => {
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) {
        res.status(404);
        throw new Error('Ticket not found');
    }
    ticket.isDeleted = true;
    ticket.status = 'CLOSED';
    await ticket.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'support_ticket',
        resourceId: ticket._id,
        description: `Ticket ${ticket.ticketNo} deleted`
    });

    res.json({ message: 'Ticket removed' });
});

// ==================== SERVICE AGREEMENTS ====================

const getAgreements = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, status, customerId, agreementType } = req.query;
    if (search) {
        query.$or = [
            { agreementNo: { $regex: search, $options: 'i' } },
            { customerName: { $regex: search, $options: 'i' } }
        ];
    }
    if (status && status !== 'ALL') query.status = status;
    if (agreementType && agreementType !== 'ALL') query.agreementType = agreementType;
    if (customerId) query.customerId = customerId;

    const agreements = await ServiceAgreement.find(query)
        .populate('customerId', 'name customerId')
        .populate('createdBy', 'name email')
        .populate('approvedBy', 'name email')
        .sort({ createdAt: -1 });
    res.json(agreements);
});

const getAgreementStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, active, draft, expired, terminated] = await Promise.all([
        ServiceAgreement.countDocuments(query),
        ServiceAgreement.countDocuments({ ...query, status: 'ACTIVE' }),
        ServiceAgreement.countDocuments({ ...query, status: 'DRAFT' }),
        ServiceAgreement.countDocuments({ ...query, status: 'EXPIRED' }),
        ServiceAgreement.countDocuments({ ...query, status: 'TERMINATED' })
    ]);

    const expiringSoon = await ServiceAgreement.countDocuments({
        ...query,
        status: 'ACTIVE',
        endDate: { $lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), $gte: new Date() }
    });

    const revenueAgg = await ServiceAgreement.aggregate([
        { $match: { ...query, status: 'ACTIVE' } },
        { $group: { _id: null, totalRevenue: { $sum: '$metrics.totalRevenue' }, totalShipments: { $sum: '$metrics.totalShipments' } } }
    ]);
    const revenue = revenueAgg[0] || { totalRevenue: 0, totalShipments: 0 };

    res.json({
        total,
        active,
        draft,
        expired,
        terminated,
        expiringSoon,
        totalRevenue: revenue.totalRevenue,
        totalShipments: revenue.totalShipments
    });
});

const getAgreementById = asyncHandler(async (req, res) => {
    const agreement = await ServiceAgreement.findById(req.params.id)
        .populate('customerId', 'name customerId phone email address')
        .populate('createdBy', 'name email')
        .populate('approvedBy', 'name email');
    if (!agreement) {
        res.status(404);
        throw new Error('Service agreement not found');
    }
    res.json(agreement);
});

const createAgreement = asyncHandler(async (req, res) => {
    const agreementData = {
        ...req.body,
        agreementNo: generateAgreementNo(),
        partnerId: getEffectivePartnerId(req.user),
        branchId: getEffectiveBranchId(req.user),
        createdBy: req.user._id
    };

    const agreement = await ServiceAgreement.create(agreementData);

    await logAudit(req, {
        action: 'CREATE',
        resource: 'service_agreement',
        resourceId: agreement._id,
        description: `Agreement ${agreement.agreementNo} created for ${agreement.customerName}`
    });

    res.status(201).json(agreement);
});

const updateAgreement = asyncHandler(async (req, res) => {
    const agreement = await ServiceAgreement.findById(req.params.id);
    if (!agreement) {
        res.status(404);
        throw new Error('Service agreement not found');
    }

    Object.assign(agreement, req.body);
    await agreement.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'service_agreement',
        resourceId: agreement._id,
        description: `Agreement ${agreement.agreementNo} updated`
    });

    res.json(agreement);
});

const approveAgreement = asyncHandler(async (req, res) => {
    const agreement = await ServiceAgreement.findById(req.params.id);
    if (!agreement) {
        res.status(404);
        throw new Error('Service agreement not found');
    }

    if (agreement.status !== 'DRAFT' && agreement.status !== 'PENDING_APPROVAL') {
        res.status(400);
        throw new Error('Only draft or pending agreements can be approved');
    }

    agreement.status = 'ACTIVE';
    agreement.approvedBy = req.user._id;
    agreement.approvedAt = new Date();
    await agreement.save();

    await logAudit(req, {
        action: 'APPROVE',
        resource: 'service_agreement',
        resourceId: agreement._id,
        description: `Agreement ${agreement.agreementNo} approved and activated`
    });

    res.json(agreement);
});

const terminateAgreement = asyncHandler(async (req, res) => {
    const { terminationReason } = req.body;
    const agreement = await ServiceAgreement.findById(req.params.id);
    if (!agreement) {
        res.status(404);
        throw new Error('Service agreement not found');
    }

    agreement.status = 'TERMINATED';
    agreement.terminatedAt = new Date();
    agreement.terminationReason = terminationReason || '';
    await agreement.save();

    await logAudit(req, {
        action: 'TERMINATE',
        resource: 'service_agreement',
        resourceId: agreement._id,
        description: `Agreement ${agreement.agreementNo} terminated`
    });

    res.json(agreement);
});

const deleteAgreement = asyncHandler(async (req, res) => {
    const agreement = await ServiceAgreement.findById(req.params.id);
    if (!agreement) {
        res.status(404);
        throw new Error('Service agreement not found');
    }
    agreement.isDeleted = true;
    agreement.status = 'TERMINATED';
    await agreement.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'service_agreement',
        resourceId: agreement._id,
        description: `Agreement ${agreement.agreementNo} deleted`
    });

    res.json({ message: 'Service agreement removed' });
});

module.exports = {
    // Tickets
    getTickets,
    getTicketStats,
    getTicketById,
    createTicket,
    updateTicket,
    assignTicket,
    addComment,
    resolveTicket,
    closeTicket,
    deleteTicket,
    // Agreements
    getAgreements,
    getAgreementStats,
    getAgreementById,
    createAgreement,
    updateAgreement,
    approveAgreement,
    terminateAgreement,
    deleteAgreement
};
