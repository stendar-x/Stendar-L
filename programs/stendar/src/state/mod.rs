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
pub const DEBT_CONTRACT_RESERVED_BYTES: usize = 44;
pub const LENDER_CONTRIBUTION_RESERVED_BYTES: usize = 24;
pub const LENDER_ESCROW_RESERVED_BYTES: usize = 32;
pub const APPROVED_FUNDER_RESERVED_BYTES: usize = 32;
pub const COLLATERAL_REGISTRY_SEED: &[u8] = b"collateral_registry";
pub const MOCK_ORACLE_PRICE_FEED_SEED: &[u8] = b"mock_oracle_price_feed";
pub const TEST_CLOCK_OFFSET_SEED: &[u8] = b"test_clock_offset";
pub const POOL_CHANGE_TIMELOCK_SECONDS: i64 = 259_200; // 72 hours
pub const POOL_IDLE_EXPIRY_SECONDS: i64 = 2_592_000; // 30 days
pub const DEMAND_LOAN_MIN_FLOOR_BPS: u16 = 10_500; // 105% minimum floor for demand loans
pub const LIQUIDATION_FEE_BPS: u16 = 300; // 3% liquidation fee
pub const RECALL_FEE_BPS: u16 = 200; // 2% demand recall fee
pub const RECALL_GRACE_PERIOD_SECONDS: i64 = 259_200; // 72 hours
pub const PARTIAL_LIQUIDATION_CAP_BPS: u16 = 5_000; // 50% max per partial liquidation

#[derive(Clone, Copy, Debug, Default)]
struct DebtContractReservedFields {
    funding_access_mode: u8,
    has_active_proposal: bool,
    proposal_count: u64,
    uncollectable_balance: u64,
}

impl DebtContractReservedFields {
    const FUNDING_ACCESS_MODE_INDEX: usize = 0;
    const HAS_ACTIVE_PROPOSAL_INDEX: usize = 1;
    const PROPOSAL_COUNT_START: usize = 2;
    const PROPOSAL_COUNT_END: usize = Self::PROPOSAL_COUNT_START + 8;
    const UNCOLLECTABLE_BALANCE_START: usize = 10;
    const UNCOLLECTABLE_BALANCE_END: usize = Self::UNCOLLECTABLE_BALANCE_START + 8;

    fn from_bytes(bytes: &[u8; DEBT_CONTRACT_RESERVED_BYTES]) -> Self {
        let mut proposal_count_bytes = [0u8; 8];
        proposal_count_bytes
            .copy_from_slice(&bytes[Self::PROPOSAL_COUNT_START..Self::PROPOSAL_COUNT_END]);

        let mut uncollectable_balance_bytes = [0u8; 8];
        uncollectable_balance_bytes.copy_from_slice(
            &bytes[Self::UNCOLLECTABLE_BALANCE_START..Self::UNCOLLECTABLE_BALANCE_END],
        );

        Self {
            funding_access_mode: bytes[Self::FUNDING_ACCESS_MODE_INDEX],
            has_active_proposal: bytes[Self::HAS_ACTIVE_PROPOSAL_INDEX] == 1,
            proposal_count: u64::from_le_bytes(proposal_count_bytes),
            uncollectable_balance: u64::from_le_bytes(uncollectable_balance_bytes),
        }
    }

    fn write_into(self, bytes: &mut [u8; DEBT_CONTRACT_RESERVED_BYTES]) {
        bytes[Self::FUNDING_ACCESS_MODE_INDEX] = self.funding_access_mode;
        bytes[Self::HAS_ACTIVE_PROPOSAL_INDEX] = if self.has_active_proposal { 1 } else { 0 };
        bytes[Self::PROPOSAL_COUNT_START..Self::PROPOSAL_COUNT_END]
            .copy_from_slice(&self.proposal_count.to_le_bytes());
        bytes[Self::UNCOLLECTABLE_BALANCE_START..Self::UNCOLLECTABLE_BALANCE_END]
            .copy_from_slice(&self.uncollectable_balance.to_le_bytes());
    }
}

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
    pub ltv_ratio: u64,
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
    /// Reserved space for additive schema changes without realloc.
    pub _reserved: [u8; DEBT_CONTRACT_RESERVED_BYTES],
    /// Version for account layout compatibility.
    pub account_version: u16,
    // --- Appended fields kept for layout compatibility ---
    pub contract_version: u8,              // 2 for standard contracts
    pub collateral_mint: Pubkey,           // SPL token mint used as collateral
    pub collateral_token_account: Pubkey,  // ATA holding collateral for this contract
    pub collateral_value_at_creation: u64, // USDC value of collateral at creation
    pub ltv_floor_bps: u16,                // Borrower-set minimum LTV in basis points
    pub loan_mint: Pubkey,                 // USDC mint for contracts
    pub loan_token_account: Pubkey,        // Contract's USDC ATA
    pub recall_requested: bool,            // Whether a demand recall is pending
    pub recall_requested_at: i64,          // Recall request timestamp (0 if none)
    pub recall_requested_by: Pubkey,       // Lender who requested recall
}

