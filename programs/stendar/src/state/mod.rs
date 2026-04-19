use crate::errors::StendarError;
use anchor_lang::prelude::*;

// Re-export submodules
pub use enums::*;
pub use pools::*;
pub use proposals::*;
// Query/bot helper types are off-chain conveniences and are not required for on-chain execution.
// Keep them out of the deployed binary to reduce program size.
#[cfg(not(target_os = "solana"))]
pub use bot::*;
#[cfg(not(target_os = "solana"))]
pub use query::*;
pub use trading::*;

// Import submodules
#[cfg(not(target_os = "solana"))]
mod bot;
mod enums;
pub mod pools;
mod proposals;
#[cfg(not(target_os = "solana"))]
mod query;
mod trading;

// Constants for PDA derivation
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const OPERATIONS_FUND_SEED: &[u8] = b"operations_fund";
pub const APPROVED_FUNDER_SEED: &[u8] = b"approved_funder";
pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_DEPOSIT_SEED: &[u8] = b"pool_deposit";
pub const POOL_OPERATOR_SEED: &[u8] = b"pool_operator";
pub const PENDING_POOL_CHANGE_SEED: &[u8] = b"pending_pool_change";
pub const CURRENT_ACCOUNT_VERSION: u16 = 1;
pub const MAX_PROTOCOL_LENDERS: u16 = 100;
pub const RESERVED_TAIL_BYTES: usize = 64;
pub const LENDER_CONTRIBUTION_RESERVED_BYTES: usize = 24;
pub const LENDER_ESCROW_RESERVED_BYTES: usize = 32;
pub const APPROVED_FUNDER_RESERVED_BYTES: usize = 32;
pub const COLLATERAL_REGISTRY_SEED: &[u8] = b"collateral_registry";
pub const MOCK_ORACLE_PRICE_FEED_SEED: &[u8] = b"mock_oracle_price_feed";
pub const TEST_CLOCK_OFFSET_SEED: &[u8] = b"test_clock_offset";
pub const FRONTEND_OPERATOR_SEED: &[u8] = b"frontend_operator";
pub const POOL_CHANGE_TIMELOCK_SECONDS: i64 = 259_200; // 72 hours
pub const POOL_IDLE_EXPIRY_SECONDS: i64 = 2_592_000; // 30 days
pub const DEMAND_LOAN_MIN_FLOOR_BPS: u16 = 10_500; // 105% minimum floor for demand loans
pub const LIQUIDATION_FEE_BPS: u16 = 300; // 3% liquidation fee
pub const RECALL_FEE_BPS: u16 = 200; // 2% demand recall fee
pub const PREPAYMENT_FEE_BPS: u16 = 200; // 2% voluntary principal prepayment fee
pub const FRONTEND_FEE_SHARE_BPS: u16 = 5_000; // 50% frontend share on protocol fees.
pub const MIN_FRONTEND_FEE_SHARE_BPS: u16 = 2_000; // Compile-time floor of 20%.
pub const RECALL_GRACE_PERIOD_SECONDS: i64 = 259_200; // 72 hours
pub const PARTIAL_LIQUIDATION_CAP_BPS: u16 = 5_000; // 50% max per partial liquidation

/// Registry of approved collateral assets for standard cross-collateral contracts.
#[account]
pub struct CollateralRegistry {
    /// Must match State.authority; validated at instruction time by validate_registry_authority.
    pub authority: Pubkey,
    pub num_collateral_types: u8,
    pub collateral_types: Vec<CollateralType>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CollateralType {
    pub mint: Pubkey,
    pub oracle_price_feed: Pubkey,
    pub decimals: u8,
    pub liquidation_buffer_bps: u16,
    pub min_committed_floor_bps: u16,
    pub is_active: bool,
}

impl CollateralRegistry {
    pub const MAX_COLLATERAL_TYPES: usize = 20;
    pub const COLLATERAL_TYPE_SIZE: usize = 32 + 32 + 1 + 2 + 2 + 1; // 70 bytes
    pub const LEN: usize =
        8 + 32 + 1 + 4 + (Self::MAX_COLLATERAL_TYPES * Self::COLLATERAL_TYPE_SIZE);

