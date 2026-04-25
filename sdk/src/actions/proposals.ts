import { TransactionInstruction } from '@solana/web3.js';
import type { StendarApiClient } from '../http-client';
import { StendarProgramClient } from '../program';
import {
  CancelTermProposalRequest,
  CloseProposalAccountsRequest,
  CreateTermProposalRequest,
  DirectCancelTermProposalInstructionRequest,
  DirectCloseProposalAccountsInstructionRequest,
  DirectCreateTermProposalInstructionRequest,
  DirectExpireTermProposalInstructionRequest,
  DirectProcessProposalRecallInstructionRequest,
  DirectVoteOnProposalInstructionRequest,
  ExpireTermProposalRequest,
  ProcessProposalRecallRequest,
  StendarClientMode,
  TransactionBuildResponse,
  VoteOnProposalRequest,
} from '../types';
import { validateSolanaAddress, validateTransactionBuildResponse } from '../utils/validation';

export class ProposalActions {
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

  async createTermProposal(
    request: CreateTermProposalRequest | DirectCreateTermProposalInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().createTermProposal(request);
    }
    return this.postTransactionBuild('/api/proposals/create', request);
  }

  async voteOnProposal(
    request: VoteOnProposalRequest | DirectVoteOnProposalInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().voteOnProposal(request);
    }
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/proposals/${contractAddress}/vote`,
      request
    );
  }

  async cancelTermProposal(
    request: CancelTermProposalRequest | DirectCancelTermProposalInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().cancelTermProposal(request);
    }
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/proposals/${contractAddress}/cancel`,
      request
    );
  }

  async expireTermProposal(
    request: ExpireTermProposalRequest | DirectExpireTermProposalInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().expireTermProposal(request);
    }
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/proposals/${contractAddress}/expire`,
      request
    );
  }

  async closeProposalAccounts(
    request: CloseProposalAccountsRequest | DirectCloseProposalAccountsInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().closeProposalAccounts(request);
    }
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/proposals/${contractAddress}/close`,
      request
    );
  }

  async processProposalRecall(
    request: ProcessProposalRecallRequest | DirectProcessProposalRecallInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().processProposalRecall(request);
    }
    const contractAddress = validateSolanaAddress(request.contractAddress, 'contractAddress');
    return this.postTransactionBuild(
      `/api/proposals/${contractAddress}/process-recall`,
      request
    );
  }
}
