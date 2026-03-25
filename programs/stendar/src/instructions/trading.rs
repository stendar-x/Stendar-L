use crate::contexts::*;
use crate::errors::StendarError;
use crate::state::{
    ContractStatus, DebtContract, LenderContribution, LenderEscrow, TradeEvent, TradeListing,
    TradeType, Treasury, CURRENT_ACCOUNT_VERSION, LENDER_CONTRIBUTION_RESERVED_BYTES,
    LENDER_ESCROW_RESERVED_BYTES, MIN_LISTING_AMOUNT,
};
use crate::utils::{require_current_version, safe_u128_to_u64, validate_trade_conditions};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

const MAX_TRADE_LISTING_DURATION_SECONDS: i64 = 7 * 24 * 60 * 60;

pub fn calculate_trade_fee_usdc(sale_price: u64) -> u64 {
    crate::utils::calculate_secondary_market_fee_usdc(sale_price)
}

fn load_accept_trade_contract(ctx: &Context<AcceptTradeOffer>) -> Result<DebtContract> {
    let contract_info = ctx
        .remaining_accounts
        .first()
        .ok_or(StendarError::InvalidContractReference)?;
    require!(
        contract_info.key == &ctx.accounts.listing.contract,
        StendarError::InvalidContractReference
    );
    require!(
        contract_info.owner == &crate::ID,
        StendarError::InvalidContractReference
    );

    let contract_data = contract_info.try_borrow_data()?;
    let mut contract_bytes: &[u8] = &contract_data;
    let contract = DebtContract::try_deserialize(&mut contract_bytes)?;
    require_current_version(contract.account_version)?;
    require!(
        contract.status == ContractStatus::Active,
        StendarError::ContractNotActive
    );

    Ok(contract)
}

pub fn create_trade_listing(
    ctx: Context<CreateTradeListing>,
    listing_amount: u64,
    asking_price: u64,
    expires_at: i64,
    nonce: u8,
) -> Result<()> {
    let listing = &mut ctx.accounts.listing;
    let contribution = &ctx.accounts.contribution;
    let contract = &ctx.accounts.contract;
    require_current_version(contribution.account_version)?;
    require_current_version(contract.account_version)?;
    require!(
        !contract.has_active_proposal(),
        StendarError::ProposalAlreadyActive
    );
    let current_time = Clock::get()?.unix_timestamp;

    if !validate_trade_conditions(contract, contribution, current_time)? {
        return Err(StendarError::PositionNotTradeable.into());
    }

    validate_listing_parameters(listing_amount, asking_price, contribution, contract)?;
    require!(
        listing_amount == contribution.contribution_amount,
        StendarError::InvalidTradeAmount
    );

    require!(expires_at > current_time, StendarError::TradeOfferExpired);
    require!(
        expires_at <= current_time.saturating_add(MAX_TRADE_LISTING_DURATION_SECONDS),
        StendarError::InvalidTradePrice
    );

    listing.contract = contract.key();
    listing.seller = ctx.accounts.seller.key();
    listing.contribution = contribution.key();
    listing.listing_amount = listing_amount;
    listing.asking_price = asking_price;
    listing.listing_type = crate::state::ListingType::FullPosition;
    listing.created_at = current_time;
    listing.expires_at = expires_at;
    listing.is_active = true;
    listing.offer_count = 0;
    listing.highest_offer = 0;
    listing.nonce = nonce;

    msg!(
        "Trade listing created: {} amount for {} price",
        listing_amount,
        asking_price
    );

    Ok(())
}

pub fn create_trade_offer(
    ctx: Context<CreateTradeOffer>,
    purchase_amount: u64,
    offered_price: u64,
    expires_at: i64,
    nonce: u8,
) -> Result<()> {
    let offer = &mut ctx.accounts.offer;
    let listing = &mut ctx.accounts.listing;
    let current_time = Clock::get()?.unix_timestamp;

    validate_offer_parameters(
        listing,
        purchase_amount,
        offered_price,
        expires_at,
        current_time,
    )?;
    require!(
        purchase_amount == listing.listing_amount,
        StendarError::InvalidTradeAmount
    );

    offer.listing = listing.key();
    offer.buyer = ctx.accounts.buyer.key();
    offer.purchase_amount = purchase_amount;
    offer.offered_price = offered_price;
    offer.created_at = current_time;
    offer.expires_at = expires_at;
    offer.is_active = true;
    offer.nonce = nonce;

    update_listing_statistics(listing, offered_price);

    msg!(
        "Trade offer created: {} amount for {} price",
        purchase_amount,
        offered_price
    );

    Ok(())
}

