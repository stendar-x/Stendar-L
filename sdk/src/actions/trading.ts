import type { StendarApiClient } from '../client';
import {
  TradeAcceptOfferRequest,
  TradeCreateListingRequest,
  TradeCreateOfferRequest,
  TradeSubmitRequest,
  TransactionBuildResponse,
  TransactionSubmissionResponse,
} from '../types';

export class TradingActions {
  constructor(private readonly api: StendarApiClient) {}

  createListingTransaction(request: TradeCreateListingRequest): Promise<TransactionBuildResponse> {
    return this.api.post<TransactionBuildResponse>('/api/trading/listings/create-transaction', request);
  }

  cancelListingTransaction(request: {
    listingAddress: string;
    sellerAddress: string;
  }): Promise<TransactionBuildResponse> {
    return this.api.post<TransactionBuildResponse>(
      `/api/trading/listings/${request.listingAddress}/cancel-transaction`,
      {
        sellerAddress: request.sellerAddress,
      }
    );
  }

  submitListingTransaction(request: TradeSubmitRequest): Promise<TransactionSubmissionResponse> {
    return this.api.post<TransactionSubmissionResponse>('/api/trading/listings/submit-transaction', request);
  }

  createOfferTransaction(request: TradeCreateOfferRequest): Promise<TransactionBuildResponse> {
    return this.api.post<TransactionBuildResponse>('/api/trading/offers/create-transaction', request);
  }

  acceptOfferTransaction(request: TradeAcceptOfferRequest): Promise<TransactionBuildResponse> {
    return this.api.post<TransactionBuildResponse>(
      `/api/trading/offers/${request.offerAddress}/accept-transaction`,
      {
        sellerAddress: request.sellerAddress,
        listingAddress: request.listingAddress,
        nonce: request.nonce,
      }
    );
  }

  submitOfferTransaction(request: TradeSubmitRequest): Promise<TransactionSubmissionResponse> {
    return this.api.post<TransactionSubmissionResponse>('/api/trading/offers/submit-transaction', request);
  }
}
