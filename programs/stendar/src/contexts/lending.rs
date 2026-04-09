use crate::errors::StendarError;
use crate::state::{
    ApprovedFunder, CollateralRegistry, ContractOperationsFund, DebtContract, LenderContribution,
    LenderEscrow, State, TestClockOffset, Treasury, APPROVED_FUNDER_SEED, OPERATIONS_FUND_SEED,
    TREASURY_SEED,
};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = State::LEN,
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::id(),
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ StendarError::UnauthorizedAuthorityUpdate
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(contract_seed: u64, max_lenders: u16)]
pub struct CreateDebtContract<'info> {
    #[account(
        init,
        payer = borrower,
        space = DebtContract::space(max_lenders),
        seeds = [b"debt_contract", borrower.key().as_ref(), &contract_seed.to_le_bytes()],
        bump
    )]
    pub contract: Box<Account<'info, DebtContract>>,
    #[account(
        init,
        payer = borrower,
        space = ContractOperationsFund::LEN,
        seeds = [OPERATIONS_FUND_SEED, contract.key().as_ref()],
        bump
    )]
    pub operations_fund: Account<'info, ContractOperationsFund>,
    #[account(
        mut,
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    pub system_program: Program<'info, System>,

    // --- standard cross-collateral accounts ---
    #[account(
        seeds = [crate::state::COLLATERAL_REGISTRY_SEED],
        bump
    )]
    pub collateral_registry: Option<Account<'info, CollateralRegistry>>,
    pub collateral_mint: Option<Account<'info, Mint>>,
    #[account(mut)]
    pub borrower_collateral_ata: Option<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub contract_collateral_ata: Option<Account<'info, TokenAccount>>,
    /// CHECK: Validated against collateral registry entry in instruction.
    pub price_feed_account: Option<AccountInfo<'info>>,
    pub usdc_mint: Option<Account<'info, Mint>>,
    #[account(mut)]
    pub contract_usdc_ata: Option<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub borrower_usdc_ata: Option<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub treasury_usdc_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub associated_token_program: Option<Program<'info, AssociatedToken>>,
}