impl DebtContract {
    // NOTE: Keep this in sync with the deployed on-chain account layout / IDL.
    // The production `DebtContract` account does not include a `processing` flag.
    pub const BASE_LAYOUT_LEN: usize = 8
        + 32
        + 8
        + 8
        + 8
        + 4
        + 4
        + 8
        + 1
        + 8
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
        + (32 * 14)
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
        + DEBT_CONTRACT_RESERVED_BYTES
        + 2;
    pub const ADDITIONAL_LAYOUT_LEN: usize = 1 + 32 + 32 + 8 + 2 + 32 + 32 + 1 + 8 + 32;
    pub const LEN: usize = Self::BASE_LAYOUT_LEN + Self::ADDITIONAL_LAYOUT_LEN;

    fn reserved_fields(&self) -> DebtContractReservedFields {
        DebtContractReservedFields::from_bytes(&self._reserved)
    }

    fn write_reserved_fields(&mut self, fields: DebtContractReservedFields) {
        fields.write_into(&mut self._reserved);
    }

    pub fn funding_access_mode(&self) -> FundingAccessMode {
        FundingAccessMode::from_reserved_byte(self.reserved_fields().funding_access_mode)
    }

    pub fn set_funding_access_mode(&mut self, mode: FundingAccessMode) {
        let mut fields = self.reserved_fields();
        fields.funding_access_mode = mode.to_reserved_byte();
        self.write_reserved_fields(fields);
    }

    pub fn has_active_proposal(&self) -> bool {
        self.reserved_fields().has_active_proposal
    }

    pub fn set_has_active_proposal(&mut self, active: bool) {
        let mut fields = self.reserved_fields();
        fields.has_active_proposal = active;
        self.write_reserved_fields(fields);
    }

    pub fn proposal_count(&self) -> u64 {
        self.reserved_fields().proposal_count
    }

    pub fn set_proposal_count(&mut self, count: u64) {
        let mut fields = self.reserved_fields();
        fields.proposal_count = count;
        self.write_reserved_fields(fields);
    }

    pub fn increment_proposal_count(&mut self) -> Result<u64> {
        let current = self.proposal_count();
        let next = current
            .checked_add(1)
            .ok_or(StendarError::ArithmeticOverflow)?;
        self.set_proposal_count(next);
        Ok(next)
    }

    pub fn uncollectable_balance(&self) -> u64 {
        self.reserved_fields().uncollectable_balance
    }

