import { DISCRIMINATORS } from './discriminators';
import { assertDiscriminator, readBool, readI64, readPubkey, readU16, readU64 } from './bufferUtils';
import { asUiUsdc } from './parserHelpers';
import type { ParsedEscrowAccount } from './types';

const LENDER_ESCROW_RESERVED_BYTES = 32;

export function parseEscrowAccount(data: Buffer): ParsedEscrowAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.LENDER_ESCROW)) {
    return null;
  }

  try {
    let offset = 8; // discriminator

    const lender = readPubkey(data, offset);
    offset += 32;
    const contract = readPubkey(data, offset);
    offset += 32;

    const escrowAmountRaw = readU64(data, offset);
    offset += 8;
    const availableInterestRaw = readU64(data, offset);
    offset += 8;
    const availablePrincipalRaw = readU64(data, offset);
    offset += 8;
    const totalClaimedRaw = readU64(data, offset);
    offset += 8;
    const isReleased = readBool(data, offset);
    offset += 1;
    const createdAt = readI64(data, offset);
    offset += 8;
    const escrowTokenAccount = readPubkey(data, offset);
    offset += 32;

    const reserved = data.subarray(offset, offset + LENDER_ESCROW_RESERVED_BYTES);
    if (reserved.length !== LENDER_ESCROW_RESERVED_BYTES) {
      return null;
    }
    offset += LENDER_ESCROW_RESERVED_BYTES;

    const accountVersion = readU16(data, offset);

    return {
      lender,
      contract,
      escrowTokenAccount,
      escrowAmount: asUiUsdc(escrowAmountRaw),
      escrowAmountRaw: escrowAmountRaw.toString(),
      availableInterest: asUiUsdc(availableInterestRaw),
      availableInterestRaw: availableInterestRaw.toString(),
      availablePrincipal: asUiUsdc(availablePrincipalRaw),
      availablePrincipalRaw: availablePrincipalRaw.toString(),
      totalClaimed: asUiUsdc(totalClaimedRaw),
      totalClaimedRaw: totalClaimedRaw.toString(),
      isReleased,
      createdAt: createdAt.toString(),
      reservedHex: reserved.toString('hex'),
      accountVersion,
    };
  } catch {
    return null;
  }
}
