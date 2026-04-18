#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

// Import modules
mod contexts;
mod errors;
mod instructions;
mod state;
mod utils;

// Re-export for external use
pub use contexts::*;
pub use errors::*;
pub use instructions::trading::{validate_listing_parameters, validate_offer_parameters};
pub use state::*;

declare_id!("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE");

#[cfg(all(feature = "testing", target_os = "solana"))]
compile_error!("The `testing` feature must not be enabled for on-chain builds.");

#[program]
pub mod stendar {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize_state(ctx)
    }

    pub fn initialize_treasury(
        ctx: Context<InitializeTreasury>,
        bot_authority: Pubkey,
        usdc_mint: Pubkey,
    ) -> Result<()> {
        instructions::initialize_treasury(ctx, bot_authority, usdc_mint)
    }

    pub fn propose_treasury_authority_transfer(
        ctx: Context<ProposeTreasuryAuthorityTransfer>,
    ) -> Result<()> {
        instructions::propose_treasury_authority_transfer(ctx)
    }

    pub fn accept_treasury_authority_transfer(
        ctx: Context<AcceptTreasuryAuthorityTransfer>,
    ) -> Result<()> {
        instructions::accept_treasury_authority_transfer(ctx)
    }

    pub fn update_bot_authority(ctx: Context<UpdateBotAuthority>) -> Result<()> {
        instructions::update_bot_authority(ctx)
    }

    pub fn toggle_pause(ctx: Context<TogglePause>) -> Result<()> {
        instructions::toggle_pause(ctx)
    }

    pub fn update_fee_rates(
        ctx: Context<UpdateFeeRates>,
        pool_deposit_fee_bps: Option<u16>,
        pool_yield_fee_bps: Option<u16>,
        primary_listing_fee_bps: Option<u16>,
        secondary_listing_fee_bps: Option<u16>,
        secondary_buyer_fee_bps: Option<u16>,
    ) -> Result<()> {
        instructions::update_fee_rates(
            ctx,
            pool_deposit_fee_bps,
            pool_yield_fee_bps,
            primary_listing_fee_bps,
            secondary_listing_fee_bps,
            secondary_buyer_fee_bps,
        )
    }

    pub fn initialize_collateral_registry(
        ctx: Context<InitializeCollateralRegistry>,
    ) -> Result<()> {
        instructions::initialize_collateral_registry(ctx)
    }

    pub fn add_collateral_type(
        ctx: Context<AddCollateralType>,
        oracle_price_feed: Pubkey,
        decimals: u8,
        liquidation_buffer_bps: u16,
        min_committed_floor_bps: u16,
    ) -> Result<()> {
        instructions::add_collateral_type(
            ctx,
            oracle_price_feed,
            decimals,
            liquidation_buffer_bps,
            min_committed_floor_bps,
        )
    }

    pub fn update_collateral_type(
        ctx: Context<UpdateCollateralType>,
        mint: Pubkey,
        new_oracle_price_feed: Option<Pubkey>,
        new_liquidation_buffer_bps: Option<u16>,
        new_min_committed_floor_bps: Option<u16>,
    ) -> Result<()> {
        instructions::update_collateral_type(
            ctx,
            mint,
            new_oracle_price_feed,
            new_liquidation_buffer_bps,
            new_min_committed_floor_bps,
        )
    }

    pub fn deactivate_collateral_type(
        ctx: Context<DeactivateCollateralType>,
        mint: Pubkey,
    ) -> Result<()> {
        instructions::deactivate_collateral_type(ctx, mint)
    }

    #[cfg(feature = "testing")]
    pub fn reset_collateral_registry(ctx: Context<DeactivateCollateralType>) -> Result<()> {
        instructions::reset_collateral_registry(ctx)
    }

    #[cfg(feature = "testing")]
    pub fn reset_treasury_usdc_mint(
        ctx: Context<ResetTreasuryUsdcMint>,
        usdc_mint: Pubkey,
    ) -> Result<()> {
        instructions::reset_treasury_usdc_mint(ctx, usdc_mint)
    }

    #[cfg(feature = "testing")]
    pub fn initialize_mock_oracle_price_feed(
        ctx: Context<InitializeMockOraclePriceFeed>,
        feed_seed: u64,
        price: i64,
        exponent: i32,
        publish_time: i64,
    ) -> Result<()> {
        instructions::initialize_mock_oracle_price_feed(
            ctx,
            feed_seed,
            price,
            exponent,
            publish_time,
        )
    }

    #[cfg(feature = "testing")]
    pub fn set_mock_oracle_price_feed(
        ctx: Context<SetMockOraclePriceFeed>,
        price: i64,
        exponent: i32,
        publish_time: i64,
    ) -> Result<()> {
        instructions::set_mock_oracle_price_feed(ctx, price, exponent, publish_time)
    }

    #[cfg(feature = "testing")]
    pub fn initialize_test_clock_offset(
        ctx: Context<InitializeTestClockOffset>,
        offset_seconds: i64,
    ) -> Result<()> {
        instructions::initialize_test_clock_offset(ctx, offset_seconds)
    }

    #[cfg(feature = "testing")]
    pub fn set_test_clock_offset(
        ctx: Context<SetTestClockOffset>,
        offset_seconds: i64,
    ) -> Result<()> {
        instructions::set_test_clock_offset(ctx, offset_seconds)
    }

    pub fn create_debt_contract(
        ctx: Context<CreateDebtContract>,
        contract_seed: u64,
        max_lenders: u16,
        target_amount: u64,
        interest_rate: u32,
        term_days: u32,
        collateral_amount: u64,
        loan_type: LoanType,
        ltv_ratio: u32,
        ltv_floor_bps: u32,
        interest_payment_type: InterestPaymentType,
        principal_payment_type: PrincipalPaymentType,
        interest_frequency: PaymentFrequency,
        principal_frequency: Option<PaymentFrequency>,
        partial_funding_enabled: bool,
        allow_partial_fill: bool,
        min_partial_fill_bps: u16,
        is_revolving: bool,
        standby_fee_rate: u32,
        distribution_method: DistributionMethod,
        funding_access_mode: FundingAccessMode,
    ) -> Result<()> {
        instructions::create_debt_contract(
            ctx,
            contract_seed,
            max_lenders,
            target_amount,
            interest_rate,
            term_days,
            collateral_amount,
            loan_type,
            ltv_ratio,
            ltv_floor_bps,
            interest_payment_type,
            principal_payment_type,
            interest_frequency,
            principal_frequency,
            partial_funding_enabled,
            allow_partial_fill,
            min_partial_fill_bps,
            is_revolving,
            standby_fee_rate,
            distribution_method,
            funding_access_mode,
        )
    }

    pub fn approve_funder(ctx: Context<ApproveFunder>) -> Result<()> {
        instructions::approve_funder(ctx)
    }

    pub fn revoke_funder(ctx: Context<RevokeFunder>) -> Result<()> {
        instructions::revoke_funder(ctx)
    }

    pub fn contribute_to_contract(ctx: Context<ContributeToContract>, amount: u64) -> Result<()> {
        instructions::contribute_to_contract(ctx, amount)
    }

    pub fn add_collateral(ctx: Context<AddCollateral>, amount: u64) -> Result<()> {
        instructions::add_collateral(ctx, amount)
    }

    pub fn draw_from_revolving<'info>(
        ctx: Context<'_, '_, 'info, 'info, DrawFromRevolving<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::draw_from_revolving(ctx, amount)
    }

    pub fn repay_revolving<'info>(
        ctx: Context<'_, '_, 'info, 'info, RepayRevolving<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::repay_revolving(ctx, amount)
    }

    pub fn close_revolving_facility(ctx: Context<CloseRevolvingFacility>) -> Result<()> {
        instructions::close_revolving_facility(ctx)
    }

    pub fn bot_close_matured_revolving(ctx: Context<BotCloseMaturedRevolving>) -> Result<()> {
        instructions::bot_close_matured_revolving(ctx)
    }

    pub fn sweep_contract_pool(ctx: Context<SweepContractPool>) -> Result<()> {
        instructions::sweep_contract_pool(ctx)
    }

    pub fn distribute_standby_fees<'info>(
        ctx: Context<'_, '_, 'info, 'info, DistributeStandbyFees<'info>>,
    ) -> Result<()> {
        instructions::distribute_standby_fees(ctx)
    }

    pub fn update_contract_state(ctx: Context<UpdateContractState>) -> Result<()> {
        instructions::update_contract_state(ctx)
    }

    pub fn distribute_to_escrows(ctx: Context<DistributeToEscrows>) -> Result<()> {
        instructions::distribute_to_escrows(ctx)
    }

    pub fn claim_from_escrow(ctx: Context<ClaimFromEscrow>) -> Result<()> {
        instructions::claim_from_escrow(ctx)
    }

    pub fn update_lender_escrow(ctx: Context<UpdateLenderEscrow>) -> Result<()> {
        instructions::update_lender_escrow(ctx)
    }

    pub fn cancel_contract(ctx: Context<CancelContract>) -> Result<()> {
        instructions::cancel_contract(ctx)
    }

    pub fn expire_contract(ctx: Context<ExpireContract>) -> Result<()> {
        instructions::expire_contract(ctx)
    }

    pub fn close_listing(ctx: Context<CloseListing>) -> Result<()> {
        instructions::close_listing(ctx)
    }

    pub fn refund_lender<'info>(
        ctx: Context<'_, '_, '_, 'info, RefundLender<'info>>,
    ) -> Result<()> {
        instructions::refund_lender(ctx)
    }

    pub fn withdraw_contribution<'info>(
        ctx: Context<'_, '_, '_, 'info, WithdrawContribution<'info>>,
    ) -> Result<()> {
        instructions::withdraw_contribution(ctx)
    }

    pub fn bot_refund_expired_lender<'info>(
        ctx: Context<'_, '_, '_, 'info, BotRefundExpiredLender<'info>>,
    ) -> Result<()> {
        instructions::bot_refund_expired_lender(ctx)
    }

    pub fn liquidate_contract<'info>(
        ctx: Context<'_, '_, '_, 'info, LiquidateContract<'info>>,
    ) -> Result<()> {
        instructions::liquidate_contract(ctx)
    }

    pub fn partial_liquidate<'info>(
        ctx: Context<'_, '_, 'info, 'info, PartialLiquidate<'info>>,
        repay_amount: u64,
    ) -> Result<()> {
        instructions::partial_liquidate(ctx, repay_amount)
    }

    pub fn request_recall(ctx: Context<RequestRecall>) -> Result<()> {
        instructions::request_recall(ctx)
    }

    pub fn borrower_repay_recall(ctx: Context<BorrowerRepayRecall>) -> Result<()> {
        instructions::borrower_repay_recall(ctx)
    }

    pub fn process_recall(ctx: Context<ProcessRecall>) -> Result<()> {
        instructions::process_recall(ctx)
    }

    pub fn make_payment(ctx: Context<MakePayment>, amount: u64) -> Result<()> {
        instructions::make_payment(ctx, amount)
    }

    pub fn make_payment_with_distribution<'info>(
        ctx: Context<'_, '_, '_, 'info, MakePaymentWithDistribution<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::make_payment_with_distribution(ctx, amount)
    }

    pub fn authorize_pool_operator(ctx: Context<AuthorizePoolOperator>) -> Result<()> {
        instructions::authorize_pool_operator(ctx)
    }

    pub fn revoke_pool_operator(ctx: Context<RevokePoolOperator>) -> Result<()> {
        instructions::revoke_pool_operator(ctx)
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
        instructions::create_pool(
            ctx,
            pool_seed,
            name,
            rate_bps,
            capacity,
            minimum_deposit,
            withdrawal_queue_enabled,
            allowed_loan_type,
            min_ltv_bps,
            max_term_days,
        )
    }

    pub fn update_pool_name(ctx: Context<UpdatePoolName>, name: [u8; 32]) -> Result<()> {
        instructions::update_pool_name(ctx, name)
    }

    pub fn update_operator_name(ctx: Context<UpdateOperatorName>, name: [u8; 32]) -> Result<()> {
        instructions::update_operator_name(ctx, name)
    }

    pub fn deposit_to_pool(ctx: Context<DepositToPool>, amount: u64) -> Result<()> {
        instructions::deposit_to_pool(ctx, amount)
    }

    pub fn withdraw_from_pool(ctx: Context<WithdrawFromPool>, amount: u64) -> Result<()> {
        instructions::withdraw_from_pool(ctx, amount)
    }

    pub fn request_pool_withdrawal(ctx: Context<RequestPoolWithdrawal>, amount: u64) -> Result<()> {
        instructions::request_pool_withdrawal(ctx, amount)
    }

    pub fn process_pool_withdrawal(ctx: Context<ProcessPoolWithdrawal>) -> Result<()> {
        instructions::process_pool_withdrawal(ctx)
    }

    pub fn operator_return_deposit(ctx: Context<OperatorReturnDeposit>) -> Result<()> {
        instructions::operator_return_deposit(ctx)
    }

    pub fn claim_pool_yield(ctx: Context<ClaimPoolYield>) -> Result<()> {
        instructions::claim_pool_yield(ctx)
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
        instructions::propose_pool_changes(
            ctx,
            rate_bps,
            capacity,
            minimum_deposit,
            allowed_loan_type,
            min_ltv_bps,
            max_term_days,
            withdrawal_queue_enabled,
        )
    }

    pub fn apply_pool_changes(ctx: Context<ApplyPoolChanges>) -> Result<()> {
        instructions::apply_pool_changes(ctx)
    }

    pub fn cancel_pool_changes(ctx: Context<CancelPoolChanges>) -> Result<()> {
        instructions::cancel_pool_changes(ctx)
    }

    pub fn pause_pool(ctx: Context<PausePool>) -> Result<()> {
        instructions::pause_pool(ctx)
    }

    pub fn resume_pool(ctx: Context<ResumePool>) -> Result<()> {
        instructions::resume_pool(ctx)
    }

    pub fn close_pool(ctx: Context<ClosePool>) -> Result<()> {
        instructions::close_pool(ctx)
    }

    pub fn expire_idle_pool(ctx: Context<ExpireIdlePool>) -> Result<()> {
        instructions::expire_idle_pool(ctx)
    }

    pub fn pool_deploy_to_contract(ctx: Context<PoolDeployToContract>, amount: u64) -> Result<()> {
        instructions::pool_deploy_to_contract(ctx, amount)
    }

    pub fn pool_claim_from_escrow(ctx: Context<PoolClaimFromEscrow>) -> Result<()> {
        instructions::pool_claim_from_escrow(ctx)
    }

    pub fn pool_request_recall(ctx: Context<PoolRequestRecall>) -> Result<()> {
        instructions::pool_request_recall(ctx)
    }

    pub fn create_term_proposal(
        ctx: Context<CreateTermProposal>,
        proposal_id: u64,
        proposed_interest_rate: u32,
        proposed_term_days: u32,
        proposed_interest_frequency: PaymentFrequency,
        proposed_principal_frequency: Option<PaymentFrequency>,
        proposed_interest_payment_type: InterestPaymentType,
        proposed_principal_payment_type: PrincipalPaymentType,
        proposed_ltv_ratio: u32,
        proposed_ltv_floor_bps: u32,
        recall_on_rejection: bool,
    ) -> Result<()> {
        instructions::create_term_proposal(
            ctx,
            proposal_id,
            proposed_interest_rate,
            proposed_term_days,
            proposed_interest_frequency,
            proposed_principal_frequency,
            proposed_interest_payment_type,
            proposed_principal_payment_type,
            proposed_ltv_ratio,
            proposed_ltv_floor_bps,
            recall_on_rejection,
        )
    }

    pub fn vote_on_proposal(
        ctx: Context<VoteOnProposal>,
        proposal_id: u64,
        vote_choice: VoteChoice,
        recall_on_rejection: bool,
    ) -> Result<()> {
        instructions::vote_on_proposal(ctx, proposal_id, vote_choice, recall_on_rejection)
    }

    pub fn cancel_term_proposal(ctx: Context<CancelTermProposal>, proposal_id: u64) -> Result<()> {
        instructions::cancel_term_proposal(ctx, proposal_id)
    }

    pub fn expire_term_proposal(ctx: Context<ExpireTermProposal>, proposal_id: u64) -> Result<()> {
        instructions::expire_term_proposal(ctx, proposal_id)
    }

    pub fn process_proposal_recall(
        ctx: Context<ProcessProposalRecall>,
        proposal_id: u64,
    ) -> Result<()> {
        instructions::process_proposal_recall(ctx, proposal_id)
    }

    pub fn close_proposal_accounts(
        ctx: Context<CloseProposalAccounts>,
        proposal_id: u64,
    ) -> Result<()> {
        instructions::close_proposal_accounts(ctx, proposal_id)
    }

    pub fn get_platform_stats(ctx: Context<GetPlatformStats>) -> Result<PlatformStats> {
        instructions::get_platform_stats(ctx)
    }

    pub fn automated_interest_transfer<'info>(
        ctx: Context<'_, '_, '_, 'info, AutomatedInterestTransfer<'info>>,
    ) -> Result<()> {
        instructions::automated_interest_transfer(ctx)
    }

    pub fn automated_principal_transfer<'info>(
        ctx: Context<'_, '_, '_, 'info, AutomatedPrincipalTransfer<'info>>,
    ) -> Result<()> {
        instructions::automated_principal_transfer(ctx)
    }

    pub fn withdraw_from_treasury(ctx: Context<WithdrawFromTreasury>, amount: u64) -> Result<()> {
        instructions::withdraw_from_treasury(ctx, amount)
    }

    // Trading instruction handlers for secondary market

    pub fn create_trade_listing(
        ctx: Context<CreateTradeListing>,
        listing_amount: u64,
        asking_price: u64,
        expires_at: i64,
        nonce: u8,
    ) -> Result<()> {
        instructions::create_trade_listing(ctx, listing_amount, asking_price, expires_at, nonce)
    }

    pub fn create_trade_offer(
        ctx: Context<CreateTradeOffer>,
        purchase_amount: u64,
        offered_price: u64,
        expires_at: i64,
        nonce: u8,
    ) -> Result<()> {
        instructions::create_trade_offer(ctx, purchase_amount, offered_price, expires_at, nonce)
    }

    pub fn accept_trade_offer(ctx: Context<AcceptTradeOffer>, nonce: u8) -> Result<()> {
        instructions::accept_trade_offer(ctx, nonce)
    }

    pub fn cancel_trade_listing(ctx: Context<CancelTradeListing>) -> Result<()> {
        instructions::cancel_trade_listing(ctx)
    }

    pub fn expire_trade_listing(ctx: Context<ExpireTradeListing>) -> Result<()> {
        instructions::expire_trade_listing(ctx)
    }

    pub fn cancel_orphaned_trade_offer(ctx: Context<CancelOrphanedTradeOffer>) -> Result<()> {
        instructions::cancel_orphaned_trade_offer(ctx)
    }

    pub fn close_trade_event(ctx: Context<CloseTradeEvent>) -> Result<()> {
        instructions::close_trade_event(ctx)
    }

    pub fn bot_close_trade_event(ctx: Context<BotCloseTradeEvent>) -> Result<()> {
        instructions::bot_close_trade_event(ctx)
    }

    pub fn transfer_lender_position(
        ctx: Context<TransferLenderPosition>,
        transfer_amount: u64,
        sale_price: u64,
        nonce: u8,
    ) -> Result<()> {
        instructions::transfer_lender_position(ctx, transfer_amount, sale_price, nonce)
    }

    pub fn calculate_position_value(
        ctx: Context<CalculatePositionValue>,
    ) -> Result<PositionValuation> {
        let current_time = Clock::get()?.unix_timestamp;
        instructions::calculate_position_value(
            &ctx.accounts.contribution,
            &ctx.accounts.contract,
            current_time,
        )
    }
}