    pub fn set_uncollectable_balance(&mut self, amount: u64) {
        let mut fields = self.reserved_fields();
        fields.uncollectable_balance = amount;
        self.write_reserved_fields(fields);
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

    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
    struct DebtContractBaseLayout {
        pub borrower: Pubkey,
        pub contract_seed: u64,
        pub target_amount: u64,
        pub funded_amount: u64,
        pub interest_rate: u32,
        pub term_days: u32,
        pub collateral_amount: u64,
        pub loan_type: LoanType,
        pub ltv_ratio: u64,
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
        pub last_bot_update: i64,
        pub next_interest_payment_due: i64,
        pub next_principal_payment_due: i64,
        pub bot_operation_count: u64,
        pub max_lenders: u16,
        pub partial_funding_flag: u8,
        pub expires_at: i64,
        pub allow_partial_fill: bool,
        pub min_partial_fill_bps: u16,
        pub listing_fee_paid: u64,
        pub _reserved: [u8; DEBT_CONTRACT_RESERVED_BYTES],
        pub account_version: u16,
    }

    fn max_contributions() -> Vec<Pubkey> {
        (0..14).map(|_| Pubkey::new_unique()).collect()
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
            _reserved: [0u8; DEBT_CONTRACT_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
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
    fn debt_contract_len_matches_base_plus_appended_fields() {
        assert_eq!(DebtContract::BASE_LAYOUT_LEN, 699);
        assert_eq!(DebtContract::ADDITIONAL_LAYOUT_LEN, 180);
        assert_eq!(DebtContract::LEN, 879);

        let contract = sample_standard_contract();
        let serialized = contract.try_to_vec().expect("serialize contract");
        assert_eq!(serialized.len() + 8, DebtContract::LEN);
    }

    #[test]
    fn base_layout_bytes_are_unchanged_with_appended_fields() {
        let contract = sample_standard_contract();
        let base_layout = DebtContractBaseLayout {
            borrower: contract.borrower,
            contract_seed: contract.contract_seed,
            target_amount: contract.target_amount,
            funded_amount: contract.funded_amount,
            interest_rate: contract.interest_rate,
            term_days: contract.term_days,
            collateral_amount: contract.collateral_amount,
            loan_type: contract.loan_type,
            ltv_ratio: contract.ltv_ratio,
            interest_payment_type: contract.interest_payment_type,
            principal_payment_type: contract.principal_payment_type,
            interest_frequency: contract.interest_frequency,
            principal_frequency: contract.principal_frequency,
            created_at: contract.created_at,
            status: contract.status,
            num_contributions: contract.num_contributions,
            outstanding_balance: contract.outstanding_balance,
            accrued_interest: contract.accrued_interest,
            last_interest_update: contract.last_interest_update,
            last_principal_payment: contract.last_principal_payment,
            total_principal_paid: contract.total_principal_paid,
            contributions: contract.contributions.clone(),
            last_bot_update: contract.last_bot_update,
            next_interest_payment_due: contract.next_interest_payment_due,
            next_principal_payment_due: contract.next_principal_payment_due,
            bot_operation_count: contract.bot_operation_count,
            max_lenders: contract.max_lenders,
            partial_funding_flag: contract.partial_funding_flag,
            expires_at: contract.expires_at,
            allow_partial_fill: contract.allow_partial_fill,
            min_partial_fill_bps: contract.min_partial_fill_bps,
            listing_fee_paid: contract.listing_fee_paid,
            _reserved: contract._reserved,
            account_version: contract.account_version,
        };

        let base_layout_bytes = base_layout.try_to_vec().expect("serialize base layout");
        let full_bytes = contract.try_to_vec().expect("serialize full layout");

        assert_eq!(base_layout_bytes.len() + 8, DebtContract::BASE_LAYOUT_LEN);
        assert_eq!(
            &full_bytes[..base_layout_bytes.len()],
            &base_layout_bytes[..]
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
    fn debt_contract_reserved_bytes_track_proposal_state() {
        let mut contract = sample_standard_contract();
        assert!(!contract.has_active_proposal());
        assert_eq!(contract.proposal_count(), 0);

        contract.set_has_active_proposal(true);
        contract.set_proposal_count(41);

        assert!(contract.has_active_proposal());
        assert_eq!(contract.proposal_count(), 41);

        let next = contract
            .increment_proposal_count()
            .expect("increment proposal count");
        assert_eq!(next, 42);
        assert_eq!(contract.proposal_count(), 42);

        contract.set_has_active_proposal(false);
        assert!(!contract.has_active_proposal());
    }

    #[test]
    fn debt_contract_reserved_bytes_track_uncollectable_balance() {
        let mut contract = sample_standard_contract();
        assert_eq!(contract.uncollectable_balance(), 0);

        contract.set_uncollectable_balance(123_456);
        assert_eq!(contract.uncollectable_balance(), 123_456);

        // Proposal metadata shares the reserved block and must remain intact.
        contract.set_has_active_proposal(true);
        contract.set_proposal_count(7);
        assert!(contract.has_active_proposal());
        assert_eq!(contract.proposal_count(), 7);
        assert_eq!(contract.uncollectable_balance(), 123_456);
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
