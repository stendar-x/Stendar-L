export const PREPAYMENT_FEE_BPS = 200;
export const EARLY_TERMINATION_FEE_FORMULA =
  '(standbyFeeRate * availableAmount * remainingSeconds) / (365 * 24 * 60 * 60 * 10000)';

const MAX_SAFE_PREPAYMENT_INPUT = Number.MAX_SAFE_INTEGER / PREPAYMENT_FEE_BPS;
const MAX_SAFE_STANDBY_NUMERATOR = Number.MAX_SAFE_INTEGER;

export function calculatePrepaymentFee(principalAmount: number): number {
  if (!Number.isFinite(principalAmount) || principalAmount <= 0) {
    return 0;
  }

  if (principalAmount > MAX_SAFE_PREPAYMENT_INPUT) {
    throw new RangeError(
      `principalAmount exceeds safe integer precision for fee calculation (max: ${Math.floor(MAX_SAFE_PREPAYMENT_INPUT)})`
    );
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

  const numerator = undrawnAmount * standbyFeeRate * elapsedSeconds;
  if (!Number.isFinite(numerator) || numerator > MAX_SAFE_STANDBY_NUMERATOR) {
    throw new RangeError('standby fee numerator exceeds safe integer precision');
  }

  return Math.floor(numerator / (365 * 24 * 60 * 60 * 10_000));
}

export function isRevolving<T extends { isRevolving?: boolean }>(
  contract: T
): contract is T & { isRevolving: true } {
  return contract.isRevolving === true;
}
