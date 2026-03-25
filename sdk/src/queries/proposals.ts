import type { StendarApiClient } from '../client';

export class ProposalQueries {
  constructor(private readonly api: StendarApiClient) {}

  list(contractAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/contracts/${contractAddress}/proposals`);
  }

  getActive(contractAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/contracts/${contractAddress}/proposals/active`);
  }

  get(contractAddress: string, proposalId: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/${contractAddress}/proposals/${proposalId}`
    );
  }

  getCooldown(contractAddress: string, walletAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/${contractAddress}/proposals/cooldown/${walletAddress}`
    );
  }
}
