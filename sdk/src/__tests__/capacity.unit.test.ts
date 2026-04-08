import assert from 'node:assert/strict';
import test from 'node:test';
import type { ParsedContractAccount } from '../parsers/types';
import { getContractCapacity } from '../utils/capacity';

const BASE_CONTRACT: ParsedContractAccount = {
  layout: 'current',
  borrower: 'borrower',
  contractSeed: '1',
  targetAmount: 100,
  targetAmountRaw: '100000000',
  fundedAmount: 40,
  fundedAmountRaw: '40000000',
  interestRate: 850,
  termDays: 30,
  collateralAmountRaw: '0',
  loanType: 'Demand',
  ltvRatioBps: '11500',
  interestPaymentType: 'OutstandingBalance',
  principalPaymentType: 'NoFixedPayment',
  interestFrequency: 'Monthly',
  principalFrequency: null,
  createdAt: '0',
  status: 'OpenPartiallyFunded',
  numContributions: 0,
  outstandingBalance: 40,
  outstandingBalanceRaw: '40000000',
  accruedInterest: 0,
  accruedInterestRaw: '0',
  lastInterestUpdate: '0',
  lastPrincipalPayment: '0',
  totalPrincipalPaid: 0,
  totalPrincipalPaidRaw: '0',
  contributions: [],
  lastBotUpdate: '0',
  nextInterestPaymentDue: '0',
  nextPrincipalPaymentDue: '0',
  botOperationCount: '0',
  maxLenders: 10,
  partialFundingFlag: 1,
  expiresAt: '0',
  allowPartialFill: true,
  minPartialFillBps: 2500,
  listingFeePaid: 0,
  listingFeePaidRaw: '0',
  fundingAccessMode: 'Public',
  hasActiveProposal: false,
  proposalCount: '0',
  uncollectableBalance: 0,
  uncollectableBalanceRaw: '0',
  totalPrepaymentFees: 0,
  totalPrepaymentFeesRaw: '0',
  accountVersion: 1,
  contractVersion: 2,
  collateralMint: null,
  collateralTokenAccount: null,
  collateralValueAtCreation: null,
  collateralValueAtCreationRaw: null,
  ltvFloorBps: null,
  loanMint: null,
  loanTokenAccount: null,
  recallRequested: null,
  recallRequestedAt: null,
  recallRequestedBy: null,
};

function buildContract(overrides: Partial<ParsedContractAccount> = {}): ParsedContractAccount {
  return {
    ...BASE_CONTRACT,
    ...overrides,
  };
}

test('getContractCapacity computes remaining amount and min partial-fill amount', () => {
  const contract = buildContract({
    targetAmount: 150,
    targetAmountRaw: '150000000',
    fundedAmount: 45,
    fundedAmountRaw: '45000000',
    allowPartialFill: true,
    partialFundingFlag: 1,
    minPartialFillBps: 3000,
  });

  const capacity = getContractCapacity(contract);

  assert.equal(capacity.remainingAmount, 105);
  assert.equal(capacity.remainingAmountRaw, '105000000');
  assert.equal(capacity.acceptsPartialFill, true);
  assert.equal(capacity.minPartialFillAmount, 45);
  assert.equal(capacity.minPartialFillAmountRaw, '45000000');
});

test('getContractCapacity disables partial fill when flag or switch is off', () => {
  const noAllowPartialFill = getContractCapacity(
    buildContract({
      allowPartialFill: false,
      partialFundingFlag: 1,
    })
  );
  const noPartialFundingFlag = getContractCapacity(
    buildContract({
      allowPartialFill: true,
      partialFundingFlag: 0,
    })
  );

  assert.equal(noAllowPartialFill.acceptsPartialFill, false);
  assert.equal(noPartialFundingFlag.acceptsPartialFill, false);
});

test('getContractCapacity never returns a negative remaining amount', () => {
  const contract = buildContract({
    targetAmount: 90,
    targetAmountRaw: '90000000',
    fundedAmount: 95,
    fundedAmountRaw: '95000000',
  });

  const capacity = getContractCapacity(contract);
  assert.equal(capacity.remainingAmount, 0);
  assert.equal(capacity.remainingAmountRaw, '0');
});

test('getContractCapacity preserves precise raw arithmetic for large values', () => {
  const contract = buildContract({
    targetAmount: Number.MAX_SAFE_INTEGER,
    fundedAmount: 0,
    targetAmountRaw: '9007199254740993000000',
    fundedAmountRaw: '9007199254740992000000',
    minPartialFillBps: 3333,
  });

  const capacity = getContractCapacity(contract);
  assert.equal(capacity.remainingAmountRaw, '1000000');
  assert.equal(capacity.minPartialFillAmountRaw, '3002099511605172966900');
});
