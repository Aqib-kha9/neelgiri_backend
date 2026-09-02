const mongoose = require('mongoose');
const dotenv = require('dotenv');
const connectDB = require('../config/db');
const Role = require('../models/Role');
const Permission = require('../models/Permission');

dotenv.config();

const patchRbac = async () => {
    try {
        await connectDB();
        console.log('📦 Connected to DB for patching...');

        const missingResources = ['op_trips', 'op_hub', 'op_rto', 'op_sla'];
        const actions = ['create', 'read', 'update', 'delete'];
        const newPermissions = [];

        for (const resource of missingResources) {
            for (const action of actions) {
                // Check if it already exists
                const existing = await Permission.findOne({ resource, action });
                if (!existing) {
                    newPermissions.push({
                        resource,
                        action,
                        description: `Can ${action} ${resource}`
                    });
                }
            }
        }

        let insertedIds = [];
        if (newPermissions.length > 0) {
            const created = await Permission.insertMany(newPermissions);
            insertedIds = created.map(p => p._id);
            console.log(`✅ Created ${created.length} new permissions for missing operations`);
        } else {
            // If they already existed, fetch their IDs just in case
            const existingPerms = await Permission.find({ resource: { $in: missingResources } });
            insertedIds = existingPerms.map(p => p._id);
            console.log(`ℹ️ Permissions already exist in DB. Proceeding to assign to roles...`);
        }

        if (insertedIds.length === 0) {
            console.log('No permissions found/created. Exiting.');
            process.exit(0);
        }

        // Helper to find specific IDs based on resource (for non super_admin roles)
        const getTripsPerms = async () => {
            const perms = await Permission.find({ resource: 'op_trips' });
            return perms.map(p => p._id);
        };

        const tripsIds = await getTripsPerms();

        // 1. Assign ALL to super_admin
        const superAdmin = await Role.findOne({ name: 'super_admin' });
        if (superAdmin) {
            const existingSet = new Set(superAdmin.permissions.map(id => id.toString()));
            let added = 0;
            insertedIds.forEach(id => {
                if (!existingSet.has(id.toString())) {
                    superAdmin.permissions.push(id);
                    added++;
                }
            });
            if (added > 0) {
                await superAdmin.save();
                console.log(`🛡️ Assigned ${added} new permissions to super_admin`);
            }
        }

        // 2. Assign op_trips to partner_admin, partner, branch_admin, branch, dispatcher
        const targetRoles = ['partner_admin', 'partner', 'branch_admin', 'branch', 'dispatcher'];
        for (const roleName of targetRoles) {
            const role = await Role.findOne({ name: roleName });
            if (role) {
                const existingSet = new Set(role.permissions.map(id => id.toString()));
                let added = 0;
                tripsIds.forEach(id => {
                    if (!existingSet.has(id.toString())) {
                        role.permissions.push(id);
                        added++;
                    }
                });
                if (added > 0) {
                    await role.save();
                    console.log(`🛡️ Assigned ${added} op_trips permissions to ${roleName}`);
                }
            }
        }

        console.log('✅ RBAC Patch completed successfully!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error patching RBAC:', err);
        process.exit(1);
    }
};

patchRbac();
