export const PREPAYMENT_FEE_BPS = 200;

export function calculatePrepaymentFee(principalAmount: number): number {
  if (!Number.isFinite(principalAmount) || principalAmount <= 0) {
    return 0;
  }
  return Math.floor((principalAmount * PREPAYMENT_FEE_BPS) / 10_000);
}
