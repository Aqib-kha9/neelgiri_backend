const asyncHandler = require('express-async-handler');
const Partner = require('../models/Partner');
const Vendor = require('../models/Vendor');
const User = require('../models/User');
const { generatePartnerCode, generateVendorCode, generateAgreementNo } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// ==================== PARTNER MANAGEMENT ====================

// @desc    Get all partners
// @route   GET /api/partners
// @access  Private
const getPartners = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, status } = req.query;
    if (search) {
        query.$or = [
            { partnerCode: { $regex: search, $options: 'i' } },
            { companyName: { $regex: search, $options: 'i' } },
            { contactPerson: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } }
        ];
    }
    if (status && status !== 'ALL') query.status = status;

    const partners = await Partner.find(query)
        .populate('userId', 'name email phone status')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 });

    res.json(partners);
});

// @desc    Get partner stats
// @route   GET /api/partners/stats
// @access  Private
const getPartnerStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, active, suspended, pending, terminated] = await Promise.all([
        Partner.countDocuments(query),
        Partner.countDocuments({ ...query, status: 'ACTIVE' }),
        Partner.countDocuments({ ...query, status: 'SUSPENDED' }),
        Partner.countDocuments({ ...query, status: 'PENDING' }),
        Partner.countDocuments({ ...query, status: 'TERMINATED' })
    ]);

    const revenueAgg = await Partner.aggregate([
        { $match: query },
        { $group: { _id: null, totalRevenue: { $sum: '$metrics.totalRevenue' }, totalCommission: { $sum: '$metrics.totalCommission' } } }
    ]);

    const revenue = revenueAgg[0] || { totalRevenue: 0, totalCommission: 0 };

    res.json({
        total,
        active,
        suspended,
        pending,
        terminated,
        totalRevenue: Number(revenue.totalRevenue.toFixed(2)),
        totalCommission: Number(revenue.totalCommission.toFixed(2))
    });
});

// @desc    Get single partner
// @route   GET /api/partners/:id
// @access  Private
const getPartnerById = asyncHandler(async (req, res) => {
    const partner = await Partner.findById(req.params.id)
        .populate('userId', 'name email phone status')
        .populate('createdBy', 'name email');
    if (!partner || partner.isDeleted) {
        res.status(404);
        throw new Error('Partner not found');
    }
    res.json(partner);
});

// @desc    Create partner
// @route   POST /api/partners
// @access  Private
const createPartner = asyncHandler(async (req, res) => {
    const { userId, companyName, contactPerson, email, phone, gstin, pan, address, commission, bankDetails, agreementStartDate, agreementEndDate } = req.body;

    if (!userId || !companyName) {
        res.status(400);
        throw new Error('userId and companyName are required');
    }

    const user = await User.findById(userId);
    if (!user) {
        res.status(404);
        throw new Error('User not found');
    }

    const partnerCode = generatePartnerCode();
    const agreementNo = generateAgreementNo();

    const partner = await Partner.create({
        partnerCode,
        userId,
        companyName,
        contactPerson,
        email,
        phone,
        gstin,
        pan,
        address,
        commission,
        bankDetails,
        agreementNo,
        agreementStartDate,
        agreementEndDate,
        status: 'ACTIVE',
        createdBy: req.user._id,
        partnerId: getEffectivePartnerId(req.user)
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'partner',
        resourceId: partner._id,
        description: `Partner ${partner.companyName} (${partner.partnerCode}) created`,
        details: { partnerCode, companyName }
    });

    res.status(201).json(partner);
});

// @desc    Update partner
// @route   PUT /api/partners/:id
// @access  Private
const updatePartner = asyncHandler(async (req, res) => {
    const partner = await Partner.findById(req.params.id);
    if (!partner || partner.isDeleted) {
        res.status(404);
        throw new Error('Partner not found');
    }

    Object.assign(partner, req.body);
    await partner.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'partner',
        resourceId: partner._id,
        description: `Partner ${partner.companyName} (${partner.partnerCode}) updated`,
        details: req.body
    });

    res.json(partner);
});

// @desc    Delete partner (soft)
// @route   DELETE /api/partners/:id
// @access  Private
const deletePartner = asyncHandler(async (req, res) => {
    const partner = await Partner.findById(req.params.id);
    if (!partner) {
        res.status(404);
        throw new Error('Partner not found');
    }

    partner.isDeleted = true;
    partner.status = 'TERMINATED';
    await partner.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'partner',
        resourceId: partner._id,
        description: `Partner ${partner.companyName} (${partner.partnerCode}) deleted`
    });

    res.json({ message: 'Partner removed' });
});

// ==================== VENDOR MANAGEMENT ====================

