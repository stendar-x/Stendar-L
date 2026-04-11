import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIXED_NAME_LENGTH,
  decodeFixedName,
  decodeOperatorName,
  decodePoolName,
  encodeFixedName,
  encodeOperatorName,
  encodePoolName,
} from '../utils/names';

test('encodeFixedName and decodeFixedName round-trip ASCII names', () => {
  const encoded = encodeFixedName('Alpha Pool');
  assert.equal(encoded.length, FIXED_NAME_LENGTH);
  assert.equal(decodeFixedName(encoded), 'Alpha Pool');
});

test('encodeFixedName rejects names that exceed fixed UTF-8 byte length', () => {
  const overlongMultiByte = '😀'.repeat(9); // 36 bytes in UTF-8.
  assert.throws(
    () => encodeFixedName(overlongMultiByte),
    /exceeds 32 UTF-8 bytes/i
  );
});

test('pool/operator helper aliases preserve the same encoding semantics', () => {
  const poolEncoded = encodePoolName('income pool');
  const operatorEncoded = encodeOperatorName('operator alpha');
  assert.equal(poolEncoded.length, FIXED_NAME_LENGTH);
  assert.equal(operatorEncoded.length, FIXED_NAME_LENGTH);
  assert.equal(decodePoolName(poolEncoded), 'income pool');
  assert.equal(decodeOperatorName(operatorEncoded), 'operator alpha');
});
