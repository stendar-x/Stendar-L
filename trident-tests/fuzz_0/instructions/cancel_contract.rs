use crate::fuzz_accounts::FuzzAccounts;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([3u8, 168u8, 37u8, 73u8, 140u8, 194u8, 156u8, 165u8])]
pub struct CancelContractInstruction {
    pub accounts: CancelContractInstructionAccounts,
    pub data: CancelContractInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(CancelContractInstructionData)]
#[storage(FuzzAccounts)]
pub struct CancelContractInstructionAccounts {
    #[account(mut)]
    pub contract: TridentAccount,

    #[account(mut)]
    pub operations_fund: TridentAccount,

    #[account(mut, signer)]
    pub borrower: TridentAccount,

    #[account(mut)]
    pub contract_collateral_ata: TridentAccount,

    #[account(mut)]
    pub borrower_collateral_ata: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct CancelContractInstructionData {}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for CancelContractInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id = Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")
            .expect("valid program id");
        let contract = fuzz_accounts.contract.get_or_create(0, trident, None, None);
        let operations_fund_seeds: &[&[u8]] = &[b"operations_fund", contract.as_ref()];
        let operations_fund = fuzz_accounts.operations_fund.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(operations_fund_seeds, program_id)),
            None,
        );
        let borrower = fuzz_accounts.borrower.get_or_create(0, trident, None, None);
        let contract_collateral_ata = program_id;
        let borrower_collateral_ata = program_id;

        self.accounts.contract.set_address(contract);
        self.accounts.operations_fund.set_address(operations_fund);
        self.accounts.borrower.set_address(borrower);
        self.accounts
            .contract_collateral_ata
            .set_address(contract_collateral_ata);
        self.accounts
            .borrower_collateral_ata
            .set_address(borrower_collateral_ata);
    }
}