    pub fn find_collateral_type(&self, mint: &Pubkey) -> Option<&CollateralType> {
        self.collateral_types.iter().find(|ct| ct.mint == *mint)
    }
}

/// Program-owned mock oracle used by local integration tests.
///
/// This account is authority-gated and only accepted by the oracle parser when
/// the feed account owner is this program id.
#[account]
pub struct MockOraclePriceFeed {
    pub authority: Pubkey,
    pub feed_seed: u64,
    pub price: i64,
    pub exponent: i32,
    pub publish_time: i64,
}

impl MockOraclePriceFeed {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 4 + 8;
}

/// Test-only clock offset account used to deterministically exercise long time gates.
///
/// The offset is authority-gated and optional in instructions; production flows can
/// ignore it by omitting the account.
#[account]
pub struct TestClockOffset {
    pub authority: Pubkey,
    pub offset_seconds: i64,
}

impl TestClockOffset {
    pub const LEN: usize = 8 + 32 + 8;
}

/// Global platform state account
///
/// Stores platform-wide statistics and configuration settings.
/// This account is created once during platform initialization.
#[account]
pub struct State {
    /// Platform governance authority.
    /// Recovery is controlled by the program upgrade authority path.
    pub authority: Pubkey,
    pub total_debt: u64,
    pub total_collateral: u64,
    pub total_interest_paid: u64,
    pub total_liquidations: u64,
    pub total_partial_liquidations: u64,
    pub total_contracts: u64,
    pub platform_fee_basis_points: u16,
    /// Fee rates stored in tenths-of-basis-points (1 = 0.001%, divisor 100_000).
    pub pool_deposit_fee_bps: u16,
    /// Fee rates stored in tenths-of-basis-points (1 = 0.001%, divisor 100_000).
    pub pool_yield_fee_bps: u16,
    /// Fee rates stored in tenths-of-basis-points (1 = 0.001%, divisor 100_000).
    pub primary_listing_fee_bps: u16,
    /// Fee rates stored in tenths-of-basis-points (1 = 0.001%, divisor 100_000).
    pub secondary_listing_fee_bps: u16,
    /// Fee rates stored in tenths-of-basis-points (1 = 0.001%, divisor 100_000).
    pub secondary_buyer_fee_bps: u16,
    pub is_paused: bool,
    pub account_version: u16,
}

impl State {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 2 + 2 + 2 + 2 + 2 + 2 + 1 + 2;
}

/// Individual debt contract account
///
/// Represents a single lending contract between borrowers and lenders.
/// Contains all terms, status, and financial tracking for the loan.
#[account]
pub struct DebtContract {
    pub borrower: Pubkey,
    pub contract_seed: u64,
    pub target_amount: u64,
    pub funded_amount: u64,
    pub interest_rate: u32,
    pub term_days: u32,
    pub collateral_amount: u64,
    pub loan_type: LoanType,
    pub ltv_ratio: u32,
    pub interest_payment_type: InterestPaymentType,
    pub principal_payment_type: PrincipalPaymentType,
    pub interest_frequency: PaymentFrequency,
    pub principal_frequency: Option<PaymentFrequency>,
    pub created_at: i64,
    pub status: ContractStatus,
    pub num_contributions: u32,
    pub outstanding_balance: u64,
    pub accrued_interest: u64,
    pub last_interest_update: i64,
    pub last_principal_payment: i64,
    pub total_principal_paid: u64,
    pub contributions: Vec<Pubkey>,
    // Bot tracking fields for automated operations
    pub last_bot_update: i64,
    pub next_interest_payment_due: i64,
    pub next_principal_payment_due: i64,
    pub bot_operation_count: u64,
    /// Borrower-defined cap on the number of lenders allowed to contribute.
    pub max_lenders: u16,
    /// Flag for whether multi-lender partial funding is enabled.
    pub partial_funding_flag: u8,
    /// Unix timestamp when this listing expires (0 when expiry is not configured).
    pub expires_at: i64,
    /// Whether the borrower allows partial fill activation when listing expires.
    pub allow_partial_fill: bool,
    /// Minimum fill threshold (basis points) required to activate partial funding.
    pub min_partial_fill_bps: u16,
    /// Listing fee charged at creation (tracked for expiry refunds).
    pub listing_fee_paid: u64,
    /// Controls whether the contract accepts public or allowlist-only funding.
    pub funding_access_mode: FundingAccessMode,
    /// Whether there is currently an active term amendment proposal.
    pub has_active_proposal: bool,
    /// Monotonically increasing proposal id counter.
    pub proposal_count: u64,
    /// Balance that remained uncollectable after full liquidation.
    pub uncollectable_balance: u64,
    /// Aggregate prepayment fees collected over the contract lifetime.
    pub total_prepayment_fees: u64,
    /// Version for account layout compatibility.
    pub account_version: u16,
    // --- Appended fields kept for layout compatibility ---
    pub contract_version: u8,              // 2 for standard contracts
    pub collateral_mint: Pubkey,           // SPL token mint used as collateral
    pub collateral_token_account: Pubkey,  // ATA holding collateral for this contract
    pub collateral_value_at_creation: u64, // USDC value of collateral at creation
    pub ltv_floor_bps: u32,                // Borrower-set minimum LTV in basis points
    pub loan_mint: Pubkey,                 // USDC mint for contracts
    pub loan_token_account: Pubkey,        // Contract's USDC ATA
    pub recall_requested: bool,            // Whether a demand recall is pending
    pub recall_requested_at: i64,          // Recall request timestamp (0 if none)
    pub recall_requested_by: Pubkey,       // Lender who requested recall
    /// Whether this contract is an active revolving line of credit.
    pub is_revolving: bool,
    /// Maximum drawable principal while the facility is open.
    pub credit_limit: u64,
    /// Current borrowed principal outstanding on the revolving facility.
    pub drawn_amount: u64,
    /// Cached drawable capacity (`credit_limit - drawn_amount` when open).
    pub available_amount: u64,
    /// Annual standby-fee rate in basis points charged on undrawn capacity.
    pub standby_fee_rate: u32,
    /// Standby fees accrued but not yet distributed.
    pub accrued_standby_fees: u64,
    /// Timestamp of the last standby-fee accrual checkpoint.
    pub last_standby_fee_update: i64,
    /// Number of successful draw operations.
    pub total_draws: u32,
    /// Lifetime total standby fees paid to lenders.
    pub total_standby_fees_paid: u64,
    /// Facility closed flag; when true no additional draws are allowed.
    pub revolving_closed: bool,
    /// Empty tail buffer reserved for future additive changes.
    pub _reserved: [u8; RESERVED_TAIL_BYTES],
}

impl DebtContract {
    // NOTE: Keep this in sync with the deployed on-chain account layout / IDL.
    // The production `DebtContract` account does not include a `processing` flag.
    pub const FRONTEND_RESERVED_START: usize = 0;
    pub const FRONTEND_RESERVED_END: usize = 32;
    pub const LEGACY_CONTRIBUTION_SLOTS: u16 = 14;
    pub const CONTRIBUTION_KEY_BYTES: usize = 32;
    pub const BASE_LEN: usize = 8
        + 32
        + 8
        + 8
        + 8
        + 4
        + 4
        + 8
        + 1
        + 4
        + 1
        + 1
        + 1
        + 2
        + 8
        + 1
        + 4
        + 8
        + 8
        + 8
        + 8
        + 8
        + 4
        + 8
        + 8
        + 8
        + 8
        + 2
        + 1
        + 8
        + 1
        + 2
        + 8
        + 1
        + 1
        + 8
        + 8
        + 8
        + 2
        + 1
        + 32
        + 32
        + 8
        + 4
        + 32
        + 32
        + 1
        + 8
        + 32
        + 1
        + 8
        + 8
        + 8
        + 4
        + 8
        + 8
        + 4
        + 8
        + 1
        + RESERVED_TAIL_BYTES;
    pub const LEN: usize = Self::space(Self::LEGACY_CONTRIBUTION_SLOTS);

