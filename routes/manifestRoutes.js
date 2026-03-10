const express = require('express');
const router = express.Router();
const { createManifest, getManifests, updateManifestStatus } = require('../controllers/manifestController');
const { protect } = require('../middleware/authMiddleware');

router.post('/create', protect, createManifest);
router.get('/', protect, getManifests);
router.put('/:id/status', protect, updateManifestStatus);

module.exports = router;
