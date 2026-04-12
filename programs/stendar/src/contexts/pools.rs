use crate::errors::StendarError;
use crate::state::{
    ApprovedFunder, AuthorizedPoolOperator, DebtContract, LenderContribution, LenderEscrow,
    PendingPoolChange, PoolDeposit, PoolState, State, Treasury, APPROVED_FUNDER_SEED,
    PENDING_POOL_CHANGE_SEED, POOL_DEPOSIT_SEED, POOL_OPERATOR_SEED, POOL_SEED, TREASURY_SEED,
};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct AuthorizePoolOperator<'info> {
    #[account(
        seeds = [b"global_state"],
        bump,
        constraint = state.authority == authority.key() @ StendarError::InvalidAuthority
    )]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = AuthorizedPoolOperator::LEN,
        seeds = [POOL_OPERATOR_SEED, operator.key().as_ref()],
        bump
    )]
    pub operator_auth: Account<'info, AuthorizedPoolOperator>,
    /// CHECK: Wallet being authorized as a pool operator.
    pub operator: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokePoolOperator<'info> {
    #[account(
        seeds = [b"global_state"],
        bump,
        constraint = state.authority == authority.key() @ StendarError::InvalidAuthority
    )]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        close = authority,
        seeds = [POOL_OPERATOR_SEED, operator.key().as_ref()],
        bump
    )]
    pub operator_auth: Account<'info, AuthorizedPoolOperator>,
    /// CHECK: Wallet being revoked as a pool operator.
    pub operator: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(pool_seed: u64)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        seeds = [POOL_OPERATOR_SEED, operator.key().as_ref()],
        bump,
        constraint = operator_auth.operator == operator.key() @ StendarError::PoolOperatorNotAuthorized
    )]
    pub operator_auth: Account<'info, AuthorizedPoolOperator>,
    #[account(
        init,
        payer = operator,
        space = PoolState::LEN,
        seeds = [POOL_SEED, operator.key().as_ref(), &pool_seed.to_le_bytes()],
        bump
    )]
    pub pool: Account<'info, PoolState>,
    #[account(
        init,
        payer = operator,
        associated_token::mint = usdc_mint,
        associated_token::authority = pool
    )]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(seeds = [b"global_state"], bump)]
    pub state: Account<'info, State>,
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePoolName<'info> {
    pub operator: Signer<'info>,
    #[account(
        mut,
        constraint = pool.operator == operator.key() @ StendarError::InvalidPoolOperator
    )]
    pub pool: Account<'info, PoolState>,
}

#[derive(Accounts)]
pub struct UpdateOperatorName<'info> {
    pub operator: Signer<'info>,
    #[account(
        mut,
        seeds = [POOL_OPERATOR_SEED, operator.key().as_ref()],
        bump,
        constraint = operator_auth.operator == operator.key() @ StendarError::PoolOperatorNotAuthorized
    )]
    pub operator_auth: Account<'info, AuthorizedPoolOperator>,
}

#[derive(Accounts)]
pub struct DepositToPool<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, PoolState>,
    #[account(seeds = [b"global_state"], bump)]
    pub state: Account<'info, State>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(
        init_if_needed,
        payer = depositor,
        space = PoolDeposit::LEN,
        seeds = [POOL_DEPOSIT_SEED, pool.key().as_ref(), depositor.key().as_ref()],
        bump
    )]
    pub pool_deposit: Account<'info, PoolDeposit>,
    #[account(
        mut,
        constraint = pool_vault.key() == pool.vault_token_account @ StendarError::TokenAccountMismatch
    )]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = depositor_usdc_ata.owner == depositor.key() @ StendarError::TokenAccountMismatch
    )]
    pub depositor_usdc_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub treasury_usdc_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawFromPool<'info> {
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, PoolState>,
    #[account(
        mut,
        seeds = [POOL_DEPOSIT_SEED, pool.key().as_ref(), depositor.key().as_ref()],
        bump,
        constraint = pool_deposit.depositor == depositor.key() @ StendarError::UnauthorizedClaim
    )]
    pub pool_deposit: Account<'info, PoolDeposit>,
    #[account(
        mut,
        constraint = pool_vault.key() == pool.vault_token_account @ StendarError::TokenAccountMismatch
    )]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub depositor_usdc_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RequestPoolWithdrawal<'info> {
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, PoolState>,
    #[account(
        mut,
        seeds = [POOL_DEPOSIT_SEED, pool.key().as_ref(), depositor.key().as_ref()],
        bump,
        constraint = pool_deposit.depositor == depositor.key() @ StendarError::UnauthorizedClaim
    )]
    pub pool_deposit: Account<'info, PoolDeposit>,
}

