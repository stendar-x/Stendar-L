use ::stendar as stendar_crate;
use anchor_lang::prelude::*;
use stendar_crate::*;

fn mock_active_contract() -> DebtContract {
    DebtContract {
        borrower: Pubkey::new_unique(),
        contract_seed: 42,
        target_amount: 2_000_000_000, // 2 SOL
        funded_amount: 0,
        interest_rate: 800, // 8.00%
        term_days: 30,
        collateral_amount: 2_400_000_000,
        loan_type: LoanType::Demand,
        ltv_ratio: 8_000,
        interest_payment_type: InterestPaymentType::OutstandingBalance,
        principal_payment_type: PrincipalPaymentType::NoFixedPayment,
        interest_frequency: PaymentFrequency::Weekly,
        principal_frequency: None,
        created_at: 1_700_000_000,
        status: ContractStatus::Active,
        num_contributions: 1,
        outstanding_balance: 2_000_000_000,
        accrued_interest: 0,
        last_interest_update: 1_700_000_000,
        last_principal_payment: 1_700_000_000,
        total_principal_paid: 0,
        contributions: vec![Pubkey::new_unique()],
        last_bot_update: 1_700_000_000,
        next_interest_payment_due: 1_700_000_000 + 7 * 24 * 60 * 60,
        next_principal_payment_due: 0,
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
        is_revolving: false,
        credit_limit: 0,
        drawn_amount: 0,
        available_amount: 0,
        standby_fee_rate: 0,
        accrued_standby_fees: 0,
        last_standby_fee_update: 0,
        total_draws: 0,
        total_standby_fees_paid: 0,
        revolving_closed: false,
        _reserved: [0u8; RESERVED_TAIL_BYTES],
    }
}

fn mock_contribution(contract: Pubkey, amount: u64) -> LenderContribution {
    LenderContribution {
        lender: Pubkey::new_unique(),
        contract,
        contribution_amount: amount,
        total_interest_claimed: 0,
        total_principal_claimed: 0,
        last_claim_timestamp: 0,
        is_refunded: false,
        created_at: 1_700_000_000,
        last_contributed_at: 1_700_000_000,
        _reserved: [0u8; LENDER_CONTRIBUTION_RESERVED_BYTES],
        account_version: CURRENT_ACCOUNT_VERSION,
    }
}

fn mock_listing(
    contract: Pubkey,
    contribution: Pubkey,
    seller: Pubkey,
    listing_amount: u64,
) -> TradeListing {
    TradeListing {
        contract,
        seller,
        contribution,
        listing_amount,
        asking_price: listing_amount + 100_000_000, // +0.1 SOL premium
        listing_type: ListingType::FullPosition,
        created_at: 1_700_000_000,
        expires_at: 1_700_086_400, // +1 day
        is_active: true,
        offer_count: 0,
        highest_offer: 0,
        nonce: 1,
    }
}

#[test]
fn mvp_primary_market_status_transitions_are_consistent() {
    let mut contract = mock_active_contract();
    contract.status = ContractStatus::OpenNotFunded;
    contract.funded_amount = 0;
    assert_eq!(
        contract.determine_status_by_funding(),
        ContractStatus::OpenNotFunded
    );

    contract.funded_amount = 1_000_000_000;
    assert_eq!(
        contract.determine_status_by_funding(),
        ContractStatus::OpenPartiallyFunded
    );

    contract.funded_amount = contract.target_amount;
    assert_eq!(
        contract.determine_status_by_funding(),
        ContractStatus::Active
    );
}

#[test]
fn mvp_secondary_market_allows_partial_position_listings_with_valid_remainder() {
    let contract_key = Pubkey::new_unique();
    let contribution = mock_contribution(contract_key, 1_000_000_000);
    let contract = mock_active_contract();

    let partial_amount = 500_000_000;
    let result = validate_listing_parameters(partial_amount, 600_000_000, &contribution, &contract);

    assert!(result.is_ok());
}

#[test]
fn mvp_secondary_market_rejects_partial_listings_with_dust_remainder() {
    let contract_key = Pubkey::new_unique();
    let contribution = mock_contribution(contract_key, MIN_LISTING_AMOUNT + 1);
    let contract = mock_active_contract();

    let result =
        validate_listing_parameters(MIN_LISTING_AMOUNT, 600_000_000, &contribution, &contract);

    assert!(result.is_err());
    assert!(result
        .expect_err("dust remainder should be rejected")
        .to_string()
        .contains("Invalid trade amount"));
}

