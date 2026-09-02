/**
 * autoRouter.js
 *
 * Auto-routing engine — determines the correct destination branch and route
 * for a shipment based on origin and destination pincodes.
 *
 * Logic:
 *   1. Look up origin pincode → find serving branch (origin branch)
 *   2. Look up destination pincode → find serving branch (destination branch)
 *   3. If origin branch === destination branch → LOCAL (direct to DRS)
 *   4. If different → NON-LOCAL (needs manifest + line-haul)
 *   5. Find best Route connecting origin branch to destination branch
 *   6. Calculate estimated transit days from route
 */

const Pincode = require('../models/Pincode');
const Branch = require('../models/Branch');
const Route = require('../models/Route');
const Location = require('../models/Location');

/**
 * Find the branch that serves a given pincode.
 * Checks both global serviceability and branch-level activation.
 */
const findBranchForPincode = async (pincode) => {
    if (!pincode || !String(pincode).trim()) {
        return { found: false, reason: 'Pincode is required' };
    }

    const normalizedPincode = String(pincode).trim();
    const pincodeDocs = await Pincode.find({
        pincode: normalizedPincode,
        isServiceable: true,
        isActiveForBranch: true,
        branchId: { $ne: null }
    }).sort({ updatedAt: -1, _id: 1 });

    if (pincodeDocs.length === 0) {
        const existingPincode = await Pincode.findOne({ pincode: normalizedPincode })
            .sort({ updatedAt: -1, _id: 1 });
        if (!existingPincode) {
            return { found: false, reason: 'Pincode not found in database' };
        }
        return {
            found: false,
            reason: existingPincode.isServiceable
                ? 'Pincode is serviceable but no branch is assigned'
                : 'Pincode is not serviceable (global)',
            pincodeDoc: existingPincode
        };
    }

    for (const pincodeDoc of pincodeDocs) {
        const branch = await Branch.findOne({
            _id: pincodeDoc.branchId,
            isActive: true
        }).select('name code address contact isActive');
        if (branch) {
            let location = null;
            if (pincodeDoc.locationId) {
                location = await Location.findById(pincodeDoc.locationId).select('name code type status');
            }
            if (!location) {
                location = await Location.findOne({ branchId: branch._id, status: 'ACTIVE' }).select('name code type status');
            }
            if (!location) {
                location = await Location.findOne({ 'address.pincode': normalizedPincode, status: 'ACTIVE' }).select('name code type status');
            }

            return {
                found: true,
                branch,
                location,
                pincodeDoc,
                isODA: pincodeDoc.isODA || false,
                transitDays: pincodeDoc.transitDays || 0
            };
        }
    }

    return {
        found: false,
        reason: 'Assigned branch is inactive or not found',
        pincodeDoc: pincodeDocs[0]
    };
};

/**
 * Find the best route connecting origin branch to destination branch.
 * Looks for routes where sourceHub/destinationHub match the branch locations.
 */
const findRouteForBranches = async (originBranchId, destinationBranchId, originLocationId, destinationLocationId) => {
    let route = null;
    
    // Primary method: Try to find a direct route using Location IDs if available
    if (originLocationId && destinationLocationId) {
        route = await Route.findOne({
            sourceHub: originLocationId,
            destinationHub: destinationLocationId,
            status: 'ACTIVE',
            isDeleted: { $ne: true }
        }).sort({ totalDistanceKm: 1 });
        
        if (route) {
            return { found: true, route, isDirect: true };
        }
    }

    // Fallback: Try to find a direct route using Branch IDs (legacy support)
    route = await Route.findOne({
        $or: [
            { sourceHub: originBranchId, destinationHub: destinationBranchId },
            { 'sourceBranch': originBranchId, 'destinationBranch': destinationBranchId }
        ],
        status: 'ACTIVE',
        isDeleted: { $ne: true }
    }).sort({ totalDistanceKm: 1 });

    if (route) {
        return { found: true, route, isDirect: true };
    }

    // Try to find a route via the branch locations
    const [originBranch, destBranch] = await Promise.all([
        Branch.findById(originBranchId).select('name code'),
        Branch.findById(destinationBranchId).select('name code')
    ]);

    if (originBranch && destBranch) {
        route = await Route.findOne({
            $or: [
                { sourceCity: { $regex: originBranch.name, $options: 'i' }, destinationCity: { $regex: destBranch.name, $options: 'i' } },
                { name: { $regex: `${originBranch.name}.*${destBranch.name}`, $options: 'i' } }
            ],
            status: 'ACTIVE',
            isDeleted: { $ne: true }
        }).sort({ totalDistanceKm: 1 });

        if (route) {
            return { found: true, route, isDirect: false };
        }
    }

    return { found: false, reason: 'No active route found connecting the branches' };
};

/**
 * Main auto-routing function.
 * Given origin and destination pincodes, returns the full routing plan.
 */
const autoRoute = async (originPincode, destinationPincode) => {
    const [originResult, destResult] = await Promise.all([
        findBranchForPincode(originPincode),
        findBranchForPincode(destinationPincode)
    ]);

    const result = {
        originPincode,
        destinationPincode,
        originBranch: null,
        originLocation: null,
        destinationBranch: null,
        destinationLocation: null,
        isLocal: false,
        route: null,
        isODA: false,
        estimatedTransitDays: 0,
        serviceable: false,
        errors: []
    };

    if (!originResult.found) {
        result.errors.push(`Origin: ${originResult.reason}`);
    } else {
        result.originBranch = originResult.branch;
        result.originLocation = originResult.location;
    }

    if (!destResult.found) {
        result.errors.push(`Destination: ${destResult.reason}`);
    } else {
        result.destinationBranch = destResult.branch;
        result.destinationLocation = destResult.location;
        result.isODA = destResult.isODA;
        result.estimatedTransitDays = destResult.transitDays;
    }

    if (!originResult.found || !destResult.found) {
        return result;
    }

    // Check if local (same branch serves both pincodes)
    if (originResult.branch._id.toString() === destResult.branch._id.toString()) {
        result.isLocal = true;
        result.serviceable = true;
        result.estimatedTransitDays = Math.max(result.estimatedTransitDays, 1);
        return result;
    }

    // Non-local — find route
    const routeResult = await findRouteForBranches(
        originResult.branch._id, 
        destResult.branch._id,
        originResult.location ? originResult.location._id : null,
        destResult.location ? destResult.location._id : null
    );
    if (routeResult.found) {
        result.route = routeResult.route;
        result.isDirect = routeResult.isDirect;
        // Use route transit time if available, otherwise use pincode transit days
        const routeTransitHours = routeResult.route.totalTransitTimeHours || 0;
        const routeTransitDays = Math.ceil(routeTransitHours / 24);
        result.estimatedTransitDays = Math.max(result.estimatedTransitDays, routeTransitDays, 1);
        result.serviceable = true;
    } else {
        result.errors.push(routeResult.reason);
    }

    return result;
};

module.exports = {
    autoRoute,
    findBranchForPincode,
    findRouteForBranches
};
