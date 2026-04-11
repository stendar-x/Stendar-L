use ::stendar::*;
use anchor_lang::prelude::*;

/// Test bot operation statistics
#[test]
fn test_bot_operation_stats() {
    let mut stats = BotOperationStats::new();

    // Test initial state
    assert_eq!(stats.contracts_processed, 0);
    assert_eq!(stats.interest_payments_processed, 0);
    assert_eq!(stats.principal_payments_processed, 0);
    assert_eq!(stats.total_amount_processed, 0);
    assert_eq!(stats.last_operation_time, 0);
    assert_eq!(stats.average_processing_time, 0);

    // Test batch stats update
    stats.update_batch_stats(10, 5000, 1000);
    assert_eq!(stats.contracts_processed, 10);
    assert_eq!(stats.total_amount_processed, 5000);
    assert_eq!(stats.last_operation_time, 1000);
    assert_eq!(stats.average_processing_time, 1000);

    // Test second batch (moving average)
    stats.update_batch_stats(5, 2500, 800);
    assert_eq!(stats.contracts_processed, 15);
    assert_eq!(stats.total_amount_processed, 7500);
    assert_eq!(stats.last_operation_time, 800);
    assert_eq!(stats.average_processing_time, 900); // (1000 + 800) / 2

    // Test interest stats update
    stats.update_interest_stats(3, 1500);
    assert_eq!(stats.interest_payments_processed, 3);
    assert_eq!(stats.total_amount_processed, 9000);

    // Test principal stats update
    stats.update_principal_stats(2, 1000);
    assert_eq!(stats.principal_payments_processed, 2);
    assert_eq!(stats.total_amount_processed, 10000);
}

/// Test batch processing configuration
#[test]
fn test_batch_processing_config() {
    // Test production config
    let prod_config = BatchProcessingConfig::production_config();
    assert_eq!(prod_config.max_contracts_per_batch, 100);
    assert_eq!(prod_config.max_processing_time_ms, 10000);
    assert_eq!(prod_config.min_batch_size, 10);
    assert_eq!(prod_config.frequency_priority.len(), 4);
    assert_eq!(prod_config.frequency_priority[0], PaymentFrequency::Daily);

    // Test test config
    let test_config = BatchProcessingConfig::test_config();
    assert_eq!(test_config.max_contracts_per_batch, 10);
    assert_eq!(test_config.max_processing_time_ms, 1000);
    assert_eq!(test_config.min_batch_size, 1);
    assert_eq!(test_config.frequency_priority.len(), 4);
}

/// Test contract batch functionality
#[test]
fn test_contract_batch() {
    let contracts = vec![Pubkey::new_unique(); 10];
    let batch = ContractBatch::new(
        contracts.clone(),
        1,
        BotPaymentType::Interest,
        PaymentFrequency::Weekly,
    );

    assert_eq!(batch.contracts.len(), 10);
    assert_eq!(batch.batch_id, 1);
    assert_eq!(batch.payment_type, BotPaymentType::Interest);
    assert_eq!(batch.frequency, PaymentFrequency::Weekly);
    assert_eq!(batch.estimated_processing_time, 500); // 10 * 50ms
    assert_eq!(batch.priority, 3); // Weekly priority

    // Test high priority
    assert!(batch.is_high_priority());

    // Test optimal chunk size
    assert_eq!(batch.optimal_chunk_size(), 50);

    // Test daily batch (highest priority)
    let daily_batch = ContractBatch::new(
        contracts,
        2,
        BotPaymentType::Principal,
        PaymentFrequency::Daily,
    );
    assert_eq!(daily_batch.priority, 4);
    assert!(daily_batch.is_high_priority());
    assert_eq!(daily_batch.optimal_chunk_size(), 20);
}

/// Test contract iterator functionality
#[test]
fn test_contract_iterator() {
    let filter = ContractQueryFilter::status_filter(ContractStatus::Active);
    let mut iterator = ContractIterator::new(filter, 10, 25);

    // Test initial state
    assert_eq!(iterator.current_offset, 0);
    assert_eq!(iterator.page_size, 10);
    assert_eq!(iterator.total_contracts, 25);
    assert!(iterator.has_next());
    assert_eq!(iterator.progress(), 0.0);

    // Test first batch
    let batch1 = iterator.next_batch();
    assert!(batch1.is_some());
    assert_eq!(batch1.unwrap(), (0, 10));
    assert_eq!(iterator.current_offset, 10);
    assert_eq!(iterator.progress(), 0.4);

    // Test second batch
    let batch2 = iterator.next_batch();
    assert!(batch2.is_some());
    assert_eq!(batch2.unwrap(), (10, 20));
    assert_eq!(iterator.current_offset, 20);
    assert_eq!(iterator.progress(), 0.8);

    // Test final batch
    let batch3 = iterator.next_batch();
    assert!(batch3.is_some());
    assert_eq!(batch3.unwrap(), (20, 25));
    assert_eq!(iterator.current_offset, 25);
    assert_eq!(iterator.progress(), 1.0);

    // Test end of iteration
    assert!(!iterator.has_next());
    let batch4 = iterator.next_batch();
    assert!(batch4.is_none());

    // Test reset
    iterator.reset();
    assert_eq!(iterator.current_offset, 0);
    assert!(iterator.has_next());
    assert_eq!(iterator.progress(), 0.0);
}

