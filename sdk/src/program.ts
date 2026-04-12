import { AnchorProvider, BN, Idl, Program } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  DirectCreateDebtContractInstructionRequest,
  DirectBotCloseMaturedRevolvingInstructionRequest,
  DirectCloseRevolvingFacilityInstructionRequest,
  DirectDistributeStandbyFeesInstructionRequest,
  DirectDrawFromRevolvingInstructionRequest,
  DistributionMethodInput,
  DirectApproveFunderInstructionRequest,
  DirectCancelContractInstructionRequest,
  DirectCancelTermProposalInstructionRequest,
  DirectClaimFromEscrowInstructionRequest,
  DirectCloseProposalAccountsInstructionRequest,
  DirectContributeInstructionRequest,
  DirectCreateTermProposalInstructionRequest,
  DirectExpireTermProposalInstructionRequest,
  DirectMakePaymentInstructionRequest,
  DirectProcessProposalRecallInstructionRequest,
  DirectProgramConfig,
  DirectRepayRevolvingInstructionRequest,
  DirectSweepContractPoolInstructionRequest,
  DirectProposePoolChangesInstructionRequest,
  DirectUpdateOperatorNameInstructionRequest,
  DirectUpdatePoolNameInstructionRequest,
  DirectApplyPoolChangesInstructionRequest,
  DirectCancelPoolChangesInstructionRequest,
  FixedNameInput,
  DirectRefundLenderInstructionRequest,
  DirectWithdrawContributionInstructionRequest,
  DirectVoteOnProposalInstructionRequest,
  FundingAccessModeInput,
  InterestPaymentTypeInput,
  LoanTypeInput,
  PaymentFrequencyInput,
  PrincipalPaymentTypeInput,
  VoteChoiceInput,
} from './types';
import {
  deriveApprovedFunderPda,
  deriveContractPda,
  deriveContributionPda,
  deriveEscrowPda,
  deriveGlobalStatePda,
  derivePoolOperatorPda,
  derivePendingPoolChangePda,
  deriveProposalVotePda,
  deriveProposerCooldownPda,
  deriveTreasuryPda,
  deriveTermProposalPda,
  resolveProgramId,
} from './utils/pda';
import { encodeFixedName } from './utils/names';
import { stendarIdl } from './idl';
import { validateIdlIntegrity } from './utils/validation';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const U64_MAX = (1n << 64n) - 1n;

function normalizeEnumInput(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}: expected a string value.`);
  }
  if (value.length === 0) {
    throw new Error(`Invalid ${fieldName}: value cannot be empty.`);
  }
  return value.toLowerCase();
}

function parseInputAsBigInt(value: string | number | bigint, fieldName: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`Invalid ${fieldName}: expected an integer.`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Invalid ${fieldName}: value exceeds Number.MAX_SAFE_INTEGER. Use BigInt or string instead.`
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    if (value.length === 0) {
      throw new Error(`Invalid ${fieldName}: value cannot be empty.`);
    }
    try {
      return BigInt(value);
    } catch {
      throw new Error(`Invalid ${fieldName}: "${value}" is not a valid integer.`);
    }
  }
  throw new Error(`Invalid ${fieldName}: unsupported type.`);
}

export function toValidatedU64Bn(
  value: string | number | bigint,
  fieldName: string,
  allowZero = false
): BN {
  const parsed = parseInputAsBigInt(value, fieldName);
  if (parsed < 0n) {
    throw new Error(`Invalid ${fieldName}: value must be non-negative.`);
  }
  if (!allowZero && parsed === 0n) {
    throw new Error(`Invalid ${fieldName}: value must be greater than zero.`);
  }
  if (parsed > U64_MAX) {
    throw new Error(`Invalid ${fieldName}: value exceeds u64 max (2^64 - 1).`);
  }
  return new BN(parsed.toString());
}

export function toValidatedU32(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || !Number.isFinite(value)) {
    throw new Error(`Invalid ${fieldName}: expected an integer.`);
  }
  if (value < 0 || value > 0xFFFFFFFF) {
    throw new Error(`Invalid ${fieldName}: value must be in the u32 range.`);
  }
  return value;
}