// @desc    Get all vendors
// @route   GET /api/vendors
// @access  Private
const getVendors = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, status, vendorType } = req.query;
    if (search) {
        query.$or = [
            { vendorCode: { $regex: search, $options: 'i' } },
            { companyName: { $regex: search, $options: 'i' } },
            { contactPerson: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } }
        ];
    }
    if (status && status !== 'ALL') query.status = status;
    if (vendorType && vendorType !== 'ALL') query.vendorType = vendorType;

    const vendors = await Vendor.find(query)
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 });

    res.json(vendors);
});

// @desc    Get vendor stats
// @route   GET /api/vendors/stats
// @access  Private
const getVendorStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, active, suspended, pending, terminated] = await Promise.all([
        Vendor.countDocuments(query),
        Vendor.countDocuments({ ...query, status: 'ACTIVE' }),
        Vendor.countDocuments({ ...query, status: 'SUSPENDED' }),
        Vendor.countDocuments({ ...query, status: 'PENDING' }),
        Vendor.countDocuments({ ...query, status: 'TERMINATED' })
    ]);

    const billingAgg = await Vendor.aggregate([
        { $match: query },
        { $group: { _id: null, totalBilled: { $sum: '$metrics.totalBilled' }, totalPaid: { $sum: '$metrics.totalPaid' } } }
    ]);

    const billing = billingAgg[0] || { totalBilled: 0, totalPaid: 0 };

    res.json({
        total,
        active,
        suspended,
        pending,
        terminated,
        totalBilled: Number(billing.totalBilled.toFixed(2)),
        totalPaid: Number(billing.totalPaid.toFixed(2)),
        totalOutstanding: Number((billing.totalBilled - billing.totalPaid).toFixed(2))
    });
});

// @desc    Get single vendor
// @route   GET /api/vendors/:id
// @access  Private
const getVendorById = asyncHandler(async (req, res) => {
    const vendor = await Vendor.findById(req.params.id)
        .populate('createdBy', 'name email');
    if (!vendor || vendor.isDeleted) {
        res.status(404);
        throw new Error('Vendor not found');
    }
    res.json(vendor);
});

// @desc    Create vendor
// @route   POST /api/vendors
// @access  Private
const createVendor = asyncHandler(async (req, res) => {
    const { companyName, vendorType, contactPerson, email, phone, gstin, pan, address, services, bankDetails, agreementStartDate, agreementEndDate } = req.body;

    if (!companyName) {
        res.status(400);
        throw new Error('companyName is required');
    }

    const vendorCode = generateVendorCode();
    const agreementNo = generateAgreementNo();

    const vendor = await Vendor.create({
        vendorCode,
        companyName,
        vendorType: vendorType || 'TRANSPORTER',
        contactPerson,
        email,
        phone,
        gstin,
        pan,
        address,
        services: services || [],
        bankDetails,
        agreementNo,
        agreementStartDate,
        agreementEndDate,
        status: 'PENDING',
        partnerId: getEffectivePartnerId(req.user),
        branchId: getEffectiveBranchId(req.user) || req.user.branchId,
        createdBy: req.user._id
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'vendor',
        resourceId: vendor._id,
        description: `Vendor ${vendor.companyName} (${vendor.vendorCode}) created`,
        details: { vendorCode, companyName, vendorType }
    });

    res.status(201).json(vendor);
});

// @desc    Update vendor
// @route   PUT /api/vendors/:id
// @access  Private
const updateVendor = asyncHandler(async (req, res) => {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor || vendor.isDeleted) {
        res.status(404);
        throw new Error('Vendor not found');
    }

    Object.assign(vendor, req.body);
    await vendor.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'vendor',
        resourceId: vendor._id,
        description: `Vendor ${vendor.companyName} (${vendor.vendorCode}) updated`,
        details: req.body
    });

    res.json(vendor);
});

// @desc    Delete vendor (soft)
// @route   DELETE /api/vendors/:id
// @access  Private
const deleteVendor = asyncHandler(async (req, res) => {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
        res.status(404);
        throw new Error('Vendor not found');
    }

    vendor.isDeleted = true;
    vendor.status = 'TERMINATED';
    await vendor.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'vendor',
        resourceId: vendor._id,
        description: `Vendor ${vendor.companyName} (${vendor.vendorCode}) deleted`
    });

    res.json({ message: 'Vendor removed' });
});

module.exports = {
    // Partners
    getPartners,
    getPartnerStats,
    getPartnerById,
    createPartner,
    updatePartner,
    deletePartner,
    // Vendors
    getVendors,
    getVendorStats,
    getVendorById,
    createVendor,
    updateVendor,
    deleteVendor
};
