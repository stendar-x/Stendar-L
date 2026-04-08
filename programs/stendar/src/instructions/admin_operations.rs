use crate::contexts::*;
use crate::errors::StendarError;
use crate::state::{
    AuthorityUpdated, ContractStatus, InterestPaymentType, LenderContribution, LenderEscrow,
    PlatformPauseToggled, PlatformStats, CURRENT_ACCOUNT_VERSION, TREASURY_SEED,
};
use crate::utils::{
    calculate_reimbursement, check_revolving_completion, checkpoint_standby_fees,
    process_automatic_interest, process_scheduled_principal_payments, require_current_version,
};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, accessor, Transfer};

fn require_automated_principal_versions(
    contract_version: u16,
    treasury_version: u16,
) -> Result<()> {
    require_current_version(contract_version)?;
    require_current_version(treasury_version)?;
    Ok(())
}

fn calculate_collateral_withdraw(
    total_collateral: u64,
    principal_paid: u64,
    outstanding_balance_before: u64,
) -> Result<u64> {
    if principal_paid == 0 || total_collateral == 0 {
        return Ok(0);
    }
    require!(outstanding_balance_before > 0, StendarError::InvalidPaymentAmount);

    let collateral_withdraw = (total_collateral as u128)
        .checked_mul(principal_paid as u128)
        .and_then(|value| value.checked_div(outstanding_balance_before as u128))
        .ok_or(StendarError::ArithmeticOverflow)?;
    u64::try_from(collateral_withdraw).map_err(|_| error!(StendarError::ArithmeticOverflow))
}

pub fn get_platform_stats(ctx: Context<GetPlatformStats>) -> Result<PlatformStats> {
    let state = &ctx.accounts.state;
    require_current_version(state.account_version)?;

    Ok(PlatformStats {
        total_contracts: state.total_contracts,
        total_debt: state.total_debt,
        total_collateral: state.total_collateral,
        total_interest_paid: state.total_interest_paid,
        total_liquidations: state.total_liquidations,
        total_partial_liquidations: state.total_partial_liquidations,
        platform_fee_basis_points: state.platform_fee_basis_points,
        pool_deposit_fee_bps: state.pool_deposit_fee_bps,
        pool_yield_fee_bps: state.pool_yield_fee_bps,
        primary_listing_fee_bps: state.primary_listing_fee_bps,
        secondary_listing_fee_bps: state.secondary_listing_fee_bps,
        secondary_buyer_fee_bps: state.secondary_buyer_fee_bps,
    })
}

pub fn initialize_treasury(
    ctx: Context<InitializeTreasury>,
    bot_authority: Pubkey,
    usdc_mint: Pubkey,
) -> Result<()> {
    require_current_version(ctx.accounts.state.account_version)?;
    let treasury = &mut ctx.accounts.treasury;
    require!(
        bot_authority != Pubkey::default(),
        StendarError::InvalidAuthority
    );
    require!(usdc_mint != Pubkey::default(), StendarError::InvalidMint);

    // Initialize treasury account with authority and default values
    treasury.authority = ctx.accounts.authority.key();
    treasury.pending_authority = Pubkey::default();
    treasury.bot_authority = bot_authority;
    treasury.fees_collected = 0;
    treasury.transaction_costs = 0;
    treasury.automated_operations = 0;
    treasury.total_contracts_processed = 0;
    treasury.last_update = Clock::get()?.unix_timestamp;
    treasury.created_at = Clock::get()?.unix_timestamp;
    treasury.account_version = CURRENT_ACCOUNT_VERSION;
    treasury.usdc_mint = usdc_mint;
    let treasury_key = treasury.key();
    treasury.treasury_usdc_account = get_associated_token_address(&treasury_key, &usdc_mint);
    treasury.total_liquidation_fees = 0;
    treasury.total_recall_fees = 0;

    msg!("Treasury initialized successfully");
    msg!("Authority: {}", treasury.authority);
    msg!("Bot Authority: {}", treasury.bot_authority);
    msg!("Created at: {}", treasury.created_at);

    Ok(())
}

pub fn propose_treasury_authority_transfer(
    ctx: Context<ProposeTreasuryAuthorityTransfer>,
) -> Result<()> {
    let treasury = &mut ctx.accounts.treasury;
    require_current_version(treasury.account_version)?;
    treasury.propose_authority_transfer(
        ctx.accounts.authority.key(),
        ctx.accounts.new_authority.key(),
        Clock::get()?.unix_timestamp,
    )?;

    Ok(())
}

