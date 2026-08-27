const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Branch = require('../models/Branch');
const User = require('../models/User');
const Partner = require('../models/Partner');
const Role = require('../models/Role');
const Customer = require('../models/Customer');
const Pincode = require('../models/Pincode');
const Location = require('../models/Location');
const Shipment = require('../models/Shipment');
const Bag = require('../models/Bag');
const Manifest = require('../models/Manifest');
const Trip = require('../models/Trip');
const Route = require('../models/Route');
const Vehicle = require('../models/Vehicle');
const Driver = require('../models/Driver');
const { findValidBranchPincode } = require('../utils/pincodeValidation');

// @desc    Create a new branch
// @route   POST /api/branches
// @access  Private (Partner Admin, Super Admin)
const createBranch = asyncHandler(async (req, res) => {
    const {
        name, code, address, city, state, pincode, phone, contact,
        partnerId, type, ownershipType, operationalType
    } = req.body;

    const roleName = req.user.role.name;
    const requestedOwnership = ownershipType || (type === 'partner' ? 'partner' : 'company');
    if (!['company', 'partner'].includes(requestedOwnership)) {
        return res.status(400).json({ message: 'Invalid branch ownership type' });
    }

    // `type` historically came from the ownership radio buttons in the UI.
    // Keep operational type separate so hub conversion remains compatible.
    const operationalTypes = ['branch', 'hub', 'central_sorting_facility', 'regional_hub', 'metro_hub'];
    const targetType = operationalTypes.includes(operationalType) ? operationalType : 'branch';
    let targetPartnerId = null;

    if (roleName === 'super_admin') {
        if (requestedOwnership === 'partner') {
            if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
                return res.status(400).json({ message: 'A valid partner must be selected for a partner-owned branch' });
            }

            const partnerUser = await User.findById(partnerId).populate('role', 'name');
            const partnerProfile = partnerUser
                ? await Partner.findOne({ userId: partnerUser._id, isDeleted: { $ne: true } }).select('_id status')
                : null;
            if (!partnerUser || !['partner_admin', 'partner'].includes(partnerUser.role?.name) || partnerUser.status === 'inactive' || partnerUser.isInactive || !partnerProfile || partnerProfile.status !== 'ACTIVE') {
                return res.status(400).json({ message: 'Selected partner is not an active partner account' });
            }
            targetPartnerId = partnerUser._id;
        }
    } else if (roleName === 'partner_admin' || roleName === 'partner') {
        // Partner users cannot forge ownership or create company-owned branches.
        targetPartnerId = req.user._id;
    } else {
        return res.status(403).json({ message: 'Not authorized to create branches' });
    }

    // 2. Check for duplicate code
    const branchExists = await Branch.findOne({ code });
    if (branchExists) {
        res.status(400);
        throw new Error('Branch code already exists');
    }

    try {
        await findValidBranchPincode({ pincode, state, city });
    } catch (error) {
        return res.status(error.statusCode || 400).json({
            message: error.message || 'Pincode could not be verified'
        });
    }

    // 3. Construct objects
    const addressObj = {
        street: address, // Map 'address' text to street
        city,
        state,
        pincode
    };

    const contactObj = {
        phone: phone || (contact ? contact.phone : undefined),
        email: contact ? contact.email : undefined
    };

    // 4. Create Branch
    const branch = await Branch.create({
        name,
        code,
        type: targetType,
        ownershipType: roleName === 'super_admin' ? requestedOwnership : 'partner',
        partnerId: targetPartnerId,
        address: addressObj,
        contact: contactObj
    });

    res.status(201).json(branch);
});

