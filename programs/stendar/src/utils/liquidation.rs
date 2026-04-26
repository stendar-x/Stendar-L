use anchor_lang::prelude::*;

use crate::errors::StendarError;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum HealthStatus {
    Healthy,
    PartialLiquidation,
    FullLiquidation,
}

/// Classify a contract's health using current LTV and configured thresholds.
pub fn check_health(
    current_ltv_bps: u32,
    ltv_floor_bps: u32,
    liquidation_buffer_bps: u16,
) -> HealthStatus {
    if ltv_floor_bps == 0 {
        return HealthStatus::Healthy;
    }

    let partial_threshold = ltv_floor_bps.saturating_add(liquidation_buffer_bps as u32);

    if current_ltv_bps <= ltv_floor_bps {
        HealthStatus::FullLiquidation
    } else if current_ltv_bps <= partial_threshold {
        HealthStatus::PartialLiquidation
    } else {
        HealthStatus::Healthy
    }
}

/// Calculate collateral to seize for a USDC repay amount (including liquidation fee).
///
/// Formula (integer math):
/// collateral_to_seize =
///   repay_amount_usdc * (10_000 + liquidation_fee_bps) * collateral_amount
///   / (collateral_value_usdc * 10_000)
pub fn calculate_collateral_to_seize(
    repay_amount_usdc: u64,
    collateral_amount: u64,
    collateral_value_usdc: u64,
    liquidation_fee_bps: u16,
) -> Result<u64> {
    require!(
        collateral_value_usdc > 0,
        StendarError::InsufficientCollateral
    );

    let numerator = (repay_amount_usdc as u128)
        .checked_mul(10_000u128 + liquidation_fee_bps as u128)
        .and_then(|value| value.checked_mul(collateral_amount as u128))
        .ok_or_else(|| error!(StendarError::ArithmeticOverflow))?;

    let denominator = (collateral_value_usdc as u128)
        .checked_mul(10_000u128)
        .ok_or_else(|| error!(StendarError::ArithmeticOverflow))?;

    let result = numerator
        .checked_div(denominator)
        .ok_or_else(|| error!(StendarError::ArithmeticOverflow))?;

    u64::try_from(result).map_err(|_| error!(StendarError::ArithmeticOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_stendar_error(err: Error, expected: StendarError) {
        match err {
            Error::AnchorError(anchor_err) => {
                assert_eq!(anchor_err.error_name, format!("{expected:?}"));
            }
            _ => panic!("expected AnchorError variant"),
        }
    }

    #[test]
    fn check_health_returns_full_at_or_below_floor() {
        assert_eq!(
            check_health(10_000, 10_000, 500),
            HealthStatus::FullLiquidation
        );
        assert_eq!(
            check_health(9_500, 10_000, 500),
            HealthStatus::FullLiquidation
        );
    }

    #[test]
    fn check_health_returns_partial_between_floor_and_buffer() {
        assert_eq!(
            check_health(10_500, 10_000, 500),
            HealthStatus::PartialLiquidation
        );
        assert_eq!(
            check_health(10_250, 10_000, 500),
            HealthStatus::PartialLiquidation
        );
    }

    #[test]
    fn check_health_returns_healthy_above_partial_threshold() {
        assert_eq!(check_health(10_501, 10_000, 500), HealthStatus::Healthy);
    }

    #[test]
    fn check_health_returns_healthy_when_floor_is_zero() {
        assert_eq!(check_health(0, 0, 500), HealthStatus::Healthy);
        assert_eq!(check_health(250, 0, 500), HealthStatus::Healthy);
    }

    #[test]
    fn collateral_to_seize_matches_reference_example() {
        // 500 USDC repay (6 decimals), 0.05 WBTC collateral (8 decimals),
        // total collateral value 1,050 USDC (6 decimals), 3% fee.
        let seized = calculate_collateral_to_seize(500_000_000, 5_000_000, 1_050_000_000, 300)
            .expect("calculation should succeed");

        assert_eq!(seized, 2_452_380);
    }

    #[test]
    fn collateral_to_seize_rejects_zero_collateral_value() {
        let err = calculate_collateral_to_seize(500_000_000, 5_000_000, 0, 300).unwrap_err();
        assert_stendar_error(err, StendarError::InsufficientCollateral);
    }
}
