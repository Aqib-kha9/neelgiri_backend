const Pincode = require('../models/Pincode');
const Branch = require('../models/Branch');
const Location = require('../models/Location');

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asyncHandler = require('express-async-handler');
const { findValidBranchPincode } = require('../utils/pincodeValidation');

const SERVICE_LOCATION_TYPES = ['BRANCH', 'DELIVERY_CENTER', 'PICKUP_POINT'];

const validateServiceLocation = async (locationId) => {
    if (!locationId) return null;

    const location = await Location.findOne({
        _id: locationId,
        isDeleted: { $ne: true }
    });

    if (!location) {
        throw new Error('Selected operational location was not found');
    }
    if (location.status !== 'ACTIVE') {
        throw new Error('Pincodes can only be mapped to an active operational location');
    }
    if (!SERVICE_LOCATION_TYPES.includes(location.type)) {
        throw new Error('Pincodes can only be mapped to a Branch, Delivery Centre, or Pickup Point');
    }

    return location;
};

// Helper: get branch IDs scoped to the requesting user's role
const getScopedBranchFilter = async (req) => {
    const roleName = req.user.role.name;
    if (roleName === 'super_admin') {
        return null; // No filter — see everything
    }
    if (['partner_admin', 'partner'].includes(roleName)) {
        // All branches under this partner
        const branches = await Branch.find({ partnerId: req.user._id }).select('_id');
        const ids = branches.map(b => b._id);
        return ids.length > 0 ? { branchId: { $in: ids } } : { branchId: null }; // if no branches, show nothing
    }
    if (['branch_admin', 'branch'].includes(roleName)) {
        // Only their assigned branch's pincodes
        return req.user.branchId
            ? { branchId: req.user.branchId }
            : { branchId: null }; // no branch = see nothing
    }
    // dispatcher, rider, customer → no access to pincode master
    return { branchId: null };
};

// @desc    Get pincodes (role-scoped)
// @route   GET /api/pincodes
// @access  Private
const getPincodes = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const skip = (page - 1) * limit;

    const query = {};

    // Apply role-based scoping
    const scopeFilter = await getScopedBranchFilter(req);
    if (scopeFilter !== null) {
        Object.assign(query, scopeFilter);
    }

    // Additional user-supplied filters
    if (req.query.search) {
        query.$or = [
            { pincode: { $regex: req.query.search, $options: 'i' } },
            { officeName: { $regex: req.query.search, $options: 'i' } },
            { district: { $regex: req.query.search, $options: 'i' } }
        ];
    }
    if (req.query.state && req.query.state !== 'all') {
        query.state = { $regex: `^${escapeRegex(req.query.state.trim())}$`, $options: 'i' };
    }
    if (req.query.district && req.query.district !== 'all') {
        query.district = { $regex: `^${escapeRegex(req.query.district.trim())}$`, $options: 'i' };
    }
    if (req.query.isServiceable) query.isServiceable = req.query.isServiceable === 'true';
    if (req.query.isActiveForBranch) query.isActiveForBranch = req.query.isActiveForBranch === 'true';

    // Existing commercial branch mapping filter
    if (req.query.mapping === 'mapped') {
        query.branchId = { $ne: null };
    } else if (req.query.mapping === 'unmapped') {
        query.branchId = null;
    }

    // Operational Location Master mapping filter
    if (req.query.locationId && req.query.locationId !== 'all') {
        query.locationId = req.query.locationId;
    }
    if (req.query.locationMapping === 'mapped') {
        query.locationId = { $ne: null };
    } else if (req.query.locationMapping === 'unmapped') {
        query.locationId = null;
    }

    const pincodes = await Pincode.find(query)
        .populate('branchId', 'name code')
        .populate('locationId', 'name code type address status')
        .sort({ pincode: 1 })
        .skip(skip)
        .limit(limit);

    const total = await Pincode.countDocuments(query);

    res.json({
        pincodes,
        page,
        pages: Math.ceil(total / limit),
        total
    });
});

// @desc    Get distinct states and districts (scoped by role or global)
// @route   GET /api/pincodes/locations/distinct
// @access  Private
const getDistinctLocations = asyncHandler(async (req, res) => {
    let matchQuery = {};
    if (req.query.global !== 'true') {
        const scopeFilter = await getScopedBranchFilter(req);
        matchQuery = scopeFilter !== null ? scopeFilter : {};
    }

    const states = await Pincode.distinct('state', matchQuery);
    const districts = await Pincode.distinct('district', matchQuery);
    res.json({ states, districts });
});

