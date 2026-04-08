export const PREPAYMENT_FEE_BPS = 200;
export const EARLY_TERMINATION_FEE_FORMULA =
  '(standbyFeeRate * availableAmount * remainingSeconds) / (365 * 24 * 60 * 60 * 10000)';

export function calculatePrepaymentFee(principalAmount: number): number {
  if (!Number.isFinite(principalAmount) || principalAmount <= 0) {
    return 0;
  }
  return Math.floor((principalAmount * PREPAYMENT_FEE_BPS) / 10_000);
}

export function calculateStandbyFee(
  creditLimit: number,
  drawnAmount: number,
  standbyFeeRate: number,
  elapsedSeconds: number
): number {
  if (
    !Number.isFinite(creditLimit) ||
    !Number.isFinite(drawnAmount) ||
    !Number.isFinite(standbyFeeRate) ||
    !Number.isFinite(elapsedSeconds)
  ) {
    return 0;
  }
  if (creditLimit <= 0 || standbyFeeRate <= 0 || elapsedSeconds <= 0) {
    return 0;
  }
  const undrawnAmount = Math.max(0, creditLimit - Math.max(0, drawnAmount));
  if (undrawnAmount <= 0) {
    return 0;
  }
  return Math.floor((undrawnAmount * standbyFeeRate * elapsedSeconds) / (365 * 24 * 60 * 60 * 10_000));
}

export function isRevolving<T extends { isRevolving?: boolean }>(
  contract: T
): contract is T & { isRevolving: true } {
  return contract.isRevolving === true;
}
