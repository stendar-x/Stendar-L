import type { StendarApiClient } from '../client';
import type { TradeEventsQuery } from '../types';

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
    return this.api.get<Record<string, unknown>>(`/api/trading/listings/contract/${contractAddress}`);
  }

  getListingsBySeller(walletAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/trading/listings/seller/${walletAddress}`);
  }

  getListing(listingAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/trading/listings/${listingAddress}`);
  }

  getOffersByListing(listingAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/trading/listings/${listingAddress}/offers`);
  }

  getOffersByBuyer(buyerAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/trading/offers/buyer/${buyerAddress}`);
  }

  getOffer(offerAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/trading/offers/${offerAddress}`);
  }

  getPositionValue(contractAddress: string, lenderAddress: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/trading/position/${contractAddress}/${lenderAddress}/value`
    );
  }

  getEvents(filters: TradeEventsQuery = {}): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/trading/events${toQueryString({
        contractAddress: filters.contractAddress,
        lenderAddress: filters.lenderAddress,
      })}`
    );
  }
}
