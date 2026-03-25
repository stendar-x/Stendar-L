import { AnchorProvider, BN, Idl, Program } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  DirectApproveFunderInstructionRequest,
  DirectCancelContractInstructionRequest,
  DirectCancelTermProposalInstructionRequest,
  DirectClaimFromEscrowInstructionRequest,
  DirectCloseProposalAccountsInstructionRequest,
  DirectContributeInstructionRequest,
  DirectCreateTermProposalInstructionRequest,
  DirectExpireTermProposalInstructionRequest,
  DirectMakePaymentInstructionRequest,
  DirectProgramConfig,
  DirectRefundLenderInstructionRequest,
  DirectVoteOnProposalInstructionRequest,
  InterestPaymentTypeInput,
  PaymentFrequencyInput,
  PrincipalPaymentTypeInput,
  VoteChoiceInput,
} from './types';
import {
  deriveApprovedFunderPda,
  deriveContributionPda,
  deriveEscrowPda,
  deriveGlobalStatePda,
  deriveProposalVotePda,
  deriveProposerCooldownPda,
  deriveTermProposalPda,
  resolveProgramId,
} from './utils/pda';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

function toProposalIdBn(value: string | number | bigint): BN {
  if (typeof value === 'bigint') {
    return new BN(value.toString());
  }
  return new BN(value);
}

function normalizePaymentFrequency(value: PaymentFrequencyInput): { daily?: {}; weekly?: {}; biWeekly?: {}; monthly?: {} } {
  switch (value.toLowerCase()) {
    case 'daily':
      return { daily: {} };
    case 'weekly':
      return { weekly: {} };
    case 'biweekly':
    case 'bi_weekly':
    case 'bi-weekly':
      return { biWeekly: {} };
    default:
      return { monthly: {} };
  }
}

function normalizeInterestPaymentType(
  value: InterestPaymentTypeInput
): { outstandingBalance?: {}; collateralTransfer?: {} } {
  if (value.toLowerCase() === 'collateraltransfer' || value.toLowerCase() === 'collateral_transfer') {
    return { collateralTransfer: {} };
  }
  return { outstandingBalance: {} };
}

function normalizePrincipalPaymentType(
  value: PrincipalPaymentTypeInput
): { collateralDeduction?: {}; noFixedPayment?: {} } {
  if (value.toLowerCase() === 'collateraldeduction' || value.toLowerCase() === 'collateral_deduction') {
    return { collateralDeduction: {} };
  }
  return { noFixedPayment: {} };
}

function normalizeVoteChoice(value: VoteChoiceInput): { approve?: {}; reject?: {} } {
  return value.toLowerCase() === 'reject' ? { reject: {} } : { approve: {} };
}

export class StendarProgramClient {
  private readonly program: Program<Idl>;
  private readonly programId: PublicKey;

  constructor(config: DirectProgramConfig) {
    const programId = resolveProgramId(config.programId);
    const provider = new AnchorProvider(config.connection, config.wallet as any, {
      commitment: config.commitment ?? 'confirmed',
    });
    const idlWithAddress = {
      ...(config.idl as Record<string, unknown>),
      address: programId.toBase58(),
    } as Idl;

    this.programId = programId;
    this.program = new Program(idlWithAddress, provider);
  }

  getProgram(): Program<Idl> {
    return this.program;
  }

  getProgramId(): PublicKey {
    return this.programId;
  }

  private optionalPublicKey(value?: string | null): PublicKey | null {
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return new PublicKey(trimmed);
  }

  private async buildInstruction(
    methodName: string,
    args: unknown[],
    accounts: Record<string, unknown>,
    remainingAccounts?: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>
  ): Promise<TransactionInstruction> {
    const methodFactory = (this.program.methods as Record<string, (...methodArgs: unknown[]) => any>)[methodName];
    if (typeof methodFactory !== 'function') {
      throw new Error(`Anchor method "${methodName}" is missing from the loaded IDL`);
    }

    let methodBuilder = methodFactory(...args).accounts(accounts);
    if (remainingAccounts && remainingAccounts.length > 0) {
      methodBuilder = methodBuilder.remainingAccounts(remainingAccounts);
    }
    return methodBuilder.instruction();
  }

