const asyncHandler = require('express-async-handler');
const Invoice = require('../models/Invoice');
const CreditDebitNote = require('../models/CreditDebitNote');
const Shipment = require('../models/Shipment');
const Customer = require('../models/Customer');
const { generateInvoiceNo, generateCreditNoteNo, generateDebitNoteNo } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// Helper: calculate invoice totals from line items
const calculateTotals = (lineItems, taxRate = 0.18) => {
    let subtotal = 0;
    let totalTax = 0;

    lineItems.forEach((item) => {
        const itemTotal = (item.baseFreight || 0) + (item.fuelSurcharge || 0) + (item.fovCharge || 0) +
            (item.odaCharge || 0) + (item.codCharge || 0);
        item.totalAmount = itemTotal + (item.taxAmount || 0);
        subtotal += itemTotal;
        totalTax += item.taxAmount || 0;
    });

    const grandTotal = subtotal + totalTax;
    return { subtotal, totalTax, grandTotal };
};

// @desc    Get all invoices (role-scoped)
// @route   GET /api/invoices
// @access  Private
const getInvoices = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, status, customerId, startDate, endDate } = req.query;
    if (search) {
        query.$or = [
            { invoiceNo: { $regex: search, $options: 'i' } },
            { customerName: { $regex: search, $options: 'i' } },
            { customerCode: { $regex: search, $options: 'i' } }
        ];
    }
    if (status && status !== 'ALL') query.status = status;
    if (customerId) query.customerId = customerId;
    if (startDate || endDate) {
        query.invoiceDate = {};
        if (startDate) query.invoiceDate.$gte = new Date(startDate);
        if (endDate) query.invoiceDate.$lte = new Date(endDate);
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [invoices, total] = await Promise.all([
        Invoice.find(query)
            .populate('customerId', 'name code email phone')
            .populate('createdBy', 'name email')
            .sort({ invoiceDate: -1 })
            .skip(skip)
            .limit(limit),
        Invoice.countDocuments(query)
    ]);

    res.json({
        data: invoices,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
});

// @desc    Get invoice stats
// @route   GET /api/invoices/stats
// @access  Private
const getInvoiceStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, draft, issued, paid, overdue, partial, cancelled] = await Promise.all([
        Invoice.countDocuments(query),
        Invoice.countDocuments({ ...query, status: 'DRAFT' }),
        Invoice.countDocuments({ ...query, status: 'ISSUED' }),
        Invoice.countDocuments({ ...query, status: 'PAID' }),
        Invoice.countDocuments({ ...query, status: 'OVERDUE' }),
        Invoice.countDocuments({ ...query, status: 'PARTIALLY_PAID' }),
        Invoice.countDocuments({ ...query, status: 'CANCELLED' })
    ]);

    const revenueAgg = await Invoice.aggregate([
        { $match: { ...query, status: { $in: ['PAID', 'PARTIALLY_PAID'] } } },
        { $group: { _id: null, totalBilled: { $sum: '$grandTotal' }, totalCollected: { $sum: '$amountPaid' }, totalOutstanding: { $sum: '$balanceDue' } } }
    ]);

    const revenue = revenueAgg[0] || { totalBilled: 0, totalCollected: 0, totalOutstanding: 0 };

    res.json({
        total,
        draft,
        issued,
        paid,
        overdue,
        partiallyPaid: partial,
        cancelled,
        totalBilled: Number(revenue.totalBilled.toFixed(2)),
        totalCollected: Number(revenue.totalCollected.toFixed(2)),
        totalOutstanding: Number(revenue.totalOutstanding.toFixed(2))
    });
});

// @desc    Get single invoice
// @route   GET /api/invoices/:id
// @access  Private
const getInvoiceById = asyncHandler(async (req, res) => {
    const invoice = await Invoice.findById(req.params.id)
        .populate('customerId')
        .populate('createdBy', 'name email')
        .populate('payments.receivedBy', 'name email');
    if (!invoice || invoice.isDeleted) {
        res.status(404);
        throw new Error('Invoice not found');
    }
    res.json(invoice);
});

