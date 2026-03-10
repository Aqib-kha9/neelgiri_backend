const express = require('express');
const router = express.Router();
const {
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
} = require('../controllers/rbacController');
const { protect } = require('../middleware/authMiddleware');

router.route('/roles')
    .get(protect, getRoles)
    .post(protect, createRole);

router.route('/roles/:id')
    .put(protect, updateRole)
    .delete(protect, deleteRole);

router.route('/roles/:roleId/users')
    .get(protect, getUsersByRole);

router.route('/permissions')
    .get(protect, getPermissions);

router.route('/users')
    .get(protect, getUsers)
    .post(protect, createUser);

router.route('/users/:id')
    .put(protect, updateUser)
    .delete(protect, deleteUser);

router.route('/users/:id/role')
    .put(protect, updateUserRole);

router.patch('/users/:id/toggle-pause', protect, toggleUserPause);

module.exports = router;
