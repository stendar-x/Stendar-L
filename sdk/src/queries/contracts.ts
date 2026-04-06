import type { StendarApiClient } from '../client';
import { ContractsQuery } from '../types';
import { validatePathSegment, validateSolanaAddress } from '../utils/validation';

function toQueryString(filters: ContractsQuery): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        searchParams.append(key, entry);
      }
      continue;
    }
    searchParams.append(key, String(value));
  }
  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : '';
}

export class ContractsQueries {
  constructor(private readonly api: StendarApiClient) {}

  list(filters: ContractsQuery = {}): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/contracts${toQueryString(filters)}`);
  }

  get(contractAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/${validateSolanaAddress(contractAddress, 'contractAddress')}`
    );
  }

  getByStatus(status: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/status/${validatePathSegment(status, 'status')}`
    );
  }

  getEscrows(contractAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/${validateSolanaAddress(contractAddress, 'contractAddress')}/escrows`
    );
  }

  getHealth(contractAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/${validateSolanaAddress(contractAddress, 'contractAddress')}/health`
    );
  }

  getContributions(contractAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/${validateSolanaAddress(contractAddress, 'contractAddress')}/contributions`
    );
  }

  getByBorrower(borrowerAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/profile/${validateSolanaAddress(borrowerAddress, 'borrowerAddress')}/contracts`
    );
  }

  getPaymentsDue(): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>('/api/contracts/payments-due');
  }

  getPosition(contractAddress: string, lenderAddress: string): Promise<Record<string, unknown>> {
    const normalizedContractAddress = validateSolanaAddress(contractAddress, 'contractAddress');
    const normalizedLenderAddress = validateSolanaAddress(lenderAddress, 'lenderAddress');
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/${normalizedContractAddress}/position/${normalizedLenderAddress}`
    );
  }

  getLenderContributions(lenderAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/lender/${validateSolanaAddress(lenderAddress, 'lenderAddress')}/contributions`
    );
  }
}
