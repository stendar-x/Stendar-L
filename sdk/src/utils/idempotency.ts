import { createHash } from 'node:crypto';

export function generateSubmissionIdFromSignedTransaction(signedTransactionBase64: string): string {
  return createHash('sha256').update(signedTransactionBase64).digest('hex');
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
