import assert from 'node:assert/strict';
import test from 'node:test';
import type { Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { stendarIdl } from '../idl';
import { StendarProgramClient } from '../program';
import { deriveGlobalStatePda, deriveTreasuryPda } from '../utils/pda';

const PROGRAM_ID = '278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

type IdlAccountMeta = {
  name: string;
  signer?: boolean;
  writable?: boolean;
  optional?: boolean;
  address?: string;
};

type IdlInstructionMeta = {
  name: string;
  discriminator: number[];
  accounts?: IdlAccountMeta[];
  args?: Array<{ name: string; type: unknown }>;
};

function getInstruction(name: string): IdlInstructionMeta {
  const instruction = (stendarIdl.instructions as IdlInstructionMeta[]).find((candidate) => candidate.name === name);
  assert.ok(instruction, `${name} must exist in IDL`);
  return instruction;
}

function getAccount(instruction: IdlInstructionMeta, name: string): IdlAccountMeta {
  const account = (instruction.accounts ?? []).find((candidate) => candidate.name === name);
  assert.ok(account, `${instruction.name} must include ${name} account`);
  return account;
}

function makeAddress(seed: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed, 0);
  return new PublicKey(bytes).toBase58();
}

function createClient(): StendarProgramClient {
  const connection = new Connection('http://127.0.0.1:8899', 'processed');
  const wallet = { publicKey: Keypair.generate().publicKey };
  return new StendarProgramClient({
    connection,
    wallet,
    idl: stendarIdl as Idl,
    programId: PROGRAM_ID,
  });
}

test('setYieldPreference builder encodes expected accounts and arg', async () => {
  const client = createClient();
  const request = {
    depositorAddress: makeAddress(1),
    poolAddress: makeAddress(2),
    poolDepositAddress: makeAddress(3),
    preference: 1,
  };

  const instruction = await client.setYieldPreference(request);
  const instructionMeta = getInstruction('set_yield_preference');

  assert.equal(instruction.programId.toBase58(), PROGRAM_ID);
  assert.deepEqual(
    instruction.keys.map((entry) => entry.pubkey.toBase58()),
    [request.depositorAddress, request.poolAddress, request.poolDepositAddress]
  );
  assert.equal(instruction.keys[0]?.isSigner, true);
  assert.equal(instruction.keys[1]?.isWritable, false);
  assert.equal(instruction.keys[2]?.isWritable, true);
  assert.deepEqual(Array.from(instruction.data.subarray(0, 8)), instructionMeta.discriminator);
  assert.equal(instruction.data.length, 9);
  assert.equal(instruction.data[8], 1);
});

test('setYieldPreference rejects invalid preference values before instruction build', async () => {
  const client = createClient();
  const request = {
    depositorAddress: makeAddress(4),
    poolAddress: makeAddress(5),
    poolDepositAddress: makeAddress(6),
    preference: 2,
  };

  await assert.rejects(() => client.setYieldPreference(request), /Invalid yieldPreference/);
  await assert.rejects(() => client.setYieldPreference({ ...request, preference: 1.5 }), /Invalid yieldPreference/);
});

test('set_yield_preference IDL metadata matches SDK builder expectations', () => {
  const instruction = getInstruction('set_yield_preference');

  const accountNames = (instruction.accounts ?? []).map((account) => account.name);
  assert.deepEqual(accountNames, ['depositor', 'pool', 'pool_deposit']);

  const args = instruction.args ?? [];
  assert.equal(args.length, 1);
  assert.equal(args[0]?.name, 'preference');
  assert.equal(args[0]?.type, 'u8');

  assert.equal(getAccount(instruction, 'depositor').signer, true);
  assert.equal(getAccount(instruction, 'pool_deposit').writable, true);
});

test('compoundPoolYield builder derives PDAs and encodes expected accounts', async () => {
  const client = createClient();
  const request = {
    callerAddress: makeAddress(11),
    poolAddress: makeAddress(12),
    poolDepositAddress: makeAddress(13),
    depositorAddress: makeAddress(14),
    poolVaultAddress: makeAddress(15),
    treasuryUsdcAccount: makeAddress(16),
    frontendUsdcAta: makeAddress(17),
  };

  const instruction = await client.compoundPoolYield(request);
  const instructionMeta = getInstruction('compound_pool_yield');
  const expectedState = deriveGlobalStatePda(PROGRAM_ID).toBase58();
  const expectedTreasury = deriveTreasuryPda(PROGRAM_ID).toBase58();

  assert.deepEqual(
    instruction.keys.map((entry) => entry.pubkey.toBase58()),
    [
      request.callerAddress,
      expectedState,
      expectedTreasury,
      request.poolAddress,
      request.poolDepositAddress,
      request.depositorAddress,
      request.poolVaultAddress,
      request.treasuryUsdcAccount,
      request.frontendUsdcAta,
      TOKEN_PROGRAM_ID,
    ]
  );
  assert.equal(instruction.keys[0]?.isSigner, true);
  assert.equal(instruction.keys[2]?.isWritable, true);
  assert.equal(instruction.keys[8]?.isWritable, true);
  assert.equal(instruction.keys[9]?.isWritable, false);
  assert.deepEqual(Array.from(instruction.data.subarray(0, 8)), instructionMeta.discriminator);
  assert.equal(instruction.data.length, 8);
});

