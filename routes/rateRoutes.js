const express = require('express');
const router = express.Router();
const {
    getRates,
    createRate,
    getRateById,
    updateRate,
    deleteRate
} = require('../controllers/rateController');
const { protect } = require('../middleware/authMiddleware');

router.route('/')
    .get(protect, getRates)
    .post(protect, createRate);

router.post('/calculate', protect, (req, res, next) => {
    // Controller will be added in rateController.js
    require('../controllers/rateController').calculateQuote(req, res, next);
});

router.route('/:id')
    .get(protect, getRateById)
    .put(protect, updateRate)
    .delete(protect, deleteRate);

module.exports = router;
