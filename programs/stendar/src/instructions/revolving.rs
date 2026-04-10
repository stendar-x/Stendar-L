use crate::contexts::*;
use crate::errors::StendarError;
use crate::state::{ContractStatus, LenderContribution, LenderEscrow, LoanType};
use crate::utils::{
    calculate_collateral_value_in_usdc, calculate_ltv_bps, calculate_standby_fee,
    check_revolving_completion, checkpoint_standby_fees, get_price_in_usdc, process_automatic_interest,
    require_current_version, safe_u128_to_u64, MAX_CONFIDENCE_BPS_STANDARD, MAX_PRICE_AGE_LIQUIDATION,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, TokenAccount, Transfer};

fn require_revolving_contract(contract: &crate::state::DebtContract) -> Result<()> {
    require!(contract.is_revolving, StendarError::RevolvingNotEnabled);
    Ok(())
}

fn require_revolving_contribution_pairs<'info>(
    program_id: &Pubkey,
    contract_key: Pubkey,
    expected_contributions: &[Pubkey],
    remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<()> {
    let contribution_count = expected_contributions.len();
    let expected_remaining_accounts = contribution_count
        .checked_mul(2)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(
        remaining_accounts.len() == expected_remaining_accounts,
        StendarError::InvalidContribution
    );

    let mut remaining_contributions = expected_contributions.to_vec();
    for chunk in remaining_accounts.chunks(2) {
        let contribution_info = &chunk[0];
        let escrow_info = &chunk[1];
        require!(
            contribution_info.owner == program_id && escrow_info.owner == program_id,
            StendarError::InvalidContribution
        );

        let contribution_key = contribution_info.key();
        let contribution_index = remaining_contributions
            .iter()
            .position(|key| *key == contribution_key)
            .ok_or(StendarError::InvalidContribution)?;
        remaining_contributions.swap_remove(contribution_index);

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
            program_id,
        );
        require!(
            contribution_key == expected_contribution_pda,
            StendarError::InvalidContribution
        );

        let escrow_data = escrow_info.try_borrow_data()?;
        let escrow = LenderEscrow::try_deserialize(&mut &escrow_data[..])
            .map_err(|_| error!(StendarError::InvalidContribution))?;
        require_current_version(escrow.account_version)?;
        require!(escrow.contract == contract_key, StendarError::InvalidContribution);
        require!(
            escrow.lender == contribution.lender,
            StendarError::UnauthorizedClaim
        );
        let (expected_escrow_pda, _) = Pubkey::find_program_address(
            &[b"escrow", contract_key.as_ref(), contribution.lender.as_ref()],
            program_id,
        );
        require!(
            escrow_info.key() == expected_escrow_pda,
            StendarError::InvalidContribution
        );
    }

    require!(
        remaining_contributions.is_empty(),
        StendarError::InvalidContribution
    );
    Ok(())
}

