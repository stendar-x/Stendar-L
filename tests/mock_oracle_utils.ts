import { Connection, Keypair, PublicKey } from "@solana/web3.js";

export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
);

const ACCOUNT_DISCRIMINATOR_LEN = 8;
const WRITE_AUTHORITY_LEN = 32;
const FEED_ID_LEN = 32;

export type MockOracleVerification = "full" | "partial";

export interface MockOraclePriceConfig {
  price: bigint | number;
  exponent: number;
  publishTime: number;
  verification?: MockOracleVerification;
  numSignatures?: number;
  feedId?: Uint8Array;
}

interface SetAccountRpcResult {
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

function asBigInt(value: bigint | number): bigint {
  return typeof value === "bigint" ? value : BigInt(Math.trunc(value));
}

function assertInt32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new Error(`${label} must fit in int32`);
  }
}

function assertInt64(value: bigint, label: string): void {
  const min = -(1n << 63n);
  const max = (1n << 63n) - 1n;
  if (value < min || value > max) {
    throw new Error(`${label} must fit in int64`);
  }
}

function assertUint8(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${label} must fit in u8`);
  }
}

function writeI64(target: Buffer, value: bigint): void {
  const temp = Buffer.alloc(8);
  temp.writeBigInt64LE(value, 0);
  temp.copy(target);
}

function writeI32(target: Buffer, value: number): void {
  const temp = Buffer.alloc(4);
  temp.writeInt32LE(value, 0);
  temp.copy(target);
}

function writeU64(target: Buffer, value: bigint): void {
  const temp = Buffer.alloc(8);
  temp.writeBigUInt64LE(value, 0);
  temp.copy(target);
}

function normalizedFeedId(feedId?: Uint8Array): Buffer {
  if (!feedId) {
    return Buffer.alloc(FEED_ID_LEN);
  }
  if (feedId.length !== FEED_ID_LEN) {
    throw new Error(`feedId must be exactly ${FEED_ID_LEN} bytes`);
  }
  return Buffer.from(feedId);
}

/**
 * Builds a mock Pyth receiver account payload that matches the subset parsed by
 * the on-chain oracle reader in `utils/oracle.rs`.
 */
export function buildMockPythPriceAccountData(config: MockOraclePriceConfig): Buffer {
  const verification = config.verification ?? "full";
  const price = asBigInt(config.price);
  const publishTime = BigInt(Math.trunc(config.publishTime));

  assertInt64(price, "price");
  assertInt32(config.exponent, "exponent");
  assertInt64(publishTime, "publishTime");
  if (verification === "partial") {
    assertUint8(config.numSignatures ?? 1, "numSignatures");
  }

  const prefixLen =
    ACCOUNT_DISCRIMINATOR_LEN +
    WRITE_AUTHORITY_LEN +
    1 + // verification variant
    (verification === "partial" ? 1 : 0) +
    FEED_ID_LEN;
  // Parse-critical fields + extra trailing fields commonly present in Pyth payloads.
  const trailingLen = 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8;
  const data = Buffer.alloc(prefixLen + trailingLen);
  let cursor = 0;

  cursor += ACCOUNT_DISCRIMINATOR_LEN;
  cursor += WRITE_AUTHORITY_LEN;
  data.writeUInt8(verification === "partial" ? 0 : 1, cursor);
  cursor += 1;
  if (verification === "partial") {
    data.writeUInt8(config.numSignatures ?? 1, cursor);
    cursor += 1;
  }

  normalizedFeedId(config.feedId).copy(data, cursor);
  cursor += FEED_ID_LEN;

  writeI64(data.subarray(cursor, cursor + 8), price);
  cursor += 8;
  writeU64(data.subarray(cursor, cursor + 8), 0n); // confidence interval
  cursor += 8;
  writeI32(data.subarray(cursor, cursor + 4), config.exponent);
  cursor += 4;
  writeI64(data.subarray(cursor, cursor + 8), publishTime);
  cursor += 8;
  writeI64(data.subarray(cursor, cursor + 8), publishTime - 1n); // prev publish time
  cursor += 8;
  writeI64(data.subarray(cursor, cursor + 8), price); // EMA price
  cursor += 8;
  writeU64(data.subarray(cursor, cursor + 8), 0n); // EMA confidence
  cursor += 8;
  writeU64(data.subarray(cursor, cursor + 8), 0n); // posted slot

  return data;
}

async function callSetAccountRpc(
  connection: Connection,
  account: PublicKey,
  data: Buffer,
  lamports: number,
): Promise<void> {
  const rawConnection = connection as unknown as {
    _rpcRequest: (method: string, params: unknown[]) => Promise<SetAccountRpcResult>;
  };
  if (typeof rawConnection._rpcRequest !== "function") {
    throw new Error("Connection does not expose _rpcRequest; cannot set mock oracle data");
  }

  const rpcResult = await rawConnection._rpcRequest("setAccount", [
    account.toBase58(),
    {
      lamports,
      owner: PYTH_RECEIVER_PROGRAM_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
      data: [data.toString("base64"), "base64"],
    },
  ]);

  if (rpcResult.error) {
    throw new Error(
      `setAccount RPC failed (${rpcResult.error.code ?? "unknown"}): ${
        rpcResult.error.message ?? "no error message"
      }`,
    );
  }
}

export async function setOraclePrice(
  connection: Connection,
  priceFeedAccount: PublicKey,
  config: MockOraclePriceConfig,
): Promise<void> {
  const data = buildMockPythPriceAccountData(config);
  const lamports = await connection.getMinimumBalanceForRentExemption(data.length);
  await callSetAccountRpc(connection, priceFeedAccount, data, lamports);
}

export async function createMockOraclePriceFeed(
  connection: Connection,
  config: MockOraclePriceConfig,
): Promise<PublicKey> {
  const priceFeedAccount = Keypair.generate().publicKey;
  await setOraclePrice(connection, priceFeedAccount, config);
  return priceFeedAccount;
}
