use crate::contexts::*;
use crate::errors::StendarError;
use crate::state::{
    ApprovedFunder, ContractCreated, ContractFunded, ContractLiquidated, ContractOperationsFund,
    ContractStatus, DebtContract, DistributionMethod, FundingAccessMode, InterestPaymentType,
    LenderContribution, LenderEscrow, LoanType, PaymentFrequency, PrincipalPaymentType,
    TestClockOffset, APPROVED_FUNDER_RESERVED_BYTES, CURRENT_ACCOUNT_VERSION,
    DEMAND_LOAN_MIN_FLOOR_BPS, DEBT_CONTRACT_RESERVED_BYTES, LENDER_CONTRIBUTION_RESERVED_BYTES,
    LENDER_ESCROW_RESERVED_BYTES, LIQUIDATION_FEE_BPS, OPERATIONS_FUND_SEED,
    PARTIAL_LIQUIDATION_CAP_BPS, RECALL_FEE_BPS, RECALL_GRACE_PERIOD_SECONDS,
};
use crate::utils::{
    calculate_collateral_to_seize, calculate_collateral_value_in_usdc, calculate_ltv_bps,
    calculate_operations_fund, calculate_platform_fee_usdc,
    calculate_proportional_collateral, check_health, get_price_in_usdc, is_native_mint,
    process_automatic_interest,
    process_scheduled_principal_payments, require_current_version, safe_u128_to_u64, HealthStatus,
    MAX_LENDERS_PER_TX, MAX_PRICE_AGE_CREATION, MAX_PRICE_AGE_LIQUIDATION,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

const PARTIAL_FUNDING_DEFAULT: u8 = 0;
const PARTIAL_FUNDING_ENABLED_FLAG: u8 = 1;
const PARTIAL_FUNDING_DISABLED_FLAG: u8 = 2;
const LISTING_EXPIRATION_SECONDS: i64 = 7 * 24 * 60 * 60;

fn with_test_clock_offset(
    base_time: i64,
    state_authority: Pubkey,
    test_clock_offset: Option<&Account<TestClockOffset>>,
) -> Result<i64> {
    if let Some(test_clock) = test_clock_offset {
        require!(
            test_clock.authority == state_authority,
            StendarError::UnauthorizedAuthorityUpdate
        );
        return base_time
            .checked_add(test_clock.offset_seconds)
            .ok_or_else(|| error!(StendarError::ArithmeticOverflow));
    }
    Ok(base_time)
}

fn validate_demand_recall_contract(contract: &DebtContract) -> Result<()> {
    require!(
        contract.loan_type == LoanType::Demand,
        StendarError::NotDemandLoan
    );
    Ok(())
}

fn calculate_recall_fee(recall_amount: u64) -> Result<u64> {
    let fee = (recall_amount as u128)
        .checked_mul(RECALL_FEE_BPS as u128)
        .and_then(|value| value.checked_div(10_000))
        .ok_or(StendarError::ArithmeticOverflow)?;
    u64::try_from(fee).map_err(|_| error!(StendarError::ArithmeticOverflow))
}

fn is_partial_funding_enabled(contract: &DebtContract) -> bool {
    match contract.partial_funding_flag {
        PARTIAL_FUNDING_DISABLED_FLAG => false,
        PARTIAL_FUNDING_ENABLED_FLAG | PARTIAL_FUNDING_DEFAULT => true,
        _ => false,
    }
}

fn has_met_partial_fill_threshold(contract: &DebtContract) -> Result<bool> {
    if contract.funded_amount == 0 {
        return Ok(false);
    }
    if contract.min_partial_fill_bps == 0 {
        return Ok(true);
    }

    let funded_scaled = (contract.funded_amount as u128)
        .checked_mul(10_000u128)
        .ok_or(StendarError::ArithmeticOverflow)?;
    let required_scaled = (contract.target_amount as u128)
        .checked_mul(contract.min_partial_fill_bps as u128)
        .ok_or(StendarError::ArithmeticOverflow)?;
    Ok(funded_scaled >= required_scaled)
}

fn should_activate_on_expiry(contract: &DebtContract) -> Result<bool> {
    if !contract.allow_partial_fill {
        return Ok(false);
    }
    has_met_partial_fill_threshold(contract)
}

fn validate_funder_authorization(
    contract: &DebtContract,
    contract_key: Pubkey,
    lender_key: Pubkey,
    approved_funder: Option<&ApprovedFunder>,
) -> Result<()> {
    if contract.funding_access_mode() != FundingAccessMode::AllowlistOnly {
        return Ok(());
    }

    let approved_funder = approved_funder.ok_or(StendarError::LenderNotApproved)?;
    require_current_version(approved_funder.account_version)?;
    require!(
        approved_funder.contract == contract_key && approved_funder.lender == lender_key,
        StendarError::InvalidApprovedFunderAccount
    );

    Ok(())
}

fn validate_close_listing_contract(contract: &DebtContract) -> Result<()> {
    require!(
        contract.status == ContractStatus::OpenPartiallyFunded,
        StendarError::ContractNotOpen
    );
    require!(contract.allow_partial_fill, StendarError::PartialFillNotAllowed);
    require!(
        contract.funded_amount > 0,
        StendarError::InvalidContributionAmount
    );
    require!(
        has_met_partial_fill_threshold(contract)?,
        StendarError::BelowMinimumFillThreshold
    );
    Ok(())
}

fn activate_open_contract_funding<'info>(
    program_id: &Pubkey,
    contract: &mut Account<'info, DebtContract>,
    contract_info: &AccountInfo<'info>,
    borrower_key: Pubkey,
    _borrower_info: &AccountInfo<'info>,
    contract_usdc_account: Option<&Account<'info, TokenAccount>>,
    borrower_usdc_account: Option<&Account<'info, TokenAccount>>,
    token_program: Option<&Program<'info, Token>>,
    current_time: i64,
) -> Result<()> {
    require!(
        contract.funded_amount > 0,
        StendarError::InvalidContributionAmount
    );

    let disbursement_amount = contract.funded_amount;
    contract.target_amount = disbursement_amount;
    contract.status = ContractStatus::Active;
    contract.outstanding_balance = disbursement_amount;
    contract.last_interest_update = current_time;
    contract.last_principal_payment = current_time;

    let token_program = token_program.ok_or(StendarError::MissingTokenAccounts)?;
    let contract_usdc_account =
        contract_usdc_account.ok_or(StendarError::MissingTokenAccounts)?;
    let borrower_usdc_account =
        borrower_usdc_account.ok_or(StendarError::MissingTokenAccounts)?;

    require!(
        contract_usdc_account.owner == contract.key()
            && contract_usdc_account.mint == contract.loan_mint
            && contract_usdc_account.key() == contract.loan_token_account,
        StendarError::TokenAccountMismatch
    );
    require!(
        borrower_usdc_account.owner == borrower_key
            && borrower_usdc_account.mint == contract.loan_mint,
        StendarError::TokenAccountMismatch
    );

    let contract_seed_bytes = contract.contract_seed.to_le_bytes();
    let (expected_contract_pda, contract_bump) = Pubkey::find_program_address(
        &[
            b"debt_contract",
            contract.borrower.as_ref(),
            &contract_seed_bytes,
        ],
        program_id,
    );
    require!(
        expected_contract_pda == contract.key(),
        StendarError::InvalidContractReference
    );
    let bump_seed = [contract_bump];
    let signer_seeds: &[&[u8]] = &[
        b"debt_contract",
        contract.borrower.as_ref(),
        &contract_seed_bytes,
        &bump_seed,
    ];

    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: contract_usdc_account.to_account_info(),
                to: borrower_usdc_account.to_account_info(),
                authority: contract_info.clone(),
            },
            &[signer_seeds],
        ),
        disbursement_amount,
    )?;

    contract.update_bot_tracking(current_time);
    Ok(())
}

pub fn initialize_state(ctx: Context<Initialize>) -> Result<()> {
    let state = &mut ctx.accounts.state;
    state.authority = ctx.accounts.authority.key();
    state.total_debt = 0;
    state.total_collateral = 0;
    state.total_interest_paid = 0;
    state.total_liquidations = 0;
    state.total_contracts = 0;
    // Match the platform fee configuration used for listing/trading (1 bp = 0.01%).
    state.platform_fee_basis_points = 1;
    state.is_paused = false;
    state.account_version = CURRENT_ACCOUNT_VERSION;
    Ok(())
}

