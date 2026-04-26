use crate::errors::StendarError;
use crate::state::{
    ContractStatus, DebtContract, LenderContribution, LoanType, PositionValuation,
    MIN_LISTING_AMOUNT,
};
use anchor_lang::prelude::*;

pub fn calculate_position_value(
    contribution: &LenderContribution,
    contract: &DebtContract,
    current_time: i64,
) -> Result<PositionValuation> {
    if !validate_trade_conditions(contract, contribution, current_time)? {
        return Err(StendarError::PositionNotTradeable.into());
    }

    let days_remaining = if contract.loan_type == LoanType::Demand {
        contract.term_days
    } else {
        let term_seconds = (contract.term_days as i64)
            .checked_mul(24 * 60 * 60)
            .ok_or(StendarError::ArithmeticOverflow)?;
        let contract_end = contract
            .created_at
            .checked_add(term_seconds)
            .ok_or(StendarError::ArithmeticOverflow)?;
        let time_remaining = contract_end.saturating_sub(current_time);
        (time_remaining / (24 * 60 * 60)).max(0) as u32
    };

    let lender_share = if contract.funded_amount > 0 {
        (contribution.contribution_amount as u128)
            .checked_mul(1_000_000)
            .and_then(|v| v.checked_div(contract.funded_amount as u128))
            .ok_or(StendarError::ArithmeticOverflow)?
    } else {
        return Err(StendarError::InvalidPositionValuation.into());
    };

    let remaining_contract_principal = contract.outstanding_balance;
    let remaining_principal = {
        let v = (remaining_contract_principal as u128)
            .checked_mul(lender_share)
            .and_then(|v| v.checked_div(1_000_000))
            .ok_or(StendarError::ArithmeticOverflow)?;
        u64::try_from(v).map_err(|_| error!(StendarError::ArithmeticOverflow))?
    };

    let annual_interest_rate = contract.interest_rate as u64;
    let projected_annual_interest = {
        let v = (remaining_principal as u128)
            .checked_mul(annual_interest_rate as u128)
            .and_then(|v| v.checked_div(10000))
            .ok_or(StendarError::ArithmeticOverflow)?;
        u64::try_from(v).map_err(|_| error!(StendarError::ArithmeticOverflow))?
    };
    let projected_remaining_interest = {
        let v = (projected_annual_interest as u128)
            .checked_mul(days_remaining as u128)
            .and_then(|v| v.checked_div(365))
            .ok_or(StendarError::ArithmeticOverflow)?;
        u64::try_from(v).map_err(|_| error!(StendarError::ArithmeticOverflow))?
    };

    let risk_adjustment =
        calculate_risk_adjustment(days_remaining, contract.loan_type, contract.ltv_ratio);

    let gross_value = remaining_principal
        .checked_add(projected_remaining_interest)
        .ok_or(StendarError::ArithmeticOverflow)?;
    let fair_value = {
        let v = (gross_value as u128)
            .checked_mul(risk_adjustment as u128)
            .and_then(|v| v.checked_div(10000))
            .ok_or(StendarError::ArithmeticOverflow)?;
        u64::try_from(v).map_err(|_| error!(StendarError::ArithmeticOverflow))?
    };

    Ok(PositionValuation {
        fair_value,
        remaining_interest: projected_remaining_interest,
        remaining_principal,
        risk_adjustment,
        days_remaining,
    })
}

pub fn validate_trade_conditions(
    contract: &DebtContract,
    contribution: &LenderContribution,
    current_time: i64,
) -> Result<bool> {
    if contract.status != ContractStatus::Active {
        return Ok(false);
    }

    if contract.loan_type == LoanType::Committed {
        let term_seconds = (contract.term_days as i64)
            .checked_mul(24 * 60 * 60)
            .ok_or(StendarError::ArithmeticOverflow)?;
        let contract_end = contract
            .created_at
            .checked_add(term_seconds)
            .ok_or(StendarError::ArithmeticOverflow)?;
        let time_remaining = contract_end.saturating_sub(current_time);
        let min_time_remaining = 30 * 24 * 60 * 60;

        if time_remaining < min_time_remaining {
            return Ok(false);
        }
    }

    if contribution.contribution_amount < MIN_LISTING_AMOUNT {
        return Ok(false);
    }

    let ltv_threshold = 18000;
    if contract.ltv_ratio > ltv_threshold {
        return Ok(false);
    }

    if contribution.is_refunded {
        return Ok(false);
    }

    Ok(true)
}

