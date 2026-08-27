const Rate = require('../models/Rate');
const Pincode = require('../models/Pincode');
const Customer = require('../models/Customer');

/**
 * Haversine formula to calculate distance between two points in KM
 */
const calculateDistance = (lat1, lon1, lat2, lon2) => {
    if (!lat1 || !lon1 || !lat2 || !lon2) return -1;
    const R = 6371; // Radius of earth in KM
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
};

/**
 * Professional Logistics Pricing Engine (Production Grade)
 */
const calculateFreight = async ({
    rateCardId,
    sourcePincode,
    destPincode,
    originPincode, // Alias for source
    destinationPincode, // Alias for dest
    weight, // Actual weight in kg
    length = 0, // in cm
    breadth = 0,  // in cm
    width = 0, // Alias for breadth
    height = 0, // in cm
    declaredValue = 0,
    codAmount = 0,
    isCOD = false,
    insuranceRequested = false,
    fovPercentage: requestedFovPercentage = null,
    customerId = null,
    customerType = 'CUSTOMER', // Used for auto-finding rate
    serviceType = 'SURFACE'    // Used for auto-finding rate
}) => {
    try {
        const sPincode = sourcePincode || originPincode;
        const dPincode = destPincode || destinationPincode;
        const bBreadth = breadth || width;

        // 1. Fetch Rate Card & Pincode Metadata
        let rateCard;
        if (rateCardId) {
            rateCard = await Rate.findById(rateCardId);
        } else {
            // Find most relevant active rate card with fallbacks
            // Priority: 1. Specific Match, 2. customerType: ALL, 3. serviceType: ALL, 4. Both ALL
            const searchQueries = [
                { customerType, serviceType, isActive: true },
                { customerType: 'ALL', serviceType, isActive: true },
                { customerType, serviceType: 'ALL', isActive: true },
                { customerType: 'ALL', serviceType: 'ALL', isActive: true }
            ];

            for (const query of searchQueries) {
                rateCard = await Rate.findOne({
                    ...query,
                    validFrom: { $lte: new Date() },
                    validTo: { $gte: new Date() }
                }).sort({ createdAt: -1 });
                
                if (rateCard) break;
            }
        }

        if (!rateCard) throw new Error(`No active rate card found for ${customerType} - ${serviceType}`);
        if (!sPincode) throw new Error(`Source/Origin pincode is required for pricing`);
        if (!dPincode) throw new Error(`Destination pincode is required for pricing`);

        const [origin, dest] = await Promise.all([
            Pincode.findOne({ pincode: sPincode }),
            Pincode.findOne({ pincode: dPincode })
        ]);

        if (!origin) throw new Error(`Origin pincode ${sPincode} is not serviceable or not found`);
        if (!dest) throw new Error(`Destination pincode ${dPincode} is not serviceable or not found`);

        // 2. Calculate Chargeable Weight (Volumetric vs Dead weight)
        const volumetricDivisor = rateCard.volumetricDivisor || 5000;
        const volumetricWeight = (length * bBreadth * height) / volumetricDivisor;
        let baseChargeableWeight = Math.max(weight, volumetricWeight);

        // Apply Rounding Logic
        if (rateCard.autoCalculate?.enabled) {
            const factor = rateCard.autoCalculate.roundingFactor || 1;
            if (rateCard.autoCalculate.rounding === 'UP') {
                baseChargeableWeight = Math.ceil(baseChargeableWeight / factor) * factor;
            } else if (rateCard.autoCalculate.rounding === 'DOWN') {
                baseChargeableWeight = Math.floor(baseChargeableWeight / factor) * factor;
            } else if (rateCard.autoCalculate.rounding === 'NEAR') {
                baseChargeableWeight = Math.round(baseChargeableWeight / factor) * factor;
            }
        }
        const chargeableWeight = baseChargeableWeight;

        // 3. Calculate Distance and Determine Bucket
        const distance = calculateDistance(origin.latitude, origin.longitude, dest.latitude, dest.longitude);
        
        let baseFreight = 0;
        let appliedBucket = null;

        // Priority 1: Distance Buckets (Professional Standard)
        if (distance >= 0 && rateCard.distanceBuckets?.length > 0) {
            appliedBucket = rateCard.distanceBuckets.find(b => 
                distance >= b.minDistance && (b.maxDistance === 0 || distance <= b.maxDistance)
            );

            if (appliedBucket) {
                const baseWeight = appliedBucket.baseWeight || 0.5;
                const baseRate = appliedBucket.baseRate || 0;
                const additionalWeight = appliedBucket.additionalWeight || 0.5;
                const additionalRate = appliedBucket.additionalRate || 0;

                if (chargeableWeight <= baseWeight) {
                    baseFreight = baseRate;
                } else {
                    const extraWeight = chargeableWeight - baseWeight;
                    const units = Math.ceil(extraWeight / additionalWeight);
                    baseFreight = baseRate + (units * additionalRate);
                }
            }
        }



        // Priority 3: Weight Slabs (Global Fallback)
        if (baseFreight === 0) {
            const appliedSlab = rateCard.slabs
                .sort((a, b) => a.minWeight - b.minWeight)
                .find(s => chargeableWeight >= s.minWeight && (s.maxWeight === 0 || chargeableWeight <= s.maxWeight));

            if (appliedSlab) {
                if (appliedSlab.rateType === 'FIXED') baseFreight = appliedSlab.rate;
                else baseFreight = chargeableWeight * appliedSlab.rate;
            }
        }

        // Apply Minimum Charge
        if (rateCard.minCharge?.amount > 0 && baseFreight < rateCard.minCharge.amount) {
            baseFreight = rateCard.minCharge.amount;
        }

        // 4. Calculate Surcharges
        // Fuel Surcharge
        let fuelSurcharge = 0;
        if (chargeableWeight >= (rateCard.fuelSurcharge?.applicableFrom || 0)) {
            fuelSurcharge = Math.max(
                (baseFreight * (rateCard.fuelSurcharge?.percentage || 0)) / 100,
                rateCard.fuelSurcharge?.minAmount || 0
            );
            if (rateCard.fuelSurcharge?.maxAmount > 0) {
                fuelSurcharge = Math.min(fuelSurcharge, rateCard.fuelSurcharge.maxAmount);
            }
        }

        // ODA Charge (Remote Areas)
        const odaSurcharge = (origin.isODA || dest.isODA) ? (rateCard.odaCharge || 0) : 0;

        // FOV/Insurance
        let fovCharge = 0;
        if (insuranceRequested) {
            let fovPercentage = rateCard.fovCharge?.percentage || 0;

            // Caller-provided FOV is authoritative after controller validation.
            if (requestedFovPercentage !== null && requestedFovPercentage !== undefined) {
                fovPercentage = Number(requestedFovPercentage);
            } else if (customerId) {
                const customer = await Customer.findById(customerId);
                if (customer && customer.fovPercentage > 0) {
                    fovPercentage = customer.fovPercentage;
                }
            }

            fovCharge = Math.min(
                Math.max(
                    (declaredValue * fovPercentage) / 100,
                    rateCard.fovCharge?.minAmount || 0
                ),
                rateCard.fovCharge?.maxAmount || Infinity
            );
        }

        // COD Charges
        const codCharge = isCOD ? Math.max(
            (Number(codAmount) * (rateCard.codCharges?.percentage || 0)) / 100,
            rateCard.codCharges?.minAmount || 0,
            rateCard.codCharges?.fixedCharge || 0
        ) : 0;

        // 5. Additional Charges
        let totalAdditionalCharges = 0;
        const additionalChargesBreakdown = [];
        if (rateCard.additionalCharges?.length > 0) {
            rateCard.additionalCharges.forEach(charge => {
                let amount = charge.type === 'PERCENTAGE' ? (baseFreight * (charge.value || 0)) / 100 : (charge.value || 0);
                totalAdditionalCharges += amount;
                additionalChargesBreakdown.push({ label: charge.name, value: amount });
            });
        }

        // 6. Subtotal and GST
        const subTotal = baseFreight + fuelSurcharge + fovCharge + odaSurcharge + codCharge + totalAdditionalCharges;
        const gstAmount = (subTotal * 18) / 100;
        const totalAmount = subTotal + gstAmount;

        return {
            volumetricWeight,
            chargeableWeight,
            distance,
            appliedBucket: appliedBucket ? appliedBucket.name : (distance >= 0 ? 'CALCULATED' : 'SLAB_FALLBACK'),
            baseFreight,
            fuelSurcharge,
            fovCharge,
            odaSurcharge,
            codCharge,
            totalAdditionalCharges,
            subTotal,
            gstAmount,
            totalAmount,
            breakdown: [
                { label: 'Base Freight', value: baseFreight },
                { label: 'Fuel Surcharge', value: fuelSurcharge },
                { label: 'FOV/Insurance', value: fovCharge },
                { label: 'ODA Surcharge', value: odaSurcharge },
                { label: 'COD Charge', value: codCharge },
                ...additionalChargesBreakdown,
                { label: 'GST (18%)', value: gstAmount }
            ]
        };
    } catch (error) {
        console.error('Pricing Calculation Error:', error);
        throw error;
    }
};

module.exports = { calculateFreight, calculateDistance };
