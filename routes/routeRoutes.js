const express = require('express');
const router = express.Router();
const {
    getRoutes,
    getRouteStats,
    getRouteById,
    createRoute,
    updateRoute,
    deleteRoute
} = require('../controllers/masterController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getRouteStats);
router.route('/')
    .get(protect, getRoutes)
    .post(protect, createRoute);

router.route('/:id')
    .get(protect, getRouteById)
    .put(protect, updateRoute)
    .delete(protect, deleteRoute);

module.exports = router;
