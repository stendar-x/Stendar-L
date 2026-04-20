import type { Idl } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import type { TransactionBuildResponse } from '../types';
import { decodeSerializedTransaction } from './transaction';

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z0-9+\-.]*:\/\//i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

export function validatePathSegment(value: string, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}: expected a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid ${fieldName}: value cannot be empty`);
  }
  if (ABSOLUTE_URL_PATTERN.test(trimmed)) {
    throw new Error(`Invalid ${fieldName}: absolute URLs are not allowed`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(trimmed)) {
    throw new Error(`Invalid ${fieldName}: control characters are not allowed`);
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error(`Invalid ${fieldName}: path delimiter characters are not allowed`);
  }

  return trimmed;
}

export function validateSolanaAddress(address: string, fieldName: string): string {
  const normalized = validatePathSegment(address, fieldName);
  try {
    return new PublicKey(normalized).toBase58();
  } catch {
    throw new Error(`Invalid ${fieldName}: expected a base58-encoded 32-byte Solana address`);
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toDiscriminatorKey(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 255) {
      return null;
    }
    normalized.push(entry);
  }
  return normalized.join(',');
}

function collectIdlDiscriminators(idl: Idl, section: 'instructions' | 'accounts'): Map<string, string> {
  const source = (idl as unknown as Record<string, unknown>)[section];
  if (!Array.isArray(source)) {
    throw new Error(`IDL integrity check failed: missing ${section} array`);
  }

  const entries = new Map<string, string>();
  for (const rawEntry of source) {
    const entry = toRecord(rawEntry);
    if (!entry || typeof entry.name !== 'string') {
      continue;
    }
    const discriminator = toDiscriminatorKey(entry.discriminator);
    if (!discriminator) {
      continue;
    }
    entries.set(entry.name, discriminator);
  }
  return entries;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function collectIdlLayouts(idl: Idl, section: 'instructions' | 'accounts'): Map<string, string> {
  const source = (idl as unknown as Record<string, unknown>)[section];
  if (!Array.isArray(source)) {
    throw new Error(`IDL integrity check failed: missing ${section} array`);
  }

  const entries = new Map<string, string>();
  for (const rawEntry of source) {
    const entry = toRecord(rawEntry);
    if (!entry || typeof entry.name !== 'string') {
      continue;
    }
    const layout = section === 'instructions'
      ? {
          accounts: entry.accounts ?? [],
          args: entry.args ?? [],
        }
      : {
          type: entry.type ?? null,
        };
    entries.set(entry.name, stableSerialize(layout));
  }
  return entries;
}

function collectIdlTypeLayouts(idl: Idl): Map<string, string> {
  const source = (idl as unknown as Record<string, unknown>).types;
  if (!Array.isArray(source)) {
    throw new Error('IDL integrity check failed: missing types array');
  }

  const entries = new Map<string, string>();
  for (const rawEntry of source) {
    const entry = toRecord(rawEntry);
    if (!entry || typeof entry.name !== 'string') {
      continue;
    }
    entries.set(entry.name, stableSerialize(entry.type ?? null));
  }
  return entries;
}

export function validateIdlIntegrity(suppliedIdl: Idl, canonicalIdl: Idl): void {
  const sections: Array<'instructions' | 'accounts'> = ['instructions', 'accounts'];

  for (const section of sections) {
    const supplied = collectIdlDiscriminators(suppliedIdl, section);
    const canonical = collectIdlDiscriminators(canonicalIdl, section);
    const suppliedLayouts = collectIdlLayouts(suppliedIdl, section);
    const canonicalLayouts = collectIdlLayouts(canonicalIdl, section);

    for (const [name, expectedDiscriminator] of canonical.entries()) {
      const actualDiscriminator = supplied.get(name);
      if (!actualDiscriminator) {
        throw new Error(`IDL integrity check failed: missing ${section.slice(0, -1)} "${name}"`);
      }
      if (actualDiscriminator !== expectedDiscriminator) {
        throw new Error(
          `IDL integrity check failed: ${section.slice(0, -1)} "${name}" discriminator mismatch`
        );
      }
    }

    for (const [name, expectedLayout] of canonicalLayouts.entries()) {
      const actualLayout = suppliedLayouts.get(name);
      if (!actualLayout) {
        throw new Error(`IDL integrity check failed: missing ${section.slice(0, -1)} "${name}" layout`);
      }
      if (actualLayout !== expectedLayout) {
        throw new Error(
          `IDL integrity check failed: ${section.slice(0, -1)} "${name}" layout mismatch`
        );
      }
    }
  }

  const suppliedTypes = collectIdlTypeLayouts(suppliedIdl);
  const canonicalTypes = collectIdlTypeLayouts(canonicalIdl);
  for (const [name, expectedLayout] of canonicalTypes.entries()) {
    const actualLayout = suppliedTypes.get(name);
    if (!actualLayout) {
      throw new Error(`IDL integrity check failed: missing type "${name}"`);
    }
    if (actualLayout !== expectedLayout) {
      throw new Error(`IDL integrity check failed: type "${name}" layout mismatch`);
    }
  }
}

export function validateTransactionBuildResponse(response: unknown): TransactionBuildResponse {
  const body = toRecord(response);
  if (!body) {
    throw new Error('Invalid transaction build response: expected an object payload');
  }

  if (typeof body.unsignedTransaction !== 'string' || body.unsignedTransaction.trim().length === 0) {
    throw new Error('Invalid transaction build response: unsignedTransaction must be a non-empty string');
  }

  const normalizedUnsignedTransaction = body.unsignedTransaction.trim();
  try {
    decodeSerializedTransaction(normalizedUnsignedTransaction, { validateProgramIds: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown decode error';
    throw new Error(`Invalid transaction build response: unsignedTransaction failed to decode (${message})`);
  }

  return {
    ...body,
    unsignedTransaction: normalizedUnsignedTransaction,
  } as TransactionBuildResponse;
}
