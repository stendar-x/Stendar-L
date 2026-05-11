use crate::fuzz_accounts::FuzzAccounts;
use crate::helpers::{ensure_token_account, token_program_id};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([214u8, 125u8, 83u8, 97u8, 120u8, 228u8, 107u8, 87u8])]
pub struct BorrowerRepayRecallInstruction {
    pub accounts: BorrowerRepayRecallInstructionAccounts,
    pub data: BorrowerRepayRecallInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(BorrowerRepayRecallInstructionData)]
#[storage(FuzzAccounts)]
pub struct BorrowerRepayRecallInstructionAccounts {
    #[account(mut)]
    pub contract: TridentAccount,

    #[account(mut, signer)]
    pub borrower: TridentAccount,

    #[account(mut)]
    pub contribution: TridentAccount,

    #[account(mut)]
    pub escrow: TridentAccount,

    #[account(mut)]
    pub borrower_usdc_ata: TridentAccount,

    #[account(mut)]
    pub contract_usdc_ata: TridentAccount,

    #[account(mut)]
    pub escrow_usdc_ata: TridentAccount,

    #[account(mut)]
    pub contract_collateral_ata: TridentAccount,

    #[account(mut)]
    pub borrower_collateral_ata: TridentAccount,

    #[account(mut)]
    pub state: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct BorrowerRepayRecallInstructionData {}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for BorrowerRepayRecallInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let token_program = token_program_id();
        let contract = fuzz_accounts.contract.get_or_create(0, trident, None, None);
        let borrower = fuzz_accounts.borrower.get_or_create(0, trident, None, None);
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
        let borrower_usdc_ata = fuzz_accounts
            .borrower_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let contract_usdc_ata = fuzz_accounts
            .contract_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let escrow_usdc_ata = fuzz_accounts
            .escrow_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let contract_collateral_ata = fuzz_accounts
            .contract_collateral_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let borrower_collateral_ata = fuzz_accounts
            .borrower_collateral_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let state_seeds: &[&[u8]] = &[b"global_state"];
        let state = fuzz_accounts.state.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(state_seeds, program_id)),
            None,
        );

        ensure_token_account(
            trident,
            &borrower_usdc_ata,
            &usdc_mint,
            &borrower,
            5_000_000_000,
        );
        ensure_token_account(trident, &contract_usdc_ata, &usdc_mint, &contract, 0);
        ensure_token_account(trident, &escrow_usdc_ata, &usdc_mint, &escrow, 0);
        ensure_token_account(
            trident,
            &contract_collateral_ata,
            &collateral_mint,
            &contract,
            0,
        );
        ensure_token_account(
            trident,
            &borrower_collateral_ata,
            &collateral_mint,
            &borrower,
            0,
        );

        self.accounts.contract.set_address(contract);
        self.accounts.borrower.set_address(borrower);
        self.accounts.contribution.set_address(contribution);
        self.accounts.escrow.set_address(escrow);
        self.accounts.borrower_usdc_ata.set_address(borrower_usdc_ata);
        self.accounts.contract_usdc_ata.set_address(contract_usdc_ata);
        self.accounts.escrow_usdc_ata.set_address(escrow_usdc_ata);
        self.accounts
            .contract_collateral_ata
            .set_address(contract_collateral_ata);
        self.accounts
            .borrower_collateral_ata
            .set_address(borrower_collateral_ata);
        self.accounts.state.set_address(state);
    }
}
