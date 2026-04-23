import type { StendarApiClient } from '../client';
import { validateSolanaAddress } from '../utils/validation';

export class CollateralQueries {
  constructor(private readonly api: StendarApiClient) {}

  getRegistry(): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>('/api/collateral/registry');
  }

  getPrice(mint: string): Promise<Record<string, unknown>> {
    const normalizedMint = validateSolanaAddress(mint, 'mint');
    return this.api.get<Record<string, unknown>>(`/api/collateral/price/${normalizedMint}`);
  }
}
