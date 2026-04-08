use ::stendar as stendar_crate;
use anchor_lang::prelude::*;
use stendar_crate::*;

#[derive(Debug, PartialEq, Eq)]
enum ExpirationOutcome {
    NoOp,
    ActivatedPartial,
    Cancelled,
}

fn meets_partial_fill_threshold(contract: &DebtContract) -> bool {
    if contract.funded_amount == 0 {
        return false;
    }
    if contract.min_partial_fill_bps == 0 {
        return true;
    }

    let funded_scaled = (contract.funded_amount as u128).saturating_mul(10_000u128);
    let required_scaled =
        (contract.target_amount as u128).saturating_mul(contract.min_partial_fill_bps as u128);
    funded_scaled >= required_scaled
}

fn simulate_primary_listing_expiration(
    contract: &mut DebtContract,
    current_time: i64,
) -> ExpirationOutcome {
    if !contract.status.is_open() || contract.expires_at <= 0 || current_time < contract.expires_at
    {
        return ExpirationOutcome::NoOp;
    }

    if contract.allow_partial_fill && meets_partial_fill_threshold(contract) {
        contract.target_amount = contract.funded_amount;
        contract.status = ContractStatus::Active;
        contract.outstanding_balance = contract.funded_amount;
        contract.last_interest_update = current_time;
        contract.last_principal_payment = current_time;
        return ExpirationOutcome::ActivatedPartial;
    }

    contract.status = ContractStatus::Cancelled;
    ExpirationOutcome::Cancelled
}

/// Test integration scenarios
#[test]
fn test_integration_scenarios() {
    let current_time = 1_700_000_000;

    // Scenario 1: Weekly interest payments due
    let mut weekly_contracts = create_mock_contracts(10, PaymentFrequency::Weekly, None);
    for contract in &mut weekly_contracts {
        contract.status = ContractStatus::Active;
        contract.funded_amount = 1000;
        contract.next_interest_payment_due = current_time - 1000; // Past due
    }

    let filter = ContractQueryFilter::interest_due_filter(PaymentFrequency::Weekly, current_time);
    let matching_count = weekly_contracts
        .iter()
        .filter(|c| filter.matches(c, current_time))
        .count();
    assert_eq!(matching_count, 10);

    // Scenario 2: Mixed frequency processing
    let mut mixed_contracts =
        create_mock_contracts(5, PaymentFrequency::Daily, Some(PaymentFrequency::Monthly));
    for contract in &mut mixed_contracts {
        contract.status = ContractStatus::Active;
        contract.funded_amount = 1000;
        contract.next_interest_payment_due = current_time - 1000; // Interest due
        contract.next_principal_payment_due = current_time + 1000; // Principal not due
    }

    let daily_filter =
        ContractQueryFilter::interest_due_filter(PaymentFrequency::Daily, current_time);
    let daily_matches = mixed_contracts
        .iter()
        .filter(|c| daily_filter.matches(c, current_time))
        .count();
    assert_eq!(daily_matches, 5);

    let monthly_filter =
        ContractQueryFilter::principal_due_filter(PaymentFrequency::Monthly, current_time);
    let monthly_matches = mixed_contracts
        .iter()
        .filter(|c| monthly_filter.matches(c, current_time))
        .count();
    assert_eq!(monthly_matches, 0); // Not due yet

    // Scenario 3: Batch processing workflow
    let batch_contracts = create_mock_contracts(100, PaymentFrequency::Weekly, None);
    let batch = ContractBatch::new(
        batch_contracts
            .iter()
            .map(|_| Pubkey::new_unique())
            .collect(),
        1,
        BotPaymentType::Interest,
        PaymentFrequency::Weekly,
    );

    let chunk_size = batch.optimal_chunk_size();
    assert_eq!(chunk_size, 50);

    let num_chunks = (batch.contracts.len() + chunk_size - 1) / chunk_size;
    assert_eq!(num_chunks, 2); // 100 contracts / 50 chunk size = 2 chunks
}

