use crate::fuzz_accounts::FuzzAccounts;
use crate::helpers::{
    associated_token_program_id, current_timestamp, ensure_collateral_registry_account,
    ensure_mint_account, ensure_pyth_price_feed, ensure_token_account, token_program_id,
};
use crate::types::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signer;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([164u8, 203u8, 159u8, 50u8, 104u8, 124u8, 178u8, 150u8])]
pub struct CreateDebtContractInstruction {
    pub accounts: CreateDebtContractInstructionAccounts,
    pub data: CreateDebtContractInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(CreateDebtContractInstructionData)]
#[storage(FuzzAccounts)]
pub struct CreateDebtContractInstructionAccounts {
    #[account(mut)]
    pub contract: TridentAccount,

    #[account(mut)]
    pub operations_fund: TridentAccount,

    #[account(mut)]
    pub state: TridentAccount,

    #[account(mut)]
    pub treasury: TridentAccount,

    #[account(mut, signer)]
    pub borrower: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,

    pub collateral_registry: TridentAccount,

    pub collateral_mint: TridentAccount,

    #[account(mut)]
    pub borrower_collateral_ata: TridentAccount,

    #[account(mut)]
    pub contract_collateral_ata: TridentAccount,

    pub price_feed_account: TridentAccount,

    pub usdc_mint: TridentAccount,

    #[account(mut)]
    pub contract_usdc_ata: TridentAccount,

    #[account(mut)]
    pub borrower_usdc_ata: TridentAccount,

    #[account(mut)]
    pub treasury_usdc_account: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,

    #[account(address = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")]
    pub associated_token_program: TridentAccount,

    pub frontend_operator: TridentAccount,

    #[account(mut)]
    pub frontend_usdc_ata: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct CreateDebtContractInstructionData {
    pub contract_seed: u64,

    pub max_lenders: u16,

    pub target_amount: u64,

    pub interest_rate: u32,

    pub term_days: u32,

    pub collateral_amount: u64,

    pub loan_type: LoanType,

    pub ltv_ratio: u32,

    pub ltv_floor_bps: u32,

    pub interest_payment_type: InterestPaymentType,

    pub principal_payment_type: PrincipalPaymentType,

    pub interest_frequency: PaymentFrequency,

    pub principal_frequency: Option<PaymentFrequency>,

    pub partial_funding_enabled: bool,

    pub allow_partial_fill: bool,

    pub min_partial_fill_bps: u16,

    pub is_revolving: bool,

    pub standby_fee_rate: u32,

    pub distribution_method: DistributionMethod,

    pub funding_access_mode: FundingAccessMode,
}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for CreateDebtContractInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_data(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let collateral_mode = !fuzz_accounts.price_feed_account.is_empty();

        self.data.contract_seed = trident.gen_range(1..u64::MAX);
        self.data.max_lenders = trident.gen_range(1..=3);
        self.data.target_amount = trident.gen_range(500_000..=2_000_000);
        self.data.interest_rate = trident.gen_range(100..=2_000);
        self.data.term_days = trident.gen_range(30..=365);
        self.data.loan_type = LoanType::Demand;
        self.data.interest_payment_type = InterestPaymentType::OutstandingBalance;
        self.data.principal_payment_type = PrincipalPaymentType::NoFixedPayment;
        self.data.interest_frequency = PaymentFrequency::Daily;
        self.data.principal_frequency = None;
        self.data.partial_funding_enabled = true;
        self.data.allow_partial_fill = true;
        self.data.min_partial_fill_bps = trident.gen_range(500..=5_000);
        self.data.is_revolving = false;
        self.data.standby_fee_rate = trident.gen_range(50..=500);
        self.data.distribution_method = DistributionMethod::Manual;
        self.data.funding_access_mode = FundingAccessMode::Public;

        if collateral_mode {
            self.data.collateral_amount = trident.gen_range(5_000_000..=20_000_000);
            self.data.ltv_ratio = trident.gen_range(15_000..=25_000);
            self.data.ltv_floor_bps = trident.gen_range(10_500..=12_000);
            self.data.interest_payment_type = InterestPaymentType::CollateralTransfer;
            self.data.principal_payment_type = PrincipalPaymentType::CollateralDeduction;
            self.data.principal_frequency = Some(PaymentFrequency::Daily);
        } else {
            self.data.collateral_amount = 0;
            self.data.ltv_ratio = 0;
            self.data.ltv_floor_bps = 0;
        }
    }

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let token_program = token_program_id();
        let associated_token_program = associated_token_program_id();