// @desc    Global pincode search — all pincodes regardless of branch (for Branch Admin to find & claim)
// @route   GET /api/pincodes/global-search
// @access  Private
const globalSearchPincode = asyncHandler(async (req, res) => {
    const search = req.query.q || '';
    const state = req.query.state;
    const district = req.query.district;
    
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 100;
    const skip = (page - 1) * limit;

    if (!district && !state && search.length < 2) {
        return res.json({ pincodes: [], total: 0, page: 1, pages: 1 });
    }

    const query = {};

    if (search.length >= 2) {
        query.$or = [
            { pincode: { $regex: search, $options: 'i' } },
            { officeName: { $regex: search, $options: 'i' } },
            { district: { $regex: search, $options: 'i' } }
        ];
    }
    
    if (state && state !== 'all') {
        query.state = { $regex: `^${escapeRegex(String(state).trim())}$`, $options: 'i' };
    }
    if (district && district !== 'all') {
        query.district = { $regex: `^${escapeRegex(String(district).trim())}$`, $options: 'i' };
    }

    // Only allow non-super_admins to see globally serviceable and unmapped pincodes for claiming
    if (req.user.role.name !== 'super_admin') {
        query.isServiceable = true;
        query.branchId = null;
    }

    const total = await Pincode.countDocuments(query);
    const results = await Pincode.find(query)
        .populate('branchId', 'name code')
        .populate('locationId', 'name code type address status')
        .skip(skip)
        .limit(Math.min(limit, 500)) // Cap limit at 500
        .sort({ pincode: 1 });

    res.json({
        pincodes: results,
        total,
        page,
        pages: Math.ceil(total / limit)
    });
});

// @desc    Bulk update serviceability by district or state
// @route   POST /api/pincodes/bulk-update
// @access  Private/Admin
const bulkUpdateServiceability = asyncHandler(async (req, res) => {
    const { district, state, isServiceable, branchId } = req.body;
    const roleName = req.user.role.name;

    if (!district && !state) {
        res.status(400);
        throw new Error('Please provide a district or state for bulk update');
    }

    const filter = {};
    if (district) filter.district = district;
    if (state) filter.state = state;

    // Branch/Partner admin can only update pincodes they own
    if (['branch_admin', 'branch'].includes(roleName)) {
        filter.branchId = req.user.branchId;
    } else if (['partner_admin', 'partner'].includes(roleName)) {
        const branches = await Branch.find({ partnerId: req.user._id }).select('_id');
        filter.branchId = { $in: branches.map(b => b._id) };
    }

    // Determine effective branchId to assign
    let effectiveBranchId = branchId;
    if (['branch_admin', 'branch'].includes(roleName)) {
        effectiveBranchId = req.user.branchId; // Force own branch
    }

    let update = {};
    if (roleName === 'super_admin') {
        update = {
            isServiceable,
            branchId: isServiceable ? effectiveBranchId : null
        };
    } else {
        // Branch/Partner admin updates local status
        update = {
            isActiveForBranch: isServiceable // here we treat the incoming 'isServiceable' as the local toggle
        };
    }

    const result = await Pincode.updateMany(filter, update);

    res.json({
        message: `Updated ${result.modifiedCount} pincodes in ${district || state}`,
        count: result.modifiedCount
    });
});

// @desc    Validate a pincode for a branch location
// @route   GET /api/pincodes/validate-branch/:pincode
// @access  Private (Partner Admin, Super Admin)
const validateBranchPincode = asyncHandler(async (req, res) => {
    const roleName = req.user.role.name;
    if (!['super_admin', 'partner_admin', 'partner'].includes(roleName)) {
        res.status(403);
        throw new Error('Not authorized to validate branch pincodes');
    }

    try {
        const pincode = await findValidBranchPincode({
            pincode: req.params.pincode,
            state: req.query.state,
            city: req.query.city
        });

        return res.json({
            valid: true,
            pincode: pincode.pincode,
            officeName: pincode.officeName || '',
            district: pincode.district || '',
            state: pincode.state || ''
        });
    } catch (error) {
        return res.status(error.statusCode || 400).json({
            valid: false,
            message: error.message || 'Pincode could not be verified'
        });
    }
});

