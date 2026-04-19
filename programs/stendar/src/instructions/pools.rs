use crate::contexts::*;
use crate::errors::StendarError;
use crate::instructions::lending::{
    activate_open_contract_funding, finalize_contribution_to_contract,
    validate_demand_recall_contract,
};
use crate::state::{
    ContractFunded, ContractStatus, FrontendFeeSplit, LoanType, PoolChangeApplied,
    PoolChangeCancelled, PoolChangeProposed, PoolDeposit, PoolExpired, PoolState, PoolStatus,
    ACCOUNT_RESERVED_BYTES, CURRENT_ACCOUNT_VERSION, POOL_CHANGE_TIMELOCK_SECONDS,
    POOL_IDLE_EXPIRY_SECONDS, POOL_SEED,
};
use crate::utils::{calculate_fee_tenths_bps, calculate_frontend_share, require_current_version};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

pub const SECONDS_PER_YEAR: u64 = 365 * 24 * 60 * 60;
#[cfg(test)]
const MIN_POOL_RATE_CHANGE_INTERVAL_SECONDS: i64 = 24 * 60 * 60;
const POOL_ALLOWED_LOAN_TYPE_BOTH: u8 = 0;
const POOL_ALLOWED_LOAN_TYPE_DEMAND_ONLY: u8 = 1;
const POOL_ALLOWED_LOAN_TYPE_COMMITTED_ONLY: u8 = 2;

fn require_pool_active(pool: &PoolState) -> Result<()> {
    match pool.status {
        PoolStatus::Active => Ok(()),
        PoolStatus::Paused => err!(StendarError::PoolPaused),
        PoolStatus::Closed => err!(StendarError::PoolNotActive),
    }
}

#[cfg(test)]
fn require_rate_update_interval(previous_rate_updated_at: i64, now: i64) -> Result<()> {
    if previous_rate_updated_at <= 0 {
        return Ok(());
    }
    let elapsed = now
        .checked_sub(previous_rate_updated_at)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(
        elapsed >= MIN_POOL_RATE_CHANGE_INTERVAL_SECONDS,
        StendarError::RateChangeTooFrequent
    );
    Ok(())
}

fn refresh_pool_idle_since(pool: &mut PoolState, now: i64) {
    if pool.current_total_deposits == 0 && pool.current_utilized == 0 {
        if pool.idle_since == 0 {
            pool.idle_since = now;
        }
    } else {
        pool.idle_since = 0;
    }
}

fn clear_withdrawal_request(pool: &mut PoolState, pool_deposit: &mut PoolDeposit) -> Result<()> {
    if pool_deposit.withdrawal_requested && pool.pending_withdrawal_requests() > 0 {
        pool.decrement_pending_withdrawal_requests()?;
    }
    pool_deposit.withdrawal_requested = false;
    pool_deposit.withdrawal_requested_at = 0;
    pool_deposit.withdrawal_requested_amount = 0;
    Ok(())
}

fn queue_withdrawal_request(
    pool: &mut PoolState,
    pool_deposit: &mut PoolDeposit,
    amount: u64,
    now: i64,
) -> Result<()> {
    require!(
        !pool_deposit.withdrawal_requested,
        StendarError::PoolWithdrawalAlreadyQueued
    );
    pool_deposit.withdrawal_requested = true;
    pool_deposit.withdrawal_requested_at = now;
    pool_deposit.withdrawal_requested_amount = amount;
    pool.increment_pending_withdrawal_requests()?;
    Ok(())
}

fn validate_pool_change_compatibility(
    pool: &PoolState,
    capacity: Option<u64>,
    minimum_deposit: Option<u64>,
    withdrawal_queue_enabled: Option<bool>,
) -> Result<()> {
    if let Some(value) = capacity {
        require!(
            value >= pool.current_total_deposits,
            StendarError::PoolCapacityBelowDeposits
        );
    }

    if let Some(value) = minimum_deposit {
        if value > pool.current_total_deposits {
            msg!(
                "Pool minimum deposit updated above current aggregate deposits; existing positions remain valid"
            );
        }
    }

    if matches!(withdrawal_queue_enabled, Some(false)) {
        require!(
            pool.pending_withdrawal_requests() == 0,
            StendarError::PoolHasPendingWithdrawals
        );
    }

    Ok(())
}

fn calculate_accrued_yield(
    deposit_amount: u64,
    rate_bps: u32,
    seconds_elapsed: i64,
) -> Result<u64> {
    if seconds_elapsed <= 0 || deposit_amount == 0 || rate_bps == 0 {
        return Ok(0);
    }

    let numerator = (deposit_amount as u128)
        .checked_mul(rate_bps as u128)
        .ok_or(StendarError::ArithmeticOverflow)?
        .checked_mul(seconds_elapsed as u128)
        .ok_or(StendarError::ArithmeticOverflow)?;
    let denominator = 10_000u128
        .checked_mul(SECONDS_PER_YEAR as u128)
        .ok_or(StendarError::ArithmeticOverflow)?;
    let yield_amount = numerator
        .checked_div(denominator)
        .ok_or(StendarError::ArithmeticOverflow)?;

    u64::try_from(yield_amount).map_err(|_| error!(StendarError::ArithmeticOverflow))
}

/// Accrues depositor yield using at most one historical rate boundary.
///
/// The pool account stores only `prev_rate_bps` and `rate_updated_at`, so if multiple
/// rate changes occur between two claims, accrual is approximated by splitting at the
/// latest tracked boundary only. This is acceptable because pool rate updates are
/// time-locked by `MIN_POOL_RATE_CHANGE_INTERVAL_SECONDS`.
fn accrue_deposit_yield(
    pool: &mut PoolState,
    pool_deposit: &mut PoolDeposit,
    now: i64,
) -> Result<u64> {
    if now <= pool_deposit.last_yield_update {
        return Ok(0);
    }
    let mut accrued = 0u64;
    let mut segment_start = pool_deposit.last_yield_update;

    let rate_changed_during_window = pool.prev_rate_bps > 0
        && pool.rate_updated_at > pool_deposit.last_yield_update
        && pool.rate_updated_at < now;

    if rate_changed_during_window {
        // Limitation: only the latest rate change is tracked on-chain.
        // If multiple updates happen between claims, we split at the last update only.
        let elapsed_before_change = pool
            .rate_updated_at
            .checked_sub(segment_start)
            .ok_or(StendarError::ArithmeticOverflow)?;
        let accrued_before_change = calculate_accrued_yield(
            pool_deposit.deposit_amount,
            pool.prev_rate_bps,
            elapsed_before_change,
        )?;
        accrued = accrued
            .checked_add(accrued_before_change)
            .ok_or(StendarError::ArithmeticOverflow)?;
        segment_start = pool.rate_updated_at;
    }

    let elapsed_current = now
        .checked_sub(segment_start)
        .ok_or(StendarError::ArithmeticOverflow)?;
    let accrued_current =
        calculate_accrued_yield(pool_deposit.deposit_amount, pool.rate_bps, elapsed_current)?;
    accrued = accrued
        .checked_add(accrued_current)
        .ok_or(StendarError::ArithmeticOverflow)?;

    if accrued > 0 {
        // Track only yield that is currently backed by available pool liquidity.
        let available_liquidity = pool.available_liquidity()?;
        let pending_yield = pool.total_pending_yield();
        let remaining_yield_capacity = available_liquidity.saturating_sub(pending_yield);
        let capped_accrued = accrued.min(remaining_yield_capacity);

        if capped_accrued == 0 {
            return Ok(0);
        }

        pool_deposit.accrued_yield = pool_deposit
            .accrued_yield
            .checked_add(capped_accrued)
            .ok_or(StendarError::ArithmeticOverflow)?;
        pool.add_pending_yield(capped_accrued)?;
        accrued = capped_accrued;
    }
    pool_deposit.last_yield_update = now;
    Ok(accrued)
}

