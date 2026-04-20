import type { StendarApiClient } from '../client';
import { validatePathSegment, validateSolanaAddress } from '../utils/validation';

export class ProposalQueries {
  constructor(private readonly api: StendarApiClient) {}

  list(contractAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/${validateSolanaAddress(contractAddress, 'contractAddress')}/proposals`
    );
  }

  getActive(contractAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/${validateSolanaAddress(contractAddress, 'contractAddress')}/proposals/active`
    );
  }

  get(contractAddress: string, proposalId: string): Promise<Record<string, unknown>> {
    const normalizedContractAddress = validateSolanaAddress(contractAddress, 'contractAddress');
    const normalizedProposalId = validatePathSegment(proposalId, 'proposalId');
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/${normalizedContractAddress}/proposals/${normalizedProposalId}`
    );
  }

  getCooldown(contractAddress: string, walletAddress: string): Promise<Record<string, unknown>> {
    const normalizedContractAddress = validateSolanaAddress(contractAddress, 'contractAddress');
    const normalizedWalletAddress = validateSolanaAddress(walletAddress, 'walletAddress');
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/${normalizedContractAddress}/proposals/cooldown/${normalizedWalletAddress}`
    );
  }
}
