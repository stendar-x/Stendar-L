import type { StendarApiClient } from '../http-client';
import { validateSolanaAddress } from '../utils/validation';

export class WalletQueries {
  constructor(private readonly api: StendarApiClient) {}

  getBalance(walletAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/wallet/${validateSolanaAddress(walletAddress, 'walletAddress')}/balance`
    );
  }

  getTokenBalance(walletAddress: string, tokenMint: string): Promise<Record<string, unknown>> {
    const normalizedWalletAddress = validateSolanaAddress(walletAddress, 'walletAddress');
    const normalizedTokenMint = validateSolanaAddress(tokenMint, 'tokenMint');
    return this.api.get<Record<string, unknown>>(
      `/api/wallet/${normalizedWalletAddress}/token-balance/${normalizedTokenMint}`
    );
  }
}