pub fn authorize_pool_operator(ctx: Context<AuthorizePoolOperator>) -> Result<()> {
    require_current_version(ctx.accounts.state.account_version)?;

    let operator = ctx.accounts.operator.key();
    let authorized_by = ctx.accounts.authority.key();
    let now = Clock::get()?.unix_timestamp;

    // v1 uses platform authority to manage operator PDAs.
    // v2 can move this to multisig, and v3 to DAO governance, while keeping the PDA model.
    ctx.accounts
        .operator_auth
        .initialize(operator, authorized_by, now);

    Ok(())
}

pub fn revoke_pool_operator(ctx: Context<RevokePoolOperator>) -> Result<()> {
    require_current_version(ctx.accounts.state.account_version)?;
    require_current_version(ctx.accounts.operator_auth.account_version)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn create_pool(
    ctx: Context<CreatePool>,
    pool_seed: u64,
    name: [u8; 32],
    rate_bps: u32,
    capacity: u64,
    minimum_deposit: u64,
    withdrawal_queue_enabled: bool,
    allowed_loan_type: u8,
    min_ltv_bps: u16,
    max_term_days: u32,
) -> Result<()> {
    require_current_version(ctx.accounts.state.account_version)?;
    require_current_version(ctx.accounts.operator_auth.account_version)?;
    require!(
        ctx.accounts.operator_auth.operator == ctx.accounts.operator.key(),
        StendarError::PoolOperatorNotAuthorized
    );
    require!(rate_bps <= 10_000, StendarError::InvalidPaymentAmount);
    require!(allowed_loan_type <= 2, StendarError::InvalidProposedTerms);

    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;

    pool.operator = ctx.accounts.operator.key();
    pool.pool_seed = pool_seed;
    pool.name = name;
    pool.rate_bps = rate_bps;
    pool.capacity = capacity;
    pool.current_total_deposits = 0;
    pool.current_utilized = 0;
    pool.total_yield_distributed = 0;
    pool.status = PoolStatus::Active;
    pool.created_at = now;
    pool.authorized = true;
    pool.withdrawal_queue_enabled = withdrawal_queue_enabled;
    pool.minimum_deposit = minimum_deposit;
    pool.num_depositors = 0;
    pool.loan_mint = ctx.accounts.usdc_mint.key();
    pool.vault_token_account = ctx.accounts.pool_vault.key();
    pool.bump = ctx.bumps.pool;
    pool.allowed_loan_type = allowed_loan_type;
    pool.min_ltv_bps = min_ltv_bps;
    pool.max_term_days = max_term_days;
    pool.rate_updated_at = 0;
    pool.prev_rate_bps = 0;
    pool.idle_since = now;
    pool.total_pending_yield = 0;
    pool.pending_withdrawal_requests = 0;
    pool._reserved = [0u8; ACCOUNT_RESERVED_BYTES];
    pool.account_version = CURRENT_ACCOUNT_VERSION;

    Ok(())
}

pub fn update_pool_name(ctx: Context<UpdatePoolName>, name: [u8; 32]) -> Result<()> {
    require_current_version(ctx.accounts.pool.account_version)?;
    ctx.accounts.pool.name = name;
    Ok(())
}

pub fn update_operator_name(ctx: Context<UpdateOperatorName>, name: [u8; 32]) -> Result<()> {
    require_current_version(ctx.accounts.operator_auth.account_version)?;
    ctx.accounts.operator_auth.operator_name = name;
    Ok(())
}

pub fn deposit_to_pool(ctx: Context<DepositToPool>, amount: u64) -> Result<()> {
    require!(amount > 0, StendarError::InvalidContributionAmount);
    let now = Clock::get()?.unix_timestamp;

    let pool_key = ctx.accounts.pool.key();
    let depositor_key = ctx.accounts.depositor.key();
    let pool_vault_key = ctx.accounts.pool_vault.key();

    let pool = &mut ctx.accounts.pool;
    require_current_version(ctx.accounts.state.account_version)?;
    require!(!ctx.accounts.state.is_paused, StendarError::PlatformPaused);
    require_current_version(ctx.accounts.treasury.account_version)?;
    require_current_version(pool.account_version)?;
    require_pool_active(pool)?;
    require!(pool.authorized, StendarError::PoolOperatorNotAuthorized);
    require!(
        amount >= pool.minimum_deposit,
        StendarError::PoolDepositBelowMinimum
    );

    let pool_deposit = &mut ctx.accounts.pool_deposit;
    let was_uninitialized = pool_deposit.account_version == 0;
    if was_uninitialized {
        pool_deposit.initialize(depositor_key, pool_key, now);
    } else {
        require_current_version(pool_deposit.account_version)?;
        require!(
            pool_deposit.depositor == depositor_key && pool_deposit.pool == pool_key,
            StendarError::UnauthorizedClaim
        );
    }

    require!(
        ctx.accounts.pool_vault.owner == pool_key && ctx.accounts.pool_vault.mint == pool.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.depositor_usdc_ata.owner == depositor_key
            && ctx.accounts.depositor_usdc_ata.mint == pool.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.treasury_usdc_account.owner == ctx.accounts.treasury.key()
            && ctx.accounts.treasury_usdc_account.mint == pool.loan_mint,
        StendarError::TokenAccountMismatch
    );
    let loan_mint = pool.loan_mint;
    {
        let treasury = &mut ctx.accounts.treasury;
        require!(
            treasury.usdc_mint != Pubkey::default(),
            StendarError::InvalidMint
        );
        require!(
            treasury.usdc_mint == loan_mint,
            StendarError::InvalidUsdcMint
        );
        require!(
            ctx.accounts.treasury_usdc_account.key() == treasury.treasury_usdc_account,
            StendarError::TokenAccountMismatch
        );
    }
    require!(
        pool.vault_token_account == pool_vault_key,
        StendarError::TokenAccountMismatch
    );

    let deposit_fee = calculate_fee_tenths_bps(amount, ctx.accounts.state.pool_deposit_fee_bps)?;
    let net_deposit = amount
        .checked_sub(deposit_fee)
        .ok_or(StendarError::ArithmeticOverflow)?;

    if pool.capacity > 0 {
        let updated_total = pool
            .current_total_deposits
            .checked_add(net_deposit)
            .ok_or(StendarError::ArithmeticOverflow)?;
        require!(
            updated_total <= pool.capacity,
            StendarError::PoolCapacityExceeded
        );
    }

    let was_zero = pool_deposit.deposit_amount == 0;
    accrue_deposit_yield(pool, pool_deposit, now)?;
    if let Some(frontend_operator) = ctx.accounts.frontend_operator.as_ref() {
        pool_deposit.frontend = frontend_operator.operator;
    }

    if deposit_fee > 0 {
        let stored_frontend = pool_deposit.frontend;
        let frontend_share = if stored_frontend != Pubkey::default() {
            if let Some(frontend_ata) = ctx.accounts.frontend_usdc_ata.as_ref() {
                require!(
                    frontend_ata.owner == stored_frontend,
                    StendarError::FrontendTokenAccountMismatch
                );
                require!(
                    frontend_ata.mint == pool.loan_mint,
                    StendarError::TokenAccountMismatch
                );
                calculate_frontend_share(deposit_fee)?
            } else {
                0
            }
        } else {
            0
        };

        let treasury_fee_received;
        if frontend_share > 0 {
            let frontend_ata = ctx
                .accounts
                .frontend_usdc_ata
                .as_ref()
                .ok_or(StendarError::MissingTokenAccounts)?;
            let treasury_share = deposit_fee
                .checked_sub(frontend_share)
                .ok_or(StendarError::ArithmeticOverflow)?;
            treasury_fee_received = treasury_share;
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.depositor_usdc_ata.to_account_info(),
                        to: ctx.accounts.treasury_usdc_account.to_account_info(),
                        authority: ctx.accounts.depositor.to_account_info(),
                    },
                ),
                treasury_share,
            )?;
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.depositor_usdc_ata.to_account_info(),
                        to: frontend_ata.to_account_info(),
                        authority: ctx.accounts.depositor.to_account_info(),
                    },
                ),
                frontend_share,
            )?;
            emit!(FrontendFeeSplit {
                frontend: stored_frontend,
                fee_type: 1,
                total_fee: deposit_fee,
                frontend_share,
                treasury_share,
            });
        } else {
            treasury_fee_received = deposit_fee;
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.depositor_usdc_ata.to_account_info(),
                        to: ctx.accounts.treasury_usdc_account.to_account_info(),
                        authority: ctx.accounts.depositor.to_account_info(),
                    },
                ),
                deposit_fee,
            )?;
        }
        ctx.accounts.treasury.fees_collected = ctx
            .accounts
            .treasury
            .fees_collected
            .checked_add(treasury_fee_received)
            .ok_or(StendarError::ArithmeticOverflow)?;
    }

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_usdc_ata.to_account_info(),
                to: ctx.accounts.pool_vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        net_deposit,
    )?;

    pool.current_total_deposits = pool
        .current_total_deposits
        .checked_add(net_deposit)
        .ok_or(StendarError::ArithmeticOverflow)?;
    refresh_pool_idle_since(pool, now);
    pool_deposit.deposit_amount = pool_deposit
        .deposit_amount
        .checked_add(net_deposit)
        .ok_or(StendarError::ArithmeticOverflow)?;
    pool_deposit.last_yield_update = now;
    if was_zero {
        pool_deposit.deposit_timestamp = now;
        pool.num_depositors = pool
            .num_depositors
            .checked_add(1)
            .ok_or(StendarError::ArithmeticOverflow)?;
    }
    pool_deposit.withdrawal_requested = false;
    pool_deposit.withdrawal_requested_at = 0;
    pool_deposit.withdrawal_requested_amount = 0;

    Ok(())
}

