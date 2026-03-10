const asyncHandler = require('express-async-handler');
const Role = require('../models/Role');
const Permission = require('../models/Permission');
const User = require('../models/User');
const mongoose = require('mongoose');

// @desc    Get all roles
// @route   GET /api/rbac/roles
// @access  Private (Admin)
const getRoles = asyncHandler(async (req, res) => {
    const roles = await Role.find({}).populate('permissions');

    // Get user counts for each role
    const userCounts = await User.aggregate([
        { $group: { _id: '$role', count: { $sum: 1 } } }
    ]);

    // Map counts to roles
    const rolesWithCounts = roles.map(role => {
        const countObj = userCounts.find(c => c._id && c._id.toString() === role._id.toString());
        return {
            ...role.toObject(),
            userCount: countObj ? countObj.count : 0
        };
    });

    res.json(rolesWithCounts);
});

// @desc    Create a new role
// @route   POST /api/rbac/roles
// @access  Private (Admin)
const createRole = asyncHandler(async (req, res) => {
    const { name, displayName, description, permissions } = req.body;

    const roleExists = await Role.findOne({ name });
    if (roleExists) {
        res.status(400);
        throw new Error('Role already exists');
    }

    // Convert permission strings (e.g., "order_create.read") to Permission ObjectIds
    const permissionIds = [];
    if (permissions && permissions.length > 0) {
        for (const permString of permissions) {
            const [resource, action] = permString.split('.');
            const permission = await Permission.findOne({ resource, action });
            if (permission) {
                permissionIds.push(permission._id);
            }
        }
    }

    const role = await Role.create({
        name,
        displayName,
        description,
        permissions: permissionIds,
        isSystem: false // Manually created roles are never system roles
    });

    if (role) {
        res.status(201).json(role);
    } else {
        res.status(400);
        throw new Error('Invalid role data');
    }
});

// @desc    Update role (permissions, name, etc.)
// @route   PUT /api/rbac/roles/:id
// @access  Private (Admin)
const updateRole = asyncHandler(async (req, res) => {
    const role = await Role.findById(req.params.id);

    if (role) {
        role.name = req.body.name || role.name;
        role.displayName = req.body.displayName || role.displayName;
        role.description = req.body.description || role.description;

        // Convert permission strings to ObjectIds if permissions are being updated
        if (req.body.permissions) {
            const permissionIds = [];
            for (const permString of req.body.permissions) {
                const [resource, action] = permString.split('.');
                const permission = await Permission.findOne({ resource, action });
                if (permission) {
                    permissionIds.push(permission._id);
                }
            }
            role.permissions = permissionIds;
        }

        const updatedRole = await role.save();
        res.json(updatedRole);
    } else {
        res.status(404);
        throw new Error('Role not found');
    }
});

// @desc    Delete role
// @route   DELETE /api/rbac/roles/:id
// @access  Private (Admin)
const deleteRole = asyncHandler(async (req, res) => {
    const role = await Role.findById(req.params.id);

    if (role) {
        if (role.isSystem) {
            res.status(400);
            throw new Error('Cannot delete system role');
        }

        // Cascading Delete: Delete all users assigned to this role
        const deleteUsersResult = await User.deleteMany({ role: role._id });
        console.log(`⚠️ Cascading Delete: Removed ${deleteUsersResult.deletedCount} users for role ${role.name}`);

        await role.deleteOne();
        res.json({ message: 'Role removed and associated users deleted' });
    } else {
        res.status(404);
        throw new Error('Role not found');
    }
});

// @desc    Get all permissions
// @route   GET /api/rbac/permissions
// @access  Private (Admin)
const getPermissions = asyncHandler(async (req, res) => {
    const permissions = await Permission.find({});
    // Group permissions by resource for easier frontend consumption
    const grouped = permissions.reduce((acc, curr) => {
        if (!acc[curr.resource]) {
            acc[curr.resource] = [];
        }
        acc[curr.resource].push(curr);
        return acc;
    }, {});

    res.json(grouped);
});

