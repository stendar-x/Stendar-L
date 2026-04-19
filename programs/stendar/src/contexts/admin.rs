use crate::errors::StendarError;
use crate::state::{
    ContractOperationsFund, DebtContract, FrontendOperator, State, Treasury,
    FRONTEND_OPERATOR_SEED, OPERATIONS_FUND_SEED, TREASURY_SEED,
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
pub struct AutomatedInterestTransfer<'info> {
    #[account(
        mut,
        seeds = [b"debt_contract", contract.borrower.as_ref(), &contract.contract_seed.to_le_bytes()],
        bump
    )]
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
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    /// Contract's USDC ATA used for interest distributions.
    #[account(mut)]
    pub contract_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Bot's USDC ATA used to front lender distributions for collateral-transfer interest.
    #[account(mut)]
    pub bot_usdc_ata: Option<Account<'info, TokenAccount>>,
    /// Contract collateral ATA used to reimburse the bot proportionally.
    #[account(mut)]
    pub contract_collateral_account: Option<Account<'info, TokenAccount>>,
    /// Bot collateral ATA that receives reimbursed collateral.
    #[account(mut)]
    pub bot_collateral_ata: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub bot_processor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AutomatedPrincipalTransfer<'info> {
    #[account(
        mut,
        seeds = [b"debt_contract", contract.borrower.as_ref(), &contract.contract_seed.to_le_bytes()],
        bump
    )]
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
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    /// Contract's USDC ATA used for principal distributions.
    #[account(
        mut,
        constraint = contract_usdc_account.key() == contract.loan_token_account @ StendarError::TokenAccountMismatch
    )]
    pub contract_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Bot's USDC ATA used to front lender distributions.
    #[account(
        mut,
        constraint = bot_usdc_ata.owner == bot_processor.key() @ StendarError::UnauthorizedBotOperation,
        constraint = bot_usdc_ata.mint == contract.loan_mint @ StendarError::InvalidUsdcMint
    )]
    pub bot_usdc_ata: Account<'info, TokenAccount>,
    /// Contract collateral ATA used to reimburse the bot proportionally.
    #[account(mut)]
    pub contract_collateral_account: Option<Account<'info, TokenAccount>>,
    /// Bot collateral ATA that receives reimbursed collateral.
    #[account(mut)]
    pub bot_collateral_ata: Option<Account<'info, TokenAccount>>,
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
pub struct ProposeTreasuryAuthorityTransfer<'info> {
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
        has_one = authority @ StendarError::UnauthorizedAuthorityUpdate
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: The new governance authority pubkey (can be a multisig account).
    pub new_authority: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AcceptTreasuryAuthorityTransfer<'info> {
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    pub pending_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateBotAuthority<'info> {
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
        has_one = authority @ StendarError::UnauthorizedAuthorityUpdate
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

#[derive(Accounts)]
pub struct UpdateFeeRates<'info> {
    #[account(
        mut,
        seeds = [b"global_state"],
        bump,
        has_one = authority @ StendarError::InvalidAuthority
    )]
    pub state: Account<'info, State>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RegisterFrontend<'info> {
    #[account(
        init,
        payer = operator,
        space = FrontendOperator::LEN,
        seeds = [FRONTEND_OPERATOR_SEED, operator.key().as_ref()],
        bump
    )]
    pub frontend_operator: Account<'info, FrontendOperator>,
    #[account(mut)]
    pub operator: Signer<'info>,
    pub system_program: Program<'info, System>,
}
