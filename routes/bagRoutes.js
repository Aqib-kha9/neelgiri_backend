const express = require('express');
const router = express.Router();
const bagController = require('../controllers/bagController');
const { protect } = require('../middleware/authMiddleware');

router.post('/create', protect, bagController.createBag);
router.get('/', protect, bagController.getBags);

module.exports = router;
