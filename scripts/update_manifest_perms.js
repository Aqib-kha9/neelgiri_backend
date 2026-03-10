const mongoose = require('mongoose');
const Role = require('../models/Role');
const Permission = require('../models/Permission');
const dotenv = require('dotenv');

dotenv.config();

const updatePermissions = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');

        // Define Manifest Permissions
        const manifestPermissionsDef = [
            { resource: 'manifest_inward', action: 'manage', description: 'Manage Inward Manifests' },
            { resource: 'manifest_create', action: 'manage', description: 'Create Forward Manifests' },
            { resource: 'manifest_bag', action: 'manage', description: 'Manage Bag Tags' },
            { resource: 'manifest_dispatch', action: 'manage', description: 'Manage Dispatch' },
            { resource: 'manifest_history', action: 'read', description: 'View Manifest History' }
        ];

        // 1. Ensure Permissions Exist and Get IDs
        const permissionIds = [];
        for (const p of manifestPermissionsDef) {
            const perm = await Permission.findOneAndUpdate(
                { resource: p.resource, action: p.action },
                { $set: { description: p.description } },
                { upsert: true, new: true }
            );
            permissionIds.push(perm._id);
            console.log(`Permission ensured: ${p.resource}:${p.action} -> ${perm._id}`);
        }

        const rolesToUpdate = ['partner_admin', 'partner', 'branch_admin', 'branch', 'dispatcher', 'branch_manager'];

        // 2. Update Roles
        for (const roleName of rolesToUpdate) {
            const role = await Role.findOne({ name: roleName });
            if (role) {
                // Get existing IDs as strings
                const existingIds = new Set((role.permissions || []).map(id => id.toString()));
                let added = 0;

                for (const newId of permissionIds) {
                    if (!existingIds.has(newId.toString())) {
                        role.permissions.push(newId);
                        added++;
                    }
                }

                if (added > 0) {
                    await role.save();
                    console.log(`Updated ${roleName}: Added ${added} permissions.`);
                } else {
                    console.log(`${roleName}: No new permissions needed.`);
                }
            } else {
                console.log(`Role ${roleName} not found (skipping).`);
            }
        }

        console.log('Done!');
        process.exit();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
};

updatePermissions();
