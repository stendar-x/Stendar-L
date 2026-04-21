import { readU8 } from './bufferUtils';

export const USDC_SCALE = 1_000_000;
const USDC_SCALE_BIGINT = 1_000_000n;

/**
 * Converts atomic USDC units to a UI number for display only.
 * Use the corresponding `*Raw` string fields for financial arithmetic.
 */
export function asUiUsdc(raw: bigint): number {
  const whole = raw / USDC_SCALE_BIGINT;
  const fractional = raw % USDC_SCALE_BIGINT;
  return Number(whole) + Number(fractional) / USDC_SCALE;
}

export function mapEnumValue<T extends string>(mapping: Record<number, string>, value: number): T | 'Unknown' {
  const mapped = mapping[value];
  return typeof mapped === 'string' ? (mapped as T) : 'Unknown';
}

export function readOptionU8(buffer: Buffer, offset: number): { value: number | null; next: number } {
  const tag = readU8(buffer, offset);
  let next = offset + 1;
  if (tag === 0) {
    return { value: null, next };
  }
  if (tag !== 1) {
    throw new RangeError(`Invalid Option<u8> tag: ${tag}`);
  }
  const value = readU8(buffer, next);
  next += 1;
  return { value, next };
}