#[test]
fn mvp_secondary_market_allows_full_position_listing() {
    let contract_key = Pubkey::new_unique();
    let contribution = mock_contribution(contract_key, 1_000_000_000);
    let contract = mock_active_contract();

    let result = validate_listing_parameters(
        contribution.contribution_amount,
        1_100_000_000,
        &contribution,
        &contract,
    );

    assert!(result.is_ok());
}

#[test]
fn mvp_secondary_market_rejects_partial_offer_fills() {
    let listing_amount = 1_000_000_000;
    let seller = Pubkey::new_unique();
    let listing = mock_listing(
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        seller,
        listing_amount,
    );
    let current_time = 1_700_000_100;

    let result = validate_offer_parameters(
        &listing,
        500_000_000,
        900_000_000,
        current_time + 3_600,
        current_time,
    );

    assert!(result.is_err());
    assert!(result
        .err()
        .unwrap()
        .to_string()
        .contains("Invalid trade amount"));
}

#[test]
fn mvp_secondary_market_allows_full_offer_fill() {
    let listing_amount = 1_000_000_000;
    let seller = Pubkey::new_unique();
    let listing = mock_listing(
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        seller,
        listing_amount,
    );
    let current_time = 1_700_000_100;

    let result = validate_offer_parameters(
        &listing,
        listing_amount,
        1_100_000_000,
        current_time + 3_600,
        current_time,
    );

    assert!(result.is_ok());
}

#[test]
fn governance_rotation_requires_current_authority() {
    let authority = Pubkey::new_unique();
    let mut treasury = Treasury {
        authority,
        pending_authority: Pubkey::default(),
        bot_authority: Pubkey::new_unique(),
        fees_collected: 0,
        transaction_costs: 0,
        automated_operations: 0,
        total_contracts_processed: 0,
        last_update: 0,
        created_at: 1_700_000_000,
        usdc_mint: Pubkey::default(),
        treasury_usdc_account: Pubkey::default(),
        total_liquidation_fees: 0,
        total_recall_fees: 0,
        account_version: CURRENT_ACCOUNT_VERSION,
    };

    let unauthorized_signer = Pubkey::new_unique();
    let result = treasury.propose_authority_transfer(
        unauthorized_signer,
        Pubkey::new_unique(),
        1_700_000_100,
    );

    assert!(result.is_err());
    assert!(result
        .err()
        .unwrap()
        .to_string()
        .contains("Unauthorized authority update"));
}

#[test]
fn governance_rotation_rejects_default_bot_authority() {
    let authority = Pubkey::new_unique();
    let mut treasury = Treasury {
        authority,
        pending_authority: Pubkey::default(),
        bot_authority: Pubkey::new_unique(),
        fees_collected: 0,
        transaction_costs: 0,
        automated_operations: 0,
        total_contracts_processed: 0,
        last_update: 0,
        created_at: 1_700_000_000,
        usdc_mint: Pubkey::default(),
        treasury_usdc_account: Pubkey::default(),
        total_liquidation_fees: 0,
        total_recall_fees: 0,
        account_version: CURRENT_ACCOUNT_VERSION,
    };

    let result = treasury.set_bot_authority(authority, Pubkey::default(), 1_700_000_100);
    assert!(result.is_err());
    assert!(result
        .err()
        .unwrap()
        .to_string()
        .contains("Invalid authority"));
}

#[test]
fn governance_rotation_allows_valid_authority_and_bot_updates() {
    let authority = Pubkey::new_unique();
    let new_authority = Pubkey::new_unique();
    let new_bot = Pubkey::new_unique();

    let mut treasury = Treasury {
        authority,
        pending_authority: Pubkey::default(),
        bot_authority: Pubkey::new_unique(),
        fees_collected: 0,
        transaction_costs: 0,
        automated_operations: 0,
        total_contracts_processed: 0,
        last_update: 0,
        created_at: 1_700_000_000,
        usdc_mint: Pubkey::default(),
        treasury_usdc_account: Pubkey::default(),
        total_liquidation_fees: 0,
        total_recall_fees: 0,
        account_version: CURRENT_ACCOUNT_VERSION,
    };

    let authority_update_result =
        treasury.propose_authority_transfer(authority, new_authority, 1_700_000_100);
    assert!(authority_update_result.is_ok());
    assert_eq!(treasury.authority, authority);
    assert_eq!(treasury.pending_authority, new_authority);

    let accept_result = treasury.accept_authority_transfer(new_authority, 1_700_000_150);
    assert!(accept_result.is_ok());
    assert_eq!(treasury.authority, new_authority);
    assert_eq!(treasury.pending_authority, Pubkey::default());

    let bot_update_result = treasury.set_bot_authority(new_authority, new_bot, 1_700_000_200);
    assert!(bot_update_result.is_ok());
    assert_eq!(treasury.bot_authority, new_bot);
}