pub fn create_debt_contract(
    ctx: Context<CreateDebtContract>,
    contract_seed: u64,
    target_amount: u64,
    interest_rate: u32,
    term_days: u32,
    collateral_amount: u64,
    loan_type: LoanType,
    ltv_ratio: u64,
    interest_payment_type: InterestPaymentType,
    principal_payment_type: PrincipalPaymentType,
    interest_frequency: PaymentFrequency,
    principal_frequency: Option<PaymentFrequency>,
    max_lenders: u16,
    partial_funding_enabled: bool,
    allow_partial_fill: bool,
    min_partial_fill_bps: u16,
    _distribution_method: DistributionMethod,
    funding_access_mode: FundingAccessMode,
) -> Result<()> {
    require!(!ctx.accounts.state.is_paused, StendarError::PlatformPaused);
    require!(target_amount > 0, StendarError::InvalidContributionAmount);
    require!(
        target_amount <= 1_000_000 * 1_000_000,
        StendarError::ExceedsTargetAmount
    );
    require!(interest_rate <= 10000, StendarError::InvalidPaymentAmount);
    require!(term_days <= 3650, StendarError::InvalidPaymentAmount);
    require!(
        collateral_amount > 0,
        StendarError::InvalidContributionAmount
    );
    require!(
        ltv_ratio >= 1000 && ltv_ratio <= 20000,
        StendarError::InvalidPaymentAmount
    );
    require!(
        max_lenders > 0 && max_lenders <= MAX_LENDERS_PER_TX,
        StendarError::InvalidMaxLenders
    );
    if allow_partial_fill {
        require!(
            partial_funding_enabled,
            StendarError::PartialFundingDisabled
        );
        require!(
            min_partial_fill_bps > 0 && min_partial_fill_bps <= 10_000,
            StendarError::InvalidPaymentAmount
        );
    }
    let normalized_min_partial_fill_bps = if allow_partial_fill {
        min_partial_fill_bps
    } else {
        0
    };

    if principal_payment_type == PrincipalPaymentType::NoFixedPayment {
        require!(
            principal_frequency.is_none(),
            StendarError::InvalidPaymentAmount
        );
    } else {
        require!(
            principal_frequency.is_some(),
            StendarError::InvalidPaymentAmount
        );
        require!(term_days > 0, StendarError::InvalidPaymentAmount);
    }

    let current_time = Clock::get()?.unix_timestamp;
    let contract_key = ctx.accounts.contract.key();
    let contract_info = ctx.accounts.contract.to_account_info();
    let borrower_info = ctx.accounts.borrower.to_account_info();

    let treasury = &mut ctx.accounts.treasury;
    let contract = &mut ctx.accounts.contract;
    let state = &mut ctx.accounts.state;
    require_current_version(state.account_version)?;
    require_current_version(treasury.account_version)?;

    let collateral_registry = ctx
        .accounts
        .collateral_registry
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let collateral_mint = ctx
        .accounts
        .collateral_mint
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let borrower_collateral_ata = ctx
        .accounts
        .borrower_collateral_ata
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let contract_collateral_ata = ctx
        .accounts
        .contract_collateral_ata
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let price_feed_account = ctx
        .accounts
        .price_feed_account
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let usdc_mint = ctx
        .accounts
        .usdc_mint
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let contract_usdc_ata = ctx
        .accounts
        .contract_usdc_ata
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let borrower_usdc_ata = ctx
        .accounts
        .borrower_usdc_ata
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let treasury_usdc_account = ctx
        .accounts
        .treasury_usdc_account
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let token_program = ctx
        .accounts
        .token_program
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;

    require!(
        borrower_usdc_ata.owner == ctx.accounts.borrower.key()
            && borrower_usdc_ata.mint == usdc_mint.key(),
        StendarError::TokenAccountMismatch
    );
    require!(
        treasury_usdc_account.owner == treasury.key() && treasury_usdc_account.mint == usdc_mint.key(),
        StendarError::TokenAccountMismatch
    );

    if treasury.usdc_mint == Pubkey::default() {
        treasury.usdc_mint = usdc_mint.key();
    }
    require!(
        treasury.usdc_mint == usdc_mint.key(),
        StendarError::InvalidUsdcMint
    );

    if treasury.treasury_usdc_account == Pubkey::default() {
        treasury.treasury_usdc_account = treasury_usdc_account.key();
    }
    require!(
        treasury.treasury_usdc_account == treasury_usdc_account.key(),
        StendarError::TokenAccountMismatch
    );

    let listing_fee_paid = calculate_platform_fee_usdc(target_amount);
    if listing_fee_paid > 0 {
        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: borrower_usdc_ata.to_account_info(),
                    to: treasury_usdc_account.to_account_info(),
                    authority: borrower_info.clone(),
                },
            ),
            listing_fee_paid,
        )?;
    }

    treasury.fees_collected = treasury
        .fees_collected
        .checked_add(listing_fee_paid)
        .ok_or(StendarError::ArithmeticOverflow)?;

    contract.borrower = ctx.accounts.borrower.key();
    contract.contract_seed = contract_seed;
    contract.target_amount = target_amount;
    contract.funded_amount = 0;
    contract.interest_rate = interest_rate;
    contract.term_days = term_days;
    contract.collateral_amount = collateral_amount;
    contract.loan_type = loan_type;
    contract.ltv_ratio = ltv_ratio;
    contract.interest_payment_type = interest_payment_type;
    contract.principal_payment_type = principal_payment_type;
    contract.interest_frequency = interest_frequency;
    contract.principal_frequency = principal_frequency;
    contract.created_at = current_time;
    contract.status = ContractStatus::OpenNotFunded;
    contract.num_contributions = 0;
    contract.outstanding_balance = 0;
    contract.accrued_interest = 0;
    contract.last_interest_update = 0;
    contract.last_principal_payment = 0;
    contract.total_principal_paid = 0;
    contract.max_lenders = max_lenders;
    contract.last_bot_update = current_time;
    contract.next_interest_payment_due = current_time
        .checked_add(contract.interest_frequency.to_seconds())
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.next_principal_payment_due = if let Some(principal_freq) = contract.principal_frequency
    {
        current_time
            .checked_add(principal_freq.to_seconds())
            .ok_or(StendarError::ArithmeticOverflow)?
    } else {
        0
    };
    contract.bot_operation_count = 0;
    contract.partial_funding_flag = if partial_funding_enabled {
        PARTIAL_FUNDING_ENABLED_FLAG
    } else {
        PARTIAL_FUNDING_DISABLED_FLAG
    };
    contract.expires_at = current_time
        .checked_add(LISTING_EXPIRATION_SECONDS)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.allow_partial_fill = allow_partial_fill;
    contract.min_partial_fill_bps = normalized_min_partial_fill_bps;
    contract.listing_fee_paid = listing_fee_paid;
    contract.contract_version = 2;
    contract.collateral_mint = Pubkey::default();
    contract.collateral_token_account = Pubkey::default();
    contract.collateral_value_at_creation = 0;
    contract.ltv_floor_bps = 0;
    contract.loan_mint = Pubkey::default();
    contract.loan_token_account = Pubkey::default();
    contract.recall_requested = false;
    contract.recall_requested_at = 0;
    contract.recall_requested_by = Pubkey::default();
    contract._reserved = [0u8; DEBT_CONTRACT_RESERVED_BYTES];
    contract.set_funding_access_mode(funding_access_mode);
    contract.account_version = CURRENT_ACCOUNT_VERSION;

    state.total_contracts = state
        .total_contracts
        .checked_add(1)
        .ok_or(StendarError::ArithmeticOverflow)?;
    state.total_debt = state
        .total_debt
        .checked_add(target_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;

    {
        let collateral_registry = ctx
            .accounts
            .collateral_registry
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let collateral_mint = ctx
            .accounts
            .collateral_mint
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let borrower_collateral_ata = ctx
            .accounts
            .borrower_collateral_ata
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let contract_collateral_ata = ctx
            .accounts
            .contract_collateral_ata
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let price_feed_account = ctx
            .accounts
            .price_feed_account
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let usdc_mint = ctx
            .accounts
            .usdc_mint
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let contract_usdc_ata = ctx
            .accounts
            .contract_usdc_ata
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;

        let collateral_type = collateral_registry
            .find_collateral_type(&collateral_mint.key())
            .ok_or(StendarError::CollateralTypeNotApproved)?;
        require!(
            collateral_type.is_active,
            StendarError::CollateralTypeInactive
        );
        require!(
            collateral_type.oracle_price_feed == price_feed_account.key(),
            StendarError::OraclePriceFeedMismatch
        );

        let ltv_floor_bps =
            u16::try_from(ltv_ratio).map_err(|_| error!(StendarError::InvalidPaymentAmount))?;
        if loan_type == LoanType::Demand {
            require!(
                ltv_floor_bps >= DEMAND_LOAN_MIN_FLOOR_BPS,
                StendarError::DemandLoanFloorTooLow
            );
        } else {
            require!(
                ltv_floor_bps >= collateral_type.min_committed_floor_bps,
                StendarError::LtvFloorBelowMinimum
            );
        }

        require!(
            borrower_collateral_ata.owner == ctx.accounts.borrower.key()
                && borrower_collateral_ata.mint == collateral_mint.key(),
            StendarError::TokenAccountMismatch
        );
        require!(
            contract_collateral_ata.owner == contract_key
                && contract_collateral_ata.mint == collateral_mint.key(),
            StendarError::TokenAccountMismatch
        );
        require!(
            contract_usdc_ata.owner == contract_key && contract_usdc_ata.mint == usdc_mint.key(),
            StendarError::TokenAccountMismatch
        );

        if treasury.usdc_mint == Pubkey::default() {
            treasury.usdc_mint = usdc_mint.key();
        }
        require!(
            treasury.usdc_mint == usdc_mint.key(),
            StendarError::InvalidUsdcMint
        );

        let (price, exponent) = get_price_in_usdc(price_feed_account, MAX_PRICE_AGE_CREATION)?;
        let collateral_value_at_creation = calculate_collateral_value_in_usdc(
            collateral_amount,
            collateral_type.decimals,
            price,
            exponent,
        )?;
        let current_ltv_bps = calculate_ltv_bps(collateral_value_at_creation, target_amount)?;
        let min_required_ltv_bps = ltv_floor_bps
            .checked_add(collateral_type.liquidation_buffer_bps)
            .ok_or(StendarError::ArithmeticOverflow)?;
        require!(
            current_ltv_bps >= min_required_ltv_bps,
            StendarError::InsufficientCollateral
        );

        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: borrower_collateral_ata.to_account_info(),
                    to: contract_collateral_ata.to_account_info(),
                    authority: borrower_info.clone(),
                },
            ),
            collateral_amount,
        )?;

        contract.contract_version = 2;
        contract.collateral_mint = collateral_mint.key();
        contract.collateral_token_account = contract_collateral_ata.key();
        contract.collateral_value_at_creation = collateral_value_at_creation;
        contract.ltv_floor_bps = ltv_floor_bps;
        contract.loan_mint = usdc_mint.key();
        contract.loan_token_account = contract_usdc_ata.key();

        state.total_collateral = state
            .total_collateral
            .checked_add(collateral_value_at_creation)
            .ok_or(StendarError::ArithmeticOverflow)?;
    }

    let operations_fund = &mut ctx.accounts.operations_fund;
    let operations_fund_info = operations_fund.to_account_info();
    let (required_total, estimated_operations) = calculate_operations_fund(
        term_days,
        interest_payment_type,
        principal_payment_type,
        interest_frequency,
        principal_frequency,
        max_lenders,
        ContractOperationsFund::LEN,
    )?;
    let currently_funded = operations_fund_info.lamports();
    if required_total > currently_funded {
        let top_up = required_total
            .checked_sub(currently_funded)
            .ok_or(StendarError::ArithmeticOverflow)?;
        let transfer_instruction = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.borrower.key(),
            operations_fund_info.key,
            top_up,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_instruction,
            &[
                borrower_info,
                operations_fund_info.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    operations_fund.contract = contract_key;
    operations_fund.borrower = ctx.accounts.borrower.key();
    operations_fund.total_funded = operations_fund_info.lamports();
    operations_fund.total_reimbursed = 0;
    operations_fund.estimated_operations = estimated_operations;
    operations_fund.completed_operations = 0;
    operations_fund.max_lenders = max_lenders;
    operations_fund.is_active = true;
    operations_fund.created_at = current_time;
    operations_fund.account_version = CURRENT_ACCOUNT_VERSION;

    emit!(ContractCreated {
        contract: contract_key,
        borrower: ctx.accounts.borrower.key(),
        amount: target_amount,
    });

    Ok(())
}

pub fn approve_funder(ctx: Context<ApproveFunder>) -> Result<()> {
    let contract_key = ctx.accounts.contract.key();
    let lender_key = ctx.accounts.lender.key();
    require!(
        lender_key != Pubkey::default(),
        StendarError::InvalidApprovedFunderAccount
    );

    let approved_funder = &mut ctx.accounts.approved_funder;
    if approved_funder.account_version != 0 {
        require!(
            approved_funder.contract == contract_key && approved_funder.lender == lender_key,
            StendarError::InvalidApprovedFunderAccount
        );
        return Err(StendarError::FunderAlreadyApproved.into());
    }

    approved_funder.contract = contract_key;
    approved_funder.lender = lender_key;
    approved_funder.approved_by = ctx.accounts.borrower.key();
    approved_funder.created_at = Clock::get()?.unix_timestamp;
    approved_funder._reserved = [0u8; APPROVED_FUNDER_RESERVED_BYTES];
    approved_funder.account_version = CURRENT_ACCOUNT_VERSION;

    Ok(())
}

pub fn revoke_funder(ctx: Context<RevokeFunder>) -> Result<()> {
    let contract_key = ctx.accounts.contract.key();
    let lender_key = ctx.accounts.lender.key();
    let approved_funder = &ctx.accounts.approved_funder;

    require_current_version(approved_funder.account_version)?;
    require!(
        approved_funder.contract == contract_key && approved_funder.lender == lender_key,
        StendarError::InvalidApprovedFunderAccount
    );

    Ok(())
}

pub fn contribute_to_contract(ctx: Context<ContributeToContract>, amount: u64) -> Result<()> {
    require!(!ctx.accounts.state.is_paused, StendarError::PlatformPaused);
    let contract_key = ctx.accounts.contract.key();
    let lender_key = ctx.accounts.lender.key();
    let borrower_key = ctx.accounts.borrower.key();
    let contract_info = ctx.accounts.contract.to_account_info();
    let borrower_info = ctx.accounts.borrower.to_account_info();

    let contract = &mut ctx.accounts.contract;
    let contribution = &mut ctx.accounts.contribution;
    let escrow = &mut ctx.accounts.escrow;

    let result = (|| -> Result<()> {
        require_current_version(contract.account_version)?;
        require!(contract.status.is_open(), StendarError::ContractNotOpen);
        let current_time = Clock::get()?.unix_timestamp;
        if contract.expires_at > 0 {
            require!(
                current_time < contract.expires_at,
                StendarError::ContractNotOpen
            );
        }
        require!(amount > 0, StendarError::InvalidContributionAmount);
        require!(
            contract.borrower == borrower_key,
            StendarError::UnauthorizedPayment
        );
        validate_funder_authorization(
            contract,
            contract_key,
            lender_key,
            ctx.accounts.approved_funder.as_deref(),
        )?;
        let lender_cap = if contract.max_lenders == 0 {
            MAX_LENDERS_PER_TX
        } else {
            contract.max_lenders
        };
        require!(
            contract.num_contributions < lender_cap as u32,
            StendarError::MaxLendersReached
        );
        if is_partial_funding_enabled(contract) {
            let next_contribution_count = contract
                .num_contributions
                .checked_add(1)
                .ok_or(StendarError::ArithmeticOverflow)?;
            let is_last_slot = next_contribution_count >= lender_cap as u32;
            if is_last_slot {
                let remaining = contract
                    .target_amount
                    .checked_sub(contract.funded_amount)
                    .ok_or(StendarError::ArithmeticOverflow)?;
                require!(
                    amount == remaining,
                    StendarError::LastLenderMustFillRemaining
                );
            }
        }
        if !is_partial_funding_enabled(contract) {
            require!(
                contract.funded_amount == 0 && amount == contract.target_amount,
                StendarError::PartialFundingDisabled
            );
        }

        let new_funded_amount = contract
            .funded_amount
            .checked_add(amount)
            .ok_or(StendarError::ArithmeticOverflow)?;
        require!(
            new_funded_amount <= contract.target_amount,
            StendarError::ExceedsTargetAmount
        );

        contribution.lender = lender_key;
        contribution.contract = contract_key;
        contribution.contribution_amount = amount;
        contribution.is_refunded = false;
        contribution.created_at = Clock::get()?.unix_timestamp;
        contribution.total_interest_claimed = 0;
        contribution.total_principal_claimed = 0;
        contribution.last_claim_timestamp = 0;
        contribution._reserved = [0u8; LENDER_CONTRIBUTION_RESERVED_BYTES];
        contribution.account_version = CURRENT_ACCOUNT_VERSION;

        escrow.lender = lender_key;
        escrow.contract = contract_key;
        escrow.escrow_amount = 0;
        escrow.available_interest = 0;
        escrow.available_principal = 0;
        escrow.total_claimed = 0;
        escrow.is_released = false;
        escrow.created_at = Clock::get()?.unix_timestamp;
        escrow._reserved = [0u8; LENDER_ESCROW_RESERVED_BYTES];
        escrow.account_version = CURRENT_ACCOUNT_VERSION;

        contract.funded_amount = new_funded_amount;
        contract.num_contributions = contract
            .num_contributions
            .checked_add(1)
            .ok_or(StendarError::ArithmeticOverflow)?;
        contract.contributions.push(contribution.key());

        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let lender_usdc_account = ctx
            .accounts
            .lender_usdc_account
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let contract_usdc_account = ctx
            .accounts
            .contract_usdc_account
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let usdc_mint = ctx
            .accounts
            .usdc_mint
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;

        require!(
            lender_usdc_account.owner == lender_key && lender_usdc_account.mint == contract.loan_mint,
            StendarError::TokenAccountMismatch
        );
        require!(
            contract_usdc_account.owner == contract_key
                && contract_usdc_account.mint == contract.loan_mint
                && contract_usdc_account.key() == contract.loan_token_account,
            StendarError::TokenAccountMismatch
        );
        require!(
            usdc_mint.key() == contract.loan_mint,
            StendarError::InvalidUsdcMint
        );

        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: lender_usdc_account.to_account_info(),
                    to: contract_usdc_account.to_account_info(),
                    authority: ctx.accounts.lender.to_account_info(),
                },
            ),
            amount,
        )?;

        if contract.funded_amount >= contract.target_amount {
            activate_open_contract_funding(
                ctx.program_id,
                contract,
                &contract_info,
                borrower_key,
                &borrower_info,
                ctx.accounts.contract_usdc_account.as_ref(),
                ctx.accounts.borrower_usdc_account.as_ref(),
                ctx.accounts.token_program.as_ref(),
                current_time,
            )?;
        } else if contract.status == ContractStatus::OpenNotFunded {
            contract.status = ContractStatus::OpenPartiallyFunded;
            contract.update_bot_tracking(current_time);
        } else {
            contract.update_bot_tracking(current_time);
        }

        emit!(ContractFunded {
            contract: contract_key,
            lender: lender_key,
            amount,
        });

        Ok(())
    })();
    result
}

pub fn add_collateral(ctx: Context<AddCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, StendarError::InvalidPaymentAmount);

    let current_time = Clock::get()?.unix_timestamp;
    let contract = &mut ctx.accounts.contract;
    require_current_version(contract.account_version)?;
    require!(
        contract.status == ContractStatus::Active || contract.status == ContractStatus::PendingRecall,
        StendarError::ContractNotFunded
    );
    require!(
        ctx.accounts.borrower_collateral_ata.owner == ctx.accounts.borrower.key()
            && ctx.accounts.borrower_collateral_ata.mint == contract.collateral_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.contract_collateral_ata.key() == contract.collateral_token_account
            && ctx.accounts.contract_collateral_ata.owner == contract.key()
            && ctx.accounts.contract_collateral_ata.mint == contract.collateral_mint,
        StendarError::TokenAccountMismatch
    );

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.borrower_collateral_ata.to_account_info(),
                to: ctx.accounts.contract_collateral_ata.to_account_info(),
                authority: ctx.accounts.borrower.to_account_info(),
            },
        ),
        amount,
    )?;

    contract.collateral_amount = contract
        .collateral_amount
        .checked_add(amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.update_bot_tracking(current_time);
    Ok(())
}

pub fn migrate_debt_contract<'info>(
    _ctx: Context<'_, '_, '_, 'info, MigrateDebtContract<'info>>,
) -> Result<()> {
    err!(StendarError::InvalidContractVersion)
}

