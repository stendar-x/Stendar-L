import assert from 'node:assert/strict';
import test from 'node:test';

import { PREPAYMENT_FEE_BPS, calculatePrepaymentFee, calculateStandbyFee } from '../utils/fees';

test('PREPAYMENT_FEE_BPS remains 200', () => {
  assert.equal(PREPAYMENT_FEE_BPS, 200);
});

test('calculatePrepaymentFee handles baseline values', () => {
  assert.equal(calculatePrepaymentFee(0), 0);
  assert.equal(calculatePrepaymentFee(1), 0);
  assert.equal(calculatePrepaymentFee(50), 1);
  assert.equal(calculatePrepaymentFee(100), 2);
});

test('calculatePrepaymentFee rounds down for fractional fees', () => {
  assert.equal(calculatePrepaymentFee(49), 0);
  assert.equal(calculatePrepaymentFee(99), 1);
});

test('calculatePrepaymentFee throws when principal exceeds safe precision bounds', () => {
  const unsafePrincipal = Math.floor(Number.MAX_SAFE_INTEGER / PREPAYMENT_FEE_BPS) + 1;
  assert.throws(
    () => calculatePrepaymentFee(unsafePrincipal),
    /exceeds safe integer precision/i
  );
});

test('calculateStandbyFee throws when numerator exceeds safe precision bounds', () => {
  assert.throws(
    () => calculateStandbyFee(Number.MAX_SAFE_INTEGER, 0, 10_000, 365 * 24 * 60 * 60),
    /exceeds safe integer precision/i
  );
});