pub fn draw_from_revolving<'info>(
    ctx: Context<'_, '_, 'info, 'info, DrawFromRevolving<'info>>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, StendarError::InvalidPaymentAmount);
    require_current_version(ctx.accounts.contract.account_version)?;
    require_current_version(ctx.accounts.state.account_version)?;
    require_current_version(ctx.accounts.treasury.account_version)?;
    require_revolving_contract(&ctx.accounts.contract)?;
    require!(
        ctx.accounts.contract.status == ContractStatus::Active,
        StendarError::ContractNotFunded
    );
    require!(
        !ctx.accounts.contract.revolving_closed,
        StendarError::RevolvingFacilityClosed
    );
    require!(
        amount <= ctx.accounts.contract.available_amount,
        StendarError::DrawExceedsAvailable
    );
    require!(
        ctx.accounts.borrower_usdc_account.owner == ctx.accounts.borrower.key()
            && ctx.accounts.borrower_usdc_account.mint == ctx.accounts.contract.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.contract_usdc_account.owner == ctx.accounts.contract.key()
            && ctx.accounts.contract_usdc_account.mint == ctx.accounts.contract.loan_mint,
        StendarError::TokenAccountMismatch
    );

    let current_time = Clock::get()?.unix_timestamp;
    if ctx.accounts.contract.term_days > 0 {
        let maturity = ctx
            .accounts
            .contract
            .created_at
            .checked_add((ctx.accounts.contract.term_days as i64).saturating_mul(24 * 60 * 60))
            .ok_or(StendarError::ArithmeticOverflow)?;
        require!(current_time < maturity, StendarError::PastMaturity);
    }

    if ctx.accounts.contract.ltv_ratio > 0 {
        let collateral_registry = ctx
            .accounts
            .collateral_registry
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let price_feed = ctx
            .accounts
            .price_feed_account
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let collateral_type = collateral_registry
            .find_collateral_type(&ctx.accounts.contract.collateral_mint)
            .ok_or(StendarError::CollateralTypeNotFound)?;
        require!(collateral_type.is_active, StendarError::CollateralTypeInactive);
        require!(
            collateral_type.oracle_price_feed == price_feed.key(),
            StendarError::OraclePriceFeedMismatch
        );
        let (price, exponent) = get_price_in_usdc(
            price_feed,
            MAX_PRICE_AGE_LIQUIDATION,
            MAX_CONFIDENCE_BPS_STANDARD,
        )?;
        let collateral_value = calculate_collateral_value_in_usdc(
            ctx.accounts.contract.collateral_amount,
            collateral_type.decimals,
            price,
            exponent,
        )?;
        let next_drawn = ctx
            .accounts
            .contract
            .drawn_amount
            .checked_add(amount)
            .ok_or(StendarError::ArithmeticOverflow)?;
        let current_ltv = calculate_ltv_bps(collateral_value, next_drawn)?;
        require!(
            current_ltv <= ctx.accounts.contract.ltv_ratio,
            StendarError::RevolvingLtvBreach
        );
    }

    require_revolving_contribution_pairs(
        ctx.program_id,
        ctx.accounts.contract.key(),
        &ctx.accounts.contract.contributions,
        ctx.remaining_accounts,
    )?;

    {
        let contract = &mut ctx.accounts.contract;
        checkpoint_standby_fees(contract, current_time)?;
    }

    let contract_seed_bytes = ctx.accounts.contract.contract_seed.to_le_bytes();
    let (expected_contract_pda, contract_bump) = Pubkey::find_program_address(
        &[
            b"debt_contract",
            ctx.accounts.contract.borrower.as_ref(),
            &contract_seed_bytes,
        ],
        ctx.program_id,
    );
    require!(
        expected_contract_pda == ctx.accounts.contract.key(),
        StendarError::InvalidContractReference
    );
    let bump_bytes = [contract_bump];
    let signer_seeds: &[&[u8]] = &[
        b"debt_contract",
        ctx.accounts.contract.borrower.as_ref(),
        &contract_seed_bytes,
        &bump_bytes,
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.contract_usdc_account.to_account_info(),
                to: ctx.accounts.borrower_usdc_account.to_account_info(),
                authority: ctx.accounts.contract.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
    )?;

    let contract = &mut ctx.accounts.contract;
    let is_first_draw = contract.total_draws == 0;
    contract.drawn_amount = contract
        .drawn_amount
        .checked_add(amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.available_amount = contract
        .credit_limit
        .checked_sub(contract.drawn_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.total_draws = contract
        .total_draws
        .checked_add(1)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.outstanding_balance = contract.drawn_amount;
    if is_first_draw {
        contract.last_interest_update = current_time;
    }
    contract.update_bot_tracking(current_time);
    Ok(())
}

pub fn repay_revolving<'info>(
    ctx: Context<'_, '_, 'info, 'info, RepayRevolving<'info>>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, StendarError::InvalidPaymentAmount);
    require_current_version(ctx.accounts.contract.account_version)?;
    require_current_version(ctx.accounts.state.account_version)?;
    require_current_version(ctx.accounts.treasury.account_version)?;
    require_revolving_contract(&ctx.accounts.contract)?;
    require!(
        ctx.accounts.contract.status == ContractStatus::Active
            || ctx.accounts.contract.status == ContractStatus::PendingRecall,
        StendarError::ContractNotFunded
    );
    require!(
        amount <= ctx.accounts.contract.drawn_amount,
        StendarError::InvalidPaymentAmount
    );
    require!(
        ctx.accounts.borrower_usdc_account.owner == ctx.accounts.borrower.key()
            && ctx.accounts.borrower_usdc_account.mint == ctx.accounts.contract.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.contract_usdc_account.owner == ctx.accounts.contract.key()
            && ctx.accounts.contract_usdc_account.mint == ctx.accounts.contract.loan_mint,
        StendarError::TokenAccountMismatch
    );

    require_revolving_contribution_pairs(
        ctx.program_id,
        ctx.accounts.contract.key(),
        &ctx.accounts.contract.contributions,
        ctx.remaining_accounts,
    )?;

    let current_time = Clock::get()?.unix_timestamp;
    {
        let contract = &mut ctx.accounts.contract;
        checkpoint_standby_fees(contract, current_time)?;
        process_automatic_interest(contract, current_time)?;
    }

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.borrower_usdc_account.to_account_info(),
                to: ctx.accounts.contract_usdc_account.to_account_info(),
                authority: ctx.accounts.borrower.to_account_info(),
            },
        ),
        amount,
    )?;

    let contract = &mut ctx.accounts.contract;
    contract.drawn_amount = contract
        .drawn_amount
        .checked_sub(amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.outstanding_balance = contract.drawn_amount;
    if contract.revolving_closed {
        contract.available_amount = 0;
    } else {
        contract.available_amount = contract
            .available_amount
            .checked_add(amount)
            .ok_or(StendarError::ArithmeticOverflow)?
            .min(contract.credit_limit.saturating_sub(contract.drawn_amount));
    }
    if check_revolving_completion(contract) {
        contract.status = ContractStatus::Completed;
    }
    contract.update_bot_tracking(current_time);
    Ok(())
}

