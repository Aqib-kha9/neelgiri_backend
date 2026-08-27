/**
 * validationGuards.js
 *
 * Centralized validation utilities to prevent duplicate AWBs, invalid
 * status transitions, and data integrity issues.
 *
 * In real courier systems, AWB uniqueness is critical — a duplicate AWB
 * means two parcels get tracked as one, causing delivery chaos.
 *
 * This utility provides:
 *   1. generateUniqueAwb() — generates AWB with collision check against DB
 *   2. validateAwbFormat() — validates AWB format
 *   3. validateStatusTransition() — ensures shipment status follows valid lifecycle
 *   4. validatePincode() — validates Indian pincode format
 *   5. validateWeight() — validates weight is positive and within limits
 *   6. validatePhoneNumber() — validates Indian phone number format
 */

const Shipment = require('../models/Shipment');
const { dateStamp, rand } = require('./idGenerator');

// ─── AWB Generation ────────────────────────────────────────────────

/**
 * Generate a unique AWB with collision checking.
 * Format: AWB-{YYYYMMDD}-{6-char-alphanumeric}
 * Retries up to 5 times if collision detected.
 *
 * @param {String} prefix - AWB prefix (default: 'AWB')
 * @param {Number} maxRetries - Max collision retry attempts (default: 5)
 * @returns {String} Unique AWB
 */
async function generateUniqueAwb(prefix = 'AWB', maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const awb = `${prefix}-${dateStamp()}-${rand(6)}`;

        // Check if this AWB already exists in the database
        const existing = await Shipment.findOne({ awb }).select('_id').lean();
        if (!existing) {
            return awb;
        }

        console.warn(`[validationGuards] AWB collision detected on attempt ${attempt + 1}: ${awb}, retrying...`);
    }

    // Fallback: use timestamp + longer random to virtually eliminate collision
    const fallback = `${prefix}-${Date.now()}-${rand(8)}`;
    console.warn(`[validationGuards] Using fallback AWB after ${maxRetries} collisions: ${fallback}`);
    return fallback;
}

/**
 * Validate AWB format.
 * Accepted formats: AWB-YYYYMMDD-XXXXXX or AWBXXXXXXXXXX
 *
 * @param {String} awb
 * @returns {Boolean}
 */
function validateAwbFormat(awb) {
    if (!awb || typeof awb !== 'string') return false;
    const trimmed = awb.trim();

    // Must start with AWB (case-insensitive)
    if (!/^AWB/i.test(trimmed)) return false;

    // Length check: minimum 10, maximum 30
    if (trimmed.length < 10 || trimmed.length > 30) return false;

    // Must be alphanumeric with optional hyphens
    if (!/^[A-Za-z0-9-]+$/.test(trimmed)) return false;

    return true;
}

/**
 * Check if an AWB already exists in the database.
 *
 * @param {String} awb
 * @returns {Boolean} true if AWB already exists
 */
async function awbExists(awb) {
    if (!awb) return false;
    const existing = await Shipment.findOne({ awb: awb.trim() }).select('_id').lean();
    return !!existing;
}

// ─── Status Transition Validation ────────────────────────────────

/**
 * Valid shipment status transitions.
 * Maps current status → array of allowed next statuses.
 */
const VALID_TRANSITIONS = {
    'not_scheduled': ['booked', 'picked_up', 'cancelled'],
    'booked': ['picked_up', 'in_transit', 'cancelled'],
    'picked_up': ['in_transit', 'arrived_at_branch', 'cancelled'],
    'in_transit': ['arrived_at_branch', 'out_for_delivery', 'delivery_failed', 'rto_initiated'],
    'arrived_at_branch': ['not_scheduled', 'out_for_delivery', 'in_transit', 'delivery_failed', 'rto_initiated'],
    'out_for_delivery': ['delivered', 'delivery_failed', 'rto_initiated'],
    'delivery_failed': ['out_for_delivery', 'not_scheduled', 'rto_initiated', 'cancelled'],
    'delivered': [], // Terminal
    'rto_initiated': ['rto_in_transit', 'rto_received', 'rto_completed', 'cancelled'],
    'rto_in_transit': ['rto_received', 'rto_completed'],
    'rto_received': ['rto_completed'],
    'rto_completed': [], // Terminal
    'cancelled': [], // Terminal
    'returned': [] // Terminal
};

/**
 * Validate that a status transition is allowed.
 *
 * @param {String} currentStatus
 * @param {String} newStatus
 * @returns {Boolean} true if transition is valid
 */