// @desc    Get all users (with Hierarchy & Data Isolation)
// @route   GET /api/rbac/users
// @access  Private (Admin, Partner, Branch, Dispatcher)
const getUsers = asyncHandler(async (req, res) => {
    const { role, _id, branchId } = req.user;
    let query = {};
    const excludeSelf = { _id: { $ne: _id } }; // Always exclude self

    console.log(`🔵 Fetching users for ${role.name} (${_id})`);

    // Helper: Find Role IDs by Names
    const getRoleIds = async (names) => {
        const roles = await Role.find({ name: { $in: names } }).select('_id');
        return roles.map(r => r._id);
    };

    if (role.name === 'super_admin') {
        // Super Admin sees all (excluding self for cleaner list)
        query = { ...excludeSelf };
    } else if (role.name === 'partner_admin' || role.name === 'partner' || (req.user.parentPartner && !req.user.branchId)) {
        // Partner-Level Access:
        // - Partner Admin/Partner roles
        // - Custom roles created by Partner Admin (have parentPartner but no branchId)
        // 
        // They see: 
        // 1. Users created by them (Direct Children: e.g. Branch Admins)
        // 2. Users in branches belonging to them (Grandchildren: e.g. Dispatchers in my branches)
        // 3. Customers associated with them

        // Determine the effective Partner ID
        // For partner_admin/partner: use their own _id
        // For custom roles: use their parentPartner
        const effectivePartnerId = (role.name === 'partner_admin' || role.name === 'partner') ? _id : req.user.parentPartner;

        // DYNAMIC ALLOW LIST: anything except Super Admin and Partner Admin
        const prohibitedRoles = ['super_admin', 'partner_admin', 'partner'];
        const allRoles = await Role.find({ name: { $nin: prohibitedRoles } }).select('_id');
        const allowedRoleIds = allRoles.map(r => r._id);

        // Find all branches owned by this partner
        const branches = await require('../models/Branch').find({ partnerId: effectivePartnerId }).select('_id');
        // CRITICAL: Convert ObjectIds to Strings likely needed if User.branchId is string
        const branchIds = branches.map(b => b._id.toString());

        query = {
            $and: [
                excludeSelf,
                { role: { $in: allowedRoleIds } }, // Strict Role Filter
                {
                    $or: [
                        { createdBy: effectivePartnerId },
                        { branchId: { $in: branchIds } }, // Matches string branch IDs
                        { parentPartner: effectivePartnerId },
                        { 'associations.partnerId': effectivePartnerId }
                    ]
                }
            ]
        };
    } else if (['branch_admin', 'branch', 'dispatcher'].includes(role.name)) {
        if (!branchId) return res.json([]);

        let allowedRoleNames = [];

        if (role.name === 'branch_admin' || role.name === 'branch') {
            // Branch Admin sees: Dispatcher, Rider, Customer
            allowedRoleNames = ['dispatcher', 'rider', 'customer'];

            // Branch Admin Logic: Can see all in branch (or created by self)
            const allowedRoleIds = await getRoleIds(allowedRoleNames);
            query = {
                $and: [
                    excludeSelf,
                    { role: { $in: allowedRoleIds } },
                    {
                        $or: [
                            { branchId: branchId },
                            { createdBy: _id }
                        ]
                    }
                ]
            };

        } else if (role.name === 'dispatcher') {
            // Dispatcher sees: Rider, Customer
            allowedRoleNames = ['rider', 'customer'];

            // Dispatcher Logic: Can see ALL Riders/Customers in their Branch
            // This replaces the previous "only created by me" rule to allow team collaboration
            const allowedRoleIds = await getRoleIds(allowedRoleNames);
            query = {
                $and: [
                    excludeSelf,
                    { role: { $in: allowedRoleIds } },
                    { branchId: branchId } // Scope to Branch
                ]
            };
        }
    } else {
        return res.json([]);
    }

    console.log('🔍 User Query Filter:', JSON.stringify(query, null, 2));
    console.log('🔍 Requestor Info:', {
        role: role.name,
        branchId: branchId,
        userId: _id
    });

    const users = await User.find(query)
        .populate('role')
        .populate('branchId', 'name code') // Populate Branch Name
        .populate('parentPartner', 'name email') // Populate Partner Name
        .populate({
            path: 'createdBy',
            select: 'name email role',
            populate: {
                path: 'role',
                select: 'name displayName'
            }
        })
        .select('-password')
        .sort({ createdAt: -1 });

    console.log(`✅ Found ${users.length} users`);
    if (users.length > 0) {
        console.log('📋 Users List:', users.map(u => ({
            id: u._id.toString().slice(-6),
            name: u.name,
            role: u.role?.name,
            branchId: u.branchId ? (typeof u.branchId === 'object' ? u.branchId._id.toString().slice(-6) : u.branchId.toString().slice(-6)) : 'none'
        })));
    }

    res.json(users);
});

