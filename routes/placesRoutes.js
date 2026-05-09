const express = require('express');
const router = express.Router();
const placesController = require('../controllers/placesController');

router.get('/search', placesController.searchPlaces);
router.get('/details', placesController.getPlaceDetails);

module.exports = router;
