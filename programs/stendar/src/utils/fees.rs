use anchor_lang::prelude::*;

use crate::errors::StendarError;
use crate::state::{
    InterestPaymentType, PaymentFrequency, PrincipalPaymentType, FRONTEND_FEE_SHARE_BPS,
    PREPAYMENT_FEE_BPS,
};

pub const SECONDARY_MARKET_FEE_BPS: u64 = 10;
pub const MIN_PLATFORM_FEE: u64 = 1_000_000;

pub const TX_FEE_ESTIMATE: u64 = 10_000;
/// Conservative bound for non-ALT transactions.
pub const MAX_LENDERS_PER_TX: u16 = 14;

/// Denominator for standard basis-point calculations (1 bp = 0.01%).
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Denominator for fee fields stored in tenths-of-basis-points.
/// 1 = 0.001%, so 100_000 = 100%.
pub const TENTHS_OF_BPS_DENOMINATOR: u128 = 100_000;

/// Calculates a proportional fee using tenths-of-basis-points precision.
///
/// The computation floors on division to round down in favor of users.
pub fn calculate_fee_tenths_bps(amount: u64, fee_tenths_bps: u16) -> Result<u64> {
    if amount == 0 || fee_tenths_bps == 0 {
        return Ok(0);
    }

    let fee = (amount as u128)
        .checked_mul(fee_tenths_bps as u128)
        .ok_or(StendarError::ArithmeticOverflow)?
        .checked_div(TENTHS_OF_BPS_DENOMINATOR)
        .ok_or(StendarError::ArithmeticOverflow)?;

    u64::try_from(fee).map_err(|_| error!(StendarError::ArithmeticOverflow))
}

pub fn calculate_frontend_share(total_fee: u64) -> Result<u64> {
    if total_fee == 0 {
        return Ok(0);
    }

    let share = (total_fee as u128)
        .checked_mul(FRONTEND_FEE_SHARE_BPS as u128)
        .ok_or(StendarError::ArithmeticOverflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(StendarError::ArithmeticOverflow)?;

    u64::try_from(share).map_err(|_| error!(StendarError::ArithmeticOverflow))
}

fn calculate_fee_with_bps(amount: u64, fee_bps: u64, min_fee: u64, max_fee: u64) -> Result<u64> {
    let pct_fee = (amount as u128)
        .checked_mul(fee_bps as u128)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR))
        .ok_or(StendarError::ArithmeticOverflow)?;
    let pct_fee = u64::try_from(pct_fee).map_err(|_| error!(StendarError::ArithmeticOverflow))?;
    Ok(std::cmp::min(std::cmp::max(pct_fee, min_fee), max_fee))
}

pub fn calculate_prepayment_fee(principal_amount: u64) -> Result<u64> {
    let fee = (principal_amount as u128)
        .checked_mul(PREPAYMENT_FEE_BPS as u128)
        .and_then(|value| value.checked_div(BPS_DENOMINATOR))
        .ok_or(StendarError::ArithmeticOverflow)?;
    u64::try_from(fee).map_err(|_| error!(StendarError::ArithmeticOverflow))
}

pub fn calculate_secondary_market_fee(amount: u64) -> Result<u64> {
    calculate_fee_with_bps(amount, SECONDARY_MARKET_FEE_BPS, MIN_PLATFORM_FEE, u64::MAX)
}

fn ceil_div_u16(n: u16, d: u16) -> Result<u16> {
    require!(d != 0, StendarError::InvalidPaymentAmount);
    Ok((n / d).saturating_add(((n % d) != 0) as u16))
}

fn frequency_days(freq: PaymentFrequency) -> u32 {
    // The enum uses fixed periods (Daily=1, Weekly=7, BiWeekly=14, Monthly=30).
    (freq.to_seconds() / (24 * 60 * 60)) as u32
}

pub fn estimate_total_operations(
    term_days: u32,
    interest_payment_type: InterestPaymentType,
    principal_payment_type: PrincipalPaymentType,
    interest_frequency: PaymentFrequency,
    principal_frequency: Option<PaymentFrequency>,
) -> Result<u32> {
    let interest_ops = if interest_payment_type == InterestPaymentType::CollateralTransfer {
        let days = frequency_days(interest_frequency).max(1);
        term_days / days
    } else {
        0
    };

    let principal_ops = if principal_payment_type == PrincipalPaymentType::CollateralDeduction {
        let freq = principal_frequency.ok_or(StendarError::InvalidPaymentAmount)?;
        let days = frequency_days(freq).max(1);
        term_days / days
    } else {
        0
    };

    interest_ops
        .checked_add(principal_ops)
        .ok_or(StendarError::ArithmeticOverflow.into())
}