pub fn close_revolving_facility(ctx: Context<CloseRevolvingFacility>) -> Result<()> {
    require_current_version(ctx.accounts.contract.account_version)?;
    require_current_version(ctx.accounts.state.account_version)?;
    require_current_version(ctx.accounts.treasury.account_version)?;
    require_revolving_contract(&ctx.accounts.contract)?;
    require!(
        ctx.accounts.contract.status == ContractStatus::Active,
        StendarError::ContractNotFunded
    );
    require!(
        !ctx.accounts.contract.revolving_closed,
        StendarError::RevolvingFacilityClosed
    );
    require!(
        ctx.accounts.borrower_usdc_account.owner == ctx.accounts.borrower.key()
            && ctx.accounts.borrower_usdc_account.mint == ctx.accounts.contract.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.treasury_usdc_account.owner == ctx.accounts.treasury.key()
            && ctx.accounts.treasury_usdc_account.mint == ctx.accounts.contract.loan_mint,
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.treasury.treasury_usdc_account == ctx.accounts.treasury_usdc_account.key(),
        StendarError::TokenAccountMismatch
    );

    let current_time = Clock::get()?.unix_timestamp;
    let contract = &mut ctx.accounts.contract;
    checkpoint_standby_fees(contract, current_time)?;
    let available_before_close = contract.available_amount;
    contract.revolving_closed = true;
    contract.available_amount = 0;

    if contract.loan_type == LoanType::Committed && contract.term_days > 0 && available_before_close > 0 {
        let maturity = contract
            .created_at
            .checked_add((contract.term_days as i64).saturating_mul(24 * 60 * 60))
            .ok_or(StendarError::ArithmeticOverflow)?;
        if current_time < maturity {
            let remaining_seconds = maturity
                .checked_sub(current_time)
                .ok_or(StendarError::ArithmeticOverflow)?;
            let early_termination_fee = calculate_standby_fee(
                available_before_close,
                contract.standby_fee_rate as u64,
                remaining_seconds,
            )?;

            if early_termination_fee > 0 {
                token::transfer(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.borrower_usdc_account.to_account_info(),
                            to: ctx.accounts.treasury_usdc_account.to_account_info(),
                            authority: ctx.accounts.borrower.to_account_info(),
                        },
                    ),
                    early_termination_fee,
                )?;
                ctx.accounts.treasury.fees_collected = ctx
                    .accounts
                    .treasury
                    .fees_collected
                    .checked_add(early_termination_fee)
                    .ok_or(StendarError::ArithmeticOverflow)?;
            }
        }
    }

    if check_revolving_completion(contract) {
        contract.status = ContractStatus::Completed;
    }
    contract.update_bot_tracking(current_time);
    Ok(())
}

