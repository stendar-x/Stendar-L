use crate::fuzz_accounts::FuzzAccounts;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::bpf_loader_upgradeable;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signer;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([175u8, 175u8, 109u8, 31u8, 13u8, 152u8, 155u8, 237u8])]
pub struct InitializeInstruction {
    pub accounts: InitializeInstructionAccounts,
    pub data: InitializeInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(InitializeInstructionData)]
#[storage(FuzzAccounts)]
pub struct InitializeInstructionAccounts {
    #[account(mut)]
    pub state: TridentAccount,

    #[account(mut, signer)]
    pub authority: TridentAccount,

    pub program_data: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct InitializeInstructionData {}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for InitializeInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let state_seeds: &[&[u8]] = &[b"global_state"];
        let state = fuzz_accounts.state.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(state_seeds, program_id)),
            None,
        );
        let (program_data, _) =
            Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::id());
        let authority = trident.get_client().payer().pubkey();
        let mut program_data_account = trident.get_client().get_account(&program_data);
        if program_data_account.owner() == &bpf_loader_upgradeable::id() {
            let mut data = program_data_account.data().to_vec();
            if data.len() >= 45 {
                // Force upgrade authority to the signer key used by the harness.
                data[12] = 1;
                data[13..45].copy_from_slice(authority.as_ref());
                program_data_account.set_data_from_slice(&data);
                trident
                    .get_client()
                    .set_account_custom(&program_data, &program_data_account);
            }
        }

        self.accounts.state.set_address(state);
        self.accounts.authority.set_address(authority);
        self.accounts.program_data.set_address(program_data);
    }
}
