mod interest;
mod fees;
mod liquidation;
mod trading;
pub mod token;
mod oracle;

use anchor_lang::prelude::*;

use crate::errors::StendarError;
use crate::state::CURRENT_ACCOUNT_VERSION;

pub use interest::*;
pub use fees::*;
pub use liquidation::*;
pub use trading::*;
#[allow(unused_imports)]
pub use token::*;
#[allow(unused_imports)]
pub use oracle::*;

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

pub fn read_version_from_account(account_info: &AccountInfo, expected_len: usize) -> Result<u16> {
    let data = account_info.try_borrow_data()?;
    // Older layouts can be shorter and may not carry the trailing version field.
    if data.len() < expected_len || data.len() < 2 {
        return Ok(0);
    }

    let offset = data.len() - 2;
    Ok(u16::from_le_bytes([data[offset], data[offset + 1]]))
}

/// Safe narrowing cast from u128 to u64, returning ArithmeticOverflow on truncation.
pub fn safe_u128_to_u64(value: u128) -> Result<u64> {
    u64::try_from(value).map_err(|_| error!(StendarError::ArithmeticOverflow))
}

#[allow(dead_code)]
/// Realloc an account to `new_len` and top up lamports for rent-exemption if needed.
pub fn ensure_rent_exempt_and_realloc<'info>(
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
        let collateral = calculate_proportional_collateral(500, 1_000, 50).expect("math should work");
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
