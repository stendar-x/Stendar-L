import type { StendarApiClient } from '../http-client';
import type { TradeEventsQuery } from '../types';
import { validateSolanaAddress } from '../utils/validation';

function toQueryString(params: Record<string, string | number | undefined>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    searchParams.set(key, String(value));
  }
  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : '';
}

export class TradingQueries {
  constructor(private readonly api: StendarApiClient) {}

  listListings(filters?: {
    contractAddress?: string;
    sellerAddress?: string;
  }): Promise<Record<string, unknown>> {
    if (filters?.contractAddress) {
      return this.getListingsByContract(filters.contractAddress);
    }
    if (filters?.sellerAddress) {
      return this.getListingsBySeller(filters.sellerAddress);
    }
    return this.api.get<Record<string, unknown>>('/api/trading/listings');
  }

  getListingsByContract(contractAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/trading/listings/contract/${validateSolanaAddress(contractAddress, 'contractAddress')}`
    );
  }

  getListingsBySeller(walletAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/trading/listings/seller/${validateSolanaAddress(walletAddress, 'walletAddress')}`
    );
  }

  getListing(listingAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/trading/listings/${validateSolanaAddress(listingAddress, 'listingAddress')}`
    );
  }

  getOffersByListing(listingAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/trading/listings/${validateSolanaAddress(listingAddress, 'listingAddress')}/offers`
    );
  }

  getOffersByBuyer(buyerAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/trading/offers/buyer/${validateSolanaAddress(buyerAddress, 'buyerAddress')}`
    );
  }

  getOffer(offerAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/trading/offers/${validateSolanaAddress(offerAddress, 'offerAddress')}`
    );
  }

  getPositionValue(contractAddress: string, lenderAddress: string): Promise<Record<string, unknown>> {
    const normalizedContractAddress = validateSolanaAddress(contractAddress, 'contractAddress');
    const normalizedLenderAddress = validateSolanaAddress(lenderAddress, 'lenderAddress');
    return this.api.get<Record<string, unknown>>(
      `/api/trading/position/${normalizedContractAddress}/${normalizedLenderAddress}/value`
    );
  }

  getEvents(filters: TradeEventsQuery = {}): Promise<Record<string, unknown>> {
    const contractAddress = filters.contractAddress
      ? validateSolanaAddress(filters.contractAddress, 'contractAddress')
      : undefined;
    const lenderAddress = filters.lenderAddress
      ? validateSolanaAddress(filters.lenderAddress, 'lenderAddress')
      : undefined;
    return this.api.get<Record<string, unknown>>(
      `/api/trading/events${toQueryString({
        contractAddress,
        lenderAddress,
      })}`
    );
  }
}
