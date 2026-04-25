use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::errors::StendarError;
#[cfg(feature = "testing")]
use crate::state::MockOraclePriceFeed;

pub const MAX_PRICE_AGE_CREATION: u64 = 120;
pub const MAX_PRICE_AGE_LIQUIDATION: u64 = 60;
pub const MAX_PRICE_AGE_DRAW: u64 = MAX_PRICE_AGE_CREATION;
pub const USDC_DECIMALS: u8 = 6;
pub const MAX_CONFIDENCE_BPS_STANDARD: u64 = 200;
pub const MAX_CONFIDENCE_BPS_LIQUIDATION: u64 = 100;

#[derive(Clone, Copy)]
struct ParsedPythPrice {
    price: i64,
    conf: u64,
    exponent: i32,
    publish_time: i64,
}

pub fn get_price_in_usdc(
    price_feed_account: &AccountInfo,
    max_age_seconds: u64,
    max_confidence_bps: u64,
) -> Result<(u64, i32)> {
    let current_timestamp = Clock::get()?.unix_timestamp;
    get_price_in_usdc_at_timestamp(
        price_feed_account,
        max_age_seconds,
        max_confidence_bps,
        current_timestamp,
    )
}

pub fn validate_price_feed_registration_account(price_feed_account: &AccountInfo) -> Result<()> {
    let _ = parse_pyth_price(price_feed_account)?;
    Ok(())
}