pub fn cancel_contract(ctx: Context<CancelContract>) -> Result<()> {
    let borrower_key = ctx.accounts.borrower.key();
    let contract_info = ctx.accounts.contract.to_account_info();
    let borrower_info = ctx.accounts.borrower.to_account_info();

    let contract = &mut ctx.accounts.contract;
    require_current_version(contract.account_version)?;

    require!(
        contract.borrower == borrower_key,
        StendarError::UnauthorizedCancellation
    );
    require!(
        contract.status.is_open(),
        StendarError::CannotCancelContract
    );

    let collateral_amount = contract.collateral_amount;
    contract.status = ContractStatus::Cancelled;

    if collateral_amount > 0 {
        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let contract_collateral_ata = ctx
            .accounts
            .contract_collateral_ata
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        require!(
            contract_collateral_ata.key() == contract.collateral_token_account
                && contract_collateral_ata.owner == contract.key()
                && contract_collateral_ata.mint == contract.collateral_mint,
            StendarError::TokenAccountMismatch
        );

        let contract_seed_bytes = contract.contract_seed.to_le_bytes();
        let (expected_contract_pda, contract_bump) = Pubkey::find_program_address(
            &[
                b"debt_contract",
                contract.borrower.as_ref(),
                &contract_seed_bytes,
            ],
            ctx.program_id,
        );
        require!(
            expected_contract_pda == contract.key(),
            StendarError::InvalidContractReference
        );
        let bump_seed = [contract_bump];
        let signer_seeds: &[&[u8]] = &[
            b"debt_contract",
            contract.borrower.as_ref(),
            &contract_seed_bytes,
            &bump_seed,
        ];

        if is_native_mint(&contract.collateral_mint) {
            token::close_account(CpiContext::new_with_signer(
                token_program.to_account_info(),
                CloseAccount {
                    account: contract_collateral_ata.to_account_info(),
                    destination: borrower_info.clone(),
                    authority: contract_info.clone(),
                },
                &[signer_seeds],
            ))?;
        } else {
            let borrower_collateral_ata = ctx
                .accounts
                .borrower_collateral_ata
                .as_ref()
                .ok_or(StendarError::MissingTokenAccounts)?;
            require!(
                borrower_collateral_ata.owner == borrower_key
                    && borrower_collateral_ata.mint == contract.collateral_mint,
                StendarError::TokenAccountMismatch
            );
            token::transfer(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    Transfer {
                        from: contract_collateral_ata.to_account_info(),
                        to: borrower_collateral_ata.to_account_info(),
                        authority: contract_info.clone(),
                    },
                    &[signer_seeds],
                ),
                collateral_amount,
            )?;
        }

        contract.collateral_amount = 0;
    }

    if let Some(ops_info) = ctx.accounts.operations_fund.as_ref() {
        let ops_info = ops_info.clone();
        if ops_info.data_len() > 0 {
            let contract_key = ctx.accounts.contract.key();
            let (expected_ops_pda, _) = Pubkey::find_program_address(
                &[OPERATIONS_FUND_SEED, contract_key.as_ref()],
                ctx.program_id,
            );
            require!(
                ops_info.key() == expected_ops_pda,
                StendarError::InvalidContractReference
            );
            require!(
                ops_info.owner == ctx.program_id,
                StendarError::InvalidContractReference
            );
            {
                let data = ops_info.try_borrow_data()?;
                require!(
                    data.len() >= 8 && &data[..8] == ContractOperationsFund::DISCRIMINATOR,
                    StendarError::InvalidContractReference
                );
            }

            let ops_balance = ops_info.lamports();
            if ops_balance > 0 {
                **ops_info.try_borrow_mut_lamports()? -= ops_balance;
                **borrower_info.try_borrow_mut_lamports()? += ops_balance;
            }
            ops_info.realloc(0, false)?;
        }
    }

    Ok(())
}

pub fn expire_contract(ctx: Context<ExpireContract>) -> Result<()> {
    let contract_info = ctx.accounts.contract.to_account_info();
    let borrower_info = ctx.accounts.borrower.to_account_info();
    let treasury_info = ctx.accounts.treasury.to_account_info();
    let contract_key = ctx.accounts.contract.key();
    let borrower_key = ctx.accounts.borrower.key();

    let contract = &mut ctx.accounts.contract;
    let treasury = &mut ctx.accounts.treasury;
    require_current_version(contract.account_version)?;
    require_current_version(treasury.account_version)?;
    require_current_version(ctx.accounts.state.account_version)?;
    require!(contract.status.is_open(), StendarError::CannotCancelContract);

    let current_time = Clock::get()?.unix_timestamp;
    require!(
        contract.expires_at > 0 && current_time >= contract.expires_at,
        StendarError::ContractNotExpired
    );

    if should_activate_on_expiry(contract)? {
        activate_open_contract_funding(
            ctx.program_id,
            contract,
            &contract_info,
            borrower_key,
            &borrower_info,
            ctx.accounts.contract_usdc_account.as_ref(),
            ctx.accounts.borrower_usdc_account.as_ref(),
            ctx.accounts.token_program.as_ref(),
            current_time,
        )?;
        return Ok(());
    }

    let collateral_amount = contract.collateral_amount;
    contract.status = ContractStatus::Cancelled;

    if collateral_amount > 0 {
        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let contract_collateral_ata = ctx
            .accounts
            .contract_collateral_ata
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        require!(
            contract_collateral_ata.key() == contract.collateral_token_account
                && contract_collateral_ata.owner == contract.key()
                && contract_collateral_ata.mint == contract.collateral_mint,
            StendarError::TokenAccountMismatch
        );

        let contract_seed_bytes = contract.contract_seed.to_le_bytes();
        let (expected_contract_pda, contract_bump) = Pubkey::find_program_address(
            &[
                b"debt_contract",
                contract.borrower.as_ref(),
                &contract_seed_bytes,
            ],
            ctx.program_id,
        );
        require!(
            expected_contract_pda == contract.key(),
            StendarError::InvalidContractReference
        );
        let bump_seed = [contract_bump];
        let signer_seeds: &[&[u8]] = &[
            b"debt_contract",
            contract.borrower.as_ref(),
            &contract_seed_bytes,
            &bump_seed,
        ];

        if is_native_mint(&contract.collateral_mint) {
            token::close_account(CpiContext::new_with_signer(
                token_program.to_account_info(),
                CloseAccount {
                    account: contract_collateral_ata.to_account_info(),
                    destination: borrower_info.clone(),
                    authority: contract_info.clone(),
                },
                &[signer_seeds],
            ))?;
        } else {
            let borrower_collateral_ata = ctx
                .accounts
                .borrower_collateral_ata
                .as_ref()
                .ok_or(StendarError::MissingTokenAccounts)?;
            require!(
                borrower_collateral_ata.owner == borrower_key
                    && borrower_collateral_ata.mint == contract.collateral_mint,
                StendarError::TokenAccountMismatch
            );
            token::transfer(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    Transfer {
                        from: contract_collateral_ata.to_account_info(),
                        to: borrower_collateral_ata.to_account_info(),
                        authority: contract_info.clone(),
                    },
                    &[signer_seeds],
                ),
                collateral_amount,
            )?;
        }

        contract.collateral_amount = 0;
    }

    if contract.listing_fee_paid > 0 {
        let listing_fee_refund = contract.listing_fee_paid;
        require!(
            treasury_info.lamports() >= listing_fee_refund,
            StendarError::InsufficientTreasuryBalance
        );
        // System transfers cannot debit program-owned accounts with data.
        **treasury_info.try_borrow_mut_lamports()? -= listing_fee_refund;
        **borrower_info.try_borrow_mut_lamports()? += listing_fee_refund;
        treasury.fees_collected = treasury.fees_collected.saturating_sub(listing_fee_refund);
        contract.listing_fee_paid = 0;
    }

    refund_operations_fund_if_present(
        ctx.program_id,
        contract_key,
        ctx.accounts.operations_fund.as_ref(),
        &borrower_info,
    )?;

    Ok(())
}

pub fn close_listing(ctx: Context<CloseListing>) -> Result<()> {
    let contract_info = ctx.accounts.contract.to_account_info();
    let borrower_info = ctx.accounts.borrower.to_account_info();
    let borrower_key = ctx.accounts.borrower.key();

    let contract = &mut ctx.accounts.contract;
    require_current_version(contract.account_version)?;
    validate_close_listing_contract(contract)?;

    let current_time = Clock::get()?.unix_timestamp;
    activate_open_contract_funding(
        ctx.program_id,
        contract,
        &contract_info,
        borrower_key,
        &borrower_info,
        ctx.accounts.contract_usdc_account.as_ref(),
        ctx.accounts.borrower_usdc_account.as_ref(),
        ctx.accounts.token_program.as_ref(),
        current_time,
    )?;
    Ok(())
}

#[inline(never)]
pub fn liquidate_contract<'info>(
    ctx: Context<'_, '_, '_, 'info, LiquidateContract<'info>>,
) -> Result<()> {
    liquidate_contract_standard(ctx)
}

#[inline(never)]
fn _liquidate_contract_compat<'info>(
    ctx: Context<'_, '_, '_, 'info, LiquidateContract<'info>>,
) -> Result<()> {
    let contract_info = ctx.accounts.contract.to_account_info();

    let contract = &mut ctx.accounts.contract;
    let state = &mut ctx.accounts.state;
    require_current_version(contract.account_version)?;
    require_current_version(state.account_version)?;

    require!(
        contract.status == ContractStatus::Active,
        StendarError::ContractNotFunded
    );
    require!(
        ctx.accounts.liquidator.key() != contract.borrower,
        StendarError::SelfLiquidationNotAllowed
    );

    let current_time = Clock::get()?.unix_timestamp;
    let term_seconds = (contract.term_days as i64)
        .checked_mul(24 * 60 * 60)
        .ok_or(StendarError::ArithmeticOverflow)?;

    // NOTE: `last_interest_update` is updated by `process_automatic_interest`, so using it to
    // compute the loan end time would make liquidation impossible (end time would move forward).
    // For demand loans, allow recall at any time while Active. For committed loans, treat the
    // contract as in default after the term has elapsed since creation.
    // NOTE (accepted risk): demand loans are immediately liquidatable by design.
    // The recall mechanism is the intended safeguard for demand lenders.
    let is_recallable_or_in_default = match contract.loan_type {
        LoanType::Demand => true,
        LoanType::Committed => {
            let contract_end = contract
                .created_at
                .checked_add(term_seconds)
                .ok_or(StendarError::ArithmeticOverflow)?;
            current_time > contract_end
        }
    };
    require!(
        is_recallable_or_in_default,
        StendarError::ContractNotInDefault
    );

    process_automatic_interest(contract, current_time)?;
    require!(
        contract.outstanding_balance > 0,
        StendarError::ContractNotInDefault
    );

    contract.status = ContractStatus::Liquidated;
    state.total_liquidations = state
        .total_liquidations
        .checked_add(1)
        .ok_or(StendarError::ArithmeticOverflow)?;

    emit!(ContractLiquidated {
        contract: contract_info.key(),
    });

    // Only distribute the tracked collateral amount. Never drain the rent-exempt reserve,
    // otherwise the contract PDA can be reaped (0 lamports) and become unreadable.
    let rent_minimum = Rent::get()?.minimum_balance(contract_info.data_len());
    let max_distributable = contract_info.lamports().saturating_sub(rent_minimum);
    let remaining_collateral = contract.collateral_amount;
    require!(
        max_distributable >= remaining_collateral,
        StendarError::InsufficientFunds
    );
    if remaining_collateral > 0 {
        const LIQUIDATOR_FEE_PERCENT: u64 = 500;
        const MAX_LIQUIDATOR_FEE: u64 = 500_000_000;

        let liquidator_fee = std::cmp::min(
            remaining_collateral
                .checked_mul(LIQUIDATOR_FEE_PERCENT)
                .and_then(|value| value.checked_div(10000))
                .ok_or(StendarError::ArithmeticOverflow)?,
            MAX_LIQUIDATOR_FEE,
        );

        let collateral_for_lenders = remaining_collateral
            .checked_sub(liquidator_fee)
            .ok_or(StendarError::ArithmeticOverflow)?;

        let contract_key = contract.key();
        let program_id = ctx.program_id;
        let liquidator_info = ctx.accounts.liquidator.to_account_info();
        if liquidator_fee > 0 {
            // System transfers cannot debit program-owned accounts with data.
            require!(
                contract_info.lamports() >= liquidator_fee,
                StendarError::InsufficientFunds
            );
            **contract_info.try_borrow_mut_lamports()? -= liquidator_fee;
            **liquidator_info.try_borrow_mut_lamports()? += liquidator_fee;
        }

        let total_funded = contract.funded_amount;
        require!(total_funded > 0, StendarError::InvalidContributionAmount);

        // Some contracts may have been created without their `contributions` vector populated.
        // Accept the provided remaining accounts and register the contribution PDAs on-chain so
        // liquidation (and future payments) can validate completeness.
        if contract.contributions.is_empty() {
            require!(
                !ctx.remaining_accounts.is_empty() && ctx.remaining_accounts.len() % 2 == 0,
                StendarError::InvalidContribution
            );

            let mut contribution_keys: Vec<Pubkey> = Vec::new();
            let mut lenders_seen: Vec<Pubkey> = Vec::new();
            let mut total_contributed: u64 = 0;

            for chunk in ctx.remaining_accounts.chunks(2) {
                let contribution_info = &chunk[0];
                let escrow_info = &chunk[1];

                require!(
                    contribution_info.owner == program_id,
                    StendarError::InvalidContribution
                );
                require!(
                    escrow_info.owner == program_id,
                    StendarError::InvalidContribution
                );

                let (lender, amount) = {
                    let data = contribution_info.try_borrow_data()?;
                    require!(data.len() >= 8, StendarError::InvalidContribution);
                    require!(
                        &data[..8] == LenderContribution::DISCRIMINATOR,
                        StendarError::InvalidContribution
                    );

                    let contrib = LenderContribution::try_deserialize(&mut &data[..])
                        .map_err(|_| StendarError::InvalidContribution)?;
                    require!(
                        contrib.contract == contract_key,
                        StendarError::InvalidContribution
                    );
                    (contrib.lender, contrib.contribution_amount)
                };

                require!(
                    !lenders_seen.contains(&lender),
                    StendarError::InvalidContribution
                );
                lenders_seen.push(lender);

                let (expected_contribution_pda, _) = Pubkey::find_program_address(
                    &[b"contribution", contract_key.as_ref(), lender.as_ref()],
                    program_id,
                );
                require!(
                    contribution_info.key() == expected_contribution_pda,
                    StendarError::InvalidContribution
                );

                let (expected_escrow_pda, _) = Pubkey::find_program_address(
                    &[b"escrow", contract_key.as_ref(), lender.as_ref()],
                    program_id,
                );
                require!(
                    escrow_info.key() == expected_escrow_pda,
                    StendarError::InvalidContribution
                );

                total_contributed = total_contributed
                    .checked_add(amount)
                    .ok_or(StendarError::ArithmeticOverflow)?;
                contribution_keys.push(expected_contribution_pda);
            }

            require!(
                total_contributed == total_funded,
                StendarError::InvalidContributionAmount
            );
            require!(
                contribution_keys.len() <= MAX_LENDERS_PER_TX as usize,
                StendarError::InvalidContribution
            );

            contract.num_contributions = contribution_keys.len() as u32;
            contract.contributions = contribution_keys;
        }

        let expected_contribution_accounts = contract.contributions.len();
        let expected_remaining_accounts = expected_contribution_accounts
            .checked_mul(2)
            .ok_or(StendarError::ArithmeticOverflow)?;
        require!(
            ctx.remaining_accounts.len() == expected_remaining_accounts,
            StendarError::InvalidContribution
        );

        // Enforce that each contribution PDA is present exactly once.
        let mut remaining_contributions = contract.contributions.clone();
        let remaining_accounts = &ctx.remaining_accounts;

        for chunk in remaining_accounts.chunks(2) {
            let contribution_info = &chunk[0];
            let escrow_info = &chunk[1];

            let contribution_key = contribution_info.key();
            let contribution_index = remaining_contributions
                .iter()
                .position(|key| *key == contribution_key)
                .ok_or(StendarError::InvalidContribution)?;
            remaining_contributions.swap_remove(contribution_index);

            let (lender, contribution_amount) = {
                let contribution_data = contribution_info.try_borrow_data()?;
                require!(
                    contribution_data.len() >= 8,
                    StendarError::InvalidContribution
                );
                require!(
                    &contribution_data[..8] == LenderContribution::DISCRIMINATOR,
                    StendarError::InvalidContribution
                );

                let contrib = LenderContribution::try_deserialize(&mut &contribution_data[..])
                    .map_err(|_| StendarError::InvalidContribution)?;
                require!(
                    contrib.contract == contract_key,
                    StendarError::InvalidContribution
                );
                (contrib.lender, contrib.contribution_amount)
            };

            let (expected_contribution_pda, _) = Pubkey::find_program_address(
                &[b"contribution", contract_key.as_ref(), lender.as_ref()],
                program_id,
            );
            require!(
                contribution_key == expected_contribution_pda,
                StendarError::InvalidContribution
            );

            let (expected_escrow_pda, _) = Pubkey::find_program_address(
                &[b"escrow", contract_key.as_ref(), lender.as_ref()],
                program_id,
            );
            require!(
                escrow_info.key() == expected_escrow_pda,
                StendarError::InvalidContribution
            );

            let lender_share = safe_u128_to_u64(
                (contribution_amount as u128)
                    .checked_mul(collateral_for_lenders as u128)
                    .and_then(|value| value.checked_div(total_funded as u128))
                    .ok_or(StendarError::ArithmeticOverflow)?,
            )?;

            if lender_share > 0 {
                **contract_info.try_borrow_mut_lamports()? -= lender_share;
                **escrow_info.try_borrow_mut_lamports()? += lender_share;

                let mut escrow_data = escrow_info.try_borrow_mut_data()?;
                require!(escrow_data.len() >= 8, StendarError::InvalidContribution);
                require!(
                    &escrow_data[..8] == LenderEscrow::DISCRIMINATOR,
                    StendarError::InvalidContribution
                );

                let mut escrow = LenderEscrow::try_deserialize(&mut &escrow_data[..])
                    .map_err(|_| StendarError::InvalidContribution)?;
                require!(
                    escrow.contract == contract_key,
                    StendarError::InvalidContribution
                );
                require!(escrow.lender == lender, StendarError::UnauthorizedClaim);

                escrow.available_principal = escrow
                    .available_principal
                    .checked_add(lender_share)
                    .ok_or(StendarError::ArithmeticOverflow)?;
                escrow.escrow_amount = escrow
                    .escrow_amount
                    .checked_add(lender_share)
                    .ok_or(StendarError::ArithmeticOverflow)?;

                escrow.try_serialize(&mut &mut escrow_data[..])?;
            }
        }

        require!(
            remaining_contributions.is_empty(),
            StendarError::InvalidContribution
        );

        msg!(
            "Liquidation completed: liquidator fee {} lamports, distributed {} lamports to lenders",
            liquidator_fee,
            collateral_for_lenders
        );
    }

    let borrower_info = ctx.accounts.borrower.to_account_info();
    refund_operations_fund_if_present(
        ctx.program_id,
        ctx.accounts.contract.key(),
        ctx.accounts.operations_fund.as_ref(),
        &borrower_info,
    )?;

    Ok(())
}