        let state_seeds: &[&[u8]] = &[b"global_state"];
        let state = fuzz_accounts.state.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(state_seeds, program_id)),
            None,
        );
        let treasury_seeds: &[&[u8]] = &[b"treasury"];
        let treasury = fuzz_accounts.treasury.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(treasury_seeds, program_id)),
            None,
        );
        let borrower = fuzz_accounts.borrower.get_or_create(0, trident, None, None);
        let contract_seed_bytes = self.data.contract_seed.to_le_bytes();
        let contract_seeds: &[&[u8]] = &[b"debt_contract", borrower.as_ref(), &contract_seed_bytes];
        let contract = fuzz_accounts.contract.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(contract_seeds, program_id)),
            None,
        );
        let operations_fund_seeds: &[&[u8]] = &[b"operations_fund", contract.as_ref()];
        let operations_fund = fuzz_accounts.operations_fund.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(operations_fund_seeds, program_id)),
            None,
        );
        let usdc_mint = fuzz_accounts.usdc_mint.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
        );
        ensure_mint_account(trident, &usdc_mint, &borrower, 6);
        let contract_usdc_ata = fuzz_accounts
            .contract_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let borrower_usdc_ata = fuzz_accounts
            .borrower_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let treasury_usdc_seeds: &[&[u8]] =
            &[treasury.as_ref(), token_program.as_ref(), usdc_mint.as_ref()];
        let treasury_usdc_account = fuzz_accounts.treasury_usdc_account.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(treasury_usdc_seeds, associated_token_program)),
            Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
        );
        ensure_token_account(trident, &contract_usdc_ata, &usdc_mint, &contract, 0);
        ensure_token_account(
            trident,
            &borrower_usdc_ata,
            &usdc_mint,
            &borrower,
            5_000_000_000,
        );
        ensure_token_account(trident, &treasury_usdc_account, &usdc_mint, &treasury, 0);

        let mut collateral_registry = program_id;
        let mut collateral_mint = program_id;
        let mut borrower_collateral_ata = program_id;
        let mut contract_collateral_ata = program_id;
        let mut price_feed_account = program_id;
        let frontend_operator = program_id;
        let frontend_usdc_ata = program_id;

        if self.data.ltv_ratio > 0 {
            let collateral_registry_seeds: &[&[u8]] = &[b"collateral_registry"];
            collateral_registry = fuzz_accounts.collateral_registry.get_or_create(
                0,
                trident,
                Some(PdaSeeds::new(collateral_registry_seeds, program_id)),
                Some(AccountMetadata::new(1_000_000_000, 512, program_id)),
            );
            collateral_mint = fuzz_accounts.collateral_mint.get_or_create(
                0,
                trident,
                None,
                Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
            );
            borrower_collateral_ata = fuzz_accounts.borrower_collateral_ata.get_or_create(
                0,
                trident,
                None,
                Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
            );
            contract_collateral_ata = fuzz_accounts.contract_collateral_ata.get_or_create(
                0,
                trident,
                None,
                Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
            );
            price_feed_account = fuzz_accounts.price_feed_account.get_or_create(
                0,
                trident,
                None,
                Some(AccountMetadata::new(1_000_000_000, 256, program_id)),
            );

            ensure_mint_account(trident, &collateral_mint, &borrower, 6);
            ensure_token_account(
                trident,
                &borrower_collateral_ata,
                &collateral_mint,
                &borrower,
                self.data.collateral_amount.saturating_mul(10),
            );
            ensure_token_account(trident, &contract_collateral_ata, &collateral_mint, &contract, 0);
            let registry_authority = trident.get_client().payer().pubkey();
            ensure_collateral_registry_account(
                trident,
                &collateral_registry,
                &registry_authority,
                &collateral_mint,
                &price_feed_account,
                &program_id,
            );
            let publish_time = current_timestamp(trident);
            ensure_pyth_price_feed(
                trident,
                &price_feed_account,
                100_000_000,
                0,
                -8,
                publish_time,
            );
        }

        self.accounts.contract.set_address(contract);
        self.accounts.operations_fund.set_address(operations_fund);
        self.accounts.state.set_address(state);
        self.accounts.treasury.set_address(treasury);
        self.accounts.borrower.set_address(borrower);
        self.accounts.collateral_registry.set_address(collateral_registry);
        self.accounts.collateral_mint.set_address(collateral_mint);
        self.accounts
            .borrower_collateral_ata
            .set_address(borrower_collateral_ata);
        self.accounts
            .contract_collateral_ata
            .set_address(contract_collateral_ata);
        self.accounts.price_feed_account.set_address(price_feed_account);
        self.accounts.usdc_mint.set_address(usdc_mint);
        self.accounts.contract_usdc_ata.set_address(contract_usdc_ata);
        self.accounts.borrower_usdc_ata.set_address(borrower_usdc_ata);
        self.accounts
            .treasury_usdc_account
            .set_address(treasury_usdc_account);
        self.accounts.frontend_operator.set_address(frontend_operator);
        self.accounts.frontend_usdc_ata.set_address(frontend_usdc_ata);
    }
}
