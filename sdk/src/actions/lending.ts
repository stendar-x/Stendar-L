import { TransactionInstruction } from '@solana/web3.js';
import type { StendarApiClient } from '../client';
import { StendarProgramClient } from '../program';
import {
  ApproveFunderRequest,
  CancelContractRequest,
  ClaimFromEscrowRequest,
  ContractCreationRequest,
  ContributeRequest,
  DirectApproveFunderInstructionRequest,
  DirectCancelContractInstructionRequest,
  DirectClaimFromEscrowInstructionRequest,
  DirectContributeInstructionRequest,
  DirectMakePaymentInstructionRequest,
  DirectRefundLenderInstructionRequest,
  MakePaymentWithDistributionRequest,
  RefundLenderRequest,
  StendarClientMode,
  TransactionBuildResponse,
  TransactionSubmissionRequest,
  TransactionSubmissionResponse,
} from '../types';

export class LendingActions {
  constructor(
    private readonly api: StendarApiClient,
    private readonly mode: StendarClientMode,
    private readonly program?: StendarProgramClient
  ) {}

  private requireProgram(): StendarProgramClient {
    if (!this.program) {
      throw new Error('Direct mode requires a StendarProgramClient configuration');
    }
    return this.program;
  }

  createContractTransaction(request: ContractCreationRequest): Promise<TransactionBuildResponse> {
    return this.api.post<TransactionBuildResponse>('/api/contracts/create-transaction', request);
  }

  createStandardContractTransaction(request: ContractCreationRequest): Promise<TransactionBuildResponse> {
    return this.api.post<TransactionBuildResponse>('/api/contracts/create-standard-transaction', request);
  }

  requestRecallTransaction(request: {
    contractAddress: string;
    lenderAddress: string;
    contributionAddress: string;
  }): Promise<TransactionBuildResponse> {
    return this.api.post<TransactionBuildResponse>(
      `/api/contracts/${request.contractAddress}/request-recall`,
      request
    );
  }

  repayRecallTransaction(request: {
    contractAddress: string;
    borrowerAddress: string;
    contributionAddress: string;
    escrowAddress: string;
    borrowerUsdcAta: string;
    escrowUsdcAta: string;
    contractCollateralAta: string;
    borrowerCollateralAta: string;
  }): Promise<TransactionBuildResponse> {
    return this.api.post<TransactionBuildResponse>(
      `/api/contracts/${request.contractAddress}/repay-recall`,
      request
    );
  }

  addCollateralTransaction(request: {
    contractAddress: string;
    borrowerAddress: string;
    borrowerCollateralAta: string;
    contractCollateralAta: string;
    collateralAmount: number;
  }): Promise<TransactionBuildResponse> {
    return this.api.post<TransactionBuildResponse>(
      `/api/contracts/${request.contractAddress}/add-collateral`,
      request
    );
  }

  closeListingTransaction(request: {
    contractAddress: string;
    borrowerAddress: string;
    contractUsdcAccount?: string;
    borrowerUsdcAccount?: string;
  }): Promise<TransactionBuildResponse> {
    return this.api.post<TransactionBuildResponse>(
      `/api/contracts/${request.contractAddress}/close-listing`,
      request
    );
  }

  async contribute(
    request: ContributeRequest | DirectContributeInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().contributeToContract(request as DirectContributeInstructionRequest);
    }
    const apiRequest = request as ContributeRequest;
    return this.api.post<TransactionBuildResponse>(
      `/api/contracts/${apiRequest.contractAddress}/contribute`,
      apiRequest
    );
  }

  async makePaymentWithDistribution(
    request: MakePaymentWithDistributionRequest | DirectMakePaymentInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().makePaymentWithDistribution(
        request as DirectMakePaymentInstructionRequest
      );
    }
    const apiRequest = request as MakePaymentWithDistributionRequest;
    return this.api.post<TransactionBuildResponse>(
      `/api/contracts/${apiRequest.contractAddress}/make-payment`,
      apiRequest
    );
  }

  async claimFromEscrow(
    request: ClaimFromEscrowRequest | DirectClaimFromEscrowInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().claimFromEscrow(request as DirectClaimFromEscrowInstructionRequest);
    }
    const apiRequest = request as ClaimFromEscrowRequest;
    return this.api.post<TransactionBuildResponse>(
      `/api/contracts/${apiRequest.contractAddress}/claim-escrow`,
      apiRequest
    );
  }

  async refundLender(
    request: RefundLenderRequest | DirectRefundLenderInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().refundLender(request as DirectRefundLenderInstructionRequest);
    }
    const apiRequest = request as RefundLenderRequest;
    return this.api.post<TransactionBuildResponse>(
      `/api/contracts/${apiRequest.contractAddress}/refund`,
      apiRequest
    );
  }

  async approveFunder(
    request: ApproveFunderRequest | DirectApproveFunderInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().approveFunder(request as DirectApproveFunderInstructionRequest);
    }
    const apiRequest = request as ApproveFunderRequest;
    return this.api.post<TransactionBuildResponse>(
      `/api/contracts/${apiRequest.contractAddress}/approve-funder`,
      apiRequest
    );
  }

  async cancelContract(
    request: CancelContractRequest | DirectCancelContractInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().cancelContract(request as DirectCancelContractInstructionRequest);
    }
    const apiRequest = request as CancelContractRequest;
    return this.api.post<TransactionBuildResponse>(
      `/api/contracts/${apiRequest.contractAddress}/cancel`,
      apiRequest
    );
  }

  submitTransaction(request: TransactionSubmissionRequest): Promise<TransactionSubmissionResponse> {
    return this.api.post<TransactionSubmissionResponse>('/api/contracts/submit-transaction', request);
  }

  getTransactionStatus(signature: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(`/api/contracts/transaction-status/${signature}`);
  }
}