/// Withdraws immediately available liquidity for a depositor.
/// Intentionally does not require an active pool so depositors can always exit during pause.
pub fn withdraw_from_pool(ctx: Context<WithdrawFromPool>, amount: u64) -> Result<()> {
    require!(amount > 0, StendarError::InvalidContributionAmount);
    let now = Clock::get()?.unix_timestamp;

    let pool = &mut ctx.accounts.pool;
    let pool_key = pool.key();
    let depositor_key = ctx.accounts.depositor.key();
    require_current_version(pool.account_version)?;

    let pool_deposit = &mut ctx.accounts.pool_deposit;
    require_current_version(pool_deposit.account_version)?;
    require!(
        pool_deposit.depositor == depositor_key && pool_deposit.pool == pool_key,
        StendarError::UnauthorizedClaim
    );
    require!(
        amount <= pool_deposit.deposit_amount,
        StendarError::InvalidContributionAmount
    );

    require!(
        ctx.accounts.pool_vault.owner == pool_key && ctx.accounts.pool_vault.mint == pool.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.depositor_usdc_ata.owner == depositor_key
            && ctx.accounts.depositor_usdc_ata.mint == pool.loan_mint,
        StendarError::TokenAccountMismatch
    );

    accrue_deposit_yield(pool, pool_deposit, now)?;

    let available_liquidity = pool
        .current_total_deposits
        .checked_sub(pool.current_utilized)
        .ok_or(StendarError::ArithmeticOverflow)?;
    if amount > available_liquidity {
        if pool.withdrawal_queue_enabled {
            queue_withdrawal_request(pool, pool_deposit, amount, now)?;
            return Ok(());
        }
        return err!(StendarError::InsufficientPoolLiquidity);
    }
    require!(
        ctx.accounts.pool_vault.amount >= amount,
        StendarError::InsufficientPoolLiquidity
    );

    let pool_seed_bytes = pool.pool_seed.to_le_bytes();
    let pool_bump_bytes = [pool.bump];
    let signer_seeds: &[&[u8]] = &[
        POOL_SEED,
        pool.operator.as_ref(),
        &pool_seed_bytes,
        &pool_bump_bytes,
    ];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pool_vault.to_account_info(),
                to: ctx.accounts.depositor_usdc_ata.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
    )?;

    let previous_amount = pool_deposit.deposit_amount;
    pool_deposit.deposit_amount = pool_deposit
        .deposit_amount
        .checked_sub(amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    pool.current_total_deposits = pool
        .current_total_deposits
        .checked_sub(amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    refresh_pool_idle_since(pool, now);

    clear_withdrawal_request(pool, pool_deposit)?;

    if previous_amount > 0 && pool_deposit.deposit_amount == 0 {
        pool.num_depositors = pool
            .num_depositors
            .checked_sub(1)
            .ok_or(StendarError::ArithmeticOverflow)?;
    }

    Ok(())
}

/// Queues a withdrawal request when immediate liquidity is unavailable.
/// Intentionally does not require an active pool so queued exits remain possible during pause.
pub fn request_pool_withdrawal(ctx: Context<RequestPoolWithdrawal>, amount: u64) -> Result<()> {
    require!(amount > 0, StendarError::InvalidContributionAmount);
    let now = Clock::get()?.unix_timestamp;

    require_current_version(ctx.accounts.pool.account_version)?;
    require_current_version(ctx.accounts.pool_deposit.account_version)?;
    require!(
        ctx.accounts.pool_deposit.depositor == ctx.accounts.depositor.key()
            && ctx.accounts.pool_deposit.pool == ctx.accounts.pool.key(),
        StendarError::UnauthorizedClaim
    );
    require!(
        amount <= ctx.accounts.pool_deposit.deposit_amount,
        StendarError::InvalidContributionAmount
    );
    require!(
        !ctx.accounts.pool_deposit.withdrawal_requested,
        StendarError::PoolWithdrawalAlreadyQueued
    );

    let pool = &mut ctx.accounts.pool;
    let pool_deposit = &mut ctx.accounts.pool_deposit;
    queue_withdrawal_request(pool, pool_deposit, amount, now)?;
    Ok(())
}

/// Processes a previously queued withdrawal request.
/// Intentionally does not require an active pool so queued exits can be processed during pause.
pub fn process_pool_withdrawal(ctx: Context<ProcessPoolWithdrawal>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let depositor_key = ctx.accounts.depositor.key();

    let pool = &mut ctx.accounts.pool;
    require_current_version(pool.account_version)?;
    let pool_key = pool.key();

    let pool_deposit = &mut ctx.accounts.pool_deposit;
    require_current_version(pool_deposit.account_version)?;
    require!(
        pool_deposit.depositor == depositor_key && pool_deposit.pool == pool_key,
        StendarError::UnauthorizedClaim
    );
    require!(
        pool_deposit.withdrawal_requested,
        StendarError::PoolWithdrawalNotQueued
    );
    let queued_amount = pool_deposit.withdrawal_requested_amount;
    require!(queued_amount > 0, StendarError::PoolWithdrawalNotQueued);
    require!(
        queued_amount <= pool_deposit.deposit_amount,
        StendarError::InvalidContributionAmount
    );

    require!(
        ctx.accounts.pool_vault.owner == pool_key && ctx.accounts.pool_vault.mint == pool.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.depositor_usdc_ata.owner == depositor_key
            && ctx.accounts.depositor_usdc_ata.mint == pool.loan_mint,
        StendarError::TokenAccountMismatch
    );

    accrue_deposit_yield(pool, pool_deposit, now)?;

    let available_liquidity = pool
        .current_total_deposits
        .checked_sub(pool.current_utilized)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(
        queued_amount <= available_liquidity,
        StendarError::InsufficientPoolLiquidity
    );
    require!(
        ctx.accounts.pool_vault.amount >= queued_amount,
        StendarError::InsufficientPoolLiquidity
    );

    let pool_seed_bytes = pool.pool_seed.to_le_bytes();
    let pool_bump_bytes = [pool.bump];
    let signer_seeds: &[&[u8]] = &[
        POOL_SEED,
        pool.operator.as_ref(),
        &pool_seed_bytes,
        &pool_bump_bytes,
    ];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pool_vault.to_account_info(),
                to: ctx.accounts.depositor_usdc_ata.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[signer_seeds],
        ),
        queued_amount,
    )?;

    let previous_amount = pool_deposit.deposit_amount;
    pool_deposit.deposit_amount = pool_deposit
        .deposit_amount
        .checked_sub(queued_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    pool.current_total_deposits = pool
        .current_total_deposits
        .checked_sub(queued_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    refresh_pool_idle_since(pool, now);

    clear_withdrawal_request(pool, pool_deposit)?;

    if previous_amount > 0 && pool_deposit.deposit_amount == 0 {
        pool.num_depositors = pool
            .num_depositors
            .checked_sub(1)
            .ok_or(StendarError::ArithmeticOverflow)?;
    }

    Ok(())
}

/// Returns currently free liquidity from a paused pool back to a specific depositor.
pub fn operator_return_deposit(ctx: Context<OperatorReturnDeposit>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let depositor_key = ctx.accounts.depositor.key();

    let pool = &mut ctx.accounts.pool;
    require_current_version(pool.account_version)?;
    require!(
        pool.status == PoolStatus::Paused,
        StendarError::PoolNotPausedForReturn
    );
    let pool_key = pool.key();

    let pool_deposit = &mut ctx.accounts.pool_deposit;
    require_current_version(pool_deposit.account_version)?;
    require!(
        pool_deposit.depositor == depositor_key && pool_deposit.pool == pool_key,
        StendarError::UnauthorizedClaim
    );
    require!(
        pool_deposit.deposit_amount > 0,
        StendarError::InvalidContributionAmount
    );

    require!(
        ctx.accounts.pool_vault.owner == pool_key && ctx.accounts.pool_vault.mint == pool.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.depositor_usdc_ata.owner == depositor_key
            && ctx.accounts.depositor_usdc_ata.mint == pool.loan_mint,
        StendarError::TokenAccountMismatch
    );

    accrue_deposit_yield(pool, pool_deposit, now)?;

    let available_liquidity = pool
        .current_total_deposits
        .checked_sub(pool.current_utilized)
        .ok_or(StendarError::ArithmeticOverflow)?;
    let returnable_amount = pool_deposit
        .deposit_amount
        .min(available_liquidity)
        .min(ctx.accounts.pool_vault.amount);
    require!(
        returnable_amount > 0,
        StendarError::InsufficientPoolLiquidity
    );

    let pool_seed_bytes = pool.pool_seed.to_le_bytes();
    let pool_bump_bytes = [pool.bump];
    let signer_seeds: &[&[u8]] = &[
        POOL_SEED,
        pool.operator.as_ref(),
        &pool_seed_bytes,
        &pool_bump_bytes,
    ];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pool_vault.to_account_info(),
                to: ctx.accounts.depositor_usdc_ata.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[signer_seeds],
        ),
        returnable_amount,
    )?;

    let previous_amount = pool_deposit.deposit_amount;
    pool_deposit.deposit_amount = pool_deposit
        .deposit_amount
        .checked_sub(returnable_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    pool.current_total_deposits = pool
        .current_total_deposits
        .checked_sub(returnable_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    refresh_pool_idle_since(pool, now);

    clear_withdrawal_request(pool, pool_deposit)?;

    if previous_amount > 0 && pool_deposit.deposit_amount == 0 {
        pool.num_depositors = pool
            .num_depositors
            .checked_sub(1)
            .ok_or(StendarError::ArithmeticOverflow)?;
    }

    Ok(())
}

/// Claims accrued depositor yield from the pool vault.
/// Intentionally does not require an active pool so yield remains claimable during pause.
pub fn claim_pool_yield(ctx: Context<ClaimPoolYield>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let depositor_key = ctx.accounts.depositor.key();
    require_current_version(ctx.accounts.state.account_version)?;
    require_current_version(ctx.accounts.treasury.account_version)?;

    let pool = &mut ctx.accounts.pool;
    require_current_version(pool.account_version)?;
    let pool_key = pool.key();

    let pool_deposit = &mut ctx.accounts.pool_deposit;
    require_current_version(pool_deposit.account_version)?;
    require!(
        pool_deposit.depositor == depositor_key && pool_deposit.pool == pool_key,
        StendarError::UnauthorizedClaim
    );

    require!(
        ctx.accounts.pool_vault.owner == pool_key && ctx.accounts.pool_vault.mint == pool.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.depositor_usdc_ata.owner == depositor_key
            && ctx.accounts.depositor_usdc_ata.mint == pool.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.treasury_usdc_account.owner == ctx.accounts.treasury.key()
            && ctx.accounts.treasury_usdc_account.mint == pool.loan_mint,
        StendarError::TokenAccountMismatch
    );
    let loan_mint = pool.loan_mint;
    {
        let treasury = &mut ctx.accounts.treasury;
        require!(
            treasury.usdc_mint != Pubkey::default(),
            StendarError::InvalidMint
        );
        require!(
            treasury.usdc_mint == loan_mint,
            StendarError::InvalidUsdcMint
        );
        require!(
            ctx.accounts.treasury_usdc_account.key() == treasury.treasury_usdc_account,
            StendarError::TokenAccountMismatch
        );
    }

    accrue_deposit_yield(pool, pool_deposit, now)?;
    let yield_amount = pool_deposit.accrued_yield;
    require!(yield_amount > 0, StendarError::NoPaymentDue);
    let available_liquidity = pool.available_liquidity()?;
    require!(
        available_liquidity >= yield_amount,
        StendarError::InsufficientPoolLiquidity
    );
    require!(
        ctx.accounts.pool_vault.amount >= yield_amount,
        StendarError::InsufficientPoolLiquidity
    );
    let yield_fee = calculate_fee_tenths_bps(yield_amount, ctx.accounts.state.pool_yield_fee_bps)?;
    let net_yield = yield_amount
        .checked_sub(yield_fee)
        .ok_or(StendarError::ArithmeticOverflow)?;

    let pool_seed_bytes = pool.pool_seed.to_le_bytes();
    let pool_bump_bytes = [pool.bump];
    let signer_seeds: &[&[u8]] = &[
        POOL_SEED,
        pool.operator.as_ref(),
        &pool_seed_bytes,
        &pool_bump_bytes,
    ];

    if yield_fee > 0 {
        let stored_frontend = pool_deposit.frontend;
        let frontend_share = if stored_frontend != Pubkey::default() {
            if let Some(frontend_ata) = ctx.accounts.frontend_usdc_ata.as_ref() {
                require!(
                    frontend_ata.owner == stored_frontend,
                    StendarError::FrontendTokenAccountMismatch
                );
                require!(
                    frontend_ata.mint == pool.loan_mint,
                    StendarError::TokenAccountMismatch
                );
                calculate_frontend_share(yield_fee)?
            } else {
                0
            }
        } else {
            0
        };

        let treasury_fee_received;
        if frontend_share > 0 {
            let frontend_ata = ctx
                .accounts
                .frontend_usdc_ata
                .as_ref()
                .ok_or(StendarError::MissingTokenAccounts)?;
            let treasury_share = yield_fee
                .checked_sub(frontend_share)
                .ok_or(StendarError::ArithmeticOverflow)?;
            treasury_fee_received = treasury_share;

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.pool_vault.to_account_info(),
                        to: ctx.accounts.treasury_usdc_account.to_account_info(),
                        authority: pool.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                treasury_share,
            )?;
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.pool_vault.to_account_info(),
                        to: frontend_ata.to_account_info(),
                        authority: pool.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                frontend_share,
            )?;
            emit!(FrontendFeeSplit {
                frontend: stored_frontend,
                fee_type: 2,
                total_fee: yield_fee,
                frontend_share,
                treasury_share,
            });
        } else {
            treasury_fee_received = yield_fee;
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.pool_vault.to_account_info(),
                        to: ctx.accounts.treasury_usdc_account.to_account_info(),
                        authority: pool.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                yield_fee,
            )?;
        }
        ctx.accounts.treasury.fees_collected = ctx
            .accounts
            .treasury
            .fees_collected
            .checked_add(treasury_fee_received)
            .ok_or(StendarError::ArithmeticOverflow)?;
    }

    if net_yield > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_vault.to_account_info(),
                    to: ctx.accounts.depositor_usdc_ata.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[signer_seeds],
            ),
            net_yield,
        )?;
    }

    pool_deposit.accrued_yield = 0;
    pool_deposit.last_yield_update = now;
    pool_deposit.total_yield_claimed = pool_deposit
        .total_yield_claimed
        .checked_add(net_yield)
        .ok_or(StendarError::ArithmeticOverflow)?;
    if pool.total_pending_yield() >= yield_amount {
        pool.consume_pending_yield(yield_amount)?;
    } else {
        // Backward-compatible fallback for deposits accrued before pending-yield tracking existed.
        pool.set_total_pending_yield(0);
    }
    pool.total_yield_distributed = pool
        .total_yield_distributed
        .checked_add(net_yield)
        .ok_or(StendarError::ArithmeticOverflow)?;

    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn propose_pool_changes(
    ctx: Context<ProposePoolChanges>,
    rate_bps: Option<u32>,
    capacity: Option<u64>,
    minimum_deposit: Option<u64>,
    allowed_loan_type: Option<u8>,
    min_ltv_bps: Option<u16>,
    max_term_days: Option<u32>,
    withdrawal_queue_enabled: Option<bool>,
) -> Result<()> {
    require_current_version(ctx.accounts.pool.account_version)?;
    require_pool_active(&ctx.accounts.pool)?;
    require!(
        rate_bps.is_some()
            || capacity.is_some()
            || minimum_deposit.is_some()
            || allowed_loan_type.is_some()
            || min_ltv_bps.is_some()
            || max_term_days.is_some()
            || withdrawal_queue_enabled.is_some(),
        StendarError::NoChangesProposed
    );
    if let Some(rate) = rate_bps {
        require!(rate <= 10_000, StendarError::InvalidPaymentAmount);
    }
    if let Some(loan_type) = allowed_loan_type {
        require!(loan_type <= 2, StendarError::InvalidProposedTerms);
    }

    let proposed_at = Clock::get()?.unix_timestamp;
    let effective_at = proposed_at
        .checked_add(POOL_CHANGE_TIMELOCK_SECONDS)
        .ok_or(StendarError::ArithmeticOverflow)?;

    let pending_change = &mut ctx.accounts.pending_change;
    pending_change.pool = ctx.accounts.pool.key();
    pending_change.operator = ctx.accounts.operator.key();
    pending_change.proposed_at = proposed_at;
    pending_change.effective_at = effective_at;
    pending_change.rate_bps = rate_bps;
    pending_change.capacity = capacity;
    pending_change.minimum_deposit = minimum_deposit;
    pending_change.allowed_loan_type = allowed_loan_type;
    pending_change.min_ltv_bps = min_ltv_bps;
    pending_change.max_term_days = max_term_days;
    pending_change.withdrawal_queue_enabled = withdrawal_queue_enabled;
    pending_change.bump = ctx.bumps.pending_change;
    pending_change._reserved = [0u8; ACCOUNT_RESERVED_BYTES];
    pending_change.account_version = CURRENT_ACCOUNT_VERSION;
    emit!(PoolChangeProposed {
        pool: pending_change.pool,
        operator: pending_change.operator,
        effective_at,
        rate_bps: pending_change.rate_bps,
        capacity: pending_change.capacity,
        minimum_deposit: pending_change.minimum_deposit,
        allowed_loan_type: pending_change.allowed_loan_type,
        min_ltv_bps: pending_change.min_ltv_bps,
        max_term_days: pending_change.max_term_days,
        withdrawal_queue_enabled: pending_change.withdrawal_queue_enabled,
    });

    Ok(())
}

