import { BN } from '@coral-xyz/anchor';

export function toBn(value: bigint | number): BN {
  return new BN(value.toString());
}

export function u64ToLeBytes(value: BN): Buffer {
  return value.toArrayLike(Buffer, 'le', 8);
}
