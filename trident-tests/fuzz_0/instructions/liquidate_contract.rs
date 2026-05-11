use crate::fuzz_accounts::FuzzAccounts;
use crate::helpers::{current_timestamp, ensure_pyth_price_feed, ensure_token_account, token_program_id};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(Debug, Clone, TridentRemainingAccounts, Default)]
pub struct LiquidateContractRemainingAccounts {
    pub accounts: [TridentAccount; 3],
}

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([180u8, 214u8, 24u8, 164u8, 209u8, 94u8, 255u8, 58u8])]
pub struct LiquidateContractInstruction {
    pub accounts: LiquidateContractInstructionAccounts,
    pub remaining_accounts: LiquidateContractRemainingAccounts,
    pub data: LiquidateContractInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(LiquidateContractInstructionData)]
#[storage(FuzzAccounts)]
pub struct LiquidateContractInstructionAccounts {
    #[account(mut)]
    pub contract: TridentAccount,

    #[account(mut)]
    pub operations_fund: TridentAccount,

    #[account(mut)]
    pub state: TridentAccount,

    #[account(mut)]
    pub borrower: TridentAccount,

    #[account(mut, signer)]
    pub liquidator: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,

    pub collateral_registry: TridentAccount,

    pub price_feed_account: TridentAccount,

    #[account(mut)]
    pub treasury: TridentAccount,

    #[account(mut)]
    pub bot_usdc_ata: TridentAccount,

    #[account(mut)]
    pub contract_usdc_ata: TridentAccount,

    #[account(mut)]
    pub contract_collateral_ata: TridentAccount,

    #[account(mut)]
    pub bot_collateral_ata: TridentAccount,

    #[account(mut)]
    pub borrower_collateral_ata: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct LiquidateContractInstructionData {}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for LiquidateContractInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let token_program = token_program_id();
        let contract = fuzz_accounts.contract.get_or_create(0, trident, None, None);
        let operations_fund = fuzz_accounts.operations_fund.get_or_create(0, trident, None, None);
        let state_seeds: &[&[u8]] = &[b"global_state"];
        let state = fuzz_accounts.state.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(state_seeds, program_id)),
            None,
        );
        let borrower = fuzz_accounts.borrower.get_or_create(0, trident, None, None);
        let liquidator = fuzz_accounts.bot_processor.get_or_create(0, trident, None, None);
        let collateral_registry_seeds: &[&[u8]] = &[b"collateral_registry"];
        let collateral_registry = fuzz_accounts.collateral_registry.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(collateral_registry_seeds, program_id)),
            Some(AccountMetadata::new(1_000_000_000, 512, program_id)),
        );
        let price_feed_account = fuzz_accounts
            .price_feed_account
            .get_or_create(0, trident, None, None);
        let treasury = fuzz_accounts.treasury.get_or_create(0, trident, None, None);
        let usdc_mint = fuzz_accounts.usdc_mint.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
        );
        let collateral_mint = fuzz_accounts.collateral_mint.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
        );
        let bot_usdc_ata = fuzz_accounts
            .bot_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let contract_usdc_ata = fuzz_accounts
            .contract_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let contract_collateral_ata = fuzz_accounts
            .contract_collateral_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let bot_collateral_ata = fuzz_accounts
            .bot_collateral_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let borrower_collateral_ata = fuzz_accounts
            .borrower_collateral_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));

        ensure_token_account(trident, &bot_usdc_ata, &usdc_mint, &liquidator, 5_000_000_000);
        ensure_token_account(trident, &contract_usdc_ata, &usdc_mint, &contract, 0);
        ensure_token_account(
            trident,
            &contract_collateral_ata,
            &collateral_mint,
            &contract,
            0,
        );
        ensure_token_account(
            trident,
            &bot_collateral_ata,
            &collateral_mint,
            &liquidator,
            0,
        );
        ensure_token_account(
            trident,
            &borrower_collateral_ata,
            &collateral_mint,
            &borrower,
            0,
        );
        let publish_time = current_timestamp(trident);
        ensure_pyth_price_feed(
            trident,
            &price_feed_account,
            1_000_000,
            0,
            -8,
            publish_time,
        );

        self.accounts.contract.set_address(contract);
        self.accounts.operations_fund.set_address(operations_fund);
        self.accounts.state.set_address(state);
        self.accounts.borrower.set_address(borrower);
        self.accounts.liquidator.set_address(liquidator);
        self.accounts.collateral_registry.set_address(collateral_registry);
        self.accounts.price_feed_account.set_address(price_feed_account);
        self.accounts.treasury.set_address(treasury);
        self.accounts.bot_usdc_ata.set_address(bot_usdc_ata);
        self.accounts.contract_usdc_ata.set_address(contract_usdc_ata);
        self.accounts
            .contract_collateral_ata
            .set_address(contract_collateral_ata);
        self.accounts.bot_collateral_ata.set_address(bot_collateral_ata);
        self.accounts
            .borrower_collateral_ata
            .set_address(borrower_collateral_ata);
    }

    fn set_remaining_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let token_program = token_program_id();
        let contribution = fuzz_accounts.contribution.get_or_create(0, trident, None, None);
        let escrow = fuzz_accounts.escrow.get_or_create(0, trident, None, None);
        let usdc_mint = fuzz_accounts.usdc_mint.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
        );
        let escrow_usdc_ata = fuzz_accounts.escrow_usdc_ata.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
        );
        ensure_token_account(trident, &escrow_usdc_ata, &usdc_mint, &escrow, 0);

        self.remaining_accounts.accounts[0].set_account_meta(contribution, false, true);
        self.remaining_accounts.accounts[1].set_account_meta(escrow, false, true);
        self.remaining_accounts.accounts[2].set_account_meta(escrow_usdc_ata, false, true);
    }
}