  async contributeToContract(request: DirectContributeInstructionRequest): Promise<TransactionInstruction> {
    const contract = new PublicKey(request.contractAddress);
    const lender = new PublicKey(request.lenderAddress);
    const borrower = new PublicKey(request.borrowerAddress);
    const contribution = request.contributionAddress
      ? new PublicKey(request.contributionAddress)
      : deriveContributionPda(request.contractAddress, request.lenderAddress, this.programId.toBase58());
    const escrow = request.escrowAddress
      ? new PublicKey(request.escrowAddress)
      : deriveEscrowPda(request.contractAddress, request.lenderAddress, this.programId.toBase58());
    const state = request.stateAddress
      ? new PublicKey(request.stateAddress)
      : deriveGlobalStatePda(this.programId.toBase58());
    const approvedFunder = this.optionalPublicKey(request.approvedFunderAddress) ??
      deriveApprovedFunderPda(request.contractAddress, request.lenderAddress, this.programId.toBase58());
    const usdcMint = this.optionalPublicKey(request.usdcMint);
    const tokenProgram = usdcMint ? TOKEN_PROGRAM_ID : null;

    return this.buildInstruction(
      'contributeToContract',
      [new BN(request.amount.toString())],
      {
        contract,
        state,
        contribution,
        escrow,
        lender,
        borrower,
        approvedFunder,
        lenderUsdcAccount: this.optionalPublicKey(request.lenderUsdcAccount),
        contractUsdcAccount: this.optionalPublicKey(request.contractUsdcAccount),
        borrowerUsdcAccount: this.optionalPublicKey(request.borrowerUsdcAccount),
        usdcMint,
        tokenProgram,
        systemProgram: SystemProgram.programId,
      }
    );
  }

  async makePaymentWithDistribution(request: DirectMakePaymentInstructionRequest): Promise<TransactionInstruction> {
    const remainingAccounts = request.contributionEscrowAccounts.flatMap((entry) => [
      {
        pubkey: new PublicKey(entry.contributionAddress),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: new PublicKey(entry.escrowAddress),
        isSigner: false,
        isWritable: true,
      },
    ]);

    const state = request.stateAddress
      ? new PublicKey(request.stateAddress)
      : deriveGlobalStatePda(this.programId.toBase58());

    return this.buildInstruction(
      'makePaymentWithDistribution',
      [new BN(request.amount.toString())],
      {
        contract: new PublicKey(request.contractAddress),
        operationsFund: this.optionalPublicKey(request.operationsFundAddress),
        state,
        borrower: new PublicKey(request.borrowerAddress),
        borrowerUsdcAccount: this.optionalPublicKey(request.borrowerUsdcAccount),
        contractUsdcAccount: this.optionalPublicKey(request.contractUsdcAccount),
        contractCollateralAccount: this.optionalPublicKey(request.contractCollateralAccount),
        borrowerCollateralAccount: this.optionalPublicKey(request.borrowerCollateralAccount),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      },
      remainingAccounts
    );
  }

  async claimFromEscrow(request: DirectClaimFromEscrowInstructionRequest): Promise<TransactionInstruction> {
    return this.buildInstruction(
      'claimFromEscrow',
      [],
      {
        contract: new PublicKey(request.contractAddress),
        escrow: new PublicKey(request.escrowAddress),
        lender: new PublicKey(request.lenderAddress),
        escrowUsdcAccount: this.optionalPublicKey(request.escrowUsdcAccount),
        lenderUsdcAccount: this.optionalPublicKey(request.lenderUsdcAccount),
        tokenProgram: this.optionalPublicKey(request.tokenProgramAddress) ?? TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }
    );
  }

  async refundLender(request: DirectRefundLenderInstructionRequest): Promise<TransactionInstruction> {
    return this.buildInstruction(
      'refundLender',
      [],
      {
        contract: new PublicKey(request.contractAddress),
        contribution: new PublicKey(request.contributionAddress),
        lender: new PublicKey(request.lenderAddress),
        contractUsdcAccount: this.optionalPublicKey(request.contractUsdcAccount),
        lenderUsdcAccount: this.optionalPublicKey(request.lenderUsdcAccount),
        tokenProgram: this.optionalPublicKey(request.tokenProgramAddress) ?? TOKEN_PROGRAM_ID,
      },
      [
        {
          pubkey: new PublicKey(request.escrowAddress),
          isSigner: false,
          isWritable: true,
        },
      ]
    );
  }

  async approveFunder(request: DirectApproveFunderInstructionRequest): Promise<TransactionInstruction> {
    const approvedFunder = request.approvedFunderAddress
      ? new PublicKey(request.approvedFunderAddress)
      : deriveApprovedFunderPda(request.contractAddress, request.lenderAddress, this.programId.toBase58());

    return this.buildInstruction(
      'approveFunder',
      [],
      {
        contract: new PublicKey(request.contractAddress),
        approvedFunder,
        borrower: new PublicKey(request.borrowerAddress),
        lender: new PublicKey(request.lenderAddress),
        systemProgram: SystemProgram.programId,
      }
    );
  }

  async cancelContract(request: DirectCancelContractInstructionRequest): Promise<TransactionInstruction> {
    return this.buildInstruction(
      'cancelContract',
      [],
      {
        contract: new PublicKey(request.contractAddress),
        operationsFund: this.optionalPublicKey(request.operationsFundAddress),
        borrower: new PublicKey(request.borrowerAddress),
        contractCollateralAta: this.optionalPublicKey(request.contractCollateralAta),
        borrowerCollateralAta: this.optionalPublicKey(request.borrowerCollateralAta),
        tokenProgram: this.optionalPublicKey(request.tokenProgramAddress) ?? TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }
    );
  }