pub fn apply_pool_changes(ctx: Context<ApplyPoolChanges>) -> Result<()> {
    require_current_version(ctx.accounts.pool.account_version)?;
    require_current_version(ctx.accounts.pending_change.account_version)?;

    let now = Clock::get()?.unix_timestamp;
    let pending_change = &ctx.accounts.pending_change;
    require!(
        now >= pending_change.effective_at,
        StendarError::TimelockNotExpired
    );

    let rate_bps = pending_change.rate_bps;
    let capacity = pending_change.capacity;
    let minimum_deposit = pending_change.minimum_deposit;
    let allowed_loan_type = pending_change.allowed_loan_type;
    let min_ltv_bps = pending_change.min_ltv_bps;
    let max_term_days = pending_change.max_term_days;
    let withdrawal_queue_enabled = pending_change.withdrawal_queue_enabled;

    let pool = &mut ctx.accounts.pool;
    validate_pool_change_compatibility(pool, capacity, minimum_deposit, withdrawal_queue_enabled)?;

    if let Some(rate) = rate_bps {
        pool.prev_rate_bps = pool.rate_bps;
        pool.rate_bps = rate;
        pool.rate_updated_at = now;
    }
    if let Some(value) = capacity {
        pool.capacity = value;
    }
    if let Some(value) = minimum_deposit {
        pool.minimum_deposit = value;
    }
    if let Some(value) = allowed_loan_type {
        pool.allowed_loan_type = value;
    }
    if let Some(value) = min_ltv_bps {
        pool.min_ltv_bps = value;
    }
    if let Some(value) = max_term_days {
        pool.max_term_days = value;
    }
    if let Some(value) = withdrawal_queue_enabled {
        pool.withdrawal_queue_enabled = value;
    }

    emit!(PoolChangeApplied {
        pool: pool.key(),
        operator: ctx.accounts.operator.key(),
    });

    Ok(())
}

