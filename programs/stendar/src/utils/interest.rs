use super::safe_u128_to_u64;
use crate::errors::StendarError;
use crate::state::{ContractStatus, DebtContract, InterestPaymentType, PrincipalPaymentType};
use anchor_lang::prelude::*;

const MAX_OUTSTANDING_BALANCE_MULTIPLIER: u64 = 10;

pub fn process_automatic_interest(contract: &mut DebtContract, current_time: i64) -> Result<()> {
    if contract.is_revolving {
        if contract.last_interest_update == 0 {
            return Ok(());
        }

        let time_elapsed = current_time
            .checked_sub(contract.last_interest_update)
            .ok_or(StendarError::ArithmeticOverflow)?;
        if time_elapsed <= 0 {
            return Ok(());
        }

        let interest_accrued =
            calculate_interest(contract.drawn_amount, contract.interest_rate as u64, time_elapsed)?;
        if interest_accrued > 0 {
            contract.accrued_interest = contract
                .accrued_interest
                .checked_add(interest_accrued)
                .ok_or(StendarError::ArithmeticOverflow)?;
        }
        contract.last_interest_update = current_time;
        return Ok(());
    }

    if contract.last_interest_update == 0 && contract.status == ContractStatus::Active {
        contract.last_interest_update = contract.created_at;
        return Ok(());
    }

    if contract.last_interest_update == 0 {
        return Ok(());
    }

    let time_elapsed = current_time
        .checked_sub(contract.last_interest_update)
        .ok_or(StendarError::ArithmeticOverflow)?;
    if time_elapsed <= 0 {
        return Ok(());
    }

    let principal_for_interest = match contract.interest_payment_type {
        InterestPaymentType::OutstandingBalance => contract.outstanding_balance,
        InterestPaymentType::CollateralTransfer => contract.target_amount,
    };

    let interest_accrued = calculate_interest(
        principal_for_interest,
        contract.interest_rate as u64,
        time_elapsed,
    )?;

    match contract.interest_payment_type {
        InterestPaymentType::OutstandingBalance => {
            contract.outstanding_balance = contract
                .outstanding_balance
                .checked_add(interest_accrued)
                .ok_or(StendarError::ArithmeticOverflow)?;
            let max_outstanding_balance = contract
                .target_amount
                .saturating_mul(MAX_OUTSTANDING_BALANCE_MULTIPLIER);
            if contract.outstanding_balance > max_outstanding_balance {
                contract.outstanding_balance = max_outstanding_balance;
                msg!(
                    "Outstanding balance growth capped at {}x principal",
                    MAX_OUTSTANDING_BALANCE_MULTIPLIER
                );
            }
        }
        InterestPaymentType::CollateralTransfer => {
            contract.accrued_interest = contract
                .accrued_interest
                .checked_add(interest_accrued)
                .ok_or(StendarError::ArithmeticOverflow)?;
        }
    }

    contract.last_interest_update = current_time;
    Ok(())
}

pub fn calculate_standby_fee(
    undrawn_amount: u64,
    standby_fee_rate: u64,
    time_elapsed: i64,
) -> Result<u64> {
    if time_elapsed <= 0 || undrawn_amount == 0 || standby_fee_rate == 0 {
        return Ok(0);
    }

    let standby_fee = (undrawn_amount as u128)
        .checked_mul(standby_fee_rate as u128)
        .and_then(|value| value.checked_mul(time_elapsed as u128))
        .and_then(|value| value.checked_div(365 * 24 * 60 * 60 * 10_000))
        .ok_or(StendarError::InvalidPaymentAmount)?;

    safe_u128_to_u64(standby_fee)
}

pub fn checkpoint_standby_fees(contract: &mut DebtContract, current_time: i64) -> Result<()> {
    if !contract.is_revolving {
        return Ok(());
    }
    if contract.revolving_closed {
        return Ok(());
    }
    if contract.last_standby_fee_update == 0 {
        contract.last_standby_fee_update = current_time;
        return Ok(());
    }

    let elapsed = current_time
        .checked_sub(contract.last_standby_fee_update)
        .ok_or(StendarError::ArithmeticOverflow)?;
    if elapsed <= 0 {
        return Ok(());
    }

    let undrawn_amount = contract.credit_limit.saturating_sub(contract.drawn_amount);
    let accrued =
        calculate_standby_fee(undrawn_amount, contract.standby_fee_rate as u64, elapsed)?;
    if accrued > 0 {
        contract.accrued_standby_fees = contract
            .accrued_standby_fees
            .checked_add(accrued)
            .ok_or(StendarError::ArithmeticOverflow)?;
    }
    contract.last_standby_fee_update = current_time;
    Ok(())
}

