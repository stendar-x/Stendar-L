import type { StendarApiClient } from '../client';

export class WalletQueries {
  constructor(private readonly api: StendarApiClient) {}

  getBalance(walletAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/wallet/${walletAddress}/balance`);
  }

  getTokenBalance(walletAddress: string, tokenMint: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/wallet/${walletAddress}/token-balance/${tokenMint}`
    );
  }
}
