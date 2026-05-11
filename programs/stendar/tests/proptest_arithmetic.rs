use ::stendar as stendar_crate;
use anchor_lang::prelude::*;
use proptest::prelude::*;
use stendar_crate::{
    calculate_collateral_to_seize, calculate_collateral_value_in_usdc, calculate_fee_tenths_bps,
    calculate_frontend_share, calculate_interest, calculate_ltv_bps, calculate_prepayment_fee,
    calculate_proportional_collateral, calculate_recall_debt_share, calculate_reimbursement,
    calculate_secondary_market_fee, calculate_standby_fee, check_health,
    process_automatic_interest, process_scheduled_principal_payments, ContractStatus, DebtContract,
    FundingAccessMode, HealthStatus, InterestPaymentType, LoanType, PaymentFrequency,
    PrincipalPaymentType, ACCOUNT_RESERVED_BYTES, CURRENT_ACCOUNT_VERSION, FRONTEND_FEE_SHARE_BPS,
    MAX_FRONTEND_FEE_SHARE_BPS, MIN_FRONTEND_FEE_SHARE_BPS, MIN_PLATFORM_FEE, TX_FEE_ESTIMATE,
};

const PROPTEST_CASES: u32 = 256;
const SECONDS_PER_YEAR: i64 = 365 * 24 * 60 * 60;
const ANNUALIZED_BPS_DENOMINATOR: u128 = (SECONDS_PER_YEAR as u128) * 10_000u128;
const LENDERS_PER_TX_BATCH: u16 = 14;

fn linear_accrual_numerator(amount: u64, rate_bps: u64, time_elapsed: i64) -> u128 {
    (amount as u128)
        .checked_mul(rate_bps as u128)
        .and_then(|value| value.checked_mul(time_elapsed as u128))
        .expect("bounded test inputs should not overflow linear accrual numerator")
}

fn ceil_div_u128(numerator: u128, denominator: u128) -> u128 {
    let quotient = numerator / denominator;
    let remainder = numerator % denominator;
    if remainder == 0 {
        quotient
    } else {
        quotient + 1
    }
}

fn health_rank(status: HealthStatus) -> u8 {
    match status {
        HealthStatus::FullLiquidation => 0,
        HealthStatus::PartialLiquidation => 1,
        HealthStatus::Healthy => 2,
    }
}

fn arb_frequency() -> impl Strategy<Value = PaymentFrequency> {
    prop_oneof![
        Just(PaymentFrequency::Daily),
        Just(PaymentFrequency::Weekly),
        Just(PaymentFrequency::BiWeekly),
        Just(PaymentFrequency::Monthly),
    ]
}