#[derive(Accounts)]
pub struct ApproveFunder<'info> {
    #[account(
        mut,
        seeds = [b"debt_contract", borrower.key().as_ref(), &contract.contract_seed.to_le_bytes()],
        bump
    )]
    pub contract: Account<'info, DebtContract>,
    #[account(
        init_if_needed,
        payer = borrower,
        space = ApprovedFunder::LEN,
        seeds = [APPROVED_FUNDER_SEED, contract.key().as_ref(), lender.key().as_ref()],
        bump
    )]
    pub approved_funder: Account<'info, ApprovedFunder>,
    #[account(
        mut,
        constraint = borrower.key() == contract.borrower @ StendarError::UnauthorizedPayment
    )]
    pub borrower: Signer<'info>,
    /// CHECK: Lender wallet to approve for this contract.
    pub lender: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeFunder<'info> {
    #[account(
        mut,
        seeds = [b"debt_contract", borrower.key().as_ref(), &contract.contract_seed.to_le_bytes()],
        bump
    )]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        close = borrower,
        seeds = [APPROVED_FUNDER_SEED, contract.key().as_ref(), lender.key().as_ref()],
        bump
    )]
    pub approved_funder: Account<'info, ApprovedFunder>,
    #[account(
        mut,
        constraint = borrower.key() == contract.borrower @ StendarError::UnauthorizedPayment
    )]
    pub borrower: Signer<'info>,
    /// CHECK: Lender wallet to revoke for this contract.
    pub lender: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ContributeToContract<'info> {
    #[account(
        mut,
        seeds = [b"debt_contract", borrower.key().as_ref(), &contract.contract_seed.to_le_bytes()],
        bump
    )]
    pub contract: Account<'info, DebtContract>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[account(
        init_if_needed,
        payer = lender,
        space = LenderContribution::LEN,
        seeds = [b"contribution", contract.key().as_ref(), lender.key().as_ref()],
        bump
    )]
    pub contribution: Account<'info, LenderContribution>,
    #[account(
        init_if_needed,
        payer = lender,
        space = LenderEscrow::LEN,
        seeds = [b"escrow", contract.key().as_ref(), lender.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, LenderEscrow>,
    #[account(mut)]
    pub lender: Signer<'info>,
    /// CHECK: This is the borrower account that receives funds when contract is fully funded
    #[account(
        mut,
        constraint = borrower.key() == contract.borrower @ StendarError::UnauthorizedPayment
    )]
    pub borrower: AccountInfo<'info>,
    #[account(
        seeds = [APPROVED_FUNDER_SEED, contract.key().as_ref(), lender.key().as_ref()],
        bump
    )]
    pub approved_funder: Option<Account<'info, ApprovedFunder>>,
    /// Lender's USDC account for contributions.
    #[account(mut)]
    pub lender_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Contract's USDC account for custody/disbursement.
    #[account(mut)]
    pub contract_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Borrower's USDC account used when a contract activates.
    #[account(mut)]
    pub borrower_usdc_account: Option<Account<'info, TokenAccount>>,
    pub usdc_mint: Option<Account<'info, Mint>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddCollateral<'info> {
    #[account(
        mut,
        seeds = [b"debt_contract", contract.borrower.as_ref(), &contract.contract_seed.to_le_bytes()],
        bump
    )]
    pub contract: Account<'info, DebtContract>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[account(
        mut,
        constraint = borrower.key() == contract.borrower @ StendarError::UnauthorizedPayment
    )]
    pub borrower: Signer<'info>,
    #[account(
        mut,
        constraint = borrower_collateral_ata.owner == borrower.key() @ StendarError::UnauthorizedPayment
    )]
    pub borrower_collateral_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = contract_collateral_ata.key() == contract.collateral_token_account @ StendarError::TokenAccountMismatch
    )]
    pub contract_collateral_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelContract<'info> {
    #[account(
        mut,
        seeds = [b"debt_contract", contract.borrower.as_ref(), &contract.contract_seed.to_le_bytes()],
        bump
    )]
    pub contract: Account<'info, DebtContract>,
    /// CHECK: Optional operations fund PDA; validated via seeds in handler.
    #[account(
        mut,
        seeds = [OPERATIONS_FUND_SEED, contract.key().as_ref()],
        bump
    )]
    pub operations_fund: Option<AccountInfo<'info>>,
    #[account(
        mut,
        constraint = borrower.key() == contract.borrower @ StendarError::UnauthorizedCancellation
    )]
    pub borrower: Signer<'info>,
    /// Contract collateral ATA used for cancellation collateral returns.
    #[account(mut)]
    pub contract_collateral_ata: Option<Account<'info, TokenAccount>>,
    /// Borrower collateral ATA used when returning non-wSOL collateral.
    #[account(mut)]
    pub borrower_collateral_ata: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExpireContract<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    /// CHECK: Optional operations fund PDA; validated via seeds in handler.
    #[account(
        mut,
        seeds = [OPERATIONS_FUND_SEED, contract.key().as_ref()],
        bump
    )]
    pub operations_fund: Option<AccountInfo<'info>>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    /// CHECK: Borrower receives disbursement/refunds; validated against contract.
    #[account(
        mut,
        constraint = borrower.key() == contract.borrower @ StendarError::InvalidContractReference
    )]
    pub borrower: AccountInfo<'info>,
    #[account(
        constraint = treasury.bot_authority == bot_authority.key() @ StendarError::UnauthorizedBotOperation
    )]
    pub bot_authority: Signer<'info>,
    /// Contract loan ATA used for partial-fill disbursement and lender refunds.
    #[account(mut)]
    pub contract_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Borrower loan ATA used for partial-fill disbursement.
    #[account(mut)]
    pub borrower_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Treasury loan ATA used for listing fee refunds.
    #[account(mut)]
    pub treasury_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Contract collateral ATA used for collateral refunds during cancellation path.
    #[account(mut)]
    pub contract_collateral_ata: Option<Account<'info, TokenAccount>>,
    /// Borrower collateral ATA used for non-native collateral refunds.
    #[account(mut)]
    pub borrower_collateral_ata: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseListing<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        constraint = borrower.key() == contract.borrower @ StendarError::UnauthorizedCancellation
    )]
    pub borrower: Signer<'info>,
    /// Contract loan ATA used for close-listing disbursement.
    #[account(mut)]
    pub contract_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Borrower loan ATA used for close-listing disbursement.
    #[account(mut)]
    pub borrower_usdc_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundLender<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        constraint = contribution.contract == contract.key() @ StendarError::InvalidContribution,
        constraint = contribution.lender == lender.key() @ StendarError::UnauthorizedClaim
    )]
    pub contribution: Account<'info, LenderContribution>,
    #[account(mut)]
    pub lender: Signer<'info>,
    /// Contract USDC ATA used for lender refunds.
    #[account(mut)]
    pub contract_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Lender USDC ATA used for lender refunds.
    #[account(mut)]
    pub lender_usdc_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
}

