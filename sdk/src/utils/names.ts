export const FIXED_NAME_LENGTH = 32;

export function encodeFixedName(name: string): number[] {
  if (typeof name !== 'string') {
    throw new Error('name must be a string');
  }

  const encoded = Buffer.from(name, 'utf8');
  if (encoded.byteLength > FIXED_NAME_LENGTH) {
    throw new Error(`name exceeds ${FIXED_NAME_LENGTH} UTF-8 bytes`);
  }

  const output = Buffer.alloc(FIXED_NAME_LENGTH);
  encoded.copy(output, 0, 0, encoded.byteLength);
  return Array.from(output);
}

export function decodeFixedName(bytes: ArrayLike<number>): string {
  const source = Buffer.from(Array.from(bytes));
  const output = source.subarray(0, FIXED_NAME_LENGTH);
  return output.toString('utf8').replace(/\0+$/g, '').trim();
}

export function encodePoolName(name: string): number[] {
  return encodeFixedName(name);
}

export function decodePoolName(bytes: ArrayLike<number>): string {
  return decodeFixedName(bytes);
}

export function encodeOperatorName(name: string): number[] {
  return encodeFixedName(name);
}

export function decodeOperatorName(bytes: ArrayLike<number>): string {
  return decodeFixedName(bytes);
}
