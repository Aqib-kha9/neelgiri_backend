const Rate = require('../models/Rate');
const Customer = require('../models/Customer');
const asyncHandler = require('express-async-handler');
const { validatePincode, validateWeight } = require('../utils/validationGuards');
const { autoRoute } = require('../utils/autoRouter');

// @desc    Get all rates
// @route   GET /api/rates
// @access  Private
const getRates = asyncHandler(async (req, res) => {
    const rates = await Rate.find().sort({ createdAt: -1 });
    res.json(rates);
});

// @desc    Create a rate rule
// @route   POST /api/rates
// @access  Private/Admin
const createRate = asyncHandler(async (req, res) => {
    const rateData = {
        ...req.body,
        createdBy: req.user._id
    };
    const rate = await Rate.create(rateData);
    res.status(201).json(rate);
});

// @desc    Get single rate
// @route   GET /api/rates/:id
// @access  Private
const getRateById = asyncHandler(async (req, res) => {
    const rate = await Rate.findById(req.params.id);
    if (!rate) {
        res.status(404);
        throw new Error('Rate rule not found');
    }
    res.json(rate);
});

// @desc    Update rate rule
// @route   PUT /api/rates/:id
// @access  Private/Admin
const updateRate = asyncHandler(async (req, res) => {
    const rate = await Rate.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!rate) {
        res.status(404);
        throw new Error('Rate rule not found');
    }
    res.json(rate);
});

// @desc    Delete rate rule
// @route   DELETE /api/rates/:id
// @access  Private/Admin
const deleteRate = asyncHandler(async (req, res) => {
    const rate = await Rate.findById(req.params.id);
    if (!rate) {
        res.status(404);
        throw new Error('Rate rule not found');
    }
    await rate.deleteOne();
    res.json({ message: 'Rate rule removed' });
});

const { calculateFreight } = require('../utils/pricingCalculator');

