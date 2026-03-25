use crate::errors::StendarError;
use crate::state::{ContractStatus, DebtContract, InterestPaymentType, PrincipalPaymentType};
use super::safe_u128_to_u64;
use anchor_lang::prelude::*;

pub fn process_automatic_interest(contract: &mut DebtContract, current_time: i64) -> Result<()> {
    if contract.last_interest_update == 0 && contract.status == ContractStatus::Active {
        contract.last_interest_update = contract.created_at;
        return Ok(());
    }

    if contract.last_interest_update == 0 {
        return Ok(());
    }

    let time_elapsed = current_time - contract.last_interest_update;
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
                let time_since_last = current_time - contract.last_principal_payment;

                if time_since_last >= frequency_seconds {
                    let periods_elapsed = time_since_last / frequency_seconds;

                    require!(contract.term_days > 0, StendarError::InvalidPaymentAmount);
                    let daily_principal_rate = contract.target_amount / (contract.term_days as u64);
                    let frequency_days = frequency_seconds / (24 * 60 * 60);
                    let principal_per_period = daily_principal_rate
                        .checked_mul(frequency_days as u64)
                        .ok_or(StendarError::ArithmeticOverflow)?;

                    let total_principal_payment = principal_per_period
                        .checked_mul(periods_elapsed as u64)
                        .ok_or(StendarError::ArithmeticOverflow)?;
                    let remaining_principal = contract
                        .target_amount
                        .saturating_sub(contract.total_principal_paid);
                    let actual_payment = total_principal_payment.min(remaining_principal);

                    if actual_payment > 0 {
                        contract.outstanding_balance =
                            contract.outstanding_balance.saturating_sub(actual_payment);
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

    let interest = (principal as u128)
        .checked_mul(rate as u128)
        .and_then(|value| value.checked_mul(time_elapsed as u128))
        .and_then(|value| value.checked_div(365 * 24 * 60 * 60 * 10000))
        .ok_or(StendarError::InvalidPaymentAmount)?;

    safe_u128_to_u64(interest)
}
