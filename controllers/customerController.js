const asyncHandler = require('express-async-handler');
const Customer = require('../models/Customer');
const User = require('../models/User');
const Role = require('../models/Role');
const bcrypt = require('bcrypt');

// Helper to determine effective partner ID
const getEffectivePartnerId = (user) => {
    if (user.role.name === 'partner_admin' || user.role.name === 'partner') {
        return user._id;
    }
    return user.parentPartner || user.createdBy;
};

// @desc    Get all customers
// @route   GET /api/customers
// @access  Private
const getCustomers = asyncHandler(async (req, res) => {
    const { role, _id, branchId } = req.user;
    let query = {};

    if (role.name === 'super_admin') {
        // Super admin sees all
        query = {};
    } else if (role.name === 'partner_admin' || role.name === 'partner' || (req.user.parentPartner && !branchId)) {
        // Partner scope
        const effectivePartnerId = getEffectivePartnerId(req.user);
        query = { partnerId: effectivePartnerId };
    } else if (['branch_admin', 'branch', 'dispatcher'].includes(role.name)) {
        // Branch scope
        if (!branchId) return res.json([]);
        query = { branchId: branchId };
    } else {
        return res.json([]);
    }

    const customers = await Customer.find(query).sort({ createdAt: -1 });
    res.json(customers);
});

// @desc    Create a customer
// @route   POST /api/customers
// @access  Private
const createCustomer = asyncHandler(async (req, res) => {
    const { role, _id, branchId } = req.user;
    
    // Determine the assignment structure
    let targetPartnerId = null;
    let targetBranchId = req.body.branchId || null;

    if (role.name === 'super_admin') {
        targetPartnerId = req.body.partnerId || null;
    } else if (role.name === 'partner_admin' || role.name === 'partner') {
        targetPartnerId = _id;
    } else if (['branch_admin', 'branch', 'dispatcher'].includes(role.name)) {
        targetPartnerId = req.user.parentPartner || req.user.createdBy;
        targetBranchId = req.user.branchId; // Force branch to creator's branch
    }

    // Check if customer with code already exists
    const customerExists = await Customer.findOne({ code: req.body.code, partnerId: targetPartnerId });
    if (customerExists) {
        res.status(400);
        throw new Error('Customer with this code already exists for this partner');
    }

    const customerData = {
        ...req.body,
        code: req.body.code || `CUST${Date.now()}`,
        createdBy: _id,
        partnerId: targetPartnerId,
        branchId: targetBranchId
    };

    // If portalAccess is true and email/password are provided, create a linked User account
    if (req.body.portalAccess && req.body.portalEmail) {
        // Find 'customer' Role ID
        const customerRole = await Role.findOne({ name: 'customer' });
        if (!customerRole) {
            res.status(400);
            throw new Error('Customer role definition not found in system');
        }

        const userExists = await User.findOne({ email: req.body.portalEmail });
        if (!userExists) {
            const newUser = await User.create({
                name: req.body.name,
                email: req.body.portalEmail,
                password: req.body.portalPassword || 'password123',
                role: customerRole._id,
                branchId: targetBranchId,
                status: req.body.status || 'active',
                phone: req.body.mobileNo,
                createdBy: _id,
                parentPartner: targetPartnerId,
                associations: [{
                    partnerId: targetPartnerId,
                    branchId: targetBranchId,
                    roleId: customerRole._id,
                    status: 'active'
                }]
            });
            customerData.userId = newUser._id;
        } else {
            // User exists, add association
            const alreadyAssociated = userExists.associations.find(a => 
                a.partnerId && targetPartnerId && a.partnerId.toString() === targetPartnerId.toString()
            );
            if (!alreadyAssociated) {
                userExists.associations.push({
                    partnerId: targetPartnerId,
                    branchId: targetBranchId,
                    roleId: customerRole._id,
                    status: 'active'
                });
                await userExists.save();
            }
            customerData.userId = userExists._id;
        }
    }

    const customer = await Customer.create(customerData);
    res.status(201).json(customer);
});

// @desc    Update a customer
// @route   PUT /api/customers/:id
// @access  Private
const updateCustomer = asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.params.id);
    if (!customer) {
        res.status(404);
        throw new Error('Customer not found');
    }

    // Verify ownership
    const { role } = req.user;
    if (role.name !== 'super_admin') {
        if (['partner_admin', 'partner'].includes(role.name)) {
            const effectivePartnerId = getEffectivePartnerId(req.user);
            if (customer.partnerId?.toString() !== effectivePartnerId.toString()) {
                res.status(403);
                throw new Error('Not authorized to edit this customer');
            }
        } else if (['branch_admin', 'branch', 'dispatcher'].includes(role.name)) {
            if (customer.branchId?.toString() !== req.user.branchId?.toString()) {
                res.status(403);
                throw new Error('Not authorized to edit this customer');
            }
        }
    }

    const updatedCustomer = await Customer.findByIdAndUpdate(
        req.params.id,
        req.body,
        { new: true }
    );

    res.json(updatedCustomer);
});

// @desc    Delete a customer
// @route   DELETE /api/customers/:id
// @access  Private
const deleteCustomer = asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.params.id);
    if (!customer) {
        res.status(404);
        throw new Error('Customer not found');
    }

    // Verify ownership
    const { role } = req.user;
    if (role.name !== 'super_admin') {
        if (['partner_admin', 'partner'].includes(role.name)) {
            const effectivePartnerId = getEffectivePartnerId(req.user);
            if (customer.partnerId?.toString() !== effectivePartnerId.toString()) {
                res.status(403);
                throw new Error('Not authorized to delete this customer');
            }
        } else if (['branch_admin', 'branch', 'dispatcher'].includes(role.name)) {
            if (customer.branchId?.toString() !== req.user.branchId?.toString()) {
                res.status(403);
                throw new Error('Not authorized to delete this customer');
            }
        }
    }

    // Also remove user portal association if applicable
    if (customer.userId) {
        const linkedUser = await User.findById(customer.userId);
        if (linkedUser) {
            linkedUser.associations = linkedUser.associations.filter(a => 
                a.partnerId?.toString() !== customer.partnerId?.toString()
            );
            await linkedUser.save();
        }
    }

    await customer.deleteOne();
    res.json({ message: 'Customer removed' });
});

module.exports = {
    getCustomers,
    createCustomer,
    updateCustomer,
    deleteCustomer
};
