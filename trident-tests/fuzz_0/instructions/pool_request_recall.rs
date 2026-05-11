use crate::fuzz_accounts::FuzzAccounts;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([191u8, 58u8, 175u8, 67u8, 36u8, 106u8, 207u8, 33u8])]
pub struct PoolRequestRecallInstruction {
    pub accounts: PoolRequestRecallInstructionAccounts,
    pub data: PoolRequestRecallInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(PoolRequestRecallInstructionData)]
#[storage(FuzzAccounts)]
pub struct PoolRequestRecallInstructionAccounts {
    #[account(signer)]
    pub operator: TridentAccount,

    #[account(mut)]
    pub pool: TridentAccount,

    #[account(mut)]
    pub contract: TridentAccount,

    #[account(mut)]
    pub contribution: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct PoolRequestRecallInstructionData {}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for PoolRequestRecallInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id = Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")
            .expect("valid program id");
        let operator = fuzz_accounts.operator.get_or_create(0, trident, None, None);
        let pool = fuzz_accounts.pool.get_or_create(0, trident, None, None);
        let contract = fuzz_accounts.contract.get_or_create(0, trident, None, None);
        let contribution_seeds: &[&[u8]] = &[b"contribution", contract.as_ref(), pool.as_ref()];
        let contribution = fuzz_accounts.contribution.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(contribution_seeds, program_id)),
            None,
        );

        self.accounts.operator.set_address(operator);
        self.accounts.pool.set_address(pool);
        self.accounts.contract.set_address(contract);
        self.accounts.contribution.set_address(contribution);
    }
}
