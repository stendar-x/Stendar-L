use anchor_lang::prelude::*;

use crate::errors::StendarError;
use crate::state::{InterestPaymentType, PaymentFrequency, PrincipalPaymentType};

// Platform fee configuration
pub const PLATFORM_FEE_BPS: u64 = 1; // 0.01%
pub const SECONDARY_MARKET_FEE_BPS: u64 = 10; // 0.1%
pub const MIN_PLATFORM_FEE: u64 = 1_000_000; // 0.001 SOL in lamports
pub const MIN_PLATFORM_FEE_USDC: u64 = 10_000; // 0.01 USDC in 6-decimal atomic units
pub const MAX_PLATFORM_FEE_USDC: u64 = 1_000_000; // 1.00 USDC in 6-decimal atomic units
#[allow(dead_code)]
pub const USDC_DECIMALS: u8 = 6;

// Bot ops fund configuration
pub const TX_FEE_ESTIMATE: u64 = 10_000; // lamports per tx (base fee + buffer)
pub const MAX_LENDERS_PER_TX: u16 = 14; // Conservative bound for non-ALT transactions

fn calculate_fee_with_bps(amount: u64, fee_bps: u64, min_fee: u64, max_fee: u64) -> u64 {
    let pct_fee = (amount as u128)
        .saturating_mul(fee_bps as u128)
        .saturating_div(10_000) as u64;
    std::cmp::min(std::cmp::max(pct_fee, min_fee), max_fee)
}

pub fn calculate_platform_fee(amount: u64) -> u64 {
    calculate_fee_with_bps(amount, PLATFORM_FEE_BPS, MIN_PLATFORM_FEE, u64::MAX)
}

pub fn calculate_platform_fee_usdc(amount: u64) -> u64 {
    calculate_fee_with_bps(
        amount,
        PLATFORM_FEE_BPS,
        MIN_PLATFORM_FEE_USDC,
        MAX_PLATFORM_FEE_USDC,
    )
}

pub fn calculate_secondary_market_fee(amount: u64) -> u64 {
    calculate_fee_with_bps(
        amount,
        SECONDARY_MARKET_FEE_BPS,
        MIN_PLATFORM_FEE,
        u64::MAX,
    )
}

pub fn calculate_secondary_market_fee_usdc(amount: u64) -> u64 {
    calculate_fee_with_bps(
        amount,
        SECONDARY_MARKET_FEE_BPS,
        MIN_PLATFORM_FEE_USDC,
        MAX_PLATFORM_FEE_USDC,
    )
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
    // Clamp in case max_lenders is unset in stored account data.
    let effective_max = max_lenders.max(actual_lenders).max(1);
    require!(
        actual_lenders <= effective_max,
        StendarError::InvalidPaymentAmount
    );

    let tx_batches = ceil_div_u16(actual_lenders.max(1), MAX_LENDERS_PER_TX)? as u64;
    tx_batches
        .checked_mul(TX_FEE_ESTIMATE)
        .ok_or(StendarError::ArithmeticOverflow.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{InterestPaymentType, PaymentFrequency, PrincipalPaymentType};

    #[test]
    fn platform_fee_is_pct_or_floor() {
        // Very small amounts should hit the floor.
        assert_eq!(calculate_platform_fee(1), MIN_PLATFORM_FEE);
        assert_eq!(calculate_platform_fee(9_999), MIN_PLATFORM_FEE);

        // 1 SOL = 1_000_000_000 lamports => 1bp = 100_000 lamports, still below the floor.
        assert_eq!(calculate_platform_fee(1_000_000_000), MIN_PLATFORM_FEE);

        // 100 SOL => 100_000_000_000 lamports => 1bp = 10_000_000 lamports > floor.
        assert_eq!(calculate_platform_fee(100_000_000_000), 10_000_000);
    }

    #[test]
    fn secondary_market_fee_is_10bps_or_floor() {
        // Very small amounts should hit the floor.
        assert_eq!(calculate_secondary_market_fee(1), MIN_PLATFORM_FEE);
        assert_eq!(calculate_secondary_market_fee(9_999), MIN_PLATFORM_FEE);

        // 1 SOL = 1_000_000_000 lamports => 10bp = 1_000_000 lamports, equals the floor.
        assert_eq!(
            calculate_secondary_market_fee(1_000_000_000),
            MIN_PLATFORM_FEE
        );

        // 100 SOL => 100_000_000_000 lamports => 10bp = 100_000_000 lamports > floor.
        assert_eq!(calculate_secondary_market_fee(100_000_000_000), 100_000_000);
    }

    #[test]
    fn secondary_market_fee_usdc_uses_usdc_floor() {
        assert_eq!(calculate_secondary_market_fee_usdc(1), MIN_PLATFORM_FEE_USDC);
        assert_eq!(calculate_secondary_market_fee_usdc(9_999), MIN_PLATFORM_FEE_USDC);

        // 100 USDC => 100_000_000 atomic units => 10bp = 100_000.
        assert_eq!(calculate_secondary_market_fee_usdc(100_000_000), 100_000);
    }

    #[test]
    fn secondary_market_fee_usdc_is_capped_at_max() {
        // 20,000 USDC => 20_000_000_000 atomic units => 10bp = 20_000_000 (20 USDC),
        // so the cap should apply.
        assert_eq!(
            calculate_secondary_market_fee_usdc(20_000_000_000),
            MAX_PLATFORM_FEE_USDC
        );
    }

    #[test]
    fn usdc_platform_fee_uses_usdc_floor() {
        // Very small amounts should hit the USDC floor.
        assert_eq!(calculate_platform_fee_usdc(1), MIN_PLATFORM_FEE_USDC);
        assert_eq!(calculate_platform_fee_usdc(9_999), MIN_PLATFORM_FEE_USDC);

        // 1,000 USDC in 6-decimal units => 1_000_000_000 atomic units => 1bp = 100_000.
        assert_eq!(calculate_platform_fee_usdc(1_000_000_000), 100_000);
    }

    #[test]
    fn usdc_platform_fee_is_capped_at_max() {
        // 20,000 USDC => 20_000_000_000 atomic units => 1bp = 2_000_000 (2 USDC),
        // so the cap should apply.
        assert_eq!(
            calculate_platform_fee_usdc(20_000_000_000),
            MAX_PLATFORM_FEE_USDC
        );
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
        assert_eq!(
            calculate_reimbursement(14, 15).unwrap(),
            2 * TX_FEE_ESTIMATE
        );
    }
}