pub fn cancel_pool_changes(ctx: Context<CancelPoolChanges>) -> Result<()> {
    require_current_version(ctx.accounts.pending_change.account_version)?;
    emit!(PoolChangeCancelled {
        pool: ctx.accounts.pending_change.pool,
        operator: ctx.accounts.operator.key(),
    });
    Ok(())
}

pub fn pause_pool(ctx: Context<PausePool>) -> Result<()> {
    require_current_version(ctx.accounts.pool.account_version)?;
    require_pool_active(&ctx.accounts.pool)?;
    ctx.accounts.pool.status = PoolStatus::Paused;
    Ok(())
}

pub fn resume_pool(ctx: Context<ResumePool>) -> Result<()> {
    require_current_version(ctx.accounts.pool.account_version)?;
    require!(
        ctx.accounts.pool.status == PoolStatus::Paused,
        StendarError::PoolNotActive
    );
    ctx.accounts.pool.status = PoolStatus::Active;
    Ok(())
}

pub fn close_pool(ctx: Context<ClosePool>) -> Result<()> {
    require_current_version(ctx.accounts.pool.account_version)?;
    ctx.accounts.pool.status = PoolStatus::Closed;
    Ok(())
}

pub fn expire_idle_pool(ctx: Context<ExpireIdlePool>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require_current_version(pool.account_version)?;
    require!(
        pool.current_utilized == 0,
        StendarError::PoolUtilizationNotZero
    );
    require!(pool.current_total_deposits == 0, StendarError::PoolNotEmpty);
    require!(pool.idle_since > 0, StendarError::PoolNotIdle);
    let expiry_ts = pool
        .idle_since
        .checked_add(POOL_IDLE_EXPIRY_SECONDS)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(now >= expiry_ts, StendarError::PoolNotIdle);
    require!(
        ctx.accounts.pool_vault.amount == 0,
        StendarError::PoolNotEmpty
    );

    pool.status = PoolStatus::Closed;

    if ctx.accounts.pending_change.is_some() {
        emit!(PoolChangeCancelled {
            pool: pool.key(),
            operator: pool.operator,
        });
    }

    emit!(PoolExpired {
        pool: pool.key(),
        operator: pool.operator,
        idle_since: pool.idle_since,
    });
    Ok(())
}

