use crate::errors::StendarError;
#[cfg(feature = "testing")]
use crate::state::TestClockOffset;
use crate::state::{CollateralRegistry, DebtContract, State, Treasury, TREASURY_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

#[derive(Accounts)]
pub struct DrawFromRevolving<'info> {
    #[account(
        mut,
        has_one = borrower @ StendarError::UnauthorizedPayment
    )]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[cfg(feature = "testing")]
    pub test_clock_offset: Option<Box<Account<'info, TestClockOffset>>>,
    #[account(
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(mut)]
    pub borrower_usdc_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = contract_usdc_account.key() == contract.loan_token_account @ StendarError::TokenAccountMismatch
    )]
    pub contract_usdc_account: Account<'info, TokenAccount>,
    #[account(
        seeds = [crate::state::COLLATERAL_REGISTRY_SEED],
        bump
    )]
    pub collateral_registry: Option<Account<'info, CollateralRegistry>>,
    /// CHECK: Validated against collateral registry oracle feed in instruction.
    pub price_feed_account: Option<AccountInfo<'info>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RepayRevolving<'info> {
    #[account(
        mut,
        has_one = borrower @ StendarError::UnauthorizedPayment
    )]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[cfg(feature = "testing")]
    pub test_clock_offset: Option<Box<Account<'info, TestClockOffset>>>,
    #[account(
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(mut)]
    pub borrower_usdc_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = contract_usdc_account.key() == contract.loan_token_account @ StendarError::TokenAccountMismatch
    )]
    pub contract_usdc_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseRevolvingFacility<'info> {
    #[account(
        mut,
        has_one = borrower @ StendarError::UnauthorizedPayment
    )]
    pub contract: Account<'info, DebtContract>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[cfg(feature = "testing")]
    pub test_clock_offset: Option<Box<Account<'info, TestClockOffset>>>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(mut)]
    pub borrower_usdc_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = contract_usdc_account.key() == contract.loan_token_account @ StendarError::TokenAccountMismatch
    )]
    pub contract_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub treasury_usdc_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SweepContractPool<'info> {
    #[account(
        mut,
        has_one = borrower @ StendarError::UnauthorizedPayment
    )]
    pub contract: Account<'info, DebtContract>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(
        mut,
        constraint = contract_usdc_account.key() == contract.loan_token_account @ StendarError::TokenAccountMismatch
    )]
    pub contract_usdc_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = borrower_usdc_account.owner == borrower.key() @ StendarError::UnauthorizedPayment,
        constraint = borrower_usdc_account.mint == contract.loan_mint @ StendarError::TokenAccountMismatch
    )]
    pub borrower_usdc_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BotCloseMaturedRevolving<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[cfg(feature = "testing")]
    pub test_clock_offset: Option<Box<Account<'info, TestClockOffset>>>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(
        constraint = treasury.bot_authority == bot_authority.key() @ StendarError::UnauthorizedBotOperation
    )]
    pub bot_authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DistributeStandbyFees<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[cfg(feature = "testing")]
    pub test_clock_offset: Option<Box<Account<'info, TestClockOffset>>>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(
        constraint = treasury.bot_authority == bot_authority.key() @ StendarError::UnauthorizedBotOperation
    )]
    pub bot_authority: Signer<'info>,
    #[account(
        mut,
        constraint = contract_usdc_account.key() == contract.loan_token_account @ StendarError::TokenAccountMismatch
    )]
    pub contract_usdc_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
