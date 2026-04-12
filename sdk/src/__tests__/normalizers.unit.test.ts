import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeDistributionMethod,
  normalizeFundingAccessMode,
  normalizeInterestPaymentType,
  normalizeLoanType,
  normalizePaymentFrequency,
  normalizePrincipalPaymentType,
  normalizeVoteChoice,
  toValidatedAllowedLoanType,
  validatePoolChangeProposal,
} from '../program';

test('normalizeVoteChoice accepts approve and reject case-insensitively', () => {
  assert.deepEqual(normalizeVoteChoice('approve'), { approve: {} });
  assert.deepEqual(normalizeVoteChoice('reject'), { reject: {} });
  assert.deepEqual(normalizeVoteChoice('Approve' as any), { approve: {} });
  assert.deepEqual(normalizeVoteChoice('REJECT' as any), { reject: {} });
});

test('normalizeVoteChoice rejects unsupported values', () => {
  assert.throws(() => normalizeVoteChoice('abstain' as any), /Invalid vote choice "abstain"/);
  assert.throws(() => normalizeVoteChoice('' as any), /vote choice: value cannot be empty/i);
  assert.throws(() => normalizeVoteChoice('approvee' as any), /Invalid vote choice "approvee"/);
});

test('normalizePaymentFrequency accepts all supported variants case-insensitively', () => {
  assert.deepEqual(normalizePaymentFrequency('daily'), { daily: {} });
  assert.deepEqual(normalizePaymentFrequency('weekly'), { weekly: {} });
  assert.deepEqual(normalizePaymentFrequency('biweekly'), { biWeekly: {} });
  assert.deepEqual(normalizePaymentFrequency('bi_weekly'), { biWeekly: {} });
  assert.deepEqual(normalizePaymentFrequency('bi-weekly'), { biWeekly: {} });
  assert.deepEqual(normalizePaymentFrequency('monthly'), { monthly: {} });
  assert.deepEqual(normalizePaymentFrequency('MONTHLY' as any), { monthly: {} });
});

test('normalizePaymentFrequency rejects unsupported values', () => {
  assert.throws(() => normalizePaymentFrequency('quarterly' as any), /Invalid payment frequency "quarterly"/);
  assert.throws(() => normalizePaymentFrequency('weekely' as any), /Invalid payment frequency "weekely"/);
  assert.throws(() => normalizePaymentFrequency('' as any), /payment frequency: value cannot be empty/i);
});

test('normalizeInterestPaymentType accepts all supported variants case-insensitively', () => {
  assert.deepEqual(normalizeInterestPaymentType('outstandingbalance'), { outstandingBalance: {} });
  assert.deepEqual(normalizeInterestPaymentType('outstanding_balance'), { outstandingBalance: {} });
  assert.deepEqual(normalizeInterestPaymentType('collateraltransfer'), { collateralTransfer: {} });
  assert.deepEqual(normalizeInterestPaymentType('collateral_transfer'), { collateralTransfer: {} });
  assert.deepEqual(normalizeInterestPaymentType('COLLATERAL_TRANSFER' as any), { collateralTransfer: {} });
});

test('normalizeInterestPaymentType rejects unsupported values', () => {
  assert.throws(() => normalizeInterestPaymentType('fixed' as any), /Invalid interest payment type "fixed"/);
  assert.throws(() => normalizeInterestPaymentType('' as any), /interest payment type: value cannot be empty/i);
});

test('normalizePrincipalPaymentType accepts all supported variants case-insensitively', () => {
  assert.deepEqual(normalizePrincipalPaymentType('collateraldeduction'), { collateralDeduction: {} });
  assert.deepEqual(normalizePrincipalPaymentType('collateral_deduction'), { collateralDeduction: {} });
  assert.deepEqual(normalizePrincipalPaymentType('nofixedpayment'), { noFixedPayment: {} });
  assert.deepEqual(normalizePrincipalPaymentType('no_fixed_payment'), { noFixedPayment: {} });
  assert.deepEqual(normalizePrincipalPaymentType('NO_FIXED_PAYMENT' as any), { noFixedPayment: {} });
});

