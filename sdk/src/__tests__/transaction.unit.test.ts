import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AddressLookupTableAccount,
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { confirmTransactionSignature, decodeSerializedTransaction, signAndSendTransaction } from '../utils/transaction';
import { useScopedEnv, withEnv } from './env-test-utils';

const STENDAR_PROGRAM_ID = '278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE';
useScopedEnv('STENDAR_PROGRAM_ID', STENDAR_PROGRAM_ID);

function serializeTransactionForTest(instruction: TransactionInstruction): string {
  const transaction = new Transaction();
  transaction.feePayer = Keypair.generate().publicKey;
  transaction.recentBlockhash = '11111111111111111111111111111111';
  transaction.add(instruction);
  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
}

function buildLookupTableTransaction(programId: PublicKey = SystemProgram.programId): {
  base64: string;
  lookupTableAccount: AddressLookupTableAccount;
} {
  const lookedUpAccount = Keypair.generate().publicKey;
  const lookupTableAccount = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: 18_446_744_073_709_551_615n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [lookedUpAccount],
    },
  });
  const message = new TransactionMessage({
    payerKey: Keypair.generate().publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [
      new TransactionInstruction({
        keys: [
          {
            pubkey: lookedUpAccount,
            isSigner: false,
            isWritable: false,
          },
        ],
        programId,
        data: Buffer.alloc(8),
      }),
    ],
  }).compileToV0Message([lookupTableAccount]);
  assert.ok(message.addressTableLookups.length > 0, 'test transaction must use a lookup table');
  const versioned = new VersionedTransaction(message);
  return {
    base64: Buffer.from(versioned.serialize()).toString('base64'),
    lookupTableAccount,
  };
}

function buildLookupTableProgramTransaction(programId: PublicKey): {
  base64: string;
  lookupTableAccount: AddressLookupTableAccount;
} {
  const payer = Keypair.generate().publicKey;
  const lookupTableAccount = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: 18_446_744_073_709_551_615n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [programId],
    },
  });
  const message = new MessageV0({
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 0,
    },
    staticAccountKeys: [payer],
    recentBlockhash: '11111111111111111111111111111111',
    compiledInstructions: [
      {
        programIdIndex: 1,
        accountKeyIndexes: [],
        data: Buffer.alloc(8),
      },
    ],
    addressTableLookups: [
      {
        accountKey: lookupTableAccount.key,
        writableIndexes: [],
        readonlyIndexes: [0],
      },
    ],
  });
  assert.ok(message.addressTableLookups.length > 0, 'test transaction program id must use a lookup table');
  const versioned = new VersionedTransaction(message);
  return {
    base64: Buffer.from(versioned.serialize()).toString('base64'),
    lookupTableAccount,
  };
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

test('decodeSerializedTransaction rejects address lookup table transactions without lookup accounts', () => {
  const { base64 } = buildLookupTableTransaction();

  assert.throws(
    () => decodeSerializedTransaction(base64),
    /Address lookup table accounts are required/i
  );
});

test('decodeSerializedTransaction validates address lookup table program IDs when accounts are supplied', () => {
  const { base64, lookupTableAccount } = buildLookupTableTransaction();

  const decoded = decodeSerializedTransaction(base64, {
    allowedProgramIds: [SystemProgram.programId],
    addressLookupTableAccounts: [lookupTableAccount],
  });
  assert.ok(decoded instanceof VersionedTransaction);
});

test('decodeSerializedTransaction rejects unexpected address lookup table program IDs', () => {
  const unexpectedProgramId = new PublicKey(new Uint8Array(32).fill(9));
  const { base64, lookupTableAccount } = buildLookupTableProgramTransaction(unexpectedProgramId);

  assert.throws(
    () =>
      decodeSerializedTransaction(base64, {
        addressLookupTableAccounts: [lookupTableAccount],
      }),
    /Unexpected program ID in serialized transaction/i
  );
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

test('decodeSerializedTransaction falls back to bundled IDL program ID when env is missing', () => {
  const stendarProgramId = new PublicKey(STENDAR_PROGRAM_ID);
  const base64 = serializeTransactionForTest(
    new TransactionInstruction({
      keys: [],
      programId: stendarProgramId,
      data: Buffer.alloc(8),
    })
  );
  withEnv('STENDAR_PROGRAM_ID', undefined, () => {
    const decoded = decodeSerializedTransaction(base64);
    assert.ok(decoded);
  });
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

test('signAndSendTransaction confirms using transaction blockhash and provided lastValidBlockHeight', async () => {
  const signature = '1111111111111111111111111111111111111111111111111111111111111111';
  const unsignedTransactionBase64 = serializeTransactionForTest(
    new TransactionInstruction({
      keys: [],
      programId: SystemProgram.programId,
      data: Buffer.alloc(0),
    })
  );
  let getLatestBlockhashCalls = 0;
  let confirmedBlockhash: string | undefined;
  let confirmedLastValidBlockHeight: number | undefined;

  const connection = {
    sendRawTransaction: async () => signature,
    getLatestBlockhash: async () => {
      getLatestBlockhashCalls += 1;
      return {
        blockhash: '22222222222222222222222222222222',
        lastValidBlockHeight: 555,
      };
    },
    confirmTransaction: async (strategy: { blockhash: string; lastValidBlockHeight: number }) => {
      confirmedBlockhash = strategy.blockhash;
      confirmedLastValidBlockHeight = strategy.lastValidBlockHeight;
      return {
        context: { slot: 1 },
        value: { err: null },
      };
    },
  } as any;

  const result = await signAndSendTransaction({
    connection,
    unsignedTransactionBase64,
    signer: {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async (transaction) => transaction,
    },
    commitment: 'confirmed',
    lastValidBlockHeight: 777,
    confirmRetryBackoffMs: 1,
  });

  assert.equal(result, signature);
  assert.equal(getLatestBlockhashCalls, 0);
  assert.equal(confirmedBlockhash, '11111111111111111111111111111111');
  assert.equal(confirmedLastValidBlockHeight, 777);
});

test('signAndSendTransaction fetches lastValidBlockHeight when caller does not provide one', async () => {
  const signature = '1111111111111111111111111111111111111111111111111111111111111111';
  const unsignedTransactionBase64 = serializeTransactionForTest(
    new TransactionInstruction({
      keys: [],
      programId: SystemProgram.programId,
      data: Buffer.alloc(0),
    })
  );
  let getLatestBlockhashCalls = 0;
  let signatureOnlyConfirmationArg: string | undefined;

  const connection = {
    sendRawTransaction: async () => signature,
    getLatestBlockhash: async () => {
      getLatestBlockhashCalls += 1;
      return {
        blockhash: '33333333333333333333333333333333',
        lastValidBlockHeight: 456,
      };
    },
    confirmTransaction: async (strategy: string) => {
      signatureOnlyConfirmationArg = strategy;
      return {
        context: { slot: 1 },
        value: { err: null },
      };
    },
  } as any;

  const result = await signAndSendTransaction({
    connection,
    unsignedTransactionBase64,
    signer: {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async (transaction) => transaction,
    },
    commitment: 'confirmed',
    confirmRetryBackoffMs: 1,
  });

  assert.equal(result, signature);
  assert.equal(getLatestBlockhashCalls, 0);
  assert.equal(signatureOnlyConfirmationArg, signature);
});