/// Test multi-frequency contract handling
#[test]
fn test_multi_frequency_contract_handling() {
    let current_time = 1_700_000_000;

    // Create contracts with different frequencies
    let daily_contracts =
        create_mock_contracts(20, PaymentFrequency::Daily, Some(PaymentFrequency::Monthly));
    let weekly_contracts = create_mock_contracts(
        30,
        PaymentFrequency::Weekly,
        Some(PaymentFrequency::BiWeekly),
    );
    let biweekly_contracts = create_mock_contracts(
        25,
        PaymentFrequency::BiWeekly,
        Some(PaymentFrequency::Monthly),
    );
    let monthly_contracts = create_mock_contracts(15, PaymentFrequency::Monthly, None);

    let mut all_contracts = [
        daily_contracts,
        weekly_contracts,
        biweekly_contracts,
        monthly_contracts,
    ]
    .concat();

    // Make all contracts active + interest-due at `current_time` so the frequency filters are the
    // only differentiator.
    for contract in &mut all_contracts {
        contract.status = ContractStatus::Active;
        contract.next_interest_payment_due = current_time - 1;
    }

    // Test frequency-specific filtering
    let daily_filter =
        ContractQueryFilter::interest_due_filter(PaymentFrequency::Daily, current_time);
    let daily_count = all_contracts
        .iter()
        .filter(|c| daily_filter.matches(c, current_time))
        .count();
    assert_eq!(daily_count, 20);

    let weekly_filter =
        ContractQueryFilter::interest_due_filter(PaymentFrequency::Weekly, current_time);
    let weekly_count = all_contracts
        .iter()
        .filter(|c| weekly_filter.matches(c, current_time))
        .count();
    assert_eq!(weekly_count, 30);

    // Test batch creation for different frequencies
    let daily_batch = ContractBatch::new(
        vec![Pubkey::new_unique(); 20],
        1,
        BotPaymentType::Interest,
        PaymentFrequency::Daily,
    );
    assert_eq!(daily_batch.priority, 4);
    assert!(daily_batch.is_high_priority());

    let monthly_batch = ContractBatch::new(
        vec![Pubkey::new_unique(); 15],
        2,
        BotPaymentType::Interest,
        PaymentFrequency::Monthly,
    );
    assert_eq!(monthly_batch.priority, 1);
    assert!(!monthly_batch.is_high_priority());
}

/// Test bot operation coordination
#[test]
fn test_bot_operation_coordination() {
    let _current_time = 1_700_000_000;
    let mut stats = BotOperationStats::new();

    // Simulate processing multiple batches
    let frequencies = [
        PaymentFrequency::Daily,
        PaymentFrequency::Weekly,
        PaymentFrequency::BiWeekly,
        PaymentFrequency::Monthly,
    ];

    for (i, frequency) in frequencies.iter().enumerate() {
        let contracts = create_mock_contracts(50, *frequency, None);

        // Create batch
        let batch = ContractBatch::new(
            contracts.iter().map(|_| Pubkey::new_unique()).collect(),
            i as u64 + 1,
            BotPaymentType::Interest,
            *frequency,
        );

        // Process batch and update stats
        let processing_time = batch.estimated_processing_time;
        stats.update_batch_stats(50, 25000, processing_time);

        // Verify priority ordering
        match frequency {
            PaymentFrequency::Daily => assert_eq!(batch.priority, 4),
            PaymentFrequency::Weekly => assert_eq!(batch.priority, 3),
            PaymentFrequency::BiWeekly => assert_eq!(batch.priority, 2),
            PaymentFrequency::Monthly => assert_eq!(batch.priority, 1),
        }
    }

    // Verify accumulated stats
    assert_eq!(stats.contracts_processed, 200); // 50 * 4 frequencies
    assert_eq!(stats.total_amount_processed, 100000); // 25000 * 4 batches
    assert!(stats.average_processing_time > 0);
}