export function toValidatedU16(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || !Number.isFinite(value)) {
    throw new Error(`Invalid ${fieldName}: expected an integer.`);
  }
  if (value < 0 || value > 0xFFFF) {
    throw new Error(`Invalid ${fieldName}: value must be in the u16 range.`);
  }
  return value;
}

export function validateRevolvingRateConstraints(
  isRevolving: boolean,
  interestRate: number,
  standbyFeeRate: number
): void {
  if (!isRevolving) {
    return;
  }
  if (standbyFeeRate <= 0 || standbyFeeRate >= interestRate) {
    throw new Error(
      `Invalid standbyFeeRate: revolving contracts require standbyFeeRate > 0 and < interestRate (standbyFeeRate=${standbyFeeRate}, interestRate=${interestRate}).`
    );
  }
}

export interface ValidatedContributionEscrowPair {
  contributionPubkey: PublicKey;
  escrowPubkey: PublicKey;
}

export interface ValidatedStandbyDistributionAccount {
  contributionPubkey: PublicKey;
  escrowPubkey: PublicKey;
  escrowUsdcPubkey: PublicKey;
}

export function validateContributionEscrowPairs(
  contributionEscrowAccounts: Array<{ contributionAddress: string; escrowAddress: string }>
): ValidatedContributionEscrowPair[] {
  if (contributionEscrowAccounts.length === 0) {
    throw new Error('contributionEscrowAccounts must include at least one contribution/escrow pair');
  }

  const seenAddresses = new Set<string>();
  return contributionEscrowAccounts.map((entry) => {
    const contributionPubkey = new PublicKey(entry.contributionAddress);
    const escrowPubkey = new PublicKey(entry.escrowAddress);
    const normalizedContribution = contributionPubkey.toBase58();
    const normalizedEscrow = escrowPubkey.toBase58();

    if (seenAddresses.has(normalizedContribution) || seenAddresses.has(normalizedEscrow)) {
      throw new Error('Duplicate contribution or escrow account detected in contributionEscrowAccounts');
    }
    seenAddresses.add(normalizedContribution);
    seenAddresses.add(normalizedEscrow);

    return {
      contributionPubkey,
      escrowPubkey,
    };
  });
}

export function validateStandbyDistributionAccounts(
  standbyDistributionAccounts: Array<{
    contributionAddress: string;
    escrowAddress: string;
    escrowUsdcAccount: string;
  }>
): ValidatedStandbyDistributionAccount[] {
  if (standbyDistributionAccounts.length === 0) {
    throw new Error('standbyDistributionAccounts must include at least one contribution/escrow/ATA tuple');
  }

  const seenAddresses = new Set<string>();
  return standbyDistributionAccounts.map((entry) => {
    const contributionPubkey = new PublicKey(entry.contributionAddress);
    const escrowPubkey = new PublicKey(entry.escrowAddress);
    const escrowUsdcPubkey = new PublicKey(entry.escrowUsdcAccount);

    const normalizedContribution = contributionPubkey.toBase58();
    const normalizedEscrow = escrowPubkey.toBase58();
    const normalizedEscrowUsdc = escrowUsdcPubkey.toBase58();
    if (
      seenAddresses.has(normalizedContribution) ||
      seenAddresses.has(normalizedEscrow) ||
      seenAddresses.has(normalizedEscrowUsdc)
    ) {
      throw new Error('Duplicate contribution, escrow, or escrow ATA account detected');
    }
    seenAddresses.add(normalizedContribution);
    seenAddresses.add(normalizedEscrow);
    seenAddresses.add(normalizedEscrowUsdc);

    return {
      contributionPubkey,
      escrowPubkey,
      escrowUsdcPubkey,
    };
  });
}

export function toValidatedAllowedLoanType(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 2) {
    throw new Error(`Invalid allowedLoanType: value must be 0 (both), 1 (demand-only), or 2 (committed-only).`);
  }
  return value;
}

export function validatePoolChangeProposal(
  request: DirectProposePoolChangesInstructionRequest
): void {
  const hasChange =
    request.rateBps != null ||
    request.capacity != null ||
    request.minimumDeposit != null ||
    request.allowedLoanType != null ||
    request.minLtvBps != null ||
    request.maxTermDays != null ||
    request.withdrawalQueueEnabled != null;
  if (!hasChange) {
    throw new Error('At least one pool parameter must be provided in a change proposal.');
  }
}

