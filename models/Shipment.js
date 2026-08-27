const mongoose = require('mongoose');

const shipmentSchema = new mongoose.Schema({
    awb: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    sender: {
        name: String,
        phone: String,
        address: String,
        pincode: String,
        city: String,
        state: String,
        email: String,
        gstin: String
    },
    receiver: {
        name: String,
        phone: String,
        address: String,
        pincode: String,
        city: String,
        state: String,
        email: String,
        gstin: String
    },
    eWayBill: String,
    weight: {
        type: Number, // in kg
        default: 0
    },
    dimensions: {
        length: Number,
        width: Number,
        height: Number
    },
    contents: String,
    packageType: { type: String, enum: ['BOX', 'DOCUMENT', 'PALLET'], default: 'BOX' },
    category: { type: String, default: 'General', trim: true },
    isFragile: { type: Boolean, default: false },
    insuranceRequired: { type: Boolean, default: false },
    fovPercentage: { type: Number, default: null, min: 0, max: 100 },
    declaredValue: { type: Number, default: 0, min: 0 },
    paymentMode: {
        type: String,
        enum: ['prepaid', 'cod', 'topay', 'TOPAY', 'credit', 'CREDIT'],
        default: 'prepaid'
    },
    codAmount: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: [
            'not_scheduled',  // Available for DRS assignment
            'scheduled',      // Assigned to DRS
            'in_progress',    // Rider actively delivering
            'paused',         // DRS paused
            'complete',       // Successfully delivered/completed
            'in_transit',     // Moving between branches
            'forwarded',      // Sent from source
            'received',       // Received at destination
            'pending_for_branch_approval', // Rider marked delivered, waiting for branch
            'out_for_delivery',  // Out for last-mile delivery
            'delivery_failed',  // Delivery attempt failed
            'rto_initiated',    // Return to origin started
            'rto_in_transit',   // RTO in transit back to origin
            'rto_received',     // RTO received at origin
            'rto_completed',    // RTO process complete
            'cancelled'         // Cancelled
        ],
        default: 'not_scheduled'
    },
    originType: {
        type: String,
        enum: ['manual_forward', 'drs_pickup', 'counter_inward', 'customer_portal', 'pickup_request'],
        default: 'counter_inward'
    },
    originBranchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch'
    },
    completedVia: {
        type: String,
        enum: ['manual', 'rider', 'branch_direct', null],
        default: null,
    },
    currentBranch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch'
    },
    destinationBranch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch'
    },
    history: [{
        status: String,
        branchId: { type: mongoose.Schema.Types.Mixed },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        timestamp: { type: Date, default: Date.now },
        remark: String
    }],
    // =====================================================
    // ENHANCED: Multi-leg journey tracking (Phase 2.1)
    // =====================================================
    journey: [{
        leg: { type: Number, default: 1 },
        type: { type: String, enum: ['pickup', 'origin_inward', 'bagging', 'manifest', 'line_haul', 'transit_hub', 'destination_inbound', 'drs_assignment', 'last_mile', 'delivery', 'rto', 'exception'] },
        fromBranch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
        toBranch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
        manifestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Manifest' },
        bagId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bag' },
        tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' },
        drsId: { type: mongoose.Schema.Types.ObjectId, ref: 'DRS' },
        timestamp: { type: Date, default: Date.now },
        remark: String
    }],
    // =====================================================
    // ENHANCED: Delivery attempt tracking (Phase 3.1)
    // =====================================================
    deliveryAttempts: {
        type: Number,
        default: 0
    },
    maxDeliveryAttempts: {
        type: Number,
        default: 3
    },
    deliveryAttemptHistory: [{
        attemptNumber: Number,
        date: { type: Date, default: Date.now },
        drsId: { type: mongoose.Schema.Types.ObjectId, ref: 'DRS' },
        riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        riderName: String,
        outcome: { type: String, enum: ['delivered', 'failed', 'rescheduled', 'customer_unavailable', 'wrong_address', 'refused', 'other'] },
        failureReason: String,
        remark: String,
        nextAttemptDate: Date
    }],
    // =====================================================
    // ENHANCED: RTO (Return to Origin) tracking (Phase 3.2)
    // =====================================================
    rtoStatus: {
        type: String,
        enum: ['none', 'initiated', 'in_transit', 'received_at_origin', 'completed', 'cancelled'],
        default: 'none'
    },
    rtoReason: String,
    rtoInitiatedAt: { type: Date },
    rtoInitiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rtoManifestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Manifest' },
    rtoReceivedAt: { type: Date },
    rtoCompletedAt: { type: Date },
    rtoCharges: { type: Number, default: 0 },
    // =====================================================
    // ENHANCED: SLA / TAT tracking (Phase 4.2)
    // =====================================================
    slaHours: { type: Number, default: null },
    slaDeadline: { type: Date, default: null },
    slaBreached: { type: Boolean, default: false },
    slaBreachedAt: { type: Date, default: null },
    // =====================================================
    // ENHANCED: Pickup request linkage (Phase 1.1)
    // =====================================================
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
    pickupRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'PickupRequest', index: true },
    // =====================================================
    // ENHANCED: Auto-routing info (Phase 1.2)
    // =====================================================
    routingInfo: {
        originPincode: String,
        destinationPincode: String,
        isLocal: { type: Boolean, default: false },
        isODA: { type: Boolean, default: false },
        estimatedTransitDays: { type: Number, default: 0 },
        routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route' },
        autoRouted: { type: Boolean, default: false }
    },
    chargeableWeight: {
        type: Number,
        default: 0
    },
    baseFreight: {
        type: Number,
        default: 0
    },
    fuelSurcharge: {
        type: Number,
        default: 0
    },
    fovCharge: {
        type: Number,
        default: 0
    },
    odaCharge: {
        type: Number,
        default: 0
    },
    codCharge: {
        type: Number,
        default: 0
    },
    senderInvoiceNo: String,
    additionalDocNos: [String],
    attachments: [{
        url: { type: String, required: true, trim: true },
        type: { type: String, enum: ['parcel_photo', 'document_scan', 'invoice_scan'], required: true },
        originalname: { type: String, trim: true },
        mimetype: { type: String, trim: true },
        size: { type: Number, min: 0 },
        uploadedAt: { type: Date, default: Date.now }
    }],
    termsAccepted: { type: Boolean, default: false },
    termsVersion: { type: String, trim: true },
    termsAcceptedAt: { type: Date },
    bookingIdempotencyKey: { type: String, trim: true },
    taxAmount: {
        type: Number,
        default: 0
    },
    totalAmount: {
        type: Number,
        default: 0
    },
    deliveredAt: {
        type: Date
    },
    // Multi-tenant scoping
    partnerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Partner'
    },
    branchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch'
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, { timestamps: true });

// Indexes
shipmentSchema.index({ currentBranch: 1, status: 1 });
shipmentSchema.index({ 'receiver.pincode': 1 });
shipmentSchema.index({ rtoStatus: 1 });
shipmentSchema.index({ slaBreached: 1 });
shipmentSchema.index({ pickupRequestId: 1 }, { sparse: true });
shipmentSchema.index({ partnerId: 1, branchId: 1 });
shipmentSchema.index(
    { createdBy: 1, bookingIdempotencyKey: 1 },
    {
        unique: true,
        partialFilterExpression: {
            bookingIdempotencyKey: { $type: 'string' }
        }
    }
);

module.exports = mongoose.model('Shipment', shipmentSchema);
