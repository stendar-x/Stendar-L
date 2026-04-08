import { DISCRIMINATORS } from './discriminators';
import {
  assertDiscriminator,
  readBool,
  readI64,
  readPubkey,
  readU16,
  readU32,
  readU64,
  readU8,
} from './bufferUtils';
import {
  CONTRACT_STATUS_MAP,
  FREQUENCY_MAP,
  INTEREST_PAYMENT_TYPE_MAP,
  LOAN_TYPE_MAP,
  PRINCIPAL_PAYMENT_TYPE_MAP,
} from './enumMaps';
import { asUiUsdc } from './parserHelpers';
import type {
  ParsedContractAccount,
  ParsedContractStatus,
  ParsedInterestPaymentType,
  ParsedLoanType,
  ParsedPaymentFrequency,
  ParsedPrincipalPaymentType,
} from './types';

const LEGACY_FULL_LAYOUT_LEN = 879;
const CURRENT_FULL_LAYOUT_LEN = 1007;
const CURRENT_BASE_LAYOUT_LEN = 699;
const APPENDED_LAYOUT_LEN = LEGACY_FULL_LAYOUT_LEN - CURRENT_BASE_LAYOUT_LEN;
const DEBT_CONTRACT_RESERVED_BYTES = 44;
const MIGRATION_RESERVE_BYTES = 128;
const MAX_REASONABLE_CONTRIBUTIONS = 128;

type ContractLayoutCandidate = {
  id: 'current';
  hasContractSeed: boolean;
  interestRateEncoding: 'u32' | 'u64';
  allowAppendedFields: boolean;
};

type ParsedCandidate = {
  parsed: ParsedContractAccount;
  score: number;
  priority: number;
};

function mapEnum<T extends string>(mapping: Record<number, string>, value: number): T | 'Unknown' {
  const mapped = mapping[value];
  return typeof mapped === 'string' ? (mapped as T) : 'Unknown';
}

function readOptionFrequency(data: Buffer, offset: number): { value: ParsedPaymentFrequency | null | 'Unknown'; next: number } {
  const tag = readU8(data, offset);
  let next = offset + 1;
  if (tag === 0) {
    return { value: null, next };
  }
  if (tag !== 1) {
    throw new RangeError(`Invalid Option<PaymentFrequency> tag: ${tag}`);
  }
  const frequencyVariant = readU8(data, next);
  next += 1;
  return {
    value: mapEnum<ParsedPaymentFrequency>(FREQUENCY_MAP, frequencyVariant),
    next,
  };
}

function decodeFundingAccessMode(reserved: Buffer): 'Public' | 'AllowlistOnly' {
  return reserved[0] === 1 ? 'AllowlistOnly' : 'Public';
}

function decodeProposalCount(reserved: Buffer): bigint {
  return reserved.readBigUInt64LE(2);
}

