use anchor_lang::prelude::*;

use super::{PoolStatus, ACCOUNT_RESERVED_BYTES, CURRENT_ACCOUNT_VERSION};

pub const RATE_HISTORY_SIZE: usize = 7;
pub const RATE_HISTORY_CONTROL_BYTES: usize = 2;
pub const RATE_HISTORY_PADDING_BYTES: usize = 10;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct RateHistoryEntry {
    pub changed_at: i64,
    pub rate_bps: u32,
}

impl RateHistoryEntry {
    pub const LEN: usize = 8 + 4;
}

const _: [u8; ACCOUNT_RESERVED_BYTES] = [0u8; RATE_HISTORY_CONTROL_BYTES
    + (RateHistoryEntry::LEN * RATE_HISTORY_SIZE)
    + RATE_HISTORY_PADDING_BYTES];

/// Global allowlist entry for pool operators.
///
/// v1 governance is single-authority (`State.authority`) controlled.
/// Future versions can migrate authorization policy by only changing who
/// can create/close this PDA.
#[account]
pub struct AuthorizedPoolOperator {
    pub operator: Pubkey,
    pub authorized_by: Pubkey,
    pub authorized_at: i64,
    pub operator_name: [u8; 32],
    pub _reserved: [u8; ACCOUNT_RESERVED_BYTES],
    pub account_version: u16,
}

impl AuthorizedPoolOperator {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 32 + ACCOUNT_RESERVED_BYTES + 2;

    pub fn initialize(&mut self, operator: Pubkey, authorized_by: Pubkey, authorized_at: i64) {
        self.operator = operator;
        self.authorized_by = authorized_by;
        self.authorized_at = authorized_at;
        self.operator_name = [0u8; 32];
        self._reserved = [0u8; ACCOUNT_RESERVED_BYTES];
        self.account_version = CURRENT_ACCOUNT_VERSION;
    }
}

/// Per-operator perpetual lending pool.
#[account]
pub struct PoolState {
    pub operator: Pubkey,
    pub pool_seed: u64,
    pub name: [u8; 32],
    pub rate_bps: u32,
    pub capacity: u64,
    pub current_total_deposits: u64,
    pub current_utilized: u64,
    pub total_yield_distributed: u64,
    pub status: PoolStatus,
    pub created_at: i64,
    pub authorized: bool,
    pub withdrawal_queue_enabled: bool,
    pub minimum_deposit: u64,
    pub num_depositors: u32,
    pub loan_mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub bump: u8,
    /// 0 = both, 1 = demand-only, 2 = committed-only.
    pub allowed_loan_type: u8,
    /// Minimum contract LTV floor required for deployments (0 = no minimum).
    pub min_ltv_bps: u16,
    /// Maximum contract term in days allowed for deployments (0 = no maximum).
    pub max_term_days: u32,
    /// Most recent pool-rate update timestamp (0 when never updated post-create).
    pub rate_updated_at: i64,
    /// Previous rate used for pre-update accrual windows.
    pub prev_rate_bps: u32,
    /// Unix timestamp when the pool became fully idle (0 when not idle).
    pub idle_since: i64,
    pub total_pending_yield: u64,
    pub pending_withdrawal_requests: u32,
    pub rate_history_len: u8,
    pub rate_history_head: u8,
    pub rate_history: [RateHistoryEntry; RATE_HISTORY_SIZE],
    pub _reserved: [u8; RATE_HISTORY_PADDING_BYTES],
    pub account_version: u16,
}

impl PoolState {
    pub const LEN: usize = 8
        + 32
        + 8
        + 32
        + 4
        + 8
        + 8
        + 8
        + 8
        + 1
        + 8
        + 1
        + 1
        + 8
        + 4
        + 32
        + 32
        + 1
        + 1
        + 2
        + 4
        + 8
        + 4
        + 8
        + 8
        + 4
        + RATE_HISTORY_CONTROL_BYTES
        + (RateHistoryEntry::LEN * RATE_HISTORY_SIZE)
        + RATE_HISTORY_PADDING_BYTES
        + 2;

    pub fn available_liquidity(&self) -> Result<u64> {
        self.current_total_deposits
            .checked_sub(self.current_utilized)
            .ok_or(crate::errors::StendarError::ArithmeticOverflow.into())
    }