function toFixedNameBytes(value: FixedNameInput, fieldName: string): number[] {
  if (typeof value === 'string') {
    return encodeFixedName(value);
  }

  const bytes = Array.from(value);
  if (bytes.length > 32) {
    throw new Error(`Invalid ${fieldName}: expected at most 32 bytes.`);
  }

  const output = Buffer.alloc(32);
  bytes.forEach((entry, index) => {
    if (!Number.isInteger(entry) || entry < 0 || entry > 255) {
      throw new Error(`Invalid ${fieldName}: byte values must be integers in the 0-255 range.`);
    }
    output[index] = entry;
  });

  return Array.from(output);
}

function toProposalIdBn(value: string | number | bigint): BN {
  return toValidatedU64Bn(value, 'proposalId', true);
}

function toValidatedU32FromInput(
  value: string | number | bigint,
  fieldName: string,
  allowZero = false
): number {
  const parsed = parseInputAsBigInt(value, fieldName);
  if (parsed < 0n) {
    throw new Error(`Invalid ${fieldName}: value must be non-negative.`);
  }
  if (!allowZero && parsed === 0n) {
    throw new Error(`Invalid ${fieldName}: value must be greater than zero.`);
  }
  if (parsed > 0xFFFFFFFFn) {
    throw new Error(`Invalid ${fieldName}: value exceeds u32 max (2^32 - 1).`);
  }
  return Number(parsed);
}

function toLtvRatioU32(value: string | number | bigint): number {
  return toValidatedU32FromInput(value, 'proposedLtvRatio');
}

export function normalizePaymentFrequency(
  value: PaymentFrequencyInput
): { daily?: {}; weekly?: {}; biWeekly?: {}; monthly?: {} } {
  switch (normalizeEnumInput(value, 'payment frequency')) {
    case 'daily':
      return { daily: {} };
    case 'weekly':
      return { weekly: {} };
    case 'biweekly':
    case 'bi_weekly':
    case 'bi-weekly':
      return { biWeekly: {} };
    case 'monthly':
      return { monthly: {} };
    default:
      throw new Error(
        `Invalid payment frequency "${value}". Valid values: daily, weekly, biweekly, bi_weekly, bi-weekly, monthly.`
      );
  }
}

export function normalizeInterestPaymentType(
  value: InterestPaymentTypeInput
): { outstandingBalance?: {}; collateralTransfer?: {} } {
  const normalized = normalizeEnumInput(value, 'interest payment type');
  if (normalized === 'collateraltransfer' || normalized === 'collateral_transfer') {
    return { collateralTransfer: {} };
  }
  if (normalized === 'outstandingbalance' || normalized === 'outstanding_balance') {
    return { outstandingBalance: {} };
  }
  throw new Error(
    `Invalid interest payment type "${value}". Valid values: outstandingbalance, outstanding_balance, collateraltransfer, collateral_transfer.`
  );
}

export function normalizePrincipalPaymentType(
  value: PrincipalPaymentTypeInput
): { collateralDeduction?: {}; noFixedPayment?: {} } {
  const normalized = normalizeEnumInput(value, 'principal payment type');
  if (normalized === 'collateraldeduction' || normalized === 'collateral_deduction') {
    return { collateralDeduction: {} };
  }
  if (normalized === 'nofixedpayment' || normalized === 'no_fixed_payment') {
    return { noFixedPayment: {} };
  }
  throw new Error(
    `Invalid principal payment type "${value}". Valid values: collateraldeduction, collateral_deduction, nofixedpayment, no_fixed_payment.`
  );
}

export function normalizeLoanType(value: LoanTypeInput): { demand?: {}; committed?: {} } {
  const normalized = normalizeEnumInput(value, 'loan type');
  if (normalized === 'demand') {
    return { demand: {} };
  }
  if (normalized === 'committed') {
    return { committed: {} };
  }
  throw new Error(`Invalid loan type "${value}". Valid values: demand, committed.`);
}

