import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateSubmissionIdFromSignedTransaction,
  withSubmissionId,
} from '../utils/idempotency';

test('generateSubmissionIdFromSignedTransaction is deterministic', () => {
  const payload = 'signed-transaction-base64';
  const first = generateSubmissionIdFromSignedTransaction(payload);
  const second = generateSubmissionIdFromSignedTransaction(payload);
  assert.equal(first, second);
  assert.equal(first.length, 64);
});

test('withSubmissionId preserves explicit submissionId', () => {
  const request = withSubmissionId({
    signedTransactionBase64: 'abc',
    expectedWalletAddress: 'wallet',
    expectedAddress: 'expected',
    submissionId: 'provided-id',
  });
  assert.equal(request.submissionId, 'provided-id');
});

test('withSubmissionId auto-generates submissionId when omitted', () => {
  const request = withSubmissionId({
    signedTransactionBase64: 'abc',
    expectedWalletAddress: 'wallet',
    expectedAddress: 'expected',
  });
  assert.equal(request.submissionId, generateSubmissionIdFromSignedTransaction('abc'));
});
