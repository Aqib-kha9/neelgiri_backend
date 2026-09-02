const mongoose = require('mongoose');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');
const connectDB = require('./config/db');

// Models
const User = require('./models/User');
const Customer = require('./models/Customer');
const Role = require('./models/Role');
const Permission = require('./models/Permission');

dotenv.config();
connectDB();

const resources = [
    // Dashboards
    'dashboard_main', 'dashboard_ops', 'dashboard_partner', 'dashboard_finance', 'dashboard_gst',

    // Booking & Orders
    'order_create', 'order_all', 'order_pending', 'order_transit', 'order_ofd', 'order_delivered', 'order_exception', 'order_quick',

    // AWB
    'awb_series', 'awb_allocation', 'awb_usage',

    // Tracking & POD
    'tracking_live', 'pod_capture', 'pod_verify', 'pod_missing', 'pod_digital',

    // DRS
    'drs_create', 'drs_active', 'drs_history', 'drs_cust_portal',

    // Manifest
    'manifest_counter', 'manifest_inward', 'manifest_bulk', 'manifest_weight',
    'manifest_create', 'manifest_bag', 'manifest_dispatch', 'manifest_history',

    // Branch Mgmt
    'branch_all', 'branch_add', 'branch_perf', 'branch_service',

    // Warehouse
    'wh_inventory', 'wh_stock', 'wh_assets',

    // Partner Mgmt
    'partner_all', 'partner_onboard', 'partner_score', 'partner_settle',

    // Vendor Mgmt
    'vendor_coload', 'vendor_service', 'vendor_metrics',

    // Customer Mgmt
    'cust_directory', 'cust_onboard', 'cust_agreement', 'cust_ticket', 'cust_pickup',

    // Finance & GST
    'fin_invoice_gen', 'fin_invoice_hist', 'fin_notes',
    'fin_gst_report', 'fin_eway', 'fin_tax',
    'fin_pay_coll', 'fin_cod', 'fin_settle', 'fin_tally',

    // Operations
    'op_rider_alloc', 'op_rider_perf', 'op_rider_shift',
    'op_ex_pending', 'op_ex_flow', 'op_ex_rca', 'op_ex_qc',
    'op_trips', 'op_hub', 'op_rto', 'op_sla',

    // Reports
    'rep_del_perf', 'rep_part_perf', 'rep_branch_perf', 'rep_rider_perf',
    'rep_rev', 'rep_gst', 'rep_settle', 'rep_bi',

    // Master Data
    'master_cust', 'master_loc', 'master_veh', 'master_driver', 'master_route', 'master_pin', 'master_rate', 'master_prod', 'master_config',

    // System Admin
    'sys_users', 'sys_roles', 'sys_perms', 'sys_audit', 'sys_settings', 'sys_int'
];

const actions = ['create', 'read', 'update', 'delete'];