test('normalizePrincipalPaymentType rejects unsupported values', () => {
  assert.throws(() => normalizePrincipalPaymentType('amortized' as any), /Invalid principal payment type "amortized"/);
  assert.throws(() => normalizePrincipalPaymentType('' as any), /principal payment type: value cannot be empty/i);
});

test('normalizeLoanType accepts supported values case-insensitively', () => {
  assert.deepEqual(normalizeLoanType('demand'), { demand: {} });
  assert.deepEqual(normalizeLoanType('committed'), { committed: {} });
  assert.deepEqual(normalizeLoanType('DEMAND' as any), { demand: {} });
});

test('normalizeLoanType rejects unsupported values', () => {
  assert.throws(() => normalizeLoanType('term' as any), /Invalid loan type "term"/);
});

test('normalizeDistributionMethod accepts supported values case-insensitively', () => {
  assert.deepEqual(normalizeDistributionMethod('manual'), { manual: {} });
  assert.deepEqual(normalizeDistributionMethod('automatic'), { automatic: {} });
  assert.deepEqual(normalizeDistributionMethod('AUTOMATIC' as any), { automatic: {} });
});

test('normalizeDistributionMethod rejects unsupported values', () => {
  assert.throws(() => normalizeDistributionMethod('scheduled' as any), /Invalid distribution method "scheduled"/);
});

test('normalizeFundingAccessMode accepts supported values case-insensitively', () => {
  assert.deepEqual(normalizeFundingAccessMode('public'), { public: {} });
  assert.deepEqual(normalizeFundingAccessMode('allowlistonly'), { allowlistOnly: {} });
  assert.deepEqual(normalizeFundingAccessMode('allowlist_only'), { allowlistOnly: {} });
  assert.deepEqual(normalizeFundingAccessMode('allowlist-only'), { allowlistOnly: {} });
  assert.deepEqual(normalizeFundingAccessMode('ALLOWLIST_ONLY' as any), { allowlistOnly: {} });
});

test('normalizeFundingAccessMode rejects unsupported values', () => {
  assert.throws(() => normalizeFundingAccessMode('private' as any), /Invalid funding access mode "private"/);
});

test('toValidatedAllowedLoanType accepts 0, 1, and 2', () => {
  assert.equal(toValidatedAllowedLoanType(0), 0);
  assert.equal(toValidatedAllowedLoanType(1), 1);
  assert.equal(toValidatedAllowedLoanType(2), 2);
});

test('toValidatedAllowedLoanType rejects out-of-range and non-integer values', () => {
  assert.throws(() => toValidatedAllowedLoanType(-1), /allowedLoanType/);
  assert.throws(() => toValidatedAllowedLoanType(3), /allowedLoanType/);
  assert.throws(() => toValidatedAllowedLoanType(1.5), /allowedLoanType/);
});

test('validatePoolChangeProposal accepts proposals with at least one field set', () => {
  const base = { operatorAddress: 'op', poolAddress: 'pool' };
  assert.doesNotThrow(() => validatePoolChangeProposal({ ...base, rateBps: 1200 }));
  assert.doesNotThrow(() => validatePoolChangeProposal({ ...base, capacity: 1000 }));
  assert.doesNotThrow(() => validatePoolChangeProposal({ ...base, minimumDeposit: 100 }));
  assert.doesNotThrow(() => validatePoolChangeProposal({ ...base, allowedLoanType: 1 }));
  assert.doesNotThrow(() => validatePoolChangeProposal({ ...base, minLtvBps: 10500 }));
  assert.doesNotThrow(() => validatePoolChangeProposal({ ...base, maxTermDays: 90 }));
  assert.doesNotThrow(() => validatePoolChangeProposal({ ...base, withdrawalQueueEnabled: true }));
});

test('validatePoolChangeProposal rejects proposals with all fields null or undefined', () => {
  const base = { operatorAddress: 'op', poolAddress: 'pool' };
  assert.throws(() => validatePoolChangeProposal(base), /At least one pool parameter/);
  assert.throws(
    () => validatePoolChangeProposal({ ...base, rateBps: null, capacity: null }),
    /At least one pool parameter/
  );
});