pub fn accept_treasury_authority_transfer(
    ctx: Context<AcceptTreasuryAuthorityTransfer>,
) -> Result<()> {
    let treasury = &mut ctx.accounts.treasury;
    require_current_version(treasury.account_version)?;
    let old_authority = treasury.authority;
    treasury.accept_authority_transfer(
        ctx.accounts.pending_authority.key(),
        Clock::get()?.unix_timestamp,
    )?;

    emit!(AuthorityUpdated {
        old: old_authority,
        new_authority: treasury.authority,
    });

    Ok(())
}

pub fn update_bot_authority(ctx: Context<UpdateBotAuthority>) -> Result<()> {
    let treasury = &mut ctx.accounts.treasury;
    require_current_version(treasury.account_version)?;
    treasury.set_bot_authority(
        ctx.accounts.authority.key(),
        ctx.accounts.new_bot_authority.key(),
        Clock::get()?.unix_timestamp,
    )?;

    msg!("Bot authority updated successfully");
    msg!("New bot authority: {}", treasury.bot_authority);

    Ok(())
}

pub fn automated_interest_transfer<'info>(
    ctx: Context<'_, '_, '_, 'info, AutomatedInterestTransfer<'info>>,
) -> Result<()> {
    let current_time = Clock::get()?.unix_timestamp;

    // Validate bot authority - only authorized bot can execute automated operations
    require!(
        ctx.accounts.treasury.bot_authority == ctx.accounts.bot_processor.key(),
        StendarError::UnauthorizedBotOperation
    );
    require!(!ctx.accounts.state.is_paused, StendarError::PlatformPaused);

    {
        let contract = &mut ctx.accounts.contract;
        require_current_version(contract.account_version)?;
        require_current_version(ctx.accounts.treasury.account_version)?;
        if contract.is_revolving {
            require!(
                contract.status == ContractStatus::Active
                    || contract.status == ContractStatus::PendingRecall,
                StendarError::ContractNotFunded
            );
            checkpoint_standby_fees(contract, current_time)?;
            if contract.drawn_amount > 0 {
                process_automatic_interest(contract, current_time)?;
            }
        } else {
            require!(
                contract.status == ContractStatus::Active,
                StendarError::ContractNotFunded
            );

            // Check due status before processing accrual updates.
            require!(
                contract.is_interest_payment_due(current_time),
                StendarError::PaymentNotDue
            );

            // Update contract state to calculate current interest
            process_automatic_interest(contract, current_time)?;
        }
    }

    let contract_key = ctx.accounts.contract.key();
    let contract_info = ctx.accounts.contract.to_account_info();
    let bot_processor_info = ctx.accounts.bot_processor.to_account_info();
    let contract_funded_amount = ctx.accounts.contract.funded_amount;
    let accrued_interest = ctx.accounts.contract.accrued_interest;
    let contract_borrower = ctx.accounts.contract.borrower;
    let contract_loan_mint = ctx.accounts.contract.loan_mint;
    let contract_collateral_mint = ctx.accounts.contract.collateral_mint;
    let interest_payment_type = ctx.accounts.contract.interest_payment_type;

    let token_program = ctx
        .accounts
        .token_program
        .as_ref()
        .ok_or(StendarError::MissingTokenAccounts)?;
    let contract_usdc_info = if interest_payment_type == InterestPaymentType::OutstandingBalance {
        let contract_usdc_account = ctx
            .accounts
            .contract_usdc_account
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        require!(
            ctx.accounts.contract.loan_token_account == contract_usdc_account.key(),
            StendarError::TokenAccountMismatch
        );
        require!(
            contract_usdc_account.owner == contract_key,
            StendarError::TokenAccountMismatch
        );
        require!(
            contract_usdc_account.mint == contract_loan_mint,
            StendarError::InvalidUsdcMint
        );
        Some(contract_usdc_account.to_account_info())
    } else {
        None
    };
    let bot_usdc_info = if interest_payment_type == InterestPaymentType::CollateralTransfer {
        let bot_usdc_ata = ctx
            .accounts
            .bot_usdc_ata
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        require!(
            bot_usdc_ata.owner == ctx.accounts.bot_processor.key(),
            StendarError::UnauthorizedBotOperation
        );
        require!(
            bot_usdc_ata.mint == contract_loan_mint,
            StendarError::InvalidUsdcMint
        );
        Some(bot_usdc_ata.to_account_info())
    } else {
        None
    };

    let contract_seed_bytes = ctx.accounts.contract.contract_seed.to_le_bytes();
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
    let token_program_info = token_program.to_account_info();
    let bump_bytes = [contract_bump];
    let signer_seeds: &[&[u8]] = &[
        b"debt_contract",
        contract_borrower.as_ref(),
        &contract_seed_bytes,
        &bump_bytes,
    ];

    let remaining_accounts = ctx.remaining_accounts;
    let expected_contribution_accounts = ctx.accounts.contract.contributions.len();
    let chunk_size = 4usize;
    let expected_remaining_accounts = expected_contribution_accounts
        .checked_mul(chunk_size)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(
        remaining_accounts.len() == expected_remaining_accounts,
        StendarError::InvalidContribution
    );

    // Enforce that each contribution PDA is present exactly once.
    let mut remaining_contributions = ctx.accounts.contract.contributions.clone();

    let mut total_tx_cost = 0u64;
    let contribution_count = expected_contribution_accounts;
    let mut interest_distributed = 0u64;
    let mut lender_index = 0usize;

    // Process lender bundles:
    // [contribution, escrow, lender_wallet, lender_usdc_ata]
    for chunk in remaining_accounts.chunks(chunk_size) {
        let contribution_info = &chunk[0];
        let escrow_info = &chunk[1];
        let lender_wallet_info = &chunk[2];
        let lender_usdc_info = &chunk[3];
        let contribution_key = contribution_info.key();

        let contribution_index = remaining_contributions
            .iter()
            .position(|key| *key == contribution_key)
            .ok_or(StendarError::InvalidContribution)?;
        remaining_contributions.swap_remove(contribution_index);

        // Deserialize contribution to get lender's share
        let contribution_data = contribution_info.try_borrow_data()?;
        let contribution = LenderContribution::try_deserialize(&mut &contribution_data[..])?;
        require_current_version(contribution.account_version)?;

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

        // Deserialize escrow for relationship validation
        let escrow_data = escrow_info.try_borrow_data()?;
        let escrow = LenderEscrow::try_deserialize(&mut &escrow_data[..])?;
        require_current_version(escrow.account_version)?;

        require!(
            contribution.contract == contract_key,
            StendarError::InvalidContribution
        );
        require!(
            escrow.contract == contract_key,
            StendarError::InvalidContribution
        );
        require!(
            escrow.lender == contribution.lender,
            StendarError::UnauthorizedClaim
        );
        require!(
            lender_wallet_info.key() == contribution.lender,
            StendarError::UnauthorizedClaim
        );

        // Last lender gets the remainder to prevent rounding dust leak
        let lender_interest_share = if contract_funded_amount == 0 {
            0
        } else if lender_index + 1 == contribution_count {
            accrued_interest.saturating_sub(interest_distributed)
        } else {
            let share = (contribution.contribution_amount as u128)
                .checked_mul(accrued_interest as u128)
                .and_then(|v| v.checked_div(contract_funded_amount as u128))
                .ok_or(StendarError::ArithmeticOverflow)?;
            u64::try_from(share).map_err(|_| error!(StendarError::ArithmeticOverflow))?
        };
        interest_distributed = interest_distributed
            .checked_add(lender_interest_share)
            .ok_or(StendarError::ArithmeticOverflow)?;

        if lender_interest_share > 0 {
            let lender_usdc_mint = accessor::mint(lender_usdc_info)
                .map_err(|_| error!(StendarError::TokenAccountMismatch))?;
            let lender_usdc_owner = accessor::authority(lender_usdc_info)
                .map_err(|_| error!(StendarError::TokenAccountMismatch))?;
            require!(
                lender_usdc_mint == contract_loan_mint,
                StendarError::InvalidUsdcMint
            );
            require!(
                lender_usdc_owner == contribution.lender,
                StendarError::TokenAccountMismatch
            );

            match interest_payment_type {
                InterestPaymentType::OutstandingBalance => {
                    let contract_usdc_info = contract_usdc_info
                        .as_ref()
                        .ok_or(StendarError::MissingTokenAccounts)?;
                    token::transfer(
                        CpiContext::new_with_signer(
                            token_program_info.clone(),
                            Transfer {
                                from: contract_usdc_info.clone(),
                                to: lender_usdc_info.to_account_info(),
                                authority: contract_info.clone(),
                            },
                            &[signer_seeds],
                        ),
                        lender_interest_share,
                    )?;
                }
                InterestPaymentType::CollateralTransfer => {
                    let bot_usdc_info = bot_usdc_info
                        .as_ref()
                        .ok_or(StendarError::MissingTokenAccounts)?;
                    token::transfer(
                        CpiContext::new(
                            token_program_info.clone(),
                            Transfer {
                                from: bot_usdc_info.clone(),
                                to: lender_usdc_info.to_account_info(),
                                authority: bot_processor_info.clone(),
                            },
                        ),
                        lender_interest_share,
                    )?;
                }
            }

            // Estimate transaction cost (approx 5000 lamports per transfer)
            total_tx_cost = total_tx_cost
                .checked_add(5000)
                .ok_or(StendarError::ArithmeticOverflow)?;
        }
        lender_index += 1;
    }

    require!(
        remaining_contributions.is_empty(),
        StendarError::InvalidContribution
    );

    let mut collateral_withdraw = 0u64;
    if interest_payment_type == InterestPaymentType::CollateralTransfer {
        collateral_withdraw = calculate_collateral_withdraw(
            ctx.accounts.contract.collateral_amount,
            accrued_interest,
            ctx.accounts.contract.outstanding_balance,
        )?;

        if collateral_withdraw > 0 {
            let contract_collateral_account = ctx
                .accounts
                .contract_collateral_account
                .as_ref()
                .ok_or(StendarError::MissingTokenAccounts)?;
            let bot_collateral_ata = ctx
                .accounts
                .bot_collateral_ata
                .as_ref()
                .ok_or(StendarError::MissingTokenAccounts)?;

            require!(
                contract_collateral_account.key() == ctx.accounts.contract.collateral_token_account,
                StendarError::TokenAccountMismatch
            );
            require!(
                contract_collateral_account.owner == contract_key
                    && contract_collateral_account.mint == contract_collateral_mint,
                StendarError::TokenAccountMismatch
            );
            require!(
                bot_collateral_ata.owner == ctx.accounts.bot_processor.key()
                    && bot_collateral_ata.mint == contract_collateral_mint,
                StendarError::TokenAccountMismatch
            );

            token::transfer(
                CpiContext::new_with_signer(
                    token_program_info.clone(),
                    Transfer {
                        from: contract_collateral_account.to_account_info(),
                        to: bot_collateral_ata.to_account_info(),
                        authority: contract_info.clone(),
                    },
                    &[signer_seeds],
                ),
                collateral_withdraw,
            )?;
        }
    }

    // Update contract state
    {
        let contract = &mut ctx.accounts.contract;
        require_current_version(contract.account_version)?;
        require_current_version(ctx.accounts.treasury.account_version)?;
        if collateral_withdraw > 0 {
            contract.collateral_amount = contract
                .collateral_amount
                .checked_sub(collateral_withdraw)
                .ok_or(StendarError::ArithmeticOverflow)?;
        }
        contract.accrued_interest = 0; // Reset after distribution
        contract.last_interest_update = current_time;
        if contract.is_revolving {
            contract.outstanding_balance = contract.drawn_amount;
            if check_revolving_completion(contract) {
                contract.status = ContractStatus::Completed;
            }
        }

        // Update bot tracking after interest processing
        contract.update_bot_tracking(current_time);
    }

    // Update treasury statistics
    {
        let treasury = &mut ctx.accounts.treasury;

        treasury.transaction_costs = treasury
            .transaction_costs
            .checked_add(total_tx_cost)
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

    // Reimburse the bot processor from the per-contract operations fund (if present).
    let mut reimbursed = 0u64;
    if let Some(operations_fund) = ctx.accounts.operations_fund.as_mut() {
        if operations_fund.is_active {
            require!(
                operations_fund.contract == contract_key,
                StendarError::InvalidContractReference
            );
            require!(
                operations_fund.borrower == ctx.accounts.contract.borrower,
                StendarError::InvalidContractReference
            );

            let actual_lenders = expected_contribution_accounts as u16;
            let requested = calculate_reimbursement(operations_fund.max_lenders, actual_lenders)?;
            let ops_info = operations_fund.to_account_info();
            let bot_info = ctx.accounts.bot_processor.to_account_info();

            let rent_minimum = Rent::get()?.minimum_balance(ops_info.data_len());
            let available = ops_info.lamports().saturating_sub(rent_minimum);
            reimbursed = std::cmp::min(requested, available);
            if reimbursed > 0 {
                **ops_info.try_borrow_mut_lamports()? -= reimbursed;
                **bot_info.try_borrow_mut_lamports()? += reimbursed;
                operations_fund.total_reimbursed = operations_fund
                    .total_reimbursed
                    .checked_add(reimbursed)
                    .ok_or(StendarError::ArithmeticOverflow)?;
            }

            operations_fund.completed_operations = operations_fund
                .completed_operations
                .checked_add(1)
                .ok_or(StendarError::ArithmeticOverflow)?;
        }
    }

    msg!(
        "Interest transfer completed for contract: {}",
        ctx.accounts.contract.contract_seed
    );
    msg!("Total transaction cost: {} lamports", total_tx_cost);
    msg!("Bot reimbursed: {} lamports", reimbursed);

    Ok(())
}

pub fn automated_principal_transfer<'info>(
    ctx: Context<'_, '_, '_, 'info, AutomatedPrincipalTransfer<'info>>,
) -> Result<()> {
    let current_time = Clock::get()?.unix_timestamp;

    // Validate bot authority - only authorized bot can execute automated operations
    require!(
        ctx.accounts.treasury.bot_authority == ctx.accounts.bot_processor.key(),
        StendarError::UnauthorizedBotOperation
    );
    require!(!ctx.accounts.state.is_paused, StendarError::PlatformPaused);

    let outstanding_balance_before = {
        let contract = &mut ctx.accounts.contract;
        require_automated_principal_versions(
            contract.account_version,
            ctx.accounts.treasury.account_version,
        )?;

        require!(
            contract.status == ContractStatus::Active,
            StendarError::ContractNotFunded
        );

        require!(
            contract.is_principal_payment_due(current_time),
            StendarError::PaymentNotDue
        );

        // Update contract state to calculate scheduled principal payments
        let outstanding_balance_before = contract.outstanding_balance;
        process_automatic_interest(contract, current_time)?;
        process_scheduled_principal_payments(contract, current_time)?;
        outstanding_balance_before
    };

    let contract_key = ctx.accounts.contract.key();
    let contract_info = ctx.accounts.contract.to_account_info();
    let bot_processor_info = ctx.accounts.bot_processor.to_account_info();
    let contract_funded_amount = ctx.accounts.contract.funded_amount;
    let available_principal = ctx.accounts.contract.total_principal_paid;
    let contract_borrower = ctx.accounts.contract.borrower;
    let contract_loan_mint = ctx.accounts.contract.loan_mint;
    let contract_collateral_mint = ctx.accounts.contract.collateral_mint;

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
    require!(
        ctx.accounts.contract.loan_token_account == contract_usdc_account.key(),
        StendarError::TokenAccountMismatch
    );
    require!(
        contract_usdc_account.owner == contract_key,
        StendarError::TokenAccountMismatch
    );
    require!(
        contract_usdc_account.mint == contract_loan_mint,
        StendarError::InvalidUsdcMint
    );
    let bot_usdc_ata = &ctx.accounts.bot_usdc_ata;
    require!(
        bot_usdc_ata.mint == contract_loan_mint,
        StendarError::InvalidUsdcMint
    );
    require!(
        bot_usdc_ata.owner == ctx.accounts.bot_processor.key(),
        StendarError::UnauthorizedBotOperation
    );

    let contract_seed_bytes = ctx.accounts.contract.contract_seed.to_le_bytes();
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
    let token_program_info = token_program.to_account_info();
    let bot_usdc_info = bot_usdc_ata.to_account_info();
    let bump_bytes = [contract_bump];
    let signer_seeds: &[&[u8]] = &[
        b"debt_contract",
        contract_borrower.as_ref(),
        &contract_seed_bytes,
        &bump_bytes,
    ];

    require!(available_principal > 0, StendarError::NoPaymentDue);

    let remaining_accounts = ctx.remaining_accounts;
    let expected_contribution_accounts = ctx.accounts.contract.contributions.len();
    let chunk_size = 4usize;
    let expected_remaining_accounts = expected_contribution_accounts
        .checked_mul(chunk_size)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(
        remaining_accounts.len() == expected_remaining_accounts,
        StendarError::InvalidContribution
    );

    // Enforce that each contribution PDA is present exactly once.
    let mut remaining_contributions = ctx.accounts.contract.contributions.clone();

    let mut total_tx_cost = 0u64;
    let principal_contribution_count = expected_contribution_accounts;
    let mut principal_distributed = 0u64;
    let mut principal_lender_index = 0usize;

    // Process lender bundles:
    // [contribution, escrow, lender_wallet, lender_usdc_ata]
    for chunk in remaining_accounts.chunks(chunk_size) {
        let contribution_info = &chunk[0];
        let escrow_info = &chunk[1];
        let lender_wallet_info = &chunk[2];
        let lender_usdc_info = &chunk[3];
        let contribution_key = contribution_info.key();

        let contribution_index = remaining_contributions
            .iter()
            .position(|key| *key == contribution_key)
            .ok_or(StendarError::InvalidContribution)?;
        remaining_contributions.swap_remove(contribution_index);

        // Deserialize contribution to get lender's share
        let contribution_data = contribution_info.try_borrow_data()?;
        let contribution = LenderContribution::try_deserialize(&mut &contribution_data[..])?;
        require_current_version(contribution.account_version)?;

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

        // Deserialize escrow for relationship validation
        let escrow_data = escrow_info.try_borrow_data()?;
        let escrow = LenderEscrow::try_deserialize(&mut &escrow_data[..])?;
        require_current_version(escrow.account_version)?;

        require!(
            contribution.contract == contract_key,
            StendarError::InvalidContribution
        );
        require!(
            escrow.contract == contract_key,
            StendarError::InvalidContribution
        );
        require!(
            escrow.lender == contribution.lender,
            StendarError::UnauthorizedClaim
        );
        require!(
            lender_wallet_info.key() == contribution.lender,
            StendarError::UnauthorizedClaim
        );

        // Last lender gets the remainder to prevent rounding dust leak
        let lender_principal_share = if contract_funded_amount == 0 {
            0
        } else if principal_lender_index + 1 == principal_contribution_count {
            available_principal.saturating_sub(principal_distributed)
        } else {
            let share = (contribution.contribution_amount as u128)
                .checked_mul(available_principal as u128)
                .and_then(|v| v.checked_div(contract_funded_amount as u128))
                .ok_or(StendarError::ArithmeticOverflow)?;
            u64::try_from(share).map_err(|_| error!(StendarError::ArithmeticOverflow))?
        };
        principal_distributed = principal_distributed
            .checked_add(lender_principal_share)
            .ok_or(StendarError::ArithmeticOverflow)?;

        if lender_principal_share > 0 {
            let lender_usdc_mint = accessor::mint(lender_usdc_info)
                .map_err(|_| error!(StendarError::TokenAccountMismatch))?;
            let lender_usdc_owner = accessor::authority(lender_usdc_info)
                .map_err(|_| error!(StendarError::TokenAccountMismatch))?;
            require!(
                lender_usdc_mint == contract_loan_mint,
                StendarError::InvalidUsdcMint
            );
            require!(
                lender_usdc_owner == contribution.lender,
                StendarError::TokenAccountMismatch
            );

            token::transfer(
                CpiContext::new(
                    token_program_info.clone(),
                    Transfer {
                        from: bot_usdc_info.clone(),
                        to: lender_usdc_info.to_account_info(),
                        authority: bot_processor_info.clone(),
                    },
                ),
                lender_principal_share,
            )?;

            // Estimate transaction cost (approx 5000 lamports per transfer)
            total_tx_cost = total_tx_cost
                .checked_add(5000)
                .ok_or(StendarError::ArithmeticOverflow)?;
        }
        principal_lender_index += 1;
    }

    require!(
        remaining_contributions.is_empty(),
        StendarError::InvalidContribution
    );

    let collateral_withdraw = calculate_collateral_withdraw(
        ctx.accounts.contract.collateral_amount,
        available_principal,
        outstanding_balance_before,
    )?;

    if collateral_withdraw > 0 {
        let contract_collateral_account = ctx
            .accounts
            .contract_collateral_account
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let bot_collateral_ata = ctx
            .accounts
            .bot_collateral_ata
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;

        require!(
            contract_collateral_account.key() == ctx.accounts.contract.collateral_token_account,
            StendarError::TokenAccountMismatch
        );
        require!(
            contract_collateral_account.owner == contract_key
                && contract_collateral_account.mint == contract_collateral_mint,
            StendarError::TokenAccountMismatch
        );
        require!(
            bot_collateral_ata.owner == ctx.accounts.bot_processor.key()
                && bot_collateral_ata.mint == contract_collateral_mint,
            StendarError::TokenAccountMismatch
        );

        token::transfer(
            CpiContext::new_with_signer(
                token_program_info.clone(),
                Transfer {
                    from: contract_collateral_account.to_account_info(),
                    to: bot_collateral_ata.to_account_info(),
                    authority: contract_info.clone(),
                },
                &[signer_seeds],
            ),
            collateral_withdraw,
        )?;
    }

    // Update contract state
    {
        let contract = &mut ctx.accounts.contract;
        require_automated_principal_versions(
            contract.account_version,
            ctx.accounts.treasury.account_version,
        )?;
        contract.collateral_amount = contract
            .collateral_amount
            .checked_sub(collateral_withdraw)
            .ok_or(StendarError::ArithmeticOverflow)?;
        contract.total_principal_paid = 0; // Reset after distribution
        contract.last_principal_payment = current_time;
        // Keep bot scheduling fields consistent with interest automation.
        contract.update_bot_tracking(current_time);
    }

    // Update treasury statistics
    {
        let treasury = &mut ctx.accounts.treasury;

        treasury.transaction_costs = treasury
            .transaction_costs
            .checked_add(total_tx_cost)
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

    // Reimburse the bot processor from the per-contract operations fund (if present).
    let mut reimbursed = 0u64;
    if let Some(operations_fund) = ctx.accounts.operations_fund.as_mut() {
        if operations_fund.is_active {
            require!(
                operations_fund.contract == contract_key,
                StendarError::InvalidContractReference
            );
            require!(
                operations_fund.borrower == ctx.accounts.contract.borrower,
                StendarError::InvalidContractReference
            );

            let actual_lenders = expected_contribution_accounts as u16;
            let requested = calculate_reimbursement(operations_fund.max_lenders, actual_lenders)?;
            let ops_info = operations_fund.to_account_info();
            let bot_info = ctx.accounts.bot_processor.to_account_info();

            let rent_minimum = Rent::get()?.minimum_balance(ops_info.data_len());
            let available = ops_info.lamports().saturating_sub(rent_minimum);
            reimbursed = std::cmp::min(requested, available);
            if reimbursed > 0 {
                **ops_info.try_borrow_mut_lamports()? -= reimbursed;
                **bot_info.try_borrow_mut_lamports()? += reimbursed;
                operations_fund.total_reimbursed = operations_fund
                    .total_reimbursed
                    .checked_add(reimbursed)
                    .ok_or(StendarError::ArithmeticOverflow)?;
            }

            operations_fund.completed_operations = operations_fund
                .completed_operations
                .checked_add(1)
                .ok_or(StendarError::ArithmeticOverflow)?;
        }
    }

    msg!(
        "Principal transfer completed for contract: {}",
        ctx.accounts.contract.contract_seed
    );
    msg!("Total transaction cost: {} lamports", total_tx_cost);
    msg!("Bot reimbursed: {} lamports", reimbursed);

    Ok(())
}

pub fn withdraw_from_treasury(ctx: Context<WithdrawFromTreasury>, amount: u64) -> Result<()> {
    let treasury = &mut ctx.accounts.treasury;
    require_current_version(treasury.account_version)?;

    // Only program authority can withdraw
    require!(
        treasury.is_authority(ctx.accounts.authority.key()),
        StendarError::UnauthorizedWithdrawal
    );

    require!(amount > 0, StendarError::InvalidWithdrawalAmount);

    let wants_token_withdrawal = ctx.accounts.treasury_usdc_account.is_some()
        || ctx.accounts.recipient_usdc_account.is_some()
        || ctx.accounts.token_program.is_some();

    if wants_token_withdrawal {
        let treasury_usdc_account = ctx
            .accounts
            .treasury_usdc_account
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let recipient_usdc_account = ctx
            .accounts
            .recipient_usdc_account
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;

        require!(
            treasury.treasury_usdc_account == treasury_usdc_account.key(),
            StendarError::TokenAccountMismatch
        );
        require!(
            treasury.usdc_mint == treasury_usdc_account.mint
                && treasury.usdc_mint == recipient_usdc_account.mint,
            StendarError::InvalidUsdcMint
        );
        require!(
            treasury_usdc_account.owner == treasury.key()
                && recipient_usdc_account.owner == ctx.accounts.recipient.key(),
            StendarError::TokenAccountMismatch
        );
        require!(
            treasury_usdc_account.amount >= amount,
            StendarError::InsufficientTreasuryBalance
        );

        let treasury_key = treasury.key();
        let (expected_treasury_pda, treasury_bump) =
            Pubkey::find_program_address(&[TREASURY_SEED], ctx.program_id);
        require!(
            expected_treasury_pda == treasury_key,
            StendarError::InvalidContractReference
        );

        let treasury_info = ctx.accounts.treasury.to_account_info();
        let bump_bytes = [treasury_bump];
        let signer_seeds: &[&[u8]] = &[TREASURY_SEED, &bump_bytes];

        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: treasury_usdc_account.to_account_info(),
                    to: recipient_usdc_account.to_account_info(),
                    authority: treasury_info,
                },
                &[signer_seeds],
            ),
            amount,
        )?;

        msg!(
            "Treasury USDC withdrawal completed: {} atomic units",
            amount
        );
    } else {
        let treasury_info = ctx.accounts.treasury.to_account_info();
        let treasury_balance = treasury_info.lamports();
        let rent_minimum = Rent::get()?.minimum_balance(treasury_info.data_len());
        let max_withdrawable = treasury_balance.saturating_sub(rent_minimum);
        require!(
            amount <= max_withdrawable,
            StendarError::InsufficientTreasuryBalance
        );

        // This instruction withdraws SOL. Restrict the recipient to a system-owned, non-executable
        // account to avoid accidental transfers to program accounts.
        require!(
            *ctx.accounts.recipient.owner == System::id(),
            StendarError::InvalidRecipient
        );
        require!(
            !ctx.accounts.recipient.executable,
            StendarError::InvalidRecipient
        );

        let recipient_info = ctx.accounts.recipient.to_account_info();

        // System transfers cannot debit program-owned accounts with data.
        // Move lamports directly from the treasury PDA to the recipient.
        **treasury_info.try_borrow_mut_lamports()? -= amount;
        **recipient_info.try_borrow_mut_lamports()? += amount;

        msg!("Treasury withdrawal completed: {} lamports", amount);
    }

    Ok(())
}