#[derive(Accounts)]
pub struct WithdrawContribution<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        close = lender,
        seeds = [b"contribution", contract.key().as_ref(), lender.key().as_ref()],
        bump,
        constraint = contribution.contract == contract.key() @ StendarError::InvalidContribution,
        constraint = contribution.lender == lender.key() @ StendarError::UnauthorizedClaim
    )]
    pub contribution: Account<'info, LenderContribution>,
    #[account(
        mut,
        close = lender,
        seeds = [b"escrow", contract.key().as_ref(), lender.key().as_ref()],
        bump,
        constraint = escrow.contract == contract.key() @ StendarError::InvalidContribution,
        constraint = escrow.lender == lender.key() @ StendarError::InvalidContribution
    )]
    pub escrow: Account<'info, LenderEscrow>,
    #[account(mut)]
    pub lender: Signer<'info>,
    /// Contract USDC ATA used for lender withdrawals.
    #[account(mut)]
    pub contract_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Lender USDC ATA used for lender withdrawals.
    #[account(mut)]
    pub lender_usdc_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BotRefundExpiredLender<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        constraint = contribution.contract == contract.key() @ StendarError::InvalidContribution,
        constraint = contribution.lender == lender.key() @ StendarError::InvalidContribution
    )]
    pub contribution: Account<'info, LenderContribution>,
    /// CHECK: Lender receives funds; must match contribution.lender.
    #[account(
        mut,
        constraint = lender.key() == contribution.lender @ StendarError::InvalidContribution
    )]
    pub lender: AccountInfo<'info>,
    #[account(
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.bot_authority == bot_authority.key() @ StendarError::UnauthorizedBotOperation
    )]
    pub treasury: Account<'info, Treasury>,
    pub bot_authority: Signer<'info>,
    /// Contract USDC ATA used for lender refunds.
    #[account(mut)]
    pub contract_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Lender USDC ATA used for lender refunds.
    #[account(mut)]
    pub lender_usdc_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
}

#[derive(Accounts)]
pub struct ClaimFromEscrow<'info> {
    #[account(
        mut,
        seeds = [b"debt_contract", contract.borrower.as_ref(), &contract.contract_seed.to_le_bytes()],
        bump
    )]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        seeds = [b"escrow", contract.key().as_ref(), lender.key().as_ref()],
        bump,
        constraint = escrow.contract == contract.key() @ StendarError::InvalidContribution,
        constraint = escrow.lender == lender.key() @ StendarError::UnauthorizedClaim
    )]
    pub escrow: Account<'info, LenderEscrow>,
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(mut)]
    pub escrow_usdc_account: Option<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub lender_usdc_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LiquidateContract<'info> {
    // Liquidations are bot-authority-gated in the current protocol version.
    #[account(
        mut,
        seeds = [b"debt_contract", contract.borrower.as_ref(), &contract.contract_seed.to_le_bytes()],
        bump
    )]
    pub contract: Box<Account<'info, DebtContract>>,
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
    pub state: Box<Account<'info, State>>,
    pub test_clock_offset: Option<Box<Account<'info, TestClockOffset>>>,
    /// CHECK: Borrower receives operations-fund refunds and closed ATA rent.
    #[account(
        mut,
        constraint = borrower.key() == contract.borrower @ StendarError::InvalidContractReference
    )]
    pub borrower: AccountInfo<'info>,
    #[account(mut)]
    pub liquidator: Signer<'info>,
    pub system_program: Program<'info, System>,

    // --- standard liquidation accounts ---
    pub collateral_registry: Option<Box<Account<'info, CollateralRegistry>>>,
    /// CHECK: Validated in instruction against the registry oracle feed.
    pub price_feed_account: Option<AccountInfo<'info>>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Option<Box<Account<'info, Treasury>>>,
    #[account(mut)]
    pub bot_usdc_ata: Option<Box<Account<'info, TokenAccount>>>,
    #[account(mut)]
    pub contract_usdc_ata: Option<Box<Account<'info, TokenAccount>>>,
    #[account(mut)]
    pub contract_collateral_ata: Option<Box<Account<'info, TokenAccount>>>,
    #[account(mut)]
    pub bot_collateral_ata: Option<Box<Account<'info, TokenAccount>>>,
    /// CHECK: Borrower's collateral ATA to receive excess collateral after liquidation.
    #[account(mut)]
    pub borrower_collateral_ata: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Option<Program<'info, Token>>,
}

