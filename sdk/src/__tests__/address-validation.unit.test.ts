import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import type { StendarApiClient } from '../http-client';
import { LendingActions } from '../actions/lending';
import { TradingActions } from '../actions/trading';
import { CollateralQueries } from '../queries/collateral';
import { ContractsQueries } from '../queries/contracts';
import { validatePathSegment, validateSolanaAddress } from '../utils/validation';

function makeAddress(seed: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed, 0);
  return new PublicKey(bytes).toBase58();
}

test('validateSolanaAddress accepts valid base58 addresses', () => {
  const address = makeAddress(1);
  assert.equal(validateSolanaAddress(address, 'contractAddress'), address);
});

test('validateSolanaAddress rejects non-base58 and malformed input', () => {
  assert.throws(
    () => validateSolanaAddress('not-a-solana-address', 'contractAddress'),
    /base58-encoded 32-byte Solana address/i
  );
  assert.throws(() => validateSolanaAddress('' as any, 'contractAddress'), /cannot be empty/i);
});

test('validatePathSegment rejects absolute URLs and traversal delimiters', () => {
  assert.throws(() => validatePathSegment('https://attacker.com', 'segment'), /absolute URLs are not allowed/i);
  assert.throws(() => validatePathSegment('../admin', 'segment'), /path delimiter characters are not allowed/i);
  assert.throws(() => validatePathSegment('abc/def', 'segment'), /path delimiter characters are not allowed/i);
  assert.throws(() => validatePathSegment('' as any, 'segment'), /cannot be empty/i);
});

test('query classes reject malicious path inputs before issuing requests', () => {
  const calls: string[] = [];
  const api = {
    get: async <T>(path: string): Promise<T> => {
      calls.push(path);
      return {} as T;
    },
  } as unknown as StendarApiClient;

  const queries = new ContractsQueries(api);
  const collateralQueries = new CollateralQueries(api);
  assert.throws(
    () => queries.get('https://attacker.com/steal'),
    /absolute URLs are not allowed/i
  );
  assert.throws(() => queries.get('../traversal'), /path delimiter characters are not allowed|base58/i);
  assert.throws(
    () => collateralQueries.getPrice('../treasury'),
    /path delimiter characters are not allowed|base58/i
  );
  assert.equal(calls.length, 0);
});

test('lending and trading creation actions validate required address fields', async () => {
  const api = {
    post: async <T>(): Promise<T> => ({} as T),
  } as unknown as StendarApiClient;

  const lending = new LendingActions(api, 'api');
  const trading = new TradingActions(api);

  await assert.rejects(
    () =>
      lending.createContractTransaction({
        borrowerAddress: 'not-an-address',
        amount: 100,
        interestRate: 10,
        loanType: 'demand',
        ltv: 120,
        termValue: 30,
        termUnit: 'days',
        interestPaymentType: 'outstanding_balance',
        interestFrequency: 'monthly',
        principalPaymentType: 'no_fixed_payment',
      }),
    /base58-encoded 32-byte Solana address/i
  );

  await assert.rejects(
    () =>
      trading.createListingTransaction({
        sellerAddress: 'not-an-address',
        contributionAddress: makeAddress(55),
        askingPriceUsdc: 10,
        expirationDays: 1,
      }),
    /base58-encoded 32-byte Solana address/i
  );

  await assert.rejects(
    () =>
      trading.createOfferTransaction({
        buyerAddress: makeAddress(56),
        listingAddress: 'not-an-address',
        offeredPriceUsdc: 10,
        expirationDays: 1,
      }),
    /base58-encoded 32-byte Solana address/i
  );

  assert.throws(
    () => trading.cancelListingTransaction({
      listingAddress: makeAddress(57),
      sellerAddress: 'not-an-address',
    }),
    /base58-encoded 32-byte Solana address/i
  );

  await assert.rejects(
    () =>
      trading.acceptOfferTransaction({
        offerAddress: makeAddress(58),
        sellerAddress: makeAddress(59),
        listingAddress: 'not-an-address',
        nonce: 1,
      }),
    /base58-encoded 32-byte Solana address/i
  );
});