fn sample_contract() -> DebtContract {
    DebtContract {
        borrower: Pubkey::new_unique(),
        contract_seed: 99,
        target_amount: 1_000_000,
        funded_amount: 1_000_000,
        interest_rate: 500,
        term_days: 365,
        collateral_amount: 2_000_000,
        loan_type: LoanType::Demand,
        ltv_ratio: 12_000,
        interest_payment_type: InterestPaymentType::OutstandingBalance,
        principal_payment_type: PrincipalPaymentType::CollateralDeduction,
        interest_frequency: PaymentFrequency::Daily,
        principal_frequency: Some(PaymentFrequency::Daily),
        created_at: 1_700_000_000,
        status: ContractStatus::Active,
        num_contributions: 1,
        outstanding_balance: 1_000_000,
        accrued_interest: 0,
        last_interest_update: 1_700_000_000,
        last_principal_payment: 1_700_000_000,
        total_principal_paid: 0,
        contributions: vec![Pubkey::new_unique()],
        last_bot_update: 0,
        next_interest_payment_due: 0,
        next_principal_payment_due: 0,
        bot_operation_count: 0,
        max_lenders: 14,
        partial_funding_flag: 1,
        expires_at: 1_700_864_000,
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
        collateral_mint: Pubkey::new_unique(),
        collateral_token_account: Pubkey::new_unique(),
        collateral_value_at_creation: 2_000_000,
        ltv_floor_bps: 11_000,
        loan_mint: Pubkey::new_unique(),
        loan_token_account: Pubkey::new_unique(),
        recall_requested: false,
        recall_requested_at: 0,
        recall_requested_by: Pubkey::default(),
        is_revolving: false,
        credit_limit: 1_000_000,
        drawn_amount: 0,
        available_amount: 1_000_000,
        standby_fee_rate: 200,
        accrued_standby_fees: 0,
        last_standby_fee_update: 1_700_000_000,
        total_draws: 0,
        total_standby_fees_paid: 0,
        revolving_closed: false,
        frontend: Pubkey::default(),
        _reserved: [0u8; ACCOUNT_RESERVED_BYTES],
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(PROPTEST_CASES))]

    #[test]
    fn recall_debt_share_stays_within_outstanding_and_contribution(
        outstanding in any::<u64>(),
        funded in 1u64..=u64::MAX,
        contribution in any::<u64>(),
    ) {
        let effective_contribution = contribution.min(funded);
        let debt_share = calculate_recall_debt_share(outstanding, funded, effective_contribution)
            .expect("bounded recall debt share should compute");
        prop_assert!(debt_share <= outstanding);
    }

    #[test]
    fn recall_debt_share_does_not_exceed_contribution_when_outstanding_is_bounded(
        outstanding in any::<u64>(),
        funded in 1u64..=u64::MAX,
        contribution in any::<u64>(),
    ) {
        let effective_outstanding = outstanding.min(funded);
        let effective_contribution = contribution.min(funded);
        let debt_share = calculate_recall_debt_share(
            effective_outstanding,
            funded,
            effective_contribution,
        ).expect("bounded recall debt share should compute");
        prop_assert!(debt_share <= effective_contribution);
    }

    #[test]
    fn proportional_collateral_stays_within_total_collateral(
        funded in 1u64..=u64::MAX,
        contribution in any::<u64>(),
        total_collateral in any::<u64>(),
    ) {
        let effective_contribution = contribution.min(funded);
        let share = calculate_proportional_collateral(
            effective_contribution,
            funded,
            total_collateral,
        ).expect("bounded proportional collateral should compute");
        prop_assert!(share <= total_collateral);
    }

    #[test]
    fn interest_is_zero_when_principal_is_zero_or_time_is_non_positive(
        principal in any::<u64>(),
        rate in 0u64..=20_000u64,
        time_elapsed in -1_000_000i64..=1_000_000i64,
    ) {
        prop_assume!(principal == 0 || time_elapsed <= 0);
        let interest = calculate_interest(principal, rate, time_elapsed)
            .expect("zero-principal/non-positive time path should always succeed");
        prop_assert_eq!(interest, 0);
    }

    #[test]
    fn interest_is_zero_when_rate_is_zero_for_positive_principal_and_time(
        principal in 1u64..=10_000_000_000_000u64,
        time_elapsed in 1i64..=(20i64 * SECONDS_PER_YEAR),
    ) {
        let interest = calculate_interest(principal, 0, time_elapsed)
            .expect("zero-rate interest should always compute");
        prop_assert_eq!(interest, 0);
    }

    #[test]
    fn interest_respects_floor_division_bounds_for_positive_inputs(
        principal in 1u64..=10_000_000_000_000u64,
        rate in 1u64..=20_000u64,
        time_elapsed in 1i64..=(20i64 * SECONDS_PER_YEAR),
    ) {
        let numerator = linear_accrual_numerator(principal, rate, time_elapsed);
        prop_assume!(numerator >= ANNUALIZED_BPS_DENOMINATOR);

        let interest = calculate_interest(principal, rate, time_elapsed)
            .expect("positive bounded interest inputs should compute");
        let lower_bound = (interest as u128)
            .checked_mul(ANNUALIZED_BPS_DENOMINATOR)
            .expect("bounded interest lower bound should not overflow");
        let upper_bound = ((interest as u128) + 1)
            .checked_mul(ANNUALIZED_BPS_DENOMINATOR)
            .expect("bounded interest upper bound should not overflow");
        prop_assert!(interest > 0);
        prop_assert!(lower_bound <= numerator);
        prop_assert!(numerator < upper_bound);
    }

    #[test]
    fn standby_fee_is_zero_when_any_zero_or_time_non_positive(
        undrawn in any::<u64>(),
        standby_rate in 0u64..=20_000u64,
        time_elapsed in -1_000_000i64..=1_000_000i64,
    ) {
        prop_assume!(undrawn == 0 || standby_rate == 0 || time_elapsed <= 0);
        let fee = calculate_standby_fee(undrawn, standby_rate, time_elapsed)
            .expect("standby zero branch should always succeed");
        prop_assert_eq!(fee, 0);
    }

    #[test]
    fn standby_fee_respects_floor_division_bounds_for_positive_inputs(
        undrawn in 1u64..=10_000_000_000_000u64,
        standby_rate in 1u64..=20_000u64,
        time_elapsed in 1i64..=(20i64 * SECONDS_PER_YEAR),
    ) {
        let numerator = linear_accrual_numerator(undrawn, standby_rate, time_elapsed);
        prop_assume!(numerator >= ANNUALIZED_BPS_DENOMINATOR);

        let fee = calculate_standby_fee(undrawn, standby_rate, time_elapsed)
            .expect("positive bounded standby inputs should compute");
        let lower_bound = (fee as u128)
            .checked_mul(ANNUALIZED_BPS_DENOMINATOR)
            .expect("bounded standby lower bound should not overflow");
        let upper_bound = ((fee as u128) + 1)
            .checked_mul(ANNUALIZED_BPS_DENOMINATOR)
            .expect("bounded standby upper bound should not overflow");
        prop_assert!(fee > 0);
        prop_assert!(lower_bound <= numerator);
        prop_assert!(numerator < upper_bound);
    }

    #[test]
    fn tenths_bps_fee_matches_reference_floor_formula(
        amount in any::<u64>(),
        fee_tenths_bps in any::<u16>(),
    ) {
        let fee = calculate_fee_tenths_bps(amount, fee_tenths_bps)
            .expect("tenths bps fee should not overflow for u64/u16 inputs");
        let expected = ((amount as u128) * (fee_tenths_bps as u128) / 100_000u128) as u64;
        prop_assert_eq!(fee, expected);
        prop_assert!(fee <= amount);
    }

    #[test]
    fn frontend_share_matches_bps_and_stays_bounded(total_fee in any::<u64>()) {
        let frontend_share = calculate_frontend_share(total_fee)
            .expect("frontend share should always compute for u64 total fee");
        let expected = ((total_fee as u128) * (FRONTEND_FEE_SHARE_BPS as u128) / 10_000u128) as u64;
        let min_bound =
            ((total_fee as u128) * (MIN_FRONTEND_FEE_SHARE_BPS as u128) / 10_000u128) as u64;
        let max_bound =
            ((total_fee as u128) * (MAX_FRONTEND_FEE_SHARE_BPS as u128) / 10_000u128) as u64;
        prop_assert_eq!(frontend_share, expected);
        prop_assert!(frontend_share <= total_fee);
        prop_assert!(frontend_share >= min_bound);
        prop_assert!(frontend_share <= max_bound);
    }

    #[test]
    fn prepayment_fee_never_exceeds_principal(principal in any::<u64>()) {
        let fee = calculate_prepayment_fee(principal)
            .expect("prepayment fee should always compute for u64 principal");
        prop_assert!(fee <= principal);
    }

    #[test]
    fn secondary_market_fee_matches_floor_or_ten_bps(amount in any::<u64>()) {
        let fee = calculate_secondary_market_fee(amount)
            .expect("secondary market fee should always compute");
        let expected = (amount / 1_000).max(MIN_PLATFORM_FEE);
        prop_assert_eq!(fee, expected);
    }

    #[test]
    fn reimbursement_matches_exact_ceil_batch_formula(
        max_lenders in 1u16..=100u16,
        actual_lenders in 1u16..=100u16,
    ) {
        let bounded_actual = actual_lenders.min(max_lenders);
        let reimbursement = calculate_reimbursement(max_lenders, bounded_actual)
            .expect("valid lender counts should compute reimbursement");
        let expected_batches = (u64::from(bounded_actual) + u64::from(LENDERS_PER_TX_BATCH) - 1)
            / u64::from(LENDERS_PER_TX_BATCH);
        let expected = expected_batches
            .checked_mul(TX_FEE_ESTIMATE)
            .expect("bounded reimbursement expectation should not overflow");
        prop_assert_eq!(reimbursement, expected);
    }

    #[test]
    fn reimbursement_is_monotonic_over_increasing_actual_lenders(
        max_lenders in 1u16..=100u16,
        actual_lenders_a in 1u16..=100u16,
        actual_lenders_b in 1u16..=100u16,
    ) {
        let lower_actual = actual_lenders_a.min(actual_lenders_b).min(max_lenders);
        let higher_actual = actual_lenders_a.max(actual_lenders_b).min(max_lenders);
        let lower = calculate_reimbursement(max_lenders, lower_actual)
            .expect("lower bounded lender count should compute reimbursement");
        let higher = calculate_reimbursement(max_lenders, higher_actual)
            .expect("higher bounded lender count should compute reimbursement");
        prop_assert!(higher >= lower);
    }

    #[test]
    fn collateral_to_seize_stays_within_collateral_when_repay_plus_fee_is_covered(
        repay_amount_usdc in 0u64..=1_000_000_000u64,
        collateral_amount in 1u64..=1_000_000_000u64,
        collateral_value_usdc in 1u64..=1_000_000_000u64,
        liquidation_fee_bps in 0u16..=2_000u16,
    ) {
        let lhs = (repay_amount_usdc as u128) * (10_000u128 + liquidation_fee_bps as u128);
        let rhs = (collateral_value_usdc as u128) * 10_000u128;
        prop_assume!(lhs <= rhs);

        let seized = calculate_collateral_to_seize(
            repay_amount_usdc,
            collateral_amount,
            collateral_value_usdc,
            liquidation_fee_bps,
        ).expect("covered repay amount should produce bounded seize amount");

        prop_assert!(seized <= collateral_amount);
    }

    #[test]
    fn collateral_to_seize_uses_protocol_protective_ceiling(
        repay_amount_usdc in 1u64..=1_000_000_000u64,
        collateral_amount in 1u64..=1_000_000_000u64,
        collateral_value_usdc in 1u64..=1_000_000_000u64,
        liquidation_fee_bps in 0u16..=2_000u16,
    ) {
        let seized = calculate_collateral_to_seize(
            repay_amount_usdc,
            collateral_amount,
            collateral_value_usdc,
            liquidation_fee_bps,
        ).expect("bounded collateral seize inputs should compute");

        let numerator = (repay_amount_usdc as u128)
            .checked_mul(10_000u128 + liquidation_fee_bps as u128)
            .and_then(|v| v.checked_mul(collateral_amount as u128))
            .expect("bounded numerator should not overflow");
        let denominator = (collateral_value_usdc as u128)
            .checked_mul(10_000u128)
            .expect("bounded denominator should not overflow");
        let seized_u128 = seized as u128;

        prop_assert!(seized_u128 > 0);
        prop_assert!(
            seized_u128
                .checked_mul(denominator)
                .expect("bounded ceil upper check should not overflow")
                >= numerator
        );
        prop_assert!(
            seized_u128
                .checked_sub(1)
                .and_then(|v| v.checked_mul(denominator))
                .expect("bounded ceil lower check should not overflow")
                < numerator
        );
    }

    #[test]
    fn health_check_is_monotonic_with_higher_ltv(
        ltv_a in any::<u32>(),
        ltv_b in any::<u32>(),
        ltv_floor_bps in any::<u32>(),
        liquidation_buffer_bps in 0u16..=2_000u16,
    ) {
        let lower_ltv = ltv_a.min(ltv_b);
        let higher_ltv = ltv_a.max(ltv_b);

        let lower_rank = health_rank(check_health(lower_ltv, ltv_floor_bps, liquidation_buffer_bps));
        let higher_rank = health_rank(check_health(higher_ltv, ltv_floor_bps, liquidation_buffer_bps));
        prop_assert!(higher_rank >= lower_rank);
    }

    #[test]
    fn collateral_value_calculation_never_panics_for_supported_ranges(
        collateral_amount in any::<u64>(),
        collateral_decimals in 0u8..=12u8,
        price in any::<u64>(),
        price_exponent in -12i32..=12i32,
    ) {
        let _ = calculate_collateral_value_in_usdc(
            collateral_amount,
            collateral_decimals,
            price,
            price_exponent,
        );
    }

    #[test]
    fn ltv_bps_is_monotonic_for_collateral_value(
        collateral_a in any::<u64>(),
        collateral_b in any::<u64>(),
        loan_amount in 1u64..=u64::MAX,
    ) {
        let lower_collateral = collateral_a.min(collateral_b);
        let higher_collateral = collateral_a.max(collateral_b);
        let max_collateral_for_u32 =
            ((u32::MAX as u128) * (loan_amount as u128)) / 10_000u128;
        prop_assume!((higher_collateral as u128) <= max_collateral_for_u32);

        let lower_ltv = calculate_ltv_bps(lower_collateral, loan_amount)
            .expect("bounded lower collateral should compute ltv");
        let higher_ltv = calculate_ltv_bps(higher_collateral, loan_amount)
            .expect("bounded higher collateral should compute ltv");
        prop_assert!(higher_ltv >= lower_ltv);
    }

    #[test]
    fn process_automatic_interest_enforces_cap_and_updates_timestamp(
        target_amount in 1u64..=10_000_000u64,
        outstanding_balance in 0u64..=10_000_000u64,
        interest_rate in 0u32..=20_000u32,
        elapsed_seconds in 1i64..=(20i64 * 365 * 24 * 60 * 60),
    ) {
        let mut contract = sample_contract();
        contract.is_revolving = false;
        contract.status = ContractStatus::Active;
        contract.target_amount = target_amount;
        let max_outstanding = target_amount.saturating_mul(10);
        contract.outstanding_balance = outstanding_balance.min(max_outstanding);
        contract.interest_rate = interest_rate;
        contract.last_interest_update = 1_700_000_000;
        let current_time = contract.last_interest_update + elapsed_seconds;

        process_automatic_interest(&mut contract, current_time)
            .expect("standard automatic interest should process for bounded ranges");

        prop_assert!(contract.outstanding_balance <= max_outstanding);
        prop_assert_eq!(contract.last_interest_update, current_time);
    }

    #[test]
    fn process_automatic_interest_collateral_transfer_accrues_without_balance_growth(
        target_amount in 1u64..=10_000_000u64,
        outstanding_balance in 0u64..=10_000_000u64,
        accrued_interest in 0u64..=1_000_000u64,
        interest_rate in 1u32..=20_000u32,
        elapsed_seconds in 1i64..=(20i64 * 365 * 24 * 60 * 60),
    ) {
        let mut contract = sample_contract();
        contract.is_revolving = false;
        contract.status = ContractStatus::Active;
        contract.interest_payment_type = InterestPaymentType::CollateralTransfer;
        contract.target_amount = target_amount;
        let max_outstanding = target_amount.saturating_mul(10);
        contract.outstanding_balance = outstanding_balance.min(max_outstanding);
        contract.accrued_interest = accrued_interest;
        contract.interest_rate = interest_rate;
        contract.last_interest_update = 1_700_000_000;
        let current_time = contract.last_interest_update + elapsed_seconds;
        let outstanding_before = contract.outstanding_balance;
        let accrued_before = contract.accrued_interest;
        let numerator =
            linear_accrual_numerator(target_amount, interest_rate as u64, elapsed_seconds);
        prop_assume!(numerator >= ANNUALIZED_BPS_DENOMINATOR);

        process_automatic_interest(&mut contract, current_time)
            .expect("collateral-transfer automatic interest should process");

        let accrued_delta = contract.accrued_interest - accrued_before;
        let lower_bound = (accrued_delta as u128)
            .checked_mul(ANNUALIZED_BPS_DENOMINATOR)
            .expect("bounded accrued-interest lower bound should not overflow");
        let upper_bound = ((accrued_delta as u128) + 1)
            .checked_mul(ANNUALIZED_BPS_DENOMINATOR)
            .expect("bounded accrued-interest upper bound should not overflow");

        prop_assert!(accrued_delta > 0);
        prop_assert_eq!(contract.outstanding_balance, outstanding_before);
        prop_assert!(lower_bound <= numerator);
        prop_assert!(numerator < upper_bound);
        prop_assert_eq!(contract.last_interest_update, current_time);
    }

    #[test]
    fn process_automatic_interest_revolving_keeps_accrual_non_decreasing_and_capped(
        credit_limit in 1u64..=10_000_000u64,
        drawn_amount in 0u64..=10_000_000u64,
        accrued_interest in 0u64..=1_000_000u64,
        interest_rate in 0u32..=20_000u32,
        elapsed_seconds in 1i64..=(20i64 * 365 * 24 * 60 * 60),
    ) {
        let mut contract = sample_contract();
        contract.is_revolving = true;
        contract.credit_limit = credit_limit;
        contract.drawn_amount = drawn_amount.min(credit_limit);
        contract.accrued_interest = accrued_interest.min(credit_limit.saturating_mul(10));
        contract.interest_rate = interest_rate;
        contract.last_interest_update = 1_700_000_000;
        let current_time = contract.last_interest_update + elapsed_seconds;
        let accrued_before = contract.accrued_interest;

        process_automatic_interest(&mut contract, current_time)
            .expect("revolving automatic interest should process for bounded ranges");

        prop_assert!(contract.accrued_interest >= accrued_before);
        prop_assert!(contract.accrued_interest <= contract.credit_limit.saturating_mul(10));
        prop_assert_eq!(contract.last_interest_update, current_time);
    }

    #[test]
    fn scheduled_principal_payments_preserve_bounds(
        target_amount in 1u64..=5_000_000u64,
        principal_paid_raw in 0u64..=5_000_000u64,
        term_days in 1u32..=3_650u32,
        payment_frequency in arb_frequency(),
        elapsed_days in 0u32..=7_300u32,
    ) {
        let mut contract = sample_contract();
        let paid = principal_paid_raw.min(target_amount);
        contract.target_amount = target_amount;
        contract.total_principal_paid = paid;
        contract.outstanding_balance = target_amount.saturating_sub(paid);
        contract.term_days = term_days;
        contract.principal_payment_type = PrincipalPaymentType::CollateralDeduction;
        contract.principal_frequency = Some(payment_frequency);
        contract.last_principal_payment = 1_700_000_000;
        let before_last_payment = contract.last_principal_payment;
        let before_outstanding = contract.outstanding_balance;
        let elapsed_seconds = i64::from(elapsed_days) * 24 * 60 * 60;
        let current_time = contract.last_principal_payment + elapsed_seconds;

        process_scheduled_principal_payments(&mut contract, current_time)
            .expect("bounded principal schedule should process");

        prop_assert!(contract.total_principal_paid <= target_amount);
        prop_assert!(contract.outstanding_balance <= before_outstanding);
        prop_assert!(contract.last_principal_payment >= before_last_payment);
        prop_assert!(contract.last_principal_payment <= current_time);
    }
}