fn calculate_risk_adjustment(days_remaining: u32, loan_type: LoanType, ltv_ratio: u32) -> u16 {
    let base_rate: u128 = match loan_type {
        LoanType::Committed => 10000,
        LoanType::Demand => 9800,
    };

    let time_adjustment: u128 = if days_remaining > 365 {
        9900
    } else if days_remaining > 180 {
        9950
    } else {
        10000
    };

    let ltv_adjustment: u128 = if ltv_ratio > 8000 {
        9800
    } else if ltv_ratio > 6000 {
        9900
    } else {
        10000
    };

    let result = (base_rate * time_adjustment * ltv_adjustment)
        .checked_div(100_000_000)
        .expect("constant divisor");
    if result > u16::MAX as u128 {
        u16::MAX
    } else {
        result as u16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_contract_for_trading() -> DebtContract {
        DebtContract {
            target_amount: 1_000_000_000,
            funded_amount: 1_000_000_000,
            term_days: 365,
            collateral_amount: 2_000_000_000,
            outstanding_balance: 1_000_000_000,
            max_lenders: 10,
            ..DebtContract::test_default()
        }
    }

    fn sample_contribution() -> LenderContribution {
        LenderContribution {
            contribution_amount: 500_000_000,
            ..LenderContribution::test_default()
        }
    }

    #[test]
    fn position_valuation_checked_arithmetic() {
        let contract = sample_contract_for_trading();
        let contribution = sample_contribution();
        let current_time = 1_700_000_000 + 30 * 24 * 60 * 60;

        let result = calculate_position_value(&contribution, &contract, current_time);
        assert!(result.is_ok());
        let val = result.unwrap();
        assert!(val.fair_value > 0);
        assert!(val.remaining_principal > 0);
    }

    #[test]
    fn position_valuation_expired_committed_contract() {
        let mut contract = sample_contract_for_trading();
        let contribution = sample_contribution();
        contract.loan_type = LoanType::Committed;
        contract.term_days = 1;
        let current_time = contract.created_at + 90 * 24 * 60 * 60;

        let result = calculate_position_value(&contribution, &contract, current_time);
        assert!(
            result.is_err(),
            "expired committed contract should not be tradeable"
        );
    }

    #[test]
    fn demand_loan_tradeable_regardless_of_term_days() {
        let mut contract = sample_contract_for_trading();
        let contribution = sample_contribution();
        contract.loan_type = LoanType::Demand;
        contract.term_days = 30;
        let current_time = contract.created_at + 25 * 24 * 60 * 60;

        let result = validate_trade_conditions(&contract, &contribution, current_time).unwrap();
        assert!(
            result,
            "demand loan should be tradeable even with short term_days"
        );
    }

    #[test]
    fn demand_loan_valuation_uses_term_days() {
        let mut contract = sample_contract_for_trading();
        let contribution = sample_contribution();
        contract.loan_type = LoanType::Demand;
        contract.term_days = 30;
        let current_time = contract.created_at + 25 * 24 * 60 * 60;

        let result = calculate_position_value(&contribution, &contract, current_time);
        assert!(result.is_ok(), "demand loan position should be valued");
        let val = result.unwrap();
        assert!(val.fair_value > 0);
        assert_eq!(val.days_remaining, 30);
    }

    #[test]
    fn validate_conditions_rejects_refunded() {
        let contract = sample_contract_for_trading();
        let mut contribution = sample_contribution();
        contribution.is_refunded = true;
        let current_time = 1_700_000_000 + 24 * 60 * 60;

        let result = validate_trade_conditions(&contract, &contribution, current_time).unwrap();
        assert!(!result, "refunded contribution should not be tradeable");
    }

    #[test]
    fn risk_adjustment_committed_short_term() {
        let adj = calculate_risk_adjustment(90, LoanType::Committed, 5000);
        assert_eq!(adj, 10000, "short-term committed low-LTV should be 100%");
    }
}
