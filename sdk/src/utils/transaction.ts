import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  SendOptions,
  SystemProgram,
  Transaction,
  TransactionSignature,
  VersionedTransaction,
} from '@solana/web3.js';
import type { AnchorWalletLike } from '../types';
import { resolveProgramId } from './pda';

export type DecodedTransaction = Transaction | VersionedTransaction;

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBase58();
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
).toBase58();
const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
  'ComputeBudget111111111111111111111111111111'
).toBase58();

function toProgramIdString(programId: string | PublicKey): string {
  if (typeof programId === 'string') {
    return new PublicKey(programId).toBase58();
  }
  return programId.toBase58();
}

function defaultAllowedProgramIds(): Set<string> {
  const stendarProgramId = resolveProgramId().toBase58();

  return new Set([
    stendarProgramId,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    COMPUTE_BUDGET_PROGRAM_ID,
    SystemProgram.programId.toBase58(),
  ]);
}

function extractProgramIds(transaction: DecodedTransaction): string[] {
  if (transaction instanceof VersionedTransaction) {
    const accountKeys = transaction.message.staticAccountKeys;
    return transaction.message.compiledInstructions.map((instruction) => {
      const programId = accountKeys[instruction.programIdIndex];
      return programId.toBase58();
    });
  }
  return transaction.instructions.map((instruction) => instruction.programId.toBase58());
}

function validateStendarInstructionShapes(transaction: DecodedTransaction, stendarProgramId: string): void {
  if (transaction instanceof VersionedTransaction) {
    const accountKeys = transaction.message.staticAccountKeys;
    for (const instruction of transaction.message.compiledInstructions) {
      const programId = accountKeys[instruction.programIdIndex]?.toBase58();
      if (programId === stendarProgramId && instruction.data.length < 8) {
        throw new Error('Invalid Stendar instruction payload: discriminator is missing');
      }
    }
    return;
  }
  for (const instruction of transaction.instructions) {
    if (instruction.programId.toBase58() === stendarProgramId && instruction.data.length < 8) {
      throw new Error('Invalid Stendar instruction payload: discriminator is missing');
    }
  }
}

export interface DecodeSerializedTransactionOptions {
  validateProgramIds?: boolean;
  allowedProgramIds?: ReadonlyArray<string | PublicKey>;
}

export function decodeSerializedTransaction(
  transactionBase64: string,
  options?: DecodeSerializedTransactionOptions
): DecodedTransaction {
  const rawBytes = Buffer.from(transactionBase64, 'base64');
  const decoded = (() => {
    try {
      return VersionedTransaction.deserialize(rawBytes);
    } catch {
      return Transaction.from(rawBytes);
    }
  })();
  const shouldValidateProgramIds = options?.validateProgramIds ?? true;
  if (shouldValidateProgramIds) {
    const allowedProgramIds = options?.allowedProgramIds
      ? new Set(options.allowedProgramIds.map((programId) => toProgramIdString(programId)))
      : defaultAllowedProgramIds();
    const stendarProgramId = resolveProgramId().toBase58();
    validateStendarInstructionShapes(decoded, stendarProgramId);
    for (const programId of extractProgramIds(decoded)) {
      if (!allowedProgramIds.has(programId)) {
        throw new Error(`Unexpected program ID in serialized transaction: ${programId}`);
      }
    }
  }

  return decoded;
}

function isKeypair(signer: AnchorWalletLike | Keypair): signer is Keypair {
  return signer instanceof Keypair;
}

async function signDecodedTransaction(
  transaction: DecodedTransaction,
  signer: AnchorWalletLike | Keypair
): Promise<DecodedTransaction> {
  if (isKeypair(signer)) {
    if (transaction instanceof VersionedTransaction) {
      transaction.sign([signer]);
      return transaction;
    }
    transaction.partialSign(signer);
    return transaction;
  }

  if (!signer.signTransaction) {
    throw new Error('Wallet signer does not implement signTransaction');
  }
  return signer.signTransaction(transaction);
}

export async function signSerializedTransaction(
  transactionBase64: string,
  signer: AnchorWalletLike | Keypair
): Promise<DecodedTransaction> {
  const decoded = decodeSerializedTransaction(transactionBase64);
  return signDecodedTransaction(decoded, signer);
}

export async function sendSignedTransaction(
  connection: Connection,
  transaction: DecodedTransaction,
  sendOptions?: SendOptions
): Promise<TransactionSignature> {
  const signature = await connection.sendRawTransaction(transaction.serialize(), sendOptions);
  return signature;
}

export async function confirmTransactionSignature(
  connection: Connection,
  signature: TransactionSignature,
  commitment: Commitment = 'confirmed',
  options?: {
    maxRetries?: number;
    retryBackoffMs?: number;
    blockhash?: string;
    lastValidBlockHeight?: number;
  }
): Promise<void> {
  const maxRetries = Math.max(0, options?.maxRetries ?? 3);
  const retryBackoffMs = Math.max(1, options?.retryBackoffMs ?? 250);
  const strategy = options?.blockhash && options.lastValidBlockHeight !== undefined
    ? {
        blockhash: options.blockhash,
        lastValidBlockHeight: options.lastValidBlockHeight,
      }
    : await connection.getLatestBlockhash(commitment);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: strategy.blockhash,
          lastValidBlockHeight: strategy.lastValidBlockHeight,
        },
        commitment
      );
      if (confirmation.value.err) {
        throw new Error(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      return;
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryBackoffMs * (2 ** attempt));
      });
    }
  }
}

export interface SignAndSendTransactionParams {
  connection: Connection;
  unsignedTransactionBase64: string;
  signer: AnchorWalletLike | Keypair;
  sendOptions?: SendOptions;
  commitment?: Commitment;
  confirmMaxRetries?: number;
  confirmRetryBackoffMs?: number;
}

export async function signAndSendTransaction({
  connection,
  unsignedTransactionBase64,
  signer,
  sendOptions,
  commitment = 'confirmed',
  confirmMaxRetries = 3,
  confirmRetryBackoffMs = 250,
}: SignAndSendTransactionParams): Promise<TransactionSignature> {
  const signedTransaction = await signSerializedTransaction(unsignedTransactionBase64, signer);
  const signature = await sendSignedTransaction(connection, signedTransaction, sendOptions);
  await confirmTransactionSignature(connection, signature, commitment, {
    maxRetries: confirmMaxRetries,
    retryBackoffMs: confirmRetryBackoffMs,
  });
  return signature;
}