#[derive(Accounts)]
pub struct ProcessPoolWithdrawal<'info> {
    pub processor: Signer<'info>,
    #[account(
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(
        mut,
        constraint = pool.operator == processor.key() || treasury.bot_authority == processor.key()
            @ StendarError::UnauthorizedBotOperation
    )]
    pub pool: Account<'info, PoolState>,
    #[account(
        mut,
        seeds = [POOL_DEPOSIT_SEED, pool.key().as_ref(), depositor.key().as_ref()],
        bump,
        constraint = pool_deposit.depositor == depositor.key() @ StendarError::UnauthorizedClaim
    )]
    pub pool_deposit: Account<'info, PoolDeposit>,
    /// CHECK: Withdrawal destination owner. Verified by PDA seeds and token account owner checks.
    pub depositor: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = depositor_usdc_ata.owner == depositor.key() @ StendarError::TokenAccountMismatch
    )]
    pub depositor_usdc_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = pool_vault.key() == pool.vault_token_account @ StendarError::TokenAccountMismatch
    )]
    pub pool_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OperatorReturnDeposit<'info> {
    pub operator: Signer<'info>,
    #[account(
        mut,
        constraint = pool.operator == operator.key() @ StendarError::InvalidPoolOperator
    )]
    pub pool: Account<'info, PoolState>,
    #[account(
        mut,
        seeds = [POOL_DEPOSIT_SEED, pool.key().as_ref(), depositor.key().as_ref()],
        bump,
        constraint = pool_deposit.depositor == depositor.key() @ StendarError::UnauthorizedClaim,
        constraint = pool_deposit.pool == pool.key() @ StendarError::UnauthorizedClaim
    )]
    pub pool_deposit: Account<'info, PoolDeposit>,
    /// CHECK: Returned funds destination owner. Verified by PDA seeds and token account owner checks.
    pub depositor: UncheckedAccount<'info>,
    #[account(mut)]
    pub depositor_usdc_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = pool_vault.key() == pool.vault_token_account @ StendarError::TokenAccountMismatch
    )]
    pub pool_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimPoolYield<'info> {
    pub depositor: Signer<'info>,
    #[account(seeds = [b"global_state"], bump)]
    pub state: Account<'info, State>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(mut)]
    pub pool: Account<'info, PoolState>,
    #[account(
        mut,
        seeds = [POOL_DEPOSIT_SEED, pool.key().as_ref(), depositor.key().as_ref()],
        bump,
        constraint = pool_deposit.depositor == depositor.key() @ StendarError::UnauthorizedClaim
    )]
    pub pool_deposit: Account<'info, PoolDeposit>,
    #[account(
        mut,
        constraint = pool_vault.key() == pool.vault_token_account @ StendarError::TokenAccountMismatch
    )]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub depositor_usdc_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub treasury_usdc_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ProposePoolChanges<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        constraint = pool.operator == operator.key() @ StendarError::InvalidPoolOperator
    )]
    pub pool: Account<'info, PoolState>,
    #[account(
        init,
        payer = operator,
        space = PendingPoolChange::LEN,
        seeds = [PENDING_POOL_CHANGE_SEED, pool.key().as_ref()],
        bump
    )]
    pub pending_change: Account<'info, PendingPoolChange>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyPoolChanges<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        mut,
        constraint = pool.operator == operator.key() @ StendarError::InvalidPoolOperator
    )]
    pub pool: Account<'info, PoolState>,
    #[account(
        mut,
        close = operator,
        seeds = [PENDING_POOL_CHANGE_SEED, pool.key().as_ref()],
        bump,
        constraint = pending_change.pool == pool.key() @ StendarError::InvalidContractReference,
        constraint = pending_change.operator == operator.key() @ StendarError::InvalidPoolOperator
    )]
    pub pending_change: Account<'info, PendingPoolChange>,
}

#[derive(Accounts)]
pub struct CancelPoolChanges<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        mut,
        close = operator,
        seeds = [PENDING_POOL_CHANGE_SEED, pending_change.pool.as_ref()],
        bump,
        constraint = pending_change.operator == operator.key() @ StendarError::InvalidPoolOperator
    )]
    pub pending_change: Account<'info, PendingPoolChange>,
}

#[derive(Accounts)]
pub struct PausePool<'info> {
    pub operator: Signer<'info>,
    #[account(
        mut,
        constraint = pool.operator == operator.key() @ StendarError::InvalidPoolOperator
    )]
    pub pool: Account<'info, PoolState>,
}

