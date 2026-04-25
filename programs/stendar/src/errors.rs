use anchor_lang::prelude::*;

// Error codes
#[error_code]
pub enum StendarError {
    #[msg("Contract is not open for contributions")]
    ContractNotOpen,
    #[msg("Contract is not funded")]
    ContractNotFunded,
    #[msg("Contract is not cancelled")]
    ContractNotCancelled,
    #[msg("Contract listing has not expired yet")]
    ContractNotExpired,
    #[msg("Contract is not in default")]
    ContractNotInDefault,
    #[msg("Invalid contribution amount")]
    InvalidContributionAmount,
    #[msg("Maximum number of lenders reached for this contract's configured cap")]
    MaxLendersReached,
    #[msg("Last lender slot must contribute the exact remaining amount to reach the target")]
    LastLenderMustFillRemaining,
    #[msg("Partial funding is disabled for this contract")]
    PartialFundingDisabled,
    #[msg("Partial fill at expiry is not enabled for this contract")]
    PartialFillNotAllowed,
    #[msg("Current funding is below the configured partial fill threshold")]
    BelowMinimumFillThreshold,
    #[msg("Invalid max lenders value (must be between 1 and protocol max)")]
    InvalidMaxLenders,
    #[msg("Invalid payment amount")]
    InvalidPaymentAmount,
    #[msg("Invalid interest rate")]
    InvalidInterestRate,
    #[msg("Invalid standby fee rate")]
    InvalidStandbyFeeRate,
    #[msg("Contract is not configured as revolving")]
    RevolvingNotEnabled,
    #[msg("Revolving facility is already closed")]
    RevolvingFacilityClosed,
    #[msg("Requested draw exceeds available amount")]
    DrawExceedsAvailable,
    #[msg("Contract token account balance is insufficient for this operation")]
    InsufficientContractBalance,
    #[msg("Draw would breach configured LTV constraints")]
    RevolvingLtvBreach,
    #[msg("Revolving contracts require NoFixedPayment principal mode")]
    RevolvingPrincipalPaymentNotAllowed,
    #[msg("Revolving principal repayment must use repay_revolving")]
    RevolvingPaymentMustUseRepay,
    #[msg("Operation is not allowed after contract maturity")]
    PastMaturity,
    #[msg("Fee exceeds configured maximum")]
    FeeTooHigh,
    #[msg("Contribution exceeds target amount")]
    ExceedsTargetAmount,
    #[msg("Unauthorized cancellation")]
    UnauthorizedCancellation,
    #[msg("Cannot cancel contract in current status")]
    CannotCancelContract,
    #[msg("Contribution already refunded")]
    AlreadyRefunded,
    #[msg("Invalid contribution for this contract")]
    InvalidContribution,
    #[msg("Payment exceeds amount owed")]
    ExcessivePayment,
    #[msg("Unauthorized payment attempt")]
    UnauthorizedPayment,
    #[msg("Lender is not approved to fund this contract")]
    LenderNotApproved,
    #[msg("Lender is already approved for this contract")]
    FunderAlreadyApproved,
    #[msg("Approved funder account does not match the expected contract or lender")]
    InvalidApprovedFunderAccount,
    #[msg("Borrower cannot fund their own contract")]
    SelfFundingNotAllowed,
    #[msg("Self-liquidation not allowed")]
    SelfLiquidationNotAllowed,
    #[msg("Recall is only allowed for demand contracts")]
    RecallNotAllowed,
    #[msg("Recall is only available for demand loans")]
    NotDemandLoan,
    #[msg("A recall is already pending for this contract")]
    RecallAlreadyPending,
    #[msg("No recall has been requested for this contract")]
    NoRecallPending,
    #[msg("Recall grace period has not elapsed yet")]
    RecallGracePeriodNotElapsed,
    #[msg("Recall grace period has elapsed")]
    RecallGracePeriodElapsed,
    #[msg("Unauthorized claim attempt")]
    UnauthorizedClaim,
    #[msg("Payment not required for this contract type")]
    PaymentNotRequired,
    #[msg("No payment due")]
    NoPaymentDue,
    #[msg("Payment not due yet based on frequency")]
    PaymentNotDue,
    #[msg("Unauthorized treasury withdrawal")]
    UnauthorizedWithdrawal,
    #[msg("Invalid withdrawal amount")]
    InvalidWithdrawalAmount,
    #[msg("Insufficient treasury balance")]
    InsufficientTreasuryBalance,
    #[msg("Invalid authority provided")]
    InvalidAuthority,
    #[msg("Unauthorized authority update")]
    UnauthorizedAuthorityUpdate,
    #[msg("Unauthorized bot operation - only authorized bot can execute automated operations")]
    UnauthorizedBotOperation,
    #[msg("Platform is paused")]
    PlatformPaused,
    // Trading-specific error codes
    #[msg("Unauthorized listing creation")]
    UnauthorizedListing,
    #[msg("Contract is not active for trading")]
    ContractNotActive,
    #[msg("Trade listing is not active")]
    InactiveListing,
    #[msg("Unauthorized acceptance of offer")]
    UnauthorizedAcceptance,
    #[msg("Invalid trade offer")]
    InvalidOffer,
    #[msg("Trade offer is not active")]
    InactiveOffer,
    #[msg("Unauthorized position transfer")]
    UnauthorizedTransfer,
    #[msg("Listing amount below minimum threshold")]
    ListingAmountTooSmall,
    #[msg("Invalid trade amount")]
    InvalidTradeAmount,
    #[msg("Insufficient funds for trade")]
    InsufficientFunds,
    #[msg("Trade offer has expired")]
    TradeOfferExpired,
    #[msg("Trade listing has expired")]
    TradeListingExpired,
    #[msg("Trade listing has not expired yet")]
    ListingNotExpired,
    #[msg("Cannot trade position in current contract state")]
    PositionNotTradeable,
    #[msg("Invalid position valuation")]
    InvalidPositionValuation,
    #[msg("Invalid trade price specified")]
    InvalidTradePrice,
    #[msg("Invalid contract reference")]
    InvalidContractReference,
    #[msg("Arithmetic overflow detected in calculation")]
    ArithmeticOverflow,
    #[msg("Oracle price feed is stale")]
    OraclePriceStale,
    #[msg("Oracle returned a negative price")]
    OraclePriceNegative,
    #[msg("Oracle price feed unavailable")]
    OraclePriceUnavailable,
    #[msg("Price calculation overflow")]
    OracleCalculationOverflow,
    #[msg("Invalid recipient account")]
    InvalidRecipient,
    #[msg("Operations fund is insufficient to reimburse the bot")]
    OperationsFundInsufficient,
    #[msg("Operations fund is inactive")]
    OperationsFundInactive,
    #[msg("Account must be migrated to the latest layout version")]
    AccountNeedsMigration,
    #[msg("Collateral registry has reached maximum capacity")]
    CollateralRegistryFull,
    #[msg("Collateral type already exists in registry")]
    CollateralTypeAlreadyExists,
    #[msg("Collateral type not found in registry")]
    CollateralTypeNotFound,
    #[msg("Collateral type is not in the registry")]
    CollateralTypeNotApproved,
    #[msg("Collateral type is inactive")]
    CollateralTypeInactive,
    #[msg("Collateral value does not meet minimum LTV + buffer requirement")]
    InsufficientCollateral,
    #[msg("LTV floor is below the minimum for this collateral type")]
    LtvFloorBelowMinimum,
    #[msg("Demand loan LTV floor must be at least 105%")]
    DemandLoanFloorTooLow,
    #[msg("Oracle price feed does not match registry entry")]
    OraclePriceFeedMismatch,
    #[msg("Liquidation buffer must be between 1 and 2000 basis points")]
    InvalidLiquidationBuffer,
    #[msg("Minimum committed floor must be greater than 0")]
    InvalidMinFloor,
    #[msg("Provided decimals do not match mint decimals")]
    DecimalsMismatch,
    #[msg("Required token accounts were not provided")]
    MissingTokenAccounts,
    #[msg("Provided mint is not the configured USDC mint")]
    InvalidUsdcMint,
    #[msg("Invalid mint provided")]
    InvalidMint,
    #[msg("Token account does not match expected owner or mint")]
    TokenAccountMismatch,
    #[msg("This operation is not supported for this contract layout")]
    InvalidContractVersion,
    #[msg("Cannot liquidate a healthy position")]
    PositionHealthy,
    #[msg("Not enough collateral to cover liquidation")]
    InsufficientCollateralForLiquidation,
    #[msg("A term amendment proposal is already active for this contract")]
    ProposalAlreadyActive,
    #[msg("Proposer is on cooldown for this contract")]
    ProposerOnCooldown,
    #[msg("Proposal is not pending")]
    ProposalNotPending,
    #[msg("Proposal has already expired")]
    ProposalExpired,
    #[msg("Proposal has not expired yet")]
    ProposalNotExpired,
    #[msg("Participant has already voted on this proposal")]
    AlreadyVoted,
    #[msg("Signer is not an active participant for this contract")]
    NotContractParticipant,
    #[msg("Proposed terms match existing contract terms")]
    NoTermChanges,
    #[msg("Proposed terms are invalid")]
    InvalidProposedTerms,
    #[msg("Only the proposal creator can cancel this proposal")]
    UnauthorizedProposalCancel,
    #[msg("Proposer vote is auto-recorded and cannot be cast again")]
    ProposerCannotVote,
    #[msg("Missing contribution accounts needed to build proposal participants")]
    MissingContributionAccounts,
    #[msg("Proposal ID does not match the expected next value")]
    InvalidProposalId,
    #[msg("Invalid proposal participant snapshot")]
    InvalidProposalParticipants,
    #[msg("Recall pledging is not allowed for committed loans")]
    RecallPledgeNotAllowedForCommittedLoans,
    #[msg("Only lenders can pledge recall on proposal rejection/expiry")]
    RecallPledgeLenderOnly,
    #[msg("Proposal recall grace period has not elapsed yet")]
    ProposalRecallGraceNotElapsed,
    #[msg("No recall pledge is set on this vote")]
    NoRecallPledgeOnVote,
    #[msg("Proposal must be rejected or expired to process pledged recalls")]
    ProposalNotRejectedOrExpired,
    #[msg("Must wait 60 seconds after contributing before withdrawing")]
    WithdrawalCooldownNotElapsed,
    #[msg("Can only withdraw from open (unfunded or partially funded) contracts")]
    ContractNotOpenForWithdrawal,
    #[msg("Escrow still has unclaimed funds")]
    EscrowNotEmpty,
    #[msg("Pool operator is not authorized")]
    PoolOperatorNotAuthorized,
    #[msg("Pool is not active")]
    PoolNotActive,
    #[msg("Pool is paused")]
    PoolPaused,
    #[msg("Pool capacity cannot be lower than current total deposits")]
    PoolCapacityBelowDeposits,
    #[msg("Pool capacity exceeded")]
    PoolCapacityExceeded,
    #[msg("Insufficient pool liquidity for withdrawal")]
    InsufficientPoolLiquidity,
    #[msg("Deposit below pool minimum")]
    PoolDepositBelowMinimum,
    #[msg("Pool still has depositors")]
    PoolNotEmpty,
    #[msg("Withdrawal already queued")]
    PoolWithdrawalAlreadyQueued,
    #[msg("No withdrawal queued")]
    PoolWithdrawalNotQueued,
    #[msg("Cannot disable withdrawal queue while requests are pending")]
    PoolHasPendingWithdrawals,
    #[msg("Invalid pool operator")]
    InvalidPoolOperator,
    #[msg("Pool utilization must be zero to close")]
    PoolUtilizationNotZero,
    #[msg("Pool is not idle or has not been idle long enough for auto-expiration")]
    PoolNotIdle,
    #[msg("Pool rate updates must respect the minimum interval")]
    RateChangeTooFrequent,
    #[msg("Timelock has not expired yet. Changes can only be applied after the 72-hour waiting period.")]
    TimelockNotExpired,
    #[msg("At least one parameter must be changed in a pool change proposal.")]
    NoChangesProposed,
    #[msg("Contract does not meet pool loan type requirement")]
    PoolLoanTypeMismatch,
    #[msg("Contract does not meet pool deployment rules")]
    PoolDeploymentRuleViolation,
    #[msg("Pool must be paused before returning deposits")]
    PoolNotPausedForReturn,
    #[msg("Account is already on the latest layout version")]
    AlreadyMigrated,
    #[msg("Frontend USDC account does not match the stored frontend operator")]
    FrontendTokenAccountMismatch,
    #[msg("Invalid yield preference value")]
    InvalidYieldPreference,
    #[msg("Yield preference does not match the requested operation")]
    YieldPreferenceMismatch,
}