test('compoundPoolYield honors explicit state and treasury overrides', async () => {
  const client = createClient();
  const request = {
    callerAddress: makeAddress(21),
    poolAddress: makeAddress(22),
    poolDepositAddress: makeAddress(23),
    depositorAddress: makeAddress(24),
    poolVaultAddress: makeAddress(25),
    treasuryUsdcAccount: makeAddress(26),
    stateAddress: makeAddress(27),
    treasuryAddress: makeAddress(28),
  };

  const instruction = await client.compoundPoolYield(request);
  assert.equal(instruction.keys[1]?.pubkey.toBase58(), request.stateAddress);
  assert.equal(instruction.keys[2]?.pubkey.toBase58(), request.treasuryAddress);
});

test('compound_pool_yield IDL metadata matches SDK builder expectations', () => {
  const instruction = getInstruction('compound_pool_yield');

  const accountNames = (instruction.accounts ?? []).map((account) => account.name);
  assert.deepEqual(accountNames, [
    'caller',
    'state',
    'treasury',
    'pool',
    'pool_deposit',
    'depositor',
    'pool_vault',
    'treasury_usdc_account',
    'frontend_usdc_ata',
    'token_program',
  ]);

  assert.equal((instruction.args ?? []).length, 0);
  assert.equal(getAccount(instruction, 'caller').signer, true);
  assert.equal(getAccount(instruction, 'frontend_usdc_ata').optional, true);
  assert.equal(
    getAccount(instruction, 'token_program').address,
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  );
});

test('botClaimPoolYield builder derives PDAs and encodes expected accounts', async () => {
  const client = createClient();
  const request = {
    botAuthorityAddress: makeAddress(31),
    poolAddress: makeAddress(32),
    poolDepositAddress: makeAddress(33),
    depositorAddress: makeAddress(34),
    poolVaultAddress: makeAddress(35),
    depositorUsdcAta: makeAddress(36),
    treasuryUsdcAccount: makeAddress(37),
    frontendUsdcAta: makeAddress(38),
  };

  const instruction = await client.botClaimPoolYield(request);
  const instructionMeta = getInstruction('bot_claim_pool_yield');
  const expectedState = deriveGlobalStatePda(PROGRAM_ID).toBase58();
  const expectedTreasury = deriveTreasuryPda(PROGRAM_ID).toBase58();

  assert.deepEqual(
    instruction.keys.map((entry) => entry.pubkey.toBase58()),
    [
      request.botAuthorityAddress,
      expectedState,
      expectedTreasury,
      request.poolAddress,
      request.poolDepositAddress,
      request.depositorAddress,
      request.poolVaultAddress,
      request.depositorUsdcAta,
      request.treasuryUsdcAccount,
      request.frontendUsdcAta,
      TOKEN_PROGRAM_ID,
    ]
  );
  assert.equal(instruction.keys[0]?.isSigner, true);
  assert.equal(instruction.keys[7]?.isWritable, true);
  assert.equal(instruction.keys[9]?.isWritable, true);
  assert.deepEqual(Array.from(instruction.data.subarray(0, 8)), instructionMeta.discriminator);
  assert.equal(instruction.data.length, 8);
});

test('bot_claim_pool_yield IDL metadata matches SDK builder expectations', () => {
  const instruction = getInstruction('bot_claim_pool_yield');

  const accountNames = (instruction.accounts ?? []).map((account) => account.name);
  assert.deepEqual(accountNames, [
    'bot_authority',
    'state',
    'treasury',
    'pool',
    'pool_deposit',
    'depositor',
    'pool_vault',
    'depositor_usdc_ata',
    'treasury_usdc_account',
    'frontend_usdc_ata',
    'token_program',
  ]);

  assert.equal((instruction.args ?? []).length, 0);
  assert.equal(getAccount(instruction, 'bot_authority').signer, true);
  assert.equal(getAccount(instruction, 'depositor_usdc_ata').writable, true);
  assert.equal(getAccount(instruction, 'frontend_usdc_ata').optional, true);
});
