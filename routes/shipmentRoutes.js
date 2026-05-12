const express = require('express');
const router = express.Router();
const shipmentController = require('../controllers/shipmentController');
const { protect } = require('../middleware/authMiddleware');

const upload = require('../middleware/uploadMiddleware');

router.post('/inward', protect, shipmentController.inwardShipment);
router.post('/book', protect, shipmentController.createBooking);
router.post('/upload', protect, upload.array('files', 10), (req, res) => {
    const files = req.files.map(file => ({
        url: `/public/uploads/${file.filename}`,
        originalname: file.originalname,
        mimetype: file.mimetype
    }));
    res.json({ files });
});
router.post('/confirm-inward', protect, shipmentController.confirmShipmentInward);
router.post('/forward', protect, shipmentController.forwardShipment);

// Static routes first
router.get('/incoming', protect, shipmentController.getIncomingShipments);

// Specific dynamic routes
router.get('/:awb/tracking', protect, shipmentController.getShipmentTracking);
router.post('/:awb/complete', protect, shipmentController.completeShipment);

// Generic dynamic routes
router.get('/:awb', protect, shipmentController.getShipmentByAWB);
router.get('/', protect, shipmentController.getShipments);

// --- Real-time Compliance (Sandbox Integration) ---
const sandboxService = require('../services/sandboxService');

router.get('/compliance/gstin/:gstin', protect, async (req, res) => {
    try {
        const details = await sandboxService.getGstinDetails(req.params.gstin);
        res.json(details);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

router.get('/compliance/ewaybill/:number', protect, async (req, res) => {
    try {
        const details = await sandboxService.getEwayBillDetails(req.params.number);
        res.json(details);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

router.get('/compliance/ewaybill/:number/print', protect, async (req, res) => {
    try {
        const pdfData = await sandboxService.getEwayBillPdf(req.params.number);
        res.json(pdfData);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

module.exports = router;