// @desc    Get branches
// @route   GET /api/branches
// @access  Private
const getBranches = asyncHandler(async (req, res) => {
    const roleName = req.user.role.name;
    let query = {};

    // 1. Filter logic
    if (roleName === 'super_admin') {
        // Can filter by specific partner if provided in query
        if (req.query.partnerId) {
            query.partnerId = req.query.partnerId;
        }
    } else if (roleName === 'partner_admin' || roleName === 'partner') {
        if (req.query.purpose === 'dropdown') {
            // Allow Partner to see ALL branches in system if they need to forward to other partners (Inter-Partner)
            // User said: "select krne ke liye sari branches jo bhi pure system me hai"
            // So YES, Global Visibility for Destination Selection.
            // No filter on partnerId if purpose is dropdown.
        } else if (req.query.scope === 'partner') {
            // ROBUST PARTNER SCOPING:
            // Strategy 1: Direct Linkage (Branch.partnerId)
            const directQuery = { partnerId: req.user._id };

            // Strategy 2: Indirect Linkage via Created Users (Branch Admins created by this Partner)
            const childUsers = await User.find({ createdBy: req.user._id }).select('branchId');
            const indirectBranchIds = childUsers
                .map(u => u.branchId)
                .filter(id => id); // Filter null/undefined

            // Combine Queries
            query = {
                $or: [
                    { partnerId: req.user._id },
                    { _id: { $in: indirectBranchIds } },
                    { code: { $in: indirectBranchIds } } // Handle potential string IDs/codes
                ]
            };
        } else {
            // Default view (if not specific scope or purpose)
            query.partnerId = req.user._id;
        }
    } else if (req.user.parentPartner && !req.user.branchId) {
        // Custom Partner Roles (Staff without specific branch)
        if (req.query.scope === 'partner') {
            query.partnerId = req.user.parentPartner;
        } else {
            query.partnerId = req.user.parentPartner;
        }
    } else if (['branch_admin', 'branch', 'dispatcher', 'rider'].includes(roleName)) {
        if (req.query.purpose === 'dropdown') {
            // User said: "sari branches jo bhi pure system me hai"
            // GLOBAL Access for Destination Dropdown
        } else {
            // Standard View: Can only see THEIR assigned branch
            if (!req.user.branchId) {
                return res.json([]);
            }
            query._id = req.user.branchId;
        }
    } else {
        // Customers don't list branches
        return res.json([]);
    }

    const branches = await Branch.find(query).populate('partnerId', 'name email').lean();

    // Enhancements: Fetch Assigned Branch Admins using NATIVE query to bypass Schema casting issues
    // 1. Get List of Branch Identifiers (ObjectId, String ID, Code)
    const branchIds = branches.map(b => b._id);
    const branchIdsStr = branchIds.map(id => id.toString());
    const branchCodes = branches.map(b => b.code).filter(c => c); // Ensure no nulls

    // Combined list of all possible ways a branch might be referenced
    const allBranchRefs = [...branchIds, ...branchIdsStr, ...branchCodes];

    // 2. Find Roles that match "Branch Admin"
    const baRoles = await Role.find({
        name: { $in: ['branch_admin', 'branch', 'branch_manager'] }
    }).select('_id');
    const baRoleIds = baRoles.map(r => r._id.toString()); // Compare as strings for safety

    // 3. Find Users via Native Collection (Bypass Mongoose Schema Casting)
    const rawAdmins = await User.collection.find({
        branchId: { $in: allBranchRefs }
    }).project({ name: 1, email: 1, branchId: 1, role: 1 }).toArray();

    // 4. Refine List: Filter by Role (Manual Check)
    const branchAdmins = rawAdmins.filter(u => {
        if (!u.role) return false;
        return baRoleIds.includes(u.role.toString());
    });

    // 5. Map Admin to Branch
    // Create a precise lookup map for speed? No, N is small (50 branches max likely). 
    // Double loop is fine but let's be cleaner.
    const branchesWithAdmins = branches.map(branch => {
        const admin = branchAdmins.find(u => {
            if (!u.branchId) return false;
            const uBid = u.branchId.toString();
            return uBid === branch._id.toString() || uBid === branch.code;
        });

        return {
            ...branch,
            ownershipType: branch.ownershipType || (branch.partnerId ? 'partner' : 'company'),
            admin: admin ? { name: admin.name, email: admin.email } : null
        };
    });

    res.json(branchesWithAdmins);
});

