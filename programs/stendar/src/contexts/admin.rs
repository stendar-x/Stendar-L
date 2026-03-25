use crate::errors::StendarError;
use crate::state::{
    ContractOperationsFund, DebtContract, State, Treasury, OPERATIONS_FUND_SEED, TREASURY_SEED,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

#[derive(Accounts)]
pub struct InitializeTreasury<'info> {
    #[account(
        init,
        payer = authority,
        space = Treasury::LEN,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(
        seeds = [b"global_state"],
        bump,
        has_one = authority @ StendarError::InvalidAuthority
    )]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GetPlatformStats<'info> {
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
}

#[derive(Accounts)]
pub struct MigratePlatformAccounts<'info> {
    /// CHECK: May be undersized and fail typed deserialization; validated in handler.
    #[account(
        mut,
        seeds = [b"global_state"],
        bump,
        owner = crate::ID @ StendarError::InvalidAuthority
    )]
    pub state: AccountInfo<'info>,
    /// CHECK: Optional because treasury may not exist on some deployments yet.
    #[account(mut)]
    pub treasury: Option<AccountInfo<'info>>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AutomatedInterestTransfer<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    /// Optional per-contract operations fund. When `None`, bot reimbursement is skipped.
    /// This is acceptable because the bot itself controls which accounts it passes.
    #[account(
        mut,
        seeds = [OPERATIONS_FUND_SEED, contract.key().as_ref()],
        bump
    )]
    pub operations_fund: Option<Account<'info, ContractOperationsFund>>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    /// Contract's USDC ATA used for interest distributions.
    #[account(mut)]
    pub contract_usdc_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub bot_processor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AutomatedPrincipalTransfer<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    /// Optional per-contract operations fund. When `None`, bot reimbursement is skipped.
    /// This is acceptable because the bot itself controls which accounts it passes.
    #[account(
        mut,
        seeds = [OPERATIONS_FUND_SEED, contract.key().as_ref()],
        bump
    )]
    pub operations_fund: Option<Account<'info, ContractOperationsFund>>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    /// Contract's USDC ATA used for principal distributions.
    #[account(mut)]
    pub contract_usdc_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub bot_processor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawFromTreasury<'info> {
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
        has_one = authority @ StendarError::UnauthorizedWithdrawal
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    /// CHECK: This is the recipient account for treasury withdrawal
    pub recipient: AccountInfo<'info>,
    /// Treasury USDC ATA for token-denominated withdrawals.
    #[account(mut)]
    pub treasury_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Recipient USDC ATA for token-denominated withdrawals.
    #[account(mut)]
    pub recipient_usdc_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateTreasuryAuthority<'info> {
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: The new governance authority pubkey (can be a multisig account).
    pub new_authority: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct UpdateBotAuthority<'info> {
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: The new constrained bot authority pubkey.
    pub new_bot_authority: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct TogglePause<'info> {
    #[account(
        mut,
        seeds = [b"global_state"],
        bump,
        has_one = authority @ StendarError::InvalidAuthority
    )]
    pub state: Account<'info, State>,
    pub authority: Signer<'info>,
}
