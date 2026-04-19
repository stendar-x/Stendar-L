import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { stendarIdl } from '../idl';
import {
  deriveContractPda,
  deriveFrontendOperatorPda,
  deriveListingPda,
  derivePoolOperatorPda,
  derivePendingPoolChangePda,
  deriveTreasuryPda,
  findAvailableTradeNonce,
} from '../utils/pda';

const PROGRAM_ID = '278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE';
const DEBT_CONTRACT_SEED_BYTES = [100, 101, 98, 116, 95, 99, 111, 110, 116, 114, 97, 99, 116];

function makeAddress(seed: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed, 0);
  return new PublicKey(bytes).toBase58();
}

function toU64LeBuffer(value: string | number | bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

test('deriveContractPda matches on-chain debt_contract seed', () => {
  const borrowerAddress = makeAddress(42);
  const borrower = new PublicKey(borrowerAddress);
  const contractSeed = 123n;
  const programId = new PublicKey(PROGRAM_ID);

  const [expectedPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('debt_contract'), borrower.toBuffer(), toU64LeBuffer(contractSeed)],
    programId
  );

  const actualPda = deriveContractPda(borrowerAddress, contractSeed, PROGRAM_ID);
  assert.equal(actualPda.toBase58(), expectedPda.toBase58());
});

test('IDL create_debt_contract PDA seed bytes encode debt_contract', () => {
  const createDebtContractIx = stendarIdl.instructions.find((ix) => ix.name === 'create_debt_contract');
  assert.ok(createDebtContractIx, 'create_debt_contract must exist in IDL');

  const contractAccount = (createDebtContractIx as any).accounts?.find((account: any) => account.name === 'contract');
  assert.ok(contractAccount, 'contract account metadata must exist');

  const idlSeedBytes = contractAccount.pda?.seeds?.[0]?.value;
  assert.deepEqual(idlSeedBytes, DEBT_CONTRACT_SEED_BYTES);
  assert.equal(Buffer.from(idlSeedBytes).toString('utf8'), 'debt_contract');
});

test('deriveTreasuryPda matches on-chain treasury seed', () => {
  const programId = new PublicKey(PROGRAM_ID);
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from('treasury')], programId);
  const actual = deriveTreasuryPda(PROGRAM_ID);
  assert.equal(actual.toBase58(), expected.toBase58());
});

test('derivePendingPoolChangePda matches on-chain pending_pool_change seed', () => {
  const programId = new PublicKey(PROGRAM_ID);
  const pool = new PublicKey(makeAddress(2026));

  const [expectedPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pending_pool_change'), pool.toBuffer()],
    programId
  );

  const [actualPda] = derivePendingPoolChangePda(pool, PROGRAM_ID);
  assert.equal(actualPda.toBase58(), expectedPda.toBase58());
});

test('derivePoolOperatorPda matches on-chain pool_operator seed', () => {
  const programId = new PublicKey(PROGRAM_ID);
  const operator = new PublicKey(makeAddress(404));

  const [expectedPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_operator'), operator.toBuffer()],
    programId
  );

  const [actualPda] = derivePoolOperatorPda(operator, PROGRAM_ID);
  assert.equal(actualPda.toBase58(), expectedPda.toBase58());
});

test('deriveFrontendOperatorPda is deterministic for the same operator', () => {
  const operator = new PublicKey(makeAddress(505));
  const [firstPda] = deriveFrontendOperatorPda(operator, PROGRAM_ID);
  const [secondPda] = deriveFrontendOperatorPda(operator, PROGRAM_ID);
  assert.equal(firstPda.toBase58(), secondPda.toBase58());
});

test('deriveFrontendOperatorPda differs across operators', () => {
  const operatorOne = new PublicKey(makeAddress(506));
  const operatorTwo = new PublicKey(makeAddress(507));
  const [operatorOnePda] = deriveFrontendOperatorPda(operatorOne, PROGRAM_ID);
  const [operatorTwoPda] = deriveFrontendOperatorPda(operatorTwo, PROGRAM_ID);
  assert.notEqual(operatorOnePda.toBase58(), operatorTwoPda.toBase58());
});

test('findAvailableTradeNonce scans 0..255 and returns first unused nonce', async () => {
  const contributionAddress = makeAddress(99);
  const [occupiedNonce0] = deriveListingPda(contributionAddress, PublicKey.default, 0, PROGRAM_ID);
  const [occupiedNonce1] = deriveListingPda(contributionAddress, PublicKey.default, 1, PROGRAM_ID);
  const [firstAvailable] = deriveListingPda(contributionAddress, PublicKey.default, 2, PROGRAM_ID);

  const connection = {
    getMultipleAccountsInfo: async (pubkeys: PublicKey[]) => {
      return pubkeys.map((pubkey) => {
        const key = pubkey.toBase58();
        if (key === occupiedNonce0.toBase58() || key === occupiedNonce1.toBase58()) {
          return { data: Buffer.alloc(1) } as any;
        }
        if (key === firstAvailable.toBase58()) {
          return null;
        }
        return null;
      });
    },
  } as any;

  const nonce = await findAvailableTradeNonce(connection, contributionAddress, PROGRAM_ID);
  assert.equal(nonce, 2);
});

test('findAvailableTradeNonce uses batched account lookups', async () => {
  const contributionAddress = makeAddress(199);
  const occupied = new Set<string>();
  for (let nonce = 0; nonce < 100; nonce += 1) {
    const [listingPda] = deriveListingPda(contributionAddress, PublicKey.default, nonce, PROGRAM_ID);
    occupied.add(listingPda.toBase58());
  }

  const batchSizes: number[] = [];
  const connection = {
    getMultipleAccountsInfo: async (pubkeys: PublicKey[]) => {
      batchSizes.push(pubkeys.length);
      return pubkeys.map((pubkey) => (occupied.has(pubkey.toBase58()) ? ({ data: Buffer.alloc(1) } as any) : null));
    },
  } as any;

  const nonce = await findAvailableTradeNonce(connection, contributionAddress, PROGRAM_ID);
  assert.equal(nonce, 100);
  assert.deepEqual(batchSizes, [100, 100]);
});