    pub const fn space(max_lenders: u16) -> usize {
        Self::BASE_LEN + (Self::CONTRIBUTION_KEY_BYTES * max_lenders as usize)
    }

    pub fn frontend(&self) -> Pubkey {
        let mut frontend_bytes = [0u8; 32];
        frontend_bytes.copy_from_slice(
            &self._reserved[Self::FRONTEND_RESERVED_START..Self::FRONTEND_RESERVED_END],
        );
        Pubkey::new_from_array(frontend_bytes)
    }

    pub fn set_frontend(&mut self, frontend: Pubkey) {
        self._reserved[Self::FRONTEND_RESERVED_START..Self::FRONTEND_RESERVED_END]
            .copy_from_slice(frontend.as_ref());
    }

    pub fn increment_proposal_count(&mut self) -> Result<u64> {
        let next = self
            .proposal_count
            .checked_add(1)
            .ok_or(StendarError::ArithmeticOverflow)?;
        self.proposal_count = next;
        Ok(next)
    }

    pub fn add_prepayment_fee(&mut self, amount: u64) -> Result<()> {
        self.total_prepayment_fees = self
            .total_prepayment_fees
            .checked_add(amount)
            .ok_or(StendarError::ArithmeticOverflow)?;
        Ok(())
    }

    /// Calculate the next interest payment due date based on frequency
    pub fn calculate_next_interest_payment(&self) -> i64 {
        if self.last_interest_update == 0 {
            self.created_at + self.interest_frequency.to_seconds()
        } else {
            self.last_interest_update + self.interest_frequency.to_seconds()
        }
    }