#[inline(never)]
fn liquidate_contract_standard<'info>(
    ctx: Context<'_, '_, '_, 'info, LiquidateContract<'info>>,
) -> Result<()> {
    let contract_key = ctx.accounts.contract.key();
    let borrower_info = ctx.accounts.borrower.to_account_info();
    let liquidator_key = ctx.accounts.liquidator.key();

    require_current_version(ctx.accounts.contract.account_version)?;
    require_current_version(ctx.accounts.state.account_version)?;

    {
        let treasury = ctx
            .accounts
            .treasury
            .as_ref()
            .ok_or_else(|| error!(StendarError::InvalidContractReference))?;
        require_current_version(treasury.account_version)?;
        require!(
            treasury.bot_authority == liquidator_key,
            StendarError::UnauthorizedBotOperation
        );
    }

    let registry = ctx
        .accounts
        .collateral_registry
        .as_ref()
        .ok_or_else(|| error!(StendarError::InvalidContractReference))?;
    let price_feed = ctx
        .accounts
        .price_feed_account
        .as_ref()
        .ok_or_else(|| error!(StendarError::InvalidContractReference))?;
    let token_program = ctx
        .accounts
        .token_program
        .as_ref()
        .ok_or_else(|| error!(StendarError::InvalidContractReference))?;
    let bot_usdc_ata = ctx
        .accounts
        .bot_usdc_ata
        .as_ref()
        .ok_or_else(|| error!(StendarError::InvalidContractReference))?;
    let contract_usdc_ata = ctx
        .accounts
        .contract_usdc_ata
        .as_ref()
        .ok_or_else(|| error!(StendarError::InvalidContractReference))?;
    let contract_collateral_ata = ctx
        .accounts
        .contract_collateral_ata
        .as_ref()
        .ok_or_else(|| error!(StendarError::InvalidContractReference))?;
    let bot_collateral_ata = ctx
        .accounts
        .bot_collateral_ata
        .as_ref()
        .ok_or_else(|| error!(StendarError::InvalidContractReference))?;

    let (
        contract_seed,
        contract_borrower,
        contract_status,
        loan_type,
        term_days,
        created_at,
        outstanding_balance,
        funded_amount,
        loan_mint,
        collateral_mint,
        contract_loan_token_account,
        contract_collateral_token_account,
        ltv_floor_bps,
    ) = {
        let contract = &ctx.accounts.contract;
        require!(
            contract.status == ContractStatus::Active
                || contract.status == ContractStatus::PendingRecall,
            StendarError::ContractNotFunded
        );
        (
            contract.contract_seed,
            contract.borrower,
            contract.status,
            contract.loan_type,
            contract.term_days,
            contract.created_at,
            contract.outstanding_balance,
            contract.funded_amount,
            contract.loan_mint,
            contract.collateral_mint,
            contract.loan_token_account,
            contract.collateral_token_account,
            contract.ltv_floor_bps,
        )
    };

    {
        let treasury = ctx
            .accounts
            .treasury
            .as_ref()
            .ok_or_else(|| error!(StendarError::InvalidContractReference))?;
        require!(
            treasury.usdc_mint == loan_mint,
            StendarError::InvalidContractReference
        );
    }

    require!(
        contract_usdc_ata.key() == contract_loan_token_account,
        StendarError::InvalidContractReference
    );
    require!(
        contract_collateral_ata.key() == contract_collateral_token_account,
        StendarError::InvalidContractReference
    );
    require!(
        contract_usdc_ata.owner == contract_key,
        StendarError::InvalidContractReference
    );
    require!(
        contract_collateral_ata.owner == contract_key,
        StendarError::InvalidContractReference
    );
    require!(
        bot_usdc_ata.owner == liquidator_key,
        StendarError::InvalidContractReference
    );
    require!(
        bot_collateral_ata.owner == liquidator_key,
        StendarError::InvalidContractReference
    );
    require!(
        bot_usdc_ata.mint == loan_mint,
        StendarError::InvalidContractReference
    );
    require!(
        contract_usdc_ata.mint == loan_mint,
        StendarError::InvalidContractReference
    );
    require!(
        bot_collateral_ata.mint == collateral_mint,
        StendarError::InvalidContractReference
    );
    require!(
        contract_collateral_ata.mint == collateral_mint,
        StendarError::InvalidContractReference
    );

    let collateral_type = registry
        .find_collateral_type(&collateral_mint)
        .ok_or_else(|| error!(StendarError::InvalidContractReference))?;
    require!(
        collateral_type.is_active,
        StendarError::InvalidContractReference
    );
    require!(
        collateral_type.oracle_price_feed == price_feed.key(),
        StendarError::InvalidContractReference
    );

    let current_time = with_test_clock_offset(
        Clock::get()?.unix_timestamp,
        ctx.accounts.state.authority,
        ctx.accounts.test_clock_offset.as_deref(),
    )?;
    let is_time_triggered = is_time_liquidation_triggered(
        loan_type,
        contract_status,
        created_at,
        term_days,
        current_time,
    )?;

    let (price, exponent) = get_price_in_usdc(price_feed, MAX_PRICE_AGE_LIQUIDATION)?;
    let collateral_value_usdc = calculate_collateral_value_in_usdc(
        contract_collateral_ata.amount,
        collateral_type.decimals,
        price,
        exponent,
    )?;
    let is_price_triggered = if outstanding_balance == 0 {
        false
    } else {
        let collateral_side = (collateral_value_usdc as u128)
            .checked_mul(10_000u128)
            .ok_or(StendarError::ArithmeticOverflow)?;
        let floor_side = (outstanding_balance as u128)
            .checked_mul(ltv_floor_bps as u128)
            .ok_or(StendarError::ArithmeticOverflow)?;
        collateral_side <= floor_side
    };

    require!(
        is_price_triggered || is_time_triggered,
        StendarError::ContractNotInDefault
    );

    {
        let contract = &mut ctx.accounts.contract;
        process_automatic_interest(contract, current_time)?;
        require!(
            contract.outstanding_balance > 0,
            StendarError::ContractNotInDefault
        );
    }

    let bot_pays_usdc = calculate_bot_payment(
        ctx.accounts.contract.outstanding_balance,
        collateral_value_usdc,
    );
    let all_collateral = contract_collateral_ata.amount;

    let contract_seed_bytes = contract_seed.to_le_bytes();
    let (expected_contract_pda, contract_bump) = Pubkey::find_program_address(
        &[
            b"debt_contract",
            contract_borrower.as_ref(),
            &contract_seed_bytes,
        ],
        ctx.program_id,
    );
    require!(
        expected_contract_pda == contract_key,
        StendarError::InvalidContractReference
    );
    let bump_seed = [contract_bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"debt_contract",
        contract_borrower.as_ref(),
        &contract_seed_bytes,
        &bump_seed,
    ]];

    if bot_pays_usdc > 0 {
        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: bot_usdc_ata.to_account_info(),
                    to: contract_usdc_ata.to_account_info(),
                    authority: ctx.accounts.liquidator.to_account_info(),
                },
            ),
            bot_pays_usdc,
        )?;
    }

    if all_collateral > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: contract_collateral_ata.to_account_info(),
                    to: bot_collateral_ata.to_account_info(),
                    authority: ctx.accounts.contract.to_account_info(),
                },
                signer_seeds,
            ),
            all_collateral,
        )?;
    }

    require!(funded_amount > 0, StendarError::InvalidContributionAmount);
    let contribution_count = ctx.accounts.contract.contributions.len();
    require!(contribution_count > 0, StendarError::InvalidContribution);

    let expected_remaining_accounts = contribution_count
        .checked_mul(3)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(
        ctx.remaining_accounts.len() == expected_remaining_accounts,
        StendarError::InvalidContribution
    );

    let mut remaining_contributions = ctx.accounts.contract.contributions.clone();
    let mut distributed_usdc = 0u64;

    for (index, chunk) in ctx.remaining_accounts.chunks(3).enumerate() {
        let contribution_info = &chunk[0];
        let escrow_info = &chunk[1];
        let escrow_usdc_ata_info = &chunk[2];

        require!(
            contribution_info.owner == ctx.program_id,
            StendarError::InvalidContribution
        );
        require!(
            escrow_info.owner == ctx.program_id,
            StendarError::InvalidContribution
        );
        require!(
            escrow_usdc_ata_info.owner == &token_program.key(),
            StendarError::InvalidContractReference
        );

        let contribution_data = contribution_info.try_borrow_data()?;
        require!(
            contribution_data.len() >= 8
                && &contribution_data[..8] == LenderContribution::DISCRIMINATOR,
            StendarError::InvalidContribution
        );
        let contribution = LenderContribution::try_deserialize(&mut &contribution_data[..])
            .map_err(|_| error!(StendarError::InvalidContribution))?;
        require_current_version(contribution.account_version)?;
        require!(
            contribution.contract == contract_key,
            StendarError::InvalidContribution
        );

        let contribution_key = contribution_info.key();
        let contribution_index = remaining_contributions
            .iter()
            .position(|key| *key == contribution_key)
            .ok_or(StendarError::InvalidContribution)?;
        remaining_contributions.swap_remove(contribution_index);

        let (expected_contribution_pda, _) = Pubkey::find_program_address(
            &[
                b"contribution",
                contract_key.as_ref(),
                contribution.lender.as_ref(),
            ],
            ctx.program_id,
        );
        require!(
            contribution_key == expected_contribution_pda,
            StendarError::InvalidContribution
        );

        let (expected_escrow_pda, _) = Pubkey::find_program_address(
            &[
                b"escrow",
                contract_key.as_ref(),
                contribution.lender.as_ref(),
            ],
            ctx.program_id,
        );
        require!(
            escrow_info.key() == expected_escrow_pda,
            StendarError::InvalidContribution
        );

        let escrow_usdc_data = escrow_usdc_ata_info.try_borrow_data()?;
        let escrow_usdc_ata = TokenAccount::try_deserialize(&mut &escrow_usdc_data[..])
            .map_err(|_| error!(StendarError::InvalidContractReference))?;
        require!(
            escrow_usdc_ata.mint == loan_mint,
            StendarError::InvalidContractReference
        );
        require!(
            escrow_usdc_ata.owner == escrow_info.key(),
            StendarError::TokenAccountMismatch
        );
        drop(escrow_usdc_data);

        let mut escrow_data = escrow_info.try_borrow_mut_data()?;
        require!(
            escrow_data.len() >= 8 && &escrow_data[..8] == LenderEscrow::DISCRIMINATOR,
            StendarError::InvalidContribution
        );
        let mut escrow = LenderEscrow::try_deserialize(&mut &escrow_data[..])
            .map_err(|_| error!(StendarError::InvalidContribution))?;
        require_current_version(escrow.account_version)?;
        require!(
            escrow.contract == contract_key,
            StendarError::InvalidContribution
        );
        require!(
            escrow.lender == contribution.lender,
            StendarError::UnauthorizedClaim
        );
        if escrow.escrow_token_account == Pubkey::default() {
            escrow.escrow_token_account = escrow_usdc_ata_info.key();
        } else {
            require!(
                escrow.escrow_token_account == escrow_usdc_ata_info.key(),
                StendarError::InvalidContractReference
            );
        }

        let lender_share = if index + 1 == contribution_count {
            bot_pays_usdc.saturating_sub(distributed_usdc)
        } else {
            safe_u128_to_u64(
                (contribution.contribution_amount as u128)
                    .checked_mul(bot_pays_usdc as u128)
                    .and_then(|value| value.checked_div(funded_amount as u128))
                    .ok_or(StendarError::ArithmeticOverflow)?,
            )?
        };

        if lender_share > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    Transfer {
                        from: contract_usdc_ata.to_account_info(),
                        to: escrow_usdc_ata_info.clone(),
                        authority: ctx.accounts.contract.to_account_info(),
                    },
                    signer_seeds,
                ),
                lender_share,
            )?;

            escrow.available_principal = escrow
                .available_principal
                .checked_add(lender_share)
                .ok_or(StendarError::ArithmeticOverflow)?;
            escrow.escrow_amount = escrow
                .escrow_amount
                .checked_add(lender_share)
                .ok_or(StendarError::ArithmeticOverflow)?;
        }

        distributed_usdc = distributed_usdc
            .checked_add(lender_share)
            .ok_or(StendarError::ArithmeticOverflow)?;
        escrow.try_serialize(&mut &mut escrow_data[..])?;
    }

    require!(
        remaining_contributions.is_empty(),
        StendarError::InvalidContribution
    );

    {
        let contract = &mut ctx.accounts.contract;
        contract.status = ContractStatus::Liquidated;
        contract.outstanding_balance = contract.outstanding_balance
            .checked_sub(bot_pays_usdc)
            .ok_or(StendarError::ArithmeticOverflow)?;
        contract.collateral_amount = 0;
        contract.update_bot_tracking(current_time);
    }

    let state = &mut ctx.accounts.state;
    state.total_liquidations = state
        .total_liquidations
        .checked_add(1)
        .ok_or(StendarError::ArithmeticOverflow)?;

    let implicit_liquidation_fee = collateral_value_usdc.saturating_sub(bot_pays_usdc);
    {
        let treasury = ctx
            .accounts
            .treasury
            .as_mut()
            .ok_or_else(|| error!(StendarError::InvalidContractReference))?;
        treasury.total_liquidation_fees = treasury
            .total_liquidation_fees
            .checked_add(implicit_liquidation_fee)
            .ok_or(StendarError::ArithmeticOverflow)?;
        treasury.automated_operations = treasury
            .automated_operations
            .checked_add(1)
            .ok_or(StendarError::ArithmeticOverflow)?;
        treasury.total_contracts_processed = treasury
            .total_contracts_processed
            .checked_add(1)
            .ok_or(StendarError::ArithmeticOverflow)?;
        treasury.last_update = current_time;
    }

    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: contract_collateral_ata.to_account_info(),
            destination: borrower_info.clone(),
            authority: ctx.accounts.contract.to_account_info(),
        },
        signer_seeds,
    ))?;

    refund_operations_fund_if_present(
        ctx.program_id,
        contract_key,
        ctx.accounts.operations_fund.as_ref(),
        &borrower_info,
    )?;

    Ok(())
}

