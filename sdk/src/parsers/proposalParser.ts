import { DISCRIMINATORS } from './discriminators';
import { assertDiscriminator, readI64, readPubkey, readU16, readU32, readU64, readU8 } from './bufferUtils';
import {
  FREQUENCY_MAP,
  INTEREST_PAYMENT_TYPE_MAP,
  PRINCIPAL_PAYMENT_TYPE_MAP,
  PROPOSAL_STATUS_MAP,
} from './enumMaps';
import { mapEnumValue, readOptionU8 } from './parserHelpers';
import type {
  ParsedInterestPaymentType,
  ParsedPaymentFrequency,
  ParsedPrincipalPaymentType,
  ParsedProposalAccount,
  ParsedProposalStatus,
} from './types';

const MAX_REASONABLE_PARTICIPANTS = 256;
const PROPOSAL_RESERVED_BYTES = 96;

export function parseProposalAccount(data: Buffer): ParsedProposalAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.TERM_AMENDMENT_PROPOSAL)) {
    return null;
  }

  try {
    let offset = 8;

    const contract = readPubkey(data, offset);
    offset += 32;
    const proposer = readPubkey(data, offset);
    offset += 32;

    const proposalId = readU64(data, offset);
    offset += 8;
    const proposedInterestRate = readU32(data, offset);
    offset += 4;
    const proposedTermDays = readU32(data, offset);
    offset += 4;

    const proposedInterestFrequency = mapEnumValue<ParsedPaymentFrequency>(FREQUENCY_MAP, readU8(data, offset));
    offset += 1;

    const principalFrequencyOpt = readOptionU8(data, offset);
    offset = principalFrequencyOpt.next;
    const proposedPrincipalFrequency =
      principalFrequencyOpt.value === null
        ? null
        : mapEnumValue<ParsedPaymentFrequency>(FREQUENCY_MAP, principalFrequencyOpt.value);

    const proposedInterestPaymentType = mapEnumValue<ParsedInterestPaymentType>(
      INTEREST_PAYMENT_TYPE_MAP,
      readU8(data, offset)
    );
    offset += 1;

    const proposedPrincipalPaymentType = mapEnumValue<ParsedPrincipalPaymentType>(
      PRINCIPAL_PAYMENT_TYPE_MAP,
      readU8(data, offset)
    );
    offset += 1;

    const proposedLtvRatioBps = readU32(data, offset);
    offset += 4;
    const proposedLtvFloorBps = readU32(data, offset);
    offset += 4;

    const participantLength = readU32(data, offset);
    offset += 4;
    if (participantLength > MAX_REASONABLE_PARTICIPANTS) {
      return null;
    }

    const participantKeys: string[] = [];
    for (let i = 0; i < participantLength; i += 1) {
      participantKeys.push(readPubkey(data, offset));
      offset += 32;
    }

    const totalParticipants = readU8(data, offset);
    offset += 1;
    const approvals = readU8(data, offset);
    offset += 1;
    const rejections = readU8(data, offset);
    offset += 1;
    const status = mapEnumValue<ParsedProposalStatus>(PROPOSAL_STATUS_MAP, readU8(data, offset));
    offset += 1;

    const createdAt = readI64(data, offset);
    offset += 8;
    const expiresAt = readI64(data, offset);
    offset += 8;
    const resolvedAt = readI64(data, offset);
    offset += 8;
    const recallPledgedCount = readU32(data, offset);
    offset += 4;
    const recallPledgedAmount = readU64(data, offset);
    offset += 8;
    const recallsProcessed = readU32(data, offset);
    offset += 4;
    const recallGraceStart = readI64(data, offset);
    offset += 8;

    const reserved = data.subarray(offset, offset + PROPOSAL_RESERVED_BYTES);
    if (reserved.length !== PROPOSAL_RESERVED_BYTES) {
      return null;
    }
    offset += PROPOSAL_RESERVED_BYTES;

    const accountVersion = readU16(data, offset);

    return {
      contract,
      proposer,
      proposalId: proposalId.toString(),
      proposedInterestRate,
      proposedTermDays,
      proposedInterestFrequency,
      proposedPrincipalFrequency,
      proposedInterestPaymentType,
      proposedPrincipalPaymentType,
      proposedLtvRatioBps: proposedLtvRatioBps.toString(),
      proposedLtvFloorBps,
      participantKeys,
      totalParticipants,
      approvals,
      rejections,
      status,
      createdAt: createdAt.toString(),
      expiresAt: expiresAt.toString(),
      resolvedAt: resolvedAt.toString(),
      recallPledgedCount,
      recallPledgedAmountRaw: recallPledgedAmount.toString(),
      recallsProcessed,
      recallGraceStart: recallGraceStart.toString(),
      reservedHex: reserved.toString('hex'),
      accountVersion,
    };
  } catch {
    return null;
  }
}
