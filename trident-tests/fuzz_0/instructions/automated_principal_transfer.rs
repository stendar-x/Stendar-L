use crate::fuzz_accounts::FuzzAccounts;
use crate::helpers::{ensure_token_account, token_program_id};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(Debug, Clone, TridentRemainingAccounts, Default)]
pub struct AutomatedPrincipalTransferRemainingAccounts {
    pub accounts: [TridentAccount; 4],
}

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([245u8, 228u8, 190u8, 93u8, 87u8, 199u8, 87u8, 59u8])]
pub struct AutomatedPrincipalTransferInstruction {
    pub accounts: AutomatedPrincipalTransferInstructionAccounts,
    pub remaining_accounts: AutomatedPrincipalTransferRemainingAccounts,
    pub data: AutomatedPrincipalTransferInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(AutomatedPrincipalTransferInstructionData)]
#[storage(FuzzAccounts)]
pub struct AutomatedPrincipalTransferInstructionAccounts {
    #[account(mut)]
    pub contract: TridentAccount,

    #[account(mut)]
    pub operations_fund: TridentAccount,

    #[account(mut)]
    pub treasury: TridentAccount,

    pub state: TridentAccount,

    #[account(mut)]
    pub contract_usdc_account: TridentAccount,

    #[account(mut)]
    pub bot_usdc_ata: TridentAccount,

    #[account(mut)]
    pub contract_collateral_account: TridentAccount,

    #[account(mut)]
    pub bot_collateral_ata: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,

    #[account(mut, signer)]
    pub bot_processor: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct AutomatedPrincipalTransferInstructionData {}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for AutomatedPrincipalTransferInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let token_program = token_program_id();
        let contract = fuzz_accounts.contract.get_or_create(0, trident, None, None);
        let operations_fund = fuzz_accounts.operations_fund.get_or_create(0, trident, None, None);
        let treasury = fuzz_accounts.treasury.get_or_create(0, trident, None, None);
        let state_seeds: &[&[u8]] = &[b"global_state"];
        let state = fuzz_accounts.state.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(state_seeds, program_id)),
            None,
        );
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
        let contract_usdc_account = fuzz_accounts
            .contract_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let bot_usdc_ata = fuzz_accounts
            .bot_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let contract_collateral_account = fuzz_accounts
            .contract_collateral_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let bot_collateral_ata = fuzz_accounts
            .bot_collateral_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let bot_processor = fuzz_accounts.bot_processor.get_or_create(0, trident, None, None);

        ensure_token_account(trident, &contract_usdc_account, &usdc_mint, &contract, 0);
        ensure_token_account(trident, &bot_usdc_ata, &usdc_mint, &bot_processor, 5_000_000_000);
        ensure_token_account(
            trident,
            &contract_collateral_account,
            &collateral_mint,
            &contract,
            0,
        );
        ensure_token_account(
            trident,
            &bot_collateral_ata,
            &collateral_mint,
            &bot_processor,
            0,
        );

        self.accounts.contract.set_address(contract);
        self.accounts.operations_fund.set_address(operations_fund);
        self.accounts.treasury.set_address(treasury);
        self.accounts.state.set_address(state);
        self.accounts
            .contract_usdc_account
            .set_address(contract_usdc_account);
        self.accounts.bot_usdc_ata.set_address(bot_usdc_ata);
        self.accounts
            .contract_collateral_account
            .set_address(contract_collateral_account);
        self.accounts.bot_collateral_ata.set_address(bot_collateral_ata);
        self.accounts.bot_processor.set_address(bot_processor);
    }

    fn set_remaining_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let token_program = token_program_id();
        let contribution = fuzz_accounts.contribution.get_or_create(0, trident, None, None);
        let escrow = fuzz_accounts.escrow.get_or_create(0, trident, None, None);
        let lender = fuzz_accounts.lender.get_or_create(0, trident, None, None);
        let usdc_mint = fuzz_accounts.usdc_mint.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
        );
        let lender_usdc_ata = fuzz_accounts.lender_usdc_account.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
        );
        ensure_token_account(trident, &lender_usdc_ata, &usdc_mint, &lender, 0);

        self.remaining_accounts.accounts[0].set_account_meta(contribution, false, true);
        self.remaining_accounts.accounts[1].set_account_meta(escrow, false, true);
        self.remaining_accounts.accounts[2].set_account_meta(lender, false, false);
        self.remaining_accounts.accounts[3].set_account_meta(lender_usdc_ata, false, true);
    }
}
