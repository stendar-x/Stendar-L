export type ParsedContractStatus =
  | 'OpenNotFunded'
  | 'OpenPartiallyFunded'
  | 'Active'
  | 'PendingRecall'
  | 'Completed'
  | 'Cancelled'
  | 'Liquidated';

export type ParsedLoanType = 'Demand' | 'Committed';

export type ParsedPaymentFrequency = 'Daily' | 'Weekly' | 'BiWeekly' | 'Monthly';

export type ParsedInterestPaymentType = 'OutstandingBalance' | 'CollateralTransfer';

export type ParsedPrincipalPaymentType = 'CollateralDeduction' | 'NoFixedPayment';

export type ParsedProposalStatus = 'Pending' | 'Approved' | 'Rejected' | 'Expired' | 'Cancelled';

export type ParsedVoteChoice = 'Approve' | 'Reject';

export type ParsedListingType = 'FullPosition' | 'PartialPosition';

export type ParsedTradeType = 'DirectSale' | 'AcceptedOffer' | 'PartialFill';

export interface ParsedContractAccount {
  layout: 'current';
  borrower: string;
  contractSeed: string | null;
  targetAmount: number;
  targetAmountRaw: string;
  fundedAmount: number;
  fundedAmountRaw: string;
  interestRate: number;
  termDays: number;
  collateralAmountRaw: string;
  loanType: ParsedLoanType | 'Unknown';
  ltvRatioBps: string;
  interestPaymentType: ParsedInterestPaymentType | 'Unknown';
  principalPaymentType: ParsedPrincipalPaymentType | 'Unknown';
  interestFrequency: ParsedPaymentFrequency | 'Unknown';
  principalFrequency: ParsedPaymentFrequency | null | 'Unknown';
  createdAt: string;
  status: ParsedContractStatus | 'Unknown';
  numContributions: number;
  outstandingBalance: number;
  outstandingBalanceRaw: string;
  accruedInterest: number;
  accruedInterestRaw: string;
  lastInterestUpdate: string;
  lastPrincipalPayment: string;
  totalPrincipalPaid: number;
  totalPrincipalPaidRaw: string;
  contributions: string[];
  lastBotUpdate: string;
  nextInterestPaymentDue: string;
  nextPrincipalPaymentDue: string;
  botOperationCount: string;
  maxLenders: number;
  partialFundingFlag: number;
  expiresAt: string;
  allowPartialFill: boolean;
  minPartialFillBps: number;
  listingFeePaid: number;
  listingFeePaidRaw: string;
  fundingAccessMode: 'Public' | 'AllowlistOnly';
  hasActiveProposal: boolean;
  proposalCount: string;
  uncollectableBalance: number;
  uncollectableBalanceRaw: string;
  totalPrepaymentFees: number;
  totalPrepaymentFeesRaw: string;
  accountVersion: number | null;
  contractVersion: number | null;
  collateralMint: string | null;
  collateralTokenAccount: string | null;
  collateralValueAtCreation: number | null;
  collateralValueAtCreationRaw: string | null;
  ltvFloorBps: number | null;
  loanMint: string | null;
  loanTokenAccount: string | null;
  recallRequested: boolean | null;
  recallRequestedAt: string | null;
  recallRequestedBy: string | null;
}

export interface ParsedContributionAccount {
  layout: 'current_147';
  lender: string;
  contract: string;
  contributionAmount: number;
  contributionAmountRaw: string;
  totalInterestClaimed: number;
  totalInterestClaimedRaw: string;
  totalPrincipalClaimed: number;
  totalPrincipalClaimedRaw: string;
  lastClaimTimestamp: string;
  isRefunded: boolean;
  createdAt: string;
  lastContributedAt: string | null;
  refundedDeprecated: boolean | null;
  accountVersion: number | null;
}

export interface ParsedEscrowAccount {
  lender: string;
  contract: string;
  escrowTokenAccount: string;
  escrowAmount: number;
  escrowAmountRaw: string;
  availableInterest: number;
  availableInterestRaw: string;
  availablePrincipal: number;
  availablePrincipalRaw: string;
  totalClaimed: number;
  totalClaimedRaw: string;
  isReleased: boolean;
  createdAt: string;
  reservedHex: string;
  accountVersion: number;
}

export interface ParsedCollateralType {
  mint: string;
  oraclePriceFeed: string;
  decimals: number;
  liquidationBufferBps: number;
  minCommittedFloorBps: number;
  isActive: boolean;
}

export interface ParsedCollateralRegistryAccount {
  authority: string;
  numCollateralTypes: number;
  collateralTypes: ParsedCollateralType[];
}

export interface ParsedProposalAccount {
  contract: string;
  proposer: string;
  proposalId: string;
  proposedInterestRate: number;
  proposedTermDays: number;
  proposedInterestFrequency: ParsedPaymentFrequency | 'Unknown';
  proposedPrincipalFrequency: ParsedPaymentFrequency | null | 'Unknown';
  proposedInterestPaymentType: ParsedInterestPaymentType | 'Unknown';
  proposedPrincipalPaymentType: ParsedPrincipalPaymentType | 'Unknown';
  proposedLtvRatioBps: string;
  proposedLtvFloorBps: number;
  participantKeys: string[];
  totalParticipants: number;
  approvals: number;
  rejections: number;
  status: ParsedProposalStatus | 'Unknown';
  createdAt: string;
  expiresAt: string;
  resolvedAt: string;
  recallPledgedCount: number;
  recallPledgedAmountRaw: string;
  recallsProcessed: number;
  recallGraceStart: string;
  reservedHex: string;
  accountVersion: number;
}

export interface ParsedProposalVoteAccount {
  proposal: string;
  voter: string;
  voteChoice: ParsedVoteChoice | 'Unknown';
  votedAt: string;
  recallOnRejection: boolean;
  reservedHex: string;
  accountVersion: number;
}

export interface ParsedListingAccount {
  contract: string;
  seller: string;
  contribution: string;
  listingAmount: number;
  listingAmountRaw: string;
  askingPrice: number;
  askingPriceRaw: string;
  listingType: ParsedListingType | 'Unknown';
  createdAt: string;
  expiresAt: string;
  isActive: boolean;
  offerCount: number;
  highestOffer: number;
  highestOfferRaw: string;
  nonce: number;
}

export interface ParsedOfferAccount {
  listing: string;
  buyer: string;
  purchaseAmount: number;
  purchaseAmountRaw: string;
  offeredPrice: number;
  offeredPriceRaw: string;
  createdAt: string;
  expiresAt: string;
  isActive: boolean;
  nonce: number;
}

export interface ParsedTradeEventAccount {
  contract: string;
  contribution: string;
  seller: string;
  buyer: string;
  amountTraded: number;
  amountTradedRaw: string;
  salePrice: number;
  salePriceRaw: string;
  platformFee: number;
  platformFeeRaw: string;
  buyerFee: number;
  buyerFeeRaw: string;
  tradeType: ParsedTradeType | 'Unknown';
  timestamp: string;
  nonce: number;
}
