const pickupCreators = [
    'customer',
    'branch_admin',
    'branch',
    'dispatcher',
    'partner_admin',
    'partner',
    'super_admin'
];

const pickupOperators = [
    'branch_admin',
    'branch',
    'dispatcher',
    'partner_admin',
    'partner',
    'super_admin'
];

const pickupExecutors = ['rider', ...pickupOperators];

const roleName = (user) => user?.role?.name || user?.role;

const isOperationsRole = (user) => pickupOperators.includes(roleName(user));

const canExecutePickup = (user, pickup) => {
    if (roleName(user) === 'rider') {
        return Boolean(
            pickup?.assignedRider &&
            user?._id &&
            pickup.assignedRider.toString() === user._id.toString()
        );
    }
    return isOperationsRole(user);
};

module.exports = {
    pickupCreators,
    pickupOperators,
    pickupExecutors,
    roleName,
    isOperationsRole,
    canExecutePickup
};
