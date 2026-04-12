use crate::errors::StendarError;
use crate::state::{DebtContract, State, OPERATIONS_FUND_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

#[derive(Accounts)]
pub struct MakePayment<'info> {
    #[account(
        mut,
        has_one = borrower @ StendarError::UnauthorizedPayment
    )]
    pub contract: Account<'info, DebtContract>,
    /// CHECK: Optional operations fund PDA; validated via seeds.
    #[account(
        mut,
        seeds = [OPERATIONS_FUND_SEED, contract.key().as_ref()],
        bump
    )]
    pub operations_fund: Option<AccountInfo<'info>>,
    #[account(
        mut,
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    /// Borrower's USDC ATA used for loan payments.
    #[account(mut)]
    pub borrower_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Contract's USDC ATA used for loan payments.
    #[account(mut)]
    pub contract_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Contract collateral ATA used when a contract completes.
    #[account(mut)]
    pub contract_collateral_account: Option<Account<'info, TokenAccount>>,
    /// Borrower collateral ATA used when a contract completes.
    #[account(mut)]
    pub borrower_collateral_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MakePaymentWithDistribution<'info> {
    #[account(
        mut,
        has_one = borrower @ StendarError::UnauthorizedPayment
    )]
    pub contract: Account<'info, DebtContract>,
    /// CHECK: Optional operations fund PDA; validated via seeds.
    #[account(
        mut,
        seeds = [OPERATIONS_FUND_SEED, contract.key().as_ref()],
        bump
    )]
    pub operations_fund: Option<AccountInfo<'info>>,
    #[account(
        mut,
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    /// Borrower's USDC ATA used for loan payments.
    #[account(mut)]
    pub borrower_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Contract's USDC ATA used for custody/distribution.
    #[account(mut)]
    pub contract_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Contract collateral ATA used when a contract completes.
    #[account(mut)]
    pub contract_collateral_account: Option<Account<'info, TokenAccount>>,
    /// Borrower collateral ATA used when a contract completes.
    #[account(mut)]
    pub borrower_collateral_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
}