pub fn accept_trade_offer(ctx: Context<AcceptTradeOffer>, nonce: u8) -> Result<()> {
    let contract = load_accept_trade_contract(&ctx)?;
    require_current_version(ctx.accounts.contribution.account_version)?;
    require_current_version(ctx.accounts.seller_escrow.account_version)?;
    require_current_version(ctx.accounts.treasury.account_version)?;
    require!(
        !contract.has_active_proposal(),
        StendarError::ProposalAlreadyActive
    );
    let listing = &mut ctx.accounts.listing;
    let offer = &mut ctx.accounts.offer;
    let current_time = Clock::get()?.unix_timestamp;

    if !listing.is_valid(current_time) {
        return Err(StendarError::TradeListingExpired.into());
    }

    if !offer.is_valid(current_time) {
        return Err(StendarError::TradeOfferExpired.into());
    }

    require!(
        offer.purchase_amount == listing.listing_amount,
        StendarError::InvalidTradeAmount
    );

    execute_position_transfer(
        &mut ctx.accounts.contribution,
        &mut ctx.accounts.seller_escrow,
        &mut ctx.accounts.buyer_contribution,
        &mut ctx.accounts.buyer_escrow,
        &mut ctx.accounts.treasury,
        &mut ctx.accounts.trade_event,
        ctx.accounts.seller.key(),
        ctx.accounts.buyer.key(),
        offer.purchase_amount,
        offer.offered_price,
        TradeType::AcceptedOffer,
        current_time,
        nonce,
    )?;

    let payment_accounts = TradePaymentAccounts {
        buyer_info: ctx.accounts.buyer.to_account_info(),
        seller_info: ctx.accounts.seller.to_account_info(),
        treasury_info: ctx.accounts.treasury.to_account_info(),
        buyer_usdc: ctx.accounts.buyer_usdc_account.as_ref().map(|a| a.clone()),
        seller_usdc: ctx.accounts.seller_usdc_account.as_ref().map(|a| a.clone()),
        treasury_usdc: ctx.accounts.treasury_usdc_account.as_ref().map(|a| a.clone()),
        token_program: ctx.accounts.token_program.as_ref().map(|p| p.clone()),
    };
    handle_payment_transfer(
        &payment_accounts,
        &mut ctx.accounts.treasury,
        offer.offered_price,
    )?;

    listing.is_active = false;
    offer.is_active = false;

    msg!(
        "Trade offer accepted: {} transferred for {}",
        offer.purchase_amount,
        offer.offered_price
    );

    Ok(())
}

pub fn cancel_trade_listing(ctx: Context<CancelTradeListing>) -> Result<()> {
    let listing = &mut ctx.accounts.listing;
    listing.is_active = false;

    msg!("Trade listing cancelled by seller");
    Ok(())
}

pub fn expire_trade_listing(ctx: Context<ExpireTradeListing>) -> Result<()> {
    require_current_version(ctx.accounts.treasury.account_version)?;
    let listing = &mut ctx.accounts.listing;
    let current_time = Clock::get()?.unix_timestamp;
    require!(listing.is_active, StendarError::InactiveListing);
    require!(
        listing.expires_at > 0 && current_time >= listing.expires_at,
        StendarError::ListingNotExpired
    );
    listing.is_active = false;
    msg!("Trade listing expired by bot");
    Ok(())
}

pub fn close_trade_event(_ctx: Context<CloseTradeEvent>) -> Result<()> {
    // No-op: `close = seller` in the context handles rent reclamation.
    Ok(())
}