// @desc    Get users by role ID
// @route   GET /api/rbac/roles/:roleId/users
// @access  Private (Admin)
const getUsersByRole = asyncHandler(async (req, res) => {
    const { roleId } = req.params;

    const users = await User.find({ role: roleId })
        .populate('role')
        .select('-password');

    res.json(users);
});

// @desc    Update user role
// @route   PUT /api/rbac/users/:id/role
// @access  Private (Admin)
const updateUserRole = asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    const { roleId } = req.body;

    console.log('🔵 Updating user role:', { userId: req.params.id, roleId });

    if (user) {
        // Prevent changing Super Admin's role
        const currentRole = await Role.findById(user.role);
        if (currentRole && currentRole.isSystem && currentRole.name === 'super_admin') {
            res.status(400);
            throw new Error('Cannot change role of Super Admin');
        }

        // Find role by name (if string) or by ID (if ObjectId)
        let newRole;
        if (mongoose.Types.ObjectId.isValid(roleId)) {
            newRole = await Role.findById(roleId);
        } else {
            // Assume it's a role name
            newRole = await Role.findOne({ name: roleId });
        }

        if (!newRole) {
            res.status(404);
            throw new Error('Role not found');
        }

        console.log('✅ New role found:', newRole.name, newRole._id);

        user.role = newRole._id;
        await user.save();

        // Return updated user with populated role
        const updatedUser = await User.findById(user._id).populate('role').select('-password');
        res.json(updatedUser);
    } else {
        res.status(404);
        throw new Error('User not found');
    }
});