    /// Calculate the next principal payment due date based on frequency
    pub fn calculate_next_principal_payment(&self) -> i64 {
        if let Some(principal_freq) = self.principal_frequency {
            if self.last_principal_payment == 0 {
                self.created_at + principal_freq.to_seconds()
            } else {
                self.last_principal_payment + principal_freq.to_seconds()
            }
        } else {
            0
        }
    }

    /// Determine the appropriate status based on funding amount
    pub fn determine_status_by_funding(&self) -> ContractStatus {
        if self.funded_amount == 0 {
            ContractStatus::OpenNotFunded
        } else if self.funded_amount < self.target_amount {
            ContractStatus::OpenPartiallyFunded
        } else {
            ContractStatus::Active
        }
    }

    /// Check if interest payment is due
    pub fn is_interest_payment_due(&self, current_time: i64) -> bool {
        self.status.is_active() && current_time >= self.next_interest_payment_due
    }

    /// Check if principal payment is due
    pub fn is_principal_payment_due(&self, current_time: i64) -> bool {
        self.status.is_active()
            && self.principal_frequency.is_some()
            && current_time >= self.next_principal_payment_due
    }

    /// Update bot tracking fields after an operation
    pub fn update_bot_tracking(&mut self, current_time: i64) {
        self.last_bot_update = current_time;
        self.bot_operation_count = self.bot_operation_count.saturating_add(1);
        self.next_interest_payment_due = self.calculate_next_interest_payment();
        self.next_principal_payment_due = self.calculate_next_principal_payment();
    }
}

/// Lender contribution tracking account
#[account]
pub struct LenderContribution {
    pub lender: Pubkey,
    pub contract: Pubkey,
    pub contribution_amount: u64,
    pub total_interest_claimed: u64,
    pub total_principal_claimed: u64,
    pub last_claim_timestamp: i64,
    pub is_refunded: bool,
    pub created_at: i64,
    pub last_contributed_at: i64,
    pub _reserved: [u8; LENDER_CONTRIBUTION_RESERVED_BYTES],
    pub account_version: u16,
}

impl LenderContribution {
    pub const LEN: usize =
        8 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 8 + 8 + LENDER_CONTRIBUTION_RESERVED_BYTES + 2;
}

/// Lender escrow account for payment distribution
#[account]
pub struct LenderEscrow {
    pub lender: Pubkey,
    pub contract: Pubkey,
    pub escrow_amount: u64,
    pub available_interest: u64,
    pub available_principal: u64,
    pub total_claimed: u64,
    pub is_released: bool,
    pub created_at: i64,
    pub escrow_token_account: Pubkey, // USDC ATA for this escrow
    pub _reserved: [u8; LENDER_ESCROW_RESERVED_BYTES],
    pub account_version: u16,
}

impl LenderEscrow {
    // NOTE: Keep this in sync with the deployed on-chain account layout / IDL.
    // The production `LenderEscrow` account does not include a `processing` flag.
    pub const LEN: usize =
        8 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 8 + 32 + LENDER_ESCROW_RESERVED_BYTES + 2;
}

/// Borrower-authorized lender for a specific contract.
#[account]
pub struct ApprovedFunder {
    pub contract: Pubkey,
    pub lender: Pubkey,
    pub approved_by: Pubkey,
    pub created_at: i64,
    pub _reserved: [u8; APPROVED_FUNDER_RESERVED_BYTES],
    pub account_version: u16,
}

impl ApprovedFunder {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + APPROVED_FUNDER_RESERVED_BYTES + 2;
}

pub const FRONTEND_OPERATOR_RESERVED_BYTES: usize = 32;

/// Registered frontend operator that can receive protocol fee sharing.
#[account]
pub struct FrontendOperator {
    pub operator: Pubkey,
    pub registered_at: i64,
    pub _reserved: [u8; FRONTEND_OPERATOR_RESERVED_BYTES],
    pub account_version: u16,
}

impl FrontendOperator {
    pub const LEN: usize = 8 + 32 + 8 + FRONTEND_OPERATOR_RESERVED_BYTES + 2;
}

/// Treasury account for automated operations and fee collection
#[account]
pub struct Treasury {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub bot_authority: Pubkey,
    pub fees_collected: u64,
    pub transaction_costs: u64,
    pub automated_operations: u64,
    pub total_contracts_processed: u64,
    pub last_update: i64,
    pub created_at: i64,
    pub usdc_mint: Pubkey,
    pub treasury_usdc_account: Pubkey,
    pub total_liquidation_fees: u64,
    pub total_recall_fees: u64,
    pub account_version: u16,
}

impl Treasury {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 32 + 32 + 8 + 8 + 2;

