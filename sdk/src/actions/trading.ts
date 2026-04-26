import type { StendarApiClient } from '../http-client';
import {
  TradeAcceptOfferRequest,
  TradeCreateListingRequest,
  TradeCreateOfferRequest,
  TradeSubmitRequest,
  TransactionBuildResponse,
  TransactionSubmissionResponse,
} from '../types';
import { withSubmissionId } from '../utils/idempotency';
import { validateSolanaAddress, validateTransactionBuildResponse } from '../utils/validation';

type TradeSubmitRequestInput = Omit<TradeSubmitRequest, 'submissionId'> & {
  submissionId?: string;
};

export class TradingActions {
  constructor(private readonly api: StendarApiClient) {}

  private async postTransactionBuild(path: string, body: unknown): Promise<TransactionBuildResponse> {
    const response = await this.api.post<TransactionBuildResponse>(path, body);
    return validateTransactionBuildResponse(response);
  }

  async createListingTransaction(request: TradeCreateListingRequest): Promise<TransactionBuildResponse> {
    validateSolanaAddress(request.sellerAddress, 'sellerAddress');
    validateSolanaAddress(request.contributionAddress, 'contributionAddress');
    if (request.contractAddress) {
      validateSolanaAddress(request.contractAddress, 'contractAddress');
    }
    return this.postTransactionBuild('/api/trading/listings/create-transaction', request);
  }

  cancelListingTransaction(request: {
    listingAddress: string;
    sellerAddress: string;
  }): Promise<TransactionBuildResponse> {
    const listingAddress = validateSolanaAddress(request.listingAddress, 'listingAddress');
    const sellerAddress = validateSolanaAddress(request.sellerAddress, 'sellerAddress');
    return this.postTransactionBuild(
      `/api/trading/listings/${listingAddress}/cancel-transaction`,
      {
        sellerAddress,
      }
    );
  }

  submitListingTransaction(request: TradeSubmitRequestInput): Promise<TransactionSubmissionResponse> {
    return this.api.post<TransactionSubmissionResponse>(
      '/api/trading/listings/submit-transaction',
      withSubmissionId(request)
    );
  }

  async createOfferTransaction(request: TradeCreateOfferRequest): Promise<TransactionBuildResponse> {
    validateSolanaAddress(request.buyerAddress, 'buyerAddress');
    validateSolanaAddress(request.listingAddress, 'listingAddress');
    return this.postTransactionBuild('/api/trading/offers/create-transaction', request);
  }

  async acceptOfferTransaction(request: TradeAcceptOfferRequest): Promise<TransactionBuildResponse> {
    const offerAddress = validateSolanaAddress(request.offerAddress, 'offerAddress');
    const sellerAddress = validateSolanaAddress(request.sellerAddress, 'sellerAddress');
    const listingAddress = validateSolanaAddress(request.listingAddress, 'listingAddress');
    return this.postTransactionBuild(
      `/api/trading/offers/${offerAddress}/accept-transaction`,
      {
        sellerAddress,
        listingAddress,
        nonce: request.nonce,
      }
    );
  }

  submitOfferTransaction(request: TradeSubmitRequestInput): Promise<TransactionSubmissionResponse> {
    return this.api.post<TransactionSubmissionResponse>(
      '/api/trading/offers/submit-transaction',
      withSubmissionId(request)
    );
  }
}
