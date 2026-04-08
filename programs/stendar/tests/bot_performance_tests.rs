use ::stendar as stendar_crate;
use anchor_lang::prelude::*;
use stendar_crate::*;

/// Test large-scale processing scenarios
#[test]
fn test_large_scale_processing() {
    let _current_time = 1_700_000_000;

    // Create a large number of contracts
    let filter = ContractQueryFilter::status_filter(ContractStatus::Active);
    let large_contract_set = create_mock_contracts(
        1000,
        PaymentFrequency::Weekly,
        Some(PaymentFrequency::Monthly),
    );

    // Test iterator for large dataset
    let mut iterator = ContractIterator::new(filter, 100, large_contract_set.len() as u32);

    let mut total_processed = 0;
    let mut batch_count = 0;

    while iterator.has_next() {
        if let Some((start, end)) = iterator.next_batch() {
            total_processed += end - start;
            batch_count += 1;
        }
    }

    assert_eq!(total_processed, 1000);
    assert_eq!(batch_count, 10); // 1000 / 100 = 10 batches
    assert_eq!(iterator.progress(), 1.0);

    // Test batch optimization for large sets
    let large_batch = ContractBatch::new(
        large_contract_set
            .iter()
            .map(|_| Pubkey::new_unique())
            .collect(),
        1,
        BotPaymentType::Interest,
        PaymentFrequency::Weekly,
    );

    assert_eq!(large_batch.contracts.len(), 1000);
    assert_eq!(large_batch.estimated_processing_time, 50000); // 1000 * 50ms
    assert_eq!(large_batch.optimal_chunk_size(), 50);
}

/// Test query optimization in practice
#[test]
fn test_query_optimization_in_practice() {
    let current_time = 1_700_000_000;

    // Create selective filter (should use small result hints)
    let selective_filter = ContractQueryFilter {
        status_filter: Some(ContractStatus::Active),
        interest_frequency_filter: Some(PaymentFrequency::Daily),
        principal_frequency_filter: None,
        due_before_timestamp: Some(current_time),
        min_funded_amount: Some(1000),
    };

    let hints = QueryOptimizationHints::from_filter(&selective_filter);
    assert!(hints.use_index_scan);
    assert!(!hints.parallel_processing);
    assert!(hints.cache_results);
    assert_eq!(hints.estimated_result_size, 100);

    // Create broad filter (should use large result hints)
    let broad_filter = ContractQueryFilter {
        status_filter: None,
        interest_frequency_filter: None,
        principal_frequency_filter: None,
        due_before_timestamp: None,
        min_funded_amount: None,
    };

    let large_hints = QueryOptimizationHints::from_filter(&broad_filter);
    assert!(!large_hints.use_index_scan);
    assert!(large_hints.parallel_processing);
    assert!(!large_hints.cache_results);
    assert_eq!(large_hints.estimated_result_size, 10000);

    // Test selectivity calculation accuracy
    assert!(selective_filter.estimated_selectivity() < 0.1);
    assert_eq!(broad_filter.estimated_selectivity(), 1.0);
}

/// Test performance under stress conditions
#[test]
fn test_performance_stress_conditions() {
    let _current_time = 1_700_000_000;

    // Test with maximum batch sizes
    let max_batch = ContractBatch::new(
        vec![Pubkey::new_unique(); 10000],
        1,
        BotPaymentType::Interest,
        PaymentFrequency::Daily,
    );

    assert_eq!(max_batch.contracts.len(), 10000);
    assert_eq!(max_batch.estimated_processing_time, 500000); // 10000 * 50ms
    assert_eq!(max_batch.optimal_chunk_size(), 20);
    assert!(max_batch.is_high_priority());

    // Test iterator with very large datasets
    let stress_filter = ContractQueryFilter::status_filter(ContractStatus::Active);
    let mut stress_iterator = ContractIterator::new(stress_filter, 1000, 50000);

    // Process first few batches to verify functionality
    let mut batches_processed = 0;
    for _ in 0..5 {
        if let Some((start, end)) = stress_iterator.next_batch() {
            assert_eq!(end - start, 1000);
            batches_processed += 1;
        }
    }

    assert_eq!(batches_processed, 5);
    assert_eq!(stress_iterator.progress(), 0.1); // 5000 / 50000 = 0.1
}