#[test]
fn hand_computed_interest_and_standby_vectors_are_exact() {
    let interest_cases = [
        (2_000_000_000u64, 1_000u64, SECONDS_PER_YEAR, 200_000_000u64),
        (1_000_000_000u64, 500u64, SECONDS_PER_YEAR / 2, 25_000_000u64),
        (1_200_000_000u64, 400u64, SECONDS_PER_YEAR / 4, 12_000_000u64),
        (100_000_000_000u64, 1u64, 24 * 60 * 60, 27_397u64),
    ];
    for (principal, rate, elapsed, expected) in interest_cases {
        let actual = calculate_interest(principal, rate, elapsed).expect("interest vector computes");
        assert_eq!(actual, expected);
    }

    let standby_cases = [
        (1_000_000u64, 200u64, SECONDS_PER_YEAR, 20_000u64),
        (5_000_000u64, 50u64, SECONDS_PER_YEAR / 4, 6_250u64),
        (3_000_000u64, 100u64, SECONDS_PER_YEAR / 2, 15_000u64),
        (1_000_000_000u64, 1u64, 24 * 60 * 60, 273u64),
    ];
    for (undrawn, rate, elapsed, expected) in standby_cases {
        let actual =
            calculate_standby_fee(undrawn, rate, elapsed).expect("standby fee vector computes");
        assert_eq!(actual, expected);
    }
}