fn get_price_in_usdc_at_timestamp(
    price_feed_account: &AccountInfo,
    max_age_seconds: u64,
    max_confidence_bps: u64,
    current_timestamp: i64,
) -> Result<(u64, i32)> {
    let parsed_price = parse_pyth_price(price_feed_account)?;
    validate_price_freshness(
        parsed_price.publish_time,
        current_timestamp,
        max_age_seconds,
    )?;
    require!(parsed_price.price > 0, StendarError::OraclePriceNegative);

    // Reject prices with confidence intervals wider than the configured basis-point threshold.
    let price_abs = parsed_price.price.unsigned_abs();
    let max_conf = (price_abs as u128)
        .checked_mul(max_confidence_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .ok_or_else(|| error!(StendarError::OracleCalculationOverflow))?;
    require!(
        (parsed_price.conf as u128) <= max_conf,
        StendarError::OraclePriceUnavailable
    );

    let price =
        u64::try_from(parsed_price.price).map_err(|_| error!(StendarError::OraclePriceNegative))?;
    Ok((price, parsed_price.exponent))
}

pub fn calculate_collateral_value_in_usdc(
    collateral_amount: u64,
    collateral_decimals: u8,
    price: u64,
    price_exponent: i32,
) -> Result<u64> {
    let collateral_amount = collateral_amount as u128;
    let price = price as u128;
    let usdc_scale = pow10_u128(USDC_DECIMALS as u32)?;
    let collateral_scale = pow10_u128(collateral_decimals as u32)?;

    let mut numerator = collateral_amount
        .checked_mul(price)
        .and_then(|value| value.checked_mul(usdc_scale))
        .ok_or_else(|| error!(StendarError::OracleCalculationOverflow))?;

    let mut denominator = collateral_scale;

    if price_exponent < 0 {
        let exponent_scale = pow10_u128(price_exponent.unsigned_abs())?;
        denominator = denominator
            .checked_mul(exponent_scale)
            .ok_or_else(|| error!(StendarError::OracleCalculationOverflow))?;
    } else if price_exponent > 0 {
        let exponent_scale = pow10_u128(price_exponent as u32)?;
        numerator = numerator
            .checked_mul(exponent_scale)
            .ok_or_else(|| error!(StendarError::OracleCalculationOverflow))?;
    }

    let value = numerator
        .checked_div(denominator)
        .ok_or_else(|| error!(StendarError::OracleCalculationOverflow))?;

    u64::try_from(value).map_err(|_| error!(StendarError::OracleCalculationOverflow))
}

pub fn calculate_ltv_bps(collateral_value_usdc: u64, loan_amount_usdc: u64) -> Result<u32> {
    require!(loan_amount_usdc > 0, StendarError::InvalidPaymentAmount);

    let ltv_bps = (collateral_value_usdc as u128)
        .checked_mul(10_000)
        .and_then(|value| value.checked_div(loan_amount_usdc as u128))
        .ok_or_else(|| error!(StendarError::OracleCalculationOverflow))?;

    u32::try_from(ltv_bps).map_err(|_| error!(StendarError::OracleCalculationOverflow))
}

pub fn validate_price_freshness(
    price_timestamp: i64,
    current_timestamp: i64,
    max_age_seconds: u64,
) -> Result<()> {
    let age = current_timestamp
        .checked_sub(price_timestamp)
        .ok_or_else(|| error!(StendarError::OraclePriceStale))?;

    require!(age >= 0, StendarError::OraclePriceStale);

    let age_u64 = u64::try_from(age).map_err(|_| error!(StendarError::OraclePriceStale))?;
    require!(age_u64 <= max_age_seconds, StendarError::OraclePriceStale);
    Ok(())
}

fn parse_pyth_price(price_feed_account: &AccountInfo) -> Result<ParsedPythPrice> {
    let account_data = price_feed_account
        .try_borrow_data()
        .map_err(|_| error!(StendarError::OraclePriceUnavailable))?;

    if price_feed_account.owner.to_bytes() == pyth_solana_receiver_sdk::id().to_bytes() {
        return parse_pyth_price_from_data(&account_data);
    }

    #[cfg(feature = "testing")]
    if price_feed_account.owner == &crate::ID {
        let mock = MockOraclePriceFeed::try_deserialize(&mut &account_data[..])
            .map_err(|_| error!(StendarError::OraclePriceUnavailable))?;
        return Ok(ParsedPythPrice {
            price: mock.price,
            conf: 0,
            exponent: mock.exponent,
            publish_time: mock.publish_time,
        });
    }

    Err(error!(StendarError::OraclePriceUnavailable))
}

// Parse only the fields we need using the receiver SDK layout.
fn parse_pyth_price_from_data(data: &[u8]) -> Result<ParsedPythPrice> {
    let price_update = PriceUpdateV2::try_deserialize(&mut &data[..])
        .map_err(|_| error!(StendarError::OraclePriceUnavailable))?;
    let price_data = price_update.price_message;

    Ok(ParsedPythPrice {
        price: price_data.price,
        conf: price_data.conf,
        exponent: price_data.exponent,
        publish_time: price_data.publish_time,
    })
}

fn pow10_u128(exp: u32) -> Result<u128> {
    10_u128
        .checked_pow(exp)
        .ok_or_else(|| error!(StendarError::OracleCalculationOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_mock_price_update_account_data_with_conf(
        price: i64,
        conf: u64,
        exponent: i32,
        publish_time: i64,
    ) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&PriceUpdateV2::DISCRIMINATOR);
        data.extend_from_slice(&Pubkey::default().to_bytes());
        data.push(1); // VerificationLevel::Full
        data.extend_from_slice(&[0u8; 32]); // feed_id
        data.extend_from_slice(&price.to_le_bytes());
        data.extend_from_slice(&conf.to_le_bytes());
        data.extend_from_slice(&exponent.to_le_bytes());
        data.extend_from_slice(&publish_time.to_le_bytes());
        data.extend_from_slice(&(publish_time - 1).to_le_bytes()); // prev_publish_time
        data.extend_from_slice(&price.to_le_bytes()); // ema_price
        data.extend_from_slice(&0u64.to_le_bytes()); // ema_conf
        data.extend_from_slice(&0u64.to_le_bytes()); // posted_slot
        data
    }

    fn build_mock_price_account(
        price: i64,
        exponent: i32,
        publish_time: i64,
    ) -> AccountInfo<'static> {
        build_mock_price_account_with_conf(price, 0, exponent, publish_time)
    }

    fn build_mock_price_account_with_conf(
        price: i64,
        conf: u64,
        exponent: i32,
        publish_time: i64,
    ) -> AccountInfo<'static> {
        let key = Box::leak(Box::new(Pubkey::new_unique()));
        let owner = Box::leak(Box::new(Pubkey::new_from_array(
            pyth_solana_receiver_sdk::id().to_bytes(),
        )));
        let lamports = Box::leak(Box::new(1u64));
        let data = Box::leak(
            build_mock_price_update_account_data_with_conf(price, conf, exponent, publish_time)
                .into_boxed_slice(),
        );

        AccountInfo::new(key, false, false, lamports, data, owner, false, 0)
    }

    fn assert_stendar_error(err: Error, expected: StendarError) {
        match err {
            Error::AnchorError(anchor_err) => {
                assert_eq!(anchor_err.error_name, format!("{expected:?}"));
            }
            _ => panic!("expected AnchorError variant"),
        }
    }

    #[test]
    fn get_price_in_usdc_reads_valid_price_from_mock_account() {
        let account = build_mock_price_account(123_456_789, -8, 1_000);
        let (price, exponent) =
            get_price_in_usdc_at_timestamp(&account, 60, MAX_CONFIDENCE_BPS_STANDARD, 1_050)
                .unwrap();

        assert_eq!(price, 123_456_789);
        assert_eq!(exponent, -8);
    }

    #[test]
    fn parse_pyth_price_from_data_uses_price_update_layout() {
        let data = build_mock_price_update_account_data_with_conf(123_456_789, 1_000, -8, 1_000);
        let parsed = parse_pyth_price_from_data(&data).expect("pyth layout should deserialize");
        assert_eq!(parsed.price, 123_456_789);
        assert_eq!(parsed.conf, 1_000);
        assert_eq!(parsed.exponent, -8);
        assert_eq!(parsed.publish_time, 1_000);
    }

    #[test]
    fn get_price_in_usdc_rejects_stale_prices() {
        let account = build_mock_price_account(123_456_789, -8, 1_000);
        let err = get_price_in_usdc_at_timestamp(&account, 60, MAX_CONFIDENCE_BPS_STANDARD, 1_061)
            .unwrap_err();

        assert_stendar_error(err, StendarError::OraclePriceStale);
    }

    #[test]
    fn get_price_in_usdc_rejects_negative_prices() {
        let account = build_mock_price_account(-1, -8, 1_000);
        let err = get_price_in_usdc_at_timestamp(&account, 60, MAX_CONFIDENCE_BPS_STANDARD, 1_001)
            .unwrap_err();

        assert_stendar_error(err, StendarError::OraclePriceNegative);
    }

    #[test]
    fn collateral_value_calculations_match_known_examples() {
        let one_wbtc = 100_000_000u64;
        let wbtc_price = 6_000_000_000_000u64; // 60,000 * 10^8
        let wbtc_value = calculate_collateral_value_in_usdc(one_wbtc, 8, wbtc_price, -8).unwrap();
        assert_eq!(wbtc_value, 60_000_000_000);

        let one_weth = 100_000_000u64;
        let weth_price = 300_000_000_000u64; // 3,000 * 10^8
        let weth_value = calculate_collateral_value_in_usdc(one_weth, 8, weth_price, -8).unwrap();
        assert_eq!(weth_value, 3_000_000_000);

        let one_msol = 1_000_000_000u64;
        let msol_price = 15_000_000_000u64; // 150 * 10^8
        let msol_value = calculate_collateral_value_in_usdc(one_msol, 9, msol_price, -8).unwrap();
        assert_eq!(msol_value, 150_000_000);
    }

    #[test]
    fn ltv_bps_handles_core_edge_cases() {
        assert_eq!(
            calculate_ltv_bps(1_000_000_000, 1_000_000_000).unwrap(),
            10_000
        );
        assert_eq!(
            calculate_ltv_bps(2_000_000_000, 1_000_000_000).unwrap(),
            20_000
        );
        assert_eq!(
            calculate_ltv_bps(7_000_000_000, 1_000_000_000).unwrap(),
            70_000
        );
        assert_eq!(calculate_ltv_bps(1, 10_000_000).unwrap(), 0);
    }

    #[test]
    fn overflow_paths_return_oracle_overflow_errors() {
        let err = calculate_collateral_value_in_usdc(u64::MAX, 0, u64::MAX, 0).unwrap_err();
        assert_stendar_error(err, StendarError::OracleCalculationOverflow);

        let err = calculate_ltv_bps(u64::MAX, 1).unwrap_err();
        assert_stendar_error(err, StendarError::OracleCalculationOverflow);
    }

    #[test]
    fn price_freshness_accepts_exact_boundary_and_rejects_older() {
        validate_price_freshness(940, 1_000, 60).unwrap();

        let err = validate_price_freshness(939, 1_000, 60).unwrap_err();
        assert_stendar_error(err, StendarError::OraclePriceStale);
    }

    #[test]
    fn accepts_tight_confidence_price() {
        // conf = 1% of price, well within the standard 2% threshold
        let account = build_mock_price_account_with_conf(100_000_000, 1_000_000, -8, 1_000);
        let result =
            get_price_in_usdc_at_timestamp(&account, 60, MAX_CONFIDENCE_BPS_STANDARD, 1_050);
        assert!(result.is_ok());
    }

    #[test]
    fn rejects_low_confidence_price() {
        // conf = 6% of price, exceeds the standard 2% threshold
        let price = 100_000_000i64;
        let conf = 6_000_001u64;
        let account = build_mock_price_account_with_conf(price, conf, -8, 1_000);
        let err = get_price_in_usdc_at_timestamp(&account, 60, MAX_CONFIDENCE_BPS_STANDARD, 1_050)
            .unwrap_err();
        assert_stendar_error(err, StendarError::OraclePriceUnavailable);
    }

    #[test]
    fn tighter_liquidation_confidence_rejects_price_accepted_by_standard_threshold() {
        // 1.5% confidence should pass with 2% threshold and fail with 1% threshold.
        let price = 100_000_000i64;
        let conf = 1_500_000u64;
        let account = build_mock_price_account_with_conf(price, conf, -8, 1_000);

        let standard =
            get_price_in_usdc_at_timestamp(&account, 60, MAX_CONFIDENCE_BPS_STANDARD, 1_050);
        assert!(standard.is_ok());

        let liquidation =
            get_price_in_usdc_at_timestamp(&account, 60, MAX_CONFIDENCE_BPS_LIQUIDATION, 1_050);
        assert!(liquidation.is_err());
    }
}