    pub fn total_pending_yield(&self) -> u64 {
        self.total_pending_yield
    }

    pub fn set_total_pending_yield(&mut self, amount: u64) {
        self.total_pending_yield = amount;
    }

    pub fn add_pending_yield(&mut self, amount: u64) -> Result<()> {
        let updated = self
            .total_pending_yield()
            .checked_add(amount)
            .ok_or(crate::errors::StendarError::ArithmeticOverflow)?;
        self.set_total_pending_yield(updated);
        Ok(())
    }

    pub fn consume_pending_yield(&mut self, amount: u64) -> Result<()> {
        let updated = self
            .total_pending_yield()
            .checked_sub(amount)
            .ok_or(crate::errors::StendarError::ArithmeticOverflow)?;
        self.set_total_pending_yield(updated);
        Ok(())
    }

    pub fn pending_withdrawal_requests(&self) -> u32 {
        self.pending_withdrawal_requests
    }

    pub fn set_pending_withdrawal_requests(&mut self, count: u32) {
        self.pending_withdrawal_requests = count;
    }

    pub fn increment_pending_withdrawal_requests(&mut self) -> Result<()> {
        let updated = self
            .pending_withdrawal_requests()
            .checked_add(1)
            .ok_or(crate::errors::StendarError::ArithmeticOverflow)?;
        self.set_pending_withdrawal_requests(updated);
        Ok(())
    }

    pub fn decrement_pending_withdrawal_requests(&mut self) -> Result<()> {
        let updated = self
            .pending_withdrawal_requests()
            .checked_sub(1)
            .ok_or(crate::errors::StendarError::ArithmeticOverflow)?;
        self.set_pending_withdrawal_requests(updated);
        Ok(())
    }

    pub fn initialize_rate_history(&mut self) {
        self.rate_history_len = 0;
        self.rate_history_head = 0;
        self.rate_history = [RateHistoryEntry::default(); RATE_HISTORY_SIZE];
        self._reserved = [0u8; RATE_HISTORY_PADDING_BYTES];
    }

    pub fn push_rate_history(&mut self, entry: RateHistoryEntry) {
        let head = (self.rate_history_head as usize) % RATE_HISTORY_SIZE;
        self.rate_history[head] = entry;
        self.rate_history_head = ((head + 1) % RATE_HISTORY_SIZE) as u8;
        let len = (self.rate_history_len as usize).min(RATE_HISTORY_SIZE);
        if len < RATE_HISTORY_SIZE {
            self.rate_history_len = (len + 1) as u8;
        }
    }

    pub fn rate_history_entry_count(&self) -> usize {
        (self.rate_history_len as usize).min(RATE_HISTORY_SIZE)
    }

    pub fn rate_history_entry_at(&self, chronological_index: usize) -> Option<RateHistoryEntry> {
        let len = self.rate_history_entry_count();
        if chronological_index >= len {
            return None;
        }

        let head = (self.rate_history_head as usize) % RATE_HISTORY_SIZE;
        let oldest_slot = if len == RATE_HISTORY_SIZE { head } else { 0 };
        let slot = (oldest_slot + chronological_index) % RATE_HISTORY_SIZE;
        Some(self.rate_history[slot])
    }
}

/// Pending timelocked pool parameter change proposal.
#[account]
pub struct PendingPoolChange {
    pub pool: Pubkey,
    pub operator: Pubkey,
    pub proposed_at: i64,
    pub effective_at: i64,
    pub rate_bps: Option<u32>,
    pub capacity: Option<u64>,
    pub minimum_deposit: Option<u64>,
    pub allowed_loan_type: Option<u8>,
    pub min_ltv_bps: Option<u16>,
    pub max_term_days: Option<u32>,
    pub withdrawal_queue_enabled: Option<bool>,
    pub bump: u8,
    pub _reserved: [u8; ACCOUNT_RESERVED_BYTES],
    pub account_version: u16,
}

impl PendingPoolChange {
    pub const LEN: usize = 8
        + 32
        + 32
        + 8
        + 8
        + (1 + 4)
        + (1 + 8)
        + (1 + 8)
        + (1 + 1)
        + (1 + 2)
        + (1 + 4)
        + (1 + 1)
        + 1
        + ACCOUNT_RESERVED_BYTES
        + 2;
}

