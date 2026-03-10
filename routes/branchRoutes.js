const express = require('express');
const router = express.Router();
const {
    createBranch,
    getBranches,
    updateBranch,
    getBranchHierarchy
} = require('../controllers/branchController');
const { protect } = require('../middleware/authMiddleware');

router.route('/')
    .post(protect, createBranch)
    .get(protect, getBranches);

router.route('/:id')
    .put(protect, updateBranch);

router.route('/:id/hierarchy')
    .get(protect, getBranchHierarchy);

module.exports = router;
