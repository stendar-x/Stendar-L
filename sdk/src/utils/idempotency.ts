import { createHash } from 'node:crypto';

export function generateSubmissionIdFromSignedTransaction(signedTransactionBase64: string): string {
  const normalized = signedTransactionBase64.replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('Invalid signedTransactionBase64: expected standard base64 transaction bytes');
  }
  const transactionBytes = Buffer.from(normalized, 'base64');
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
