const test = require('node:test');
const assert = require('node:assert/strict');
const {
    pickupCreators,
    pickupOperators,
    pickupExecutors,
    roleName,
    isOperationsRole,
    canExecutePickup
} = require('../utils/pickupPolicy');

test('pickup role sets preserve creator, operator, and executor boundaries', () => {
    assert.equal(pickupCreators.includes('customer'), true);
    assert.equal(pickupOperators.includes('customer'), false);
    assert.equal(pickupExecutors.includes('rider'), true);
    assert.equal(pickupOperators.includes('rider'), false);

    for (const role of pickupOperators) {
        assert.equal(pickupCreators.includes(role), true);
        assert.equal(pickupExecutors.includes(role), true);
    }
});

test('roleName supports populated and plain role values', () => {
    assert.equal(roleName({ role: 'dispatcher' }), 'dispatcher');
    assert.equal(roleName({ role: { name: 'branch_admin' } }), 'branch_admin');
    assert.equal(roleName({}), undefined);
});

test('operations roles can execute pickups', () => {
    for (const role of pickupOperators) {
        assert.equal(isOperationsRole({ role }), true);
        assert.equal(canExecutePickup({ role }, {}), true);
    }

    assert.equal(isOperationsRole({ role: 'customer' }), false);
    assert.equal(canExecutePickup({ role: 'customer' }, {}), false);
});

test('riders can execute only their assigned pickup', () => {
    const assignedRider = { _id: 'rider-1', role: 'rider' };
    const otherRider = { _id: 'rider-2', role: { name: 'rider' } };
    const pickup = { assignedRider: 'rider-1' };

    assert.equal(canExecutePickup(assignedRider, pickup), true);
    assert.equal(canExecutePickup(otherRider, pickup), false);
    assert.equal(canExecutePickup(assignedRider, {}), false);
    assert.equal(canExecutePickup({ role: 'rider' }, pickup), false);
});