pub fn pool_deploy_to_contract(ctx: Context<PoolDeployToContract>, amount: u64) -> Result<()> {
    require!(amount > 0, StendarError::InvalidContributionAmount);
    require_current_version(ctx.accounts.state.account_version)?;
    require!(!ctx.accounts.state.is_paused, StendarError::PlatformPaused);

    let now = Clock::get()?.unix_timestamp;
    let pool_key = ctx.accounts.pool.key();
    let contract_key = ctx.accounts.contract.key();
    let borrower_key = ctx.accounts.borrower.key();
    let contract_info = ctx.accounts.contract.to_account_info();
    let contribution_key = ctx.accounts.contribution.key();

    let pool = &mut ctx.accounts.pool;
    require_current_version(pool.account_version)?;
    require_pool_active(pool)?;

    let available_liquidity = pool
        .current_total_deposits
        .checked_sub(pool.current_utilized)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(
        amount <= available_liquidity,
        StendarError::InsufficientPoolLiquidity
    );
    require!(
        u64::from(ctx.accounts.pool_vault.amount) >= amount,
        StendarError::InsufficientPoolLiquidity
    );

    let contract = &mut ctx.accounts.contract;
    require_current_version(contract.account_version)?;
    match pool.allowed_loan_type {
        POOL_ALLOWED_LOAN_TYPE_BOTH => {}
        POOL_ALLOWED_LOAN_TYPE_DEMAND_ONLY => require!(
            contract.loan_type == LoanType::Demand,
            StendarError::PoolLoanTypeMismatch
        ),
        POOL_ALLOWED_LOAN_TYPE_COMMITTED_ONLY => require!(
            contract.loan_type == LoanType::Committed,
            StendarError::PoolLoanTypeMismatch
        ),
        _ => return err!(StendarError::PoolDeploymentRuleViolation),
    }
    if pool.min_ltv_bps > 0 {
        require!(
            contract.ltv_floor_bps >= pool.min_ltv_bps as u32,
            StendarError::PoolDeploymentRuleViolation
        );
    }
    if pool.max_term_days > 0 {
        require!(
            contract.term_days > 0 && contract.term_days <= pool.max_term_days,
            StendarError::PoolDeploymentRuleViolation
        );
    }

    require!(
        ctx.accounts.pool_vault.owner == pool_key && ctx.accounts.pool_vault.mint == pool.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.contract_usdc_account.owner == contract_key
            && ctx.accounts.contract_usdc_account.mint == contract.loan_mint
            && ctx.accounts.contract_usdc_account.key() == contract.loan_token_account,
        StendarError::TokenAccountMismatch
    );
    require!(
        pool.loan_mint == contract.loan_mint && ctx.accounts.usdc_mint.key() == contract.loan_mint,
        StendarError::InvalidUsdcMint
    );

    finalize_contribution_to_contract(
        contract,
        &mut ctx.accounts.contribution,
        &mut ctx.accounts.escrow,
        contribution_key,
        contract_key,
        pool_key,
        borrower_key,
        amount,
        now,
        ctx.accounts
            .approved_funder
            .as_deref()
            .map(|approved| approved.as_ref()),
    )?;

    let pool_seed_bytes = pool.pool_seed.to_le_bytes();
    let pool_bump_bytes = [pool.bump];
    let signer_seeds: &[&[u8]] = &[
        POOL_SEED,
        pool.operator.as_ref(),
        &pool_seed_bytes,
        &pool_bump_bytes,
    ];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pool_vault.to_account_info(),
                to: ctx.accounts.contract_usdc_account.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
    )?;

    if contract.funded_amount >= contract.target_amount {
        activate_open_contract_funding(
            ctx.program_id,
            contract,
            &contract_info,
            borrower_key,
            Some(&ctx.accounts.contract_usdc_account),
            ctx.accounts.borrower_usdc_account.as_deref(),
            Some(&ctx.accounts.token_program),
            now,
        )?;
    } else if contract.status == ContractStatus::OpenNotFunded {
        contract.status = ContractStatus::OpenPartiallyFunded;
        contract.update_bot_tracking(now);
    } else {
        contract.update_bot_tracking(now);
    }

    pool.current_utilized = pool
        .current_utilized
        .checked_add(amount)
        .ok_or(StendarError::ArithmeticOverflow)?;

    emit!(ContractFunded {
        contract: contract_key,
        lender: pool_key,
        amount,
    });

    Ok(())
}