#[derive(Accounts)]
pub struct PartialLiquidate<'info> {
    #[account(
        mut,
        seeds = [b"debt_contract", contract.borrower.as_ref(), &contract.contract_seed.to_le_bytes()],
        bump
    )]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    pub collateral_registry: Account<'info, CollateralRegistry>,
    /// CHECK: Validated against collateral registry in instruction.
    pub price_feed_account: AccountInfo<'info>,
    #[account(mut)]
    pub bot_usdc_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = contract_usdc_ata.key() == contract.loan_token_account @ StendarError::TokenAccountMismatch,
    )]
    pub contract_usdc_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = contract_collateral_ata.key() == contract.collateral_token_account @ StendarError::TokenAccountMismatch,
    )]
    pub contract_collateral_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub bot_collateral_ata: Account<'info, TokenAccount>,
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
    /// CHECK: Borrower relationship is validated against the contract.
    #[account(
        constraint = borrower.key() == contract.borrower @ StendarError::InvalidContractReference
    )]
    pub borrower: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestRecall<'info> {
    #[account(mut)]
    pub contract: Box<Account<'info, DebtContract>>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Box<Account<'info, State>>,
    /// The lender requesting recall.
    pub lender: Signer<'info>,
    #[account(
        mut,
        constraint = contribution.contract == contract.key() @ StendarError::InvalidContribution,
        constraint = contribution.lender == lender.key() @ StendarError::UnauthorizedClaim,
        constraint = !contribution.is_refunded @ StendarError::AlreadyRefunded,
    )]
    pub contribution: Box<Account<'info, LenderContribution>>,
}

