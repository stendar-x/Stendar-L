use ::stendar as stendar_crate;
use anchor_lang::prelude::*;
use stendar_crate::*;

/// Test contract state transitions
#[test]
fn test_contract_status_transitions() {
    // Test initial state
    let status = ContractStatus::OpenNotFunded;
    assert!(status.is_open());
    assert!(!status.is_active());
    assert!(!status.is_terminal());

    // Test valid transitions
    let valid_transitions = status.valid_transitions();
    assert_eq!(valid_transitions.len(), 3);
    assert!(valid_transitions.contains(&ContractStatus::OpenPartiallyFunded));
    assert!(valid_transitions.contains(&ContractStatus::Active));
    assert!(valid_transitions.contains(&ContractStatus::Cancelled));

    // Test partially funded state
    let partial_status = ContractStatus::OpenPartiallyFunded;
    assert!(partial_status.is_open());
    assert!(!partial_status.is_active());
    assert!(!partial_status.is_terminal());

    // Test active state
    let active_status = ContractStatus::Active;
    assert!(!active_status.is_open());
    assert!(active_status.is_active());
    assert!(!active_status.is_terminal());

    // Test terminal states
    let completed_status = ContractStatus::Completed;
    assert!(!completed_status.is_open());
    assert!(!completed_status.is_active());
    assert!(completed_status.is_terminal());

    let cancelled_status = ContractStatus::Cancelled;
    assert!(!cancelled_status.is_open());
    assert!(!cancelled_status.is_active());
    assert!(cancelled_status.is_terminal());

    let liquidated_status = ContractStatus::Liquidated;
    assert!(!liquidated_status.is_open());
    assert!(!liquidated_status.is_active());
    assert!(liquidated_status.is_terminal());
}

/// Test payment frequency calculations
#[test]
fn test_payment_frequency_calculations() {
    // Test frequency to seconds conversion
    assert_eq!(PaymentFrequency::Daily.to_seconds(), 24 * 60 * 60);
    assert_eq!(PaymentFrequency::Weekly.to_seconds(), 7 * 24 * 60 * 60);
    assert_eq!(PaymentFrequency::BiWeekly.to_seconds(), 14 * 24 * 60 * 60);
    assert_eq!(PaymentFrequency::Monthly.to_seconds(), 30 * 24 * 60 * 60);

    // Test frequency matching
    let weekly_freq = PaymentFrequency::Weekly;
    let mock_contract = create_mock_contract(weekly_freq, Some(PaymentFrequency::Monthly));

    assert!(weekly_freq.matches_interest_frequency(&mock_contract));
    assert!(!weekly_freq.matches_principal_frequency(&mock_contract));

    let monthly_freq = PaymentFrequency::Monthly;
    assert!(!monthly_freq.matches_interest_frequency(&mock_contract));
    assert!(monthly_freq.matches_principal_frequency(&mock_contract));
}

/// Test debt contract payment calculations
#[test]
fn test_debt_contract_payment_calculations() {
    let mut contract =
        create_mock_contract(PaymentFrequency::Weekly, Some(PaymentFrequency::Monthly));
    let current_time = 1_700_000_000; // Mock timestamp

    // Test initial payment calculations
    let next_interest = contract.calculate_next_interest_payment();
    let next_principal = contract.calculate_next_principal_payment();

    assert!(next_interest > contract.created_at);
    assert!(next_principal > contract.created_at);

    // Test payment due checks
    contract.status = ContractStatus::Active;
    contract.next_interest_payment_due = current_time - 1000; // Past due
    contract.next_principal_payment_due = current_time + 1000; // Future due

    assert!(contract.is_interest_payment_due(current_time));
    assert!(!contract.is_principal_payment_due(current_time));

    // Test bot tracking update
    let old_bot_count = contract.bot_operation_count;
    contract.update_bot_tracking(current_time);
    assert_eq!(contract.bot_operation_count, old_bot_count + 1);
    assert_eq!(contract.last_bot_update, current_time);
}