// NOTE: Intentionally skips platform pause checks so pool exit/settlement flows remain available.
pub fn pool_claim_from_escrow(ctx: Context<PoolClaimFromEscrow>) -> Result<()> {
    let pool_key = ctx.accounts.pool.key();
    let contract_key = ctx.accounts.contract.key();

    let pool = &mut ctx.accounts.pool;
    require_current_version(pool.account_version)?;
    let escrow = &mut ctx.accounts.escrow;
    require_current_version(escrow.account_version)?;

    require!(
        escrow.contract == contract_key && escrow.lender == pool_key,
        StendarError::InvalidContribution
    );
    require!(
        escrow.escrow_token_account != Pubkey::default()
            && escrow.escrow_token_account == ctx.accounts.escrow_usdc_account.key(),
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.escrow_usdc_account.owner == escrow.key()
            && ctx.accounts.escrow_usdc_account.mint == ctx.accounts.contract.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.pool_vault.owner == pool_key
            && ctx.accounts.pool_vault.mint == ctx.accounts.contract.loan_mint
            && ctx.accounts.pool_vault.key() == pool.vault_token_account,
        StendarError::TokenAccountMismatch
    );

    let principal_claimed = escrow.available_principal;
    let total_available = escrow
        .available_interest
        .checked_add(escrow.available_principal)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(total_available > 0, StendarError::NoPaymentDue);

    let (expected_escrow_pda, escrow_bump) = Pubkey::find_program_address(
        &[b"escrow", contract_key.as_ref(), pool_key.as_ref()],
        ctx.program_id,
    );
    require!(
        expected_escrow_pda == escrow.key(),
        StendarError::InvalidContribution
    );
    let escrow_bump_bytes = [escrow_bump];
    let signer_seeds: &[&[u8]] = &[
        b"escrow",
        contract_key.as_ref(),
        pool_key.as_ref(),
        &escrow_bump_bytes,
    ];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_usdc_account.to_account_info(),
                to: ctx.accounts.pool_vault.to_account_info(),
                authority: escrow.to_account_info(),
            },
            &[signer_seeds],
        ),
        total_available,
    )?;

    escrow.total_claimed = escrow
        .total_claimed
        .checked_add(total_available)
        .ok_or(StendarError::ArithmeticOverflow)?;
    escrow.escrow_amount = escrow.escrow_amount.saturating_sub(total_available);
    escrow.available_interest = 0;
    escrow.available_principal = 0;

    if principal_claimed > 0 {
        pool.current_utilized = pool
            .current_utilized
            .checked_sub(principal_claimed)
            .ok_or(StendarError::ArithmeticOverflow)?;
    }
    refresh_pool_idle_since(pool, Clock::get()?.unix_timestamp);

    Ok(())
}

