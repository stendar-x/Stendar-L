import { DISCRIMINATORS } from './discriminators';
import {
  assertDiscriminator,
  readBool,
  readI64,
  readPubkey,
  readU8,
  readU16,
  readU64,
} from './bufferUtils';
import { asUiUsdc } from './parserHelpers';
import type { ParsedPoolDepositAccount } from './types';

const POOL_DEPOSIT_RESERVED_BYTES = 96;

export function parsePoolDepositAccount(data: Buffer): ParsedPoolDepositAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.POOL_DEPOSIT)) {
    return null;
  }

  try {
    let offset = 8; // discriminator

    const depositor = readPubkey(data, offset);
    offset += 32;
    const pool = readPubkey(data, offset);
    offset += 32;

    const depositAmountRaw = readU64(data, offset);
    offset += 8;
    const accruedYieldRaw = readU64(data, offset);
    offset += 8;
    const lastYieldUpdate = readI64(data, offset);
    offset += 8;
    const depositTimestamp = readI64(data, offset);
    offset += 8;
    const withdrawalRequested = readBool(data, offset);
    offset += 1;
    const withdrawalRequestedAt = readI64(data, offset);
    offset += 8;
    const withdrawalRequestedAmountRaw = readU64(data, offset);
    offset += 8;
    const totalYieldClaimedRaw = readU64(data, offset);
    offset += 8;

    const frontend = readPubkey(data, offset);
    offset += 32;
    const yieldPreference = readU8(data, offset);
    offset += 1;
    const totalYieldCompoundedRaw = readU64(data, offset);
    offset += 8;

    const reserved = data.subarray(offset, offset + POOL_DEPOSIT_RESERVED_BYTES);
    if (reserved.length !== POOL_DEPOSIT_RESERVED_BYTES) {
      return null;
    }
    offset += POOL_DEPOSIT_RESERVED_BYTES;

    const accountVersion = readU16(data, offset);

    return {
      depositor,
      pool,
      depositAmount: asUiUsdc(depositAmountRaw),
      depositAmountRaw: depositAmountRaw.toString(),
      accruedYield: asUiUsdc(accruedYieldRaw),
      accruedYieldRaw: accruedYieldRaw.toString(),
      lastYieldUpdate: lastYieldUpdate.toString(),
      depositTimestamp: depositTimestamp.toString(),
      withdrawalRequested,
      withdrawalRequestedAt: withdrawalRequestedAt.toString(),
      withdrawalRequestedAmount: asUiUsdc(withdrawalRequestedAmountRaw),
      withdrawalRequestedAmountRaw: withdrawalRequestedAmountRaw.toString(),
      totalYieldClaimed: asUiUsdc(totalYieldClaimedRaw),
      totalYieldClaimedRaw: totalYieldClaimedRaw.toString(),
      frontend,
      yieldPreference,
      totalYieldCompounded: asUiUsdc(totalYieldCompoundedRaw),
      totalYieldCompoundedRaw: totalYieldCompoundedRaw.toString(),
      accountVersion,
    };
  } catch {
    return null;
  }
}
