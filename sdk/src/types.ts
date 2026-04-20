import type { Idl } from '@coral-xyz/anchor';
import type { Commitment, Connection, PublicKey } from '@solana/web3.js';

export type StendarClientMode = 'api' | 'direct';

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta?: {
    timestamp: number;
    requestId: string;
  };
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  status: number;
  requestId?: string;
}

export class StendarApiError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly status: number;
  readonly requestId?: string;

  constructor(payload: ApiErrorPayload) {
    super(payload.message);
    this.name = 'StendarApiError';
    this.code = payload.code;
    this.details = payload.details;
    this.status = payload.status;
    this.requestId = payload.requestId;
  }
}

export interface AnchorWalletLike {
  publicKey: PublicKey;
  signTransaction?: <T>(transaction: T) => Promise<T>;
  signAllTransactions?: <T>(transactions: T[]) => Promise<T[]>;
}

export interface DirectProgramConfig {
  connection: Connection;
  wallet: AnchorWalletLike;
  idl: Idl;
  programId?: string;
  commitment?: Commitment;
}

export interface HttpClientConfig {
  apiUrl?: string;
  apiKey?: string;
  sessionBearerToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

export interface StendarClientConfig extends HttpClientConfig {
  mode?: StendarClientMode;
  direct?: DirectProgramConfig;
}

export interface ContractCreationRequest {
  borrowerAddress: string;
  amount: number;
  interestRate: number;
  loanType: 'demand' | 'committed';
  isRevolving?: boolean;
  standbyFeeRate?: number | null;
  partialFundingEnabled?: boolean;
  allowPartialFill?: boolean;
  minPartialFillBps?: number | null;
  fundingAccessMode?: 'public' | 'allowlist_only';
  ltvFloorBps?: number | null;
  distributionMethod?: 'automatic' | 'manual';
  maxLenders?: number;
  ltv: number;
  termValue: number;
  termUnit: 'days' | 'months' | 'years' | 'no_maturity';
  interestPaymentType: 'outstanding_balance' | 'collateral_transfer';
  interestFrequency: 'daily' | 'weekly' | 'bi_weekly' | 'monthly';
  principalPaymentType: 'collateral_deduction' | 'no_fixed_payment';
  principalFrequency?: 'daily' | 'weekly' | 'bi_weekly' | 'monthly' | null;
  collateralMint?: string;
  loanMint?: string;
  collateralAmount?: number;
}

export interface TransactionBuildResponse {
  contractAddress?: string;
  primaryAddress?: string;
  listingAddress?: string;
  offerAddress?: string;
  unsignedTransaction: string;
  requiredSigners: string[];
  collateralRequired?: number;
  estimatedFee: number;
  status: string;
  instructions: string[];
  [key: string]: unknown;
}

export interface TransactionSubmissionRequest {
  signedTransactionBase64: string;
  expectedWalletAddress: string;
  contractAddress: string;
  submissionId: string;
}

export interface TransactionSubmissionResponse {
  transactionSignature: string;
  confirmationStatus?: string;
  contractAddress?: string;
  expectedAddress?: string;
  [key: string]: unknown;
}

export interface ContributeRequest {
  contractAddress: string;
  lenderAddress: string;
  amount: number;
  borrowerAddress?: string;
  approvedFunderAddress?: string | null;
  lenderUsdcAccount?: string;
  contractUsdcAccount?: string;
  borrowerUsdcAccount?: string;
  usdcMint?: string;
}

export interface MakePaymentWithDistributionRequest {
  contractAddress: string;
  borrowerAddress: string;
  amount: number;
  borrowerUsdcAccount?: string;
  contractUsdcAccount?: string;
  contractCollateralAccount?: string;
  borrowerCollateralAccount?: string;
  contributionEscrowAccounts: Array<{
    contributionAddress: string;
    escrowAddress: string;
  }>;
}

export interface RequestRecallRequest {
  contractAddress: string;
  lenderAddress: string;
  contributionAddress: string;
}

export interface RepayRecallRequest {
  contractAddress: string;
  borrowerAddress: string;
  contributionAddress: string;
  escrowAddress: string;
  borrowerUsdcAta: string;
  contractUsdcAta: string;
  escrowUsdcAta: string;
  contractCollateralAta: string;
  borrowerCollateralAta: string;
}

export interface DrawFromRevolvingRequest {
  contractAddress: string;
  borrowerAddress: string;
  amount: number;
  borrowerUsdcAccount: string;
  contractUsdcAccount: string;
  contributionEscrowAccounts: Array<{
    contributionAddress: string;
    escrowAddress: string;
  }>;
  collateralRegistryAddress?: string | null;
  priceFeedAddress?: string | null;
}

export interface RepayRevolvingRequest {
  contractAddress: string;
  borrowerAddress: string;
  amount: number;
  borrowerUsdcAccount: string;
  contractUsdcAccount: string;
  contributionEscrowAccounts: Array<{
    contributionAddress: string;
    escrowAddress: string;
  }>;
}

export interface CloseRevolvingFacilityRequest {
  contractAddress: string;
  borrowerAddress: string;
  borrowerUsdcAccount: string;
  contractUsdcAccount: string;
  treasuryUsdcAccount: string;
}

export interface SweepContractPoolRequest {
  contractAddress: string;
  borrowerAddress: string;
  contractUsdcAccount: string;
  borrowerUsdcAccount: string;
}

export interface BotCloseMaturedRevolvingRequest {
  contractAddress: string;
  botAuthorityAddress: string;
}

export interface DistributeStandbyFeesRequest {
  contractAddress: string;
  botAuthorityAddress: string;
  contractUsdcAccount: string;
  standbyDistributionAccounts: Array<{
    contributionAddress: string;
    escrowAddress: string;
    escrowUsdcAccount: string;
  }>;
}

export interface ClaimFromEscrowRequest {
  contractAddress: string;
  lenderAddress: string;
  escrowAddress?: string;
  escrowUsdcAccount?: string;
  lenderUsdcAccount?: string;
}

export interface RefundLenderRequest {
  contractAddress: string;
  lenderAddress: string;
  contributionAddress?: string;
  escrowAddress?: string;
  contractUsdcAccount?: string;
  lenderUsdcAccount?: string;
}

export interface WithdrawContributionRequest {
  contractAddress: string;
  lenderAddress: string;
  contributionAddress?: string;
  escrowAddress?: string;
  contractUsdcAccount?: string;
  lenderUsdcAccount?: string;
}

export interface ApproveFunderRequest {
  contractAddress: string;
  borrowerAddress: string;
  lenderAddress: string;
  approvedFunderAddress?: string;
}

export interface CancelContractRequest {
  contractAddress: string;
  borrowerAddress: string;
  operationsFundAddress?: string;
  contractCollateralAta?: string;
  borrowerCollateralAta?: string;
}

export type PaymentFrequencyInput = 'daily' | 'weekly' | 'bi_weekly' | 'bi-weekly' | 'biweekly' | 'monthly';
export type InterestPaymentTypeInput = 'outstanding_balance' | 'outstandingbalance' | 'collateral_transfer' | 'collateraltransfer';
export type PrincipalPaymentTypeInput = 'collateral_deduction' | 'collateraldeduction' | 'no_fixed_payment' | 'nofixedpayment';
export type LoanTypeInput = 'demand' | 'committed';
export type DistributionMethodInput = 'manual' | 'automatic';
export type FundingAccessModeInput = 'public' | 'allowlist_only' | 'allowlistonly' | 'allowlist-only';
export type VoteChoiceInput = 'approve' | 'reject';

export interface CreateTermProposalRequest {
  contractAddress: string;
  proposerAddress: string;
  proposalId: string | number | bigint;
  proposedInterestRate: number;
  proposedTermDays: number;
  proposedInterestFrequency: PaymentFrequencyInput;
  proposedPrincipalFrequency?: PaymentFrequencyInput | null;
  proposedInterestPaymentType: InterestPaymentTypeInput;
  proposedPrincipalPaymentType: PrincipalPaymentTypeInput;
  proposedLtvRatio: string | number | bigint;
  proposedLtvFloorBps: number;
  contributionAccounts: string[];
  recallOnRejection?: boolean;
}

export interface VoteOnProposalRequest {
  contractAddress: string;
  voterAddress: string;
  proposalId: string | number | bigint;
  proposalProposerAddress: string;
  voteChoice: VoteChoiceInput;
  recallOnRejection?: boolean;
}

export interface CancelTermProposalRequest {
  contractAddress: string;
  proposerAddress: string;
  proposalId: string | number | bigint;
}

export interface ExpireTermProposalRequest {
  contractAddress: string;
  executorAddress: string;
  proposalId: string | number | bigint;
  proposalProposerAddress: string;
}

export interface CloseProposalAccountsRequest {
  contractAddress: string;
  proposalId: string | number | bigint;
  proposerReceiverAddress: string;
}

export interface ProcessProposalRecallRequest {
  contractAddress: string;
  proposalId: string | number | bigint;
  voterAddress: string;
  botAuthorityAddress: string;
  contributionAddress: string;
  escrowAddress: string;
  borrowerAddress: string;
  botUsdcAta: string;
  escrowUsdcAta: string;
  treasuryUsdcAta: string;
  contractCollateralAta: string;
  botCollateralAta: string;
  proposalAddress?: string;
  voteAddress?: string;
  /** @internal Test-only account override; do not use in production integrations. */
  testClockOffsetAddress?: string | null;
  frontendUsdcAta?: string | null;
  tokenProgramAddress?: string | null;
}

export interface TradeCreateListingRequest {
  sellerAddress: string;
  contributionAddress: string;
  askingPriceUsdc: number;
  listingAmountUsdc?: number;
  expirationDays: number;
  nonce?: number;
  contractAddress?: string;
}

export interface TradeSubmitRequest {
  signedTransactionBase64: string;
  expectedWalletAddress: string;
  expectedAddress: string;
  submissionId: string;
}

export interface TradeCreateOfferRequest {
  buyerAddress: string;
  listingAddress: string;
  offeredPriceUsdc: number;
  expirationDays: number;
  nonce?: number;
}

export interface TradeAcceptOfferRequest {
  offerAddress: string;
  sellerAddress: string;
  listingAddress: string;
  nonce?: number;
}

export type ListingType = 'FullPosition' | 'PartialPosition';
export type TradeType = 'DirectSale' | 'AcceptedOffer' | 'PartialFill';

export interface ContractsQuery {
  status?: string | string[];
  borrower?: string;
  lender?: string;
  loanType?: string;
  minAmount?: number;
  maxAmount?: number;
  minInterestRate?: number;
  maxInterestRate?: number;
  sortBy?: string;
  page?: number;
  limit?: number;
}

export interface TradeEventsQuery {
  contractAddress?: string;
  lenderAddress?: string;
}

export interface RateBenchmarkQuery {
  collateralMint?: string;
  loanType?: 'demand' | 'committed';
  termBucket?: 'short' | 'medium' | 'long' | 'no_maturity';
  sizeBucket?: 'micro' | 'small' | 'medium' | 'large' | 'whale';
}

export interface BorrowerGuidanceQuery {
  interestRate: number;
  collateralMint?: string;
  loanType?: 'demand' | 'committed';
  termDays?: number;
  amount?: number;
}

export interface SellerGuidanceQuery {
  contractAddress: string;
  lenderAddress: string;
  askingPrice?: number;
}

export interface RateBenchmark {
  segment: {
    collateralMint?: string;
    loanType?: string;
    termBucket?: string;
    sizeBucket?: string;
  };
  p25: number;
  p50: number;
  p75: number;
  average: number;
  volumeWeightedAverage: number;
  min: number;
  max: number;
  count: number;
  totalVolume: number;
  trend7d: number | null;
  trend30d: number | null;
  lowConfidence: boolean;
}

export interface BorrowerGuidance {
  proposedRate: number;
  percentilePosition: number;
  marketMedian: number;
  marketP25: number;
  marketP75: number;
  rateDistribution: Array<{
    rateBucket: string;
    count: number;
  }>;
  fundingVelocity: Array<{
    rateRange: string;
    avgFundingHours: number;
    count: number;
  }>;
  suggestion: string;
}

export interface SellerGuidance {
  fairValueEstimate: number;
  suggestedPriceRange: {
    low: number;
    high: number;
  };
  contractRate: number;
  marketMedianRate: number;
  ratePremiumDiscount: number;
  comparableTransactions: Array<{
    price: number;
    rate: number;
    date: number;
  }>;
  positionDetails: {
    principal: number;
    accruedInterest: number;
    remainingTerm: number;
  };
}

export interface DashboardData {
  benchmarksByCategory: RateBenchmark[];
  rateTrends: Array<{
    period: string;
    averageRate: number;
    volume: number;
  }>;
  volumeByRateRange: Array<{
    rateRange: string;
    volume: number;
    count: number;
  }>;
  spread: {
    askRateAvg: number;
    fundedRateAvg: number;
    spreadBps: number;
  };
}

export type BugSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface SupportMessageRequest {
  name: string;
  email: string;
  message: string;
  walletAddress?: string;
}

export interface BugReportRequest {
  title: string;
  description: string;
  severity?: BugSeverity;
  walletAddress?: string;
}

export interface FeatureRequestSubmissionRequest {
  title: string;
  description: string;
  category?: string;
  contactEmail?: string;
  walletAddress?: string;
}

export type FeatureRequestModerationStatus = 'pending' | 'approved' | 'denied';

export interface FeatureRequestRecord {
  id: number;
  title: string;
  description: string;
  category: string;
  status: FeatureRequestModerationStatus;
  moderationNotes: string | null;
  moderatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PoolOperatorApplicationRequest {
  name: string;
  email: string;
  experience: string;
  strategy: string;
  walletAddress?: string;
  additionalInfo?: string;
}

export interface PoolOperatorApplicationResponse {
  success: true;
  applicationId: number;
}

export interface ComputedContractFields {
  earlyTerminationFeeEstimate: number | null;
  standbyFeeEstimate: number | null;
  healthFactor: number | null;
  nextPaymentAmount: number | null;
  nextPaymentDate: string | null;
  totalRepaid: number;
  remainingPrincipal: number;
  effectiveApr: number | null;
  estimatedPositionValue: number | null;
  suggestedListingPrice: number | null;
  discountPremiumPct: number | null;
}

export interface ContractResponse {
  [key: string]: unknown;
  computed?: ComputedContractFields;
}

export interface WebsocketEventsMetadata {
  eventTypes: string[];
  messages: {
    subscribe: string;
    unsubscribe: string;
    broadcast: string;
  };
  filters: string[];
}

export interface DirectCreateDebtContractInstructionRequest {
  borrowerAddress: string;
  contractSeed: string | number | bigint;
  maxLenders: number;
  targetAmount: string | number | bigint;
  interestRate: number;
  termDays: number;
  collateralAmount: string | number | bigint;
  loanType: LoanTypeInput;
  ltvRatio: number;
  ltvFloorBps: number;
  interestPaymentType: InterestPaymentTypeInput;
  principalPaymentType: PrincipalPaymentTypeInput;
  interestFrequency: PaymentFrequencyInput;
  principalFrequency?: PaymentFrequencyInput | null;
  partialFundingEnabled: boolean;
  allowPartialFill: boolean;
  minPartialFillBps: number;
  isRevolving: boolean;
  standbyFeeRate: number;
  distributionMethod: DistributionMethodInput;
  fundingAccessMode: FundingAccessModeInput;
  stateAddress?: string;
  treasuryAddress?: string;
  collateralRegistryAddress?: string | null;
  collateralMintAddress?: string | null;
  borrowerCollateralAta?: string | null;
  contractCollateralAta?: string | null;
  priceFeedAddress?: string | null;
  usdcMintAddress?: string | null;
  contractUsdcAta?: string | null;
  borrowerUsdcAta?: string | null;
  treasuryUsdcAccount?: string | null;
  frontendOperatorAddress?: string | null;
  frontendUsdcAta?: string | null;
  tokenProgramAddress?: string | null;
  associatedTokenProgramAddress?: string | null;
}

export interface DirectContributeInstructionRequest {
  contractAddress: string;
  lenderAddress: string;
  borrowerAddress: string;
  amount: string | number | bigint;
  stateAddress?: string;
  contributionAddress?: string;
  escrowAddress?: string;
  approvedFunderAddress?: string | null;
  lenderUsdcAccount?: string | null;
  contractUsdcAccount?: string | null;
  borrowerUsdcAccount?: string | null;
  usdcMint?: string | null;
}

export interface DirectMakePaymentInstructionRequest {
  contractAddress: string;
  borrowerAddress: string;
  amount: string | number | bigint;
  stateAddress?: string;
  operationsFundAddress?: string | null;
  borrowerUsdcAccount?: string | null;
  contractUsdcAccount?: string | null;
  contractCollateralAccount?: string | null;
  borrowerCollateralAccount?: string | null;
  contributionEscrowAccounts: Array<{
    contributionAddress: string;
    escrowAddress: string;
  }>;
}

export interface DirectDrawFromRevolvingInstructionRequest {
  contractAddress: string;
  borrowerAddress: string;
  amount: string | number | bigint;
  borrowerUsdcAccount: string;
  contractUsdcAccount: string;
  contributionEscrowAccounts: Array<{
    contributionAddress: string;
    escrowAddress: string;
  }>;
  stateAddress?: string;
  testClockOffsetAddress?: string | null;
  treasuryAddress?: string;
  collateralRegistryAddress?: string | null;
  priceFeedAddress?: string | null;
}

export interface DirectRepayRevolvingInstructionRequest {
  contractAddress: string;
  borrowerAddress: string;
  amount: string | number | bigint;
  borrowerUsdcAccount: string;
  contractUsdcAccount: string;
  contributionEscrowAccounts: Array<{
    contributionAddress: string;
    escrowAddress: string;
  }>;
  stateAddress?: string;
  testClockOffsetAddress?: string | null;
  treasuryAddress?: string;
}

export interface DirectCloseRevolvingFacilityInstructionRequest {
  contractAddress: string;
  borrowerAddress: string;
  borrowerUsdcAccount: string;
  contractUsdcAccount: string;
  treasuryUsdcAccount: string;
  stateAddress?: string;
  testClockOffsetAddress?: string | null;
  treasuryAddress?: string;
}

export interface DirectSweepContractPoolInstructionRequest {
  contractAddress: string;
  borrowerAddress: string;
  contractUsdcAccount: string;
  borrowerUsdcAccount: string;
  stateAddress?: string;
  tokenProgramAddress?: string | null;
}

export interface DirectBotCloseMaturedRevolvingInstructionRequest {
  contractAddress: string;
  botAuthorityAddress: string;
  stateAddress?: string;
  treasuryAddress?: string;
  testClockOffsetAddress?: string | null;
  tokenProgramAddress?: string | null;
}

export interface DirectDistributeStandbyFeesInstructionRequest {
  contractAddress: string;
  botAuthorityAddress: string;
  contractUsdcAccount: string;
  standbyDistributionAccounts: Array<{
    contributionAddress: string;
    escrowAddress: string;
    escrowUsdcAccount: string;
  }>;
  stateAddress?: string;
  treasuryAddress?: string;
}

export interface DirectClaimFromEscrowInstructionRequest {
  contractAddress: string;
  lenderAddress: string;
  escrowAddress: string;
  escrowUsdcAccount?: string | null;
  lenderUsdcAccount?: string | null;
  tokenProgramAddress?: string | null;
}

export interface DirectRefundLenderInstructionRequest {
  contractAddress: string;
  lenderAddress: string;
  contributionAddress: string;
  escrowAddress: string;
  contractUsdcAccount?: string | null;
  lenderUsdcAccount?: string | null;
  tokenProgramAddress?: string | null;
}

export interface DirectWithdrawContributionInstructionRequest {
  contractAddress: string;
  lenderAddress: string;
  contributionAddress?: string;
  escrowAddress?: string;
  contractUsdcAccount?: string | null;
  lenderUsdcAccount?: string | null;
  tokenProgramAddress?: string | null;
}

export interface DirectApproveFunderInstructionRequest {
  contractAddress: string;
  borrowerAddress: string;
  lenderAddress: string;
  approvedFunderAddress?: string;
}

export interface DirectCancelContractInstructionRequest {
  contractAddress: string;
  borrowerAddress: string;
  operationsFundAddress?: string | null;
  contractCollateralAta?: string | null;
  borrowerCollateralAta?: string | null;
  tokenProgramAddress?: string | null;
}

export interface DirectCreateTermProposalInstructionRequest extends CreateTermProposalRequest {
  proposalAddress?: string;
  proposerVoteAddress?: string;
  proposerCooldownAddress?: string;
}

export interface DirectVoteOnProposalInstructionRequest extends VoteOnProposalRequest {
  proposalAddress?: string;
  voteAddress?: string;
  proposerCooldownAddress?: string;
  voterContributionAddress?: string;
}

export interface DirectCancelTermProposalInstructionRequest extends CancelTermProposalRequest {
  proposalAddress?: string;
}

export interface DirectExpireTermProposalInstructionRequest extends ExpireTermProposalRequest {
  proposalAddress?: string;
  proposerCooldownAddress?: string;
}

export interface DirectCloseProposalAccountsInstructionRequest extends CloseProposalAccountsRequest {
  proposalAddress?: string;
}

export interface DirectProcessProposalRecallInstructionRequest
  extends ProcessProposalRecallRequest {}

export interface DirectProcessRecallInstructionRequest {
  contractAddress: string;
  botAuthorityAddress: string;
  contributionAddress: string;
  escrowAddress: string;
  borrowerAddress: string;
  botUsdcAta: string;
  contractUsdcAta: string;
  escrowUsdcAta: string;
  treasuryUsdcAta: string;
  contractCollateralAta: string;
  botCollateralAta: string;
  treasuryAddress?: string;
  stateAddress?: string;
  testClockOffsetAddress?: string | null;
  frontendUsdcAta?: string | null;
  tokenProgramAddress?: string | null;
}

export interface DirectClaimPoolYieldInstructionRequest {
  depositorAddress: string;
  poolAddress: string;
  poolDepositAddress: string;
  poolVaultAddress: string;
  depositorUsdcAta: string;
  treasuryUsdcAccount: string;
  stateAddress?: string;
  treasuryAddress?: string;
  frontendUsdcAta?: string | null;
  tokenProgramAddress?: string | null;
}

export interface DirectSetYieldPreferenceInstructionRequest {
  depositorAddress: string;
  poolAddress: string;
  poolDepositAddress: string;
  preference: number;
}

export interface DirectCompoundPoolYieldInstructionRequest {
  callerAddress: string;
  poolAddress: string;
  poolDepositAddress: string;
  depositorAddress: string;
  poolVaultAddress: string;
  treasuryUsdcAccount: string;
  stateAddress?: string;
  treasuryAddress?: string;
  frontendUsdcAta?: string | null;
  tokenProgramAddress?: string | null;
}

export interface DirectBotClaimPoolYieldInstructionRequest {
  botAuthorityAddress: string;
  poolAddress: string;
  poolDepositAddress: string;
  depositorAddress: string;
  poolVaultAddress: string;
  depositorUsdcAta: string;
  treasuryUsdcAccount: string;
  stateAddress?: string;
  treasuryAddress?: string;
  frontendUsdcAta?: string | null;
  tokenProgramAddress?: string | null;
}

export interface DirectProposePoolChangesInstructionRequest {
  operatorAddress: string;
  poolAddress: string;
  rateBps?: number | null;
  capacity?: string | number | bigint | null;
  minimumDeposit?: string | number | bigint | null;
  allowedLoanType?: number | null;
  minLtvBps?: number | null;
  maxTermDays?: number | null;
  withdrawalQueueEnabled?: boolean | null;
  pendingChangeAddress?: string;
}

export interface DirectApplyPoolChangesInstructionRequest {
  operatorAddress: string;
  poolAddress: string;
  pendingChangeAddress?: string;
}

export interface DirectCancelPoolChangesInstructionRequest {
  operatorAddress: string;
  poolAddress: string;
  pendingChangeAddress?: string;
}

export type FixedNameInput = string | number[] | Uint8Array;

export interface DirectUpdatePoolNameInstructionRequest {
  operatorAddress: string;
  poolAddress: string;
  name: FixedNameInput;
}

export interface DirectUpdateOperatorNameInstructionRequest {
  operatorAddress: string;
  name: FixedNameInput;
  operatorAuthAddress?: string;
}

// ---------------------------------------------------------------------------
// Async Job Contract Types
// ---------------------------------------------------------------------------

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface JobSubmissionRequest {
  tool: string;
  params: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface JobSubmissionResponse {
  jobId: string;
  status: JobStatus;
  createdAt: number;
}

export interface JobStatusResponse {
  jobId: string;
  status: JobStatus;
  tool: string;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface JobListQuery {
  status?: JobStatus | JobStatus[];
  tool?: string;
  limit?: number;
  cursor?: string;
}

export interface JobListResponse {
  jobs: JobStatusResponse[];
  nextCursor?: string;
  total: number;
}

export interface JobCancelResponse {
  jobId: string;
  status: JobStatus;
  cancelled: boolean;
}
