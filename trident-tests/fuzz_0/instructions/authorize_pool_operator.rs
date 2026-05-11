use crate::fuzz_accounts::FuzzAccounts;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signer;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([255u8, 50u8, 255u8, 212u8, 86u8, 5u8, 247u8, 65u8])]
pub struct AuthorizePoolOperatorInstruction {
    pub accounts: AuthorizePoolOperatorInstructionAccounts,
    pub data: AuthorizePoolOperatorInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(AuthorizePoolOperatorInstructionData)]
#[storage(FuzzAccounts)]
pub struct AuthorizePoolOperatorInstructionAccounts {
    pub state: TridentAccount,

    #[account(mut, signer)]
    pub authority: TridentAccount,

    #[account(mut)]
    pub operator_auth: TridentAccount,

    pub operator: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct AuthorizePoolOperatorInstructionData {}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for AuthorizePoolOperatorInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let operator = fuzz_accounts.operator.get_or_create(0, trident, None, None);
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let state_seeds: &[&[u8]] = &[b"global_state"];
        let state = fuzz_accounts.state.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(state_seeds, program_id)),
            None,
        );
        let authority = trident.get_client().payer().pubkey();
        let operator_auth_seeds: &[&[u8]] = &[b"pool_operator", operator.as_ref()];
        let operator_auth = fuzz_accounts.operator_auth.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(operator_auth_seeds, program_id)),
            None,
        );

        self.accounts.state.set_address(state);
        self.accounts.authority.set_address(authority);
        self.accounts.operator_auth.set_address(operator_auth);
        self.accounts.operator.set_address(operator);
    }
}
