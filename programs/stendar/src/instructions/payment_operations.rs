use crate::contexts::*;
use crate::errors::StendarError;
use crate::state::{
    ContractOperationsFund, ContractStatus, DebtContract, LenderContribution, LenderEscrow,
    OPERATIONS_FUND_SEED,
};
use crate::utils::{
    is_native_mint, process_automatic_interest, process_scheduled_principal_payments,
    require_current_version, safe_u128_to_u64,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, accessor, CloseAccount, TokenAccount, Transfer};

fn validate_payment_token_accounts(
    contract: &DebtContract,
    contract_key: Pubkey,
    borrower_key: Pubkey,
    borrower_usdc_account: &Account<TokenAccount>,
    contract_usdc_account: &Account<TokenAccount>,
) -> Result<()> {
    require!(
        contract.loan_token_account == contract_usdc_account.key(),
        StendarError::TokenAccountMismatch
    );
    require!(
        borrower_usdc_account.mint == contract.loan_mint
            && contract_usdc_account.mint == contract.loan_mint,
        StendarError::InvalidUsdcMint
    );
    require!(
        borrower_usdc_account.owner == borrower_key && contract_usdc_account.owner == contract_key,
        StendarError::TokenAccountMismatch
    );
    Ok(())
}

fn calculate_lender_share(
    contribution_amount: u64,
    total_funded: u64,
    total_payment: u64,
    contribution_index: usize,
    contribution_count: usize,
    distributed_so_far: u64,
) -> Result<u64> {
    if total_payment == 0 {
        return Ok(0);
    }
    if contribution_index + 1 == contribution_count {
        return Ok(total_payment.saturating_sub(distributed_so_far));
    }

    safe_u128_to_u64(
        (contribution_amount as u128)
            .checked_mul(total_payment as u128)
            .and_then(|v| v.checked_div(total_funded as u128))
            .ok_or(StendarError::ArithmeticOverflow)?,
    )
}

