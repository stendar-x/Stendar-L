import {
  Commitment,
  Connection,
  Keypair,
  SendOptions,
  Transaction,
  TransactionSignature,
  VersionedTransaction,
} from '@solana/web3.js';
import type { AnchorWalletLike } from '../types';

export type DecodedTransaction = Transaction | VersionedTransaction;

export function decodeSerializedTransaction(transactionBase64: string): DecodedTransaction {
  const rawBytes = Buffer.from(transactionBase64, 'base64');
  try {
    return VersionedTransaction.deserialize(rawBytes);
  } catch {
    return Transaction.from(rawBytes);
  }
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
  commitment: Commitment = 'confirmed'
): Promise<void> {
  const confirmation = await connection.confirmTransaction(signature, commitment);
  if (confirmation.value.err) {
    throw new Error(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
  }
}

export interface SignAndSendTransactionParams {
  connection: Connection;
  unsignedTransactionBase64: string;
  signer: AnchorWalletLike | Keypair;
  sendOptions?: SendOptions;
  commitment?: Commitment;
}

export async function signAndSendTransaction({
  connection,
  unsignedTransactionBase64,
  signer,
  sendOptions,
  commitment = 'confirmed',
}: SignAndSendTransactionParams): Promise<TransactionSignature> {
  const signedTransaction = await signSerializedTransaction(unsignedTransactionBase64, signer);
  const signature = await sendSignedTransaction(connection, signedTransaction, sendOptions);
  await confirmTransactionSignature(connection, signature, commitment);
  return signature;
}