pub fn check_revolving_completion(contract: &DebtContract) -> bool {
    contract.revolving_closed
        && contract.drawn_amount == 0
        && contract.accrued_interest == 0
        && contract.accrued_standby_fees == 0
}

pub fn process_scheduled_principal_payments(
    contract: &mut DebtContract,
    current_time: i64,
) -> Result<()> {
    if contract.last_principal_payment == 0 {
        return Ok(());
    }

    match contract.principal_payment_type {
        PrincipalPaymentType::NoFixedPayment => Ok(()),
        PrincipalPaymentType::CollateralDeduction => {
            if let Some(frequency) = contract.principal_frequency {
                let frequency_seconds = frequency.to_seconds();
                let time_since_last = current_time
                    .checked_sub(contract.last_principal_payment)
                    .ok_or(StendarError::ArithmeticOverflow)?;
                if time_since_last <= 0 {
                    return Ok(());
                }

                if time_since_last >= frequency_seconds {
                    let periods_elapsed = time_since_last / frequency_seconds;

                    require!(contract.term_days > 0, StendarError::InvalidPaymentAmount);
                    let frequency_days = u64::try_from(frequency_seconds / (24 * 60 * 60))
                        .map_err(|_| error!(StendarError::ArithmeticOverflow))?;
                    let elapsed_days = (periods_elapsed as u64)
                        .checked_mul(frequency_days)
                        .ok_or(StendarError::ArithmeticOverflow)?;
                    let expected_total_principal = safe_u128_to_u64(
                        (contract.target_amount as u128)
                            .checked_mul(elapsed_days as u128)
                            .and_then(|v| v.checked_div(contract.term_days as u128))
                            .ok_or(StendarError::ArithmeticOverflow)?,
                    )?
                    .min(contract.target_amount);
                    let total_principal_payment =
                        expected_total_principal.saturating_sub(contract.total_principal_paid);
                    let remaining_principal = contract
                        .target_amount
                        .saturating_sub(contract.total_principal_paid);
                    let actual_payment = total_principal_payment.min(remaining_principal);

                    if actual_payment > 0 {
                        contract.outstanding_balance = contract
                            .outstanding_balance
                            .checked_sub(actual_payment)
                            .ok_or(StendarError::ArithmeticOverflow)?;
                        contract.total_principal_paid = contract
                            .total_principal_paid
                            .checked_add(actual_payment)
                            .ok_or(StendarError::ArithmeticOverflow)?;
                        let elapsed_seconds = periods_elapsed
                            .checked_mul(frequency_seconds)
                            .ok_or(StendarError::ArithmeticOverflow)?;
                        contract.last_principal_payment = contract
                            .last_principal_payment
                            .checked_add(elapsed_seconds)
                            .ok_or(StendarError::ArithmeticOverflow)?;
                    } else {
                        let elapsed_seconds = periods_elapsed
                            .checked_mul(frequency_seconds)
                            .ok_or(StendarError::ArithmeticOverflow)?;
                        contract.last_principal_payment = contract
                            .last_principal_payment
                            .checked_add(elapsed_seconds)
                            .ok_or(StendarError::ArithmeticOverflow)?;
                    }
                }
            }
            Ok(())
        }
    }
}