// @desc    Create new user (Admin)
// @route   POST /api/rbac/users
// @access  Private (Admin)
const createUser = asyncHandler(async (req, res) => {
    const { name, email, password, role, branchId, status, phone } = req.body;
    const normalizedEmail = email ? email.toLowerCase().trim() : '';
    const creatorRole = req.user.role.name;
    const creatorId = req.user._id;

    console.log(`🔵 Creating user by ${creatorRole} (${req.user.name}):`, { email: normalizedEmail, role });

    // 1. Validate Creator Permissions & Hierarchy
    let targetRoleName = role; // Assume role is passed as name string
    let targetBranchId = branchId;

    // Fix: If branchId is empty string, set to undefined to prevent CastError
    if (!targetBranchId || targetBranchId === '') {
        targetBranchId = undefined;
    }

    // Helper to get Role Object
    const roleDoc = await Role.findOne({ name: targetRoleName });
    if (!roleDoc) {
        res.status(400);
        throw new Error(`Role '${targetRoleName}' not found`);
    }

    // STRICT HIERARCHY CHECK
    if (targetRoleName === 'customer') {
        res.status(400);
        throw new Error('Customers must be created through the Customer Master module');
    }

    if (creatorRole === 'super_admin') {
        // Can create ANY role (mainly Partner Admin, Global Roles)
        // No restrictions on branchId (can set freely)
    }
    else if (creatorRole === 'partner_admin' || creatorRole === 'partner') {
        // Allowed: Branch Admin, Dispatcher, Rider, Customer
        const allowedRoles = ['branch_admin', 'branch', 'dispatcher', 'rider', 'customer'];
        if (!allowedRoles.includes(targetRoleName)) {
            // Check if it's a valid Custom Role (not system role)
            // If it IS a system role and not in allowed list (e.g. super_admin), BLOCK.
            // If it is NOT a system role (isSystem=false), ALLOW.
            if (roleDoc.isSystem) {
                res.status(403);
                throw new Error('Partner Admin cannot create this system role');
            }
            // Implicitly allow custom roles
        }
        // Must allow creating Branch Admin for a SPECIFIC branch (branchId required)
        if (['branch_admin', 'branch', 'dispatcher'].includes(targetRoleName)) {
            if (!branchId) {
                res.status(400);
                throw new Error('Branch ID is required for this role');
            }
            // Verify Branch belongs to this Partner
            const branch = await require('../models/Branch').findOne({ _id: branchId, partnerId: creatorId });
            if (!branch) {
                res.status(400);
                throw new Error('Invalid Branch ID or does not belong to you');
            }
        }
    }
    else if (['branch_admin', 'branch'].includes(creatorRole)) {
        // Allowed: Dispatcher, Rider, Customer
        const allowedRoles = ['dispatcher', 'rider', 'customer'];
        if (!allowedRoles.includes(targetRoleName)) {
            res.status(403);
            throw new Error('Branch Admin cannot create this role');
        }
        // FORCE Branch ID to Creator's Branch
        targetBranchId = req.user.branchId;
    }
    else if (creatorRole === 'dispatcher') {
        // Allowed: Rider, Customer
        const allowedRoles = ['rider', 'customer'];
        if (!allowedRoles.includes(targetRoleName)) {
            res.status(403);
            throw new Error('Dispatcher cannot create this role');
        }
        // FORCE Branch ID
        targetBranchId = req.user.branchId;
    }
    else {
        res.status(403);
        throw new Error('Not authorized to create users');
    }


    // 2. Check if user exists (Customer Multi-Partner Logic)
    const existingUser = await User.findOne({ email: normalizedEmail });

    if (existingUser) {
        if (targetRoleName !== 'customer') {
            res.status(400);
            throw new Error('User with this email already exists (Non-customer roles must be unique)');
        }

        // CUSTOMER LOGIC: Add association
        console.log(`⚠️ User exists. Adding new association for Customer: ${email}`);

        // Define the new association
        // Determine the "Partner ID" for this association
        let associationPartnerId = null;
        if (creatorRole === 'super_admin') {
            // Try to infer from inputs or leave null? ideally super admin specifying branch implies partner
            // For now, if branch is present, get its partner
            if (targetBranchId) {
                const b = await require('../models/Branch').findById(targetBranchId);
                if (b) associationPartnerId = b.partnerId;
            }
        } else if (creatorRole === 'partner_admin' || creatorRole === 'partner') {
            associationPartnerId = req.user._id;
        } else {
            // Branch Admin / Dispatcher -> Partner is their creator/parent hierarchy
            // Ideally User model has parentPartner, use that
            associationPartnerId = req.user.parentPartner || req.user.createdBy; // Fallback
        }

        // Check if already associated with this partner
        const alreadyAssociated = existingUser.associations.find(a =>
            a.partnerId && associationPartnerId && a.partnerId.toString() === associationPartnerId.toString()
        );

        if (alreadyAssociated) {
            res.status(400);
            throw new Error('Customer already associated with this Partner');
        }

        existingUser.associations.push({
            partnerId: associationPartnerId,
            branchId: targetBranchId,
            roleId: roleDoc._id,
            status: 'active'
        });

        // If provided password, update it? 
        // PROMPT SAYS: "Allow creation with New password, Updated details"
        // This acts as a profile update + new association.
        if (password) existingUser.password = password; // Will re-hash
        if (name) existingUser.name = name;
        if (phone) existingUser.phone = phone;
        else if (status) existingUser.status = status;

        await existingUser.save();

        return res.json({
            message: 'Customer associated with new Partner successfully',
            user: existingUser
        });
    }

    // 3. Create New User
    // Determine Parent Partner for faster lookups
    let parentPartnerId = null;
    if (creatorRole === 'partner_admin' || creatorRole === 'partner') {
        parentPartnerId = req.user._id;
    } else if (req.user.parentPartner) {
        parentPartnerId = req.user.parentPartner;
    }

    const user = await User.create({
        name,
        email: normalizedEmail,
        password,
        role: roleDoc._id,
        branchId: targetBranchId,
        status: status || 'active',
        phone,
        createdBy: req.user._id,
        parentPartner: parentPartnerId,
        // If it's a customer, also add the initial association
        associations: targetRoleName === 'customer' ? [{
            partnerId: parentPartnerId,
            branchId: targetBranchId,
            roleId: roleDoc._id,
            status: 'active'
        }] : []
    });

    console.log('✅ User created:', user.email);

    if (user) {
        res.status(201).json({
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            branchId: user.branchId,
            status: user.status,
            phone: user.phone
        });
    } else {
        res.status(400);
        throw new Error('Invalid user data');
    }
});

// @desc    Toggle user pause status
// @route   PATCH /api/rbac/users/:id/toggle-pause
// @access  Private (Admin)
const toggleUserPause = asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);

    if (user) {
        // Prevent pausing self
        if (req.user._id.toString() === user._id.toString()) {
            res.status(400);
            throw new Error('Cannot pause yourself');
        }

        user.isPaused = !user.isPaused;
        await user.save();

        res.json({
            message: `User ${user.isPaused ? 'paused' : 'resumed'} successfully`,
            isPaused: user.isPaused
        });
    } else {
        res.status(404);
        throw new Error('User not found');
    }
});