// @desc    Calculate an authenticated, serviceability-aware shipment quote
// @route   POST /api/rates/calculate
// @access  Private
const calculateQuote = asyncHandler(async (req, res) => {
    const {
        sourcePincode,
        originPincode,
        destPincode,
        destinationPincode,
        weight,
        length,
        breadth,
        width,
        height,
        declaredValue,
        paymentMode,
        codAmount,
        insuranceRequested,
        fovPercentage,
        serviceType,
        mode,
        customerId
    } = req.body || {};

    const roleName = req.user?.role?.name || req.user?.role;
    const normalizedSourcePincode = String(sourcePincode || originPincode || '').trim();
    const normalizedDestPincode = String(destPincode || destinationPincode || '').trim();
    const normalizedWeight = Number(weight);
    const normalizedLength = Number(length || 0);
    const normalizedBreadth = Number(breadth ?? width ?? 0);
    const normalizedHeight = Number(height || 0);
    const normalizedDeclaredValue = Number(declaredValue || 0);
    const normalizedPaymentMode = String(paymentMode || 'prepaid').trim().toLowerCase();
    const normalizedCodAmount = normalizedPaymentMode === 'cod' ? Number(codAmount) : 0;
    const normalizedServiceType = String(serviceType || mode || 'SURFACE').trim().toUpperCase();
    const wantsInsurance = insuranceRequested === true;
    const normalizedFovPercentage = wantsInsurance && fovPercentage !== undefined && fovPercentage !== null
        ? Number(fovPercentage)
        : null;
    const errors = [];

    if (!validatePincode(normalizedSourcePincode)) errors.push('A valid 6-digit source pincode is required');
    if (!validatePincode(normalizedDestPincode)) errors.push('A valid 6-digit destination pincode is required');
    if (!validateWeight(normalizedWeight)) errors.push('Weight must be greater than 0 and no more than 10000 kg');
    if (!['SURFACE', 'AIR'].includes(normalizedServiceType)) errors.push('Service type must be SURFACE or AIR');
    if (!['prepaid', 'cod', 'topay', 'credit'].includes(normalizedPaymentMode)) errors.push('Invalid payment mode');
    if (!Number.isFinite(normalizedDeclaredValue) || normalizedDeclaredValue < 0) errors.push('Declared value must be a non-negative number');
    if (normalizedPaymentMode === 'cod' && (!Number.isFinite(normalizedCodAmount) || normalizedCodAmount <= 0)) errors.push('COD amount must be positive for COD shipments');
    if (wantsInsurance && normalizedDeclaredValue <= 0) errors.push('Declared value must be positive when insurance is selected');
    if (normalizedFovPercentage !== null && (!Number.isFinite(normalizedFovPercentage) || normalizedFovPercentage <= 0 || normalizedFovPercentage > 100)) errors.push('FOV percentage must be greater than 0 and no more than 100');

    const dimensions = [normalizedLength, normalizedBreadth, normalizedHeight];
    const hasDimensions = dimensions.some((value) => value > 0);
    if (dimensions.some((value) => !Number.isFinite(value) || value < 0) || (hasDimensions && dimensions.some((value) => value <= 0))) {
        errors.push('All dimensions must be positive when any dimension is provided');
    }

    if (errors.length > 0) {
        return res.status(400).json({ message: 'Quote validation failed', errors });
    }

    const customerQuery = roleName === 'customer'
        ? { userId: req.user._id }
        : customerId
            ? { _id: customerId }
            : { userId: req.user._id };
    const customer = await Customer.findOne(customerQuery)
        .select('_id userId branchId partnerId customerType rateCard status allowedServices')
        .lean();

    if (roleName === 'customer' && (!customer || customer.status === 'inactive')) {
        return res.status(403).json({ message: 'An active customer profile is required to calculate a quote' });
    }
    if (customerId && !customer) {
        return res.status(404).json({ message: 'Customer profile not found' });
    }
    if (customer?.status === 'inactive') {
        return res.status(400).json({ message: 'Selected customer profile is inactive' });
    }
    if (customer && roleName !== 'customer') {
        const effectivePartnerId = req.user.parentPartner || req.user.createdBy ||
            (['partner_admin', 'partner'].includes(roleName) ? req.user._id : null);
        if (effectivePartnerId && customer.partnerId && customer.partnerId.toString() !== effectivePartnerId.toString()) {
            return res.status(403).json({ message: 'Selected customer is outside your partner scope' });
        }
        if (req.user.branchId && customer.branchId && customer.branchId.toString() !== req.user.branchId.toString()) {
            return res.status(403).json({ message: 'Selected customer is outside your branch scope' });
        }
    }
    if (customer?.allowedServices?.length > 0 && !customer.allowedServices.includes(normalizedServiceType)) {
        return res.status(403).json({ message: `${normalizedServiceType} service is not enabled for this customer` });
    }

    const routing = await autoRoute(normalizedSourcePincode, normalizedDestPincode);
    if (!routing.serviceable || !routing.originBranch || !routing.destinationBranch) {
        return res.status(400).json({
            message: 'Shipment route is not serviceable',
            errors: routing.errors || ['No active route found for the supplied pincodes']
        });
    }

    const quote = await calculateFreight({
        rateCardId: customer?.rateCard || undefined,
        sourcePincode: normalizedSourcePincode,
        destPincode: normalizedDestPincode,
        weight: normalizedWeight,
        length: normalizedLength,
        breadth: normalizedBreadth,
        height: normalizedHeight,
        declaredValue: normalizedDeclaredValue,
        codAmount: normalizedCodAmount,
        isCOD: normalizedPaymentMode === 'cod',
        insuranceRequested: wantsInsurance,
        fovPercentage: normalizedFovPercentage,
        customerId: customer?._id,
        customerType: 'CUSTOMER',
        serviceType: normalizedServiceType
    });

    return res.json({
        ...quote,
        serviceability: {
            serviceable: true,
            isLocal: routing.isLocal,
            isODA: routing.isODA,
            estimatedTransitDays: routing.estimatedTransitDays,
            originBranchId: routing.originBranch._id,
            destinationBranchId: routing.destinationBranch._id
        }
    });
});

module.exports = {
    getRates,
    createRate,
    getRateById,
    updateRate,
    deleteRate,
    calculateQuote
};