/// Test integration edge cases
#[test]
fn test_integration_edge_cases() {
    let current_time = 1_700_000_000;

    // Edge case: Empty contract set
    let empty_contracts: Vec<DebtContract> = vec![];
    let filter = ContractQueryFilter::status_filter(ContractStatus::Active);
    let matching = empty_contracts
        .iter()
        .filter(|c| filter.matches(c, current_time))
        .count();
    assert_eq!(matching, 0);

    // Edge case: All contracts in terminal states
    let mut terminal_contracts = create_mock_contracts(10, PaymentFrequency::Weekly, None);
    for contract in &mut terminal_contracts {
        contract.status = ContractStatus::Completed;
    }

    let active_filter = ContractQueryFilter::status_filter(ContractStatus::Active);
    let active_count = terminal_contracts
        .iter()
        .filter(|c| active_filter.matches(c, current_time))
        .count();
    assert_eq!(active_count, 0);

    // Edge case: Mixed payment due states
    let mut mixed_due_contracts =
        create_mock_contracts(6, PaymentFrequency::Weekly, Some(PaymentFrequency::Monthly));
    for (i, contract) in mixed_due_contracts.iter_mut().enumerate() {
        contract.status = ContractStatus::Active;
        contract.funded_amount = 1000;

        if i % 2 == 0 {
            contract.next_interest_payment_due = current_time - 1000; // Past due
        } else {
            contract.next_interest_payment_due = current_time + 1000; // Future due
        }
    }

    let due_filter =
        ContractQueryFilter::interest_due_filter(PaymentFrequency::Weekly, current_time);
    let due_count = mixed_due_contracts
        .iter()
        .filter(|c| due_filter.matches(c, current_time))
        .count();
    assert_eq!(due_count, 3); // Half the contracts are due
}

#[test]
fn test_primary_expiration_activates_partial_fill_when_threshold_met() {
    let current_time = 1_700_000_000;
    let mut contracts = create_mock_contracts(1, PaymentFrequency::Weekly, None);
    let contract = contracts
        .get_mut(0)
        .expect("expected one contract for expiration simulation");

    contract.status = ContractStatus::OpenPartiallyFunded;
    contract.target_amount = 1_000;
    contract.funded_amount = 600;
    contract.allow_partial_fill = true;
    contract.min_partial_fill_bps = 5_000;
    contract.expires_at = current_time - 1;

    let outcome = simulate_primary_listing_expiration(contract, current_time);
    assert_eq!(outcome, ExpirationOutcome::ActivatedPartial);
    assert_eq!(contract.status, ContractStatus::Active);
    assert_eq!(contract.target_amount, 600);
    assert_eq!(contract.outstanding_balance, 600);
}

#[test]
fn test_primary_expiration_cancels_when_threshold_not_met() {
    let current_time = 1_700_000_000;
    let mut contracts = create_mock_contracts(1, PaymentFrequency::Weekly, None);
    let contract = contracts
        .get_mut(0)
        .expect("expected one contract for expiration simulation");

    contract.status = ContractStatus::OpenPartiallyFunded;
    contract.target_amount = 1_000;
    contract.funded_amount = 300;
    contract.allow_partial_fill = true;
    contract.min_partial_fill_bps = 5_000;
    contract.expires_at = current_time - 1;

    let outcome = simulate_primary_listing_expiration(contract, current_time);
    assert_eq!(outcome, ExpirationOutcome::Cancelled);
    assert_eq!(contract.status, ContractStatus::Cancelled);
}

#[test]
fn test_secondary_listing_expiration_marks_listing_inactive() {
    let current_time = 1_700_000_000;
    let mut listing = TradeListing {
        contract: Pubkey::new_unique(),
        seller: Pubkey::new_unique(),
        contribution: Pubkey::new_unique(),
        listing_amount: 1_000,
        asking_price: 950,
        listing_type: ListingType::FullPosition,
        created_at: current_time - 100,
        expires_at: current_time - 1,
        is_active: true,
        offer_count: 0,
        highest_offer: 0,
        nonce: 1,
    };

    assert!(!listing.is_valid(current_time));
    if !listing.is_valid(current_time) {
        listing.is_active = false;
    }
    assert!(!listing.is_active);
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