// @desc    Update user details (name, email, role, password)
// @route   PUT /api/rbac/users/:id
// @access  Private (Admin)
const updateUser = asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    const { name, email, role, branchId, status, password, phone } = req.body;
    const requestorRole = req.user.role.name;

    console.log('🔵 Updating user:', { userId: req.params.id, updates: req.body });

    if (user) {
        // Enforce Dispatcher Ownership & Scope:
        // 1. Must be in same branch
        // 2. Target must be Rider/Customer (implicitly handled by UI/logic usually, but good to ensure)
        if (requestorRole === 'dispatcher') {
            if (user.branchId && user.branchId !== req.user.branchId) {
                res.status(403);
                throw new Error('Dispatchers can only edit users in their own branch');
            }
            // Optional: Prevent Dispatcher from editing other Dispatchers? 
            // The previous check was "createdBy", which prevented this naturally.
            // For now, assuming RBAC prevents fetching them in the first place via getUsers.
        }

        // Prevent changing Super Admin's critical details (optional safety)
        // ...

        user.name = name || user.name;
        user.email = email ? email.toLowerCase().trim() : user.email;
        // Handle branchId:
        if (branchId !== undefined) {
            if (branchId === '') {
                // If trying to clear branch, check if requestor is branch-scoped (Branch Admin/Dispatcher)
                // If so, force keep/assign to their branch to prevent user disappearing from their view
                if (['branch_admin', 'branch', 'dispatcher'].includes(requestorRole)) {
                    user.branchId = req.user.branchId;
                } else {
                    user.branchId = undefined; // Allow clearing for Partner/Super Admin
                }
            } else {
                user.branchId = branchId;
            }
        } else if (!user.branchId && ['branch_admin', 'branch', 'dispatcher'].includes(requestorRole)) {
            // Safety: If branchId wasn't sent but user has none, and is being edited by branch-scoped user, assign it.
            user.branchId = req.user.branchId;
        }
        user.status = status || user.status;
        user.phone = phone || user.phone;

        // Update Role if provided
        if (role) {
            let newRole;
            if (mongoose.Types.ObjectId.isValid(role)) {
                newRole = await Role.findById(role);
            } else {
                newRole = await Role.findOne({ name: role });
            }

            if (newRole) {
                // Prevent role change for Super Admin user safety
                const currentRole = await Role.findById(user.role);
                if (currentRole && currentRole.isSystem && currentRole.name === 'super_admin' && newRole.name !== 'super_admin') {
                    res.status(400);
                    throw new Error('Cannot change role of Super Admin to non-admin');
                }
                user.role = newRole._id;
            }
        }

        // Update Password if provided
        if (password && password.trim() !== '') {
            user.password = password; // Pre-save hook will hash this
        }

        console.log('🔍 Before Save:', {
            userId: user._id,
            name: user.name,
            role: user.role,
            branchId: user.branchId,
            status: user.status
        });

        const updatedUser = await user.save();

        console.log('✅ After Save:', {
            userId: updatedUser._id,
            name: updatedUser.name,
            role: updatedUser.role,
            branchId: updatedUser.branchId,
            status: updatedUser.status
        });

        // Return populated user
        const populated = await User.findById(updatedUser._id).populate('role').select('-password');

        console.log('📤 Returning to client:', {
            userId: populated._id,
            name: populated.name,
            role: populated.role?.name,
            branchId: populated.branchId,
            status: populated.status
        });

        res.json(populated);

    } else {
        res.status(404);
        throw new Error('User not found');
    }
});

// @desc    Delete user
// @route   DELETE /api/rbac/users/:id
// @access  Private (Admin)
const deleteUser = asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);

    if (user) {
        // Prevent deleting Super Admin
        // Optimization: Checking role name might require population if role is ObjectId
        const userRole = await Role.findById(user.role);
        if (userRole && userRole.isSystem && userRole.name === 'super_admin') {
            res.status(400);
            throw new Error('Cannot delete Super Admin user');
        }

        // Prevent self-deletion if needed (optional but good practice)
        if (req.user._id.toString() === user._id.toString()) {
            res.status(400);
            throw new Error('Cannot delete yourself');
        }

        // Enforce Dispatcher Ownership: Can only delete users in THEIR branch
        const requestorRole = req.user.role.name;
        if (requestorRole === 'dispatcher') {
            if (user.branchId && user.branchId !== req.user.branchId) {
                res.status(403);
                throw new Error('Dispatchers can only delete users in their own branch');
            }
        }

        await user.deleteOne();
        res.json({ message: 'User removed' });
    } else {
        res.status(404);
        throw new Error('User not found');
    }
});

module.exports = {
    getRoles,
    createRole,
    updateRole,
    deleteRole,
    getPermissions,
    getUsers,
    getUsersByRole,
    updateUserRole,
    updateUser,
    createUser,
    deleteUser,
    toggleUserPause
};
