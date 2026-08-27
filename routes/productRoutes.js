const express = require('express');
const router = express.Router();
const {
    getProducts,
    getProductStats,
    getProductById,
    createProduct,
    updateProduct,
    deleteProduct
} = require('../controllers/masterController');
const { protect } = require('../middleware/authMiddleware');

router.route('/stats').get(protect, getProductStats);
router.route('/')
    .get(protect, getProducts)
    .post(protect, createProduct);

router.route('/:id')
    .get(protect, getProductById)
    .put(protect, updateProduct)
    .delete(protect, deleteProduct);

module.exports = router;