pub fn distribute_standby_fees<'info>(
    ctx: Context<'_, '_, 'info, 'info, DistributeStandbyFees<'info>>,
) -> Result<()> {
    require_current_version(ctx.accounts.contract.account_version)?;
    require_current_version(ctx.accounts.state.account_version)?;
    require_current_version(ctx.accounts.treasury.account_version)?;
    require_revolving_contract(&ctx.accounts.contract)?;
    require!(
        ctx.accounts.contract.status == ContractStatus::Active
            || ctx.accounts.contract.status == ContractStatus::PendingRecall,
        StendarError::ContractNotFunded
    );
    require!(
        ctx.accounts.contract_usdc_account.owner == ctx.accounts.contract.key()
            && ctx.accounts.contract_usdc_account.mint == ctx.accounts.contract.loan_mint,
        StendarError::TokenAccountMismatch
    );

    let current_time = Clock::get()?.unix_timestamp;
    {
        let contract = &mut ctx.accounts.contract;
        checkpoint_standby_fees(contract, current_time)?;
    }

    let contract_key = ctx.accounts.contract.key();
    let contract_seed = ctx.accounts.contract.contract_seed;
    let contract_borrower = ctx.accounts.contract.borrower;
    let contract_loan_mint = ctx.accounts.contract.loan_mint;
    let funded_amount = ctx.accounts.contract.funded_amount;
    let contribution_count = ctx.accounts.contract.contributions.len();
    let standby_fee_amount = ctx.accounts.contract.accrued_standby_fees;
    require!(funded_amount > 0, StendarError::InvalidContributionAmount);

    let expected_remaining_accounts = contribution_count
        .checked_mul(3)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(
        ctx.remaining_accounts.len() == expected_remaining_accounts,
        StendarError::InvalidContribution
    );
    let mut remaining_contributions = ctx.accounts.contract.contributions.clone();
    let mut distributed_standby = 0u64;

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
    let bump_bytes = [contract_bump];
    let signer_seeds: &[&[u8]] = &[
        b"debt_contract",
        contract_borrower.as_ref(),
        &contract_seed_bytes,
        &bump_bytes,
    ];

    for (index, chunk) in ctx.remaining_accounts.chunks(3).enumerate() {
        let contribution_info = &chunk[0];
        let escrow_info = &chunk[1];
        let escrow_usdc_info = &chunk[2];
        let contribution_key = contribution_info.key();

        let contribution_index = remaining_contributions
            .iter()
            .position(|key| *key == contribution_key)
            .ok_or(StendarError::InvalidContribution)?;
        remaining_contributions.swap_remove(contribution_index);

        require!(
            contribution_info.owner == ctx.program_id && escrow_info.owner == ctx.program_id,
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
            &[b"escrow", contract_key.as_ref(), contribution.lender.as_ref()],
            ctx.program_id,
        );
        require!(
            escrow_info.key() == expected_escrow_pda,
            StendarError::InvalidContribution
        );

        let mut escrow_data = escrow_info.try_borrow_mut_data()?;
        let mut escrow = LenderEscrow::try_deserialize(&mut &escrow_data[..])
            .map_err(|_| error!(StendarError::InvalidContribution))?;
        require_current_version(escrow.account_version)?;
        require!(escrow.contract == contract_key, StendarError::InvalidContribution);
        require!(
            escrow.lender == contribution.lender,
            StendarError::UnauthorizedClaim
        );

        let escrow_usdc = Account::<TokenAccount>::try_from(escrow_usdc_info)
            .map_err(|_| error!(StendarError::TokenAccountMismatch))?;
        require!(
            escrow_usdc.owner == escrow_info.key(),
            StendarError::TokenAccountMismatch
        );
        require!(
            escrow_usdc.mint == contract_loan_mint,
            StendarError::InvalidUsdcMint
        );

        let lender_share = if index + 1 == contribution_count {
            standby_fee_amount.saturating_sub(distributed_standby)
        } else {
            safe_u128_to_u64(
                (contribution.contribution_amount as u128)
                    .checked_mul(standby_fee_amount as u128)
                    .and_then(|value| value.checked_div(funded_amount as u128))
                    .ok_or(StendarError::ArithmeticOverflow)?,
            )?
        };
        distributed_standby = distributed_standby
            .checked_add(lender_share)
            .ok_or(StendarError::ArithmeticOverflow)?;

        if lender_share > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.contract_usdc_account.to_account_info(),
                        to: escrow_usdc.to_account_info(),
                        authority: ctx.accounts.contract.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                lender_share,
            )?;
            if escrow.escrow_token_account == Pubkey::default() {
                escrow.escrow_token_account = escrow_usdc.key();
            } else {
                require!(
                    escrow.escrow_token_account == escrow_usdc.key(),
                    StendarError::TokenAccountMismatch
                );
            }
            escrow.available_interest = escrow
                .available_interest
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

    let contract = &mut ctx.accounts.contract;
    contract.total_standby_fees_paid = contract
        .total_standby_fees_paid
        .checked_add(distributed_standby)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.accrued_standby_fees = 0;
    if !contract.revolving_closed {
        contract.available_amount = contract.available_amount.saturating_sub(distributed_standby);
    }
    if check_revolving_completion(contract) {
        contract.status = ContractStatus::Completed;
    }
    contract.update_bot_tracking(current_time);

    ctx.accounts.treasury.automated_operations = ctx
        .accounts
        .treasury
        .automated_operations
        .checked_add(1)
        .ok_or(StendarError::ArithmeticOverflow)?;
    ctx.accounts.treasury.total_contracts_processed = ctx
        .accounts
        .treasury
        .total_contracts_processed
        .checked_add(1)
        .ok_or(StendarError::ArithmeticOverflow)?;
    ctx.accounts.treasury.last_update = current_time;

    Ok(())
}
