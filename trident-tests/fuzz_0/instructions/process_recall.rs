use crate::fuzz_accounts::FuzzAccounts;
use crate::helpers::{
    associated_token_program_id, ensure_mint_account, ensure_token_account, token_program_id,
};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([6u8, 202u8, 104u8, 82u8, 53u8, 190u8, 83u8, 194u8])]
pub struct ProcessRecallInstruction {
    pub accounts: ProcessRecallInstructionAccounts,
    pub data: ProcessRecallInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(ProcessRecallInstructionData)]
#[storage(FuzzAccounts)]
pub struct ProcessRecallInstructionAccounts {
    #[account(mut)]
    pub contract: TridentAccount,

    #[account(signer)]
    pub bot_authority: TridentAccount,

    #[account(mut)]
    pub treasury: TridentAccount,

    #[account(mut)]
    pub contribution: TridentAccount,

    #[account(mut)]
    pub escrow: TridentAccount,

    #[account(mut)]
    pub bot_usdc_ata: TridentAccount,

    #[account(mut)]
    pub contract_usdc_ata: TridentAccount,

    #[account(mut)]
    pub escrow_usdc_ata: TridentAccount,

    #[account(mut)]
    pub treasury_usdc_ata: TridentAccount,

    #[account(mut)]
    pub contract_collateral_ata: TridentAccount,

    #[account(mut)]
    pub bot_collateral_ata: TridentAccount,

    pub borrower: TridentAccount,

    #[account(mut)]
    pub state: TridentAccount,

    #[account(mut)]
    pub frontend_usdc_ata: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct ProcessRecallInstructionData {}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for ProcessRecallInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let token_program = token_program_id();
        let associated_token_program = associated_token_program_id();

        let contract = fuzz_accounts.contract.get_or_create(0, trident, None, None);
        let bot_authority = fuzz_accounts
            .bot_processor
            .get_or_create(0, trident, None, None);
        let treasury = fuzz_accounts.treasury.get_or_create(0, trident, None, None);
        let contribution = fuzz_accounts.contribution.get_or_create(0, trident, None, None);
        let escrow = fuzz_accounts.escrow.get_or_create(0, trident, None, None);
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
        ensure_mint_account(trident, &usdc_mint, &bot_authority, 6);
        ensure_mint_account(trident, &collateral_mint, &bot_authority, 6);

        let bot_usdc_ata = fuzz_accounts.bot_usdc_ata.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
        );
        let contract_usdc_ata = fuzz_accounts
            .contract_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let escrow_usdc_ata = fuzz_accounts
            .escrow_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let treasury_usdc_seeds: &[&[u8]] =
            &[treasury.as_ref(), token_program.as_ref(), usdc_mint.as_ref()];
        let treasury_usdc_ata = fuzz_accounts.treasury_usdc_ata.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(treasury_usdc_seeds, associated_token_program)),
            Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
        );
        let contract_collateral_ata = fuzz_accounts
            .contract_collateral_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let bot_collateral_ata = fuzz_accounts
            .bot_collateral_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let borrower = fuzz_accounts.borrower.get_or_create(0, trident, None, None);
        let state_seeds: &[&[u8]] = &[b"global_state"];
        let state = fuzz_accounts.state.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(state_seeds, program_id)),
            None,
        );
        let frontend_usdc_ata = program_id;

        ensure_token_account(trident, &bot_usdc_ata, &usdc_mint, &bot_authority, 5_000_000_000);
        ensure_token_account(trident, &contract_usdc_ata, &usdc_mint, &contract, 0);
        ensure_token_account(trident, &escrow_usdc_ata, &usdc_mint, &escrow, 0);
        ensure_token_account(trident, &treasury_usdc_ata, &usdc_mint, &treasury, 0);
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
            &bot_authority,
            0,
        );

        self.accounts.contract.set_address(contract);
        self.accounts.bot_authority.set_address(bot_authority);
        self.accounts.treasury.set_address(treasury);
        self.accounts.contribution.set_address(contribution);
        self.accounts.escrow.set_address(escrow);
        self.accounts.bot_usdc_ata.set_address(bot_usdc_ata);
        self.accounts.contract_usdc_ata.set_address(contract_usdc_ata);
        self.accounts.escrow_usdc_ata.set_address(escrow_usdc_ata);
        self.accounts.treasury_usdc_ata.set_address(treasury_usdc_ata);
        self.accounts
            .contract_collateral_ata
            .set_address(contract_collateral_ata);
        self.accounts.bot_collateral_ata.set_address(bot_collateral_ata);
        self.accounts.borrower.set_address(borrower);
        self.accounts.state.set_address(state);
        self.accounts.frontend_usdc_ata.set_address(frontend_usdc_ata);
    }
}
