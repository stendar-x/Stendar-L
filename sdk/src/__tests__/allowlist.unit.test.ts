import assert from 'node:assert/strict';
import test from 'node:test';
import type { AccountInfo, Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { batchCheckApprovedFunders, isApprovedFunder } from '../utils/allowlist';
import { deriveApprovedFunderPda } from '../utils/pda';

const PROGRAM_ID = '278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE';

function makeAddress(seed: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed, 0);
  return new PublicKey(bytes).toBase58();
}

function checkKey(contractAddress: string, lenderAddress: string): string {
  return `${contractAddress}:${lenderAddress}`;
}

function withMockConnection(methods: Partial<Connection>): Connection {
  return methods as unknown as Connection;
}

function fundedAccount(): AccountInfo<Buffer> {
  return {
    executable: false,
    owner: new PublicKey(makeAddress(999_999)),
    lamports: 1,
    data: Buffer.from([1]),
    rentEpoch: 0,
  };
}

test('isApprovedFunder returns false when the account does not exist', async () => {
  const connection = withMockConnection({
    getAccountInfo: async () => null,
  });

  const approved = await isApprovedFunder(connection, makeAddress(1), makeAddress(2), PROGRAM_ID);
  assert.equal(approved, false);
});

test('isApprovedFunder derives the approved_funder PDA and returns true when account exists', async () => {
  const contractAddress = makeAddress(11);
  const lenderAddress = makeAddress(12);
  const expectedPda = deriveApprovedFunderPda(contractAddress, lenderAddress, PROGRAM_ID).toBase58();
  let requestedPda: string | null = null;

  const connection = withMockConnection({
    getAccountInfo: async (pubkey: PublicKey) => {
      requestedPda = pubkey.toBase58();
      return fundedAccount();
    },
  });

  const approved = await isApprovedFunder(connection, contractAddress, lenderAddress, PROGRAM_ID);
  assert.equal(approved, true);
  assert.equal(requestedPda, expectedPda);
});

test('isApprovedFunder treats zero-length account data as not approved', async () => {
  const connection = withMockConnection({
    getAccountInfo: async () =>
      ({
        ...fundedAccount(),
        data: Buffer.alloc(0),
      }) as AccountInfo<Buffer>,
  });

  const approved = await isApprovedFunder(connection, makeAddress(21), makeAddress(22), PROGRAM_ID);
  assert.equal(approved, false);
});

test('batchCheckApprovedFunders chunks RPC calls and returns per-check membership', async () => {
  const checks = Array.from({ length: 205 }, (_, index) => ({
    contractAddress: makeAddress(index + 100),
    lenderAddress: makeAddress(index + 10_000),
  }));
  const activeIndexes = new Set([0, 55, 99, 100, 150, 204]);
  const activePdas = new Set<string>();

  checks.forEach((check, index) => {
    if (activeIndexes.has(index)) {
      activePdas.add(deriveApprovedFunderPda(check.contractAddress, check.lenderAddress, PROGRAM_ID).toBase58());
    }
  });

  const chunkSizes: number[] = [];
  const connection = withMockConnection({
    getMultipleAccountsInfo: async (pubkeys: PublicKey[]) => {
      chunkSizes.push(pubkeys.length);
      return pubkeys.map((pubkey: PublicKey) => (activePdas.has(pubkey.toBase58()) ? fundedAccount() : null));
    },
  });

  const membership = await batchCheckApprovedFunders(connection, checks, PROGRAM_ID);

  assert.deepEqual(chunkSizes, [100, 100, 5]);
  assert.equal(membership.size, checks.length);
  checks.forEach((check, index) => {
    assert.equal(membership.get(checkKey(check.contractAddress, check.lenderAddress)), activeIndexes.has(index));
  });
});

test('batchCheckApprovedFunders returns an empty result and skips RPC for empty checks', async () => {
  let called = false;
  const connection = withMockConnection({
    getMultipleAccountsInfo: async () => {
      called = true;
      return [];
    },
  });

  const membership = await batchCheckApprovedFunders(connection, [], PROGRAM_ID);
  assert.equal(called, false);
  assert.equal(membership.size, 0);
});