pub fn toggle_pause(ctx: Context<TogglePause>) -> Result<()> {
    let state = &mut ctx.accounts.state;
    state.is_paused = !state.is_paused;
    emit!(PlatformPauseToggled {
        is_paused: state.is_paused,
    });
    msg!("Platform paused: {}", state.is_paused);
    Ok(())
}

pub fn update_fee_rates(
    ctx: Context<UpdateFeeRates>,
    pool_deposit_fee_bps: Option<u16>,
    pool_yield_fee_bps: Option<u16>,
    primary_listing_fee_bps: Option<u16>,
    secondary_listing_fee_bps: Option<u16>,
    secondary_buyer_fee_bps: Option<u16>,
) -> Result<()> {
    const MAX_FEE_TENTHS_BPS: u16 = 100; // 0.1%

    let state = &mut ctx.accounts.state;
    require_current_version(state.account_version)?;

    let validate_fee = |fee: u16| -> Result<()> {
        require!(fee <= MAX_FEE_TENTHS_BPS, StendarError::FeeTooHigh);
        Ok(())
    };

    if let Some(fee) = pool_deposit_fee_bps {
        validate_fee(fee)?;
        state.pool_deposit_fee_bps = fee;
    }
    if let Some(fee) = pool_yield_fee_bps {
        validate_fee(fee)?;
        state.pool_yield_fee_bps = fee;
    }
    if let Some(fee) = primary_listing_fee_bps {
        validate_fee(fee)?;
        state.primary_listing_fee_bps = fee;
    }
    if let Some(fee) = secondary_listing_fee_bps {
        validate_fee(fee)?;
        state.secondary_listing_fee_bps = fee;
    }
    if let Some(fee) = secondary_buyer_fee_bps {
        validate_fee(fee)?;
        state.secondary_buyer_fee_bps = fee;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::error::Error;

    fn assert_stendar_error(err: Error, expected: StendarError) {
        match err {
            Error::AnchorError(anchor_err) => {
                assert_eq!(anchor_err.error_name, format!("{expected:?}"));
            }
            _ => panic!("expected AnchorError variant"),
        }
    }

    #[test]
    fn principal_version_validation_accepts_current_versions() {
        require_automated_principal_versions(CURRENT_ACCOUNT_VERSION, CURRENT_ACCOUNT_VERSION)
            .expect("current versions should pass");
    }

    #[test]
    fn principal_version_validation_rejects_stale_contract() {
        let err = require_automated_principal_versions(0, CURRENT_ACCOUNT_VERSION)
            .expect_err("stale contract version must fail");
        assert_stendar_error(err, StendarError::AccountNeedsMigration);
    }

    #[test]
    fn principal_version_validation_rejects_stale_treasury() {
        let err = require_automated_principal_versions(CURRENT_ACCOUNT_VERSION, 0)
            .expect_err("stale treasury version must fail");
        assert_stendar_error(err, StendarError::AccountNeedsMigration);
    }

    #[test]
    fn collateral_withdraw_preserves_ltv_ratio() {
        let collateral_withdraw =
            calculate_collateral_withdraw(500_000, 100_000, 1_000_000).expect("math should work");
        assert_eq!(collateral_withdraw, 50_000);
    }

    #[test]
    fn collateral_withdraw_is_zero_when_no_principal_paid() {
        let collateral_withdraw =
            calculate_collateral_withdraw(500_000, 0, 1_000_000).expect("zero principal is valid");
        assert_eq!(collateral_withdraw, 0);
    }

    #[test]
    fn collateral_withdraw_is_zero_when_contract_has_no_collateral() {
        let collateral_withdraw =
            calculate_collateral_withdraw(0, 100_000, 1_000_000).expect("zero collateral is valid");
        assert_eq!(collateral_withdraw, 0);
    }

    #[test]
    fn collateral_withdraw_matches_bot_reimbursement_amount() {
        // Bot should receive the same proportional collateral deducted from the contract.
        let collateral_withdraw =
            calculate_collateral_withdraw(1_250_000, 250_000, 1_000_000).expect("math should work");
        assert_eq!(collateral_withdraw, 312_500);
    }

    #[test]
    fn collateral_withdraw_for_interest_with_full_balance_interest_withdraws_all_collateral() {
        let collateral_withdraw =
            calculate_collateral_withdraw(900_000, 450_000, 450_000).expect("math should work");
        assert_eq!(collateral_withdraw, 900_000);
    }

    #[test]
    fn collateral_withdraw_for_interest_rejects_zero_outstanding_balance() {
        let err = calculate_collateral_withdraw(900_000, 10_000, 0)
            .expect_err("non-zero interest requires outstanding balance");
        assert_stendar_error(err, StendarError::InvalidPaymentAmount);
    }
}