  async createTermProposal(request: DirectCreateTermProposalInstructionRequest): Promise<TransactionInstruction> {
    const proposalId = toProposalIdBn(request.proposalId);
    const proposal = request.proposalAddress
      ? new PublicKey(request.proposalAddress)
      : deriveTermProposalPda(request.contractAddress, request.proposalId, this.programId.toBase58());
    const proposerVote = request.proposerVoteAddress
      ? new PublicKey(request.proposerVoteAddress)
      : deriveProposalVotePda(proposal.toBase58(), request.proposerAddress, this.programId.toBase58());
    const proposerCooldown = request.proposerCooldownAddress
      ? new PublicKey(request.proposerCooldownAddress)
      : deriveProposerCooldownPda(request.contractAddress, request.proposerAddress, this.programId.toBase58());

    return this.buildInstruction(
      'createTermProposal',
      [
        proposalId,
        request.proposedInterestRate,
        request.proposedTermDays,
        normalizePaymentFrequency(request.proposedInterestFrequency),
        request.proposedPrincipalFrequency
          ? normalizePaymentFrequency(request.proposedPrincipalFrequency)
          : null,
        normalizeInterestPaymentType(request.proposedInterestPaymentType),
        normalizePrincipalPaymentType(request.proposedPrincipalPaymentType),
        toProposalIdBn(request.proposedLtvRatio),
        request.proposedLtvFloorBps,
      ],
      {
        contract: new PublicKey(request.contractAddress),
        proposal,
        proposerVote,
        proposerCooldown,
        proposer: new PublicKey(request.proposerAddress),
        systemProgram: SystemProgram.programId,
      },
      request.contributionAccounts.map((address) => ({
        pubkey: new PublicKey(address),
        isSigner: false,
        isWritable: false,
      }))
    );
  }

  async voteOnProposal(request: DirectVoteOnProposalInstructionRequest): Promise<TransactionInstruction> {
    const proposal = request.proposalAddress
      ? new PublicKey(request.proposalAddress)
      : deriveTermProposalPda(request.contractAddress, request.proposalId, this.programId.toBase58());
    const vote = request.voteAddress
      ? new PublicKey(request.voteAddress)
      : deriveProposalVotePda(proposal.toBase58(), request.voterAddress, this.programId.toBase58());
    const proposerCooldown = request.proposerCooldownAddress
      ? new PublicKey(request.proposerCooldownAddress)
      : deriveProposerCooldownPda(
          request.contractAddress,
          request.proposalProposerAddress,
          this.programId.toBase58()
        );

    return this.buildInstruction(
      'voteOnProposal',
      [toProposalIdBn(request.proposalId), normalizeVoteChoice(request.voteChoice)],
      {
        contract: new PublicKey(request.contractAddress),
        proposal,
        vote,
        proposerCooldown,
        voter: new PublicKey(request.voterAddress),
        systemProgram: SystemProgram.programId,
      }
    );
  }

  async cancelTermProposal(request: DirectCancelTermProposalInstructionRequest): Promise<TransactionInstruction> {
    const proposal = request.proposalAddress
      ? new PublicKey(request.proposalAddress)
      : deriveTermProposalPda(request.contractAddress, request.proposalId, this.programId.toBase58());

    return this.buildInstruction(
      'cancelTermProposal',
      [toProposalIdBn(request.proposalId)],
      {
        contract: new PublicKey(request.contractAddress),
        proposal,
        proposer: new PublicKey(request.proposerAddress),
      }
    );
  }

  async expireTermProposal(request: DirectExpireTermProposalInstructionRequest): Promise<TransactionInstruction> {
    const proposal = request.proposalAddress
      ? new PublicKey(request.proposalAddress)
      : deriveTermProposalPda(request.contractAddress, request.proposalId, this.programId.toBase58());
    const proposerCooldown = request.proposerCooldownAddress
      ? new PublicKey(request.proposerCooldownAddress)
      : deriveProposerCooldownPda(
          request.contractAddress,
          request.proposalProposerAddress,
          this.programId.toBase58()
        );

    return this.buildInstruction(
      'expireTermProposal',
      [toProposalIdBn(request.proposalId)],
      {
        contract: new PublicKey(request.contractAddress),
        proposal,
        proposerCooldown,
        executor: new PublicKey(request.executorAddress),
        systemProgram: SystemProgram.programId,
      }
    );
  }

  async closeProposalAccounts(
    request: DirectCloseProposalAccountsInstructionRequest
  ): Promise<TransactionInstruction> {
    const proposal = request.proposalAddress
      ? new PublicKey(request.proposalAddress)
      : deriveTermProposalPda(request.contractAddress, request.proposalId, this.programId.toBase58());

    return this.buildInstruction(
      'closeProposalAccounts',
      [toProposalIdBn(request.proposalId)],
      {
        contract: new PublicKey(request.contractAddress),
        proposal,
        proposerReceiver: new PublicKey(request.proposerReceiverAddress),
      }
    );
  }
}