function validateStatusTransition(currentStatus, newStatus) {
    // Normalize to lowercase
    const current = (currentStatus || '').toLowerCase();
    const next = (newStatus || '').toLowerCase();

    // Same status is always valid (idempotent)
    if (current === next) return true;

    // If current status not in map, allow any transition (backward compat)
    if (!VALID_TRANSITIONS[current]) return true;

    const allowed = VALID_TRANSITIONS[current];
    return allowed.includes(next);
}

/**
 * Get the list of valid next statuses for a given current status.
 *
 * @param {String} currentStatus
 * @returns {Array} List of valid next statuses
 */
function getValidNextStatuses(currentStatus) {
    const current = (currentStatus || '').toLowerCase();
    return VALID_TRANSITIONS[current] || [];
}

/**
 * Check if a status is terminal (no further transitions).
 *
 * @param {String} status
 * @returns {Boolean}
 */
function isTerminalStatus(status) {
    const s = (status || '').toLowerCase();
    return VALID_TRANSITIONS[s] !== undefined && VALID_TRANSITIONS[s].length === 0;
}

// ─── Field Validators ─────────────────────────────────────────────

/**
 * Validate Indian pincode format (6 digits, first digit 1-8).
 *
 * @param {String} pincode
 * @returns {Boolean}
 */
function validatePincode(pincode) {
    if (!pincode) return false;
    const pin = String(pincode).trim();
    return /^[1-8][0-9]{5}$/.test(pin);
}

/**
 * Validate weight is positive and within reasonable limits.
 *
 * @param {Number} weight
 * @param {Number} maxWeight - Maximum allowed weight in kg (default: 10000)
 * @returns {Boolean}
 */
function validateWeight(weight, maxWeight = 10000) {
    const w = Number(weight);
    if (isNaN(w)) return false;
    if (w <= 0) return false;
    if (w > maxWeight) return false;
    return true;
}

/**
 * Validate Indian phone number format (10 digits, starting with 6-9).
 *
 * @param {String} phone
 * @returns {Boolean}
 */
function validatePhoneNumber(phone) {
    if (!phone) return false;
    const cleaned = String(phone).replace(/[\s+()-]/g, '');
    return /^[6-9][0-9]{9}$/.test(cleaned);
}

/**
 * Validate email format.
 *
 * @param {String} email
 * @returns {Boolean}
 */
