use crate::fuzz_accounts::FuzzAccounts;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([239u8, 163u8, 211u8, 151u8, 182u8, 61u8, 155u8, 208u8])]
pub struct RequestRecallInstruction {
    pub accounts: RequestRecallInstructionAccounts,
    pub data: RequestRecallInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(RequestRecallInstructionData)]
#[storage(FuzzAccounts)]
pub struct RequestRecallInstructionAccounts {
    #[account(mut)]
    pub contract: TridentAccount,

    pub state: TridentAccount,

    #[account(signer)]
    pub lender: TridentAccount,

    #[account(mut)]
    pub contribution: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct RequestRecallInstructionData {}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for RequestRecallInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let contract = fuzz_accounts.contract.get_or_create(0, trident, None, None);
        let state_seeds: &[&[u8]] = &[b"global_state"];
        let state = fuzz_accounts.state.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(state_seeds, program_id)),
            None,
        );
        let lender = fuzz_accounts.lender.get_or_create(0, trident, None, None);
        let contribution = fuzz_accounts.contribution.get_or_create(0, trident, None, None);

        self.accounts.contract.set_address(contract);
        self.accounts.state.set_address(state);
        self.accounts.lender.set_address(lender);
        self.accounts.contribution.set_address(contribution);
    }
}
