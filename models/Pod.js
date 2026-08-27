const mongoose = require('mongoose');

const podAttachmentSchema = new mongoose.Schema({
    url: { type: String, required: true },
    type: { type: String, enum: ['image', 'document', 'signature'], default: 'image' },
    uploadedAt: { type: Date, default: Date.now }
}, { _id: false });

const podSchema = new mongoose.Schema({
    podId: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },

    shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment', required: true, index: true },
    awb: { type: String, required: true, index: true },

    // Delivery outcome
    deliveryStatus: {
        type: String,
        enum: ['DELIVERED', 'UNDELIVERED', 'RTO', 'PARTIAL', 'REFUSED'],
        default: 'DELIVERED',
        index: true
    },

    // Who received the shipment
    deliveredTo: {
        name: { type: String, trim: true },
        relation: { type: String, trim: true }, // e.g. "Son", "Neighbor", "Receptionist"
        phone: { type: String, trim: true }
    },

    deliveryDate: { type: Date, default: Date.now },
    deliveryTimeSlot: { type: String, trim: true },

    // Proof artifacts
    signature: { type: String }, // base64 data URL or file path
    attachments: [podAttachmentSchema],

    // Capture metadata
    remarks: { type: String, trim: true },
    undeliveredReason: {
        type: String,
        enum: ['ADDRESS_NOT_FOUND', 'CONSIGNEE_NOT_AVAILABLE', 'CONSIGNEE_REFUSED', 'INCORRECT_ADDRESS', 'OFFICE_CLOSED', 'PAYMENT_ISSUE', 'OTHER'],
        default: null
    },

    // Geo-location at time of delivery
    location: {
        latitude: { type: Number },
        longitude: { type: Number },
        address: { type: String, trim: true }
    },

    // Capture info
    capturedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    capturedByName: { type: String },
    captureDevice: { type: String, trim: true }, // mobile/web/scanner
    capturedAt: { type: Date, default: Date.now },

    // Verification workflow
    verificationStatus: {
        type: String,
        enum: ['PENDING', 'VERIFIED', 'REJECTED'],
        default: 'PENDING',
        index: true
    },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date },
    rejectionReason: { type: String, trim: true },

    // Hierarchy / RBAC
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

// Index for efficient queries
podSchema.index({ shipmentId: 1, deliveryStatus: 1 });
podSchema.index({ awb: 1, verificationStatus: 1 });

module.exports = mongoose.model('Pod', podSchema);