#[test]
fn boundary_vectors_fee_helpers_cover_floor_and_large_inputs() {
    assert_eq!(calculate_fee_tenths_bps(99_999, 1).unwrap(), 0);
    assert_eq!(calculate_fee_tenths_bps(100_000, 1).unwrap(), 1);
    assert_eq!(
        calculate_fee_tenths_bps(u64::MAX, u16::MAX).unwrap(),
        ((u64::MAX as u128) * (u16::MAX as u128) / 100_000u128) as u64
    );

    assert_eq!(calculate_secondary_market_fee(1).unwrap(), MIN_PLATFORM_FEE);
    assert_eq!(
        calculate_secondary_market_fee(999_999_999).unwrap(),
        MIN_PLATFORM_FEE
    );
    assert_eq!(
        calculate_secondary_market_fee(1_000_000_000).unwrap(),
        MIN_PLATFORM_FEE
    );
    assert_eq!(
        calculate_secondary_market_fee(1_000_001_000).unwrap(),
        1_000_001
    );
    assert_eq!(
        calculate_secondary_market_fee(u64::MAX).unwrap(),
        u64::MAX / 1_000
    );
}

#[test]
fn boundary_vectors_collateral_and_accounting_helpers_are_exact() {
    let collateral_cases = [
        (500_000_000u64, 5_000_000u64, 1_050_000_000u64, 300u16),
        (1u64, 1u64, 3u64, 0u16),
        (2u64, 3u64, 4u64, 500u16),
        (u64::MAX / 2, 2u64, u64::MAX, 0u16),
    ];
    for (repay, collateral_amount, collateral_value, liquidation_fee_bps) in collateral_cases {
        let numerator = (repay as u128)
            .checked_mul(10_000u128 + liquidation_fee_bps as u128)
            .and_then(|value| value.checked_mul(collateral_amount as u128))
            .expect("vector numerator should not overflow");
        let denominator = (collateral_value as u128)
            .checked_mul(10_000u128)
            .expect("vector denominator should not overflow");
        let expected = ceil_div_u128(numerator, denominator) as u64;
        let actual = calculate_collateral_to_seize(
            repay,
            collateral_amount,
            collateral_value,
            liquidation_fee_bps,
        )
        .expect("collateral vector should compute");
        assert_eq!(actual, expected);
    }

    assert_eq!(
        calculate_recall_debt_share(u64::MAX, u64::MAX, u64::MAX).unwrap(),
        u64::MAX
    );
    assert_eq!(
        calculate_proportional_collateral(u64::MAX, u64::MAX, u64::MAX).unwrap(),
        u64::MAX
    );
    assert_eq!(calculate_reimbursement(14, 14).unwrap(), TX_FEE_ESTIMATE);
    assert_eq!(calculate_reimbursement(100, 100).unwrap(), 8 * TX_FEE_ESTIMATE);

    assert_eq!(calculate_ltv_bps(429_496, 1).unwrap(), 4_294_960_000);
    assert!(calculate_ltv_bps(429_497, 1).is_err());
}

#[test]
fn near_overflow_vectors_fail_with_errors() {
    assert!(calculate_interest(u64::MAX, u64::MAX, i64::MAX).is_err());
    assert!(calculate_standby_fee(u64::MAX, u64::MAX, i64::MAX).is_err());
    assert!(calculate_collateral_to_seize(u64::MAX, u64::MAX, u64::MAX, u16::MAX).is_err());
    assert!(calculate_collateral_value_in_usdc(u64::MAX, 0, u64::MAX, 12).is_err());
}