fn is_time_liquidation_triggered(
    loan_type: LoanType,
    status: ContractStatus,
    created_at: i64,
    term_days: u32,
    current_time: i64,
) -> Result<bool> {
    let term_seconds = (term_days as i64)
        .checked_mul(24 * 60 * 60)
        .ok_or(StendarError::ArithmeticOverflow)?;
    match loan_type {
        LoanType::Demand => Ok(status == ContractStatus::PendingRecall),
        LoanType::Committed => Ok(current_time
            > created_at
                .checked_add(term_seconds)
                .ok_or(StendarError::ArithmeticOverflow)?),
    }
}

fn calculate_bot_payment(outstanding_balance: u64, collateral_value_usdc: u64) -> u64 {
    std::cmp::min(outstanding_balance, collateral_value_usdc)
}

fn refund_operations_fund_if_present<'info>(
    program_id: &Pubkey,
    contract_key: Pubkey,
    operations_fund: Option<&AccountInfo<'info>>,
    borrower_info: &AccountInfo<'info>,
) -> Result<()> {
    if let Some(ops_info) = operations_fund {
        let ops_info = ops_info.clone();
        if ops_info.data_len() > 0 {
            let (expected_ops_pda, _) = Pubkey::find_program_address(
                &[OPERATIONS_FUND_SEED, contract_key.as_ref()],
                program_id,
            );
            require!(
                ops_info.key() == expected_ops_pda,
                StendarError::InvalidContractReference
            );
            require!(
                ops_info.owner == program_id,
                StendarError::InvalidContractReference
            );
            {
                let data = ops_info.try_borrow_data()?;
                require!(
                    data.len() >= 8 && &data[..8] == ContractOperationsFund::DISCRIMINATOR,
                    StendarError::InvalidContractReference
                );
            }

            let ops_balance = ops_info.lamports();
            if ops_balance > 0 {
                **ops_info.try_borrow_mut_lamports()? -= ops_balance;
                **borrower_info.try_borrow_mut_lamports()? += ops_balance;
            }
            ops_info.realloc(0, false)?;
        }
    }
    Ok(())
}

pub fn partial_liquidate<'info>(
    ctx: Context<'_, '_, 'info, 'info, PartialLiquidate<'info>>,
    repay_amount: u64,
) -> Result<()> {
    require!(repay_amount > 0, StendarError::InvalidPaymentAmount);

    require_current_version(ctx.accounts.contract.account_version)?;
    require_current_version(ctx.accounts.state.account_version)?;
    require_current_version(ctx.accounts.treasury.account_version)?;

    require!(
        ctx.accounts.treasury.bot_authority == ctx.accounts.bot_authority.key(),
        StendarError::UnauthorizedBotOperation
    );

    let contract_key = ctx.accounts.contract.key();
    let contract = &ctx.accounts.contract;

    require!(
        contract.status == ContractStatus::Active,
        StendarError::ContractNotFunded
    );
    require!(
        contract.borrower == ctx.accounts.borrower.key(),
        StendarError::InvalidContractReference
    );
    require!(
        contract.outstanding_balance > 0,
        StendarError::InvalidPaymentAmount
    );

    // Validate token account relationships up front to prevent account substitution.
    require!(
        ctx.accounts.contract_usdc_ata.owner == contract_key,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.contract_usdc_ata.mint == contract.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.bot_usdc_ata.owner == ctx.accounts.bot_authority.key(),
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.bot_usdc_ata.mint == contract.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.contract_collateral_ata.owner == contract_key,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.contract_collateral_ata.mint == contract.collateral_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.bot_collateral_ata.owner == ctx.accounts.bot_authority.key(),
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.bot_collateral_ata.mint == contract.collateral_mint,
        StendarError::TokenAccountMismatch
    );

    let collateral_type = ctx
        .accounts
        .collateral_registry
        .find_collateral_type(&contract.collateral_mint)
        .ok_or(StendarError::CollateralTypeNotFound)?;
    require!(
        collateral_type.is_active,
        StendarError::CollateralTypeNotFound
    );
    require!(
        ctx.accounts.price_feed_account.key() == collateral_type.oracle_price_feed,
        StendarError::OraclePriceFeedMismatch
    );

    let (price, exponent) =
        get_price_in_usdc(&ctx.accounts.price_feed_account, MAX_PRICE_AGE_LIQUIDATION)?;
    let actual_collateral = std::cmp::min(
        ctx.accounts.contract_collateral_ata.amount,
        contract.collateral_amount,
    );
    let collateral_value_usdc = calculate_collateral_value_in_usdc(
        actual_collateral,
        collateral_type.decimals,
        price,
        exponent,
    )?;
    let current_ltv = calculate_ltv_bps(collateral_value_usdc, contract.outstanding_balance)?;
    let health = check_health(
        current_ltv,
        contract.ltv_floor_bps,
        collateral_type.liquidation_buffer_bps,
    );
    require!(
        health != HealthStatus::Healthy,
        StendarError::PositionHealthy
    );

    let max_repay = safe_u128_to_u64(
        (contract.outstanding_balance as u128)
            .checked_mul(PARTIAL_LIQUIDATION_CAP_BPS as u128)
            .and_then(|value| value.checked_div(10_000))
            .ok_or(StendarError::ArithmeticOverflow)?,
    )?;
    let capped_repay = std::cmp::min(repay_amount, max_repay);
    require!(capped_repay > 0, StendarError::InvalidPaymentAmount);

    let collateral_to_seize = calculate_collateral_to_seize(
        capped_repay,
        actual_collateral,
        collateral_value_usdc,
        LIQUIDATION_FEE_BPS,
    )?;
    let actual_seize = std::cmp::min(collateral_to_seize, actual_collateral);
    require!(
        actual_seize > 0,
        StendarError::InsufficientCollateralForLiquidation
    );

    let contract_seed_bytes = contract.contract_seed.to_le_bytes();
    let (expected_contract_pda, contract_bump) = Pubkey::find_program_address(
        &[
            b"debt_contract",
            contract.borrower.as_ref(),
            &contract_seed_bytes,
        ],
        ctx.program_id,
    );
    require!(
        expected_contract_pda == contract_key,
        StendarError::InvalidContractReference
    );
    let contract_bump_bytes = [contract_bump];
    let contract_signer_seeds: &[&[u8]] = &[
        b"debt_contract",
        contract.borrower.as_ref(),
        &contract_seed_bytes,
        &contract_bump_bytes,
    ];
    let signer_seeds = &[contract_signer_seeds];

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bot_usdc_ata.to_account_info(),
                to: ctx.accounts.contract_usdc_ata.to_account_info(),
                authority: ctx.accounts.bot_authority.to_account_info(),
            },
        ),
        capped_repay,
    )?;

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.contract_collateral_ata.to_account_info(),
                to: ctx.accounts.bot_collateral_ata.to_account_info(),
                authority: ctx.accounts.contract.to_account_info(),
            },
            signer_seeds,
        ),
        actual_seize,
    )?;

    let funded_amount = contract.funded_amount;
    require!(funded_amount > 0, StendarError::InvalidContributionAmount);

    let expected_contributions = contract.contributions.len();
    let expected_remaining_accounts = expected_contributions
        .checked_mul(3)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(
        ctx.remaining_accounts.len() == expected_remaining_accounts,
        StendarError::InvalidContribution
    );

    let mut remaining_contributions = contract.contributions.clone();
    for chunk in ctx.remaining_accounts.chunks(3) {
        let contribution_info = &chunk[0];
        let escrow_info = &chunk[1];
        let escrow_usdc_ata_info = &chunk[2];
        let contribution_key = contribution_info.key();

        let contribution_index = remaining_contributions
            .iter()
            .position(|key| *key == contribution_key)
            .ok_or(StendarError::InvalidContribution)?;
        remaining_contributions.swap_remove(contribution_index);

        require!(
            contribution_info.owner == ctx.program_id,
            StendarError::InvalidContribution
        );
        require!(
            escrow_info.owner == ctx.program_id,
            StendarError::InvalidContribution
        );

        let contribution_data = contribution_info.try_borrow_data()?;
        let contribution = LenderContribution::try_deserialize(&mut &contribution_data[..])
            .map_err(|_| error!(StendarError::InvalidContribution))?;
        require_current_version(contribution.account_version)?;
        require!(
            contribution.contract == contract_key,
            StendarError::InvalidContribution
        );

        let (expected_contribution_pda, _) = Pubkey::find_program_address(
            &[
                b"contribution",
                contract_key.as_ref(),
                contribution.lender.as_ref(),
            ],
            ctx.program_id,
        );
        require!(
            contribution_key == expected_contribution_pda,
            StendarError::InvalidContribution
        );

        let (expected_escrow_pda, _) = Pubkey::find_program_address(
            &[
                b"escrow",
                contract_key.as_ref(),
                contribution.lender.as_ref(),
            ],
            ctx.program_id,
        );
        require!(
            escrow_info.key() == expected_escrow_pda,
            StendarError::InvalidContribution
        );

        let escrow_data = escrow_info.try_borrow_data()?;
        let escrow = LenderEscrow::try_deserialize(&mut &escrow_data[..])
            .map_err(|_| error!(StendarError::InvalidContribution))?;
        require_current_version(escrow.account_version)?;
        require!(
            escrow.contract == contract_key,
            StendarError::InvalidContribution
        );
        require!(
            escrow.lender == contribution.lender,
            StendarError::UnauthorizedClaim
        );
        drop(escrow_data);

        let escrow_usdc_ata = Account::<TokenAccount>::try_from(escrow_usdc_ata_info)
            .map_err(|_| error!(StendarError::TokenAccountMismatch))?;
        require!(
            escrow_usdc_ata.owner == escrow_info.key(),
            StendarError::TokenAccountMismatch
        );
        require!(
            escrow_usdc_ata.mint == contract.loan_mint,
            StendarError::TokenAccountMismatch
        );
        if escrow.escrow_token_account != Pubkey::default() {
            require!(
                escrow.escrow_token_account == escrow_usdc_ata.key(),
                StendarError::TokenAccountMismatch
            );
        }

        let lender_share = safe_u128_to_u64(
            (contribution.contribution_amount as u128)
                .checked_mul(capped_repay as u128)
                .and_then(|value| value.checked_div(funded_amount as u128))
                .ok_or(StendarError::ArithmeticOverflow)?,
        )?;

        if lender_share > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.contract_usdc_ata.to_account_info(),
                        to: escrow_usdc_ata.to_account_info(),
                        authority: ctx.accounts.contract.to_account_info(),
                    },
                    signer_seeds,
                ),
                lender_share,
            )?;

            let mut escrow_data = escrow_info.try_borrow_mut_data()?;
            let mut escrow_state = LenderEscrow::try_deserialize(&mut &escrow_data[..])
                .map_err(|_| error!(StendarError::InvalidContribution))?;
            require_current_version(escrow_state.account_version)?;
            escrow_state.available_principal = escrow_state
                .available_principal
                .checked_add(lender_share)
                .ok_or(StendarError::ArithmeticOverflow)?;
            escrow_state.escrow_amount = escrow_state
                .escrow_amount
                .checked_add(lender_share)
                .ok_or(StendarError::ArithmeticOverflow)?;
            if escrow_state.escrow_token_account == Pubkey::default() {
                escrow_state.escrow_token_account = escrow_usdc_ata.key();
            }
            escrow_state.try_serialize(&mut &mut escrow_data[..])?;
        }
    }

    require!(
        remaining_contributions.is_empty(),
        StendarError::InvalidContribution
    );

    let current_time = Clock::get()?.unix_timestamp;
    {
        let contract = &mut ctx.accounts.contract;
        contract.outstanding_balance = contract
            .outstanding_balance
            .checked_sub(capped_repay)
            .ok_or(StendarError::ArithmeticOverflow)?;
        contract.collateral_amount = contract
            .collateral_amount
            .checked_sub(actual_seize)
            .ok_or(StendarError::ArithmeticOverflow)?;
        contract.total_principal_paid = contract
            .total_principal_paid
            .checked_add(capped_repay)
            .ok_or(StendarError::ArithmeticOverflow)?;
        if contract.outstanding_balance == 0 {
            contract.status = ContractStatus::Completed;
        }
        contract.update_bot_tracking(current_time);
    }

    let liquidation_fee_usdc = safe_u128_to_u64(
        (capped_repay as u128)
            .checked_mul(LIQUIDATION_FEE_BPS as u128)
            .and_then(|value| value.checked_div(10_000))
            .ok_or(StendarError::ArithmeticOverflow)?,
    )?;

    ctx.accounts.state.total_liquidations = ctx
        .accounts
        .state
        .total_liquidations
        .checked_add(1)
        .ok_or(StendarError::ArithmeticOverflow)?;
    ctx.accounts.treasury.total_liquidation_fees = ctx
        .accounts
        .treasury
        .total_liquidation_fees
        .checked_add(liquidation_fee_usdc)
        .ok_or(StendarError::ArithmeticOverflow)?;
    ctx.accounts.treasury.last_update = current_time;

    Ok(())
}