pub fn transfer_lender_position(
    ctx: Context<TransferLenderPosition>,
    transfer_amount: u64,
    sale_price: u64,
    nonce: u8,
) -> Result<()> {
    let current_time = Clock::get()?.unix_timestamp;
    require_current_version(ctx.accounts.contract.account_version)?;
    require_current_version(ctx.accounts.contribution.account_version)?;
    require_current_version(ctx.accounts.seller_escrow.account_version)?;
    require_current_version(ctx.accounts.treasury.account_version)?;

    if !validate_trade_conditions(
        &ctx.accounts.contract,
        &ctx.accounts.contribution,
        current_time,
    )? {
        return Err(StendarError::PositionNotTradeable.into());
    }

    require!(
        transfer_amount == ctx.accounts.contribution.contribution_amount,
        StendarError::InvalidTradeAmount
    );

    execute_position_transfer(
        &mut ctx.accounts.contribution,
        &mut ctx.accounts.seller_escrow,
        &mut ctx.accounts.buyer_contribution,
        &mut ctx.accounts.buyer_escrow,
        &mut ctx.accounts.treasury,
        &mut ctx.accounts.transfer_event,
        ctx.accounts.seller.key(),
        ctx.accounts.buyer.key(),
        transfer_amount,
        sale_price,
        TradeType::DirectSale,
        current_time,
        nonce,
    )?;
    let payment_accounts = TradePaymentAccounts {
        buyer_info: ctx.accounts.buyer.to_account_info(),
        seller_info: ctx.accounts.seller.to_account_info(),
        treasury_info: ctx.accounts.treasury.to_account_info(),
        buyer_usdc: ctx.accounts.buyer_usdc_account.as_ref().map(|a| a.clone()),
        seller_usdc: ctx.accounts.seller_usdc_account.as_ref().map(|a| a.clone()),
        treasury_usdc: ctx.accounts.treasury_usdc_account.as_ref().map(|a| a.clone()),
        token_program: ctx.accounts.token_program.as_ref().map(|p| p.clone()),
    };
    handle_payment_transfer(
        &payment_accounts,
        &mut ctx.accounts.treasury,
        sale_price,
    )?;

    msg!(
        "Direct position transfer: {} for {}",
        transfer_amount,
        sale_price
    );

    Ok(())
}

pub fn execute_position_transfer(
    seller_contribution: &mut Account<LenderContribution>,
    seller_escrow: &mut Account<LenderEscrow>,
    buyer_contribution: &mut Account<LenderContribution>,
    buyer_escrow: &mut Account<LenderEscrow>,
    _treasury: &mut Account<Treasury>,
    trade_event: &mut Account<TradeEvent>,
    seller_key: Pubkey,
    buyer_key: Pubkey,
    transfer_amount: u64,
    sale_price: u64,
    trade_type: TradeType,
    current_time: i64,
    nonce: u8,
) -> Result<()> {
    require!(transfer_amount > 0, StendarError::InvalidTradeAmount);
    require!(
        transfer_amount <= seller_contribution.contribution_amount,
        StendarError::InvalidTradeAmount
    );

    let platform_fee = calculate_trade_fee_usdc(sale_price);
    require_current_version(seller_contribution.account_version)?;
    require_current_version(seller_escrow.account_version)?;

    buyer_contribution.lender = buyer_key;
    buyer_contribution.contract = seller_contribution.contract;
    buyer_contribution.contribution_amount = transfer_amount;
    buyer_contribution.total_interest_claimed = 0;
    buyer_contribution.total_principal_claimed = 0;
    buyer_contribution.last_claim_timestamp = 0;
    buyer_contribution.is_refunded = false;
    buyer_contribution.created_at = current_time;
    buyer_contribution._reserved = [0u8; LENDER_CONTRIBUTION_RESERVED_BYTES];
    buyer_contribution.account_version = CURRENT_ACCOUNT_VERSION;

    let seller_total = seller_contribution.contribution_amount;
    let transfer_ratio = (transfer_amount as u128)
        .checked_mul(1_000_000)
        .and_then(|value| value.checked_div(seller_total as u128))
        .ok_or(StendarError::ArithmeticOverflow)?;

    let escrow_transfer = safe_u128_to_u64(
        (seller_escrow.escrow_amount as u128)
            .checked_mul(transfer_ratio)
            .and_then(|v| v.checked_div(1_000_000))
            .ok_or(StendarError::ArithmeticOverflow)?,
    )?;
    let interest_transfer = safe_u128_to_u64(
        (seller_escrow.available_interest as u128)
            .checked_mul(transfer_ratio)
            .and_then(|v| v.checked_div(1_000_000))
            .ok_or(StendarError::ArithmeticOverflow)?,
    )?;
    let principal_transfer = safe_u128_to_u64(
        (seller_escrow.available_principal as u128)
            .checked_mul(transfer_ratio)
            .and_then(|v| v.checked_div(1_000_000))
            .ok_or(StendarError::ArithmeticOverflow)?,
    )?;

    buyer_escrow.lender = buyer_key;
    buyer_escrow.contract = seller_contribution.contract;
    buyer_escrow.escrow_amount = escrow_transfer;
    buyer_escrow.available_interest = interest_transfer;
    buyer_escrow.available_principal = principal_transfer;
    buyer_escrow.total_claimed = 0;
    buyer_escrow.is_released = false;
    buyer_escrow.created_at = current_time;
    buyer_escrow._reserved = [0u8; LENDER_ESCROW_RESERVED_BYTES];
    buyer_escrow.account_version = CURRENT_ACCOUNT_VERSION;

    seller_escrow.escrow_amount = seller_escrow
        .escrow_amount
        .checked_sub(escrow_transfer)
        .ok_or(StendarError::ArithmeticOverflow)?;
    seller_escrow.available_interest = seller_escrow
        .available_interest
        .checked_sub(interest_transfer)
        .ok_or(StendarError::ArithmeticOverflow)?;
    seller_escrow.available_principal = seller_escrow
        .available_principal
        .checked_sub(principal_transfer)
        .ok_or(StendarError::ArithmeticOverflow)?;

    seller_contribution.contribution_amount = seller_contribution
        .contribution_amount
        .checked_sub(transfer_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;

    trade_event.contract = seller_contribution.contract;
    trade_event.contribution = seller_contribution.key();
    trade_event.seller = seller_key;
    trade_event.buyer = buyer_key;
    trade_event.amount_traded = transfer_amount;
    trade_event.sale_price = sale_price;
    trade_event.platform_fee = platform_fee;
    trade_event.trade_type = trade_type;
    trade_event.timestamp = current_time;
    trade_event.nonce = nonce;

    Ok(())
}

pub struct TradePaymentAccounts<'info> {
    pub buyer_info: AccountInfo<'info>,
    pub seller_info: AccountInfo<'info>,
    pub treasury_info: AccountInfo<'info>,
    pub buyer_usdc: Option<Account<'info, TokenAccount>>,
    pub seller_usdc: Option<Account<'info, TokenAccount>>,
    pub treasury_usdc: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
}

