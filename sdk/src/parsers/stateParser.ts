import { DISCRIMINATORS } from './discriminators';
import { assertDiscriminator, readBool, readPubkey, readU16, readU64 } from './bufferUtils';
import { asUiUsdc } from './parserHelpers';
import type { ParsedStateAccount } from './types';

const STATE_RESERVED_BYTES = 96;

export function parseStateAccount(data: Buffer): ParsedStateAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.STATE)) {
    return null;
  }

  try {
    let offset = 8;

  const authority = readPubkey(data, offset);
  offset += 32;

  const totalDebtRaw = readU64(data, offset);
  offset += 8;
  const totalCollateralRaw = readU64(data, offset);
  offset += 8;
  const totalInterestPaidRaw = readU64(data, offset);
  offset += 8;
  const totalLiquidations = readU64(data, offset);
  offset += 8;
  const totalPartialLiquidations = readU64(data, offset);
  offset += 8;
  const totalContracts = readU64(data, offset);
  offset += 8;

  const platformFeeBasisPoints = readU16(data, offset);
  offset += 2;
  const poolDepositFeeBps = readU16(data, offset);
  offset += 2;
  const poolYieldFeeBps = readU16(data, offset);
  offset += 2;
  const primaryListingFeeBps = readU16(data, offset);
  offset += 2;
  const secondaryListingFeeBps = readU16(data, offset);
  offset += 2;
  const secondaryBuyerFeeBps = readU16(data, offset);
  offset += 2;

  const isPaused = readBool(data, offset);
  offset += 1;

  const reserved = data.subarray(offset, offset + STATE_RESERVED_BYTES);
  if (reserved.length !== STATE_RESERVED_BYTES) {
    return null;
  }
  offset += STATE_RESERVED_BYTES;

  const accountVersion = readU16(data, offset);

  return {
    authority,
    totalDebt: asUiUsdc(totalDebtRaw),
    totalDebtRaw: totalDebtRaw.toString(),
    totalCollateral: asUiUsdc(totalCollateralRaw),
    totalCollateralRaw: totalCollateralRaw.toString(),
    totalInterestPaid: asUiUsdc(totalInterestPaidRaw),
    totalInterestPaidRaw: totalInterestPaidRaw.toString(),
    totalLiquidations: totalLiquidations.toString(),
    totalPartialLiquidations: totalPartialLiquidations.toString(),
    totalContracts: totalContracts.toString(),
    platformFeeBasisPoints,
    poolDepositFeeBps,
    poolYieldFeeBps,
    primaryListingFeeBps,
    secondaryListingFeeBps,
    secondaryBuyerFeeBps,
    isPaused,
    accountVersion,
  };
  } catch {
    return null;
  }
}
