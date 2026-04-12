import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { confirmTransactionSignature, decodeSerializedTransaction } from '../utils/transaction';

const STENDAR_PROGRAM_ID = '278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE';
const PREVIOUS_PROGRAM_ID = process.env.STENDAR_PROGRAM_ID;

process.env.STENDAR_PROGRAM_ID = STENDAR_PROGRAM_ID;
test.after(() => {
  if (PREVIOUS_PROGRAM_ID === undefined) {
    delete process.env.STENDAR_PROGRAM_ID;
  } else {
    process.env.STENDAR_PROGRAM_ID = PREVIOUS_PROGRAM_ID;
  }
});

function serializeTransactionForTest(instruction: TransactionInstruction): string {
  const transaction = new Transaction();
  transaction.feePayer = Keypair.generate().publicKey;
  transaction.recentBlockhash = '11111111111111111111111111111111';
  transaction.add(instruction);
  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
}

test('decodeSerializedTransaction accepts allowed program IDs', () => {
  const stendarProgramId = new PublicKey(STENDAR_PROGRAM_ID);
  const base64 = serializeTransactionForTest(
    new TransactionInstruction({
      keys: [],
      programId: stendarProgramId,
      data: Buffer.alloc(8),
    })
  );

  const decoded = decodeSerializedTransaction(base64);
  assert.ok(decoded);
});

test('decodeSerializedTransaction supports VersionedTransaction payloads', () => {
  const payer = Keypair.generate().publicKey;
  const instruction = new TransactionInstruction({
    keys: [],
    programId: new PublicKey(STENDAR_PROGRAM_ID),
    data: Buffer.alloc(8),
  });
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [instruction],
  }).compileToV0Message();
  const versioned = new VersionedTransaction(message);
  const base64 = Buffer.from(versioned.serialize()).toString('base64');

  const decoded = decodeSerializedTransaction(base64);
  assert.ok(decoded instanceof VersionedTransaction);
});

test('decodeSerializedTransaction rejects unexpected program IDs', () => {
  const unexpectedProgramId = new PublicKey(new Uint8Array(32).fill(7));
  const base64 = serializeTransactionForTest(
    new TransactionInstruction({
      keys: [],
      programId: unexpectedProgramId,
      data: Buffer.alloc(8),
    })
  );

  assert.throws(
    () => decodeSerializedTransaction(base64),
    /Unexpected program ID in serialized transaction/i
  );
});

test('decodeSerializedTransaction rejects malformed Stendar instruction payloads', () => {
  const stendarProgramId = new PublicKey(STENDAR_PROGRAM_ID);
  const base64 = serializeTransactionForTest(
    new TransactionInstruction({
      keys: [],
      programId: stendarProgramId,
      data: Buffer.alloc(4),
    })
  );

  assert.throws(
    () => decodeSerializedTransaction(base64),
    /discriminator is missing/i
  );
});

test('decodeSerializedTransaction requires configured program ID resolution', () => {
  const stendarProgramId = new PublicKey(STENDAR_PROGRAM_ID);
  const base64 = serializeTransactionForTest(
    new TransactionInstruction({
      keys: [],
      programId: stendarProgramId,
      data: Buffer.alloc(8),
    })
  );
  const previous = process.env.STENDAR_PROGRAM_ID;
  delete process.env.STENDAR_PROGRAM_ID;

  try {
    assert.throws(
      () => decodeSerializedTransaction(base64),
      /programId is required/i
    );
  } finally {
    if (previous === undefined) {
      delete process.env.STENDAR_PROGRAM_ID;
    } else {
      process.env.STENDAR_PROGRAM_ID = previous;
    }
  }
});

test('confirmTransactionSignature retries transient RPC errors', async () => {
  let attempts = 0;
  const connection = {
    getLatestBlockhash: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 123,
    }),
    confirmTransaction: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('transient rpc failure');
      }
      return {
        context: { slot: 1 },
        value: { err: null },
      };
    },
  } as any;

  await confirmTransactionSignature(connection, '1111111111111111111111111111111111111111111111111111111111111111', 'confirmed', {
    maxRetries: 2,
    retryBackoffMs: 1,
  });
  assert.equal(attempts, 3);
});