export function normalizeDistributionMethod(
  value: DistributionMethodInput
): { manual?: {}; automatic?: {} } {
  const normalized = normalizeEnumInput(value, 'distribution method');
  if (normalized === 'manual') {
    return { manual: {} };
  }
  if (normalized === 'automatic') {
    return { automatic: {} };
  }
  throw new Error(`Invalid distribution method "${value}". Valid values: manual, automatic.`);
}

export function normalizeFundingAccessMode(
  value: FundingAccessModeInput
): { public?: {}; allowlistOnly?: {} } {
  const normalized = normalizeEnumInput(value, 'funding access mode');
  if (normalized === 'public') {
    return { public: {} };
  }
  if (normalized === 'allowlistonly' || normalized === 'allowlist_only' || normalized === 'allowlist-only') {
    return { allowlistOnly: {} };
  }
  throw new Error(
    `Invalid funding access mode "${value}". Valid values: public, allowlistonly, allowlist_only, allowlist-only.`
  );
}

export function normalizeVoteChoice(value: VoteChoiceInput): { approve?: {}; reject?: {} } {
  const normalized = normalizeEnumInput(value, 'vote choice');
  if (normalized === 'approve') {
    return { approve: {} };
  }
  if (normalized === 'reject') {
    return { reject: {} };
  }
  throw new Error(`Invalid vote choice "${value}". Valid values: approve, reject.`);
}

export class StendarProgramClient {
  private readonly program: Program<Idl>;
  private readonly programId: PublicKey;

