const express = require('express');
const router = express.Router();
const {
    getConfigs,
    getConfigByKey,
    createConfig,
    updateConfig,
    deleteConfig,
    bulkUpdateConfigs
} = require('../controllers/masterController');
const { protect } = require('../middleware/authMiddleware');

router.route('/bulk').put(protect, bulkUpdateConfigs);
router.route('/key/:key').get(protect, getConfigByKey);
router.route('/')
    .get(protect, getConfigs)
    .post(protect, createConfig);

router.route('/:id')
    .put(protect, updateConfig)
    .delete(protect, deleteConfig);

module.exports = router;
