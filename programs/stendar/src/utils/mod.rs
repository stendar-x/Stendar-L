mod fees;
mod interest;
mod liquidation;
mod oracle;
pub mod token;
mod trading;

use anchor_lang::prelude::*;

use crate::errors::StendarError;
use crate::state::CURRENT_ACCOUNT_VERSION;

pub use fees::*;
pub use interest::*;
pub use liquidation::*;
pub use oracle::*;
pub use token::*;
pub use trading::*;

/// Calculate proportional collateral for a lender's share of principal.
///
/// This preserves the contract's LTV for the remaining lenders by reducing
/// collateral in the same proportion as principal.
pub fn calculate_proportional_collateral(
    lender_contribution: u64,
    total_funded: u64,
    total_collateral: u64,
) -> Result<u64> {
    require!(total_funded > 0, StendarError::InvalidContributionAmount);
    let result = (lender_contribution as u128)
        .checked_mul(total_collateral as u128)
        .and_then(|value| value.checked_div(total_funded as u128))
        .ok_or(StendarError::ArithmeticOverflow)?;
    u64::try_from(result).map_err(|_| error!(StendarError::ArithmeticOverflow))
}

/// Safe narrowing cast from u128 to u64, returning ArithmeticOverflow on truncation.
pub fn safe_u128_to_u64(value: u128) -> Result<u64> {
    u64::try_from(value).map_err(|_| error!(StendarError::ArithmeticOverflow))
}

/// Performs a saturating subtraction and emits a warning when saturation occurs.
///
/// This is useful for best-effort metrics where underflow should never block
/// user-facing or bot-triggered settlement flows.
pub fn saturating_sub_with_log(value: &mut u64, amount: u64, context: &str) {
    let previous = *value;
    *value = previous.saturating_sub(amount);
    if amount > previous {
        msg!(
            "saturating_sub_with_log: prevented underflow in {} (previous={}, subtracting={})",
            context,
            previous,
            amount
        );
    }
}

pub fn require_current_version(version: u16) -> Result<()> {
    require!(
        version == CURRENT_ACCOUNT_VERSION,
        StendarError::AccountNeedsMigration
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::calculate_proportional_collateral;
    use crate::errors::StendarError;
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
    fn proportional_collateral_preserves_ratio() {
        let collateral =
            calculate_proportional_collateral(500, 1_000, 50).expect("math should work");
        assert_eq!(collateral, 25);
    }

    #[test]
    fn proportional_collateral_rounds_down() {
        let collateral = calculate_proportional_collateral(1, 3, 10).expect("math should work");
        assert_eq!(collateral, 3);
    }

    #[test]
    fn proportional_collateral_rejects_zero_total_funded() {
        let error = calculate_proportional_collateral(10, 0, 100).expect_err("must fail");
        assert_stendar_error(error, StendarError::InvalidContributionAmount);
    }
}