#[derive(Accounts)]
pub struct BorrowerRepayRecall<'info> {
    #[account(mut)]
    pub contract: Box<Account<'info, DebtContract>>,
    #[account(
        mut,
        constraint = borrower.key() == contract.borrower @ StendarError::UnauthorizedPayment,
    )]
    pub borrower: Signer<'info>,
    #[account(
        mut,
        constraint = contribution.contract == contract.key() @ StendarError::InvalidContribution,
        constraint = !contribution.is_refunded @ StendarError::AlreadyRefunded,
    )]
    pub contribution: Box<Account<'info, LenderContribution>>,
    #[account(
        mut,
        constraint = escrow.contract == contract.key() @ StendarError::InvalidContribution,
    )]
    pub escrow: Box<Account<'info, LenderEscrow>>,
    #[account(
        mut,
        constraint = borrower_usdc_ata.owner == borrower.key() @ StendarError::UnauthorizedPayment,
        constraint = borrower_usdc_ata.mint == contract.loan_mint @ StendarError::TokenAccountMismatch,
    )]
    pub borrower_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = escrow_usdc_ata.owner == escrow.key() @ StendarError::TokenAccountMismatch,
        constraint = escrow_usdc_ata.mint == contract.loan_mint @ StendarError::TokenAccountMismatch,
    )]
    pub escrow_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = contract_collateral_ata.key() == contract.collateral_token_account @ StendarError::TokenAccountMismatch,
        constraint = contract_collateral_ata.mint == contract.collateral_mint @ StendarError::TokenAccountMismatch,
    )]
    pub contract_collateral_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = borrower_collateral_ata.owner == borrower.key() @ StendarError::UnauthorizedPayment,
        constraint = borrower_collateral_ata.mint == contract.collateral_mint @ StendarError::TokenAccountMismatch,
    )]
    pub borrower_collateral_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"global_state"],
        bump
    )]
    pub state: Box<Account<'info, State>>,
    pub test_clock_offset: Option<Box<Account<'info, TestClockOffset>>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProcessRecall<'info> {
    #[account(mut)]
    pub contract: Box<Account<'info, DebtContract>>,
    pub bot_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
    )]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        mut,
        constraint = contribution.contract == contract.key() @ StendarError::InvalidContribution,
        constraint = !contribution.is_refunded @ StendarError::AlreadyRefunded,
    )]
    pub contribution: Box<Account<'info, LenderContribution>>,
    #[account(
        mut,
        constraint = escrow.contract == contract.key() @ StendarError::InvalidContribution,
    )]
    pub escrow: Box<Account<'info, LenderEscrow>>,
    #[account(
        mut,
        constraint = bot_usdc_ata.owner == bot_authority.key() @ StendarError::UnauthorizedBotOperation,
        constraint = bot_usdc_ata.mint == contract.loan_mint @ StendarError::TokenAccountMismatch,
    )]
    pub bot_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = escrow_usdc_ata.owner == escrow.key() @ StendarError::TokenAccountMismatch,
        constraint = escrow_usdc_ata.mint == contract.loan_mint @ StendarError::TokenAccountMismatch,
    )]
    pub escrow_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = treasury.treasury_usdc_account == Pubkey::default() || treasury_usdc_ata.key() == treasury.treasury_usdc_account @ StendarError::TokenAccountMismatch,
        constraint = treasury_usdc_ata.mint == contract.loan_mint @ StendarError::TokenAccountMismatch,
    )]
    pub treasury_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = contract_collateral_ata.key() == contract.collateral_token_account @ StendarError::TokenAccountMismatch,
        constraint = contract_collateral_ata.mint == contract.collateral_mint @ StendarError::TokenAccountMismatch,
    )]
    pub contract_collateral_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = bot_collateral_ata.owner == bot_authority.key() @ StendarError::UnauthorizedBotOperation,
        constraint = bot_collateral_ata.mint == contract.collateral_mint @ StendarError::TokenAccountMismatch,
    )]
    pub bot_collateral_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: Borrower reference validation for contract consistency.
    #[account(
        constraint = borrower.key() == contract.borrower @ StendarError::InvalidContractReference,
    )]
    pub borrower: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"global_state"],
        bump
    )]
    pub state: Box<Account<'info, State>>,
    pub test_clock_offset: Option<Box<Account<'info, TestClockOffset>>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateContractState<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.bot_authority == processor.key() @ StendarError::UnauthorizedBotOperation
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    pub processor: Signer<'info>,
}

#[derive(Accounts)]
pub struct DistributeToEscrows<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.bot_authority == processor.key() @ StendarError::UnauthorizedBotOperation
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    pub processor: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateLenderEscrow<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        seeds = [b"contribution", contract.key().as_ref(), contribution.lender.as_ref()],
        bump,
        constraint = contribution.contract == contract.key() @ StendarError::InvalidContribution
    )]
    pub contribution: Account<'info, LenderContribution>,
    #[account(
        mut,
        constraint = escrow.contract == contract.key() @ StendarError::InvalidContribution,
        constraint = escrow.lender == contribution.lender @ StendarError::UnauthorizedClaim
    )]
    pub escrow: Account<'info, LenderEscrow>,
    #[account(
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.bot_authority == processor.key() @ StendarError::UnauthorizedBotOperation
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    pub processor: Signer<'info>,
}

// Unused contexts kept for layout compatibility.
#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(mut)]
    /// CHECK: This is the borrower's collateral account
    pub collateral_account: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CollectInterest<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(mut)]
    pub contribution: Account<'info, LenderContribution>,
    #[account(mut)]
    pub escrow: Account<'info, LenderEscrow>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawLenderFunds<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(mut)]
    pub contribution: Account<'info, LenderContribution>,
    #[account(mut)]
    pub escrow: Account<'info, LenderEscrow>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DistributeLiquidationProceeds<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ForceLiquidateContract<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub state: Account<'info, State>,
    pub system_program: Program<'info, System>,
}
