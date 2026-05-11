use crate::fuzz_accounts::FuzzAccounts;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([19u8, 128u8, 153u8, 121u8, 221u8, 192u8, 91u8, 53u8])]
pub struct MakePaymentInstruction {
    pub accounts: MakePaymentInstructionAccounts,
    pub data: MakePaymentInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(MakePaymentInstructionData)]
#[storage(FuzzAccounts)]
pub struct MakePaymentInstructionAccounts {
    #[account(mut)]
    pub contract: TridentAccount,

    #[account(mut)]
    pub operations_fund: TridentAccount,

    #[account(mut)]
    pub state: TridentAccount,

    #[account(mut, signer)]
    pub borrower: TridentAccount,

    #[account(mut)]
    pub borrower_usdc_account: TridentAccount,

    #[account(mut)]
    pub contract_usdc_account: TridentAccount,

    #[account(mut)]
    pub contract_collateral_account: TridentAccount,

    #[account(mut)]
    pub borrower_collateral_account: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct MakePaymentInstructionData {
    pub amount: u64,
}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for MakePaymentInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_data(&mut self, trident: &mut Trident, _fuzz_accounts: &mut Self::IxAccounts) {
        self.data.amount = trident.gen_range(1..=500_000);
    }

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id = Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")
            .expect("valid program id");
        let contract = fuzz_accounts.contract.get_or_create(0, trident, None, None);
        let operations_fund = fuzz_accounts
            .operations_fund
            .get_or_create(0, trident, None, None);
        let state = fuzz_accounts.state.get_or_create(0, trident, None, None);
        let borrower = fuzz_accounts.borrower.get_or_create(0, trident, None, None);
        let borrower_usdc_account = fuzz_accounts
            .borrower_usdc_ata
            .get_or_create(0, trident, None, None);
        let contract_usdc_account = fuzz_accounts
            .contract_usdc_ata
            .get_or_create(0, trident, None, None);
        // Optional collateral accounts are omitted for zero-collateral contracts.
        let contract_collateral_account = program_id;
        let borrower_collateral_account = program_id;

        self.accounts.contract.set_address(contract);
        self.accounts.operations_fund.set_address(operations_fund);
        self.accounts.state.set_address(state);
        self.accounts.borrower.set_address(borrower);
        self.accounts
            .borrower_usdc_account
            .set_address(borrower_usdc_account);
        self.accounts
            .contract_usdc_account
            .set_address(contract_usdc_account);
        self.accounts
            .contract_collateral_account
            .set_address(contract_collateral_account);
        self.accounts
            .borrower_collateral_account
            .set_address(borrower_collateral_account);
    }
}
