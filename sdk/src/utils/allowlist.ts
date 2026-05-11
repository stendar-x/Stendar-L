import type { AccountInfo, Connection } from '@solana/web3.js';
import { deriveApprovedFunderPda } from './pda';

export interface ApprovedFunderCheck {
  contractAddress: string;
  lenderAddress: string;
}

const MULTIPLE_ACCOUNTS_CHUNK_SIZE = 100;

function toCheckKey(contractAddress: string, lenderAddress: string): string {
  return `${contractAddress}:${lenderAddress}`;
}

function accountExists(data: AccountInfo<Buffer> | null | undefined): boolean {
  return data !== null && data !== undefined && data.data.length > 0;
}

export async function isApprovedFunder(
  connection: Connection,
  contractAddress: string,
  lenderAddress: string,
  programId?: string
): Promise<boolean> {
  const approvedFunderPda = deriveApprovedFunderPda(contractAddress, lenderAddress, programId);
  const accountInfo = await connection.getAccountInfo(approvedFunderPda);
  return accountExists(accountInfo);
}

export async function batchCheckApprovedFunders(
  connection: Connection,
  checks: ReadonlyArray<ApprovedFunderCheck>,
  programId?: string
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (checks.length === 0) {
    return result;
  }

  const derivedChecks = checks.map((check) => ({
    key: toCheckKey(check.contractAddress, check.lenderAddress),
    pda: deriveApprovedFunderPda(check.contractAddress, check.lenderAddress, programId),
  }));

  for (let start = 0; start < derivedChecks.length; start += MULTIPLE_ACCOUNTS_CHUNK_SIZE) {
    const chunk = derivedChecks.slice(start, start + MULTIPLE_ACCOUNTS_CHUNK_SIZE);
    const accounts = await connection.getMultipleAccountsInfo(chunk.map((entry) => entry.pda));

    for (let i = 0; i < chunk.length; i += 1) {
      const entry = chunk[i];
      result.set(entry.key, accountExists(accounts[i]));
    }
  }

  return result;
}