pub fn calculate_interest(principal: u64, rate: u64, time_elapsed: i64) -> Result<u64> {
    if time_elapsed <= 0 || principal == 0 {
        return Ok(0);
    }

    // Known limitation: this uses integer division and rounds down toward zero.
    // Lenders can be underpaid by sub-atomic amounts across repeated accrual windows.
    let interest = (principal as u128)
        .checked_mul(rate as u128)
        .and_then(|value| value.checked_mul(time_elapsed as u128))
        .and_then(|value| value.checked_div(365 * 24 * 60 * 60 * 10000))
        .ok_or(StendarError::InvalidPaymentAmount)?;

    safe_u128_to_u64(interest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        FundingAccessMode, LoanType, PaymentFrequency, CURRENT_ACCOUNT_VERSION,
        RESERVED_TAIL_BYTES,
    };

    fn sample_contract() -> DebtContract {
        DebtContract {
            borrower: Pubkey::new_unique(),
            contract_seed: 1,
            target_amount: 1_000_000,
            funded_amount: 1_000_000,
            interest_rate: 1_000,
            term_days: 365,
            collateral_amount: 0,
            loan_type: LoanType::Committed,
            ltv_ratio: 0,
            interest_payment_type: InterestPaymentType::OutstandingBalance,
            principal_payment_type: PrincipalPaymentType::CollateralDeduction,
            interest_frequency: PaymentFrequency::Monthly,
            principal_frequency: Some(PaymentFrequency::Daily),
            created_at: 1,
            status: ContractStatus::Active,
            num_contributions: 1,
            outstanding_balance: 1_000_000,
            accrued_interest: 0,
            last_interest_update: 1,
            last_principal_payment: 1,
            total_principal_paid: 0,
            contributions: vec![Pubkey::new_unique()],
            last_bot_update: 0,
            next_interest_payment_due: 0,
            next_principal_payment_due: 0,
            bot_operation_count: 0,
            max_lenders: 14,
            partial_funding_flag: 1,
            expires_at: 0,
            allow_partial_fill: false,
            min_partial_fill_bps: 0,
            listing_fee_paid: 0,
            funding_access_mode: FundingAccessMode::Public,
            has_active_proposal: false,
            proposal_count: 0,
            uncollectable_balance: 0,
            total_prepayment_fees: 0,
            account_version: CURRENT_ACCOUNT_VERSION,
            contract_version: 2,
            collateral_mint: Pubkey::default(),
            collateral_token_account: Pubkey::default(),
            collateral_value_at_creation: 0,
            ltv_floor_bps: 0,
            loan_mint: Pubkey::default(),
            loan_token_account: Pubkey::default(),
            recall_requested: false,
            recall_requested_at: 0,
            recall_requested_by: Pubkey::default(),
            is_revolving: false,
            credit_limit: 0,
            drawn_amount: 0,
            available_amount: 0,
            standby_fee_rate: 0,
            accrued_standby_fees: 0,
            last_standby_fee_update: 0,
            total_draws: 0,
            total_standby_fees_paid: 0,
            revolving_closed: false,
            _reserved: [0u8; RESERVED_TAIL_BYTES],
        }
    }

    #[test]
    fn outstanding_balance_interest_is_capped() {
        let mut contract = sample_contract();
        contract.interest_rate = 10_000; // 100% APR
        let ten_years = 10 * 365 * 24 * 60 * 60;
        let current_time = contract
            .last_interest_update
            .checked_add(ten_years)
            .expect("time math should not overflow");

        process_automatic_interest(&mut contract, current_time).expect("accrual should succeed");

        assert_eq!(contract.outstanding_balance, 10_000_000);
    }

    #[test]
    fn revolving_interest_accrues_on_drawn_amount_to_accrued_interest() {
        let mut contract = sample_contract();
        contract.is_revolving = true;
        contract.drawn_amount = 500_000;
        contract.outstanding_balance = 500_000;
        contract.accrued_interest = 0;
        contract.last_interest_update = 1;
        contract.interest_rate = 1_000; // 10% APR

        let one_year_later = 365 * 24 * 60 * 60 + 1;
        process_automatic_interest(&mut contract, one_year_later).expect("accrual should succeed");

        assert_eq!(contract.accrued_interest, 50_000);
        assert_eq!(contract.outstanding_balance, 500_000);
    }

    #[test]
    fn revolving_interest_still_accrues_after_close() {
        let mut contract = sample_contract();
        contract.is_revolving = true;
        contract.revolving_closed = true;
        contract.drawn_amount = 500_000;
        contract.accrued_interest = 0;
        contract.last_interest_update = 1;
        contract.interest_rate = 1_000; // 10% APR

        let one_year_later = 365 * 24 * 60 * 60 + 1;
        process_automatic_interest(&mut contract, one_year_later).expect("accrual should succeed");

        assert!(contract.accrued_interest > 0);
    }

    #[test]
    fn scheduled_principal_handles_negative_elapsed_time() {
        let mut contract = sample_contract();
        let original_outstanding = contract.outstanding_balance;
        let original_paid = contract.total_principal_paid;
        let original_last_payment = contract.last_principal_payment;

        process_scheduled_principal_payments(&mut contract, 0)
            .expect("negative elapsed time should return early");

        assert_eq!(contract.outstanding_balance, original_outstanding);
        assert_eq!(contract.total_principal_paid, original_paid);
        assert_eq!(contract.last_principal_payment, original_last_payment);
    }

    #[test]
    fn scheduled_principal_uses_remainder_on_final_period() {
        let mut contract = sample_contract();
        contract.target_amount = 100;
        contract.outstanding_balance = 100;
        contract.term_days = 3;
        contract.total_principal_paid = 0;
        contract.principal_frequency = Some(PaymentFrequency::Daily);

        let three_days_later = contract
            .last_principal_payment
            .checked_add(3 * 24 * 60 * 60)
            .expect("time math should not overflow");

        process_scheduled_principal_payments(&mut contract, three_days_later)
            .expect("scheduled principal processing should succeed");

        assert_eq!(contract.total_principal_paid, 100);
        assert_eq!(contract.outstanding_balance, 0);
    }

    #[test]
    fn calculate_standby_fee_matches_expected_formula() {
        let undrawn = 1_000_000u64;
        let rate_bps = 200u64; // 2% APR
        let elapsed = 365 * 24 * 60 * 60;
        let fee = calculate_standby_fee(undrawn, rate_bps, elapsed).expect("fee should compute");
        assert_eq!(fee, 20_000);
    }

    #[test]
    fn checkpoint_standby_fees_accrues_and_updates_timestamp() {
        let mut contract = sample_contract();
        contract.is_revolving = true;
        contract.credit_limit = 1_000_000;
        contract.drawn_amount = 250_000;
        contract.standby_fee_rate = 200; // 2%
        contract.last_standby_fee_update = 1;

        let one_year_later = 365 * 24 * 60 * 60 + 1;
        checkpoint_standby_fees(&mut contract, one_year_later).expect("checkpoint succeeds");

        // 750_000 * 2% = 15_000
        assert_eq!(contract.accrued_standby_fees, 15_000);
        assert_eq!(contract.last_standby_fee_update, one_year_later);
    }

    #[test]
    fn checkpoint_standby_fees_skips_closed_facility() {
        let mut contract = sample_contract();
        contract.is_revolving = true;
        contract.revolving_closed = true;
        contract.credit_limit = 1_000_000;
        contract.drawn_amount = 250_000;
        contract.standby_fee_rate = 200; // 2% APR
        contract.last_standby_fee_update = 1;

        let one_year_later = 365 * 24 * 60 * 60 + 1;
        checkpoint_standby_fees(&mut contract, one_year_later).expect("checkpoint succeeds");

        assert_eq!(contract.accrued_standby_fees, 0);
    }

    #[test]
    fn standby_distribution_saturates_available_amount_at_zero() {
        let mut contract = sample_contract();
        contract.is_revolving = true;
        contract.revolving_closed = false;
        contract.credit_limit = 1_000_000;
        contract.drawn_amount = 0;
        contract.available_amount = 1_000;
        contract.standby_fee_rate = 10_000; // 100% APR
        contract.last_standby_fee_update = 1;

        let one_year_later = 365 * 24 * 60 * 60 + 1;
        checkpoint_standby_fees(&mut contract, one_year_later).expect("checkpoint succeeds");

        let distributed_standby = contract.accrued_standby_fees;
        assert!(distributed_standby > contract.available_amount);
        assert!(contract.available_amount.checked_sub(distributed_standby).is_none());

        contract.available_amount = contract.available_amount.saturating_sub(distributed_standby);

        assert_eq!(contract.available_amount, 0);
    }

    #[test]
    fn checkpoint_standby_fees_accrues_only_before_close() {
        let mut contract = sample_contract();
        contract.is_revolving = true;
        contract.credit_limit = 1_000_000;
        contract.drawn_amount = 250_000;
        contract.standby_fee_rate = 200; // 2% APR
        contract.last_standby_fee_update = 1;

        let first_checkpoint_time = 180 * 24 * 60 * 60 + 1;
        checkpoint_standby_fees(&mut contract, first_checkpoint_time).expect("first checkpoint succeeds");
        let accrued_before_close = contract.accrued_standby_fees;
        assert!(accrued_before_close > 0);

        contract.revolving_closed = true;

        let second_checkpoint_time = first_checkpoint_time + (180 * 24 * 60 * 60);
        checkpoint_standby_fees(&mut contract, second_checkpoint_time)
            .expect("second checkpoint succeeds");

        assert_eq!(contract.accrued_standby_fees, accrued_before_close);
    }

    #[test]
    fn revolving_completion_requires_zero_drawn_and_fees() {
        let mut contract = sample_contract();
        contract.is_revolving = true;
        contract.revolving_closed = true;
        contract.drawn_amount = 0;
        contract.accrued_interest = 0;
        contract.accrued_standby_fees = 0;
        assert!(check_revolving_completion(&contract));

        contract.accrued_standby_fees = 1;
        assert!(!check_revolving_completion(&contract));
    }
}