/// Test contract status determination by funding
#[test]
fn test_contract_status_by_funding() {
    let mut contract =
        create_mock_contract(PaymentFrequency::Weekly, Some(PaymentFrequency::Monthly));

    // Test not funded
    contract.funded_amount = 0;
    contract.target_amount = 1000;
    assert_eq!(
        contract.determine_status_by_funding(),
        ContractStatus::OpenNotFunded
    );

    // Test partially funded
    contract.funded_amount = 500;
    assert_eq!(
        contract.determine_status_by_funding(),
        ContractStatus::OpenPartiallyFunded
    );

    // Test fully funded
    contract.funded_amount = 1000;
    assert_eq!(
        contract.determine_status_by_funding(),
        ContractStatus::Active
    );

    // Test overfunded
    contract.funded_amount = 1500;
    assert_eq!(
        contract.determine_status_by_funding(),
        ContractStatus::Active
    );
}

/// Test edge cases for state transitions
#[test]
fn test_state_edge_cases() {
    // Test contract with no principal frequency
    let contract = create_mock_contract(PaymentFrequency::Weekly, None);
    let monthly_freq = PaymentFrequency::Monthly;
    assert!(!monthly_freq.matches_principal_frequency(&contract));

    // Test contract with equal target and funded amounts
    let mut contract =
        create_mock_contract(PaymentFrequency::Weekly, Some(PaymentFrequency::Monthly));
    contract.target_amount = 1000;
    contract.funded_amount = 1000;
    assert_eq!(
        contract.determine_status_by_funding(),
        ContractStatus::Active
    );
    contract.status = ContractStatus::Active;

    // Test payment due at exact time
    let current_time = 1_700_000_000;
    contract.next_interest_payment_due = current_time;
    assert!(contract.is_interest_payment_due(current_time));

    // Test payment due just before
    contract.next_interest_payment_due = current_time - 1;
    assert!(contract.is_interest_payment_due(current_time));

    // Test payment not due yet
    contract.next_interest_payment_due = current_time + 1;
    assert!(!contract.is_interest_payment_due(current_time));
}

// Helper function for creating mock contracts
fn create_mock_contract(
    interest_freq: PaymentFrequency,
    principal_freq: Option<PaymentFrequency>,
) -> DebtContract {
    DebtContract {
        borrower: Pubkey::new_unique(),
        contract_seed: 1,
        target_amount: 1000,
        funded_amount: 0,
        interest_rate: 500, // 5%
        term_days: 30,
        collateral_amount: 1200,
        loan_type: LoanType::Demand,
        ltv_ratio: 80,
        interest_payment_type: InterestPaymentType::OutstandingBalance,
        principal_payment_type: PrincipalPaymentType::CollateralDeduction,
        interest_frequency: interest_freq,
        principal_frequency: principal_freq,
        created_at: 1_700_000_000,
        status: ContractStatus::OpenNotFunded,
        num_contributions: 0,
        outstanding_balance: 1000,
        accrued_interest: 0,
        last_interest_update: 1_700_000_000,
        last_principal_payment: 1_700_000_000,
        total_principal_paid: 0,
        contributions: vec![],
        last_bot_update: 1_700_000_000,
        next_interest_payment_due: 1_700_000_000 + interest_freq.to_seconds(),
        next_principal_payment_due: if let Some(freq) = principal_freq {
            1_700_000_000 + freq.to_seconds()
        } else {
            0
        },
        bot_operation_count: 0,
        max_lenders: 14,
        partial_funding_flag: 1,
        expires_at: 1_700_604_800,
        allow_partial_fill: false,
        min_partial_fill_bps: 0,
        listing_fee_paid: 0,
        _reserved: [0u8; DEBT_CONTRACT_RESERVED_BYTES],
        account_version: CURRENT_ACCOUNT_VERSION,
        contract_version: 1,
        collateral_mint: Pubkey::default(),
        collateral_token_account: Pubkey::default(),
        collateral_value_at_creation: 0,
        ltv_floor_bps: 0,
        loan_mint: Pubkey::default(),
        loan_token_account: Pubkey::default(),
        recall_requested: false,
        recall_requested_at: 0,
        recall_requested_by: Pubkey::default(),
        _migration_reserve: [0u8; MIGRATION_RESERVE_BYTES],
    }
}