// @desc    Create invoice (manual)
// @route   POST /api/invoices
// @access  Private
const createInvoice = asyncHandler(async (req, res) => {
    const partnerId = getEffectivePartnerId(req.user);
    const branchId = getEffectiveBranchId(req.user) || req.user.branchId;
    const invoiceNo = generateInvoiceNo();

    const { lineItems, customerId, customerName, customerCode, billingPeriodStart, billingPeriodEnd, invoiceDate, dueDate, taxBreakup, notes, termsAndConditions } = req.body;

    if (!customerId || !lineItems || !lineItems.length) {
        res.status(400);
        throw new Error('customerId and lineItems are required');
    }

    const totals = calculateTotals(lineItems);

    const invoice = await Invoice.create({
        invoiceNo,
        customerId,
        customerName,
        customerCode,
        billingPeriodStart,
        billingPeriodEnd,
        invoiceDate: invoiceDate || new Date(),
        dueDate,
        lineItems,
        subtotal: totals.subtotal,
        totalTax: totals.totalTax,
        grandTotal: totals.grandTotal,
        balanceDue: totals.grandTotal,
        taxBreakup: taxBreakup || [],
        notes,
        termsAndConditions,
        status: 'DRAFT',
        partnerId,
        branchId,
        createdBy: req.user._id
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'invoice',
        resourceId: invoice._id,
        description: `Invoice ${invoice.invoiceNo} created for ${customerName || customerId}`,
        details: { invoiceNo, grandTotal: totals.grandTotal }
    });

    res.status(201).json(invoice);
});

// @desc    Generate invoice from shipments (bulk billing)
// @route   POST /api/invoices/generate
// @access  Private
const generateInvoiceFromShipments = asyncHandler(async (req, res) => {
    const { customerId, shipmentIds, billingPeriodStart, billingPeriodEnd, dueDate, notes } = req.body;

    if (!customerId || !shipmentIds || !shipmentIds.length) {
        res.status(400);
        throw new Error('customerId and shipmentIds are required');
    }

    const customer = await Customer.findById(customerId);
    if (!customer) {
        res.status(404);
        throw new Error('Customer not found');
    }

    // Fetch shipments
    const shipments = await Shipment.find({ _id: { $in: shipmentIds } });
    if (!shipments.length) {
        res.status(404);
        throw new Error('No shipments found');
    }

    const partnerId = getEffectivePartnerId(req.user);
    const branchId = getEffectiveBranchId(req.user) || req.user.branchId;
    const invoiceNo = generateInvoiceNo();

    // Build line items from shipments
    const lineItems = shipments.map((s) => ({
        shipmentId: s._id,
        awb: s.awb,
        description: `Shipment ${s.awb}`,
        origin: s.sender?.city || s.sender?.address,
        destination: s.receiver?.city || s.receiver?.address,
        weight: s.weight?.actual || 0,
        chargeableWeight: s.chargeableWeight || 0,
        baseFreight: s.baseFreight || 0,
        fuelSurcharge: s.fuelSurcharge || 0,
        fovCharge: s.fovCharge || 0,
        odaCharge: s.odaCharge || 0,
        codCharge: s.codCharge || 0,
        taxAmount: s.taxAmount || 0,
        totalAmount: s.totalAmount || 0
    }));

    const totals = calculateTotals(lineItems);

    const invoice = await Invoice.create({
        invoiceNo,
        customerId: customer._id,
        customerName: customer.name,
        customerCode: customer.code,
        billingPeriodStart: billingPeriodStart || new Date(),
        billingPeriodEnd: billingPeriodEnd || new Date(),
        invoiceDate: new Date(),
        dueDate,
        lineItems,
        subtotal: totals.subtotal,
        totalTax: totals.totalTax,
        grandTotal: totals.grandTotal,
        balanceDue: totals.grandTotal,
        notes,
        status: 'DRAFT',
        partnerId,
        branchId,
        createdBy: req.user._id
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'invoice',
        resourceId: invoice._id,
        description: `Invoice ${invoice.invoiceNo} generated from ${shipments.length} shipments for ${customer.name}`,
        details: { invoiceNo, shipmentCount: shipments.length, grandTotal: totals.grandTotal }
    });

    res.status(201).json(invoice);
});

