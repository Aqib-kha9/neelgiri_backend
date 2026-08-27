const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    sku: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    category: { type: String, required: true, trim: true, index: true },
    subCategory: { type: String, trim: true },
    hsnCode: { type: String, trim: true },

    weight: { type: Number, default: 0 }, // in kg
    dimensions: {
        length: { type: Number, default: 0 },
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 },
        unit: { type: String, default: 'cm' }
    },
    dimensionString: { type: String, default: '' },

    value: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },

    handlingFlags: {
        fragile: { type: Boolean, default: false },
        hazardous: { type: Boolean, default: false },
        temperatureSensitive: { type: Boolean, default: false },
        flammable: { type: Boolean, default: false },
        perishable: { type: Boolean, default: false }
    },
    specialHandling: { type: String, default: '' },
    storageRequirements: { type: String, default: '' },

    packaging: {
        recommendedPackaging: String,
        maxStackingHeight: Number,
        storageTempMin: Number,
        storageTempMax: Number
    },

    images: [String],
    barcode: { type: String, default: '' },

    status: { type: String, enum: ['active', 'inactive', 'discontinued'], default: 'active' },

    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted: { type: Boolean, default: false }
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

productSchema.index({ name: 'text', description: 'text', sku: 'text' });

module.exports = mongoose.model('Product', productSchema);