pub fn handle_payment_transfer<'info>(
    accounts: &TradePaymentAccounts<'info>,
    treasury: &mut Account<'info, Treasury>,
    sale_price: u64,
) -> Result<()> {
    let platform_fee = calculate_trade_fee_usdc(sale_price);
    let seller_payment = sale_price.saturating_sub(platform_fee);

    let buyer_usdc = accounts
        .buyer_usdc
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let seller_usdc = accounts
        .seller_usdc
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let token_program = accounts
        .token_program
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;

    token::transfer(
        CpiContext::new(
            token_program.to_account_info(),
            Transfer {
                from: buyer_usdc.to_account_info(),
                to: seller_usdc.to_account_info(),
                authority: accounts.buyer_info.clone(),
            },
        ),
        seller_payment,
    )?;

    if platform_fee > 0 {
        let treasury_usdc = accounts
            .treasury_usdc
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        require!(
            treasury_usdc.key() == treasury.treasury_usdc_account,
            StendarError::TokenAccountMismatch
        );
        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: buyer_usdc.to_account_info(),
                    to: treasury_usdc.to_account_info(),
                    authority: accounts.buyer_info.clone(),
                },
            ),
            platform_fee,
        )?;
    }

    treasury.fees_collected = treasury
        .fees_collected
        .checked_add(platform_fee)
        .ok_or(StendarError::ArithmeticOverflow)?;

    Ok(())
}

pub fn validate_listing_parameters(
    listing_amount: u64,
    asking_price: u64,
    contribution: &LenderContribution,
    contract: &DebtContract,
) -> Result<()> {
    if listing_amount != contribution.contribution_amount {
        return Err(StendarError::InvalidTradeAmount.into());
    }

    if listing_amount < MIN_LISTING_AMOUNT {
        return Err(StendarError::ListingAmountTooSmall.into());
    }

    if asking_price == 0 {
        return Err(StendarError::InvalidTradePrice.into());
    }

    if contract.status != ContractStatus::Active {
        return Err(StendarError::ContractNotActive.into());
    }

    Ok(())
}

pub fn validate_offer_parameters(
    listing: &TradeListing,
    purchase_amount: u64,
    offered_price: u64,
    expires_at: i64,
    current_time: i64,
) -> Result<()> {
    if !listing.is_valid(current_time) {
        return Err(StendarError::TradeListingExpired.into());
    }

    if purchase_amount != listing.listing_amount {
        return Err(StendarError::InvalidTradeAmount.into());
    }

    if purchase_amount < MIN_LISTING_AMOUNT {
        return Err(StendarError::ListingAmountTooSmall.into());
    }

    if offered_price == 0 {
        return Err(StendarError::InvalidTradeAmount.into());
    }

    if expires_at <= current_time {
        return Err(StendarError::TradeOfferExpired.into());
    }

    Ok(())
}

pub fn update_listing_statistics(listing: &mut TradeListing, offered_price: u64) {
    listing.offer_count += 1;
    if offered_price > listing.highest_offer {
        listing.highest_offer = offered_price;
    }
}
