use ::stendar as stendar_crate;
use anchor_lang::prelude::*;
use stendar_crate::*;

/// Test contract query filters
#[test]
fn test_contract_query_filters() {
    let current_time = 1_700_000_000;

    // Test interest due filter
    let interest_filter =
        ContractQueryFilter::interest_due_filter(PaymentFrequency::Weekly, current_time);
    assert_eq!(interest_filter.status_filter, Some(ContractStatus::Active));
    assert_eq!(
        interest_filter.interest_frequency_filter,
        Some(PaymentFrequency::Weekly)
    );
    assert_eq!(interest_filter.due_before_timestamp, Some(current_time));

    // Test principal due filter
    let principal_filter =
        ContractQueryFilter::principal_due_filter(PaymentFrequency::Monthly, current_time);
    assert_eq!(principal_filter.status_filter, Some(ContractStatus::Active));
    assert_eq!(
        principal_filter.principal_frequency_filter,
        Some(PaymentFrequency::Monthly)
    );
    assert_eq!(principal_filter.due_before_timestamp, Some(current_time));

    // Test status filter
    let status_filter = ContractQueryFilter::status_filter(ContractStatus::Active);
    assert_eq!(status_filter.status_filter, Some(ContractStatus::Active));
    assert!(status_filter.interest_frequency_filter.is_none());
    assert!(status_filter.principal_frequency_filter.is_none());

    // Test optimized bot filter
    let bot_filter = ContractQueryFilter::optimized_bot_filter(
        PaymentFrequency::Weekly,
        current_time,
        BotPaymentType::Interest,
    );
    assert_eq!(bot_filter.status_filter, Some(ContractStatus::Active));
    assert_eq!(
        bot_filter.interest_frequency_filter,
        Some(PaymentFrequency::Weekly)
    );

    // Test batch filter
    let batch_filter = ContractQueryFilter::batch_filter(
        ContractStatus::Active,
        100,
        Some(PaymentFrequency::Weekly),
    );
    assert_eq!(batch_filter.status_filter, Some(ContractStatus::Active));
    assert_eq!(
        batch_filter.interest_frequency_filter,
        Some(PaymentFrequency::Weekly)
    );
}

/// Test filter optimization and selectivity
#[test]
fn test_filter_optimization() {
    let current_time = 1_700_000_000;

    // Test unoptimized filter
    let basic_filter = ContractQueryFilter {
        status_filter: None,
        interest_frequency_filter: None,
        principal_frequency_filter: None,
        due_before_timestamp: None,
        min_funded_amount: None,
    };
    assert!(!basic_filter.is_optimized());
    assert_eq!(basic_filter.estimated_selectivity(), 1.0);

    // Test optimized filter
    let optimized_filter =
        ContractQueryFilter::interest_due_filter(PaymentFrequency::Weekly, current_time);
    assert!(optimized_filter.is_optimized());
    assert!(optimized_filter.estimated_selectivity() < 0.5);

    // Test highly selective filter
    let selective_filter = ContractQueryFilter {
        status_filter: Some(ContractStatus::Active),
        interest_frequency_filter: Some(PaymentFrequency::Weekly),
        principal_frequency_filter: Some(PaymentFrequency::Monthly),
        due_before_timestamp: Some(current_time),
        min_funded_amount: Some(1000),
    };
    assert!(selective_filter.is_optimized());
    assert!(selective_filter.estimated_selectivity() < 0.1);
}

/// Test filter matching functionality
#[test]
fn test_filter_matching() {
    let current_time = 1_700_000_000;
    let mut contract =
        create_mock_contract(PaymentFrequency::Weekly, Some(PaymentFrequency::Monthly));
    contract.status = ContractStatus::Active;
    contract.funded_amount = 1000;
    contract.next_interest_payment_due = current_time - 1000; // Due for interest
    contract.next_principal_payment_due = current_time + 1000; // Not due for principal

    // Test interest filter match
    let interest_filter =
        ContractQueryFilter::interest_due_filter(PaymentFrequency::Weekly, current_time);
    assert!(interest_filter.matches(&contract, current_time));

    // Test principal filter no match (not due)
    let principal_filter =
        ContractQueryFilter::principal_due_filter(PaymentFrequency::Monthly, current_time);
    assert!(!principal_filter.matches(&contract, current_time));

    // Test status filter match
    let status_filter = ContractQueryFilter::status_filter(ContractStatus::Active);
    assert!(status_filter.matches(&contract, current_time));

    // Test status filter no match
    let wrong_status_filter = ContractQueryFilter::status_filter(ContractStatus::Completed);
    assert!(!wrong_status_filter.matches(&contract, current_time));

    // Test frequency filter no match
    let wrong_freq_filter =
        ContractQueryFilter::interest_due_filter(PaymentFrequency::Monthly, current_time);
    assert!(!wrong_freq_filter.matches(&contract, current_time));
}

/// Test contract query result
#[test]
fn test_contract_query_result() {
    let contracts = vec![Pubkey::new_unique(); 5];
    let result = ContractQueryResult::new(contracts.clone(), 10, 5, 0, 100);

    assert_eq!(result.contracts.len(), 5);
    assert_eq!(result.total_count, 10);
    assert_eq!(result.page_size, 5);
    assert_eq!(result.page_offset, 0);
    assert!(result.has_more);
    assert_eq!(result.query_execution_time, 100);

    // Test last page
    let last_result = ContractQueryResult::new(contracts, 10, 5, 5, 100);
    assert!(!last_result.has_more);
}

/// Test query optimization hints
#[test]
fn test_query_optimization_hints() {
    // Test small result hints
    let small_hints = QueryOptimizationHints::small_result_hints();
    assert!(small_hints.use_index_scan);
    assert!(!small_hints.parallel_processing);
    assert!(small_hints.cache_results);
    assert_eq!(small_hints.estimated_result_size, 100);

    // Test large result hints
    let large_hints = QueryOptimizationHints::large_result_hints();
    assert!(!large_hints.use_index_scan);
    assert!(large_hints.parallel_processing);
    assert!(!large_hints.cache_results);
    assert_eq!(large_hints.estimated_result_size, 10000);

    // Test hints from selective filter
    let selective_filter = ContractQueryFilter {
        status_filter: Some(ContractStatus::Active),
        interest_frequency_filter: Some(PaymentFrequency::Weekly),
        principal_frequency_filter: None,
        due_before_timestamp: Some(1_700_000_000),
        min_funded_amount: Some(1000),
    };
    let hints = QueryOptimizationHints::from_filter(&selective_filter);
    assert!(hints.use_index_scan); // Should use small result hints
    assert!(!hints.parallel_processing);
    assert!(hints.cache_results);

    // Test hints from broad filter
    let broad_filter = ContractQueryFilter {
        status_filter: None,
        interest_frequency_filter: None,
        principal_frequency_filter: None,
        due_before_timestamp: None,
        min_funded_amount: None,
    };
    let broad_hints = QueryOptimizationHints::from_filter(&broad_filter);
    assert!(!broad_hints.use_index_scan); // Should use large result hints
    assert!(broad_hints.parallel_processing);
    assert!(!broad_hints.cache_results);
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
    }
}