pub fn make_payment(ctx: Context<MakePayment>, amount: u64) -> Result<()> {
    // Get keys and info first to avoid borrow conflicts
    let borrower_key = ctx.accounts.borrower.key();
    let contract_key = ctx.accounts.contract.key();
    let borrower_info = ctx.accounts.borrower.to_account_info();
    let contract_info = ctx.accounts.contract.to_account_info();

    let contract = &mut ctx.accounts.contract;
    let state = &mut ctx.accounts.state;
    require_current_version(contract.account_version)?;
    require_current_version(state.account_version)?;
    require!(!state.is_paused, StendarError::PlatformPaused);

    let result = (|| -> Result<()> {
        require!(
            contract.status == ContractStatus::Active,
            StendarError::ContractNotFunded
        );
        require!(amount > 0, StendarError::InvalidPaymentAmount);
        require!(
            contract.borrower == borrower_key,
            StendarError::UnauthorizedPayment
        );

        // Update contract state to get current outstanding balance and accrued interest
        let current_time = Clock::get()?.unix_timestamp;
        process_automatic_interest(contract, current_time)?;
        process_scheduled_principal_payments(contract, current_time)?;

        let total_owed = contract
            .outstanding_balance
            .checked_add(contract.accrued_interest)
            .ok_or(StendarError::ArithmeticOverflow)?;
        // The UI can slightly overestimate (scheduled principal deductions, rounding). Clamp instead
        // of failing so "max payment" works reliably.
        let payment_amount = std::cmp::min(amount, total_owed);
        require!(payment_amount > 0, StendarError::NoPaymentDue);

        // Transfer payment from borrower to contract.
        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let borrower_usdc_account = ctx
            .accounts
            .borrower_usdc_account
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let contract_usdc_account = ctx
            .accounts
            .contract_usdc_account
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;

        validate_payment_token_accounts(
            contract,
            contract_key,
            borrower_key,
            borrower_usdc_account,
            contract_usdc_account,
        )?;

        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: borrower_usdc_account.to_account_info(),
                    to: contract_usdc_account.to_account_info(),
                    authority: borrower_info.clone(),
                },
            ),
            payment_amount,
        )?;

        // Apply payment: first to interest, then to principal
        if contract.accrued_interest > 0 {
            let interest_payment = std::cmp::min(payment_amount, contract.accrued_interest);
            contract.accrued_interest = contract
                .accrued_interest
                .checked_sub(interest_payment)
                .ok_or(StendarError::ArithmeticOverflow)?;
            state.total_interest_paid = state
                .total_interest_paid
                .checked_add(interest_payment)
                .ok_or(StendarError::ArithmeticOverflow)?;
            let remaining_payment = payment_amount
                .checked_sub(interest_payment)
                .ok_or(StendarError::ArithmeticOverflow)?;

            if remaining_payment > 0 {
                contract.outstanding_balance = contract
                    .outstanding_balance
                    .checked_sub(remaining_payment)
                    .ok_or(StendarError::ArithmeticOverflow)?;
                contract.total_principal_paid = contract
                    .total_principal_paid
                    .checked_add(remaining_payment)
                    .ok_or(StendarError::ArithmeticOverflow)?;
            }
        } else {
            contract.outstanding_balance = contract
                .outstanding_balance
                .checked_sub(payment_amount)
                .ok_or(StendarError::ArithmeticOverflow)?;
            contract.total_principal_paid = contract
                .total_principal_paid
                .checked_add(payment_amount)
                .ok_or(StendarError::ArithmeticOverflow)?;
        }

        // Check if loan is fully paid
        if contract.outstanding_balance == 0 && contract.accrued_interest == 0 {
            contract.status = ContractStatus::Completed;

            // Return only tracked collateral amount, never the whole account balance.
            let collateral_to_return = contract.collateral_amount;
            if collateral_to_return > 0 {
                let token_program = ctx
                    .accounts
                    .token_program
                    .as_ref()
                    .ok_or(StendarError::MissingTokenAccounts)?;
                let contract_collateral_account = ctx
                    .accounts
                    .contract_collateral_account
                    .as_ref()
                    .ok_or(StendarError::MissingTokenAccounts)?;

                require!(
                    contract_collateral_account.key() == contract.collateral_token_account
                        && contract_collateral_account.owner == contract_key
                        && contract_collateral_account.mint == contract.collateral_mint,
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
                    expected_contract_pda == contract_key,
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
                            account: contract_collateral_account.to_account_info(),
                            destination: borrower_info.clone(),
                            authority: contract_info.clone(),
                        },
                        &[signer_seeds],
                    ))?;
                } else {
                    let borrower_collateral_account = ctx
                        .accounts
                        .borrower_collateral_account
                        .as_ref()
                        .ok_or(StendarError::MissingTokenAccounts)?;
                    require!(
                        borrower_collateral_account.owner == borrower_key
                            && borrower_collateral_account.mint == contract.collateral_mint,
                        StendarError::TokenAccountMismatch
                    );
                    let collateral_token_amount = contract_collateral_account.amount;
                    if collateral_token_amount > 0 {
                        token::transfer(
                            CpiContext::new_with_signer(
                                token_program.to_account_info(),
                                Transfer {
                                    from: contract_collateral_account.to_account_info(),
                                    to: borrower_collateral_account.to_account_info(),
                                    authority: contract_info.clone(),
                                },
                                &[signer_seeds],
                            ),
                            collateral_token_amount,
                        )?;
                    }
                }

                contract.collateral_amount = 0;
            }

            // Refund and close the per-contract operations fund PDA (if present).
            if let Some(ops_info) = ctx.accounts.operations_fund.as_ref() {
                let ops_info = ops_info.clone();
                if ops_info.data_len() > 0 {
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
                    // Drop the data borrow before `realloc`, otherwise the runtime errors with
                    // AccountBorrowFailed (immutable borrow held across mutable borrow).
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

        // Update bot tracking after payment processing
        contract.update_bot_tracking(current_time);

        Ok(())
    })();
    result
}

