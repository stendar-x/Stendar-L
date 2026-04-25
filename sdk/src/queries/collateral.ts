import type { StendarApiClient } from '../http-client';
import type { CollateralPriceResponse, CollateralRegistryResponse } from '../types';
import { validateSolanaAddress } from '../utils/validation';

export class CollateralQueries {
  constructor(private readonly api: StendarApiClient) {}

  getRegistry(): Promise<CollateralRegistryResponse> {
    return this.api.get<CollateralRegistryResponse>('/api/collateral/registry');
  }

  getPrice(mint: string): Promise<CollateralPriceResponse> {
    const normalizedMint = validateSolanaAddress(mint, 'mint');
    return this.api.get<CollateralPriceResponse>(`/api/collateral/price/${normalizedMint}`);
  }
}
