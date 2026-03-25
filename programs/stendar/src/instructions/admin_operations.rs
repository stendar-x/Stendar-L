use crate::contexts::*;
use crate::errors::StendarError;
use crate::state::{
    AuthorityUpdated, ContractStatus, LenderContribution, LenderEscrow, PlatformStats, State,
    Treasury, CURRENT_ACCOUNT_VERSION, TREASURY_SEED,
};
use crate::utils::{
    calculate_reimbursement, process_automatic_interest, process_scheduled_principal_payments,
    read_version_from_account, require_current_version,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, accessor, Transfer};

fn ensure_rent_exempt_and_realloc<'info>(
    payer_key: &Pubkey,
    payer_info: &AccountInfo<'info>,
    account_info: &AccountInfo<'info>,
    system_program_info: &AccountInfo<'info>,
    new_len: usize,
) -> Result<()> {
    if account_info.data_len() >= new_len {
        return Ok(());
    }

    let rent_minimum = Rent::get()?.minimum_balance(new_len);
    let current_lamports = account_info.lamports();
    if current_lamports < rent_minimum {
        let top_up = rent_minimum
            .checked_sub(current_lamports)
            .ok_or(StendarError::ArithmeticOverflow)?;
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            payer_key,
            account_info.key,
            top_up,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                payer_info.clone(),
                account_info.clone(),
                system_program_info.clone(),
            ],
        )?;
    }

    account_info.realloc(new_len, true)?;
    Ok(())
}

pub fn migrate_platform_accounts<'info>(
    ctx: Context<'_, '_, '_, 'info, MigratePlatformAccounts<'info>>,
) -> Result<()> {
    let authority_key = ctx.accounts.authority.key();
    let authority_info = ctx.accounts.authority.to_account_info();
    let system_program_info = ctx.accounts.system_program.to_account_info();

    let state_info = ctx.accounts.state.to_account_info();
    let (expected_state_pda, _) = Pubkey::find_program_address(&[b"global_state"], ctx.program_id);
    require!(
        state_info.key() == expected_state_pda,
        StendarError::InvalidContractReference
    );
    require!(
        state_info.owner == ctx.program_id,
        StendarError::InvalidContractReference
    );
    {
        let data = state_info.try_borrow_data()?;
        require!(data.len() >= 8 + 32, StendarError::InvalidContractReference);
        require!(
            &data[..8] == State::DISCRIMINATOR,
            StendarError::InvalidContractReference
        );
        let mut authority_bytes = [0u8; 32];
        authority_bytes.copy_from_slice(&data[8..40]);
        require!(
            Pubkey::new_from_array(authority_bytes) == authority_key,
            StendarError::UnauthorizedAuthorityUpdate
        );
    }

    ensure_rent_exempt_and_realloc(
        &authority_key,
        &authority_info,
        &state_info,
        &system_program_info,
        State::LEN,
    )?;
    let state_version = read_version_from_account(&state_info, State::LEN)?;
    {
        let mut data = state_info.try_borrow_mut_data()?;
        let mut state = State::try_deserialize(&mut &data[..])
            .map_err(|_| StendarError::AccountNeedsMigration)?;
        if state_version != CURRENT_ACCOUNT_VERSION {
            state.account_version = CURRENT_ACCOUNT_VERSION;
            state.try_serialize(&mut &mut data[..])?;
        }
    }

    if let Some(treasury_info) = ctx.accounts.treasury.as_ref() {
        let treasury_info = treasury_info.to_account_info();
        let (expected_treasury_pda, _) =
            Pubkey::find_program_address(&[TREASURY_SEED], ctx.program_id);
        require!(
            treasury_info.key() == expected_treasury_pda,
            StendarError::InvalidContractReference
        );
        require!(
            treasury_info.owner == ctx.program_id,
            StendarError::InvalidContractReference
        );

        {
            let data = treasury_info.try_borrow_data()?;
            require!(data.len() >= 8 + 32, StendarError::InvalidContractReference);
            require!(
                &data[..8] == Treasury::DISCRIMINATOR,
                StendarError::InvalidContractReference
            );
            let mut authority_bytes = [0u8; 32];
            authority_bytes.copy_from_slice(&data[8..40]);
            require!(
                Pubkey::new_from_array(authority_bytes) == authority_key,
                StendarError::UnauthorizedAuthorityUpdate
            );
        }

        ensure_rent_exempt_and_realloc(
            &authority_key,
            &authority_info,
            &treasury_info,
            &system_program_info,
            Treasury::LEN,
        )?;
        let treasury_version = read_version_from_account(&treasury_info, Treasury::LEN)?;
        let mut data = treasury_info.try_borrow_mut_data()?;
        let mut treasury = Treasury::try_deserialize(&mut &data[..])
            .map_err(|_| StendarError::AccountNeedsMigration)?;
        if treasury_version != CURRENT_ACCOUNT_VERSION {
            treasury.account_version = CURRENT_ACCOUNT_VERSION;
            treasury.try_serialize(&mut &mut data[..])?;
        }
    }

    Ok(())
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
        platform_fee_basis_points: state.platform_fee_basis_points,
    })
}

