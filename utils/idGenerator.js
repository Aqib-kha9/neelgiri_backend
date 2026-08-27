/**
 * idGenerator.js
 * Centralized, production-grade ID generators for all LogiFlow entities.
 * Uses a prefix + base36 timestamp + random suffix to guarantee uniqueness
 * while remaining human-readable (e.g. INV-20260701-AB12).
 */

const pad = (n, len = 2) => String(n).padStart(len, '0');

const dateStamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
};

const rand = (len = 4) => Math.random().toString(36).slice(2, 2 + len).toUpperCase();

const generateManifestId = () => `MF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const generateBagId = () => `BAG-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

const generateDriverCode = () => `DRV-${dateStamp()}-${rand(4)}`;
const generateVehicleCode = () => `VEH-${dateStamp()}-${rand(4)}`;
const generateInvoiceNo = () => `INV-${dateStamp()}-${rand(5)}`;
const generateCreditNoteNo = () => `CN-${dateStamp()}-${rand(5)}`;
const generateDebitNoteNo = () => `DN-${dateStamp()}-${rand(5)}`;
const generateAwbSeriesCode = () => `AWB-SER-${dateStamp()}-${rand(4)}`;
const generatePodId = () => `POD-${dateStamp()}-${rand(5)}`;
const generateTicketNo = () => `TKT-${dateStamp()}-${rand(5)}`;
const generateAgreementNo = () => `AGR-${dateStamp()}-${rand(5)}`;
const generateExceptionId = () => `EXC-${dateStamp()}-${rand(5)}`;
const generateAssetCode = () => `AST-${dateStamp()}-${rand(4)}`;
const generateSkuCode = () => `SKU-${dateStamp()}-${rand(4)}`;
const generateRouteCode = () => `RTE-${dateStamp()}-${rand(4)}`;
const generateLocationCode = () => `LOC-${dateStamp()}-${rand(4)}`;
const generateAttendanceId = () => `ATT-${Date.now()}-${rand(4)}`;
const generateTrackingId = () => `TRK-${Date.now()}-${rand(6)}`;
const generateVendorCode = () => `VND-${dateStamp()}-${rand(4)}`;
const generatePartnerCode = () => `PRT-${dateStamp()}-${rand(4)}`;
const generateReconciliationId = () => `REC-${dateStamp()}-${rand(5)}`;
const generateLeaveRequestId = () => `LVR-${dateStamp()}-${rand(5)}`;
const generateShiftId = () => `SFT-${dateStamp()}-${rand(4)}`;
const generateSettlementId = () => `SET-${dateStamp()}-${rand(5)}`;
const generateTallySyncId = () => `SYNC-${dateStamp()}-${rand(5)}`;
const generatePaymentTxnId = () => `TXN-${dateStamp()}-${rand(6)}`;
const generatePickupRequestId = () => `PKP-${dateStamp()}-${rand(5)}`;
const generateTripId = () => `TRP-${dateStamp()}-${rand(5)}`;
const generateNotificationId = () => `NTF-${Date.now()}-${rand(6)}`;

module.exports = {
    generateManifestId,
    generateBagId,
    generateDriverCode,
    generateVehicleCode,
    generateInvoiceNo,
    generateCreditNoteNo,
    generateDebitNoteNo,
    generateAwbSeriesCode,
    generatePodId,
    generateTicketNo,
    generateAgreementNo,
    generateExceptionId,
    generateAssetCode,
    generateSkuCode,
    generateRouteCode,
    generateLocationCode,
    generateAttendanceId,
    generateTrackingId,
    generateVendorCode,
    generatePartnerCode,
    generateReconciliationId,
    generateLeaveRequestId,
    generateShiftId,
    generateSettlementId,
    generateTallySyncId,
    generatePaymentTxnId,
    generatePickupRequestId,
    generateTripId,
    generateNotificationId
};