#[derive(Accounts)]
pub struct ResumePool<'info> {
    pub operator: Signer<'info>,
    #[account(
        mut,
        constraint = pool.operator == operator.key() @ StendarError::InvalidPoolOperator
    )]
    pub pool: Account<'info, PoolState>,
}

#[derive(Accounts)]
pub struct ClosePool<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        mut,
        close = operator,
        constraint = pool.operator == operator.key() @ StendarError::InvalidPoolOperator,
        constraint = pool.current_total_deposits == 0 @ StendarError::PoolNotEmpty,
        constraint = pool.current_utilized == 0 @ StendarError::PoolUtilizationNotZero
    )]
    pub pool: Account<'info, PoolState>,
}

#[derive(Accounts)]
pub struct ExpireIdlePool<'info> {
    pub bot_authority: Signer<'info>,
    #[account(
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.bot_authority == bot_authority.key() @ StendarError::UnauthorizedBotOperation
    )]
    pub treasury: Account<'info, Treasury>,
    /// CHECK: Pool rent is returned directly to the operator wallet.
    #[account(mut)]
    pub operator_receiver: AccountInfo<'info>,
    #[account(
        mut,
        close = operator_receiver,
        constraint = operator_receiver.key() == pool.operator @ StendarError::InvalidPoolOperator
    )]
    pub pool: Account<'info, PoolState>,
    #[account(
        constraint = pool_vault.key() == pool.vault_token_account @ StendarError::TokenAccountMismatch
    )]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        close = operator_receiver,
        seeds = [PENDING_POOL_CHANGE_SEED, pool.key().as_ref()],
        bump,
    )]
    pub pending_change: Option<Account<'info, PendingPoolChange>>,
}

#[derive(Accounts)]
pub struct PoolDeployToContract<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        mut,
        constraint = pool.operator == operator.key() @ StendarError::InvalidPoolOperator
    )]
    pub pool: Box<Account<'info, PoolState>>,
    #[account(
        mut,
        constraint = pool_vault.key() == pool.vault_token_account @ StendarError::TokenAccountMismatch
    )]
    pub pool_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub contract: Box<Account<'info, DebtContract>>,
    #[account(seeds = [b"global_state"], bump)]
    pub state: Box<Account<'info, State>>,
    #[account(
        init_if_needed,
        payer = operator,
        space = LenderContribution::LEN,
        seeds = [b"contribution", contract.key().as_ref(), pool.key().as_ref()],
        bump
    )]
    pub contribution: Box<Account<'info, LenderContribution>>,
    #[account(
        init_if_needed,
        payer = operator,
        space = LenderEscrow::LEN,
        seeds = [b"escrow", contract.key().as_ref(), pool.key().as_ref()],
        bump
    )]
    pub escrow: Box<Account<'info, LenderEscrow>>,
    #[account(mut)]
    pub contract_usdc_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Contract borrower wallet for standard funding checks.
    #[account(
        mut,
        constraint = borrower.key() == contract.borrower @ StendarError::UnauthorizedPayment
    )]
    pub borrower: UncheckedAccount<'info>,
    #[account(mut)]
    pub borrower_usdc_account: Option<Box<Account<'info, TokenAccount>>>,
    #[account(
        seeds = [APPROVED_FUNDER_SEED, contract.key().as_ref(), pool.key().as_ref()],
        bump
    )]
    pub approved_funder: Option<Box<Account<'info, ApprovedFunder>>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PoolClaimFromEscrow<'info> {
    pub caller: Signer<'info>,
    #[account(
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(
        mut,
        constraint = pool.operator == caller.key() || treasury.bot_authority == caller.key()
            @ StendarError::InvalidPoolOperator
    )]
    pub pool: Account<'info, PoolState>,
    #[account(
        mut,
        constraint = pool_vault.key() == pool.vault_token_account @ StendarError::TokenAccountMismatch
    )]
    pub pool_vault: Account<'info, TokenAccount>,
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        seeds = [b"escrow", contract.key().as_ref(), pool.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, LenderEscrow>,
    #[account(mut)]
    pub escrow_usdc_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PoolRequestRecall<'info> {
    pub operator: Signer<'info>,
    #[account(
        mut,
        constraint = pool.operator == operator.key() @ StendarError::InvalidPoolOperator
    )]
    pub pool: Account<'info, PoolState>,
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        seeds = [b"contribution", contract.key().as_ref(), pool.key().as_ref()],
        bump,
        constraint = contribution.contract == contract.key() @ StendarError::InvalidContribution,
        constraint = contribution.lender == pool.key() @ StendarError::InvalidPoolOperator
    )]
    pub contribution: Account<'info, LenderContribution>,
}