// NOTE: Intentionally skips platform pause checks so pool recall exits remain available.
pub fn pool_request_recall(ctx: Context<PoolRequestRecall>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool_key = ctx.accounts.pool.key();

    require_current_version(ctx.accounts.pool.account_version)?;
    require_current_version(ctx.accounts.contract.account_version)?;
    require_current_version(ctx.accounts.contribution.account_version)?;

    let contract = &mut ctx.accounts.contract;
    validate_demand_recall_contract(contract)?;
    require!(
        contract.status == ContractStatus::Active,
        StendarError::ContractNotFunded
    );
    require!(
        !contract.recall_requested,
        StendarError::RecallAlreadyPending
    );
    require!(
        ctx.accounts.contribution.contribution_amount > 0,
        StendarError::InvalidContributionAmount
    );
    require!(
        ctx.accounts.contribution.contract == contract.key()
            && ctx.accounts.contribution.lender == pool_key,
        StendarError::InvalidContribution
    );

    contract.recall_requested = true;
    contract.recall_requested_at = now;
    contract.recall_requested_by = pool_key;
    contract.status = ContractStatus::PendingRecall;
    contract.update_bot_tracking(now);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::error::Error;

    fn sample_pool() -> PoolState {
        PoolState {
            operator: Pubkey::new_unique(),
            pool_seed: 1,
            name: [0u8; 32],
            rate_bps: 500,
            capacity: 0,
            current_total_deposits: 0,
            current_utilized: 0,
            total_yield_distributed: 0,
            status: PoolStatus::Active,
            created_at: 1_700_000_000,
            authorized: true,
            withdrawal_queue_enabled: false,
            minimum_deposit: 0,
            num_depositors: 0,
            loan_mint: Pubkey::new_unique(),
            vault_token_account: Pubkey::new_unique(),
            bump: 255,
            allowed_loan_type: 0,
            min_ltv_bps: 0,
            max_term_days: 0,
            rate_updated_at: 0,
            prev_rate_bps: 0,
            idle_since: 0,
            total_pending_yield: 0,
            pending_withdrawal_requests: 0,
            _reserved: [0u8; ACCOUNT_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        }
    }

    fn sample_deposit(last_yield_update: i64) -> PoolDeposit {
        PoolDeposit {
            depositor: Pubkey::new_unique(),
            pool: Pubkey::new_unique(),
            deposit_amount: 1_000_000_000,
            accrued_yield: 0,
            last_yield_update,
            deposit_timestamp: last_yield_update,
            withdrawal_requested: false,
            withdrawal_requested_at: 0,
            withdrawal_requested_amount: 0,
            total_yield_claimed: 0,
            frontend: Pubkey::default(),
            _reserved: [0u8; ACCOUNT_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        }
    }

    #[test]
    fn accrue_deposit_yield_splits_accrual_across_rate_change() {
        let mut pool = sample_pool();
        pool.prev_rate_bps = 1_000;
        pool.rate_bps = 500;
        pool.rate_updated_at = 200;
        let mut deposit = sample_deposit(100);
        pool.current_total_deposits = deposit.deposit_amount;

        let accrued =
            accrue_deposit_yield(&mut pool, &mut deposit, 300).expect("accrual must succeed");
        let before_change =
            calculate_accrued_yield(deposit.deposit_amount, pool.prev_rate_bps, 100).unwrap();
        let after_change =
            calculate_accrued_yield(deposit.deposit_amount, pool.rate_bps, 100).unwrap();

        assert_eq!(accrued, before_change + after_change);
        assert_eq!(deposit.accrued_yield, accrued);
        assert_eq!(deposit.last_yield_update, 300);
    }

    #[test]
    fn accrue_deposit_yield_uses_current_rate_when_no_change_applies() {
        let mut pool = sample_pool();
        let mut deposit = sample_deposit(100);
        pool.current_total_deposits = deposit.deposit_amount;

        let accrued =
            accrue_deposit_yield(&mut pool, &mut deposit, 200).expect("accrual must succeed");
        let expected = calculate_accrued_yield(deposit.deposit_amount, pool.rate_bps, 100).unwrap();

        assert_eq!(accrued, expected);
        assert_eq!(deposit.accrued_yield, expected);
        assert_eq!(deposit.last_yield_update, 200);
    }

    #[test]
    fn accrue_deposit_yield_tracks_pending_yield() {
        let mut pool = sample_pool();
        let mut deposit = sample_deposit(100);
        pool.current_total_deposits = deposit.deposit_amount;

        let first = accrue_deposit_yield(&mut pool, &mut deposit, 200).expect("first accrual");
        let second = accrue_deposit_yield(&mut pool, &mut deposit, 300).expect("second accrual");

        assert_eq!(pool.total_pending_yield(), first + second);
        assert_eq!(deposit.accrued_yield, first + second);
    }

    #[test]
    fn accrue_deposit_yield_uses_last_rate_boundary_when_multiple_changes_are_possible() {
        let mut pool = sample_pool();
        pool.prev_rate_bps = 1_500;
        pool.rate_bps = 500;
        pool.rate_updated_at = 200;
        let mut deposit = sample_deposit(0);
        pool.current_total_deposits = deposit.deposit_amount;

        let approximated =
            accrue_deposit_yield(&mut pool, &mut deposit, 300).expect("accrual must succeed");
        let tracked_before_change =
            calculate_accrued_yield(deposit.deposit_amount, pool.prev_rate_bps, 200).unwrap();
        let tracked_after_change =
            calculate_accrued_yield(deposit.deposit_amount, pool.rate_bps, 100).unwrap();
        let hypothetical_two_change_exact = calculate_accrued_yield(deposit.deposit_amount, 1_000, 100)
            .unwrap()
            + calculate_accrued_yield(deposit.deposit_amount, 1_500, 100).unwrap()
            + tracked_after_change;

        assert_eq!(approximated, tracked_before_change + tracked_after_change);
        assert_ne!(approximated, hypothetical_two_change_exact);
    }

    #[test]
    fn accrue_deposit_yield_caps_unbacked_amount() {
        let mut pool = sample_pool();
        pool.current_total_deposits = 10;
        pool.current_utilized = 9;

        let mut deposit = sample_deposit(0);
        deposit.deposit_amount = 1_000_000_000;
        pool.set_total_pending_yield(0);

        let accrued = accrue_deposit_yield(&mut pool, &mut deposit, 365 * 24 * 60 * 60)
            .expect("accrual should cap to available backing");

        assert_eq!(accrued, 1);
        assert_eq!(deposit.accrued_yield, 1);
        assert_eq!(pool.total_pending_yield(), 1);
    }

    #[test]
    fn accrue_deposit_yield_does_not_advance_time_when_unbacked() {
        let mut pool = sample_pool();
        let mut deposit = sample_deposit(100);
        pool.current_total_deposits = 0;
        pool.current_utilized = 0;

        let first = accrue_deposit_yield(&mut pool, &mut deposit, 200)
            .expect("accrual without backing should succeed");
        assert_eq!(first, 0);
        assert_eq!(deposit.last_yield_update, 100);

        pool.current_total_deposits = 10;
        let second =
            accrue_deposit_yield(&mut pool, &mut deposit, 200).expect("accrual should resume");
        assert_eq!(second, 10);
        assert_eq!(deposit.last_yield_update, 200);
        assert_eq!(deposit.accrued_yield, 10);
        assert_eq!(pool.total_pending_yield(), 10);
    }

    #[test]
    fn clear_withdrawal_request_updates_pool_counter() {
        let mut pool = sample_pool();
        let mut deposit = sample_deposit(100);

        deposit.withdrawal_requested = true;
        deposit.withdrawal_requested_at = 500;
        deposit.withdrawal_requested_amount = 50;
        pool.increment_pending_withdrawal_requests()
            .expect("increment should succeed");
        assert_eq!(pool.pending_withdrawal_requests(), 1);

        clear_withdrawal_request(&mut pool, &mut deposit)
            .expect("clear should succeed");
        assert_eq!(pool.pending_withdrawal_requests(), 0);
        assert!(!deposit.withdrawal_requested);
        assert_eq!(deposit.withdrawal_requested_at, 0);
        assert_eq!(deposit.withdrawal_requested_amount, 0);
    }

    #[test]
    fn clear_withdrawal_request_is_idempotent() {
        let mut pool = sample_pool();
        let mut deposit = sample_deposit(100);

        clear_withdrawal_request(&mut pool, &mut deposit)
            .expect("clearing a non-requested deposit should succeed");
        assert_eq!(pool.pending_withdrawal_requests(), 0);
        assert!(!deposit.withdrawal_requested);
    }

    #[test]
    fn validate_pool_change_rejects_capacity_below_deposits() {
        let mut pool = sample_pool();
        pool.current_total_deposits = 500;
        let err = validate_pool_change_compatibility(&pool, Some(499), None, None)
            .expect_err("capacity below deposits must fail");
        match err {
            Error::AnchorError(anchor_err) => {
                assert_eq!(anchor_err.error_name, "PoolCapacityBelowDeposits");
            }
            _ => panic!("expected AnchorError variant"),
        }
    }

    #[test]
    fn validate_pool_change_rejects_disabling_queue_with_pending_requests() {
        let mut pool = sample_pool();
        pool.set_pending_withdrawal_requests(1);
        let err = validate_pool_change_compatibility(&pool, None, None, Some(false))
            .expect_err("disabling queue with pending requests must fail");
        match err {
            Error::AnchorError(anchor_err) => {
                assert_eq!(anchor_err.error_name, "PoolHasPendingWithdrawals");
            }
            _ => panic!("expected AnchorError variant"),
        }
    }

    #[test]
    fn rate_update_interval_allows_first_update_or_24h_spacing() {
        require_rate_update_interval(0, 1_700_000_000).expect("first update should pass");
        require_rate_update_interval(1_700_000_000, 1_700_086_400)
            .expect("24-hour interval should pass");
    }

    #[test]
    fn rate_update_interval_rejects_frequent_updates() {
        let err = require_rate_update_interval(1_700_000_000, 1_700_000_100)
            .expect_err("rapid updates must be rejected");
        match err {
            Error::AnchorError(anchor_err) => {
                assert_eq!(anchor_err.error_name, "RateChangeTooFrequent");
            }
            _ => panic!("expected AnchorError variant"),
        }
    }
}