// @desc    Check single pincode serviceability (public)
// @route   GET /api/pincodes/check/:pincode
// @access  Public
const checkPincode = asyncHandler(async (req, res) => {
    const normalizedPincode = String(req.params.pincode || '').trim();
    const pincode = await Pincode.findOne({
        pincode: normalizedPincode,
        isServiceable: true,
        isActiveForBranch: true,
        branchId: { $ne: null }
    })
        .populate({
            path: 'branchId',
            select: 'name code isActive',
            match: { isActive: true }
        })
        .populate('locationId', 'name code type address status');

    if (!pincode || !pincode.branchId) {
        return res.status(404).json({
            serviceable: false,
            message: 'Pickup service is not currently available for this pincode'
        });
    }

    res.json({
        ...pincode.toObject(),
        serviceable: true
    });
});

// @desc    Create a pincode (super_admin only)
// @route   POST /api/pincodes
// @access  Private/Admin
const createPincode = asyncHandler(async (req, res) => {
    const roleName = req.user.role.name;

    // Branch admin / partner admin should use the claim endpoint instead
    if (['branch_admin', 'branch'].includes(roleName)) {
        res.status(403);
        throw new Error('Branch Admin cannot create new pincodes. Use the Claim endpoint to assign existing pincodes to your branch.');
    }

    if (req.body.locationId) {
        await validateServiceLocation(req.body.locationId);
    }

    const pincodeData = {
        ...req.body,
        locationId: req.body.locationId || null,
        createdBy: req.user._id
    };
    const pincode = await Pincode.create(pincodeData);
    const populated = await Pincode.findById(pincode._id)
        .populate('branchId', 'name code')
        .populate('locationId', 'name code type address status');
    res.status(201).json(populated);
});

// @desc    Claim a pincode for the requester's branch (set branchId + isServiceable)
// @route   POST /api/pincodes/:id/claim
// @access  Private (branch_admin, partner_admin)
const claimPincode = asyncHandler(async (req, res) => {
    const roleName = req.user.role.name;

    // Determine which branch we are claiming for
    let claimBranchId;
    if (['branch_admin', 'branch'].includes(roleName)) {
        claimBranchId = req.user.branchId;
    } else if (['partner_admin', 'partner'].includes(roleName)) {
        // Partner admin must specify which of their branches
        claimBranchId = req.body.branchId;
        if (!claimBranchId) {
            res.status(400);
            throw new Error('Partner Admin must specify branchId when claiming a pincode');
        }
        // Verify branch belongs to this partner
        const branch = await Branch.findOne({ _id: claimBranchId, partnerId: req.user._id });
        if (!branch) {
            res.status(403);
            throw new Error('Branch does not belong to your partner account');
        }
    } else if (roleName === 'super_admin') {
        claimBranchId = req.body.branchId;
    } else {
        res.status(403);
        throw new Error('Not authorized to claim pincodes');
    }

    if (!claimBranchId) {
        res.status(400);
        throw new Error('No branch assigned to your account. Contact your administrator.');
    }

    const pincode = await Pincode.findById(req.params.id).populate('branchId', 'name code');
    if (!pincode) {
        res.status(404);
        throw new Error('Pincode not found');
    }

    // Verify global serviceability
    if (!pincode.isServiceable && roleName !== 'super_admin') {
        res.status(403);
        throw new Error('This pincode is globally disabled by Super Admin and cannot be claimed');
    }

    // Check if already claimed by a DIFFERENT branch
    if (
        pincode.branchId &&
        pincode.branchId._id.toString() !== claimBranchId.toString()
    ) {
        res.status(409);
        throw new Error(`Pincode ${pincode.pincode} is already assigned to branch "${pincode.branchId.name}". Contact Super Admin to reassign.`);
    }

    // Assign branch and activate
    pincode.branchId = claimBranchId;
    pincode.isActiveForBranch = true;
    if (roleName === 'super_admin') pincode.isServiceable = true;
    
    if (req.body.transitDays) pincode.transitDays = req.body.transitDays;
    if (req.body.isODA !== undefined) pincode.isODA = req.body.isODA;

    await pincode.save();
    const updated = await Pincode.findById(pincode._id).populate('branchId', 'name code');

    res.json({
        message: `Pincode ${pincode.pincode} successfully claimed for your branch`,
        pincode: updated
    });
});