function parseCandidate(data: Buffer, candidate: ContractLayoutCandidate): ParsedContractAccount {
  let offset = 8; // discriminator

  const borrower = readPubkey(data, offset);
  offset += 32;

  const contractSeed = candidate.hasContractSeed ? readU64(data, offset) : null;
  if (candidate.hasContractSeed) {
    offset += 8;
  }

  const targetAmountRaw = readU64(data, offset);
  offset += 8;

  const fundedAmountRaw = readU64(data, offset);
  offset += 8;

  const interestRate =
    candidate.interestRateEncoding === 'u32' ? readU32(data, offset) : Number(readU64(data, offset));
  offset += candidate.interestRateEncoding === 'u32' ? 4 : 8;

  const termDays = readU32(data, offset);
  offset += 4;

  const collateralAmountRaw = readU64(data, offset);
  offset += 8;

  const loanType = mapEnum<ParsedLoanType>(LOAN_TYPE_MAP, readU8(data, offset));
  offset += 1;

  const ltvRatioBps = readU64(data, offset);
  offset += 8;

  const interestPaymentType = mapEnum<ParsedInterestPaymentType>(INTEREST_PAYMENT_TYPE_MAP, readU8(data, offset));
  offset += 1;

  const principalPaymentType = mapEnum<ParsedPrincipalPaymentType>(PRINCIPAL_PAYMENT_TYPE_MAP, readU8(data, offset));
  offset += 1;

  const interestFrequency = mapEnum<ParsedPaymentFrequency>(FREQUENCY_MAP, readU8(data, offset));
  offset += 1;

  const principalFrequencyOption = readOptionFrequency(data, offset);
  const principalFrequency = principalFrequencyOption.value;
  offset = principalFrequencyOption.next;

  const createdAt = readI64(data, offset);
  offset += 8;

  const status = mapEnum<ParsedContractStatus>(CONTRACT_STATUS_MAP, readU8(data, offset));
  offset += 1;

  const numContributions = readU32(data, offset);
  offset += 4;
  if (numContributions > MAX_REASONABLE_CONTRIBUTIONS) {
    throw new RangeError(`Unreasonable contribution count: ${numContributions}`);
  }

  const outstandingBalanceRaw = readU64(data, offset);
  offset += 8;

  const accruedInterestRaw = readU64(data, offset);
  offset += 8;

  const lastInterestUpdate = readI64(data, offset);
  offset += 8;

  const lastPrincipalPayment = readI64(data, offset);
  offset += 8;

  const totalPrincipalPaidRaw = readU64(data, offset);
  offset += 8;

  const contributionsLength = readU32(data, offset);
  offset += 4;
  if (contributionsLength > MAX_REASONABLE_CONTRIBUTIONS) {
    throw new RangeError(`Unreasonable contributions vec length: ${contributionsLength}`);
  }
  const contributions: string[] = [];
  for (let i = 0; i < contributionsLength; i += 1) {
    contributions.push(readPubkey(data, offset));
    offset += 32;
  }

  const lastBotUpdate = readI64(data, offset);
  offset += 8;

  const nextInterestPaymentDue = readI64(data, offset);
  offset += 8;

  const nextPrincipalPaymentDue = readI64(data, offset);
  offset += 8;

  const botOperationCount = readU64(data, offset);
  offset += 8;

  const maxLenders = readU16(data, offset);
  offset += 2;

  const partialFundingFlag = readU8(data, offset);
  offset += 1;

  const expiresAt = readI64(data, offset);
  offset += 8;

  const allowPartialFill = readBool(data, offset);
  offset += 1;

  const minPartialFillBps = readU16(data, offset);
  offset += 2;

  const listingFeePaidRaw = readU64(data, offset);
  offset += 8;

  const reserved = data.subarray(offset, offset + DEBT_CONTRACT_RESERVED_BYTES);
  if (reserved.length !== DEBT_CONTRACT_RESERVED_BYTES) {
    throw new RangeError('DebtContract reserved bytes are truncated');
  }
  offset += DEBT_CONTRACT_RESERVED_BYTES;

  const accountVersion = readU16(data, offset);
  offset += 2;

  // Account data fetched from Solana RPC includes allocated size. Rely on known
  // account allocation length (legacy: 879 bytes) rather than trailing zero
  // padding after variable-length vec fields when deciding if appended fields
  // are present.
  const appendedAvailable = data.length >= LEGACY_FULL_LAYOUT_LEN;
  const shouldParseAppended = candidate.allowAppendedFields && appendedAvailable;
  const migrationReserveAvailable = data.length >= CURRENT_FULL_LAYOUT_LEN;

  let contractVersion: number | null = null;
  let collateralMint: string | null = null;
  let collateralTokenAccount: string | null = null;
  let collateralValueAtCreationRaw: bigint | null = null;
  let ltvFloorBps: number | null = null;
  let loanMint: string | null = null;
  let loanTokenAccount: string | null = null;
  let recallRequested: boolean | null = null;
  let recallRequestedAt: bigint | null = null;
  let recallRequestedBy: string | null = null;
  let migrationReserveHex: string | undefined;

  if (shouldParseAppended) {
    contractVersion = readU8(data, offset);
    offset += 1;

    collateralMint = readPubkey(data, offset);
    offset += 32;

    collateralTokenAccount = readPubkey(data, offset);
    offset += 32;

    collateralValueAtCreationRaw = readU64(data, offset);
    offset += 8;

    ltvFloorBps = readU16(data, offset);
    offset += 2;

    loanMint = readPubkey(data, offset);
    offset += 32;

    loanTokenAccount = readPubkey(data, offset);
    offset += 32;

    recallRequested = readBool(data, offset);
    offset += 1;

    recallRequestedAt = readI64(data, offset);
    offset += 8;

    recallRequestedBy = readPubkey(data, offset);
    offset += 32;

    if (migrationReserveAvailable) {
      const migrationReserve = data.subarray(offset, offset + MIGRATION_RESERVE_BYTES);
      if (migrationReserve.length !== MIGRATION_RESERVE_BYTES) {
        throw new RangeError('DebtContract migration reserve bytes are truncated');
      }
      migrationReserveHex = migrationReserve.toString('hex');
      offset += MIGRATION_RESERVE_BYTES;
    }
  }

  const layout =
    candidate.id === 'current'
      ? shouldParseAppended
        ? 'current'
        : 'current_base'
      : candidate.id;

  return {
    layout,
    borrower,
    contractSeed: contractSeed?.toString() ?? null,
    targetAmount: asUiUsdc(targetAmountRaw),
    targetAmountRaw: targetAmountRaw.toString(),
    fundedAmount: asUiUsdc(fundedAmountRaw),
    fundedAmountRaw: fundedAmountRaw.toString(),
    interestRate,
    termDays,
    collateralAmountRaw: collateralAmountRaw.toString(),
    loanType,
    ltvRatioBps: ltvRatioBps.toString(),
    interestPaymentType,
    principalPaymentType,
    interestFrequency,
    principalFrequency,
    createdAt: createdAt.toString(),
    status,
    numContributions,
    outstandingBalance: asUiUsdc(outstandingBalanceRaw),
    outstandingBalanceRaw: outstandingBalanceRaw.toString(),
    accruedInterest: asUiUsdc(accruedInterestRaw),
    accruedInterestRaw: accruedInterestRaw.toString(),
    lastInterestUpdate: lastInterestUpdate.toString(),
    lastPrincipalPayment: lastPrincipalPayment.toString(),
    totalPrincipalPaid: asUiUsdc(totalPrincipalPaidRaw),
    totalPrincipalPaidRaw: totalPrincipalPaidRaw.toString(),
    contributions,
    lastBotUpdate: lastBotUpdate.toString(),
    nextInterestPaymentDue: nextInterestPaymentDue.toString(),
    nextPrincipalPaymentDue: nextPrincipalPaymentDue.toString(),
    botOperationCount: botOperationCount.toString(),
    maxLenders,
    partialFundingFlag,
    expiresAt: expiresAt.toString(),
    allowPartialFill,
    minPartialFillBps,
    listingFeePaid: asUiUsdc(listingFeePaidRaw),
    listingFeePaidRaw: listingFeePaidRaw.toString(),
    fundingAccessMode: decodeFundingAccessMode(reserved),
    hasActiveProposal: reserved[1] === 1,
    proposalCount: decodeProposalCount(reserved).toString(),
    reservedHex: reserved.toString('hex'),
    accountVersion,
    contractVersion,
    collateralMint,
    collateralTokenAccount,
    collateralValueAtCreation: collateralValueAtCreationRaw === null ? null : asUiUsdc(collateralValueAtCreationRaw),
    collateralValueAtCreationRaw: collateralValueAtCreationRaw?.toString() ?? null,
    ltvFloorBps,
    loanMint,
    loanTokenAccount,
    recallRequested,
    recallRequestedAt: recallRequestedAt?.toString() ?? null,
    recallRequestedBy,
    ...(migrationReserveHex === undefined ? {} : { migrationReserveHex }),
  };
}

