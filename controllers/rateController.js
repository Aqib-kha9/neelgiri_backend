const Rate = require('../models/Rate');
const asyncHandler = require('express-async-handler');

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

// @desc    Calculate shipment quote
// @route   POST /api/rates/calculate
// @access  Private
const calculateQuote = asyncHandler(async (req, res) => {
    const quote = await calculateFreight(req.body);
    res.json(quote);
});

module.exports = {
    getRates,
    createRate,
    getRateById,
    updateRate,
    deleteRate,
    calculateQuote
};