pub fn request_recall(ctx: Context<RequestRecall>) -> Result<()> {
    let current_time = Clock::get()?.unix_timestamp;
    let lender_key = ctx.accounts.lender.key();

    let contract = &mut ctx.accounts.contract;
    require_current_version(contract.account_version)?;
    require_current_version(ctx.accounts.contribution.account_version)?;
    validate_demand_recall_contract(contract)?;
    require!(
        !contract.recall_requested,
        StendarError::RecallAlreadyPending
    );
    require!(
        contract.status == ContractStatus::Active,
        StendarError::ContractNotFunded
    );
    require!(
        ctx.accounts.contribution.contribution_amount > 0,
        StendarError::InvalidContributionAmount
    );

    contract.recall_requested = true;
    contract.recall_requested_at = current_time;
    contract.recall_requested_by = lender_key;
    contract.status = ContractStatus::PendingRecall;
    contract.update_bot_tracking(current_time);

    msg!(
        "Recall requested by lender {} on contract {}",
        lender_key,
        contract.contract_seed
    );
    Ok(())
}

pub fn borrower_repay_recall(ctx: Context<BorrowerRepayRecall>) -> Result<()> {
    require_current_version(ctx.accounts.contract.account_version)?;
    require_current_version(ctx.accounts.contribution.account_version)?;
    require_current_version(ctx.accounts.escrow.account_version)?;
    require_current_version(ctx.accounts.state.account_version)?;

    let current_time = with_test_clock_offset(
        Clock::get()?.unix_timestamp,
        ctx.accounts.state.authority,
        ctx.accounts.test_clock_offset.as_deref(),
    )?;
    {
        let contract = &ctx.accounts.contract;
        validate_demand_recall_contract(contract)?;
        require!(
            contract.status == ContractStatus::PendingRecall,
            StendarError::NoRecallPending
        );
        require!(contract.recall_requested, StendarError::NoRecallPending);

        let grace_end = contract
            .recall_requested_at
            .checked_add(RECALL_GRACE_PERIOD_SECONDS)
            .ok_or(StendarError::ArithmeticOverflow)?;
        require!(
            current_time < grace_end,
            StendarError::RecallGracePeriodElapsed
        );
        require!(
            ctx.accounts.contribution.lender == contract.recall_requested_by,
            StendarError::InvalidContribution
        );
        require!(
            ctx.accounts.escrow.lender == contract.recall_requested_by,
            StendarError::UnauthorizedClaim
        );
    }

    let repay_amount = ctx.accounts.contribution.contribution_amount;
    require!(repay_amount > 0, StendarError::InvalidContributionAmount);

    // Keep escrow token account pinned once it is first observed.
    {
        let escrow = &mut ctx.accounts.escrow;
        if escrow.escrow_token_account == Pubkey::default() {
            escrow.escrow_token_account = ctx.accounts.escrow_usdc_ata.key();
        } else {
            require!(
                escrow.escrow_token_account == ctx.accounts.escrow_usdc_ata.key(),
                StendarError::TokenAccountMismatch
            );
        }
    }

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.borrower_usdc_ata.to_account_info(),
                to: ctx.accounts.escrow_usdc_ata.to_account_info(),
                authority: ctx.accounts.borrower.to_account_info(),
            },
        ),
        repay_amount,
    )?;

    let funded_amount = ctx.accounts.contract.funded_amount;
    let total_collateral = ctx.accounts.contract.collateral_amount;
    let collateral_to_return =
        calculate_proportional_collateral(repay_amount, funded_amount, total_collateral)?;

    if collateral_to_return > 0 {
        let contract = &ctx.accounts.contract;
        let contract_seed_bytes = contract.contract_seed.to_le_bytes();
        let (expected_contract_pda, contract_bump) = Pubkey::find_program_address(
            &[
                b"debt_contract",
                contract.borrower.as_ref(),
                &contract_seed_bytes,
            ],
            ctx.program_id,
        );
        require!(
            expected_contract_pda == contract.key(),
            StendarError::InvalidContractReference
        );
        let bump_seed = [contract_bump];
        let signer_seeds: &[&[u8]] = &[
            b"debt_contract",
            contract.borrower.as_ref(),
            &contract_seed_bytes,
            &bump_seed,
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.contract_collateral_ata.to_account_info(),
                    to: ctx.accounts.borrower_collateral_ata.to_account_info(),
                    authority: ctx.accounts.contract.to_account_info(),
                },
                &[signer_seeds],
            ),
            collateral_to_return,
        )?;
    }

    let escrow = &mut ctx.accounts.escrow;
    escrow.available_principal = escrow
        .available_principal
        .checked_add(repay_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    escrow.escrow_amount = escrow
        .escrow_amount
        .checked_add(repay_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;

    let contribution_key = ctx.accounts.contribution.key();
    let contract = &mut ctx.accounts.contract;
    contract.outstanding_balance = contract
        .outstanding_balance
        .checked_sub(repay_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.collateral_amount = contract
        .collateral_amount
        .checked_sub(collateral_to_return)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.funded_amount = contract
        .funded_amount
        .checked_sub(repay_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;

    let contribution = &mut ctx.accounts.contribution;
    contribution.is_refunded = true;

    let index = contract
        .contributions
        .iter()
        .position(|key| *key == contribution_key)
        .ok_or(StendarError::InvalidContribution)?;
    contract.contributions.swap_remove(index);
    contract.num_contributions = u32::try_from(contract.contributions.len())
        .map_err(|_| error!(StendarError::ArithmeticOverflow))?;

    contract.recall_requested = false;
    contract.recall_requested_at = 0;
    contract.recall_requested_by = Pubkey::default();
    contract.status = if contract.outstanding_balance == 0 || contract.contributions.is_empty() {
        ContractStatus::Completed
    } else {
        ContractStatus::Active
    };
    contract.update_bot_tracking(current_time);

    let state = &mut ctx.accounts.state;
    state.total_debt = state.total_debt
        .checked_sub(repay_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    state.total_collateral = state.total_collateral
        .checked_sub(collateral_to_return)
        .ok_or(StendarError::ArithmeticOverflow)?;

    Ok(())
}

pub fn process_recall(ctx: Context<ProcessRecall>) -> Result<()> {
    require_current_version(ctx.accounts.contract.account_version)?;
    require_current_version(ctx.accounts.contribution.account_version)?;
    require_current_version(ctx.accounts.escrow.account_version)?;
    require_current_version(ctx.accounts.state.account_version)?;
    require_current_version(ctx.accounts.treasury.account_version)?;

    require!(
        ctx.accounts.treasury.bot_authority == ctx.accounts.bot_authority.key(),
        StendarError::UnauthorizedBotOperation
    );

    let current_time = with_test_clock_offset(
        Clock::get()?.unix_timestamp,
        ctx.accounts.state.authority,
        ctx.accounts.test_clock_offset.as_deref(),
    )?;
    let treasury = &mut ctx.accounts.treasury;
    if treasury.usdc_mint == Pubkey::default() {
        treasury.usdc_mint = ctx.accounts.contract.loan_mint;
    } else {
        require!(
            treasury.usdc_mint == ctx.accounts.contract.loan_mint,
            StendarError::InvalidUsdcMint
        );
    }
    if treasury.treasury_usdc_account == Pubkey::default() {
        treasury.treasury_usdc_account = ctx.accounts.treasury_usdc_ata.key();
    } else {
        require!(
            treasury.treasury_usdc_account == ctx.accounts.treasury_usdc_ata.key(),
            StendarError::TokenAccountMismatch
        );
    }
    require!(
        ctx.accounts.treasury_usdc_ata.owner == treasury.key(),
        StendarError::TokenAccountMismatch
    );

    {
        let contract = &ctx.accounts.contract;
        validate_demand_recall_contract(contract)?;
        require!(
            contract.status == ContractStatus::PendingRecall,
            StendarError::NoRecallPending
        );
        require!(contract.recall_requested, StendarError::NoRecallPending);

        let grace_end = contract
            .recall_requested_at
            .checked_add(RECALL_GRACE_PERIOD_SECONDS)
            .ok_or(StendarError::ArithmeticOverflow)?;
        require!(
            current_time >= grace_end,
            StendarError::RecallGracePeriodNotElapsed
        );
        require!(
            ctx.accounts.contribution.lender == contract.recall_requested_by,
            StendarError::InvalidContribution
        );
        require!(
            ctx.accounts.escrow.lender == contract.recall_requested_by,
            StendarError::UnauthorizedClaim
        );
    }

    let recall_amount = ctx.accounts.contribution.contribution_amount;
    require!(recall_amount > 0, StendarError::InvalidContributionAmount);
    let recall_fee = calculate_recall_fee(recall_amount)?;
    let lender_receives = recall_amount
        .checked_sub(recall_fee)
        .ok_or(StendarError::ArithmeticOverflow)?;

    let funded_amount = ctx.accounts.contract.funded_amount;
    let total_collateral = ctx.accounts.contract.collateral_amount;
    let proportional_collateral =
        calculate_proportional_collateral(recall_amount, funded_amount, total_collateral)?;

    // Keep escrow token account pinned once it is first observed.
    {
        let escrow = &mut ctx.accounts.escrow;
        if escrow.escrow_token_account == Pubkey::default() {
            escrow.escrow_token_account = ctx.accounts.escrow_usdc_ata.key();
        } else {
            require!(
                escrow.escrow_token_account == ctx.accounts.escrow_usdc_ata.key(),
                StendarError::TokenAccountMismatch
            );
        }
    }

    if lender_receives > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bot_usdc_ata.to_account_info(),
                    to: ctx.accounts.escrow_usdc_ata.to_account_info(),
                    authority: ctx.accounts.bot_authority.to_account_info(),
                },
            ),
            lender_receives,
        )?;
    }

    if recall_fee > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bot_usdc_ata.to_account_info(),
                    to: ctx.accounts.treasury_usdc_ata.to_account_info(),
                    authority: ctx.accounts.bot_authority.to_account_info(),
                },
            ),
            recall_fee,
        )?;
    }

    if proportional_collateral > 0 {
        let contract = &ctx.accounts.contract;
        let contract_seed_bytes = contract.contract_seed.to_le_bytes();
        let (expected_contract_pda, contract_bump) = Pubkey::find_program_address(
            &[
                b"debt_contract",
                contract.borrower.as_ref(),
                &contract_seed_bytes,
            ],
            ctx.program_id,
        );
        require!(
            expected_contract_pda == contract.key(),
            StendarError::InvalidContractReference
        );
        let bump_seed = [contract_bump];
        let signer_seeds: &[&[u8]] = &[
            b"debt_contract",
            contract.borrower.as_ref(),
            &contract_seed_bytes,
            &bump_seed,
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.contract_collateral_ata.to_account_info(),
                    to: ctx.accounts.bot_collateral_ata.to_account_info(),
                    authority: ctx.accounts.contract.to_account_info(),
                },
                &[signer_seeds],
            ),
            proportional_collateral,
        )?;
    }

    let escrow = &mut ctx.accounts.escrow;
    escrow.available_principal = escrow
        .available_principal
        .checked_add(lender_receives)
        .ok_or(StendarError::ArithmeticOverflow)?;
    escrow.escrow_amount = escrow
        .escrow_amount
        .checked_add(lender_receives)
        .ok_or(StendarError::ArithmeticOverflow)?;

    let contribution_key = ctx.accounts.contribution.key();
    let contract = &mut ctx.accounts.contract;
    contract.outstanding_balance = contract
        .outstanding_balance
        .checked_sub(recall_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.collateral_amount = contract
        .collateral_amount
        .checked_sub(proportional_collateral)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.funded_amount = contract
        .funded_amount
        .checked_sub(recall_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;

    let contribution = &mut ctx.accounts.contribution;
    contribution.is_refunded = true;
    let recalled_lender = contribution.lender;

    let index = contract
        .contributions
        .iter()
        .position(|key| *key == contribution_key)
        .ok_or(StendarError::InvalidContribution)?;
    contract.contributions.swap_remove(index);
    contract.num_contributions = u32::try_from(contract.contributions.len())
        .map_err(|_| error!(StendarError::ArithmeticOverflow))?;

    contract.recall_requested = false;
    contract.recall_requested_at = 0;
    contract.recall_requested_by = Pubkey::default();
    contract.status = if contract.outstanding_balance == 0 || contract.contributions.is_empty() {
        ContractStatus::Completed
    } else {
        ContractStatus::Active
    };
    contract.update_bot_tracking(current_time);
    let contract_seed = contract.contract_seed;

    let state = &mut ctx.accounts.state;
    state.total_debt = state.total_debt
        .checked_sub(recall_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    state.total_collateral = state.total_collateral
        .checked_sub(proportional_collateral)
        .ok_or(StendarError::ArithmeticOverflow)?;

    treasury.total_recall_fees = treasury
        .total_recall_fees
        .checked_add(recall_fee)
        .ok_or(StendarError::ArithmeticOverflow)?;

    msg!(
        "Processed recall for lender {} on contract {}, amount {}, fee {}",
        recalled_lender,
        contract_seed,
        recall_amount,
        recall_fee
    );

    Ok(())
}

pub fn recall_demand_contribution(ctx: Context<RecallDemandContribution>) -> Result<()> {
    let contract_info = ctx.accounts.contract.to_account_info();
    let escrow_info = ctx.accounts.escrow.to_account_info();
    let contract_key = ctx.accounts.contract.key();
    let borrower_info = ctx.accounts.borrower.to_account_info();

    let contract = &mut ctx.accounts.contract;
    let contribution = &mut ctx.accounts.contribution;
    let escrow = &mut ctx.accounts.escrow;
    let state = &mut ctx.accounts.state;
    require_current_version(contract.account_version)?;
    require_current_version(contribution.account_version)?;
    require_current_version(escrow.account_version)?;
    require_current_version(state.account_version)?;

    require!(
        contract.status == ContractStatus::Active,
        StendarError::ContractNotFunded
    );
    require!(
        contract.loan_type == LoanType::Demand,
        StendarError::RecallNotAllowed
    );
    // This recall flow is deprecated; standard contracts must use request_recall/process_recall.
    require!(false, StendarError::InvalidContractVersion);
    require!(!contribution.is_refunded, StendarError::AlreadyRefunded);

    let current_time = Clock::get()?.unix_timestamp;
    process_automatic_interest(contract, current_time)?;

    let total_funded = contract.funded_amount;
    require!(total_funded > 0, StendarError::InvalidContributionAmount);

    let contribution_amount = contribution.contribution_amount;
    let remaining_collateral = contract.collateral_amount;

    let lender_share = safe_u128_to_u64(
        (contribution_amount as u128)
            .checked_mul(remaining_collateral as u128)
            .and_then(|value| value.checked_div(total_funded as u128))
            .ok_or(StendarError::ArithmeticOverflow)?,
    )?;

    // Only distribute tracked collateral; never drain rent reserve.
    let rent_minimum = Rent::get()?.minimum_balance(contract_info.data_len());
    let max_distributable = contract_info.lamports().saturating_sub(rent_minimum);
    require!(
        max_distributable >= lender_share,
        StendarError::InsufficientFunds
    );

    if lender_share > 0 {
        **contract_info.try_borrow_mut_lamports()? -= lender_share;
        **escrow_info.try_borrow_mut_lamports()? += lender_share;

        escrow.available_principal = escrow
            .available_principal
            .checked_add(lender_share)
            .ok_or(StendarError::ArithmeticOverflow)?;
        escrow.escrow_amount = escrow
            .escrow_amount
            .checked_add(lender_share)
            .ok_or(StendarError::ArithmeticOverflow)?;

        contract.collateral_amount = contract.collateral_amount
            .checked_sub(lender_share)
            .ok_or(StendarError::ArithmeticOverflow)?;
    }

    contract.funded_amount = contract.funded_amount
        .checked_sub(contribution_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.outstanding_balance = contract.outstanding_balance
        .checked_sub(contribution_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;

    contribution.is_refunded = true;

    let contribution_key = contribution.key();
    if let Some(index) = contract
        .contributions
        .iter()
        .position(|key| *key == contribution_key)
    {
        contract.contributions.swap_remove(index);
    } else {
        return Err(StendarError::InvalidContribution.into());
    }
    contract.num_contributions = contract.contributions.len() as u32;

    let mut became_liquidated = false;
    if contract.contributions.is_empty() || contract.funded_amount == 0 {
        contract.status = ContractStatus::Liquidated;
        state.total_liquidations = state
            .total_liquidations
            .checked_add(1)
            .ok_or(StendarError::ArithmeticOverflow)?;
        became_liquidated = true;
    }

    if became_liquidated {
        refund_operations_fund_if_present(
            ctx.program_id,
            contract_key,
            ctx.accounts.operations_fund.as_ref(),
            &borrower_info,
        )?;
    }

    let should_close_operations_fund = matches!(
        contract.status,
        ContractStatus::Completed | ContractStatus::Liquidated
    );
    contract.update_bot_tracking(current_time);

    if should_close_operations_fund {
        if let Some(ops_info) = ctx.accounts.operations_fund.as_ref() {
            let ops_info = ops_info.clone();
            if ops_info.data_len() > 0 {
                let contract_key = contract.key();
                let (expected_ops_pda, _) = Pubkey::find_program_address(
                    &[OPERATIONS_FUND_SEED, contract_key.as_ref()],
                    ctx.program_id,
                );
                require!(
                    ops_info.key() == expected_ops_pda,
                    StendarError::InvalidContractReference
                );
                require!(
                    ops_info.owner == ctx.program_id,
                    StendarError::InvalidContractReference
                );
                {
                    let data = ops_info.try_borrow_data()?;
                    require!(
                        data.len() >= 8 && &data[..8] == ContractOperationsFund::DISCRIMINATOR,
                        StendarError::InvalidContractReference
                    );
                }

                let ops_balance = ops_info.lamports();
                if ops_balance > 0 {
                    **ops_info.try_borrow_mut_lamports()? -= ops_balance;
                    **borrower_info.try_borrow_mut_lamports()? += ops_balance;
                }
                ops_info.realloc(0, false)?;
            }
        }
    }
    Ok(())
}

pub fn update_contract_state(ctx: Context<UpdateContractState>) -> Result<()> {
    let contract = &mut ctx.accounts.contract;
    require_current_version(contract.account_version)?;

    require!(
        contract.status == ContractStatus::Active,
        StendarError::ContractNotFunded
    );

    let current_time = Clock::get()?.unix_timestamp;
    process_automatic_interest(contract, current_time)?;
    process_scheduled_principal_payments(contract, current_time)?;
    contract.update_bot_tracking(current_time);

    Ok(())
}

pub fn distribute_to_escrows(ctx: Context<DistributeToEscrows>) -> Result<()> {
    let contract = &mut ctx.accounts.contract;
    require_current_version(contract.account_version)?;

    require!(
        contract.status == ContractStatus::Active,
        StendarError::ContractNotFunded
    );

    let current_time = Clock::get()?.unix_timestamp;
    process_automatic_interest(contract, current_time)?;
    process_scheduled_principal_payments(contract, current_time)?;

    Ok(())
}

pub fn claim_from_escrow(ctx: Context<ClaimFromEscrow>) -> Result<()> {
    let lender_key = ctx.accounts.lender.key();
    let contract_key = ctx.accounts.contract.key();
    let program_id = ctx.program_id;
    let escrow_info = ctx.accounts.escrow.to_account_info();
    let lender_info = ctx.accounts.lender.to_account_info();

    require!(
        escrow_info.owner == program_id,
        StendarError::InvalidContribution
    );

    let escrow_key = escrow_info.key();
    let (expected_escrow_pda, _escrow_bump) = Pubkey::find_program_address(
        &[b"escrow", contract_key.as_ref(), lender_key.as_ref()],
        program_id,
    );
    require!(
        escrow_key == expected_escrow_pda,
        StendarError::InvalidContribution
    );

    let mut escrow = {
        let data = escrow_info.try_borrow_data()?;
        require!(data.len() >= 8, StendarError::InvalidContribution);
        require!(
            &data[..8] == LenderEscrow::DISCRIMINATOR,
            StendarError::InvalidContribution
        );

        let parsed = LenderEscrow::try_deserialize(&mut &data[..])
            .map_err(|_| StendarError::InvalidContribution)?;
        require_current_version(parsed.account_version)?;
        parsed
    };

    require!(
        escrow.contract == contract_key,
        StendarError::InvalidContribution
    );
    require!(escrow.lender == lender_key, StendarError::UnauthorizedClaim);

    let total_available = escrow
        .available_interest
        .checked_add(escrow.available_principal)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(total_available > 0, StendarError::NoPaymentDue);

    // If the contract is finished (no future distributions) and this escrow will be settled,
    // close it to return rent to the lender.
    let will_settle = escrow.escrow_amount == total_available;
    let should_close = (ctx.accounts.contract.status == ContractStatus::Completed
        || ctx.accounts.contract.status == ContractStatus::Liquidated)
        && will_settle;

    let token_program = ctx
        .accounts
        .token_program
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let escrow_usdc_account = ctx
        .accounts
        .escrow_usdc_account
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let lender_usdc_account = ctx
        .accounts
        .lender_usdc_account
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;

    require!(
        escrow.escrow_token_account != Pubkey::default(),
        StendarError::MissingTokenAccounts
    );
    require!(
        escrow.escrow_token_account == escrow_usdc_account.key(),
        StendarError::TokenAccountMismatch
    );
    require!(
        escrow_usdc_account.owner == escrow_key
            && escrow_usdc_account.mint == ctx.accounts.contract.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        lender_usdc_account.owner == lender_key
            && lender_usdc_account.mint == ctx.accounts.contract.loan_mint,
        StendarError::TokenAccountMismatch
    );

    let (expected_escrow_pda, escrow_bump) = Pubkey::find_program_address(
        &[b"escrow", contract_key.as_ref(), lender_key.as_ref()],
        program_id,
    );
    require!(
        expected_escrow_pda == escrow_key,
        StendarError::InvalidContribution
    );
    let escrow_bump_bytes = [escrow_bump];
    let signer_seeds: &[&[u8]] = &[
        b"escrow",
        contract_key.as_ref(),
        lender_key.as_ref(),
        &escrow_bump_bytes,
    ];

    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: escrow_usdc_account.to_account_info(),
                to: lender_usdc_account.to_account_info(),
                authority: escrow_info.clone(),
            },
            &[signer_seeds],
        ),
        total_available,
    )?;

    if should_close {
        token::close_account(CpiContext::new_with_signer(
            token_program.to_account_info(),
            CloseAccount {
                account: escrow_usdc_account.to_account_info(),
                destination: lender_info.clone(),
                authority: escrow_info.clone(),
            },
            &[signer_seeds],
        ))?;
    }

    if should_close {
        // Drain the remaining rent reserve and reclaim the account.
        let remaining = escrow_info.lamports();
        if remaining > 0 {
            **escrow_info.try_borrow_mut_lamports()? -= remaining;
            **lender_info.try_borrow_mut_lamports()? += remaining;
        }
        escrow_info.realloc(0, false)?;
        return Ok(());
    }

    escrow.total_claimed = escrow
        .total_claimed
        .checked_add(total_available)
        .ok_or(StendarError::ArithmeticOverflow)?;
    escrow.escrow_amount = escrow.escrow_amount.saturating_sub(total_available);
    escrow.available_interest = 0;
    escrow.available_principal = 0;

    let mut data = escrow_info.try_borrow_mut_data()?;
    escrow.try_serialize(&mut &mut data[..])?;

    Ok(())
}

pub fn update_lender_escrow(ctx: Context<UpdateLenderEscrow>) -> Result<()> {
    let contract = &ctx.accounts.contract;
    let contribution = &ctx.accounts.contribution;
    let escrow = &mut ctx.accounts.escrow;
    require_current_version(contract.account_version)?;
    require_current_version(contribution.account_version)?;
    require_current_version(escrow.account_version)?;

    require!(
        contract.status == ContractStatus::Active,
        StendarError::ContractNotFunded
    );

    let lender_share = contribution.contribution_amount;
    let total_funded = contract.funded_amount;

    if total_funded > 0 {
        let total_interest = contract.accrued_interest;
        let total_entitled_interest = crate::utils::safe_u128_to_u64(
            (lender_share as u128)
                .checked_mul(total_interest as u128)
                .and_then(|v| v.checked_div(total_funded as u128))
                .ok_or(StendarError::ArithmeticOverflow)?,
        )?;

        let total_principal = contract.total_principal_paid;
        let total_entitled_principal = crate::utils::safe_u128_to_u64(
            (lender_share as u128)
                .checked_mul(total_principal as u128)
                .and_then(|v| v.checked_div(total_funded as u128))
                .ok_or(StendarError::ArithmeticOverflow)?,
        )?;

        let already_distributed_interest = contribution
            .total_interest_claimed
            .checked_add(escrow.available_interest)
            .ok_or(StendarError::ArithmeticOverflow)?;
        let new_interest = total_entitled_interest.saturating_sub(already_distributed_interest);

        let already_distributed_principal = contribution
            .total_principal_claimed
            .checked_add(escrow.available_principal)
            .ok_or(StendarError::ArithmeticOverflow)?;
        let new_principal = total_entitled_principal.saturating_sub(already_distributed_principal);

        escrow.available_interest = escrow
            .available_interest
            .checked_add(new_interest)
            .ok_or(StendarError::ArithmeticOverflow)?;
        escrow.available_principal = escrow
            .available_principal
            .checked_add(new_principal)
            .ok_or(StendarError::ArithmeticOverflow)?;
    }

    Ok(())
}

pub fn refund_lender<'info>(ctx: Context<'_, '_, '_, 'info, RefundLender<'info>>) -> Result<()> {
    let contract_info = ctx.accounts.contract.to_account_info();
    let lender_info = ctx.accounts.lender.to_account_info();
    let contract = &mut ctx.accounts.contract;
    let contribution = &mut ctx.accounts.contribution;
    require_current_version(contract.account_version)?;
    require_current_version(contribution.account_version)?;

    require!(
        contract.status == ContractStatus::Cancelled,
        StendarError::ContractNotCancelled
    );
    require!(
        contribution.lender == ctx.accounts.lender.key(),
        StendarError::UnauthorizedClaim
    );
    require!(
        contribution.contract == contract.key(),
        StendarError::InvalidContribution
    );
    require!(!contribution.is_refunded, StendarError::AlreadyRefunded);

    let refund_amount = contribution.contribution_amount;
    let token_program = ctx
        .accounts
        .token_program
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let contract_usdc_account = ctx
        .accounts
        .contract_usdc_account
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let lender_usdc_account = ctx
        .accounts
        .lender_usdc_account
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;

    require!(
        contract_usdc_account.owner == contract.key()
            && contract_usdc_account.mint == contract.loan_mint
            && contract_usdc_account.key() == contract.loan_token_account,
        StendarError::TokenAccountMismatch
    );
    require!(
        lender_usdc_account.owner == ctx.accounts.lender.key()
            && lender_usdc_account.mint == contract.loan_mint,
        StendarError::TokenAccountMismatch
    );

    let contract_seed_bytes = contract.contract_seed.to_le_bytes();
    let (expected_contract_pda, contract_bump) = Pubkey::find_program_address(
        &[
            b"debt_contract",
            contract.borrower.as_ref(),
            &contract_seed_bytes,
        ],
        ctx.program_id,
    );
    require!(
        expected_contract_pda == contract.key(),
        StendarError::InvalidContractReference
    );
    let bump_seed = [contract_bump];
    let signer_seeds: &[&[u8]] = &[
        b"debt_contract",
        contract.borrower.as_ref(),
        &contract_seed_bytes,
        &bump_seed,
    ];

    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: contract_usdc_account.to_account_info(),
                to: lender_usdc_account.to_account_info(),
                authority: contract_info.clone(),
            },
            &[signer_seeds],
        ),
        refund_amount,
    )?;

    contribution.is_refunded = true;
    contract.funded_amount = contract.funded_amount
        .checked_sub(refund_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;

    // Optional: close the lender's escrow PDA (passed via remaining accounts) to reclaim rent.
    // This keeps the account list stable while enabling cleanup.
    if let Some(escrow_info) = ctx.remaining_accounts.first() {
        let contract_key = contract.key();
        let lender_key = ctx.accounts.lender.key();
        let escrow_key = escrow_info.key();
        let (expected_escrow_pda, _escrow_bump) = Pubkey::find_program_address(
            &[b"escrow", contract_key.as_ref(), lender_key.as_ref()],
            ctx.program_id,
        );
        require!(
            escrow_key == expected_escrow_pda,
            StendarError::InvalidContribution
        );
        require!(
            escrow_info.owner == ctx.program_id,
            StendarError::InvalidContribution
        );

        let escrow_balance = escrow_info.lamports();
        if escrow_balance > 0 {
            // System transfers cannot debit program-owned accounts with data.
            **escrow_info.try_borrow_mut_lamports()? -= escrow_balance;
            **lender_info.try_borrow_mut_lamports()? += escrow_balance;
        }

        // Shrink data to 0 so the account can be reclaimed.
        escrow_info.realloc(0, false)?;
    }

    Ok(())
}