// @desc    Bulk claim multiple pincodes for the requester's branch
// @route   POST /api/pincodes/bulk-claim
// @access  Private (branch_admin, partner_admin)
const bulkClaimPincodes = asyncHandler(async (req, res) => {
    const roleName = req.user.role.name;
    const { pincodeIds, branchId: reqBranchId } = req.body;

    if (!Array.isArray(pincodeIds) || pincodeIds.length === 0) {
        res.status(400);
        throw new Error('Please provide an array of pincodeIds to claim');
    }

    // Determine target branch
    let claimBranchId;
    if (['branch_admin', 'branch'].includes(roleName)) {
        claimBranchId = req.user.branchId;
    } else if (['partner_admin', 'partner'].includes(roleName)) {
        claimBranchId = reqBranchId;
        if (!claimBranchId) {
            res.status(400);
            throw new Error('Partner Admin must specify branchId for bulk claim');
        }
        // Verify ownership
        const branch = await Branch.findOne({ _id: claimBranchId, partnerId: req.user._id });
        if (!branch) {
            res.status(403);
            throw new Error('Branch does not belong to your partner account');
        }
    } else if (roleName === 'super_admin') {
        claimBranchId = reqBranchId;
    }

    if (!claimBranchId) {
        res.status(400);
        throw new Error('No valid branch assigned for claiming');
    }

    // Find all requested pincodes
    const pincodesToClaim = await Pincode.find({ _id: { $in: pincodeIds } });

    // Filter out pincodes already assigned to a DIFFERENT branch OR globally disabled
    const validPincodeIds = pincodesToClaim
        .filter(p => {
            const isAvailable = !p.branchId || p.branchId.toString() === claimBranchId.toString();
            const isGloballyActive = p.isServiceable || roleName === 'super_admin';
            return isAvailable && isGloballyActive;
        })
        .map(p => p._id);

    const skippedCount = pincodeIds.length - validPincodeIds.length;

    if (validPincodeIds.length === 0) {
        res.status(409);
        throw new Error('All selected pincodes are already assigned to other branches');
    }

    // Perform bulk update
    await Pincode.updateMany(
        { _id: { $in: validPincodeIds } },
        {
            $set: {
                branchId: claimBranchId,
                isActiveForBranch: true,
                ...(roleName === 'super_admin' ? { isServiceable: true } : {})
            }
        }
    );

    res.json({
        message: `Successfully claimed ${validPincodeIds.length} pincodes.${skippedCount > 0 ? ` Skipped ${skippedCount} items already assigned elsewhere.` : ''}`,
        claimedCount: validPincodeIds.length,
        skippedCount
    });
});

// @desc    Release a pincode (Remove branch assignment)
// @route   POST /api/pincodes/:id/release
// @access  Private (branch_admin, partner_admin)
const releasePincode = asyncHandler(async (req, res) => {
    const roleName = req.user.role.name;
    const pincode = await Pincode.findById(req.params.id);

    if (!pincode) {
        res.status(404);
        throw new Error('Pincode not found');
    }

    // Must be assigned to release
    if (!pincode.branchId) {
        res.status(400);
        throw new Error('Pincode is not assigned to any branch');
    }

    // Verify ownership
    if (['branch_admin', 'branch'].includes(roleName)) {
        if (pincode.branchId.toString() !== req.user.branchId.toString()) {
            res.status(403);
            throw new Error('Not authorized to release pincodes of other branches');
        }
    } else if (['partner_admin', 'partner'].includes(roleName)) {
        const branches = await Branch.find({ partnerId: req.user._id }).select('_id');
        const allowedBranchIds = branches.map(b => b._id.toString());
        if (!allowedBranchIds.includes(pincode.branchId.toString())) {
            res.status(403);
            throw new Error('Not authorized to release pincodes not belonging to your partner');
        }
    } else if (roleName !== 'super_admin') {
        res.status(403);
        throw new Error('Not authorized to release pincodes');
    }

    // Unassign and deactivate
    pincode.branchId = undefined; // Need to remove it. mongoose uses undefined for unset.
    pincode.isServiceable = false;
    await pincode.save();

    res.json({ message: `Pincode ${pincode.pincode} released back to global pool successfully` });
});