function validateEmail(email) {
    if (!email) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

/**
 * Validate COD amount is positive (if COD payment mode).
 *
 * @param {String} paymentMode
 * @param {Number} codAmount
 * @returns {Boolean}
 */
function validateCODAmount(paymentMode, codAmount) {
    if (!paymentMode || paymentMode.toLowerCase() !== 'cod') return true;
    const amt = Number(codAmount);
    return !isNaN(amt) && amt > 0;
}

/**
 * Validate declared value for insurance.
 *
 * @param {Number} declaredValue
 * @returns {Boolean}
 */
function validateDeclaredValue(declaredValue) {
    if (declaredValue === undefined || declaredValue === null) return true; // Optional
    const val = Number(declaredValue);
    return !isNaN(val) && val >= 0;
}

/**
 * Comprehensive shipment validation before creation.
 * Returns { valid, errors } object.
 *
 * @param {Object} data - Shipment data
 * @returns {Object} { valid: Boolean, errors: Array }
 */
function validateShipmentData(data) {
    const errors = [];

    if (!data) {
        return { valid: false, errors: ['No data provided'] };
    }

    const validateParty = (party, label) => {
        if (!party || !String(party.name || '').trim()) errors.push(`${label} name is required`);
        if (party && String(party.name || '').trim().length > 120) errors.push(`${label} name is too long`);
        if (!party || !validatePhoneNumber(party.phone)) errors.push(`Valid ${label.toLowerCase()} phone number is required`);
        if (!party || !validatePincode(party.pincode)) errors.push(`Valid ${label.toLowerCase()} pincode is required`);
        if (!party || String(party.address || '').trim().length < 10) errors.push(`${label} address is required`);
        if (party?.email && !validateEmail(party.email)) errors.push(`Valid ${label.toLowerCase()} email is required`);
        if (party?.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(party.gstin).trim().toUpperCase())) errors.push(`Valid ${label.toLowerCase()} GSTIN is required`);
    };
    validateParty(data.sender, 'Sender');
    validateParty(data.receiver, 'Receiver');

    // Weight and dimensions validation
    if (!validateWeight(data.weight)) errors.push('Valid weight is required (must be > 0 and <= 10000 kg)');
    const dimensions = data.dimensions || {};
    const dimensionValues = [dimensions.length, dimensions.width, dimensions.height].map(Number);
    const hasDimensions = dimensionValues.some(value => value > 0);
    if (hasDimensions && dimensionValues.some(value => !Number.isFinite(value) || value <= 0)) {
        errors.push('All dimensions must be positive when provided');
    }
    if (String(data.contents || '').trim().length < 2) errors.push('Shipment contents are required');
    if (!['BOX', 'DOCUMENT', 'PALLET'].includes(String(data.packageType || 'BOX').toUpperCase())) errors.push('Invalid package type');
    if (data.category && String(data.category).trim().length > 80) errors.push('Shipment category is too long');
    if (!['SURFACE', 'AIR'].includes(String(data.mode || 'SURFACE').toUpperCase())) errors.push('Invalid service mode');

    // Payment mode validation
    const validPaymentModes = ['prepaid', 'cod', 'credit', 'topay'];
    if (!data.paymentMode || !validPaymentModes.includes(String(data.paymentMode).toLowerCase())) {
        errors.push(`Invalid payment mode. Must be one of: ${validPaymentModes.join(', ')}`);
    }

    // COD amount validation
    if (!validateCODAmount(data.paymentMode, data.codAmount)) {
        errors.push('COD amount must be positive when payment mode is COD');
    }

    // Declared value, insurance and compliance validation
    if (!validateDeclaredValue(data.declaredValue)) errors.push('Declared value must be a non-negative number');
    if (data.insuranceRequired && Number(data.declaredValue || 0) <= 0) errors.push('Declared value is required for insurance');
    if (data.fovPercentage !== undefined && data.fovPercentage !== null && (!Number.isFinite(Number(data.fovPercentage)) || Number(data.fovPercentage) < 0 || Number(data.fovPercentage) > 100)) errors.push('FOV percentage must be between 0 and 100');
    if (data.insuranceRequired && data.fovPercentage !== undefined && data.fovPercentage !== null && Number(data.fovPercentage) <= 0) errors.push('FOV percentage must be positive for insurance');
    if (data.eWayBill && !/^\d{12}$/.test(String(data.eWayBill).trim())) errors.push('E-Way Bill must contain exactly 12 digits');
    if (data.termsAccepted !== true) errors.push('Terms and conditions must be accepted');
    if (!String(data.termsVersion || '').trim()) errors.push('Terms version is required');

    if (data.attachments !== undefined) {
        if (!Array.isArray(data.attachments)) {
            errors.push('Attachments must be an array');
        } else {
            const allowedAttachmentTypes = ['parcel_photo', 'document_scan', 'invoice_scan'];
            if (data.attachments.length > 10) errors.push('A maximum of 10 attachments is allowed');
            if (data.attachments.filter(item => item?.type === 'parcel_photo').length > 5) errors.push('A maximum of 5 parcel photos is allowed');
            data.attachments.forEach((attachment, index) => {
                if (!attachment || !String(attachment.url || '').trim()) errors.push(`Attachment ${index + 1} URL is required`);
                if (!allowedAttachmentTypes.includes(attachment?.type)) errors.push(`Attachment ${index + 1} type is invalid`);
                if (attachment?.size !== undefined && (!Number.isFinite(Number(attachment.size)) || Number(attachment.size) < 0 || Number(attachment.size) > 5 * 1024 * 1024)) errors.push(`Attachment ${index + 1} exceeds the 5 MB limit`);
                if (attachment?.mimetype && !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(attachment.mimetype)) errors.push(`Attachment ${index + 1} MIME type is invalid`);
                if (attachment?.type === 'parcel_photo' && attachment?.mimetype && !String(attachment.mimetype).startsWith('image/')) errors.push(`Attachment ${index + 1} must be an image`);
            });
        }
    }

    // AWB format validation (if provided manually)
    if (data.awb && !validateAwbFormat(data.awb)) {
        errors.push('Invalid AWB format');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

module.exports = {
    // AWB
    generateUniqueAwb,
    validateAwbFormat,
    awbExists,
    // Status transitions
    VALID_TRANSITIONS,
    validateStatusTransition,
    getValidNextStatuses,
    isTerminalStatus,
    // Field validators
    validatePincode,
    validateWeight,
    validatePhoneNumber,
    validateEmail,
    validateCODAmount,
    validateDeclaredValue,
    // Comprehensive
    validateShipmentData
};
