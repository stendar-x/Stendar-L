use crate::contexts::*;
use crate::errors::StendarError;
use crate::state::{
    ContractStatus, DebtContract, LenderContribution, LenderEscrow, ListingType, TradeEvent,
    TradeListing, TradeType, Treasury, CURRENT_ACCOUNT_VERSION, LENDER_CONTRIBUTION_RESERVED_BYTES,
    LENDER_ESCROW_RESERVED_BYTES, MIN_LISTING_AMOUNT,
};
use crate::utils::{
    calculate_fee_tenths_bps, require_current_version, safe_u128_to_u64, validate_trade_conditions,
    MAX_LENDERS_PER_TX,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

const MAX_TRADE_LISTING_DURATION_SECONDS: i64 = 7 * 24 * 60 * 60;
const STALE_TRADE_EVENT_SECONDS: i64 = 30 * 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TransferComputation {
    seller_remaining_contribution: u64,
    escrow_transfer: u64,
    interest_transfer: u64,
    principal_transfer: u64,
}

fn validate_min_remainder(total_amount: u64, transfer_amount: u64) -> Result<()> {
    require!(
        transfer_amount <= total_amount,
        StendarError::InvalidTradeAmount
    );
    let remainder = total_amount
        .checked_sub(transfer_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    if remainder > 0 {
        require!(
            remainder >= MIN_LISTING_AMOUNT,
            StendarError::InvalidTradeAmount
        );
    }
    Ok(())
}

fn ensure_trade_event_stale(event_timestamp: i64, current_time: i64) -> Result<()> {
    let stale_after = event_timestamp
        .checked_add(STALE_TRADE_EVENT_SECONDS)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(current_time >= stale_after, StendarError::ListingNotExpired);
    Ok(())
}

fn resolve_listing_type(listing_amount: u64, contribution_amount: u64) -> ListingType {
    if listing_amount < contribution_amount {
        ListingType::PartialPosition
    } else {
        ListingType::FullPosition
    }
}

fn resolve_trade_type(transfer_amount: u64, seller_total: u64, fallback: TradeType) -> TradeType {
    if transfer_amount < seller_total {
        TradeType::PartialFill
    } else {
        fallback
    }
}

fn enforce_partial_lender_cap(
    contract: &DebtContract,
    transfer_amount: u64,
    seller_total: u64,
) -> Result<()> {
    if transfer_amount >= seller_total {
        return Ok(());
    }

    let lender_cap = if contract.max_lenders == 0 {
        MAX_LENDERS_PER_TX
    } else {
        contract.max_lenders
    };

    require!(
        contract.num_contributions < lender_cap as u32,
        StendarError::MaxLendersReached
    );

    Ok(())
}

fn sync_contract_contributions_for_transfer(
    contract: &mut DebtContract,
    seller_contribution_key: Pubkey,
    buyer_contribution_key: Pubkey,
    seller_remaining_contribution: u64,
) -> Result<()> {
    if seller_remaining_contribution == 0 {
        let seller_index = contract
            .contributions
            .iter()
            .position(|key| *key == seller_contribution_key)
            .ok_or(StendarError::InvalidContribution)?;
        contract.contributions.swap_remove(seller_index);
    } else {
        require!(
            contract
                .contributions
                .iter()
                .any(|key| *key == seller_contribution_key),
            StendarError::InvalidContribution
        );
    }

    require!(
        !contract
            .contributions
            .iter()
            .any(|key| *key == buyer_contribution_key),
        StendarError::InvalidContribution
    );
    contract.contributions.push(buyer_contribution_key);
    contract.num_contributions = u32::try_from(contract.contributions.len())
        .map_err(|_| error!(StendarError::ArithmeticOverflow))?;
    Ok(())
}

fn compute_transfer_computation(
    seller_total: u64,
    transfer_amount: u64,
    seller_escrow_amount: u64,
    seller_available_interest: u64,
    seller_available_principal: u64,
) -> Result<TransferComputation> {
    require!(transfer_amount > 0, StendarError::InvalidTradeAmount);
    require!(seller_total > 0, StendarError::InvalidTradeAmount);
    require!(
        transfer_amount <= seller_total,
        StendarError::InvalidTradeAmount
    );

    let transfer_ratio = (transfer_amount as u128)
        .checked_mul(1_000_000)
        .and_then(|value| value.checked_div(seller_total as u128))
        .ok_or(StendarError::ArithmeticOverflow)?;

    let escrow_transfer = safe_u128_to_u64(
        (seller_escrow_amount as u128)
            .checked_mul(transfer_ratio)
            .and_then(|v| v.checked_div(1_000_000))
            .ok_or(StendarError::ArithmeticOverflow)?,
    )?;
    let interest_transfer = safe_u128_to_u64(
        (seller_available_interest as u128)
            .checked_mul(transfer_ratio)
            .and_then(|v| v.checked_div(1_000_000))
            .ok_or(StendarError::ArithmeticOverflow)?,
    )?;
    let principal_transfer = safe_u128_to_u64(
        (seller_available_principal as u128)
            .checked_mul(transfer_ratio)
            .and_then(|v| v.checked_div(1_000_000))
            .ok_or(StendarError::ArithmeticOverflow)?,
    )?;
    let seller_remaining_contribution = seller_total
        .checked_sub(transfer_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;

    Ok(TransferComputation {
        seller_remaining_contribution,
        escrow_transfer,
        interest_transfer,
        principal_transfer,
    })
}

pub fn create_trade_listing(
    ctx: Context<CreateTradeListing>,
    listing_amount: u64,
    asking_price: u64,
    expires_at: i64,
    nonce: u8,
) -> Result<()> {
    require_current_version(ctx.accounts.state.account_version)?;
    require!(!ctx.accounts.state.is_paused, StendarError::PlatformPaused);
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
        listing_amount <= contribution.contribution_amount,
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
    listing.listing_type = resolve_listing_type(listing_amount, contribution.contribution_amount);
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
    require_current_version(ctx.accounts.state.account_version)?;
    require!(!ctx.accounts.state.is_paused, StendarError::PlatformPaused);
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
    let contract = &mut ctx.accounts.contract;
    require_current_version(contract.account_version)?;
    require!(
        contract.status == ContractStatus::Active,
        StendarError::ContractNotActive
    );
    require_current_version(ctx.accounts.contribution.account_version)?;
    require_current_version(ctx.accounts.seller_escrow.account_version)?;
    require_current_version(ctx.accounts.treasury.account_version)?;
    require_current_version(ctx.accounts.state.account_version)?;
    require!(!ctx.accounts.state.is_paused, StendarError::PlatformPaused);
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
    let seller_total = ctx.accounts.contribution.contribution_amount;
    validate_min_remainder(seller_total, offer.purchase_amount)?;
    enforce_partial_lender_cap(contract, offer.purchase_amount, seller_total)?;
    let seller_fee = calculate_fee_tenths_bps(
        offer.offered_price,
        ctx.accounts.state.secondary_listing_fee_bps,
    )?;
    let buyer_fee = calculate_fee_tenths_bps(
        offer.offered_price,
        ctx.accounts.state.secondary_buyer_fee_bps,
    )?;

    execute_position_transfer(
        contract,
        &mut ctx.accounts.contribution,
        &mut ctx.accounts.seller_escrow,
        &mut ctx.accounts.buyer_contribution,
        &mut ctx.accounts.buyer_escrow,
        &mut ctx.accounts.trade_event,
        ctx.accounts.seller.key(),
        ctx.accounts.buyer.key(),
        offer.purchase_amount,
        offer.offered_price,
        seller_fee,
        buyer_fee,
        TradeType::AcceptedOffer,
        current_time,
        nonce,
    )?;

    let payment_accounts = TradePaymentAccounts {
        buyer_info: ctx.accounts.buyer.to_account_info(),
        _seller_info: ctx.accounts.seller.to_account_info(),
        _treasury_info: ctx.accounts.treasury.to_account_info(),
        buyer_usdc: ctx.accounts.buyer_usdc_account.as_ref().map(|a| a.clone()),
        seller_usdc: ctx.accounts.seller_usdc_account.as_ref().map(|a| a.clone()),
        treasury_usdc: ctx
            .accounts
            .treasury_usdc_account
            .as_ref()
            .map(|a| a.clone()),
        token_program: ctx.accounts.token_program.as_ref().map(|p| p.clone()),
    };
    handle_payment_transfer(
        &payment_accounts,
        &mut ctx.accounts.treasury,
        offer.offered_price,
        seller_fee,
        buyer_fee,
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

pub fn cancel_orphaned_trade_offer(ctx: Context<CancelOrphanedTradeOffer>) -> Result<()> {
    let listing_info = &ctx.accounts.listing;
    if listing_info.owner == &crate::ID {
        let listing_data = listing_info.try_borrow_data()?;
        let mut listing_slice: &[u8] = &listing_data;
        let listing = TradeListing::try_deserialize(&mut listing_slice)
            .map_err(|_| error!(StendarError::InvalidOffer))?;
        require!(!listing.is_active, StendarError::InvalidOffer);
    }

    ctx.accounts.offer.is_active = false;
    msg!("Orphaned trade offer cancelled by buyer");
    Ok(())
}

pub fn close_trade_event(_ctx: Context<CloseTradeEvent>) -> Result<()> {
    // No-op: `close = seller` in the context handles rent reclamation.
    Ok(())
}

pub fn bot_close_trade_event(ctx: Context<BotCloseTradeEvent>) -> Result<()> {
    require_current_version(ctx.accounts.treasury.account_version)?;
    require_current_version(ctx.accounts.state.account_version)?;
    require!(
        ctx.accounts.closer.key() == ctx.accounts.treasury.bot_authority
            || ctx.accounts.closer.key() == ctx.accounts.state.authority,
        StendarError::UnauthorizedBotOperation
    );
    let current_time = Clock::get()?.unix_timestamp;
    ensure_trade_event_stale(ctx.accounts.trade_event.timestamp, current_time)?;
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
    require_current_version(ctx.accounts.state.account_version)?;
    require!(!ctx.accounts.state.is_paused, StendarError::PlatformPaused);

    if !validate_trade_conditions(
        &ctx.accounts.contract,
        &ctx.accounts.contribution,
        current_time,
    )? {
        return Err(StendarError::PositionNotTradeable.into());
    }

    require!(
        transfer_amount <= ctx.accounts.contribution.contribution_amount,
        StendarError::InvalidTradeAmount
    );
    let seller_total = ctx.accounts.contribution.contribution_amount;
    validate_min_remainder(seller_total, transfer_amount)?;
    enforce_partial_lender_cap(&ctx.accounts.contract, transfer_amount, seller_total)?;
    let seller_fee =
        calculate_fee_tenths_bps(sale_price, ctx.accounts.state.secondary_listing_fee_bps)?;
    let buyer_fee =
        calculate_fee_tenths_bps(sale_price, ctx.accounts.state.secondary_buyer_fee_bps)?;

    execute_position_transfer(
        &mut ctx.accounts.contract,
        &mut ctx.accounts.contribution,
        &mut ctx.accounts.seller_escrow,
        &mut ctx.accounts.buyer_contribution,
        &mut ctx.accounts.buyer_escrow,
        &mut ctx.accounts.transfer_event,
        ctx.accounts.seller.key(),
        ctx.accounts.buyer.key(),
        transfer_amount,
        sale_price,
        seller_fee,
        buyer_fee,
        TradeType::DirectSale,
        current_time,
        nonce,
    )?;
    let payment_accounts = TradePaymentAccounts {
        buyer_info: ctx.accounts.buyer.to_account_info(),
        _seller_info: ctx.accounts.seller.to_account_info(),
        _treasury_info: ctx.accounts.treasury.to_account_info(),
        buyer_usdc: ctx.accounts.buyer_usdc_account.as_ref().map(|a| a.clone()),
        seller_usdc: ctx.accounts.seller_usdc_account.as_ref().map(|a| a.clone()),
        treasury_usdc: ctx
            .accounts
            .treasury_usdc_account
            .as_ref()
            .map(|a| a.clone()),
        token_program: ctx.accounts.token_program.as_ref().map(|p| p.clone()),
    };
    handle_payment_transfer(
        &payment_accounts,
        &mut ctx.accounts.treasury,
        sale_price,
        seller_fee,
        buyer_fee,
    )?;

    msg!(
        "Direct position transfer: {} for {}",
        transfer_amount,
        sale_price
    );

    Ok(())
}

pub fn execute_position_transfer(
    contract: &mut Account<DebtContract>,
    seller_contribution: &mut Account<LenderContribution>,
    seller_escrow: &mut Account<LenderEscrow>,
    buyer_contribution: &mut Account<LenderContribution>,
    buyer_escrow: &mut Account<LenderEscrow>,
    trade_event: &mut Account<TradeEvent>,
    seller_key: Pubkey,
    buyer_key: Pubkey,
    transfer_amount: u64,
    sale_price: u64,
    seller_fee: u64,
    buyer_fee: u64,
    trade_type: TradeType,
    current_time: i64,
    nonce: u8,
) -> Result<()> {
    require_current_version(contract.account_version)?;
    require_current_version(seller_contribution.account_version)?;
    require_current_version(seller_escrow.account_version)?;
    let seller_total = seller_contribution.contribution_amount;
    let computed = compute_transfer_computation(
        seller_total,
        transfer_amount,
        seller_escrow.escrow_amount,
        seller_escrow.available_interest,
        seller_escrow.available_principal,
    )?;
    let resolved_trade_type = resolve_trade_type(transfer_amount, seller_total, trade_type);

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

    buyer_escrow.lender = buyer_key;
    buyer_escrow.contract = seller_contribution.contract;
    buyer_escrow.escrow_amount = computed.escrow_transfer;
    buyer_escrow.available_interest = computed.interest_transfer;
    buyer_escrow.available_principal = computed.principal_transfer;
    buyer_escrow.total_claimed = 0;
    buyer_escrow.is_released = false;
    buyer_escrow.created_at = current_time;
    buyer_escrow._reserved = [0u8; LENDER_ESCROW_RESERVED_BYTES];
    buyer_escrow.account_version = CURRENT_ACCOUNT_VERSION;

    seller_escrow.escrow_amount = seller_escrow
        .escrow_amount
        .checked_sub(computed.escrow_transfer)
        .ok_or(StendarError::ArithmeticOverflow)?;
    seller_escrow.available_interest = seller_escrow
        .available_interest
        .checked_sub(computed.interest_transfer)
        .ok_or(StendarError::ArithmeticOverflow)?;
    seller_escrow.available_principal = seller_escrow
        .available_principal
        .checked_sub(computed.principal_transfer)
        .ok_or(StendarError::ArithmeticOverflow)?;

    seller_contribution.contribution_amount = computed.seller_remaining_contribution;
    sync_contract_contributions_for_transfer(
        contract,
        seller_contribution.key(),
        buyer_contribution.key(),
        computed.seller_remaining_contribution,
    )?;

    trade_event.contract = seller_contribution.contract;
    trade_event.contribution = seller_contribution.key();
    trade_event.seller = seller_key;
    trade_event.buyer = buyer_key;
    trade_event.amount_traded = transfer_amount;
    trade_event.sale_price = sale_price;
    trade_event.platform_fee = seller_fee;
    trade_event.buyer_fee = buyer_fee;
    trade_event.trade_type = resolved_trade_type;
    trade_event.timestamp = current_time;
    trade_event.nonce = nonce;

    Ok(())
}

pub struct TradePaymentAccounts<'info> {
    pub buyer_info: AccountInfo<'info>,
    pub _seller_info: AccountInfo<'info>,
    pub _treasury_info: AccountInfo<'info>,
    pub buyer_usdc: Option<Account<'info, TokenAccount>>,
    pub seller_usdc: Option<Account<'info, TokenAccount>>,
    pub treasury_usdc: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
}

pub fn handle_payment_transfer<'info>(
    accounts: &TradePaymentAccounts<'info>,
    treasury: &mut Account<'info, Treasury>,
    sale_price: u64,
    seller_fee: u64,
    buyer_fee: u64,
) -> Result<()> {
    let seller_payment = sale_price
        .checked_sub(seller_fee)
        .ok_or(StendarError::ArithmeticOverflow)?;
    let total_protocol_fee = seller_fee
        .checked_add(buyer_fee)
        .ok_or(StendarError::ArithmeticOverflow)?;

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

    if total_protocol_fee > 0 {
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
            total_protocol_fee,
        )?;
    }

    treasury.fees_collected = treasury
        .fees_collected
        .checked_add(total_protocol_fee)
        .ok_or(StendarError::ArithmeticOverflow)?;

    Ok(())
}

pub fn validate_listing_parameters(
    listing_amount: u64,
    asking_price: u64,
    contribution: &LenderContribution,
    contract: &DebtContract,
) -> Result<()> {
    if listing_amount > contribution.contribution_amount {
        return Err(StendarError::InvalidTradeAmount.into());
    }

    if listing_amount < MIN_LISTING_AMOUNT {
        return Err(StendarError::ListingAmountTooSmall.into());
    }
    validate_min_remainder(contribution.contribution_amount, listing_amount)?;

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
    if expires_at > current_time.saturating_add(MAX_TRADE_LISTING_DURATION_SECONDS) {
        return Err(StendarError::InvalidTradePrice.into());
    }

    Ok(())
}

pub fn update_listing_statistics(listing: &mut TradeListing, offered_price: u64) {
    listing.offer_count = listing.offer_count.saturating_add(1);
    if offered_price > listing.highest_offer {
        listing.highest_offer = offered_price;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        DebtContract, InterestPaymentType, LenderContribution, LoanType, PaymentFrequency,
        PrincipalPaymentType, DEBT_CONTRACT_RESERVED_BYTES, LENDER_CONTRIBUTION_RESERVED_BYTES,
    };
    use anchor_lang::prelude::Pubkey;

    fn sample_contract() -> DebtContract {
        DebtContract {
            borrower: Pubkey::new_unique(),
            contract_seed: 1,
            target_amount: 1_000_000_000,
            funded_amount: 1_000_000_000,
            interest_rate: 500,
            term_days: 365,
            collateral_amount: 2_000_000_000,
            loan_type: LoanType::Committed,
            ltv_ratio: 5000,
            interest_payment_type: InterestPaymentType::OutstandingBalance,
            principal_payment_type: PrincipalPaymentType::NoFixedPayment,
            interest_frequency: PaymentFrequency::Monthly,
            principal_frequency: None,
            created_at: 1_700_000_000,
            status: ContractStatus::Active,
            num_contributions: 1,
            outstanding_balance: 1_000_000_000,
            accrued_interest: 0,
            last_interest_update: 1_700_000_000,
            last_principal_payment: 0,
            total_principal_paid: 0,
            contributions: vec![],
            last_bot_update: 0,
            next_interest_payment_due: 0,
            next_principal_payment_due: 0,
            bot_operation_count: 0,
            max_lenders: 14,
            partial_funding_flag: 1,
            expires_at: 1_700_604_800,
            allow_partial_fill: false,
            min_partial_fill_bps: 0,
            listing_fee_paid: 0,
            contract_version: 1,
            collateral_mint: Pubkey::default(),
            collateral_token_account: Pubkey::default(),
            collateral_value_at_creation: 0,
            ltv_floor_bps: 0,
            loan_mint: Pubkey::default(),
            loan_token_account: Pubkey::default(),
            recall_requested: false,
            recall_requested_at: 0,
            recall_requested_by: Pubkey::default(),
            _reserved: [0u8; DEBT_CONTRACT_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        }
    }

    fn sample_contribution(amount: u64) -> LenderContribution {
        LenderContribution {
            lender: Pubkey::new_unique(),
            contract: Pubkey::new_unique(),
            contribution_amount: amount,
            total_interest_claimed: 0,
            total_principal_claimed: 0,
            last_claim_timestamp: 0,
            is_refunded: false,
            created_at: 1_700_000_000,
            last_contributed_at: 1_700_000_000,
            _reserved: [0u8; LENDER_CONTRIBUTION_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        }
    }

    fn sample_listing(current_time: i64) -> TradeListing {
        TradeListing {
            contract: Pubkey::new_unique(),
            seller: Pubkey::new_unique(),
            contribution: Pubkey::new_unique(),
            listing_amount: MIN_LISTING_AMOUNT,
            asking_price: 100_000,
            listing_type: ListingType::FullPosition,
            created_at: current_time,
            expires_at: current_time + 60,
            is_active: true,
            offer_count: 0,
            highest_offer: 0,
            nonce: 1,
        }
    }

    #[test]
    fn validate_listing_parameters_allows_partial_with_valid_remainder() {
        let mut contract = sample_contract();
        contract.max_lenders = 14;
        let contribution = sample_contribution(MIN_LISTING_AMOUNT * 3);

        let result = validate_listing_parameters(
            MIN_LISTING_AMOUNT * 2,
            600_000_000,
            &contribution,
            &contract,
        );

        assert!(result.is_ok());
    }

    #[test]
    fn validate_listing_parameters_rejects_partial_with_dust_remainder() {
        let contract = sample_contract();
        let contribution = sample_contribution(MIN_LISTING_AMOUNT + 1);

        let result =
            validate_listing_parameters(MIN_LISTING_AMOUNT, 600_000_000, &contribution, &contract);

        assert!(result.is_err());
        assert!(result
            .expect_err("expected dust remainder validation to fail")
            .to_string()
            .contains("Invalid trade amount"));
    }

    #[test]
    fn validate_offer_parameters_rejects_expiry_beyond_max_duration() {
        let current_time = 1_700_000_000;
        let listing = sample_listing(current_time);
        let invalid_expires_at = current_time + MAX_TRADE_LISTING_DURATION_SECONDS + 1;

        let result = validate_offer_parameters(
            &listing,
            listing.listing_amount,
            listing.asking_price,
            invalid_expires_at,
            current_time,
        );

        assert!(result.is_err());
        assert!(result
            .expect_err("expected max duration validation to fail")
            .to_string()
            .contains("Invalid trade price"));
    }

    #[test]
    fn ensure_trade_event_stale_requires_timeout() {
        let now = 1_700_000_000;
        let event_timestamp = now - STALE_TRADE_EVENT_SECONDS + 1;
        let result = ensure_trade_event_stale(event_timestamp, now);
        assert!(result.is_err());

        let stale_event_timestamp = now - STALE_TRADE_EVENT_SECONDS;
        assert!(ensure_trade_event_stale(stale_event_timestamp, now).is_ok());
    }

    #[test]
    fn resolve_listing_type_marks_partial_listings() {
        let listing_type = resolve_listing_type(500_000_000, 1_000_000_000);
        assert!(matches!(listing_type, ListingType::PartialPosition));

        let listing_type_full = resolve_listing_type(1_000_000_000, 1_000_000_000);
        assert!(matches!(listing_type_full, ListingType::FullPosition));
    }

    #[test]
    fn resolve_trade_type_marks_partial_fills() {
        let partial = resolve_trade_type(400_000_000, 1_000_000_000, TradeType::AcceptedOffer);
        assert!(matches!(partial, TradeType::PartialFill));

        let full = resolve_trade_type(1_000_000_000, 1_000_000_000, TradeType::AcceptedOffer);
        assert!(matches!(full, TradeType::AcceptedOffer));
    }

    #[test]
    fn enforce_partial_lender_cap_increments_for_partial_transfer() {
        let mut contract = sample_contract();
        contract.num_contributions = 3;
        contract.max_lenders = 14;

        let result = enforce_partial_lender_cap(&mut contract, 500_000_000, 1_000_000_000);
        assert!(result.is_ok());
        assert_eq!(contract.num_contributions, 3);
    }

    #[test]
    fn enforce_partial_lender_cap_rejects_when_cap_reached() {
        let mut contract = sample_contract();
        contract.num_contributions = 14;
        contract.max_lenders = 14;

        let result = enforce_partial_lender_cap(&mut contract, 500_000_000, 1_000_000_000);
        assert!(result.is_err());
        assert!(result
            .expect_err("expected lender cap check to fail")
            .to_string()
            .contains("Maximum number of lenders reached"));
    }

    #[test]
    fn enforce_partial_lender_cap_noop_for_full_transfer() {
        let mut contract = sample_contract();
        contract.num_contributions = 14;
        contract.max_lenders = 14;

        let result = enforce_partial_lender_cap(&mut contract, 1_000_000_000, 1_000_000_000);
        assert!(result.is_ok());
        assert_eq!(contract.num_contributions, 14);
    }

    #[test]
    fn compute_transfer_computation_reduces_seller_contribution_on_partial_trade() {
        let computed = compute_transfer_computation(
            1_000_000_000,
            600_000_000,
            300_000_000,
            90_000_000,
            60_000_000,
        )
        .expect("partial trade computation should succeed");

        assert_eq!(computed.seller_remaining_contribution, 400_000_000);
        assert_eq!(computed.escrow_transfer, 180_000_000);
        assert_eq!(computed.interest_transfer, 54_000_000);
        assert_eq!(computed.principal_transfer, 36_000_000);
    }

    #[test]
    fn sync_contract_contributions_swaps_full_transfer_participant() {
        let mut contract = sample_contract();
        let seller_contribution = Pubkey::new_unique();
        let existing_contribution = Pubkey::new_unique();
        let buyer_contribution = Pubkey::new_unique();
        contract.contributions = vec![seller_contribution, existing_contribution];
        contract.num_contributions = 2;

        sync_contract_contributions_for_transfer(
            &mut contract,
            seller_contribution,
            buyer_contribution,
            0,
        )
        .expect("full transfer should replace seller entry");

        assert!(!contract
            .contributions
            .iter()
            .any(|key| *key == seller_contribution));
        assert!(contract
            .contributions
            .iter()
            .any(|key| *key == buyer_contribution));
        assert_eq!(contract.contributions.len(), 2);
        assert_eq!(contract.num_contributions, 2);
    }

    #[test]
    fn sync_contract_contributions_adds_buyer_for_partial_transfer() {
        let mut contract = sample_contract();
        let seller_contribution = Pubkey::new_unique();
        let existing_contribution = Pubkey::new_unique();
        let buyer_contribution = Pubkey::new_unique();
        contract.contributions = vec![seller_contribution, existing_contribution];
        contract.num_contributions = 2;

        sync_contract_contributions_for_transfer(
            &mut contract,
            seller_contribution,
            buyer_contribution,
            10,
        )
        .expect("partial transfer should append buyer entry");

        assert!(contract
            .contributions
            .iter()
            .any(|key| *key == seller_contribution));
        assert!(contract
            .contributions
            .iter()
            .any(|key| *key == buyer_contribution));
        assert_eq!(contract.contributions.len(), 3);
        assert_eq!(contract.num_contributions, 3);
    }
}