// @desc    Update pincode (scoped — branch admin can only edit their own branch's pincodes & limited fields)
// @route   PUT /api/pincodes/:id
// @access  Private
const updatePincode = asyncHandler(async (req, res) => {
    const roleName = req.user.role.name;
    const pincode = await Pincode.findById(req.params.id);

    if (!pincode) {
        res.status(404);
        throw new Error('Pincode not found');
    }

    // Scope check for branch_admin
    if (['branch_admin', 'branch'].includes(roleName)) {
        if (!pincode.branchId || pincode.branchId.toString() !== req.user.branchId.toString()) {
            res.status(403);
            throw new Error('Not authorized: This pincode does not belong to your branch');
        }
        // Branch Admin can ONLY update these fields
        const allowedFields = ['isActiveForBranch', 'isODA', 'transitDays'];
        const updateData = {};
        allowedFields.forEach(f => {
            if (req.body[f] !== undefined) updateData[f] = req.body[f];
        });

        // Ensure transitDays is numeric
        if (updateData.transitDays !== undefined) updateData.transitDays = Number(updateData.transitDays);

        const updated = await Pincode.findByIdAndUpdate(req.params.id, updateData, { new: true }).populate('branchId', 'name code');
        return res.json(updated);
    }

    // Partner admin: can only update their own branches' pincodes
    if (['partner_admin', 'partner'].includes(roleName)) {
        if (pincode.branchId) {
            const branch = await Branch.findOne({ _id: pincode.branchId, partnerId: req.user._id });
            if (!branch) {
                res.status(403);
                throw new Error('Not authorized: This pincode does not belong to your partner account');
            }
        }
        // Partner admin gets same field restrictions as branch admin
        const allowedFields = ['isActiveForBranch', 'isODA', 'transitDays', 'branchId'];
        const updateData = {};
        allowedFields.forEach(f => {
            if (req.body[f] !== undefined) updateData[f] = req.body[f];
        });

        // Ensure transitDays is numeric
        if (updateData.transitDays !== undefined) updateData.transitDays = Number(updateData.transitDays);

        const updated = await Pincode.findByIdAndUpdate(req.params.id, updateData, { new: true }).populate('branchId', 'name code');
        return res.json(updated);
    }

    // super_admin: full update, with operational-facility validation
    if (req.body.locationId) {
        await validateServiceLocation(req.body.locationId);
    }

    const updateData = {
        ...req.body,
        ...(req.body.locationId === '' ? { locationId: null } : {})
    };
    const updated = await Pincode.findByIdAndUpdate(req.params.id, updateData, {
        new: true,
        runValidators: true
    })
        .populate('branchId', 'name code')
        .populate('locationId', 'name code type address status');
    res.json(updated);
});

// @desc    Map selected pincodes to an operational Location Master facility
// @route   POST /api/pincodes/bulk-map-location
// @access  Private/Super Admin
const bulkMapLocation = asyncHandler(async (req, res) => {
    if (req.user.role.name !== 'super_admin') {
        res.status(403);
        throw new Error('Only Super Admin can change operational location mapping');
    }

    const { pincodeIds, locationId } = req.body;
    if (!Array.isArray(pincodeIds) || pincodeIds.length === 0) {
        res.status(400);
        throw new Error('Please select at least one pincode');
    }

    const location = locationId ? await validateServiceLocation(locationId) : null;
    const result = await Pincode.updateMany(
        { _id: { $in: pincodeIds } },
        { $set: { locationId: location?._id || null } }
    );

    res.json({
        message: location
            ? `Mapped ${result.modifiedCount} pincodes to ${location.name}`
            : `Removed operational location mapping from ${result.modifiedCount} pincodes`,
        count: result.modifiedCount,
        location
    });
});

// @desc    Delete pincode (super_admin only)
// @route   DELETE /api/pincodes/:id
// @access  Private/Admin
const deletePincode = asyncHandler(async (req, res) => {
    const roleName = req.user.role.name;
    if (roleName !== 'super_admin') {
        res.status(403);
        throw new Error('Only Super Admin can delete pincodes');
    }

    const pincode = await Pincode.findById(req.params.id);
    if (!pincode) {
        res.status(404);
        throw new Error('Pincode not found');
    }
    await pincode.deleteOne();
    res.json({ message: 'Pincode removed' });
});

// @desc    Bulk Create/Import pincodes (super_admin only)
// @route   POST /api/pincodes/bulk
// @access  Private/Admin
const bulkCreatePincodes = asyncHandler(async (req, res) => {
    const pincodes = req.body;
    if (!Array.isArray(pincodes)) {
        res.status(400);
        throw new Error('Please provide an array of pincodes');
    }

    const result = await Pincode.insertMany(pincodes, { ordered: false });
    res.status(201).json({
        message: `Successfully imported ${result.length} pincodes`,
        count: result.length
    });
});

module.exports = {
    getPincodes,
    validateBranchPincode,
    getDistinctLocations,
    globalSearchPincode,
    bulkUpdateServiceability,
    bulkMapLocation,
    checkPincode,
    createPincode,
    claimPincode,
    bulkClaimPincodes,
    releasePincode,
    updatePincode,
    deletePincode,
    bulkCreatePincodes
};
