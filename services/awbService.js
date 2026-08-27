const mongoose = require('mongoose');
const AwbSeries = require('../models/AwbSeries');

const normalizeTargetIds = (values = []) => {
    const normalized = [];

    values.filter(Boolean).forEach((value) => {
        const stringValue = String(value);
        normalized.push(stringValue);
        if (mongoose.isValidObjectId(stringValue)) {
            normalized.push(new mongoose.Types.ObjectId(stringValue));
        }
    });

    return normalized;
};

const formatAwbNumber = (series, number) => {
    const width = series.numberWidth || String(series.endNumber).length;
    return `${series.prefix}${String(number).padStart(width, '0')}`;
};

const consumeAllocatedAwb = async ({ seriesId, targetIds, targetTypes, session, maxRetries = 5 }) => {
    const normalizedIds = normalizeTargetIds(targetIds);
    if (normalizedIds.length === 0) {
        const error = new Error('No AWB allocation target is available for this user');
        error.statusCode = 400;
        throw error;
    }

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const allocationQuery = {
            allocatedToId: { $in: normalizedIds }
        };
        if (targetTypes && targetTypes.length) {
            allocationQuery.allocatedToType = { $in: targetTypes };
        }

        const seriesQuery = {
            isDeleted: { $ne: true },
            status: 'ACTIVE',
            allocations: { $elemMatch: allocationQuery }
        };
        if (seriesId) {
            if (!mongoose.isValidObjectId(seriesId)) {
                const error = new Error('A valid AWB series id is required');
                error.statusCode = 400;
                throw error;
            }
            seriesQuery._id = seriesId;
        }

        let query = AwbSeries.find(seriesQuery).sort({ createdAt: 1 });
        if (session) query = query.session(session);
        const candidates = await query;

        for (const series of candidates) {
            const allocation = series.allocations.find((item) => {
                const matchesId = normalizedIds.some((id) => String(id) === String(item.allocatedToId));
                const matchesType = !targetTypes || !targetTypes.length || targetTypes.includes(item.allocatedToType);
                return matchesId && matchesType && item.lastConsumedNumber < item.endNumber;
            });

            if (!allocation) continue;

            const expectedLastNumber = allocation.lastConsumedNumber;
            const nextNumber = expectedLastNumber + 1;
            const allocationMatch = allocation._id
                ? { _id: allocation._id, lastConsumedNumber: expectedLastNumber }
                : {
                    startNumber: allocation.startNumber,
                    endNumber: allocation.endNumber,
                    allocatedToType: allocation.allocatedToType,
                    allocatedToId: allocation.allocatedToId,
                    lastConsumedNumber: expectedLastNumber
                };
            const allocationFilter = {};
            Object.keys(allocationMatch).forEach((key) => {
                allocationFilter[`allocation.${key}`] = allocationMatch[key];
            });
            const updateOptions = {
                new: true,
                runValidators: true,
                arrayFilters: [allocationFilter]
            };
            if (session) updateOptions.session = session;

            const updated = await AwbSeries.findOneAndUpdate(
                {
                    _id: series._id,
                    status: 'ACTIVE',
                    isDeleted: { $ne: true },
                    allocations: { $elemMatch: allocationMatch }
                },
                {
                    $inc: {
                        'allocations.$[allocation].lastConsumedNumber': 1,
                        'allocations.$[allocation].consumedCount': 1
                    }
                },
                updateOptions
            );

            if (!updated) continue;

            const totalAllocated = updated.allocations.reduce(
                (sum, item) => sum + (item.endNumber - item.startNumber + 1),
                0
            );
            const totalConsumed = updated.allocations.reduce(
                (sum, item) => sum + (item.consumedCount || 0),
                0
            );

            if (totalAllocated > 0 && totalConsumed >= totalAllocated) {
                await AwbSeries.updateOne(
                    { _id: updated._id, status: 'ACTIVE' },
                    { $set: { status: 'EXHAUSTED' } },
                    session ? { session } : undefined
                );
            }

            return {
                awbNumber: formatAwbNumber(updated, nextNumber),
                number: nextNumber,
                seriesId: updated._id,
                seriesCode: updated.code,
                prefix: updated.prefix,
                allocationId: allocation._id || null,
                allocatedToId: allocation.allocatedToId,
                allocatedToType: allocation.allocatedToType
            };
        }
    }

    const error = new Error('No available AWB numbers in the assigned allocations');
    error.statusCode = 409;
    throw error;
};

module.exports = {
    consumeAllocatedAwb,
    formatAwbNumber,
    normalizeTargetIds
};
