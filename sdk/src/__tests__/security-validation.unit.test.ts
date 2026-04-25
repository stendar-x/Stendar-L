import assert from 'node:assert/strict';
import test from 'node:test';
import type { Idl } from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { stendarIdl } from '../idl';
import { safeReadEnv } from '../utils/env';
import { validateIdlIntegrity, validateTransactionBuildResponse } from '../utils/validation';

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

function cloneIdl(): Idl {
  return JSON.parse(JSON.stringify(stendarIdl)) as Idl;
}

function buildUnsignedTransactionBase64(programId: PublicKey = SystemProgram.programId): string {
  const transaction = new Transaction();
  transaction.feePayer = Keypair.generate().publicKey;
  transaction.recentBlockhash = '11111111111111111111111111111111';
  transaction.add(
    new TransactionInstruction({
      keys: [],
      programId,
      data: Buffer.alloc(1),
    })
  );
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

test('validateIdlIntegrity accepts canonical discriminator mapping', () => {
  const supplied = cloneIdl();
  assert.doesNotThrow(() => validateIdlIntegrity(supplied, stendarIdl));
});

test('validateIdlIntegrity rejects mismatched instruction discriminators', () => {
  const supplied = cloneIdl() as any;
  supplied.instructions[0].discriminator[0] = (supplied.instructions[0].discriminator[0] + 1) % 256;
  assert.throws(
    () => validateIdlIntegrity(supplied, stendarIdl),
    /discriminator mismatch/i
  );
});

test('validateIdlIntegrity rejects mismatched account discriminators', () => {
  const supplied = cloneIdl() as any;
  const accountWithDiscriminator = supplied.accounts.find((account: any) => Array.isArray(account.discriminator));
  assert.ok(accountWithDiscriminator, 'expected at least one account discriminator in IDL');
  accountWithDiscriminator.discriminator[0] = (accountWithDiscriminator.discriminator[0] + 1) % 256;

  assert.throws(
    () => validateIdlIntegrity(supplied, stendarIdl),
    /discriminator mismatch/i
  );
});

test('validateIdlIntegrity rejects mismatched instruction layouts', () => {
  const supplied = cloneIdl() as any;
  const instructionWithArgs = supplied.instructions.find(
    (instruction: any) => Array.isArray(instruction.args) && instruction.args.length > 0
  );
  assert.ok(instructionWithArgs, 'expected at least one instruction with args in IDL');

  instructionWithArgs.args[0].name = `${instructionWithArgs.args[0].name}_tampered`;

  assert.throws(
    () => validateIdlIntegrity(supplied, stendarIdl),
    /layout mismatch/i
  );
});

test('validateIdlIntegrity rejects mismatched account type layouts', () => {
  const supplied = cloneIdl() as any;
  const typeWithFields = supplied.types.find(
    (typeEntry: any) =>
      typeEntry?.type?.kind === 'struct'
      && Array.isArray(typeEntry.type.fields)
      && typeEntry.type.fields.length > 0
  );
  assert.ok(typeWithFields, 'expected at least one struct type layout in IDL');

  typeWithFields.type.fields[0].name = `${typeWithFields.type.fields[0].name}_tampered`;

  assert.throws(
    () => validateIdlIntegrity(supplied, stendarIdl),
    /layout mismatch/i
  );
});

test('validateIdlIntegrity rejects unexpected instructions in supplied IDL', () => {
  const supplied = cloneIdl() as any;
  const instructionClone = JSON.parse(JSON.stringify(supplied.instructions[0]));
  instructionClone.name = `${instructionClone.name}_unexpected`;
  instructionClone.discriminator = instructionClone.discriminator.map((value: number, idx: number) => (
    idx === 0 ? (value + 1) % 256 : value
  ));
  supplied.instructions.push(instructionClone);

  assert.throws(
    () => validateIdlIntegrity(supplied, stendarIdl),
    /unexpected instruction/i
  );
});

test('validateIdlIntegrity rejects unexpected types in supplied IDL', () => {
  const supplied = cloneIdl() as any;
  const typeClone = JSON.parse(JSON.stringify(supplied.types[0]));
  typeClone.name = `${typeClone.name}_unexpected`;
  supplied.types.push(typeClone);

  assert.throws(
    () => validateIdlIntegrity(supplied, stendarIdl),
    /unexpected type/i
  );
});

test('validateTransactionBuildResponse validates and decodes unsignedTransaction', () => {
  const response = validateTransactionBuildResponse({
    unsignedTransaction: buildUnsignedTransactionBase64(),
    requiredSigners: [],
    estimatedFee: 0,
    status: 'built',
    instructions: [],
  });
  assert.equal(typeof response.unsignedTransaction, 'string');
  assert.ok(response.unsignedTransaction.length > 0);
});

test('validateTransactionBuildResponse rejects unsignedTransaction payloads with unexpected program IDs', () => {
  assert.throws(
    () => validateTransactionBuildResponse({ unsignedTransaction: buildUnsignedTransactionBase64(new PublicKey(new Uint8Array(32).fill(2))) }),
    /Unexpected program ID/i
  );
});

test('validateTransactionBuildResponse rejects invalid unsignedTransaction payloads', () => {
  assert.throws(
    () => validateTransactionBuildResponse({ unsignedTransaction: '' }),
    /non-empty string/i
  );
  assert.throws(
    () => validateTransactionBuildResponse({ unsignedTransaction: 'not-base64' }),
    /failed to decode/i
  );
});

test('safeReadEnv returns undefined when process is unavailable', () => {
  const processDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
  if (!processDescriptor || processDescriptor.configurable !== true) {
    assert.doesNotThrow(() => safeReadEnv('NODE_ENV'));
    return;
  }

  Object.defineProperty(globalThis, 'process', {
    value: undefined,
    writable: true,
    configurable: true,
  });

  try {
    assert.equal(safeReadEnv('NODE_ENV'), undefined);
  } finally {
    Object.defineProperty(globalThis, 'process', processDescriptor);
  }
});
