const express = require('express');
const router = express.Router();
const {
    getPincodes,
    getDistinctLocations,
    globalSearchPincode,
    bulkUpdateServiceability,
    checkPincode,
    createPincode,
    claimPincode,
    bulkClaimPincodes,
    releasePincode,
    updatePincode,
    deletePincode,
    bulkCreatePincodes
} = require('../controllers/pincodeController');
const { protect } = require('../middleware/authMiddleware');

// Special routes FIRST (before /:id to avoid conflicts)
router.get('/locations/distinct', protect, getDistinctLocations);
router.get('/global-search', protect, globalSearchPincode);
router.post('/bulk-update', protect, bulkUpdateServiceability);
router.post('/bulk-claim', protect, bulkClaimPincodes);
router.post('/bulk', protect, bulkCreatePincodes);

// Public pincode serviceability check
router.get('/check/:pincode', checkPincode);

// CRUD
router.route('/')
    .get(protect, getPincodes)
    .post(protect, createPincode);

router.route('/:id')
    .put(protect, updatePincode)
    .delete(protect, deletePincode);

// Branch claim endpoint
router.post('/:id/claim', protect, claimPincode);
// Branch release endpoint
router.post('/:id/release', protect, releasePincode);

module.exports = router;
