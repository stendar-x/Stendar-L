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
  DirectWithdrawContributionInstructionRequest,
  MakePaymentWithDistributionRequest,
  RefundLenderRequest,
  StendarClientMode,
  TransactionBuildResponse,
  TransactionSubmissionRequest,
  TransactionSubmissionResponse,
  WithdrawContributionRequest,
} from '../types';
import { withSubmissionId } from '../utils/idempotency';
import {
  validatePathSegment,
  validateSolanaAddress,
  validateTransactionBuildResponse,
} from '../utils/validation';

type TransactionSubmissionRequestInput = Omit<TransactionSubmissionRequest, 'submissionId'> & {
  submissionId?: string;
};

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

  private async postTransactionBuild(path: string, body: unknown): Promise<TransactionBuildResponse> {
    const response = await this.api.post<TransactionBuildResponse>(path, body);
    return validateTransactionBuildResponse(response);
  }

  private toDirectContributeRequest(
    request: ContributeRequest | DirectContributeInstructionRequest
  ): DirectContributeInstructionRequest {
    if (!request.borrowerAddress) {
      throw new Error('Direct mode requires borrowerAddress');
    }
    return {
      ...request,
      borrowerAddress: request.borrowerAddress,
    };
  }

  private toDirectClaimFromEscrowRequest(
    request: ClaimFromEscrowRequest | DirectClaimFromEscrowInstructionRequest
  ): DirectClaimFromEscrowInstructionRequest {
    if (!request.escrowAddress) {
      throw new Error('Direct mode requires escrowAddress');
    }
    return {
      ...request,
      escrowAddress: request.escrowAddress,
    };
  }

  private toDirectRefundLenderRequest(
    request: RefundLenderRequest | DirectRefundLenderInstructionRequest
  ): DirectRefundLenderInstructionRequest {
    if (!request.contributionAddress || !request.escrowAddress) {
      throw new Error('Direct mode requires contributionAddress and escrowAddress');
    }
    return {
      ...request,
      contributionAddress: request.contributionAddress,
      escrowAddress: request.escrowAddress,
    };
  }

  async createContractTransaction(request: ContractCreationRequest): Promise<TransactionBuildResponse> {
    validateSolanaAddress(request.borrowerAddress, 'borrowerAddress');
    return this.postTransactionBuild('/api/contracts/create-transaction', request);
  }

  async createStandardContractTransaction(request: ContractCreationRequest): Promise<TransactionBuildResponse> {
    validateSolanaAddress(request.borrowerAddress, 'borrowerAddress');
    return this.postTransactionBuild('/api/contracts/create-standard-transaction', request);
  }

  requestRecallTransaction(request: {
    contractAddress: string;
    lenderAddress: string;
    contributionAddress: string;
  }): Promise<TransactionBuildResponse> {
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/contracts/${contractAddress}/request-recall`,
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
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/contracts/${contractAddress}/repay-recall`,
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
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/contracts/${contractAddress}/add-collateral`,
      request
    );
  }

  closeListingTransaction(request: {
    contractAddress: string;
    borrowerAddress: string;
    contractUsdcAccount?: string;
    borrowerUsdcAccount?: string;
  }): Promise<TransactionBuildResponse> {
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/contracts/${contractAddress}/close-listing`,
      request
    );
  }

  async contribute(
    request: ContributeRequest | DirectContributeInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().contributeToContract(this.toDirectContributeRequest(request));
    }
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/contracts/${contractAddress}/contribute`,
      request
    );
  }

  async makePaymentWithDistribution(
    request: MakePaymentWithDistributionRequest | DirectMakePaymentInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().makePaymentWithDistribution(request);
    }
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/contracts/${contractAddress}/make-payment`,
      request
    );
  }

  async claimFromEscrow(
    request: ClaimFromEscrowRequest | DirectClaimFromEscrowInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().claimFromEscrow(this.toDirectClaimFromEscrowRequest(request));
    }
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/contracts/${contractAddress}/claim-escrow`,
      request
    );
  }

  async refundLender(
    request: RefundLenderRequest | DirectRefundLenderInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().refundLender(this.toDirectRefundLenderRequest(request));
    }
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/contracts/${contractAddress}/refund`,
      request
    );
  }

  async withdrawContribution(
    request: WithdrawContributionRequest | DirectWithdrawContributionInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().withdrawContribution(request);
    }
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/contracts/${contractAddress}/withdraw-contribution`,
      request
    );
  }

  async approveFunder(
    request: ApproveFunderRequest | DirectApproveFunderInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().approveFunder(request);
    }
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/contracts/${contractAddress}/approve-funder`,
      request
    );
  }

  async cancelContract(
    request: CancelContractRequest | DirectCancelContractInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().cancelContract(request);
    }
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/contracts/${contractAddress}/cancel`,
      request
    );
  }

  submitTransaction(request: TransactionSubmissionRequestInput): Promise<TransactionSubmissionResponse> {
    return this.api.post<TransactionSubmissionResponse>(
      '/api/contracts/submit-transaction',
      withSubmissionId(request)
    );
  }

  getTransactionStatus(signature: string): Promise<Record<string, unknown>> {
    return this.api.get<Record<string, unknown>>(
      `/api/contracts/transaction-status/${validatePathSegment(signature, 'signature')}`
    );
  }
}
