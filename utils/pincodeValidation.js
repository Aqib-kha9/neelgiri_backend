const Pincode = require('../models/Pincode');

const normalizeLocation = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[.,\-_/]+/g, ' ')
    .replace(/\s+/g, ' ');

const isCityCompatible = (city, pincode) => {
    const normalizedCity = normalizeLocation(city);
    if (!normalizedCity) return true;

    const state = normalizeLocation(pincode.state);
    const district = normalizeLocation(pincode.district);
    const officeName = normalizeLocation(pincode.officeName);

    // City-states and union territories often use postal districts such as
    // Central, North, or South instead of repeating the selected city name.
    if (normalizedCity === state) return true;
    if (!district && !officeName) return true;
    if (district === normalizedCity || officeName === normalizedCity) return true;

    return Boolean(
        officeName &&
        (officeName.startsWith(`${normalizedCity} `) ||
            officeName.endsWith(` ${normalizedCity}`))
    );
};

const getPincodeValidationError = (pincode, state, city, records = []) => {
    if (!/^\d{6}$/.test(pincode)) {
        return 'Pincode must be exactly 6 digits';
    }

    if (records.length === 0) {
        return 'Pincode was not found in Pincode Master';
    }

    const normalizedState = normalizeLocation(state);
    const stateMatches = records.filter((record) =>
        normalizeLocation(record.state) === normalizedState
    );

    if (stateMatches.length === 0) {
        return 'Pincode does not belong to the selected state';
    }

    const activeMatches = stateMatches.filter((record) =>
        record.isActiveForBranch !== false
    );
    if (activeMatches.length === 0) {
        return 'Pincode exists but is disabled for branch use';
    }

    if (!activeMatches.some((record) => isCityCompatible(city, record))) {
        return 'Pincode does not belong to the selected city or district';
    }

    return null;
};

const findValidBranchPincode = async ({ pincode, state, city }) => {
    const normalizedPincode = String(pincode || '').trim();
    const records = await Pincode.find({ pincode: normalizedPincode })
        .select('pincode officeName district state isActiveForBranch')
        .sort({ isActiveForBranch: -1, _id: 1 })
        .lean();

    const error = getPincodeValidationError(normalizedPincode, state, city, records);
    if (error) {
        const validationError = new Error(error);
        validationError.statusCode = 400;
        throw validationError;
    }

    const matchingRecord = records.find((record) =>
        normalizeLocation(record.state) === normalizeLocation(state) &&
        record.isActiveForBranch !== false &&
        isCityCompatible(city, record)
    );

    if (!matchingRecord) {
        const validationError = new Error('Pincode is not valid for the selected branch location');
        validationError.statusCode = 400;
        throw validationError;
    }

    return matchingRecord;
};

module.exports = {
    findValidBranchPincode,
    normalizeLocation,
    isCityCompatible
};