// @desc    Permanently delete a branch when it has no dependent records
// @route   DELETE /api/branches/:id
// @access  Private (Partner Admin (Own), Super Admin)
const deleteBranch = asyncHandler(async (req, res) => {
    const branch = await Branch.findById(req.params.id);

    if (!branch) {
        res.status(404);
        throw new Error('Branch not found');
    }

    const roleName = req.user.role.name;
    if (roleName !== 'super_admin' && (!branch.partnerId || branch.partnerId.toString() !== req.user._id.toString())) {
        res.status(403);
        throw new Error('Not authorized to delete this branch');
    }

    const branchId = branch._id;
    const branchRefs = [branchId, branchId.toString(), branch.code].filter(Boolean);
    const checks = await Promise.all([
        User.collection.countDocuments({
            $or: [
                { branchId: { $in: branchRefs } },
                { 'associations.branchId': { $in: branchRefs } }
            ]
        }),
        Customer.countDocuments({ branchId }),
        Pincode.countDocuments({ branchId }),
        Location.countDocuments({ branchId }),
        Shipment.countDocuments({ $or: [{ branchId }, { originBranchId: branchId }, { currentBranch: branchId }, { destinationBranch: branchId }] }),
        Bag.countDocuments({ $or: [{ branchId }, { sourceBranch: branchId }, { destinationBranch: branchId }, { currentBranch: branchId }] }),
        Manifest.countDocuments({ $or: [{ branchId }, { sourceBranch: branchId }, { destinationBranch: branchId }] }),
        Trip.countDocuments({ $or: [{ branchId }, { originBranch: branchId }, { destinationBranch: branchId }] }),
        Route.countDocuments({ branchId }),
        Vehicle.countDocuments({ branchId }),
        Driver.countDocuments({ $or: [{ branchId }, { hubId: branchId.toString() }, { hubId: branch.code }] }),
        Branch.countDocuments({ $or: [{ servesBranches: branchId }, { connectedHubs: branchId }] })
    ]);

    const labels = ['users', 'customers', 'pincodes', 'locations', 'shipments', 'bags', 'manifests', 'trips', 'routes', 'vehicles', 'drivers', 'branch links'];
    const dependencies = Object.fromEntries(checks.flatMap((count, index) => count ? [[labels[index], count]] : []));
    if (Object.keys(dependencies).length) {
        res.status(409);
        return res.json({
            message: 'Branch cannot be permanently deleted because dependent records exist. Deactivate it instead or remove dependencies first.',
            dependencies
        });
    }

    await Branch.deleteOne({ _id: branchId });
    res.json({ message: 'Branch permanently deleted', branchId });
});

// @desc    Update branch
// @route   PUT /api/branches/:id
// @access  Private (Partner Admin (Own), Super Admin)
const updateBranch = asyncHandler(async (req, res) => {
    const branch = await Branch.findById(req.params.id);

    if (!branch) {
        res.status(404);
        throw new Error('Branch not found');
    }

    // Authorization
    if (req.user.role.name !== 'super_admin') {
        if (!branch.partnerId || branch.partnerId.toString() !== req.user._id.toString()) {
            res.status(403);
            throw new Error('Not authorized to update this branch');
        }
    }

    const { name, address, contact, isActive } = req.body;

    branch.name = name || branch.name;
    branch.address = address || branch.address;
    branch.contact = contact || branch.contact;
    if (isActive !== undefined) branch.isActive = isActive;

    const updatedBranch = await branch.save();
    res.json(updatedBranch);
});

