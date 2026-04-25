import assert from 'node:assert/strict';
import test from 'node:test';
import { BN } from '@coral-xyz/anchor';
import { toBn, u64ToLeBytes } from '../utils/bn';

test('toBn normalizes numeric inputs', () => {
  assert.equal(toBn(42).toString(), '42');
  assert.equal(toBn(9_876_543_210n).toString(), '9876543210');
});

test('u64ToLeBytes encodes BN in little-endian u64 layout', () => {
  const value = new BN('18446744073709551615'); // u64::MAX
  const bytes = u64ToLeBytes(value);

  assert.equal(bytes.length, 8);
  assert.equal(bytes.toString('hex'), 'ffffffffffffffff');
});