// @desc    Update invoice
// @route   PUT /api/invoices/:id
// @access  Private
const updateInvoice = asyncHandler(async (req, res) => {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || invoice.isDeleted) {
        res.status(404);
        throw new Error('Invoice not found');
    }

    if (invoice.status === 'PAID' || invoice.status === 'CANCELLED') {
        res.status(400);
        throw new Error(`Cannot edit invoice in ${invoice.status} status`);
    }

    Object.assign(invoice, req.body);

    // Recalculate totals if line items changed
    if (req.body.lineItems) {
        const totals = calculateTotals(req.body.lineItems);
        invoice.subtotal = totals.subtotal;
        invoice.totalTax = totals.totalTax;
        invoice.grandTotal = totals.grandTotal;
        invoice.balanceDue = totals.grandTotal - invoice.amountPaid;
    }

    await invoice.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'invoice',
        resourceId: invoice._id,
        description: `Invoice ${invoice.invoiceNo} updated`,
        details: req.body
    });

    res.json(invoice);
});

// @desc    Issue invoice (change status from DRAFT to ISSUED)
// @route   PUT /api/invoices/:id/issue
// @access  Private
const issueInvoice = asyncHandler(async (req, res) => {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || invoice.isDeleted) {
        res.status(404);
        throw new Error('Invoice not found');
    }
    if (invoice.status !== 'DRAFT') {
        res.status(400);
        throw new Error('Only DRAFT invoices can be issued');
    }

    invoice.status = 'ISSUED';
    if (!invoice.dueDate) {
        const due = new Date();
        due.setDate(due.getDate() + 30); // default 30-day terms
        invoice.dueDate = due;
    }
    await invoice.save();

    await logAudit(req, {
        action: 'ISSUE',
        resource: 'invoice',
        resourceId: invoice._id,
        description: `Invoice ${invoice.invoiceNo} issued`,
        details: { grandTotal: invoice.grandTotal, dueDate: invoice.dueDate }
    });

    res.json(invoice);
});

// @desc    Record payment against invoice
// @route   POST /api/invoices/:id/payments
// @access  Private
const recordPayment = asyncHandler(async (req, res) => {
    const { amount, method, referenceNo, paidDate, remarks } = req.body;

    if (!amount || amount <= 0) {
        res.status(400);
        throw new Error('Valid payment amount is required');
    }

    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || invoice.isDeleted) {
        res.status(404);
        throw new Error('Invoice not found');
    }
    if (invoice.status === 'CANCELLED') {
        res.status(400);
        throw new Error('Cannot record payment for cancelled invoice');
    }

    invoice.payments.push({
        amount: Number(amount),
        method: method || 'BANK_TRANSFER',
        referenceNo,
        paidDate: paidDate || new Date(),
        receivedBy: req.user._id,
        remarks
    });

    invoice.amountPaid = (invoice.amountPaid || 0) + Number(amount);
    invoice.balanceDue = invoice.grandTotal - invoice.amountPaid;

    if (invoice.balanceDue <= 0) {
        invoice.status = 'PAID';
        invoice.balanceDue = 0;
    } else if (invoice.amountPaid > 0) {
        invoice.status = 'PARTIALLY_PAID';
    }

    await invoice.save();

    await logAudit(req, {
        action: 'PAYMENT',
        resource: 'invoice',
        resourceId: invoice._id,
        description: `Payment of ${amount} recorded for invoice ${invoice.invoiceNo}`,
        details: { amount, method, referenceNo, balanceDue: invoice.balanceDue }
    });

    res.json(invoice);
});

// @desc    Cancel invoice
// @route   PUT /api/invoices/:id/cancel
// @access  Private
const cancelInvoice = asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || invoice.isDeleted) {
        res.status(404);
        throw new Error('Invoice not found');
    }
    if (invoice.status === 'PAID') {
        res.status(400);
        throw new Error('Cannot cancel a paid invoice. Issue a credit note instead.');
    }

    invoice.status = 'CANCELLED';
    invoice.notes = (invoice.notes || '') + `\n[Cancelled: ${reason || 'No reason provided'}]`;
    await invoice.save();

    await logAudit(req, {
        action: 'CANCEL',
        resource: 'invoice',
        resourceId: invoice._id,
        description: `Invoice ${invoice.invoiceNo} cancelled`,
        details: { reason }
    });

    res.json(invoice);
});

