const mongoose = require('mongoose');

const invoiceLineItemSchema = new mongoose.Schema({
    shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment' },
    awb: { type: String, trim: true },
    description: { type: String, trim: true },
    origin: { type: String, trim: true },
    destination: { type: String, trim: true },
    weight: { type: Number, default: 0 },
    chargeableWeight: { type: Number, default: 0 },
    baseFreight: { type: Number, default: 0 },
    fuelSurcharge: { type: Number, default: 0 },
    fovCharge: { type: Number, default: 0 },
    odaCharge: { type: Number, default: 0 },
    codCharge: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 }
}, { _id: false });

const paymentSchema = new mongoose.Schema({
    paymentId: { type: String, trim: true },
    amount: { type: Number, required: true },
    method: { type: String, enum: ['CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI', 'CARD', 'ONLINE', 'ADJUSTMENT'], default: 'BANK_TRANSFER' },
    referenceNo: { type: String, trim: true },
    paidDate: { type: Date, default: Date.now },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    remarks: { type: String, trim: true }
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
    invoiceNo: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },

    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    customerName: { type: String, trim: true },
    customerCode: { type: String, trim: true },

    // Billing period
    billingPeriodStart: { type: Date },
    billingPeriodEnd: { type: Date },
    invoiceDate: { type: Date, default: Date.now, required: true },
    dueDate: { type: Date },

    // Line items (shipments)
    lineItems: [invoiceLineItemSchema],

    // Totals
    subtotal: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    totalDiscount: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    // Payment tracking
    amountPaid: { type: Number, default: 0 },
    balanceDue: { type: Number, default: 0 },
    payments: [paymentSchema],

    status: {
        type: String,
        enum: ['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED'],
        default: 'DRAFT',
        index: true
    },

    // Tax breakdown
    taxBreakup: [{
        taxName: { type: String, trim: true }, // e.g. CGST, SGST, IGST
        rate: { type: Number, default: 0 },
        amount: { type: Number, default: 0 }
    }],

    // Notes
    notes: { type: String, trim: true },
    termsAndConditions: { type: String, trim: true },

    // PDF
    pdfUrl: { type: String },

    // Hierarchy / RBAC
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branchId: { type: mongoose.Schema.Types.Mixed, index: true },

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

invoiceSchema.index({ customerId: 1, status: 1 });
invoiceSchema.index({ invoiceDate: -1 });

module.exports = mongoose.model('Invoice', invoiceSchema);
