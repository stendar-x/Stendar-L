import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateSubmissionIdFromSignedTransaction,
  withSubmissionId,
} from '../utils/idempotency';

test('generateSubmissionIdFromSignedTransaction is deterministic for equivalent base64 payloads', () => {
  const canonicalPayload = 'YWJjZGU='; // "abcde"
  const compactPayload = 'YWJjZGU'; // equivalent base64 without padding
  const whitespacePayload = 'YWJj\nZGU='; // equivalent base64 with ignored whitespace

  const first = generateSubmissionIdFromSignedTransaction(canonicalPayload);
  const second = generateSubmissionIdFromSignedTransaction(compactPayload);
  const third = generateSubmissionIdFromSignedTransaction(whitespacePayload);

  assert.equal(first, second);
  assert.equal(second, third);
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
