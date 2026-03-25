use crate::errors::StendarError;
use crate::state::{
    ContractStatus, DebtContract, LenderContribution, LenderEscrow, State, TradeEvent, TradeListing,
    TradeOffer, Treasury, TREASURY_SEED,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

#[derive(Accounts)]
#[instruction(listing_amount: u64, asking_price: u64, expires_at: i64, nonce: u8)]
pub struct CreateTradeListing<'info> {
    #[account(
        init,
        payer = seller,
        space = TradeListing::LEN,
        seeds = [b"listing", contribution.key().as_ref(), &[nonce]],
        bump
    )]
    pub listing: Account<'info, TradeListing>,
    #[account(
        constraint = contribution.lender == seller.key() @ StendarError::UnauthorizedListing
    )]
    pub contribution: Account<'info, LenderContribution>,
    #[account(
        constraint = contract.status == ContractStatus::Active @ StendarError::ContractNotActive,
        constraint = contribution.contract == contract.key() @ StendarError::InvalidContractReference
    )]
    pub contract: Account<'info, DebtContract>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub seller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(purchase_amount: u64, offered_price: u64, expires_at: i64, nonce: u8)]
pub struct CreateTradeOffer<'info> {
    #[account(
        init,
        payer = buyer,
        space = TradeOffer::LEN,
        seeds = [b"offer", listing.key().as_ref(), buyer.key().as_ref(), &[nonce]],
        bump
    )]
    pub offer: Account<'info, TradeOffer>,
    #[account(
        mut,
        constraint = listing.is_active @ StendarError::InactiveListing
    )]
    pub listing: Account<'info, TradeListing>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u8)]
pub struct AcceptTradeOffer<'info> {
    #[account(
        mut,
        constraint = listing.seller == seller.key() @ StendarError::UnauthorizedAcceptance,
        close = seller
    )]
    pub listing: Account<'info, TradeListing>,
    #[account(
        mut,
        constraint = offer.listing == listing.key() @ StendarError::InvalidOffer,
        constraint = offer.is_active @ StendarError::InactiveOffer,
        close = buyer
    )]
    pub offer: Account<'info, TradeOffer>,
    #[account(
        init,
        payer = seller,
        space = TradeEvent::LEN,
        seeds = [b"trade", listing.key().as_ref(), &[nonce]],
        bump
    )]
    pub trade_event: Account<'info, TradeEvent>,
    #[account(
        mut,
        constraint = contribution.lender == seller.key() @ StendarError::UnauthorizedTransfer,
        constraint = listing.contribution == contribution.key() @ StendarError::InvalidContractReference,
        constraint = listing.contract == contribution.contract @ StendarError::InvalidContractReference
    )]
    pub contribution: Account<'info, LenderContribution>,
    #[account(
        mut,
        constraint = seller_escrow.lender == seller.key() @ StendarError::UnauthorizedTransfer,
        constraint = seller_escrow.contract == contribution.contract @ StendarError::InvalidContractReference
    )]
    pub seller_escrow: Account<'info, LenderEscrow>,
    #[account(
        init,
        payer = buyer,
        space = LenderContribution::LEN,
        seeds = [b"contribution", contribution.contract.as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub buyer_contribution: Account<'info, LenderContribution>,
    #[account(
        init,
        payer = buyer,
        space = LenderEscrow::LEN,
        seeds = [b"escrow", contribution.contract.as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub buyer_escrow: Account<'info, LenderEscrow>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// Buyer's USDC ATA for contract trades.
    #[account(mut)]
    pub buyer_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Seller's USDC ATA for contract trades.
    #[account(mut)]
    pub seller_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Treasury's USDC ATA for contract trade fees; validated in handler.
    #[account(mut)]
    pub treasury_usdc_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelTradeListing<'info> {
    #[account(
        mut,
        constraint = listing.seller == seller.key() @ StendarError::UnauthorizedCancellation,
        close = seller
    )]
    pub listing: Account<'info, TradeListing>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub seller: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExpireTradeListing<'info> {
    #[account(
        mut,
        close = seller
    )]
    pub listing: Account<'info, TradeListing>,
    #[account(
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.bot_authority == bot_authority.key() @ StendarError::UnauthorizedBotOperation
    )]
    pub treasury: Account<'info, Treasury>,
    pub bot_authority: Signer<'info>,
    /// CHECK: Seller receives rent back when listing closes.
    #[account(
        mut,
        constraint = seller.key() == listing.seller @ StendarError::InvalidContractReference
    )]
    pub seller: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(transfer_amount: u64, sale_price: u64, nonce: u8)]
pub struct TransferLenderPosition<'info> {
    pub contract: Box<Account<'info, DebtContract>>,
    #[account(
        init,
        payer = seller,
        space = TradeEvent::LEN,
        seeds = [b"transfer", contribution.key().as_ref(), &[nonce]],
        bump
    )]
    pub transfer_event: Box<Account<'info, TradeEvent>>,
    #[account(
        mut,
        constraint = contribution.lender == seller.key() @ StendarError::UnauthorizedTransfer,
        constraint = contract.key() == contribution.contract @ StendarError::InvalidContractReference
    )]
    pub contribution: Box<Account<'info, LenderContribution>>,
    #[account(
        mut,
        constraint = seller_escrow.lender == seller.key() @ StendarError::UnauthorizedTransfer,
        constraint = seller_escrow.contract == contribution.contract @ StendarError::InvalidContractReference
    )]
    pub seller_escrow: Box<Account<'info, LenderEscrow>>,
    #[account(
        init,
        payer = buyer,
        space = LenderContribution::LEN,
        seeds = [b"contribution", contribution.contract.as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub buyer_contribution: Box<Account<'info, LenderContribution>>,
    #[account(
        init,
        payer = buyer,
        space = LenderEscrow::LEN,
        seeds = [b"escrow", contribution.contract.as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub buyer_escrow: Box<Account<'info, LenderEscrow>>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump
    )]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// Buyer's USDC ATA for contract trades.
    #[account(mut)]
    pub buyer_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Seller's USDC ATA for contract trades.
    #[account(mut)]
    pub seller_usdc_account: Option<Account<'info, TokenAccount>>,
    /// Treasury's USDC ATA for contract trade fees; validated in handler.
    #[account(mut)]
    pub treasury_usdc_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CalculatePositionValue<'info> {
    pub contribution: Account<'info, LenderContribution>,
    pub contract: Account<'info, DebtContract>,
}

#[derive(Accounts)]
pub struct CloseTradeEvent<'info> {
    #[account(
        mut,
        constraint = trade_event.seller == seller.key() @ StendarError::UnauthorizedClaim,
        close = seller
    )]
    pub trade_event: Account<'info, TradeEvent>,
    #[account(mut)]
    pub seller: Signer<'info>,
}