function scoreCandidate(parsed: ParsedContractAccount): number {
  let score = 0;

  if (parsed.status !== 'Unknown') score += 5;
  if (parsed.loanType !== 'Unknown') score += 4;
  if (parsed.interestPaymentType !== 'Unknown') score += 3;
  if (parsed.principalPaymentType !== 'Unknown') score += 3;
  if (parsed.interestFrequency !== 'Unknown') score += 3;
  if (parsed.principalFrequency !== 'Unknown') score += 2;
  if (parsed.numContributions <= MAX_REASONABLE_CONTRIBUTIONS) score += 2;
  if (parsed.maxLenders <= MAX_REASONABLE_CONTRIBUTIONS) score += 2;
  if (parsed.termDays <= 36500) score += 1;
  if (parsed.interestRate <= 1_000_000) score += 1;

  const createdAt = Number(parsed.createdAt);
  if (Number.isFinite(createdAt) && createdAt >= 1_400_000_000 && createdAt <= 2_500_000_000) {
    score += 2;
  }

  if (parsed.layout === 'current') score += 4;
  if (parsed.layout === 'current_base') score += 2;
  return score;
}

export function parseContractAccount(data: Buffer): ParsedContractAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.DEBT_CONTRACT)) {
    return null;
  }

  const candidates: ContractLayoutCandidate[] = [
    {
      id: 'current',
      hasContractSeed: true,
      interestRateEncoding: 'u32',
      allowAppendedFields: true,
    },
  ];

  const parsedCandidates: ParsedCandidate[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      const parsed = parseCandidate(data, candidate);
      parsedCandidates.push({
        parsed,
        score: scoreCandidate(parsed),
        priority: i,
      });
    } catch {
      // Ignore invalid candidate layouts.
    }
  }

  if (parsedCandidates.length === 0) {
    return null;
  }

  parsedCandidates.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.priority - b.priority;
  });

  return parsedCandidates[0]?.parsed ?? null;
}
