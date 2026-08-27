/**
 * scopeHelper.js
 * Centralized role-based data scoping utilities.
 *
 * LogiFlow uses a strict hierarchy:
 *   super_admin  -> sees everything
 *   partner_admin / partner -> scoped to their partnerId (and branches they own)
 *   branch_admin / branch   -> scoped to their branchId
 *   dispatcher / rider      -> scoped to their branchId
 *   customer                 -> scoped to their own userId / customerId
 *
 * Every new controller reuses these helpers so data isolation is consistent
 * across the entire platform (production-grade multi-tenant isolation).
 */

const User = require('../models/User');
const Branch = require('../models/Branch');

const getRoleName = (user) => user?.role?.name || user?.role || null;

/**
 * Returns the effective partner ObjectId for the authenticated user.
 * - super_admin: null (global)
 * - partner_admin/partner: their own _id
 * - everyone else: parentPartner || createdBy
 */
const getEffectivePartnerId = (user) => {
    const roleName = getRoleName(user);
    if (!roleName) return null;
    if (roleName === 'super_admin') return null;
    if (roleName === 'partner_admin' || roleName === 'partner') return user._id;
    return user.parentPartner || user.createdBy || null;
};

/**
 * Returns the effective branch id for the authenticated user.
 * - branch-scoped roles: their branchId
 * - partner/super: null (multi-branch)
 */
const getEffectiveBranchId = (user) => {
    const roleName = getRoleName(user);
    if (!roleName) return null;
    if (['branch_admin', 'branch', 'dispatcher', 'rider'].includes(roleName)) {
        return user.branchId || null;
    }
    return null;
};

/**
 * Build a mongoose query filter object for partner/branch scoped resources.
 *
 * @param {Object} user - req.user (populated with role)
 * @param {Object} opts
 * @param {String} opts.partnerField - field name storing partnerId (default 'partnerId')
 * @param {String} opts.branchField  - field name storing branchId (default 'branchId')
 * @param {Boolean} opts.allowGlobalForSuper - if true, super_admin gets {} (all). default true
 * @returns {Object|null} mongoose query. Returns null when user has no scope (=> empty result)
 */
const buildScopeQuery = (user, opts = {}) => {
    const {
        partnerField = 'partnerId',
        branchField = 'branchId',
        allowGlobalForSuper = true
    } = opts;

    const roleName = getRoleName(user);
    if (!roleName) return null;

    if (roleName === 'super_admin') {
        return allowGlobalForSuper ? {} : null;
    }

    if (roleName === 'partner_admin' || roleName === 'partner') {
        return { [partnerField]: user._id };
    }

    // Custom partner staff (no branch)
    if (user.parentPartner && !user.branchId) {
        return { [partnerField]: user.parentPartner };
    }

    if (['branch_admin', 'branch', 'dispatcher', 'rider'].includes(roleName)) {
        if (!user.branchId) return null;
        return { [branchField]: user.branchId };
    }

    if (roleName === 'customer') {
        return { [opts.customerField || 'userId']: user._id };
    }

    return null;
};

/**
 * Returns an array of branch ObjectIds owned by a partner.
 * Useful for partner-scoped queries that filter by branch.
 */
const getPartnerBranchIds = async (partnerId) => {
    if (!partnerId) return [];
    const branches = await Branch.find({ partnerId }).select('_id');
    return branches.map(b => b._id);
};

/**
 * Returns a list of rider (User) ObjectIds that belong to the caller's scope.
 * Used by DRS / operations controllers to populate rider dropdowns.
 */
const getScopedRiders = async (user) => {
    const roleName = getRoleName(user);
    if (!roleName) return [];

    let query = { isInactive: false, status: { $ne: 'inactive' } };
    if (roleName === 'super_admin') {
        // all riders
    } else if (roleName === 'partner_admin' || roleName === 'partner') {
        const branchIds = await getPartnerBranchIds(user._id);
        query.$or = [
            { parentPartner: user._id },
            { branchId: { $in: branchIds } }
        ];
    } else if (['branch_admin', 'branch', 'dispatcher'].includes(roleName)) {
        if (!user.branchId) return [];
        query.branchId = user.branchId;
    } else {
        return [];
    }

    // Only return users whose role is rider. No role document means no safe result.
    const Role = require('../models/Role');
    const riderRole = await Role.findOne({ name: 'rider' });
    if (!riderRole) return [];
    query.role = riderRole._id;

    return User.find(query).select('name email phone branchId').sort({ name: 1 });
};

module.exports = {
    getEffectivePartnerId,
    getEffectiveBranchId,
    buildScopeQuery,
    getPartnerBranchIds,
    getScopedRiders
};