pub fn initialize_treasury(ctx: Context<InitializeTreasury>, bot_authority: Pubkey) -> Result<()> {
    require_current_version(ctx.accounts.state.account_version)?;
    let treasury = &mut ctx.accounts.treasury;
    require_current_version(ctx.accounts.state.account_version)?;
    require!(
        bot_authority != Pubkey::default(),
        StendarError::InvalidAuthority
    );

    // Initialize treasury account with authority and default values
    treasury.authority = ctx.accounts.authority.key();
    treasury.bot_authority = bot_authority;
    treasury.fees_collected = 0;
    treasury.transaction_costs = 0;
    treasury.automated_operations = 0;
    treasury.total_contracts_processed = 0;
    treasury.last_update = Clock::get()?.unix_timestamp;
    treasury.created_at = Clock::get()?.unix_timestamp;
    treasury.account_version = CURRENT_ACCOUNT_VERSION;
    treasury.usdc_mint = Pubkey::default();
    treasury.treasury_usdc_account = Pubkey::default();
    treasury.total_liquidation_fees = 0;
    treasury.total_recall_fees = 0;

    msg!("Treasury initialized successfully");
    msg!("Authority: {}", treasury.authority);
    msg!("Bot Authority: {}", treasury.bot_authority);
    msg!("Created at: {}", treasury.created_at);

    Ok(())
}

pub fn update_treasury_authority(ctx: Context<UpdateTreasuryAuthority>) -> Result<()> {
    let old_authority = ctx.accounts.authority.key();
    let treasury = &mut ctx.accounts.treasury;
    require_current_version(treasury.account_version)?;
    treasury.set_authority(
        old_authority,
        ctx.accounts.new_authority.key(),
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

    {
        let contract = &mut ctx.accounts.contract;
        require_current_version(contract.account_version)?;
        require_current_version(ctx.accounts.treasury.account_version)?;

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

    let contract_key = ctx.accounts.contract.key();
    let contract_info = ctx.accounts.contract.to_account_info();
    let contract_funded_amount = ctx.accounts.contract.funded_amount;
    let accrued_interest = ctx.accounts.contract.accrued_interest;
    let contract_borrower = ctx.accounts.contract.borrower;
    let contract_loan_mint = ctx.accounts.contract.loan_mint;

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
    let contract_usdc_info = contract_usdc_account.to_account_info();
    let bump_bytes = [contract_bump];

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

            let signer_seeds: &[&[u8]] = &[
                b"debt_contract",
                contract_borrower.as_ref(),
                &contract_seed_bytes,
                &bump_bytes,
            ];

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

    // Update contract state
    {
        let contract = &mut ctx.accounts.contract;
        require_current_version(contract.account_version)?;
        require_current_version(ctx.accounts.treasury.account_version)?;
        contract.accrued_interest = 0; // Reset after distribution
        contract.last_interest_update = current_time;

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

    {
        let contract = &mut ctx.accounts.contract;

        require!(
            contract.status == ContractStatus::Active,
            StendarError::ContractNotFunded
        );

        require!(
            contract.is_principal_payment_due(current_time),
            StendarError::PaymentNotDue
        );

        // Update contract state to calculate scheduled principal payments
        process_automatic_interest(contract, current_time)?;
        process_scheduled_principal_payments(contract, current_time)?;
    }

    let contract_key = ctx.accounts.contract.key();
    let contract_info = ctx.accounts.contract.to_account_info();
    let contract_funded_amount = ctx.accounts.contract.funded_amount;
    let available_principal = ctx.accounts.contract.total_principal_paid;
    let contract_borrower = ctx.accounts.contract.borrower;
    let contract_loan_mint = ctx.accounts.contract.loan_mint;

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
    let contract_usdc_info = contract_usdc_account.to_account_info();
    let bump_bytes = [contract_bump];

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

            let signer_seeds: &[&[u8]] = &[
                b"debt_contract",
                contract_borrower.as_ref(),
                &contract_seed_bytes,
                &bump_bytes,
            ];

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

    // Update contract state
    {
        let contract = &mut ctx.accounts.contract;
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
    msg!("Platform paused: {}", state.is_paused);
    Ok(())
}
