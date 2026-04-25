import { DISCRIMINATORS } from './discriminators';
import { assertDiscriminator, readBool, readI64, readPubkey, readU16, readU64 } from './bufferUtils';
import { asUiUsdc } from './parserHelpers';
import type { ParsedContributionAccount } from './types';

const CONTRIBUTION_RESERVED_BYTES = 96;
const CURRENT_LAYOUT_LEN = 219;

function parseCurrent219(data: Buffer): ParsedContributionAccount {
  let offset = 8; // discriminator
  const lender = readPubkey(data, offset);
  offset += 32;
  const contract = readPubkey(data, offset);
  offset += 32;

  const contributionAmountRaw = readU64(data, offset);
  offset += 8;
  const totalInterestClaimedRaw = readU64(data, offset);
  offset += 8;
  const totalPrincipalClaimedRaw = readU64(data, offset);
  offset += 8;
  const lastClaimTimestamp = readI64(data, offset);
  offset += 8;
  const isRefunded = readBool(data, offset);
  offset += 1;
  const createdAt = readI64(data, offset);
  offset += 8;
  const lastContributedAt = readI64(data, offset);
  offset += 8;
  offset += CONTRIBUTION_RESERVED_BYTES;
  const accountVersion = readU16(data, offset);

  return {
    layout: 'current_219',
    lender,
    contract,
    contributionAmount: asUiUsdc(contributionAmountRaw),
    contributionAmountRaw: contributionAmountRaw.toString(),
    totalInterestClaimed: asUiUsdc(totalInterestClaimedRaw),
    totalInterestClaimedRaw: totalInterestClaimedRaw.toString(),
    totalPrincipalClaimed: asUiUsdc(totalPrincipalClaimedRaw),
    totalPrincipalClaimedRaw: totalPrincipalClaimedRaw.toString(),
    lastClaimTimestamp: lastClaimTimestamp.toString(),
    isRefunded,
    createdAt: createdAt.toString(),
    lastContributedAt: lastContributedAt.toString(),
    refundedDeprecated: null,
    accountVersion,
  };
}

export function parseContributionAccount(data: Buffer): ParsedContributionAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.LENDER_CONTRIBUTION)) {
    return null;
  }

  if (data.length < CURRENT_LAYOUT_LEN) {
    return null;
  }
  try {
    return parseCurrent219(data);
  } catch {
    return null;
  }
}
