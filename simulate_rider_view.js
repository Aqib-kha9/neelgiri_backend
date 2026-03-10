const mongoose = require('mongoose');
const dotenv = require('dotenv');
const DRS = require('./models/DRS');
const User = require('./models/User');

dotenv.config();

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('DB Connected');

        // 1. Get Last Created DRS
        const drs = await DRS.findOne().sort({ createdAt: -1 });
        if (!drs) {
            console.log('No DRS found.');
            return;
        }

        console.log(`Target DRS ID: ${drs.drsId}`);
        console.log(`Target Rider ID: ${drs.rider}`);

        // 2. Simulate getAllDRS for this Rider
        // Based on drsController.getAllDRS logic for 'rider' role
        const matchStage = {};
        matchStage.rider = drs.rider; // Simulate req.user._id
        matchStage.status = { $ne: 'deleted' };

        console.log('Match Stage:', JSON.stringify(matchStage));

        const drsList = await DRS.aggregate([
            { $match: matchStage },
            { $sort: { createdAt: -1 } },
            // Lookup Rider
            {
                $lookup: {
                    from: 'users',
                    localField: 'rider',
                    foreignField: '_id',
                    as: 'rider'
                }
            },
            { $unwind: { path: '$rider', preserveNullAndEmptyArrays: true } },
            // Lookup Shipments
            {
                $lookup: {
                    from: 'shipments',
                    let: { drsShipments: '$shipments' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $in: ['$awb', '$$drsShipments.awb']
                                }
                            }
                        },
                        {
                            $project: {
                                awb: 1,
                                'receiver.pincode': 1,
                                createdAt: 1
                            }
                        }
                    ],
                    as: 'shipmentDetails'
                }
            },
            {
                $addFields: {
                    shipments: {
                        $map: {
                            input: '$shipments',
                            as: 's',
                            in: {
                                $mergeObjects: [
                                    '$$s',
                                    {
                                        $arrayElemAt: [
                                            {
                                                $filter: {
                                                    input: '$shipmentDetails',
                                                    as: 'sd',
                                                    cond: { $eq: ['$$sd.awb', '$$s.awb'] }
                                                }
                                            },
                                            0
                                        ]
                                    }
                                ]
                            }
                        }
                    }
                }
            },
            { $project: { shipmentDetails: 0 } },
            {
                $lookup: {
                    from: 'branches',
                    let: { drsBranchId: '$branchId' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $eq: [{ $toString: '$_id' }, '$$drsBranchId']
                                }
                            }
                        }
                    ],
                    as: 'branchId'
                }
            },
            { $unwind: { path: '$branchId', preserveNullAndEmptyArrays: true } }
        ]);

        console.log(`Found ${drsList.length} DRS for this rider.`);
        const found = drsList.find(d => d.drsId === drs.drsId);
        if (found) {
            console.log('✅ Target DRS found in results!');
            console.log('Status:', found.status);
        } else {
            console.log('❌ Target DRS NOT found in results.');
        }

    } catch (e) {
        console.error('Error:', e);
    } finally {
        await mongoose.disconnect();
    }
};

run();
