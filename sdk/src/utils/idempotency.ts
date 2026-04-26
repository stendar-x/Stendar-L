import { createHash } from 'node:crypto';

export function generateSubmissionIdFromSignedTransaction(signedTransactionBase64: string): string {
  const transactionBytes = Buffer.from(signedTransactionBase64, 'base64');
  return createHash('sha256').update(transactionBytes).digest('hex');
}

export function withSubmissionId<T extends { signedTransactionBase64: string; submissionId?: string }>(
  request: T
): Omit<T, 'submissionId'> & { submissionId: string } {
  const normalizedSubmissionId = request.submissionId?.trim();
  if (normalizedSubmissionId) {
    return {
      ...request,
      submissionId: normalizedSubmissionId,
    };
  }

  return {
    ...request,
    submissionId: generateSubmissionIdFromSignedTransaction(request.signedTransactionBase64),
  };
}
