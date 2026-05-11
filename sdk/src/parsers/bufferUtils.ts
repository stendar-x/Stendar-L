import { PublicKey } from '@solana/web3.js';

export const ACCOUNT_DISCRIMINATOR_SIZE = 8;

function assertReadable(buffer: Buffer, offset: number, length: number): void {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`Invalid buffer offset: ${offset}`);
  }
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`Invalid read length: ${length}`);
  }
  const end = offset + length;
  if (end > buffer.length) {
    throw new RangeError(
      `Out-of-bounds read (offset=${offset}, length=${length}, bufferLength=${buffer.length})`
    );
  }
}

export function assertMinLength(buffer: Buffer, minLength: number): boolean {
  return buffer.length >= minLength;
}

export function assertDiscriminator(buffer: Buffer, expected: Buffer): boolean {
  if (expected.length !== ACCOUNT_DISCRIMINATOR_SIZE) {
    return false;
  }
  if (!assertMinLength(buffer, ACCOUNT_DISCRIMINATOR_SIZE)) {
    return false;
  }
  return buffer.subarray(0, ACCOUNT_DISCRIMINATOR_SIZE).equals(expected);
}

// Alias names exported for external consumers that use product parser naming.
export const assertMinimumBufferLength = assertMinLength;
export const assertAccountDiscriminator = assertDiscriminator;

export function readPubkey(buffer: Buffer, offset: number): string {
  assertReadable(buffer, offset, 32);
  return new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
}

export function readU64(buffer: Buffer, offset: number): bigint {
  assertReadable(buffer, offset, 8);
  return buffer.readBigUInt64LE(offset);
}

export function readI64(buffer: Buffer, offset: number): bigint {
  assertReadable(buffer, offset, 8);
  return buffer.readBigInt64LE(offset);
}

export function readU32(buffer: Buffer, offset: number): number {
  assertReadable(buffer, offset, 4);
  return buffer.readUInt32LE(offset);
}

export function readI32(buffer: Buffer, offset: number): number {
  assertReadable(buffer, offset, 4);
  return buffer.readInt32LE(offset);
}

export function readU16(buffer: Buffer, offset: number): number {
  assertReadable(buffer, offset, 2);
  return buffer.readUInt16LE(offset);
}

export function readU8(buffer: Buffer, offset: number): number {
  assertReadable(buffer, offset, 1);
  return buffer.readUInt8(offset);
}

export function readBool(buffer: Buffer, offset: number): boolean {
  return readU8(buffer, offset) !== 0;
}