// @desc    Soft delete invoice
// @route   DELETE /api/invoices/:id
// @access  Private
const deleteInvoice = asyncHandler(async (req, res) => {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) {
        res.status(404);
        throw new Error('Invoice not found');
    }

    invoice.isDeleted = true;
    await invoice.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'invoice',
        resourceId: invoice._id,
        description: `Invoice ${invoice.invoiceNo} deleted`
    });

    res.json({ message: 'Invoice removed' });
});

// ==================== CREDIT / DEBIT NOTES ====================

// @desc    Get all credit/debit notes
// @route   GET /api/invoices/notes
// @access  Private
const getNotes = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, noteType, status, customerId } = req.query;
    if (search) {
        query.$or = [
            { noteNo: { $regex: search, $options: 'i' } },
            { customerName: { $regex: search, $options: 'i' } }
        ];
    }
    if (noteType && noteType !== 'ALL') query.noteType = noteType;
    if (status && status !== 'ALL') query.status = status;
    if (customerId) query.customerId = customerId;

    const notes = await CreditDebitNote.find(query)
        .populate('customerId', 'name code')
        .populate('invoiceId', 'invoiceNo')
        .sort({ noteDate: -1 });

    res.json(notes);
});

// @desc    Create credit/debit note
// @route   POST /api/invoices/notes
// @access  Private
const createNote = asyncHandler(async (req, res) => {
    const { noteType, customerId, customerName, customerCode, invoiceId, invoiceNo, reason, lineItems, notes } = req.body;

    if (!noteType || !customerId || !lineItems || !lineItems.length) {
        res.status(400);
        throw new Error('noteType, customerId and lineItems are required');
    }

    const partnerId = getEffectivePartnerId(req.user);
    const branchId = getEffectiveBranchId(req.user) || req.user.branchId;
    const noteNo = noteType === 'CREDIT' ? generateCreditNoteNo() : generateDebitNoteNo();

    const subtotal = lineItems.reduce((sum, item) => sum + (item.amount || 0), 0);
    const totalAmount = subtotal; // notes typically don't have additional tax

    const note = await CreditDebitNote.create({
        noteNo,
        noteType,
        customerId,
        customerName,
        customerCode,
        invoiceId,
        invoiceNo,
        reason,
        lineItems,
        subtotal,
        totalAmount,
        notes,
        partnerId,
        branchId,
        createdBy: req.user._id
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'credit_debit_note',
        resourceId: note._id,
        description: `${noteType} note ${note.noteNo} created for ${customerName || customerId}`,
        details: { noteNo, noteType, totalAmount }
    });

    res.status(201).json(note);
});

// @desc    Approve credit/debit note
// @route   PUT /api/invoices/notes/:id/approve
// @access  Private
const approveNote = asyncHandler(async (req, res) => {
    const note = await CreditDebitNote.findById(req.params.id);
    if (!note || note.isDeleted) {
        res.status(404);
        throw new Error('Note not found');
    }
    if (note.status !== 'PENDING') {
        res.status(400);
        throw new Error('Only pending notes can be approved');
    }

    note.status = 'APPROVED';
    note.approvedBy = req.user._id;
    note.approvedAt = new Date();
    await note.save();

    // Apply to invoice if linked
    if (note.invoiceId) {
        const invoice = await Invoice.findById(note.invoiceId);
        if (invoice) {
            if (note.noteType === 'CREDIT') {
                invoice.totalDiscount = (invoice.totalDiscount || 0) + note.totalAmount;
                invoice.grandTotal = Math.max(0, invoice.grandTotal - note.totalAmount);
                invoice.balanceDue = Math.max(0, invoice.balanceDue - note.totalAmount);
            } else {
                invoice.grandTotal += note.totalAmount;
                invoice.balanceDue += note.totalAmount;
            }
            await invoice.save();
            note.status = 'APPLIED';
            await note.save();
        }
    }

    await logAudit(req, {
        action: 'APPROVE',
        resource: 'credit_debit_note',
        resourceId: note._id,
        description: `${note.noteType} note ${note.noteNo} approved`,
        details: { totalAmount: note.totalAmount }
    });

    res.json(note);
});

module.exports = {
    getInvoices,
    getInvoiceStats,
    getInvoiceById,
    createInvoice,
    generateInvoiceFromShipments,
    updateInvoice,
    issueInvoice,
    recordPayment,
    cancelInvoice,
    deleteInvoice,
    getNotes,
    createNote,
    approveNote
};
