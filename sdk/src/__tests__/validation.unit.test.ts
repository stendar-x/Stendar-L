import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  toValidatedU16,
  toValidatedU32,
  toValidatedU64Bn,
  validateContributionEscrowPairs,
} from '../program';

const U64_MAX = (1n << 64n) - 1n;

test('toValidatedU64Bn accepts positive u64 values', () => {
  assert.equal(toValidatedU64Bn(1, 'amount').toString(), '1');
  assert.equal(toValidatedU64Bn('42', 'amount').toString(), '42');
  assert.equal(toValidatedU64Bn(9007199254740991n, 'amount').toString(), '9007199254740991');
  assert.equal(toValidatedU64Bn(U64_MAX, 'amount').toString(), U64_MAX.toString());
});

test('toValidatedU64Bn rejects zero and negative amount values', () => {
  assert.throws(() => toValidatedU64Bn(0, 'amount'), /greater than zero/i);
  assert.throws(() => toValidatedU64Bn(-1, 'amount'), /non-negative/i);
  assert.throws(() => toValidatedU64Bn('-3', 'amount'), /non-negative/i);
});

test('toValidatedU64Bn rejects overflow and invalid integer formats', () => {
  assert.throws(() => toValidatedU64Bn(U64_MAX + 1n, 'amount'), /exceeds u64 max/i);
  assert.throws(() => toValidatedU64Bn('18446744073709551616', 'amount'), /exceeds u64 max/i);
  assert.throws(() => toValidatedU64Bn(1.5 as any, 'amount'), /expected an integer/i);
  assert.throws(() => toValidatedU64Bn('abc' as any, 'amount'), /not a valid integer/i);
});

test('toValidatedU64Bn rejects unsafe JavaScript integers', () => {
  const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => toValidatedU64Bn(unsafeInteger, 'amount'),
    /Number\.MAX_SAFE_INTEGER/i
  );
});

test('toValidatedU64Bn supports allowZero for non-amount fields', () => {
  assert.equal(toValidatedU64Bn(0, 'proposalId', true).toString(), '0');
});

test('toValidatedU32 accepts in-range integer values', () => {
  assert.equal(toValidatedU32(0, 'proposedInterestRate'), 0);
  assert.equal(toValidatedU32(4294967295, 'proposedInterestRate'), 4294967295);
});

test('toValidatedU32 rejects invalid number formats and ranges', () => {
  assert.throws(() => toValidatedU32(-1, 'proposedInterestRate'), /u32 range/i);
  assert.throws(() => toValidatedU32(4294967296, 'proposedInterestRate'), /u32 range/i);
  assert.throws(() => toValidatedU32(1.5 as any, 'proposedInterestRate'), /expected an integer/i);
  assert.throws(() => toValidatedU32(Number.NaN, 'proposedInterestRate'), /expected an integer/i);
  assert.throws(() => toValidatedU32(Number.POSITIVE_INFINITY, 'proposedInterestRate'), /expected an integer/i);
});

test('toValidatedU16 accepts in-range integer values', () => {
  assert.equal(toValidatedU16(0, 'proposedLtvFloorBps'), 0);
  assert.equal(toValidatedU16(65535, 'proposedLtvFloorBps'), 65535);
});

test('toValidatedU16 rejects invalid number formats and ranges', () => {
  assert.throws(() => toValidatedU16(-1, 'proposedLtvFloorBps'), /u16 range/i);
  assert.throws(() => toValidatedU16(65536, 'proposedLtvFloorBps'), /u16 range/i);
  assert.throws(() => toValidatedU16(2.25 as any, 'proposedLtvFloorBps'), /expected an integer/i);
  assert.throws(() => toValidatedU16(Number.NaN, 'proposedLtvFloorBps'), /expected an integer/i);
  assert.throws(() => toValidatedU16(Number.NEGATIVE_INFINITY, 'proposedLtvFloorBps'), /expected an integer/i);
});

function makeAddress(seed: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed, 0);
  return new PublicKey(bytes).toBase58();
}

test('validateContributionEscrowPairs rejects empty and duplicate entries', () => {
  assert.throws(
    () => validateContributionEscrowPairs([]),
    /at least one contribution\/escrow pair/i
  );

  const contribution = makeAddress(1);
  const escrow = makeAddress(2);
  assert.throws(
    () =>
      validateContributionEscrowPairs([
        { contributionAddress: contribution, escrowAddress: escrow },
        { contributionAddress: contribution, escrowAddress: makeAddress(3) },
      ]),
    /duplicate contribution or escrow account/i
  );
});

test('validateContributionEscrowPairs accepts unique contribution and escrow pairs', () => {
  const validated = validateContributionEscrowPairs([
    { contributionAddress: makeAddress(10), escrowAddress: makeAddress(11) },
    { contributionAddress: makeAddress(12), escrowAddress: makeAddress(13) },
  ]);
  assert.equal(validated.length, 2);
});