/// Test memory efficiency with large contract sets
#[test]
fn test_memory_efficiency() {
    // Test iterator memory usage doesn't scale with total contract count
    let small_iterator = ContractIterator::new(
        ContractQueryFilter::status_filter(ContractStatus::Active),
        100,
        1000,
    );

    let large_iterator = ContractIterator::new(
        ContractQueryFilter::status_filter(ContractStatus::Active),
        100,
        1000000,
    );

    // Both iterators should have same memory footprint for current batch
    assert_eq!(small_iterator.page_size, large_iterator.page_size);
    assert_eq!(small_iterator.current_offset, large_iterator.current_offset);

    // Only total count differs
    assert_ne!(
        small_iterator.total_contracts,
        large_iterator.total_contracts
    );
}

/// Test batch optimization strategies
#[test]
fn test_batch_optimization_strategies() {
    let contracts = vec![Pubkey::new_unique(); 1000];

    // Test different frequency optimizations
    let daily_batch = ContractBatch::new(
        contracts.clone(),
        1,
        BotPaymentType::Interest,
        PaymentFrequency::Daily,
    );

    let weekly_batch = ContractBatch::new(
        contracts.clone(),
        2,
        BotPaymentType::Interest,
        PaymentFrequency::Weekly,
    );

    let monthly_batch = ContractBatch::new(
        contracts,
        3,
        BotPaymentType::Interest,
        PaymentFrequency::Monthly,
    );

    // Verify optimal chunk sizes
    assert_eq!(daily_batch.optimal_chunk_size(), 20);
    assert_eq!(weekly_batch.optimal_chunk_size(), 50);
    assert_eq!(monthly_batch.optimal_chunk_size(), 100);

    // Verify priority ordering
    assert!(daily_batch.priority > weekly_batch.priority);
    assert!(weekly_batch.priority > monthly_batch.priority);

    // Verify processing time estimates
    assert_eq!(daily_batch.estimated_processing_time, 50000); // 1000 * 50ms
    assert_eq!(weekly_batch.estimated_processing_time, 50000);
    assert_eq!(monthly_batch.estimated_processing_time, 50000);
}

/// Test configuration performance optimizations
#[test]
fn test_configuration_performance() {
    let prod_config = BatchProcessingConfig::production_config();
    let test_config = BatchProcessingConfig::test_config();

    // Production config should handle larger loads
    assert!(prod_config.max_contracts_per_batch > test_config.max_contracts_per_batch);
    assert!(prod_config.max_processing_time_ms > test_config.max_processing_time_ms);
    assert!(prod_config.min_batch_size > test_config.min_batch_size);

    // Both should have same priority ordering
    assert_eq!(
        prod_config.frequency_priority,
        test_config.frequency_priority
    );
    assert_eq!(prod_config.frequency_priority[0], PaymentFrequency::Daily);
    assert_eq!(prod_config.frequency_priority[3], PaymentFrequency::Monthly);
}

// Helper functions for testing
fn create_mock_contracts(
    count: usize,
    interest_freq: PaymentFrequency,
    principal_freq: Option<PaymentFrequency>,
) -> Vec<DebtContract> {
    (0..count)
        .map(|i| {
            DebtContract {
                borrower: Pubkey::new_unique(),
                contract_seed: i as u64,
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
                funding_access_mode: FundingAccessMode::Public,
                has_active_proposal: false,
                proposal_count: 0,
                uncollectable_balance: 0,
                total_prepayment_fees: 0,
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
                _reserved: [0u8; RESERVED_TAIL_BYTES],
            }
        })
        .collect()
}