fn calculate_operations_fund_with_rent_exempt_min(
    term_days: u32,
    interest_payment_type: InterestPaymentType,
    principal_payment_type: PrincipalPaymentType,
    interest_frequency: PaymentFrequency,
    principal_frequency: Option<PaymentFrequency>,
    max_lenders: u16,
    rent_exempt_min: u64,
) -> Result<(u64, u32)> {
    let estimated_ops = estimate_total_operations(
        term_days,
        interest_payment_type,
        principal_payment_type,
        interest_frequency,
        principal_frequency,
    )?;

    let tx_batches = ceil_div_u16(max_lenders, MAX_LENDERS_PER_TX)? as u64;
    let total_txs = (estimated_ops as u64)
        .checked_mul(tx_batches)
        .ok_or(StendarError::ArithmeticOverflow)?;
    let operations_cost = total_txs
        .checked_mul(TX_FEE_ESTIMATE)
        .ok_or(StendarError::ArithmeticOverflow)?;

    let total = rent_exempt_min
        .checked_add(operations_cost)
        .ok_or(StendarError::ArithmeticOverflow)?;

    Ok((total, estimated_ops))
}

pub fn calculate_operations_fund(
    term_days: u32,
    interest_payment_type: InterestPaymentType,
    principal_payment_type: PrincipalPaymentType,
    interest_frequency: PaymentFrequency,
    principal_frequency: Option<PaymentFrequency>,
    max_lenders: u16,
    fund_account_len: usize,
) -> Result<(u64, u32)> {
    let rent_exempt_min = Rent::get()?.minimum_balance(fund_account_len);
    calculate_operations_fund_with_rent_exempt_min(
        term_days,
        interest_payment_type,
        principal_payment_type,
        interest_frequency,
        principal_frequency,
        max_lenders,
        rent_exempt_min,
    )
}