pub fn make_payment_with_distribution<'info>(
    ctx: Context<'_, '_, '_, 'info, MakePaymentWithDistribution<'info>>,
    amount: u64,
) -> Result<()> {
    // Get keys and info first to avoid borrow conflicts
    let borrower_key = ctx.accounts.borrower.key();
    let contract_key = ctx.accounts.contract.key();
    let borrower_info = ctx.accounts.borrower.to_account_info();
    let contract_info = ctx.accounts.contract.to_account_info();

    let contract = &mut ctx.accounts.contract;
    let state = &mut ctx.accounts.state;
    require_current_version(contract.account_version)?;
    require_current_version(state.account_version)?;
    require!(!state.is_paused, StendarError::PlatformPaused);

    let result = (|| -> Result<()> {
        require!(
            contract.status == ContractStatus::Active,
            StendarError::ContractNotFunded
        );
        require!(amount > 0, StendarError::InvalidPaymentAmount);
        require!(
            contract.borrower == borrower_key,
            StendarError::UnauthorizedPayment
        );

        // Update contract state to get current outstanding balance and accrued interest
        let current_time = Clock::get()?.unix_timestamp;
        process_automatic_interest(contract, current_time)?;
        process_scheduled_principal_payments(contract, current_time)?;

        let total_owed = contract
            .outstanding_balance
            .checked_add(contract.accrued_interest)
            .ok_or(StendarError::ArithmeticOverflow)?;
        // The UI can slightly overestimate (scheduled principal deductions, rounding). Clamp instead
        // of failing so "max payment" works reliably.
        let payment_amount = std::cmp::min(amount, total_owed);
        require!(payment_amount > 0, StendarError::NoPaymentDue);

        // Transfer payment from borrower to contract.
        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let borrower_usdc_account = ctx
            .accounts
            .borrower_usdc_account
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;
        let contract_usdc_account = ctx
            .accounts
            .contract_usdc_account
            .as_ref()
            .ok_or(StendarError::MissingTokenAccounts)?;

        validate_payment_token_accounts(
            contract,
            contract_key,
            borrower_key,
            borrower_usdc_account,
            contract_usdc_account,
        )?;

        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: borrower_usdc_account.to_account_info(),
                    to: contract_usdc_account.to_account_info(),
                    authority: borrower_info.clone(),
                },
            ),
            payment_amount,
        )?;

        // Apply payment: first to interest, then to principal
        let mut interest_payment = 0u64;
        let mut principal_payment = 0u64;

        if contract.accrued_interest > 0 {
            interest_payment = std::cmp::min(payment_amount, contract.accrued_interest);
            contract.accrued_interest = contract
                .accrued_interest
                .checked_sub(interest_payment)
                .ok_or(StendarError::ArithmeticOverflow)?;
            state.total_interest_paid = state
                .total_interest_paid
                .checked_add(interest_payment)
                .ok_or(StendarError::ArithmeticOverflow)?;
            let remaining_payment = payment_amount
                .checked_sub(interest_payment)
                .ok_or(StendarError::ArithmeticOverflow)?;

            if remaining_payment > 0 {
                principal_payment = remaining_payment;
                contract.outstanding_balance = contract
                    .outstanding_balance
                    .checked_sub(remaining_payment)
                    .ok_or(StendarError::ArithmeticOverflow)?;
                contract.total_principal_paid = contract
                    .total_principal_paid
                    .checked_add(remaining_payment)
                    .ok_or(StendarError::ArithmeticOverflow)?;
            }
        } else {
            principal_payment = payment_amount;
            contract.outstanding_balance = contract
                .outstanding_balance
                .checked_sub(payment_amount)
                .ok_or(StendarError::ArithmeticOverflow)?;
            contract.total_principal_paid = contract
                .total_principal_paid
                .checked_add(payment_amount)
                .ok_or(StendarError::ArithmeticOverflow)?;
        }

        // Distribute payment to lender escrows proportionally.
        let total_funded = contract.funded_amount;
        require!(total_funded > 0, StendarError::InvalidContributionAmount);
        let program_id = ctx.program_id;

        let expected_contribution_accounts = contract.contributions.len();
        let chunk_size = 3usize;
        let expected_remaining_accounts = expected_contribution_accounts
            .checked_mul(chunk_size)
            .ok_or(StendarError::ArithmeticOverflow)?;
        require!(
            ctx.remaining_accounts.len() == expected_remaining_accounts,
            StendarError::InvalidContribution
        );

        // Enforce that each contribution PDA is present exactly once.
        let mut remaining_contributions = contract.contributions.clone();
        let remaining_accounts = &ctx.remaining_accounts;
        let contribution_count = expected_contribution_accounts;
        let mut interest_distributed: u64 = 0;
        let mut principal_distributed: u64 = 0;

        // Process lender account bundles:
        // [contribution, escrow, escrow_usdc_ata]
        for (lender_index, chunk) in remaining_accounts.chunks(chunk_size).enumerate() {
            let contribution_info = &chunk[0];
            let escrow_info = &chunk[1];
            let escrow_usdc_info = &chunk[2];
            let contribution_key = contribution_info.key();

            let contribution_position = remaining_contributions
                .iter()
                .position(|key| *key == contribution_key)
                .ok_or(StendarError::InvalidContribution)?;
            remaining_contributions.swap_remove(contribution_position);

            // Deserialize contribution account
            let contribution_data = contribution_info.try_borrow_data()?;
            let contribution = LenderContribution::try_deserialize(&mut &contribution_data[..])?;
            require_current_version(contribution.account_version)?;

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

            let (expected_escrow_pda, _) = Pubkey::find_program_address(
                &[
                    b"escrow",
                    contract_key.as_ref(),
                    contribution.lender.as_ref(),
                ],
                program_id,
            );
            require!(
                escrow_info.key() == expected_escrow_pda,
                StendarError::InvalidContribution
            );

            // Deserialize and update escrow account
            let mut escrow_data = escrow_info.try_borrow_mut_data()?;
            let mut escrow = LenderEscrow::try_deserialize(&mut &escrow_data[..])?;
            require_current_version(escrow.account_version)?;

            // Validate account relationships to prevent account substitution.
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

            // Calculate proportional interest and principal
            let lender_interest = calculate_lender_share(
                contribution.contribution_amount,
                total_funded,
                interest_payment,
                lender_index,
                contribution_count,
                interest_distributed,
            )?;
            let lender_principal = calculate_lender_share(
                contribution.contribution_amount,
                total_funded,
                principal_payment,
                lender_index,
                contribution_count,
                principal_distributed,
            )?;
            interest_distributed = interest_distributed
                .checked_add(lender_interest)
                .ok_or(StendarError::ArithmeticOverflow)?;
            principal_distributed = principal_distributed
                .checked_add(lender_principal)
                .ok_or(StendarError::ArithmeticOverflow)?;

            let lender_total = lender_interest
                .checked_add(lender_principal)
                .ok_or(StendarError::ArithmeticOverflow)?;

            if lender_total > 0 {
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
                    contract.loan_token_account == contract_usdc_account.key(),
                    StendarError::TokenAccountMismatch
                );
                require!(
                    contract_usdc_account.owner == contract_key
                        && contract_usdc_account.mint == contract.loan_mint,
                    StendarError::TokenAccountMismatch
                );

                let escrow_usdc_mint = accessor::mint(escrow_usdc_info)
                    .map_err(|_| error!(StendarError::TokenAccountMismatch))?;
                let escrow_usdc_owner = accessor::authority(escrow_usdc_info)
                    .map_err(|_| error!(StendarError::TokenAccountMismatch))?;
                require!(
                    escrow_usdc_mint == contract.loan_mint,
                    StendarError::InvalidUsdcMint
                );
                require!(
                    escrow_usdc_owner == escrow_info.key(),
                    StendarError::TokenAccountMismatch
                );

                if escrow.escrow_token_account == Pubkey::default() {
                    escrow.escrow_token_account = escrow_usdc_info.key();
                } else {
                    require!(
                        escrow.escrow_token_account == escrow_usdc_info.key(),
                        StendarError::TokenAccountMismatch
                    );
                }

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
                    expected_contract_pda == contract_key,
                    StendarError::InvalidContractReference
                );
                let bump_bytes = [contract_bump];
                let signer_seeds: &[&[u8]] = &[
                    b"debt_contract",
                    contract.borrower.as_ref(),
                    &contract_seed_bytes,
                    &bump_bytes,
                ];

                token::transfer(
                    CpiContext::new_with_signer(
                        token_program.to_account_info(),
                        Transfer {
                            from: contract_usdc_account.to_account_info(),
                            to: escrow_usdc_info.to_account_info(),
                            authority: contract_info.clone(),
                        },
                        &[signer_seeds],
                    ),
                    lender_total,
                )?;

                escrow.available_interest = escrow
                    .available_interest
                    .checked_add(lender_interest)
                    .ok_or(StendarError::ArithmeticOverflow)?;
                escrow.available_principal = escrow
                    .available_principal
                    .checked_add(lender_principal)
                    .ok_or(StendarError::ArithmeticOverflow)?;
                escrow.escrow_amount = escrow
                    .escrow_amount
                    .checked_add(lender_total)
                    .ok_or(StendarError::ArithmeticOverflow)?;

                // Serialize back to account
                escrow.try_serialize(&mut &mut escrow_data[..])?;
            }
        }

        require!(
            remaining_contributions.is_empty(),
            StendarError::InvalidContribution
        );

        // Check if loan is fully paid
        if contract.outstanding_balance == 0 && contract.accrued_interest == 0 {
            contract.status = ContractStatus::Completed;

            // Return only tracked collateral amount, never the whole account balance.
            let collateral_to_return = contract.collateral_amount;
            if collateral_to_return > 0 {
                let token_program = ctx
                    .accounts
                    .token_program
                    .as_ref()
                    .ok_or(StendarError::MissingTokenAccounts)?;
                let contract_collateral_account = ctx
                    .accounts
                    .contract_collateral_account
                    .as_ref()
                    .ok_or(StendarError::MissingTokenAccounts)?;

                require!(
                    contract_collateral_account.key() == contract.collateral_token_account
                        && contract_collateral_account.owner == contract_key
                        && contract_collateral_account.mint == contract.collateral_mint,
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
                    expected_contract_pda == contract_key,
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
                            account: contract_collateral_account.to_account_info(),
                            destination: borrower_info.clone(),
                            authority: contract_info.clone(),
                        },
                        &[signer_seeds],
                    ))?;
                } else {
                    let borrower_collateral_account = ctx
                        .accounts
                        .borrower_collateral_account
                        .as_ref()
                        .ok_or(StendarError::MissingTokenAccounts)?;
                    require!(
                        borrower_collateral_account.owner == borrower_key
                            && borrower_collateral_account.mint == contract.collateral_mint,
                        StendarError::TokenAccountMismatch
                    );
                    let collateral_token_amount = contract_collateral_account.amount;
                    if collateral_token_amount > 0 {
                        token::transfer(
                            CpiContext::new_with_signer(
                                token_program.to_account_info(),
                                Transfer {
                                    from: contract_collateral_account.to_account_info(),
                                    to: borrower_collateral_account.to_account_info(),
                                    authority: contract_info.clone(),
                                },
                                &[signer_seeds],
                            ),
                            collateral_token_amount,
                        )?;
                    }
                }

                contract.collateral_amount = 0;
            }

            // Refund and close the per-contract operations fund PDA (if present).
            if let Some(ops_info) = ctx.accounts.operations_fund.as_ref() {
                let ops_info = ops_info.clone();
                if ops_info.data_len() > 0 {
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
                    // Drop the data borrow before `realloc`, otherwise the runtime errors with
                    // AccountBorrowFailed (immutable borrow held across mutable borrow).
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

        // Update bot tracking after payment processing
        contract.update_bot_tracking(current_time);

        Ok(())
    })();
    result
}

#[cfg(test)]
mod tests {
    use super::calculate_lender_share;

    #[test]
    fn calculate_lender_share_assigns_rounding_remainder_to_last_lender() {
        let total_funded = 3;
        let total_payment = 100;
        let contribution_count = 3usize;
        let mut distributed = 0u64;
        let mut shares = Vec::new();

        for index in 0..contribution_count {
            let share = calculate_lender_share(
                1,
                total_funded,
                total_payment,
                index,
                contribution_count,
                distributed,
            )
            .expect("share calculation should succeed");
            distributed = distributed
                .checked_add(share)
                .expect("distributed total should not overflow");
            shares.push(share);
        }

        assert_eq!(shares, vec![33, 33, 34]);
        assert_eq!(distributed, total_payment);
    }

    #[test]
    fn calculate_lender_share_is_zero_when_no_payment_exists() {
        let share = calculate_lender_share(10, 100, 0, 0, 1, 0).expect("share should be zero");
        assert_eq!(share, 0);
    }
}
