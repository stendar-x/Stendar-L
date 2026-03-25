import type { StendarApiClient } from '../client';
import { ContractsQuery } from '../types';

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
    return this.api.get<Record<string, unknown>>(`/api/contracts/${contractAddress}`);
  }

  getByStatus(status: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/contracts/status/${status}`);
  }

  getEscrows(contractAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/contracts/${contractAddress}/escrows`);
  }

  getHealth(contractAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/contracts/${contractAddress}/health`);
  }

  getContributions(contractAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/contracts/${contractAddress}/contributions`);
  }

  getByBorrower(borrowerAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/profile/${borrowerAddress}/contracts`);
  }

  getPaymentsDue(): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>('/api/contracts/payments-due');
  }

  getPosition(contractAddress: string, lenderAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/${contractAddress}/position/${lenderAddress}`
    );
  }

  getLenderContributions(lenderAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/lender/${lenderAddress}/contributions`);
  }
}