const importData = async () => {
    try {
        // 1. Clear Database
        await User.deleteMany();
        await Role.deleteMany();
        await Permission.deleteMany();

        console.log('🗑️  Database cleared');

        // 2. Create Permissions
        const permissions = [];

        // Generate standard CRUD permissions for all resources
        for (const resource of resources) {
            for (const action of actions) {
                permissions.push({
                    resource,
                    action,
                    description: `Can ${action} ${resource}`
                });
            }
        }

        const createdPermissions = await Permission.insertMany(permissions);
        console.log(`✅ Created ${createdPermissions.length} permissions`);

        // Helper to get permission IDs
        const getPerms = (res, acts) => {
            return createdPermissions
                .filter(p => p.resource === res && (acts.includes(p.action) || acts.includes('*')))
                .map(p => p._id);
        };

        // Helper to get ALL permissions for a resource
        const getFullPerms = (res) => getPerms(res, ['create', 'read', 'update', 'delete']);
        // Helper to get Read/Update perms
        const getReadUpdate = (res) => getPerms(res, ['read', 'update']);
        // Helper to get Read Only perms
        const getRead = (res) => getPerms(res, ['read']);

        // 3. Create Roles

        // Super Admin: All Permissions
        const superAdminPerms = createdPermissions.map(p => p._id);

        // Delivery Partner: Based on screenshot - PARTNER ADMIN sidebar
        const partnerPerms = [
            ...getRead('dashboard_main'),
            // Booking & Orders
            ...getFullPerms('order_create'),
            ...getReadUpdate('order_all'),
            ...getReadUpdate('order_pending'),
            ...getRead('order_transit'),
            ...getRead('order_delivered'),
            ...getRead('order_exception'),
            // Tracking & POD
            ...getRead('tracking_live'),
            ...getFullPerms('pod_capture'),
            ...getReadUpdate('pod_verify'),
            // Branch Management
            ...getReadUpdate('branch_all'),
            ...getFullPerms('branch_add'),
            ...getRead('branch_perf'),
            // Financial & GST
            ...getFullPerms('fin_invoice_gen'),
            ...getRead('fin_invoice_hist'),
            ...getRead('fin_gst_report'),
            ...getRead('fin_settle'),
            // Reports
            ...getRead('rep_del_perf'),
            ...getRead('rep_branch_perf'),
            ...getRead('rep_rev'),
            // Manifest Management
            ...getFullPerms('op_trips'),
            ...getFullPerms('manifest_counter'),
            ...getFullPerms('manifest_inward'),
            ...getFullPerms('manifest_create'),
            ...getFullPerms('manifest_bag'),
            ...getFullPerms('manifest_dispatch'),
            ...getFullPerms('manifest_history')
        ];

        // Branch Admin: Based on screenshot - BRANCH ADMIN sidebar
        const branchPerms = [
            ...getRead('dashboard_main'),
            // Booking & Orders
            ...getFullPerms('order_create'),
            ...getReadUpdate('order_all'),
            ...getReadUpdate('order_pending'),
            ...getRead('order_transit'),
            ...getReadUpdate('order_ofd'),
            ...getRead('order_delivered'),
            // Delivery Run Sheet
            ...getFullPerms('drs_create'),
            ...getReadUpdate('drs_active'),
            ...getRead('drs_history'),
            // Tracking & POD
            ...getRead('tracking_live'),
            ...getFullPerms('pod_capture'),
            // Rider Management
            ...getReadUpdate('op_rider_alloc'),
            ...getRead('op_rider_perf'),
            // Reports
            ...getRead('rep_del_perf'),
            ...getRead('rep_rider_perf'),
            // Manifest Management
            ...getFullPerms('op_trips'),
            ...getFullPerms('manifest_counter'),
            ...getFullPerms('manifest_inward'),
            ...getFullPerms('manifest_create'),
            ...getFullPerms('manifest_bag'),
            ...getFullPerms('manifest_dispatch'),
            ...getFullPerms('manifest_history')
        ];

        // Dispatcher: Based on screenshot - DISPATCHER sidebar
        const dispatcherPerms = [
            ...getRead('dashboard_main'),
            // Order Management
            ...getReadUpdate('order_all'),
            ...getReadUpdate('order_pending'),
            ...getRead('order_transit'),
            ...getReadUpdate('order_ofd'),
            // DRS
            ...getFullPerms('drs_create'),
            ...getReadUpdate('drs_active'),
            // Rider Management
            ...getReadUpdate('op_rider_alloc'),
            // Tracking
            ...getRead('tracking_live'),
            // Manifest Management
            ...getFullPerms('op_trips'),
            ...getFullPerms('manifest_counter'),
            ...getFullPerms('manifest_inward'),
            ...getFullPerms('manifest_create'),
            ...getFullPerms('manifest_bag'),
            ...getFullPerms('manifest_dispatch'),
            ...getFullPerms('manifest_history')
        ];

        // Rider: Based on screenshot - RIDER sidebar
        const riderPerms = [
            // My Tasks (OFD orders)
            ...getReadUpdate('order_ofd'),
            // Create DRS
            ...getFullPerms('drs_create'),
            // POD Capture
            ...getFullPerms('pod_capture'),
            // My Performance
            ...getRead('op_rider_perf')
        ];

        // Customer: Based on screenshot - CUSTOMER PORTAL sidebar
        const customerPerms = [
            ...getRead('dashboard_main'),
            // Create Order
            ...getFullPerms('order_create'),
            // My Orders
            ...getRead('order_all'),
            // Track Order
            ...getRead('tracking_live'),
            // Pickup Requests
            ...getFullPerms('cust_pickup'),
            // Invoices
            ...getRead('fin_invoice_hist')
        ];


        const roles = [
            {
                name: 'super_admin',
                displayName: 'Super Admin',
                permissions: superAdminPerms,
                isSystem: true,
                description: 'Full system access'
            },
            {
                name: 'partner_admin',
                displayName: 'Delivery Partner',
                permissions: partnerPerms,
                isSystem: false,
                description: 'Manages logistics operations'
            },
            {
                name: 'branch_admin',
                displayName: 'Branch Manager',
                permissions: branchPerms,
                isSystem: false,
                description: 'Manages specific branch'
            },
            {
                name: 'dispatcher',
                displayName: 'Dispatcher',
                permissions: dispatcherPerms,
                isSystem: false,
                description: 'Dispatches shipments to riders'
            },
            {
                name: 'rider',
                displayName: 'Rider',
                permissions: riderPerms,
                isSystem: false,
                description: 'Delivers shipments'
            },
            {
                name: 'customer',
                displayName: 'Customer',
                permissions: customerPerms,
                isSystem: false,
                description: 'End user tracking shipments'
            }
        ];

        const createdRoles = await Role.insertMany(roles);
        console.log(`✅ Created ${createdRoles.length} roles`);

        // Helper to find Role ID
        const getRoleId = (name) => createdRoles.find(r => r.name === name)._id;

        // 4. Create Users
        const users = [
            {
                name: 'Super Admin',
                email: 'superadmin@logistics.com',
                password: 'password123',
                role: getRoleId('super_admin'),
                status: 'active'
            },
            {
                name: 'Delivery Partner',
                email: 'partner@delivery.com',
                password: 'password123',
                role: getRoleId('partner_admin'),
                status: 'active'
            },
            {
                name: 'Branch Manager',
                email: 'branch@delivery.com',
                password: 'password123',
                role: getRoleId('branch_admin'),
                branchId: 'BR-001',
                status: 'active'
            },
            {
                name: 'Dispatcher User',
                email: 'dispatcher@delivery.com',
                password: 'password123',
                role: getRoleId('dispatcher'),
                branchId: 'BR-001',
                status: 'active'
            },
            {
                name: 'Rider User',
                email: 'rider@delivery.com',
                password: 'password123',
                role: getRoleId('rider'),
                branchId: 'BR-001',
                status: 'active'
            },
            {
                name: 'Customer User',
                email: 'customer@example.com',
                password: 'password123',
                role: getRoleId('customer'),
                status: 'active'
            }
        ];

        // Hash passwords manually here since we are using insertMany which bypasses 'save' middleware usually, 
        // BUT our previous seed.js used map + bcrypt.hashSync. Let's do that.
        const hashedUsers = users.map(user => {
            return {
                ...user,
                password: bcrypt.hashSync(user.password, 10)
            };
        });

        const createdUsers = await User.insertMany(hashedUsers);
        console.log(`✅ Created ${createdUsers.length} users`);

        const demoCustomerUser = createdUsers.find((user) => user.email === 'customer@example.com');
        if (demoCustomerUser) {
            await Customer.findOneAndUpdate(
                { portalEmail: demoCustomerUser.email },
                {
                    $set: {
                        code: 'CUST-DEMO-001',
                        name: demoCustomerUser.name,
                        email: demoCustomerUser.email,
                        portalEmail: demoCustomerUser.email,
                        portalAccess: true,
                        status: 'active',
                        userId: demoCustomerUser._id,
                        mobileNo: '',
                        address1: '',
                        city: '',
                        pincode: ''
                    }
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            console.log('✅ Linked demo customer User to an active Customer profile');
        }

        console.log('🚀 SEEDING COMPLETE');
        process.exit();
    } catch (error) {
        console.error(`❌ Error parsing data: ${error}`);
        process.exit(1);
    }
};

importData();