pub fn calculate_reimbursement(max_lenders: u16, actual_lenders: u16) -> Result<u64> {
    require!(max_lenders > 0, StendarError::InvalidMaxLenders);
    require!(actual_lenders > 0, StendarError::InvalidPaymentAmount);
    require!(
        actual_lenders <= max_lenders,
        StendarError::InvalidPaymentAmount
    );

    let tx_batches = ceil_div_u16(actual_lenders, MAX_LENDERS_PER_TX)? as u64;
    tx_batches
        .checked_mul(TX_FEE_ESTIMATE)
        .ok_or(StendarError::ArithmeticOverflow.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{InterestPaymentType, PaymentFrequency, PrincipalPaymentType};

    #[test]
    fn secondary_market_fee_is_10bps_or_floor() {
        // Very small amounts should hit the floor.
        assert_eq!(calculate_secondary_market_fee(1).unwrap(), MIN_PLATFORM_FEE);
        assert_eq!(
            calculate_secondary_market_fee(9_999).unwrap(),
            MIN_PLATFORM_FEE
        );

        // 1 SOL = 1_000_000_000 lamports => 10bp = 1_000_000 lamports, equals the floor.
        assert_eq!(
            calculate_secondary_market_fee(1_000_000_000).unwrap(),
            MIN_PLATFORM_FEE
        );

        // 100 SOL => 100_000_000_000 lamports => 10bp = 100_000_000 lamports > floor.
        assert_eq!(
            calculate_secondary_market_fee(100_000_000_000).unwrap(),
            100_000_000
        );
    }

    #[test]
    fn fee_with_bps_returns_error_on_conversion_overflow() {
        let err = calculate_fee_with_bps(u64::MAX, u64::MAX, 0, u64::MAX);
        assert!(err.is_err());
    }

    #[test]
    fn tenths_bps_fee_rounds_down_in_user_favor() {
        // 999 * 1 / 100_000 = 0.00999 => floor to 0.
        assert_eq!(calculate_fee_tenths_bps(999, 1).unwrap(), 0);
        assert_eq!(calculate_fee_tenths_bps(100_000, 1).unwrap(), 1);
    }

    #[test]
    fn tenths_bps_fee_handles_large_amounts_without_overflow() {
        let amount = u64::MAX;
        let fee = calculate_fee_tenths_bps(amount, 65_535).unwrap();
        let expected = ((amount as u128) * 65_535u128 / TENTHS_OF_BPS_DENOMINATOR) as u64;
        assert_eq!(fee, expected);
    }

    #[test]
    fn operations_estimate_matches_integer_division_spec() {
        // Interest only: CollateralTransfer with monthly (30d) over 60 days => 2 ops.
        let ops = estimate_total_operations(
            60,
            InterestPaymentType::CollateralTransfer,
            PrincipalPaymentType::NoFixedPayment,
            PaymentFrequency::Monthly,
            None,
        )
        .unwrap();
        assert_eq!(ops, 2);

        // Principal only: daily over 30 days => 30 ops.
        let ops = estimate_total_operations(
            30,
            InterestPaymentType::OutstandingBalance,
            PrincipalPaymentType::CollateralDeduction,
            PaymentFrequency::Monthly,
            Some(PaymentFrequency::Daily),
        )
        .unwrap();
        assert_eq!(ops, 30);
    }

    #[test]
    fn operations_fund_total_includes_rent_and_ops_cost() {
        let rent_exempt_min = 1_000_000u64;

        // Weekly interest transfers over 30 days => floor(30/7)=4 operations.
        let (total, estimated_ops) = calculate_operations_fund_with_rent_exempt_min(
            30,
            InterestPaymentType::CollateralTransfer,
            PrincipalPaymentType::NoFixedPayment,
            PaymentFrequency::Weekly,
            None,
            14,
            rent_exempt_min,
        )
        .unwrap();

        assert_eq!(estimated_ops, 4);
        assert_eq!(total, rent_exempt_min + (4 * TX_FEE_ESTIMATE));

        // If the contract expects >14 lenders, we estimate multiple tx batches per operation.
        let (total, estimated_ops) = calculate_operations_fund_with_rent_exempt_min(
            30,
            InterestPaymentType::CollateralTransfer,
            PrincipalPaymentType::NoFixedPayment,
            PaymentFrequency::Weekly,
            None,
            15,
            rent_exempt_min,
        )
        .unwrap();

        assert_eq!(estimated_ops, 4);
        assert_eq!(total, rent_exempt_min + (8 * TX_FEE_ESTIMATE));
    }

    #[test]
    fn reimbursement_batches_by_actual_lenders() {
        assert_eq!(calculate_reimbursement(14, 1).unwrap(), 1 * TX_FEE_ESTIMATE);
        assert_eq!(
            calculate_reimbursement(14, 14).unwrap(),
            1 * TX_FEE_ESTIMATE
        );
        assert!(calculate_reimbursement(14, 15).is_err());
    }

    #[test]
    fn reimbursement_rejects_zero_lender_inputs() {
        assert!(calculate_reimbursement(0, 1).is_err());
        assert!(calculate_reimbursement(14, 0).is_err());
    }

    #[test]
    fn prepayment_fee_handles_edge_cases_and_rounding() {
        assert_eq!(calculate_prepayment_fee(0).unwrap(), 0);
        assert_eq!(calculate_prepayment_fee(1).unwrap(), 0);
        assert_eq!(calculate_prepayment_fee(50).unwrap(), 1);
        assert_eq!(calculate_prepayment_fee(100).unwrap(), 2);
    }

    #[test]
    fn prepayment_fee_supports_large_amounts() {
        let fee = calculate_prepayment_fee(u64::MAX).unwrap();
        let expected = ((u64::MAX as u128) * (PREPAYMENT_FEE_BPS as u128) / BPS_DENOMINATOR) as u64;
        assert_eq!(fee, expected);
    }

    #[test]
    fn frontend_share_zero_fee() {
        assert_eq!(calculate_frontend_share(0).unwrap(), 0);
    }

    #[test]
    fn frontend_share_one_lamport() {
        assert_eq!(calculate_frontend_share(1).unwrap(), 0);
    }

    #[test]
    fn frontend_share_two_lamports() {
        assert_eq!(calculate_frontend_share(2).unwrap(), 1);
    }

    #[test]
    fn frontend_share_normal() {
        assert_eq!(calculate_frontend_share(10_000).unwrap(), 5_000);
    }

    #[test]
    fn frontend_share_odd() {
        assert_eq!(calculate_frontend_share(3).unwrap(), 1);
    }

    #[test]
    fn frontend_share_large() {
        assert_eq!(
            calculate_frontend_share(u64::MAX).unwrap(),
            ((u64::MAX as u128) * (FRONTEND_FEE_SHARE_BPS as u128) / BPS_DENOMINATOR) as u64
        );
    }

    #[test]
    fn frontend_share_plus_treasury_equals_total() {
        let total_fee = 12_345u64;
        let frontend_share = calculate_frontend_share(total_fee).unwrap();
        let treasury_share = total_fee - frontend_share;

        assert_eq!(frontend_share + treasury_share, total_fee);
    }
}
