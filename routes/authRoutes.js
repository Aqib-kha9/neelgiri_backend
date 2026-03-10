const express = require('express');
const router = express.Router();
const { loginUser, getUserProfile } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.get('/test-connection', (req, res) => {
    console.log('✅ FRONTEND CONNECTED: Received test ping!');
    res.json({ message: 'Backend is connected and listening!' });
});

router.post('/login', loginUser);
router.get('/me', protect, getUserProfile);

module.exports = router;