    pub fn is_authority(&self, signer: Pubkey) -> bool {
        self.authority == signer
    }

    pub fn propose_authority_transfer(
        &mut self,
        signer: Pubkey,
        new_authority: Pubkey,
        current_time: i64,
    ) -> Result<()> {
        require!(
            self.is_authority(signer),
            StendarError::UnauthorizedAuthorityUpdate
        );
        require!(
            new_authority != Pubkey::default(),
            StendarError::InvalidAuthority
        );
        require!(
            new_authority != self.authority,
            StendarError::InvalidAuthority
        );

        self.pending_authority = new_authority;
        self.last_update = current_time;
        Ok(())
    }

    pub fn accept_authority_transfer(&mut self, signer: Pubkey, current_time: i64) -> Result<()> {
        require!(
            self.pending_authority != Pubkey::default(),
            StendarError::InvalidAuthority
        );
        require!(
            signer == self.pending_authority,
            StendarError::UnauthorizedAuthorityUpdate
        );

        self.authority = signer;
        self.pending_authority = Pubkey::default();
        self.last_update = current_time;
        Ok(())
    }

    pub fn set_bot_authority(
        &mut self,
        signer: Pubkey,
        new_bot_authority: Pubkey,
        current_time: i64,
    ) -> Result<()> {
        require!(
            self.is_authority(signer),
            StendarError::UnauthorizedAuthorityUpdate
        );
        require!(
            new_bot_authority != Pubkey::default(),
            StendarError::InvalidAuthority
        );

        self.bot_authority = new_bot_authority;
        self.last_update = current_time;
        Ok(())
    }
}

/// Per-contract operations fund account.
///
/// Borrowers fund this PDA at contract creation to cover the off-chain bot's
/// expected transaction fees for automated interest/principal transfers.
#[account]
pub struct ContractOperationsFund {
    pub contract: Pubkey,          // Associated contract
    pub borrower: Pubkey,          // Who funded it (for refunds)
    pub total_funded: u64,         // Total lamports deposited
    pub total_reimbursed: u64,     // Total lamports paid to bot
    pub estimated_operations: u32, // Total expected operations
    pub completed_operations: u32, // Operations completed so far
    pub max_lenders: u16,          // Max lender count used for calculation
    pub is_active: bool,           // False after refund/close
    pub created_at: i64,
    pub account_version: u16,
}

impl ContractOperationsFund {
    pub const LEN: usize = 8  // discriminator
        + 32 // contract
        + 32 // borrower
        + 8  // total_funded
        + 8  // total_reimbursed
        + 4  // estimated_operations
        + 4  // completed_operations
        + 2  // max_lenders
        + 1  // is_active
        + 8  // created_at
        + 2; // account_version
}

/// Platform statistics return type
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct PlatformStats {
    pub total_contracts: u64,
    pub total_debt: u64,
    pub total_collateral: u64,
    pub total_interest_paid: u64,
    pub total_liquidations: u64,
    pub total_partial_liquidations: u64,
    pub platform_fee_basis_points: u16,
    pub pool_deposit_fee_bps: u16,
    pub pool_yield_fee_bps: u16,
    pub primary_listing_fee_bps: u16,
    pub secondary_listing_fee_bps: u16,
    pub secondary_buyer_fee_bps: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn max_contributions() -> Vec<Pubkey> {
        (0..usize::from(DebtContract::LEGACY_CONTRIBUTION_SLOTS))
            .map(|_| Pubkey::new_unique())
            .collect()
    }

    fn sample_standard_contract() -> DebtContract {
        DebtContract {
            borrower: Pubkey::new_unique(),
            contract_seed: 99,
            target_amount: 1_000_000,
            funded_amount: 900_000,
            interest_rate: 750,
            term_days: 180,
            collateral_amount: 2_000_000,
            loan_type: LoanType::Committed,
            ltv_ratio: 12_000,
            interest_payment_type: InterestPaymentType::OutstandingBalance,
            principal_payment_type: PrincipalPaymentType::CollateralDeduction,
            interest_frequency: PaymentFrequency::Monthly,
            principal_frequency: Some(PaymentFrequency::Monthly),
            created_at: 1_700_000_000,
            status: ContractStatus::Active,
            num_contributions: 14,
            outstanding_balance: 900_000,
            accrued_interest: 10_000,
            last_interest_update: 1_700_000_100,
            last_principal_payment: 1_700_000_200,
            total_principal_paid: 100_000,
            contributions: max_contributions(),
            last_bot_update: 1_700_000_300,
            next_interest_payment_due: 1_700_086_400,
            next_principal_payment_due: 1_700_086_400,
            bot_operation_count: 5,
            max_lenders: 14,
            partial_funding_flag: 1,
            expires_at: 1_700_604_800,
            allow_partial_fill: true,
            min_partial_fill_bps: 5_000,
            listing_fee_paid: 1_000_000,
            funding_access_mode: FundingAccessMode::Public,
            has_active_proposal: false,
            proposal_count: 0,
            uncollectable_balance: 0,
            total_prepayment_fees: 0,
            account_version: CURRENT_ACCOUNT_VERSION,
            contract_version: 2,
            collateral_mint: Pubkey::new_unique(),
            collateral_token_account: Pubkey::new_unique(),
            collateral_value_at_creation: 2_100_000,
            ltv_floor_bps: 11_000,
            loan_mint: Pubkey::new_unique(),
            loan_token_account: Pubkey::new_unique(),
            recall_requested: false,
            recall_requested_at: 0,
            recall_requested_by: Pubkey::default(),
            is_revolving: false,
            credit_limit: 0,
            drawn_amount: 0,
            available_amount: 0,
            standby_fee_rate: 0,
            accrued_standby_fees: 0,
            last_standby_fee_update: 0,
            total_draws: 0,
            total_standby_fees_paid: 0,
            revolving_closed: false,
            _reserved: [0u8; RESERVED_TAIL_BYTES],
        }
    }

    #[test]
    fn collateral_registry_len_matches_design() {
        assert_eq!(CollateralRegistry::LEN, 1445);
    }

    #[test]
    fn collateral_registry_serialization_roundtrip() {
        let mint_a = Pubkey::new_unique();
        let mint_b = Pubkey::new_unique();
        let registry = CollateralRegistry {
            authority: Pubkey::new_unique(),
            num_collateral_types: 2,
            collateral_types: vec![
                CollateralType {
                    mint: mint_a,
                    oracle_price_feed: Pubkey::new_unique(),
                    decimals: 8,
                    liquidation_buffer_bps: 500,
                    min_committed_floor_bps: 5_000,
                    is_active: true,
                },
                CollateralType {
                    mint: mint_b,
                    oracle_price_feed: Pubkey::new_unique(),
                    decimals: 9,
                    liquidation_buffer_bps: 700,
                    min_committed_floor_bps: 5_500,
                    is_active: false,
                },
            ],
        };

        let bytes = registry
            .try_to_vec()
            .expect("serialize collateral registry");
        let decoded =
            CollateralRegistry::try_from_slice(&bytes).expect("deserialize collateral registry");

        assert_eq!(decoded.authority, registry.authority);
        assert_eq!(decoded.num_collateral_types, 2);
        assert_eq!(decoded.collateral_types.len(), 2);
        assert_eq!(decoded.collateral_types[0].mint, mint_a);
        assert_eq!(decoded.collateral_types[1].mint, mint_b);
        assert_eq!(decoded.collateral_types[0].liquidation_buffer_bps, 500);
        assert!(!decoded.collateral_types[1].is_active);
    }

    #[test]
    fn find_collateral_type_returns_expected_entry() {
        let mint_a = Pubkey::new_unique();
        let mint_b = Pubkey::new_unique();
        let registry = CollateralRegistry {
            authority: Pubkey::new_unique(),
            num_collateral_types: 2,
            collateral_types: vec![
                CollateralType {
                    mint: mint_a,
                    oracle_price_feed: Pubkey::new_unique(),
                    decimals: 8,
                    liquidation_buffer_bps: 500,
                    min_committed_floor_bps: 5_000,
                    is_active: true,
                },
                CollateralType {
                    mint: mint_b,
                    oracle_price_feed: Pubkey::new_unique(),
                    decimals: 9,
                    liquidation_buffer_bps: 700,
                    min_committed_floor_bps: 5_500,
                    is_active: true,
                },
            ],
        };

        let first = registry
            .find_collateral_type(&mint_a)
            .expect("mint A exists");
        assert_eq!(first.decimals, 8);

        let second = registry
            .find_collateral_type(&mint_b)
            .expect("mint B exists");
        assert_eq!(second.min_committed_floor_bps, 5_500);

        assert!(registry
            .find_collateral_type(&Pubkey::new_unique())
            .is_none());
    }

    #[test]
    fn debt_contract_len_matches_layout() {
        assert_eq!(
            DebtContract::space(1),
            DebtContract::BASE_LEN + DebtContract::CONTRIBUTION_KEY_BYTES
        );
        assert_eq!(
            DebtContract::space(14),
            DebtContract::BASE_LEN + (DebtContract::CONTRIBUTION_KEY_BYTES * 14)
        );
        assert_eq!(
            DebtContract::space(100),
            DebtContract::BASE_LEN + (DebtContract::CONTRIBUTION_KEY_BYTES * 100)
        );
        assert_eq!(
            DebtContract::LEN,
            DebtContract::space(DebtContract::LEGACY_CONTRIBUTION_SLOTS)
        );

        let contract = sample_standard_contract();
        let serialized = contract.try_to_vec().expect("serialize contract");
        assert_eq!(
            serialized.len() + 8,
            DebtContract::space(contract.max_lenders)
        );
    }

    #[test]
    fn lender_contribution_len_after_field_consolidation() {
        // 8 discriminator + 32 lender + 32 contract + 8 contribution_amount +
        // 8 total_interest_claimed + 8 total_principal_claimed + 8 last_claim_timestamp +
        // 1 is_refunded + 8 created_at + 8 last_contributed_at + 24 _reserved + 2 account_version
        let expected: usize =
            8 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 8 + 8 + LENDER_CONTRIBUTION_RESERVED_BYTES + 2;
        assert_eq!(LenderContribution::LEN, expected);

        let sample = LenderContribution {
            lender: Pubkey::default(),
            contract: Pubkey::default(),
            contribution_amount: 100,
            total_interest_claimed: 0,
            total_principal_claimed: 0,
            last_claim_timestamp: 0,
            is_refunded: false,
            created_at: 12345,
            last_contributed_at: 12345,
            _reserved: [0u8; LENDER_CONTRIBUTION_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        };
        let serialized = sample.try_to_vec().expect("serialize LenderContribution");
        assert_eq!(serialized.len() + 8, LenderContribution::LEN);
    }

    #[test]
    fn state_len_includes_fee_fields_and_is_paused_flag() {
        let expected: usize = 8 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 2 + 2 + 2 + 2 + 2 + 2 + 1 + 2;
        assert_eq!(State::LEN, expected);
    }

    #[test]
    fn collateral_registry_uses_self_documenting_size() {
        assert_eq!(CollateralRegistry::COLLATERAL_TYPE_SIZE, 70);
        assert_eq!(CollateralRegistry::LEN, 8 + 32 + 1 + 4 + (20 * 70));
    }

    #[test]
    fn debt_contract_fields_track_proposal_state() {
        let mut contract = sample_standard_contract();
        assert!(!contract.has_active_proposal);
        assert_eq!(contract.proposal_count, 0);

        contract.has_active_proposal = true;
        contract.proposal_count = 41;

        assert!(contract.has_active_proposal);
        assert_eq!(contract.proposal_count, 41);

        let next = contract
            .increment_proposal_count()
            .expect("increment proposal count");
        assert_eq!(next, 42);
        assert_eq!(contract.proposal_count, 42);

        contract.has_active_proposal = false;
        assert!(!contract.has_active_proposal);
    }

    #[test]
    fn debt_contract_fields_track_uncollectable_balance() {
        let mut contract = sample_standard_contract();
        assert_eq!(contract.uncollectable_balance, 0);

        contract.uncollectable_balance = 123_456;
        assert_eq!(contract.uncollectable_balance, 123_456);

        contract.has_active_proposal = true;
        contract.proposal_count = 7;
        assert!(contract.has_active_proposal);
        assert_eq!(contract.proposal_count, 7);
        assert_eq!(contract.uncollectable_balance, 123_456);
    }

    #[test]
    fn debt_contract_fields_track_total_prepayment_fees() {
        let mut contract = sample_standard_contract();
        assert_eq!(contract.total_prepayment_fees, 0);

        contract
            .add_prepayment_fee(500)
            .expect("first prepayment fee increment");
        contract
            .add_prepayment_fee(250)
            .expect("second prepayment fee increment");
        assert_eq!(contract.total_prepayment_fees, 750);

        contract.has_active_proposal = true;
        contract.proposal_count = 2;
        contract.uncollectable_balance = 99;
        assert!(contract.has_active_proposal);
        assert_eq!(contract.proposal_count, 2);
        assert_eq!(contract.uncollectable_balance, 99);
        assert_eq!(contract.total_prepayment_fees, 750);
    }

    #[test]
    fn frontend_operator_len_matches_design() {
        assert_eq!(FrontendOperator::LEN, 82);

        let sample = FrontendOperator {
            operator: Pubkey::new_unique(),
            registered_at: 1_700_000_000,
            _reserved: [0u8; FRONTEND_OPERATOR_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        };
        let serialized = sample.try_to_vec().expect("serialize FrontendOperator");
        assert_eq!(serialized.len() + 8, FrontendOperator::LEN);
    }

    #[test]
    fn debt_contract_frontend_accessor_roundtrip() {
        let mut contract = sample_standard_contract();
        let frontend = Pubkey::new_unique();

        contract.set_frontend(frontend);

        assert_eq!(contract.frontend(), frontend);
    }

    #[test]
    fn debt_contract_frontend_default_is_system_program() {
        let contract = sample_standard_contract();

        assert_eq!(contract.frontend(), Pubkey::default());
    }

    #[test]
    fn frontend_fee_share_bps_above_floor() {
        assert!(FRONTEND_FEE_SHARE_BPS >= MIN_FRONTEND_FEE_SHARE_BPS);
    }
}

#[event]
pub struct ContractCreated {
    pub contract: Pubkey,
    pub borrower: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ContractFunded {
    pub contract: Pubkey,
    pub lender: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ContractMigrated {
    pub contract: Pubkey,
    pub from_version: u16,
    pub to_version: u16,
    pub old_len: u32,
    pub new_len: u32,
}

#[event]
pub struct PaymentMade {
    pub contract: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ContractLiquidated {
    pub contract: Pubkey,
}

#[event]
pub struct AuthorityUpdated {
    pub old: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct ContributionWithdrawn {
    pub contract: Pubkey,
    pub lender: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PoolChangeProposed {
    pub pool: Pubkey,
    pub operator: Pubkey,
    pub effective_at: i64,
    pub rate_bps: Option<u32>,
    pub capacity: Option<u64>,
    pub minimum_deposit: Option<u64>,
    pub allowed_loan_type: Option<u8>,
    pub min_ltv_bps: Option<u16>,
    pub max_term_days: Option<u32>,
    pub withdrawal_queue_enabled: Option<bool>,
}

#[event]
pub struct PoolChangeApplied {
    pub pool: Pubkey,
    pub operator: Pubkey,
}

#[event]
pub struct PoolChangeCancelled {
    pub pool: Pubkey,
    pub operator: Pubkey,
}

#[event]
pub struct PoolExpired {
    pub pool: Pubkey,
    pub operator: Pubkey,
    pub idle_since: i64,
}

#[event]
pub struct PlatformPauseToggled {
    pub is_paused: bool,
}

#[event]
pub struct FeeRatesUpdated {
    pub authority: Pubkey,
    pub old_pool_deposit_fee_bps: u16,
    pub new_pool_deposit_fee_bps: u16,
    pub old_pool_yield_fee_bps: u16,
    pub new_pool_yield_fee_bps: u16,
    pub old_primary_listing_fee_bps: u16,
    pub new_primary_listing_fee_bps: u16,
    pub old_secondary_listing_fee_bps: u16,
    pub new_secondary_listing_fee_bps: u16,
    pub old_secondary_buyer_fee_bps: u16,
    pub new_secondary_buyer_fee_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct TreasuryWithdrawal {
    pub authority: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub is_token_withdrawal: bool,
    pub timestamp: i64,
}

#[event]
pub struct FrontendRegistered {
    pub operator: Pubkey,
    pub frontend_operator_pda: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct FrontendFeeSplit {
    pub frontend: Pubkey,
    pub fee_type: u8, // 0=listing, 1=deposit, 2=yield, 3=secondary, 4=recall
    pub total_fee: u64,
    pub frontend_share: u64,
    pub treasury_share: u64,
}
