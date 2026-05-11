import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateStandbyFee, isRevolving } from '../utils/fees';

test('calculateStandbyFee mirrors on-chain annualized formula', () => {
  const fee = calculateStandbyFee(1_000_000, 250_000, 200, 365 * 24 * 60 * 60);
  // (750_000 * 200) / 10_000 = 15_000
  assert.equal(fee, 15_000);
});

test('calculateStandbyFee returns zero for non-positive undrawn windows', () => {
  assert.equal(calculateStandbyFee(1000, 1000, 100, 86400), 0);
  assert.equal(calculateStandbyFee(1000, 1200, 100, 86400), 0);
  assert.equal(calculateStandbyFee(1000, 0, 0, 86400), 0);
});

test('isRevolving narrows truthy revolving contracts', () => {
  const revolvingContract = { isRevolving: true as const, contractSeed: '1' };
  const standardContract = { isRevolving: false as const, contractSeed: '2' };

  assert.equal(isRevolving(revolvingContract), true);
  assert.equal(isRevolving(standardContract), false);
});