/// Per-depositor position in a pool.
#[account]
pub struct PoolDeposit {
    pub depositor: Pubkey,
    pub pool: Pubkey,
    pub deposit_amount: u64,
    pub accrued_yield: u64,
    pub last_yield_update: i64,
    pub deposit_timestamp: i64,
    pub withdrawal_requested: bool,
    pub withdrawal_requested_at: i64,
    pub withdrawal_requested_amount: u64,
    pub total_yield_claimed: u64,
    pub frontend: Pubkey,
    /// 0 = compound, 1 = claim.
    pub yield_preference: u8,
    /// Lifetime compounded yield amount for this deposit.
    pub total_yield_compounded: u64,
    pub _reserved: [u8; ACCOUNT_RESERVED_BYTES],
    pub account_version: u16,
}

impl PoolDeposit {
    pub const LEN: usize =
        8 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 8 + 8 + 8 + 32 + 1 + 8 + ACCOUNT_RESERVED_BYTES + 2;

    pub fn initialize(&mut self, depositor: Pubkey, pool: Pubkey, now: i64) {
        self.depositor = depositor;
        self.pool = pool;
        self.deposit_amount = 0;
        self.accrued_yield = 0;
        self.last_yield_update = now;
        self.deposit_timestamp = now;
        self.withdrawal_requested = false;
        self.withdrawal_requested_at = 0;
        self.withdrawal_requested_amount = 0;
        self.total_yield_claimed = 0;
        self.frontend = Pubkey::default();
        self.yield_preference = 0;
        self.total_yield_compounded = 0;
        self._reserved = [0u8; ACCOUNT_RESERVED_BYTES];
        self.account_version = CURRENT_ACCOUNT_VERSION;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_authorized_pool_operator() -> AuthorizedPoolOperator {
        let mut operator = AuthorizedPoolOperator {
            operator: Pubkey::new_unique(),
            authorized_by: Pubkey::new_unique(),
            authorized_at: 1_700_000_000,
            operator_name: [0u8; 32],
            _reserved: [0u8; ACCOUNT_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        };
        operator.initialize(operator.operator, operator.authorized_by, operator.authorized_at);
        operator
    }

    fn sample_pool_state() -> PoolState {
        let mut pool = PoolState {
            operator: Pubkey::new_unique(),
            pool_seed: 42,
            name: [0u8; 32],
            rate_bps: 750,
            capacity: 5_000_000_000,
            current_total_deposits: 2_000_000_000,
            current_utilized: 1_200_000_000,
            total_yield_distributed: 80_000_000,
            status: PoolStatus::Active,
            created_at: 1_700_000_000,
            authorized: true,
            withdrawal_queue_enabled: true,
            minimum_deposit: 1_000_000,
            num_depositors: 12,
            loan_mint: Pubkey::new_unique(),
            vault_token_account: Pubkey::new_unique(),
            bump: 254,
            allowed_loan_type: 0,
            min_ltv_bps: 10_000,
            max_term_days: 365,
            rate_updated_at: 1_700_000_500,
            prev_rate_bps: 700,
            idle_since: 0,
            total_pending_yield: 15_000_000,
            pending_withdrawal_requests: 2,
            rate_history_len: 0,
            rate_history_head: 0,
            rate_history: [RateHistoryEntry::default(); RATE_HISTORY_SIZE],
            _reserved: [0u8; RATE_HISTORY_PADDING_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        };
        pool.initialize_rate_history();
        pool.push_rate_history(RateHistoryEntry {
            changed_at: 1_700_000_100,
            rate_bps: 700,
        });
        pool.push_rate_history(RateHistoryEntry {
            changed_at: 1_700_000_500,
            rate_bps: 750,
        });
        pool
    }

    fn sample_pending_pool_change() -> PendingPoolChange {
        PendingPoolChange {
            pool: Pubkey::new_unique(),
            operator: Pubkey::new_unique(),
            proposed_at: 1_700_000_000,
            effective_at: 1_700_086_400,
            rate_bps: Some(800),
            capacity: Some(8_000_000_000),
            minimum_deposit: Some(2_000_000),
            allowed_loan_type: Some(1),
            min_ltv_bps: Some(10_500),
            max_term_days: Some(180),
            withdrawal_queue_enabled: Some(true),
            bump: 200,
            _reserved: [0u8; ACCOUNT_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        }
    }

    fn sample_pool_deposit() -> PoolDeposit {
        let mut deposit = PoolDeposit {
            depositor: Pubkey::new_unique(),
            pool: Pubkey::new_unique(),
            deposit_amount: 1_000_000,
            accrued_yield: 5_000,
            last_yield_update: 1_700_000_100,
            deposit_timestamp: 1_700_000_000,
            withdrawal_requested: false,
            withdrawal_requested_at: 0,
            withdrawal_requested_amount: 0,
            total_yield_claimed: 0,
            frontend: Pubkey::default(),
            yield_preference: 0,
            total_yield_compounded: 0,
            _reserved: [0u8; ACCOUNT_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        };
        deposit.initialize(deposit.depositor, deposit.pool, deposit.deposit_timestamp);
        deposit
    }

    #[test]
    fn authorized_pool_operator_len_matches_design() {
        let sample = sample_authorized_pool_operator();
        let serialized = sample
            .try_to_vec()
            .expect("serialize AuthorizedPoolOperator");
        assert_eq!(serialized.len() + 8, AuthorizedPoolOperator::LEN);
    }

    #[test]
    fn pool_state_len_matches_design() {
        let sample = sample_pool_state();
        let serialized = sample.try_to_vec().expect("serialize PoolState");
        assert_eq!(serialized.len() + 8, PoolState::LEN);
    }

    #[test]
    fn pending_pool_change_len_matches_design() {
        let sample = sample_pending_pool_change();
        let serialized = sample.try_to_vec().expect("serialize PendingPoolChange");
        assert_eq!(serialized.len() + 8, PendingPoolChange::LEN);
    }

    #[test]
    fn pool_deposit_len_matches_design() {
        let sample = sample_pool_deposit();
        let serialized = sample.try_to_vec().expect("serialize PoolDeposit");
        assert_eq!(serialized.len() + 8, PoolDeposit::LEN);
    }

    #[test]
    fn pool_deposit_frontend_field_roundtrip() {
        let frontend = Pubkey::new_unique();
        let mut deposit = sample_pool_deposit();

        deposit.frontend = frontend;

        assert_eq!(deposit.frontend, frontend);
    }

    #[test]
    fn pool_deposit_frontend_default_is_pubkey_default() {
        let deposit = sample_pool_deposit();

        assert_eq!(deposit.frontend, Pubkey::default());
    }

    #[test]
    fn pool_deposit_yield_preference_default_is_compound() {
        let deposit = sample_pool_deposit();

        assert_eq!(deposit.yield_preference, 0);
    }

    #[test]
    fn pool_deposit_yield_preference_roundtrip() {
        let mut deposit = sample_pool_deposit();

        deposit.yield_preference = 1;

        assert_eq!(deposit.yield_preference, 1);
    }

    #[test]
    fn pool_deposit_total_yield_compounded_default_is_zero() {
        let deposit = sample_pool_deposit();

        assert_eq!(deposit.total_yield_compounded, 0);
    }

    #[test]
    fn pool_deposit_total_yield_compounded_roundtrip() {
        let mut deposit = sample_pool_deposit();

        deposit.total_yield_compounded = 1_000_000;

        assert_eq!(deposit.total_yield_compounded, 1_000_000);
    }

    #[test]
    fn pool_deposit_total_yield_compounded_accumulates() {
        let mut deposit = sample_pool_deposit();

        deposit.total_yield_compounded = deposit
            .total_yield_compounded
            .checked_add(500)
            .expect("first accumulation should succeed");
        deposit.total_yield_compounded = deposit
            .total_yield_compounded
            .checked_add(300)
            .expect("second accumulation should succeed");

        assert_eq!(deposit.total_yield_compounded, 800);
    }

    #[test]
    fn pool_deposit_total_yield_compounded_overflow_is_detected() {
        let mut deposit = sample_pool_deposit();
        deposit.total_yield_compounded = u64::MAX;

        let overflowed = deposit.total_yield_compounded.checked_add(1);

        assert!(overflowed.is_none());
    }

    #[test]
    fn pool_deposit_yield_fields_do_not_clobber_each_other() {
        let mut deposit = sample_pool_deposit();

        deposit.yield_preference = 1;
        deposit.total_yield_compounded = 999;

        assert_eq!(deposit.yield_preference, 1);
        assert_eq!(deposit.total_yield_compounded, 999);
    }
}
