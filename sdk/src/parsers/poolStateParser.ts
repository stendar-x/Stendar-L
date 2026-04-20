import { DISCRIMINATORS } from './discriminators';
import {
  assertDiscriminator,
  readBool,
  readI64,
  readPubkey,
  readU8,
  readU16,
  readU32,
  readU64,
} from './bufferUtils';
import { POOL_STATUS_MAP } from './enumMaps';
import { asUiUsdc, mapEnumValue } from './parserHelpers';
import type { ParsedPoolStateAccount, ParsedPoolStatus } from './types';

const POOL_RESERVED_SIZE = 96;

function decodePoolName(buffer: Buffer, offset: number): string {
  const raw = buffer.subarray(offset, offset + 32);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? 32 : end).toString('utf8');
}

export function parsePoolStateAccount(data: Buffer): ParsedPoolStateAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.POOL_STATE)) {
    return null;
  }

  try {
    let offset = 8;

    const operator = readPubkey(data, offset);
    offset += 32;
    const poolSeed = readU64(data, offset);
    offset += 8;
    const name = decodePoolName(data, offset);
    offset += 32;
    const rateBps = readU32(data, offset);
    offset += 4;
    const capacityRaw = readU64(data, offset);
    offset += 8;
    const currentTotalDepositsRaw = readU64(data, offset);
    offset += 8;
    const currentUtilizedRaw = readU64(data, offset);
    offset += 8;
    const totalYieldDistributedRaw = readU64(data, offset);
    offset += 8;
    const status = mapEnumValue<ParsedPoolStatus>(POOL_STATUS_MAP, readU8(data, offset));
    offset += 1;
    const createdAt = readI64(data, offset);
    offset += 8;
    const authorized = readBool(data, offset);
    offset += 1;
    const withdrawalQueueEnabled = readBool(data, offset);
    offset += 1;
    const minimumDepositRaw = readU64(data, offset);
    offset += 8;
    const numDepositors = readU32(data, offset);
    offset += 4;
    const loanMint = readPubkey(data, offset);
    offset += 32;
    const vaultTokenAccount = readPubkey(data, offset);
    offset += 32;
    const bump = readU8(data, offset);
    offset += 1;
    const allowedLoanType = readU8(data, offset);
    offset += 1;
    const minLtvBps = readU16(data, offset);
    offset += 2;
    const maxTermDays = readU32(data, offset);
    offset += 4;
    const rateUpdatedAt = readI64(data, offset);
    offset += 8;
    const prevRateBps = readU32(data, offset);
    offset += 4;
    const idleSince = readI64(data, offset);
    offset += 8;

    const totalPendingYieldRaw = readU64(data, offset);
    offset += 8;
    const pendingWithdrawalRequests = readU32(data, offset);
    offset += 4;

    const reserved = data.subarray(offset, offset + POOL_RESERVED_SIZE);
    if (reserved.length !== POOL_RESERVED_SIZE) {
      return null;
    }
    offset += POOL_RESERVED_SIZE;

    const accountVersion = readU16(data, offset);

    return {
      operator,
      poolSeed: poolSeed.toString(),
      name,
      rateBps,
      capacity: asUiUsdc(capacityRaw),
      capacityRaw: capacityRaw.toString(),
      currentTotalDeposits: asUiUsdc(currentTotalDepositsRaw),
      currentTotalDepositsRaw: currentTotalDepositsRaw.toString(),
      currentUtilized: asUiUsdc(currentUtilizedRaw),
      currentUtilizedRaw: currentUtilizedRaw.toString(),
      totalYieldDistributed: asUiUsdc(totalYieldDistributedRaw),
      totalYieldDistributedRaw: totalYieldDistributedRaw.toString(),
      status,
      createdAt: createdAt.toString(),
      authorized,
      withdrawalQueueEnabled,
      minimumDeposit: asUiUsdc(minimumDepositRaw),
      minimumDepositRaw: minimumDepositRaw.toString(),
      numDepositors,
      loanMint,
      vaultTokenAccount,
      bump,
      allowedLoanType,
      minLtvBps,
      maxTermDays,
      rateUpdatedAt: rateUpdatedAt.toString(),
      prevRateBps,
      idleSince: idleSince.toString(),
      totalPendingYieldRaw: totalPendingYieldRaw.toString(),
      pendingWithdrawalRequests,
      accountVersion,
    };
  } catch {
    return null;
  }
}