/// Test batch processing edge cases
#[test]
fn test_batch_edge_cases() {
    // Test iterator with zero contracts
    let filter = ContractQueryFilter::status_filter(ContractStatus::Active);
    let mut empty_iterator = ContractIterator::new(filter, 10, 0);
    assert!(!empty_iterator.has_next());
    assert_eq!(empty_iterator.progress(), 1.0);
    assert!(empty_iterator.next_batch().is_none());

    // Test batch with zero contracts
    let empty_batch = ContractBatch::new(
        vec![],
        1,
        BotPaymentType::Interest,
        PaymentFrequency::Monthly,
    );
    assert_eq!(empty_batch.contracts.len(), 0);
    assert_eq!(empty_batch.estimated_processing_time, 0);
    assert_eq!(empty_batch.priority, 1); // Monthly priority
    assert!(!empty_batch.is_high_priority());

    // Test batch priority levels
    let monthly_batch = ContractBatch::new(
        vec![Pubkey::new_unique()],
        1,
        BotPaymentType::Interest,
        PaymentFrequency::Monthly,
    );
    assert_eq!(monthly_batch.priority, 1);
    assert!(!monthly_batch.is_high_priority());

    let biweekly_batch = ContractBatch::new(
        vec![Pubkey::new_unique()],
        1,
        BotPaymentType::Interest,
        PaymentFrequency::BiWeekly,
    );
    assert_eq!(biweekly_batch.priority, 2);
    assert!(!biweekly_batch.is_high_priority());

    let weekly_batch = ContractBatch::new(
        vec![Pubkey::new_unique()],
        1,
        BotPaymentType::Interest,
        PaymentFrequency::Weekly,
    );
    assert_eq!(weekly_batch.priority, 3);
    assert!(weekly_batch.is_high_priority());

    let daily_batch = ContractBatch::new(
        vec![Pubkey::new_unique()],
        1,
        BotPaymentType::Interest,
        PaymentFrequency::Daily,
    );
    assert_eq!(daily_batch.priority, 4);
    assert!(daily_batch.is_high_priority());
}

/// Test batch processing optimization
#[test]
fn test_batch_optimization() {
    // Test different chunk sizes for different frequencies
    let daily_batch = ContractBatch::new(
        vec![Pubkey::new_unique(); 100],
        1,
        BotPaymentType::Interest,
        PaymentFrequency::Daily,
    );
    assert_eq!(daily_batch.optimal_chunk_size(), 20);

    let weekly_batch = ContractBatch::new(
        vec![Pubkey::new_unique(); 100],
        1,
        BotPaymentType::Interest,
        PaymentFrequency::Weekly,
    );
    assert_eq!(weekly_batch.optimal_chunk_size(), 50);

    let biweekly_batch = ContractBatch::new(
        vec![Pubkey::new_unique(); 100],
        1,
        BotPaymentType::Interest,
        PaymentFrequency::BiWeekly,
    );
    assert_eq!(biweekly_batch.optimal_chunk_size(), 75);

    let monthly_batch = ContractBatch::new(
        vec![Pubkey::new_unique(); 100],
        1,
        BotPaymentType::Interest,
        PaymentFrequency::Monthly,
    );
    assert_eq!(monthly_batch.optimal_chunk_size(), 100);
}

/// Test iterator progress calculation
#[test]
fn test_iterator_progress() {
    let filter = ContractQueryFilter::status_filter(ContractStatus::Active);
    let mut iterator = ContractIterator::new(filter, 10, 100);

    // Test progress at different stages
    assert_eq!(iterator.progress(), 0.0);

    iterator.next_batch(); // 0-10
    assert_eq!(iterator.progress(), 0.1);

    iterator.next_batch(); // 10-20
    assert_eq!(iterator.progress(), 0.2);

    iterator.next_batch(); // 20-30
    assert_eq!(iterator.progress(), 0.3);

    // Skip to near end
    iterator.current_offset = 95;
    assert_eq!(iterator.progress(), 0.95);

    iterator.next_batch(); // 95-100
    assert_eq!(iterator.progress(), 1.0);
}
