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

const MIN_LAYOUT_LEN = 533;
const RESERVED_TAIL_BYTES = 64;
const MAX_REASONABLE_CONTRIBUTIONS = 128;

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

function decodeFundingAccessMode(value: number): 'Public' | 'AllowlistOnly' {
  return value === 1 ? 'AllowlistOnly' : 'Public';
}

function parseCurrentLayout(data: Buffer): ParsedContractAccount {
  let offset = 8; // discriminator

  const borrower = readPubkey(data, offset);
  offset += 32;

  const contractSeed = readU64(data, offset);
  offset += 8;

  const targetAmountRaw = readU64(data, offset);
  offset += 8;

  const fundedAmountRaw = readU64(data, offset);
  offset += 8;

  const interestRate = readU32(data, offset);
  offset += 4;

  const termDays = readU32(data, offset);
  offset += 4;

  const collateralAmountRaw = readU64(data, offset);
  offset += 8;

  const loanType = mapEnum<ParsedLoanType>(LOAN_TYPE_MAP, readU8(data, offset));
  offset += 1;

  const ltvRatioBps = readU32(data, offset);
  offset += 4;

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

  const fundingAccessMode = decodeFundingAccessMode(readU8(data, offset));
  offset += 1;

  const hasActiveProposal = readBool(data, offset);
  offset += 1;

  const proposalCountRaw = readU64(data, offset);
  offset += 8;

  const uncollectableBalanceRaw = readU64(data, offset);
  offset += 8;

  const totalPrepaymentFeesRaw = readU64(data, offset);
  offset += 8;

  const accountVersion = readU16(data, offset);
  offset += 2;

  const contractVersion = readU8(data, offset);
  offset += 1;

  const collateralMint = readPubkey(data, offset);
  offset += 32;

  const collateralTokenAccount = readPubkey(data, offset);
  offset += 32;

  const collateralValueAtCreationRaw = readU64(data, offset);
  offset += 8;

  const ltvFloorBps = readU32(data, offset);
  offset += 4;

  const loanMint = readPubkey(data, offset);
  offset += 32;

  const loanTokenAccount = readPubkey(data, offset);
  offset += 32;

  const recallRequested = readBool(data, offset);
  offset += 1;

  const recallRequestedAt = readI64(data, offset);
  offset += 8;

  const recallRequestedBy = readPubkey(data, offset);
  offset += 32;

  const isRevolving = readBool(data, offset);
  offset += 1;

  const creditLimitRaw = readU64(data, offset);
  offset += 8;

  const drawnAmountRaw = readU64(data, offset);
  offset += 8;

  const availableAmountRaw = readU64(data, offset);
  offset += 8;

  const standbyFeeRate = readU32(data, offset);
  offset += 4;

  const accruedStandbyFeesRaw = readU64(data, offset);
  offset += 8;

  const lastStandbyFeeUpdate = readI64(data, offset);
  offset += 8;

  const totalDraws = readU32(data, offset);
  offset += 4;

  const totalStandbyFeesPaidRaw = readU64(data, offset);
  offset += 8;

  const revolvingClosed = readBool(data, offset);
  offset += 1;

  const reservedTail = data.subarray(offset, offset + RESERVED_TAIL_BYTES);
  if (reservedTail.length !== RESERVED_TAIL_BYTES) {
    throw new RangeError('DebtContract tail reserved bytes are truncated');
  }
  offset += RESERVED_TAIL_BYTES;

  return {
    layout: 'current',
    borrower,
    contractSeed: contractSeed.toString(),
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
    fundingAccessMode,
    hasActiveProposal,
    proposalCount: proposalCountRaw.toString(),
    uncollectableBalance: asUiUsdc(uncollectableBalanceRaw),
    uncollectableBalanceRaw: uncollectableBalanceRaw.toString(),
    totalPrepaymentFees: asUiUsdc(totalPrepaymentFeesRaw),
    totalPrepaymentFeesRaw: totalPrepaymentFeesRaw.toString(),
    accountVersion,
    contractVersion,
    collateralMint,
    collateralTokenAccount,
    collateralValueAtCreation: asUiUsdc(collateralValueAtCreationRaw),
    collateralValueAtCreationRaw: collateralValueAtCreationRaw.toString(),
    ltvFloorBps,
    loanMint,
    loanTokenAccount,
    recallRequested,
    recallRequestedAt: recallRequestedAt.toString(),
    recallRequestedBy,
    isRevolving,
    creditLimit: asUiUsdc(creditLimitRaw),
    creditLimitRaw: creditLimitRaw.toString(),
    drawnAmount: asUiUsdc(drawnAmountRaw),
    drawnAmountRaw: drawnAmountRaw.toString(),
    availableAmount: asUiUsdc(availableAmountRaw),
    availableAmountRaw: availableAmountRaw.toString(),
    standbyFeeRate,
    accruedStandbyFees: asUiUsdc(accruedStandbyFeesRaw),
    accruedStandbyFeesRaw: accruedStandbyFeesRaw.toString(),
    lastStandbyFeeUpdate: lastStandbyFeeUpdate.toString(),
    totalDraws,
    totalStandbyFeesPaid: asUiUsdc(totalStandbyFeesPaidRaw),
    totalStandbyFeesPaidRaw: totalStandbyFeesPaidRaw.toString(),
    revolvingClosed,
  };
}

export function parseContractAccount(data: Buffer): ParsedContractAccount | null {
  if (!assertDiscriminator(data, DISCRIMINATORS.DEBT_CONTRACT)) {
    return null;
  }

  if (data.length < MIN_LAYOUT_LEN) {
    return null;
  }

  try {
    return parseCurrentLayout(data);
  } catch {
    return null;
  }
}
