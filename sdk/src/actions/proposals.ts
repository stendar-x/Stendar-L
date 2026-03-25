import { TransactionInstruction } from '@solana/web3.js';
import type { StendarApiClient } from '../client';
import { StendarProgramClient } from '../program';
import {
  CancelTermProposalRequest,
  CloseProposalAccountsRequest,
  CreateTermProposalRequest,
  DirectCancelTermProposalInstructionRequest,
  DirectCloseProposalAccountsInstructionRequest,
  DirectCreateTermProposalInstructionRequest,
  DirectExpireTermProposalInstructionRequest,
  DirectVoteOnProposalInstructionRequest,
  ExpireTermProposalRequest,
  StendarClientMode,
  TransactionBuildResponse,
  VoteOnProposalRequest,
} from '../types';

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

  async createTermProposal(
    request: CreateTermProposalRequest | DirectCreateTermProposalInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().createTermProposal(request as DirectCreateTermProposalInstructionRequest);
    }
    return this.api.post<TransactionBuildResponse>('/api/proposals/create', request);
  }

  async voteOnProposal(
    request: VoteOnProposalRequest | DirectVoteOnProposalInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().voteOnProposal(request as DirectVoteOnProposalInstructionRequest);
    }
    const apiRequest = request as VoteOnProposalRequest;
    return this.api.post<TransactionBuildResponse>(
      `/api/proposals/${apiRequest.contractAddress}/vote`,
      apiRequest
    );
  }

  async cancelTermProposal(
    request: CancelTermProposalRequest | DirectCancelTermProposalInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().cancelTermProposal(request as DirectCancelTermProposalInstructionRequest);
    }
    const apiRequest = request as CancelTermProposalRequest;
    return this.api.post<TransactionBuildResponse>(
      `/api/proposals/${apiRequest.contractAddress}/cancel`,
      apiRequest
    );
  }

  async expireTermProposal(
    request: ExpireTermProposalRequest | DirectExpireTermProposalInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().expireTermProposal(request as DirectExpireTermProposalInstructionRequest);
    }
    const apiRequest = request as ExpireTermProposalRequest;
    return this.api.post<TransactionBuildResponse>(
      `/api/proposals/${apiRequest.contractAddress}/expire`,
      apiRequest
    );
  }

  async closeProposalAccounts(
    request: CloseProposalAccountsRequest | DirectCloseProposalAccountsInstructionRequest
  ): Promise<TransactionBuildResponse | TransactionInstruction> {
    if (this.mode === 'direct') {
      return this.requireProgram().closeProposalAccounts(
        request as DirectCloseProposalAccountsInstructionRequest
      );
    }
    const apiRequest = request as CloseProposalAccountsRequest;
    return this.api.post<TransactionBuildResponse>(
      `/api/proposals/${apiRequest.contractAddress}/close`,
      apiRequest
    );
  }
}