pub fn bot_refund_expired_lender<'info>(
    ctx: Context<'_, '_, '_, 'info, BotRefundExpiredLender<'info>>,
) -> Result<()> {
    let contract_info = ctx.accounts.contract.to_account_info();
    let lender_info = ctx.accounts.lender.to_account_info();
    let contract = &mut ctx.accounts.contract;
    let contribution = &mut ctx.accounts.contribution;
    require_current_version(contract.account_version)?;
    require_current_version(contribution.account_version)?;
    require_current_version(ctx.accounts.treasury.account_version)?;

    require!(
        contract.status == ContractStatus::Cancelled,
        StendarError::ContractNotCancelled
    );
    require!(
        contribution.contract == contract.key(),
        StendarError::InvalidContribution
    );
    require!(
        contribution.lender == ctx.accounts.lender.key(),
        StendarError::InvalidContribution
    );
    require!(!contribution.is_refunded, StendarError::AlreadyRefunded);

    let refund_amount = contribution.contribution_amount;
    let token_program = ctx
        .accounts
        .token_program
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let contract_usdc_account = ctx
        .accounts
        .contract_usdc_account
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let lender_usdc_account = ctx
        .accounts
        .lender_usdc_account
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;

    require!(
        contract_usdc_account.owner == contract.key()
            && contract_usdc_account.mint == contract.loan_mint
            && contract_usdc_account.key() == contract.loan_token_account,
        StendarError::TokenAccountMismatch
    );
    require!(
        lender_usdc_account.owner == contribution.lender
            && lender_usdc_account.mint == contract.loan_mint,
        StendarError::TokenAccountMismatch
    );

    let contract_seed_bytes = contract.contract_seed.to_le_bytes();
    let (expected_contract_pda, contract_bump) = Pubkey::find_program_address(
        &[
            b"debt_contract",
            contract.borrower.as_ref(),
            &contract_seed_bytes,
        ],
        ctx.program_id,
    );
    require!(
        expected_contract_pda == contract.key(),
        StendarError::InvalidContractReference
    );
    let bump_seed = [contract_bump];
    let signer_seeds: &[&[u8]] = &[
        b"debt_contract",
        contract.borrower.as_ref(),
        &contract_seed_bytes,
        &bump_seed,
    ];

    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: contract_usdc_account.to_account_info(),
                to: lender_usdc_account.to_account_info(),
                authority: contract_info.clone(),
            },
            &[signer_seeds],
        ),
        refund_amount,
    )?;

    contribution.is_refunded = true;
    contract.funded_amount = contract
        .funded_amount
        .checked_sub(refund_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;

    // Optional: close the lender escrow PDA (passed via remaining accounts).
    if let Some(escrow_info) = ctx.remaining_accounts.first() {
        let contract_key = contract.key();
        let lender_key = contribution.lender;
        let escrow_key = escrow_info.key();
        let (expected_escrow_pda, _escrow_bump) = Pubkey::find_program_address(
            &[b"escrow", contract_key.as_ref(), lender_key.as_ref()],
            ctx.program_id,
        );
        require!(
            escrow_key == expected_escrow_pda,
            StendarError::InvalidContribution
        );
        require!(
            escrow_info.owner == ctx.program_id,
            StendarError::InvalidContribution
        );

        let escrow_balance = escrow_info.lamports();
        if escrow_balance > 0 {
            // System transfers cannot debit program-owned accounts with data.
            **escrow_info.try_borrow_mut_lamports()? -= escrow_balance;
            **lender_info.try_borrow_mut_lamports()? += escrow_balance;
        }

        escrow_info.realloc(0, false)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::StendarError;
    use crate::state::{
        ContractStatus, InterestPaymentType, LoanType, PaymentFrequency, PrincipalPaymentType,
    };
    use anchor_lang::error::Error;

    fn assert_stendar_error(err: Error, expected: StendarError) {
        match err {
            Error::AnchorError(anchor_err) => {
                assert_eq!(anchor_err.error_name, format!("{expected:?}"));
            }
            _ => panic!("expected AnchorError variant"),
        }
    }

    fn sample_contract(seed: u64) -> DebtContract {
        DebtContract {
            borrower: Pubkey::new_unique(),
            contract_seed: seed,
            target_amount: 600_000,
            funded_amount: 0,
            interest_rate: 500,
            term_days: 30,
            collateral_amount: 800_000,
            loan_type: LoanType::Demand,
            ltv_ratio: 10000,
            interest_payment_type: InterestPaymentType::OutstandingBalance,
            principal_payment_type: PrincipalPaymentType::NoFixedPayment,
            interest_frequency: PaymentFrequency::Monthly,
            principal_frequency: None,
            created_at: 1_700_000_000,
            status: ContractStatus::OpenNotFunded,
            num_contributions: 0,
            outstanding_balance: 0,
            accrued_interest: 0,
            last_interest_update: 0,
            last_principal_payment: 0,
            total_principal_paid: 0,
            contributions: vec![],
            last_bot_update: 123,
            next_interest_payment_due: 456,
            next_principal_payment_due: 789,
            bot_operation_count: 10,
            max_lenders: 14,
            partial_funding_flag: PARTIAL_FUNDING_ENABLED_FLAG,
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

    fn sample_approved_funder(contract: Pubkey, lender: Pubkey) -> ApprovedFunder {
        ApprovedFunder {
            contract,
            lender,
            approved_by: Pubkey::new_unique(),
            created_at: 1_700_000_000,
            _reserved: [0u8; APPROVED_FUNDER_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        }
    }

    #[test]
    fn validate_funder_authorization_skips_checks_for_public_mode() {
        let contract = sample_contract(100);
        let contract_key = Pubkey::new_unique();
        let lender_key = Pubkey::new_unique();

        validate_funder_authorization(&contract, contract_key, lender_key, None)
            .expect("public mode should not require allowlist account");
    }

    #[test]
    fn validate_funder_authorization_requires_allowlist_membership() {
        let mut contract = sample_contract(101);
        contract.set_funding_access_mode(FundingAccessMode::AllowlistOnly);

        let err = validate_funder_authorization(
            &contract,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            None,
        )
        .expect_err("allowlist-only mode requires approved_funder account");

        assert_stendar_error(err, StendarError::LenderNotApproved);
    }

    #[test]
    fn validate_funder_authorization_rejects_mismatched_allowlist_record() {
        let mut contract = sample_contract(102);
        contract.set_funding_access_mode(FundingAccessMode::AllowlistOnly);
        let contract_key = Pubkey::new_unique();
        let lender_key = Pubkey::new_unique();
        let approved_funder = sample_approved_funder(Pubkey::new_unique(), lender_key);

        let err =
            validate_funder_authorization(&contract, contract_key, lender_key, Some(&approved_funder))
                .expect_err("mismatched contract should be rejected");

        assert_stendar_error(err, StendarError::InvalidApprovedFunderAccount);
    }

    #[test]
    fn validate_funder_authorization_accepts_matching_allowlist_record() {
        let mut contract = sample_contract(103);
        contract.set_funding_access_mode(FundingAccessMode::AllowlistOnly);
        let contract_key = Pubkey::new_unique();
        let lender_key = Pubkey::new_unique();
        let approved_funder = sample_approved_funder(contract_key, lender_key);

        validate_funder_authorization(&contract, contract_key, lender_key, Some(&approved_funder))
            .expect("matching allowlist record should authorize lender");
    }

    #[test]
    fn bot_payment_is_capped_by_collateral_value() {
        assert_eq!(calculate_bot_payment(1_000_000, 800_000), 800_000);
    }

    #[test]
    fn bot_payment_fully_repays_when_collateral_covers_debt() {
        assert_eq!(calculate_bot_payment(800_000, 1_000_000), 800_000);
    }

    #[test]
    fn time_trigger_for_demand_requires_pending_recall() {
        let triggered = is_time_liquidation_triggered(
            LoanType::Demand,
            ContractStatus::PendingRecall,
            1_700_000_000,
            30,
            1_700_000_001,
        )
        .expect("time trigger should evaluate");
        assert!(triggered);

        let not_triggered = is_time_liquidation_triggered(
            LoanType::Demand,
            ContractStatus::Active,
            1_700_000_000,
            30,
            1_700_000_001,
        )
        .expect("time trigger should evaluate");
        assert!(!not_triggered);
    }

    #[test]
    fn time_trigger_for_committed_requires_term_expiry() {
        let created_at = 1_700_000_000;
        let one_day = 86_400;
        let trigger_time = created_at + one_day + 1;

        let triggered = is_time_liquidation_triggered(
            LoanType::Committed,
            ContractStatus::Active,
            created_at,
            1,
            trigger_time,
        )
        .expect("time trigger should evaluate");
        assert!(triggered);

        let not_triggered = is_time_liquidation_triggered(
            LoanType::Committed,
            ContractStatus::Active,
            created_at,
            1,
            created_at + one_day,
        )
        .expect("time trigger should evaluate");
        assert!(!not_triggered);
    }

    #[test]
    fn should_activate_on_expiry_requires_partial_fill_opt_in() {
        let mut contract = sample_contract(77);
        contract.status = ContractStatus::OpenPartiallyFunded;
        contract.funded_amount = 300_000_000;
        contract.target_amount = 600_000_000;
        contract.allow_partial_fill = false;
        contract.min_partial_fill_bps = 5_000;

        let should_activate = should_activate_on_expiry(&contract).expect("threshold check");
        assert!(!should_activate);
    }

    #[test]
    fn should_activate_on_expiry_respects_minimum_threshold() {
        let mut contract = sample_contract(78);
        contract.status = ContractStatus::OpenPartiallyFunded;
        contract.funded_amount = 300_000_000;
        contract.target_amount = 600_000_000;
        contract.allow_partial_fill = true;
        contract.min_partial_fill_bps = 6_000;

        let should_activate = should_activate_on_expiry(&contract).expect("threshold check");
        assert!(!should_activate);

        contract.min_partial_fill_bps = 5_000;
        let should_activate = should_activate_on_expiry(&contract).expect("threshold check");
        assert!(should_activate);
    }

    #[test]
    fn validate_close_listing_requires_open_partially_funded_status() {
        let mut contract = sample_contract(79);
        contract.status = ContractStatus::OpenNotFunded;
        contract.allow_partial_fill = true;
        contract.funded_amount = 200_000_000;
        contract.target_amount = 600_000_000;
        contract.min_partial_fill_bps = 2_000;

        let err = validate_close_listing_contract(&contract).expect_err("must reject non-partially-funded");
        assert_stendar_error(err, StendarError::ContractNotOpen);
    }

    #[test]
    fn validate_close_listing_requires_partial_fill_enabled() {
        let mut contract = sample_contract(80);
        contract.status = ContractStatus::OpenPartiallyFunded;
        contract.allow_partial_fill = false;
        contract.funded_amount = 300_000_000;
        contract.target_amount = 600_000_000;
        contract.min_partial_fill_bps = 0;

        let err = validate_close_listing_contract(&contract).expect_err("must reject without partial fill opt-in");
        assert_stendar_error(err, StendarError::PartialFillNotAllowed);
    }

    #[test]
    fn validate_close_listing_requires_threshold() {
        let mut contract = sample_contract(81);
        contract.status = ContractStatus::OpenPartiallyFunded;
        contract.allow_partial_fill = true;
        contract.funded_amount = 200_000_000;
        contract.target_amount = 600_000_000;
        contract.min_partial_fill_bps = 5_000;

        let err = validate_close_listing_contract(&contract).expect_err("must reject below threshold");
        assert_stendar_error(err, StendarError::BelowMinimumFillThreshold);
    }

    #[test]
    fn validate_close_listing_accepts_eligible_contract() {
        let mut contract = sample_contract(82);
        contract.status = ContractStatus::OpenPartiallyFunded;
        contract.allow_partial_fill = true;
        contract.funded_amount = 400_000_000;
        contract.target_amount = 600_000_000;
        contract.min_partial_fill_bps = 5_000;

        validate_close_listing_contract(&contract).expect("eligible close listing should pass");
    }
}