  constructor(config: DirectProgramConfig) {
    const programId = resolveProgramId(config.programId);
    const provider = new AnchorProvider(config.connection, config.wallet as any, {
      commitment: config.commitment ?? 'confirmed',
    });
    validateIdlIntegrity(config.idl, stendarIdl);
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

  async createDebtContract(
    request: DirectCreateDebtContractInstructionRequest
  ): Promise<TransactionInstruction> {
    const borrower = new PublicKey(request.borrowerAddress);
    const contractSeed = toValidatedU64Bn(request.contractSeed, 'contractSeed', true);
    const contract = deriveContractPda(
      request.borrowerAddress,
      request.contractSeed,
      this.programId.toBase58()
    );
    const [operationsFund] = PublicKey.findProgramAddressSync(
      [Buffer.from('operations_fund'), contract.toBuffer()],
      this.programId
    );
    const state = request.stateAddress
      ? new PublicKey(request.stateAddress)
      : deriveGlobalStatePda(this.programId.toBase58());
    const treasury = request.treasuryAddress
      ? new PublicKey(request.treasuryAddress)
      : deriveTreasuryPda(this.programId.toBase58());
    const tokenProgram =
      this.optionalPublicKey(request.tokenProgramAddress) ??
      (this.optionalPublicKey(request.usdcMintAddress) ? TOKEN_PROGRAM_ID : null);
    const associatedTokenProgram =
      this.optionalPublicKey(request.associatedTokenProgramAddress) ??
      (this.optionalPublicKey(request.usdcMintAddress) ? ASSOCIATED_TOKEN_PROGRAM_ID : null);
    const interestRate = toValidatedU32(request.interestRate, 'interestRate');
    const standbyFeeRate = toValidatedU32(request.standbyFeeRate, 'standbyFeeRate');
    validateRevolvingRateConstraints(
      Boolean(request.isRevolving),
      interestRate,
      standbyFeeRate
    );

    return this.buildInstruction(
      'createDebtContract',
      [
        contractSeed,
        toValidatedU16(request.maxLenders, 'maxLenders'),
        toValidatedU64Bn(request.targetAmount, 'targetAmount'),
        interestRate,
        toValidatedU32(request.termDays, 'termDays'),
        toValidatedU64Bn(request.collateralAmount, 'collateralAmount', true),
        normalizeLoanType(request.loanType),
        toValidatedU32(request.ltvRatio, 'ltvRatio'),
        toValidatedU32(request.ltvFloorBps, 'ltvFloorBps'),
        normalizeInterestPaymentType(request.interestPaymentType),
        normalizePrincipalPaymentType(request.principalPaymentType),
        normalizePaymentFrequency(request.interestFrequency),
        request.principalFrequency == null
          ? null
          : normalizePaymentFrequency(request.principalFrequency),
        Boolean(request.partialFundingEnabled),
        Boolean(request.allowPartialFill),
        toValidatedU16(request.minPartialFillBps, 'minPartialFillBps'),
        Boolean(request.isRevolving),
        standbyFeeRate,
        normalizeDistributionMethod(request.distributionMethod),
        normalizeFundingAccessMode(request.fundingAccessMode),
      ],
      {
        contract,
        operationsFund,
        state,
        treasury,
        borrower,
        systemProgram: SystemProgram.programId,
        collateralRegistry: this.optionalPublicKey(request.collateralRegistryAddress),
        collateralMint: this.optionalPublicKey(request.collateralMintAddress),
        borrowerCollateralAta: this.optionalPublicKey(request.borrowerCollateralAta),
        contractCollateralAta: this.optionalPublicKey(request.contractCollateralAta),
        priceFeedAccount: this.optionalPublicKey(request.priceFeedAddress),
        usdcMint: this.optionalPublicKey(request.usdcMintAddress),
        contractUsdcAta: this.optionalPublicKey(request.contractUsdcAta),
        borrowerUsdcAta: this.optionalPublicKey(request.borrowerUsdcAta),
        treasuryUsdcAccount: this.optionalPublicKey(request.treasuryUsdcAccount),
        tokenProgram,
        associatedTokenProgram,
      }
    );
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
    const approvedFunder = request.approvedFunderAddress === null
      ? null
      : this.optionalPublicKey(request.approvedFunderAddress) ??
          deriveApprovedFunderPda(request.contractAddress, request.lenderAddress, this.programId.toBase58());
    const usdcMint = this.optionalPublicKey(request.usdcMint);
    const tokenProgram = usdcMint ? TOKEN_PROGRAM_ID : null;

    return this.buildInstruction(
      'contributeToContract',
      [toValidatedU64Bn(request.amount, 'amount')],
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
    const validatedPairs = validateContributionEscrowPairs(request.contributionEscrowAccounts);
    const remainingAccounts = validatedPairs.flatMap((entry) => [
      {
        pubkey: entry.contributionPubkey,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: entry.escrowPubkey,
        isSigner: false,
        isWritable: true,
      },
    ]);

    const state = request.stateAddress
      ? new PublicKey(request.stateAddress)
      : deriveGlobalStatePda(this.programId.toBase58());

    return this.buildInstruction(
      'makePaymentWithDistribution',
      [toValidatedU64Bn(request.amount, 'amount')],
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

  async drawFromRevolving(request: DirectDrawFromRevolvingInstructionRequest): Promise<TransactionInstruction> {
    const validatedPairs = validateContributionEscrowPairs(request.contributionEscrowAccounts);
    const remainingAccounts = validatedPairs.flatMap((entry) => [
      {
        pubkey: entry.contributionPubkey,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: entry.escrowPubkey,
        isSigner: false,
        isWritable: true,
      },
    ]);
    const state = request.stateAddress
      ? new PublicKey(request.stateAddress)
      : deriveGlobalStatePda(this.programId.toBase58());
    const treasury = request.treasuryAddress
      ? new PublicKey(request.treasuryAddress)
      : deriveTreasuryPda(this.programId.toBase58());

    return this.buildInstruction(
      'drawFromRevolving',
      [toValidatedU64Bn(request.amount, 'amount')],
      {
        contract: new PublicKey(request.contractAddress),
        state,
        testClockOffset: this.optionalPublicKey(request.testClockOffsetAddress),
        treasury,
        borrower: new PublicKey(request.borrowerAddress),
        borrowerUsdcAccount: new PublicKey(request.borrowerUsdcAccount),
        contractUsdcAccount: new PublicKey(request.contractUsdcAccount),
        collateralRegistry: this.optionalPublicKey(request.collateralRegistryAddress),
        priceFeedAccount: this.optionalPublicKey(request.priceFeedAddress),
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      remainingAccounts
    );
  }

  async repayRevolving(request: DirectRepayRevolvingInstructionRequest): Promise<TransactionInstruction> {
    const validatedPairs = validateContributionEscrowPairs(request.contributionEscrowAccounts);
    const remainingAccounts = validatedPairs.flatMap((entry) => [
      {
        pubkey: entry.contributionPubkey,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: entry.escrowPubkey,
        isSigner: false,
        isWritable: true,
      },
    ]);
    const state = request.stateAddress
      ? new PublicKey(request.stateAddress)
      : deriveGlobalStatePda(this.programId.toBase58());
    const treasury = request.treasuryAddress
      ? new PublicKey(request.treasuryAddress)
      : deriveTreasuryPda(this.programId.toBase58());

    return this.buildInstruction(
      'repayRevolving',
      [toValidatedU64Bn(request.amount, 'amount')],
      {
        contract: new PublicKey(request.contractAddress),
        state,
        testClockOffset: this.optionalPublicKey(request.testClockOffsetAddress),
        treasury,
        borrower: new PublicKey(request.borrowerAddress),
        borrowerUsdcAccount: new PublicKey(request.borrowerUsdcAccount),
        contractUsdcAccount: new PublicKey(request.contractUsdcAccount),
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      remainingAccounts
    );
  }

  async closeRevolvingFacility(
    request: DirectCloseRevolvingFacilityInstructionRequest
  ): Promise<TransactionInstruction> {
    const state = request.stateAddress
      ? new PublicKey(request.stateAddress)
      : deriveGlobalStatePda(this.programId.toBase58());
    const treasury = request.treasuryAddress
      ? new PublicKey(request.treasuryAddress)
      : deriveTreasuryPda(this.programId.toBase58());

    return this.buildInstruction(
      'closeRevolvingFacility',
      [],
      {
        contract: new PublicKey(request.contractAddress),
        state,
        testClockOffset: this.optionalPublicKey(request.testClockOffsetAddress),
        treasury,
        borrower: new PublicKey(request.borrowerAddress),
        borrowerUsdcAccount: new PublicKey(request.borrowerUsdcAccount),
        contractUsdcAccount: new PublicKey(request.contractUsdcAccount),
        treasuryUsdcAccount: new PublicKey(request.treasuryUsdcAccount),
        tokenProgram: TOKEN_PROGRAM_ID,
      }
    );
  }

  async sweepContractPool(
    request: DirectSweepContractPoolInstructionRequest
  ): Promise<TransactionInstruction> {
    const state = request.stateAddress
      ? new PublicKey(request.stateAddress)
      : deriveGlobalStatePda(this.programId.toBase58());

    return this.buildInstruction(
      'sweepContractPool',
      [],
      {
        contract: new PublicKey(request.contractAddress),
        state,
        borrower: new PublicKey(request.borrowerAddress),
        contractUsdcAccount: new PublicKey(request.contractUsdcAccount),
        borrowerUsdcAccount: new PublicKey(request.borrowerUsdcAccount),
        tokenProgram: this.optionalPublicKey(request.tokenProgramAddress) ?? TOKEN_PROGRAM_ID,
      }
    );
  }

  async botCloseMaturedRevolving(
    request: DirectBotCloseMaturedRevolvingInstructionRequest
  ): Promise<TransactionInstruction> {
    const state = request.stateAddress
      ? new PublicKey(request.stateAddress)
      : deriveGlobalStatePda(this.programId.toBase58());
    const treasury = request.treasuryAddress
      ? new PublicKey(request.treasuryAddress)
      : deriveTreasuryPda(this.programId.toBase58());

    return this.buildInstruction(
      'botCloseMaturedRevolving',
      [],
      {
        contract: new PublicKey(request.contractAddress),
        state,
        testClockOffset: this.optionalPublicKey(request.testClockOffsetAddress),
        treasury,
        botAuthority: new PublicKey(request.botAuthorityAddress),
        tokenProgram: this.optionalPublicKey(request.tokenProgramAddress) ?? TOKEN_PROGRAM_ID,
      }
    );
  }

  async distributeStandbyFees(
    request: DirectDistributeStandbyFeesInstructionRequest
  ): Promise<TransactionInstruction> {
    const validatedAccounts = validateStandbyDistributionAccounts(request.standbyDistributionAccounts);
    const remainingAccounts = validatedAccounts.flatMap((entry) => [
      {
        pubkey: entry.contributionPubkey,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: entry.escrowPubkey,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: entry.escrowUsdcPubkey,
        isSigner: false,
        isWritable: true,
      },
    ]);
    const state = request.stateAddress
      ? new PublicKey(request.stateAddress)
      : deriveGlobalStatePda(this.programId.toBase58());
    const treasury = request.treasuryAddress
      ? new PublicKey(request.treasuryAddress)
      : deriveTreasuryPda(this.programId.toBase58());

    return this.buildInstruction(
      'distributeStandbyFees',
      [],
      {
        contract: new PublicKey(request.contractAddress),
        state,
        treasury,
        botAuthority: new PublicKey(request.botAuthorityAddress),
        contractUsdcAccount: new PublicKey(request.contractUsdcAccount),
        tokenProgram: TOKEN_PROGRAM_ID,
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

  async withdrawContribution(
    request: DirectWithdrawContributionInstructionRequest
  ): Promise<TransactionInstruction> {
    const contribution = request.contributionAddress
      ? new PublicKey(request.contributionAddress)
      : deriveContributionPda(request.contractAddress, request.lenderAddress, this.programId.toBase58());
    const escrow = request.escrowAddress
      ? new PublicKey(request.escrowAddress)
      : deriveEscrowPda(request.contractAddress, request.lenderAddress, this.programId.toBase58());

    return this.buildInstruction(
      'withdrawContribution',
      [],
      {
        contract: new PublicKey(request.contractAddress),
        contribution,
        escrow,
        lender: new PublicKey(request.lenderAddress),
        contractUsdcAccount: this.optionalPublicKey(request.contractUsdcAccount),
        lenderUsdcAccount: this.optionalPublicKey(request.lenderUsdcAccount),
        tokenProgram: this.optionalPublicKey(request.tokenProgramAddress) ?? TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }
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
        toValidatedU32(request.proposedInterestRate, 'proposedInterestRate'),
        toValidatedU32(request.proposedTermDays, 'proposedTermDays'),
        normalizePaymentFrequency(request.proposedInterestFrequency),
        request.proposedPrincipalFrequency
          ? normalizePaymentFrequency(request.proposedPrincipalFrequency)
          : null,
        normalizeInterestPaymentType(request.proposedInterestPaymentType),
        normalizePrincipalPaymentType(request.proposedPrincipalPaymentType),
        toLtvRatioU32(request.proposedLtvRatio),
        toValidatedU32(request.proposedLtvFloorBps, 'proposedLtvFloorBps'),
        Boolean(request.recallOnRejection),
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
      [
        toProposalIdBn(request.proposalId),
        normalizeVoteChoice(request.voteChoice),
        Boolean(request.recallOnRejection),
      ],
      {
        contract: new PublicKey(request.contractAddress),
        proposal,
        vote,
        voterContribution: this.optionalPublicKey(request.voterContributionAddress),
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

  async processProposalRecall(
    request: DirectProcessProposalRecallInstructionRequest
  ): Promise<TransactionInstruction> {
    const proposal = request.proposalAddress
      ? new PublicKey(request.proposalAddress)
      : deriveTermProposalPda(request.contractAddress, request.proposalId, this.programId.toBase58());
    const vote = request.voteAddress
      ? new PublicKey(request.voteAddress)
      : deriveProposalVotePda(proposal.toBase58(), request.voterAddress, this.programId.toBase58());
    const treasury = deriveTreasuryPda(this.programId.toBase58());
    const state = deriveGlobalStatePda(this.programId.toBase58());

    return this.buildInstruction(
      'processProposalRecall',
      [toProposalIdBn(request.proposalId)],
      {
        contract: new PublicKey(request.contractAddress),
        proposal,
        vote,
        botAuthority: new PublicKey(request.botAuthorityAddress),
        treasury,
        contribution: new PublicKey(request.contributionAddress),
        escrow: new PublicKey(request.escrowAddress),
        botUsdcAta: new PublicKey(request.botUsdcAta),
        escrowUsdcAta: new PublicKey(request.escrowUsdcAta),
        treasuryUsdcAta: new PublicKey(request.treasuryUsdcAta),
        contractCollateralAta: new PublicKey(request.contractCollateralAta),
        botCollateralAta: new PublicKey(request.botCollateralAta),
        borrower: new PublicKey(request.borrowerAddress),
        state,
        testClockOffset: this.optionalPublicKey(request.testClockOffsetAddress),
        tokenProgram: this.optionalPublicKey(request.tokenProgramAddress) ?? TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }
    );
  }

  async proposePoolChanges(
    request: DirectProposePoolChangesInstructionRequest
  ): Promise<TransactionInstruction> {
    validatePoolChangeProposal(request);

    const pool = new PublicKey(request.poolAddress);
    const [pendingChange] = request.pendingChangeAddress
      ? [new PublicKey(request.pendingChangeAddress)]
      : derivePendingPoolChangePda(pool, this.programId.toBase58());

    const rateBps = request.rateBps != null ? toValidatedU32(request.rateBps, 'rateBps') : null;
    const capacity = request.capacity != null
      ? toValidatedU64Bn(request.capacity, 'capacity', true)
      : null;
    const minimumDeposit = request.minimumDeposit != null
      ? toValidatedU64Bn(request.minimumDeposit, 'minimumDeposit', true)
      : null;
    const allowedLoanType = request.allowedLoanType != null
      ? toValidatedAllowedLoanType(request.allowedLoanType)
      : null;
    const minLtvBps = request.minLtvBps != null
      ? toValidatedU16(request.minLtvBps, 'minLtvBps')
      : null;
    const maxTermDays = request.maxTermDays != null
      ? toValidatedU32(request.maxTermDays, 'maxTermDays')
      : null;
    const withdrawalQueueEnabled = request.withdrawalQueueEnabled ?? null;

    return this.buildInstruction(
      'proposePoolChanges',
      [rateBps, capacity, minimumDeposit, allowedLoanType, minLtvBps, maxTermDays, withdrawalQueueEnabled],
      {
        operator: new PublicKey(request.operatorAddress),
        pool,
        pendingChange,
        systemProgram: SystemProgram.programId,
      }
    );
  }

  async applyPoolChanges(
    request: DirectApplyPoolChangesInstructionRequest
  ): Promise<TransactionInstruction> {
    const pool = new PublicKey(request.poolAddress);
    const [pendingChange] = request.pendingChangeAddress
      ? [new PublicKey(request.pendingChangeAddress)]
      : derivePendingPoolChangePda(pool, this.programId.toBase58());

    return this.buildInstruction(
      'applyPoolChanges',
      [],
      {
        operator: new PublicKey(request.operatorAddress),
        pool,
        pendingChange,
      }
    );
  }

  async cancelPoolChanges(
    request: DirectCancelPoolChangesInstructionRequest
  ): Promise<TransactionInstruction> {
    const pool = new PublicKey(request.poolAddress);
    const [pendingChange] = request.pendingChangeAddress
      ? [new PublicKey(request.pendingChangeAddress)]
      : derivePendingPoolChangePda(pool, this.programId.toBase58());

    return this.buildInstruction(
      'cancelPoolChanges',
      [],
      {
        operator: new PublicKey(request.operatorAddress),
        pendingChange,
      }
    );
  }

  async updatePoolName(
    request: DirectUpdatePoolNameInstructionRequest
  ): Promise<TransactionInstruction> {
    return this.buildInstruction(
      'updatePoolName',
      [toFixedNameBytes(request.name, 'name')],
      {
        operator: new PublicKey(request.operatorAddress),
        pool: new PublicKey(request.poolAddress),
      }
    );
  }

  async updateOperatorName(
    request: DirectUpdateOperatorNameInstructionRequest
  ): Promise<TransactionInstruction> {
    const operator = new PublicKey(request.operatorAddress);
    const [operatorAuth] = request.operatorAuthAddress
      ? [new PublicKey(request.operatorAuthAddress)]
      : derivePoolOperatorPda(operator, this.programId.toBase58());

    return this.buildInstruction(
      'updateOperatorName',
      [toFixedNameBytes(request.name, 'name')],
      {
        operator,
        operatorAuth,
      }
    );
  }
}
