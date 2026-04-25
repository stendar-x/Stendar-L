import { DISCRIMINATORS } from './discriminators';
import { assertDiscriminator, readI64, readPubkey, readU16, readU64 } from './bufferUtils';
import { asUiUsdc } from './parserHelpers';
import type { ParsedTreasuryAccount } from './types';

const TREASURY_RESERVED_BYTES = 96;

export function parseTreasuryAccount(data: Buffer): ParsedTreasuryAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.TREASURY)) {
    return null;
  }

  try {
    let offset = 8;

  const authority = readPubkey(data, offset);
  offset += 32;
  const pendingAuthority = readPubkey(data, offset);
  offset += 32;
  const botAuthority = readPubkey(data, offset);
  offset += 32;

  const feesCollectedRaw = readU64(data, offset);
  offset += 8;
  const transactionCostsRaw = readU64(data, offset);
  offset += 8;
  const automatedOperations = readU64(data, offset);
  offset += 8;
  const totalContractsProcessed = readU64(data, offset);
  offset += 8;
  const lastUpdate = readI64(data, offset);
  offset += 8;
  const createdAt = readI64(data, offset);
  offset += 8;

  const usdcMint = readPubkey(data, offset);
  offset += 32;
  const treasuryUsdcAccount = readPubkey(data, offset);
  offset += 32;

  const totalLiquidationFeesRaw = readU64(data, offset);
  offset += 8;
  const totalRecallFeesRaw = readU64(data, offset);
  offset += 8;

  const reserved = data.subarray(offset, offset + TREASURY_RESERVED_BYTES);
  if (reserved.length !== TREASURY_RESERVED_BYTES) {
    return null;
  }
  offset += TREASURY_RESERVED_BYTES;

  const accountVersion = readU16(data, offset);

  return {
    authority,
    pendingAuthority,
    botAuthority,
    feesCollected: asUiUsdc(feesCollectedRaw),
    feesCollectedRaw: feesCollectedRaw.toString(),
    transactionCosts: asUiUsdc(transactionCostsRaw),
    transactionCostsRaw: transactionCostsRaw.toString(),
    automatedOperations: automatedOperations.toString(),
    totalContractsProcessed: totalContractsProcessed.toString(),
    lastUpdate: lastUpdate.toString(),
    createdAt: createdAt.toString(),
    usdcMint,
    treasuryUsdcAccount,
    totalLiquidationFees: asUiUsdc(totalLiquidationFeesRaw),
    totalLiquidationFeesRaw: totalLiquidationFeesRaw.toString(),
    totalRecallFees: asUiUsdc(totalRecallFeesRaw),
    totalRecallFeesRaw: totalRecallFeesRaw.toString(),
    accountVersion,
  };
  } catch {
    return null;
  }
}