// @desc    Get detailed branch hierarchy
// @route   GET /api/branches/:id/hierarchy
// @access  Private (Partner Admin, Super Admin)
const getBranchHierarchy = asyncHandler(async (req, res) => {
    const branch = await Branch.findById(req.params.id).populate('partnerId', 'name email');
    if (!branch) {
        res.status(404);
        throw new Error('Branch not found');
    }

    // Auth Check
    const roleName = req.user.role.name;
    const isGenericAdmin = ['super_admin', 'partner_admin', 'partner'].includes(roleName);

    if (!isGenericAdmin) {
        // Check if user is a Branch Admin OR Dispatcher for THIS branch
        const CAN_VIEW_OWN_BRANCH = ['branch_admin', 'branch', 'dispatcher'].includes(roleName);

        if (CAN_VIEW_OWN_BRANCH) {
            // Verify assignment
            const userBranchId = req.user.branchId ? req.user.branchId.toString() : '';
            if (userBranchId !== branch._id.toString() && userBranchId !== branch.code) {
                res.status(403);
                throw new Error('Not authorized: You can only view your own branch hierarchy');
            }
        } else {
            // Riders/Customers - deny
            if (!branch.partnerId || branch.partnerId.toString() !== req.user._id.toString()) { // Fallback check
                res.status(403);
                throw new Error('Not authorized to view this branch hierarchy');
            }
        }
    }

    // 1. Standard Mongoose Find (for valid ObjectIds)
    const standardUsers = await User.find({
        $or: [
            { branchId: branch._id },
            { branchId: branch._id.toString() }
        ]
    })
        .populate('role')
        .populate({
            path: 'createdBy',
            select: 'name email role',
            populate: { path: 'role', select: 'name' } // Deep populate role to get name
        })
        .select('-password');

    // 2. Native Mongo Find (for Legacy String IDs/Codes that verify against Schema)
    let rawLegacyUsers = [];
    try {
        rawLegacyUsers = await User.collection.find({
            $or: [
                { branchId: branch.code },
                { branchId: branch._id.toString() }
            ]
        }).toArray();
    } catch (err) {
        console.log('[Hierarchy] Native find error (ignoring):', err.message);
    }

    // 3. Hydrate Legacy Users (Fetch Roles & Creators manually)
    const allRoles = await Role.find({});
    const roleMap = {};
    allRoles.forEach(r => { roleMap[r._id.toString()] = r; });

    // 3.1 Fetch Creators for legacy users
    // Fix: Validate ObjectId to prevent CastError
    const creatorIds = [...new Set(rawLegacyUsers.map(u => u.createdBy ? u.createdBy.toString() : null).filter(id => id && mongoose.Types.ObjectId.isValid(id)))];
    const creators = await User.find({ _id: { $in: creatorIds } }).select('name email role');
    const creatorMap = {};
    creators.forEach(c => { creatorMap[c._id.toString()] = c; });

    const legacyUsers = rawLegacyUsers.map(u => {
        let roleDoc = null;
        if (u.role) {
            const roleIdStr = u.role.toString();
            roleDoc = roleMap[roleIdStr];
            if (!roleDoc && !mongoose.Types.ObjectId.isValid(roleIdStr)) {
                roleDoc = allRoles.find(r => r.name === roleIdStr);
            }
        }
        if (!roleDoc) roleDoc = { name: 'unknown', _id: u.role };

        let creatorDoc = null;
        if (u.createdBy && creatorMap[u.createdBy.toString()]) {
            creatorDoc = creatorMap[u.createdBy.toString()];
        }

        return {
            ...u,
            _id: u._id,
            role: roleDoc,
            createdBy: creatorDoc || u.createdBy,
            toObject: () => ({ ...u, role: roleDoc, createdBy: creatorDoc })
        };
    });

    // 4. Merge Unique
    const mergedUsers = [...standardUsers];
    legacyUsers.forEach(lu => {
        if (!mergedUsers.find(su => su._id.toString() === lu._id.toString())) {
            mergedUsers.push(lu);
        }
    });

    const users = mergedUsers;

    // Helper: bucket users by role
    const admins = users.filter(u => {
        const r = u.role && u.role.name ? u.role.name.toLowerCase() : '';
        return r.includes('branch') && (r.includes('admin') || r.includes('manager') || r === 'branch');
    });

    const allCustomers = users.filter(u => u.role && u.role.name === 'customer');
    const dispatchers = users.filter(u => u.role && u.role.name === 'dispatcher');
    const riders = users.filter(u => u.role && u.role.name === 'rider');
    const customers = users.filter(u => u.role && u.role.name === 'customer');

    // Build the Tree
    const tree = admins.map(admin => {
        const myDispatchers = dispatchers.filter(d => d.createdBy && d.createdBy._id && d.createdBy._id.toString() === admin._id.toString());
        const myDirectRiders = riders.filter(r => r.createdBy && r.createdBy._id && r.createdBy._id.toString() === admin._id.toString());

        const dispatcherTree = myDispatchers.map(d => {
            const drivers = riders.filter(r => r.createdBy && r.createdBy._id && r.createdBy._id.toString() === d._id.toString());
            return { ...d.toObject(), riders: drivers };
        });

        return { ...admin.toObject(), dispatchers: dispatcherTree, directRiders: myDirectRiders };
    });

    // Identify "Orphans" (Created by Partner/System directly for this branch)
    const partnerCreated = users.filter(u => {
        if (!u.createdBy) return false;

        let creatorRoleName = '';
        if (u.createdBy.role && u.createdBy.role.name) {
            creatorRoleName = u.createdBy.role.name;
        } else if (u.createdBy.role) {
            const rId = u.createdBy.role.toString();
            // Reuse allRoles from above
            const r = allRoles.find(role => role._id.toString() === rId);
            if (r) creatorRoleName = r.name;
        }

        return creatorRoleName.includes('partner') || creatorRoleName.includes('super');
    });

    // Group Partner Created by Type for display
    const partnerDirects = {
        dispatchers: partnerCreated.filter(u => u.role.name === 'dispatcher'),
        riders: partnerCreated.filter(u => u.role.name === 'rider'),
        customers: partnerCreated.filter(u => u.role.name === 'customer'),
        others: partnerCreated.filter(u => !['dispatcher', 'rider', 'customer', 'branch_admin', 'branch'].includes(u.role.name))
    };

    res.json({
        branch: branch,
        tree: tree,
        orphans: partnerDirects,
        customers: allCustomers // New field with all customers
    });
});

module.exports = {
    createBranch,
    getBranches,
    updateBranch,
    deleteBranch,
    getBranchHierarchy
};
