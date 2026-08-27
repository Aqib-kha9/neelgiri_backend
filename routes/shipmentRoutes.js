const express = require('express');
const router = express.Router();
const shipmentController = require('../controllers/shipmentController');
const { protect } = require('../middleware/authMiddleware');

const upload = require('../middleware/uploadMiddleware');

router.post('/inward', protect, shipmentController.inwardShipment);
router.post('/book', protect, shipmentController.createBooking);
router.post('/upload', protect, (req, res, next) => {
    upload.array('files', 10)(req, res, (error) => {
        if (error) {
            if (error.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ message: 'Each file must be 5 MB or smaller' });
            }
            if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
                return res.status(400).json({ message: 'A maximum of 10 files can be uploaded at once' });
            }
            return res.status(400).json({ message: error.message || 'Invalid upload' });
        }
        return next();
    });
}, (req, res) => {
    const files = Array.isArray(req.files) ? req.files.map(file => ({
        url: `/public/uploads/${file.filename}`,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size
    })) : [];
    res.json({ files });
});
router.post('/confirm-inward', protect, shipmentController.confirmShipmentInward);
router.post('/forward', protect, shipmentController.forwardShipment);

// Static routes must be registered before /:awb dynamic routes.
router.get('/auto-route', protect, shipmentController.autoRouteShipment);
router.get('/incoming', protect, shipmentController.getIncomingShipments);

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

// Specific dynamic routes
router.get('/:awb/tracking', protect, shipmentController.getShipmentTracking);
router.post('/:awb/complete', protect, shipmentController.completeShipment);

// Generic dynamic routes
router.get('/:awb', protect, shipmentController.getShipmentByAWB);
router.get('/', protect, shipmentController.getShipments);

module.exports = router;
