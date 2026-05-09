const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Role = require('../models/Role');

const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: '30d',
    });
};

// @desc    Auth user & get token
// @route   POST /api/auth/login
// @access  Public
// @desc    Auth user & get token
// @route   POST /api/auth/login
// @access  Public
const loginUser = async (req, res) => {
    const { email, password, profileIndex } = req.body;

    // Normalize email
    const normalizedEmail = email ? email.toLowerCase().trim() : '';

    console.log('🔵 Login attempt:', normalizedEmail);

    try {
        const user = await User.findOne({ email: normalizedEmail }).populate({
            path: 'role',
            populate: {
                path: 'permissions'
            }
        });

        if (user && (await user.matchPassword(password))) {
            if (user.isPaused) {
                console.log('🚫 Login blocked: User is paused:', user.email);
                return res.status(403).json({ message: 'Your account has been paused. Please contact administrator.' });
            }
            console.log('✅ Login successful for:', user.email);

            // CUSTOMER MULTI-PARTNER HANDLING
            if (user.role.name === 'customer' && user.associations && user.associations.length > 0) {
                // If specific profile selection requested
                if (profileIndex !== undefined && user.associations[profileIndex]) {
                    const selected = user.associations[profileIndex];
                    if (selected.isInactive) {
                        // Prompt / Logic for inactive? For now allow login but maybe read-only?
                        // Frontend handles "View Inactive" logic
                    }
                    // Login AS this association
                    // Return token with specific branch/partner context?
                    // Or just return the standard User object but with 'branchId' and 'parentPartner' temporarily swapped for session?
                    // Let's swap them in the response so frontend uses them contextually
                    return res.json({
                        _id: user._id,
                        name: user.name,
                        email: user.email,
                        role: user.role.name,
                        roleDisplayName: user.role.displayName,
                        roleId: user.role._id,
                        permissions: user.role.permissions.map(p => ({ resource: p.resource, action: p.action })),
                        branchId: selected.branchId, // SWAPPED
                        partnerId: selected.partnerId, // Context
                        token: generateToken(user._id),
                        redirectUrl: '/dashboard',
                        isMultiProfile: true
                    });
                }

                // If NO profile selected but multiple exist:
                // Return list for Frontend to prompt "Select Profile"
                // UNLESS it's the very first time or default? 
                // Strategy: If > 1 association OR 1 association != main fields?
                // Actually, simpler: Always return profile list if customer has associations, let frontend decide to auto-select or prompt.

                // Construct friendly profile list
                // We need to fetch Partner Names for display
                const Branch = require('../models/Branch'); // Lazy load
                // Fetch names manually (optimization needed in real app)
                const profiles = await Promise.all(user.associations.map(async (assoc, idx) => {
                    // Fetch Partner Name
                    const partner = await User.findById(assoc.partnerId).select('name');
                    return {
                        index: idx,
                        partnerName: partner ? partner.name : 'Unknown Partner',
                        branchId: assoc.branchId,
                        status: assoc.status,
                        isInactive: assoc.isInactive
                    };
                }));

                return res.json({
                    _id: user._id,
                    email: user.email,
                    role: 'customer',
                    requiresProfileSelection: true, // TRIGGER FRONTEND MODAL
                    profiles: profiles
                });
            }

            // STANDARD LOGIN (Non-customer or Single Profile)
            const loginResponse = {
                _id: user._id,
                name: user.name,
                email: user.email,
                role: user.role.name,
                roleDisplayName: user.role.displayName,
                roleId: user.role._id,
                permissions: user.role.permissions.map(p => ({ resource: p.resource, action: p.action })),
                branchId: user.branchId,
                token: generateToken(user._id),
                redirectUrl: user.role.name === 'super_admin' ? '/admin/dashboard' : '/dashboard',
            };

            // Add customer profile if applicable
            if (user.role.name === 'customer') {
                const Customer = require('../models/Customer');
                const customerProfile = await Customer.findOne({ userId: user._id });
                if (customerProfile) {
                    loginResponse.customerId = customerProfile._id;
                    loginResponse.city = customerProfile.city;
                    loginResponse.pincode = customerProfile.pincode;
                    loginResponse.phone = customerProfile.mobileNo;
                    loginResponse.address = `${customerProfile.address1}${customerProfile.address2 ? ', ' + customerProfile.address2 : ''}`;
                    loginResponse.rateCard = customerProfile.rateCard;
                    loginResponse.receivers = customerProfile.receivers || [];
                    loginResponse.pickupLocations = customerProfile.pickupLocations || [];
                    loginResponse.volumetricWeightDivisor = customerProfile.volumetricWeightDivisor || 5000;
                    loginResponse.allowedServices = customerProfile.allowedServices || ['SURFACE', 'AIR'];
                    loginResponse.billingType = customerProfile.billingType;
                }
            }

            res.json(loginResponse);
        } else {
            console.log('❌ Login failed: Invalid credentials');
            res.status(401).json({ message: 'Invalid email or password' });
        }
    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get user profile
// @route   GET /api/auth/me
// @access  Private
const getUserProfile = asyncHandler(async (req, res) => {
    // Populate Role, Branch, and ParentPartner (for hierarchy name)
    const user = await User.findById(req.user._id)
        .populate({
            path: 'role',
            populate: { path: 'permissions' }
        })
        .populate('branchId', 'name code') // Fetch Branch Name
        .populate('parentPartner', 'name email') // Fetch Partner Name (Direct Parent)
        .populate('createdBy', 'name role'); // Fetch Creator for context

    if (user) {
        // Determine Hierarchy Names
        let partnerName = null;
        let branchName = user.branchId ? user.branchId.name : null;

        if (user.role.name === 'partner_admin' || user.role.name === 'partner') {
            partnerName = user.name; // I am the partner
        } else if (user.parentPartner) {
            partnerName = user.parentPartner.name;
        } else if (user.createdBy && user.createdBy.role && user.createdBy.role.name && user.createdBy.role.name.includes('partner')) {
            partnerName = user.createdBy.name;
        }

        // Determine Branch Admin Name (Structural)
        let branchAdminName = null;
        if (user.branchId && typeof user.branchId === 'object') { // It is populated
            console.log(`[Hierarchy] Looking for Branch Admin in Branch: ${user.branchId.name} (${user.branchId._id})`);
            // Debug: check what roles we are looking for
            const baRoles = await Role.find({ name: { $in: ['branch_admin', 'branch', 'branch_manager'] } });
            console.log(`[Hierarchy] Branch Admin Roles found: ${baRoles.length}`, baRoles.map(r => r.name));

            if (baRoles.length > 0) {
                // Try all matching roles
                const baRoleIds = baRoles.map(r => r._id);

                const baUser = await User.findOne({
                    branchId: user.branchId._id,
                    role: { $in: baRoleIds }
                }).select('name role');

                console.log(`[Hierarchy] Found Branch Admin User: ${baUser ? baUser.name : 'NONE'}`);
                if (baUser) branchAdminName = baUser.name;
            } else {
                console.log('[Hierarchy] NO Branch Admin Role Definition Found!');
            }
        }

        console.log('[Hierarchy] Context:', { partnerName, branchName, branchAdminName });

        // Prepare Response Object
        const responseData = {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role.name,
            roleDisplayName: user.role.displayName,
            roleId: user.role._id,
            permissions: user.role.permissions.map(p => ({ resource: p.resource, action: p.action })),
            branchId: user.branchId ? user.branchId._id : null,

            // Hierarchy Context
            branchName: branchName,
            partnerName: partnerName,
            branchAdminName: branchAdminName,
            creatorName: user.createdBy ? user.createdBy.name : null,
            childrenBranches: []
        };

        // NEW: If user is a customer, fetch their profile details from Customer model
        if (user.role.name === 'customer') {
            const Customer = require('../models/Customer');
            const customerProfile = await Customer.findOne({ userId: user._id });
            if (customerProfile) {
                responseData.customerId = customerProfile._id;
                responseData.city = customerProfile.city;
                responseData.pincode = customerProfile.pincode;
                responseData.phone = customerProfile.mobileNo;
                responseData.address = `${customerProfile.address1}${customerProfile.address2 ? ', ' + customerProfile.address2 : ''}`;
                responseData.rateCard = customerProfile.rateCard;
                responseData.receivers = customerProfile.receivers || [];
                responseData.pickupLocations = customerProfile.pickupLocations || [];
            }
        }

        // Special Case: If Partner, fetch their Branches & Branch Admins
        if (user.role.name === 'partner_admin' || user.role.name === 'partner') {
            const Branch = require('../models/Branch');
            const myBranches = await Branch.find({ partnerId: user._id });

            if (myBranches.length > 0) {
                const branchIds = myBranches.map(b => b._id);
                // Also prepare lists for legacy string matching
                const branchIdsStr = branchIds.map(id => id.toString());
                const branchCodes = myBranches.map(b => b.code);

                // Use Native Query to catch ALL formats (ObjectId, String ID, Branch Code)
                let allAdmins = [];
                try {
                    // We can't easily filter by Role ID in native query if roles are mixed types
                    // So we fetch all users linked to these branches, then filter by role name in JS
                    const potentialAdmins = await User.collection.find({
                        $or: [
                            { branchId: { $in: branchIds } },
                            { branchId: { $in: branchIdsStr } },
                            { branchId: { $in: branchCodes } }
                        ]
                    }).toArray();

                    // Retrieve Roles to check names
                    const roles = await Role.find({});
                    const roleMap = {};
                    roles.forEach(r => roleMap[r._id.toString()] = r.name);
                    const roleNameMap = {};
                    roles.forEach(r => roleNameMap[r.name] = r.name); // Self-map

                    allAdmins = potentialAdmins.filter(u => {
                        let rName = '';
                        if (u.role) {
                            const rStr = u.role.toString();
                            rName = roleMap[rStr] || roleNameMap[rStr] || '';
                        }
                        rName = rName.toLowerCase();
                        // Check if "Branch Admin" or similar
                        return rName.includes('branch') && (rName.includes('admin') || rName.includes('manager') || rName === 'branch');
                    });

                } catch (err) {
                    console.error('[Profile] Error fetching branch admins:', err);
                }

                responseData.childrenBranches = myBranches.map(b => {
                    // precise matching for this specific branch
                    const admin = allAdmins.find(u =>
                        (u.branchId && u.branchId.toString() === b._id.toString()) ||
                        (u.branchId === b.code)
                    );

                    return {
                        id: b._id,
                        name: b.name,
                        code: b.code,
                        admin: admin ? {
                            name: admin.name,
                            email: admin.email
                        } : null
                    };
                });
            }
        }

        // Send final response
        res.json(responseData);

    } else {
        res.status(404);
        throw new Error('User not found');
    }
});

module.exports = { loginUser, getUserProfile };
