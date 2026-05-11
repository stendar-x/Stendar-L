use crate::fuzz_accounts::FuzzAccounts;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([179u8, 230u8, 125u8, 252u8, 189u8, 246u8, 68u8, 244u8])]
pub struct RequestPoolWithdrawalInstruction {
    pub accounts: RequestPoolWithdrawalInstructionAccounts,
    pub data: RequestPoolWithdrawalInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(RequestPoolWithdrawalInstructionData)]
#[storage(FuzzAccounts)]
pub struct RequestPoolWithdrawalInstructionAccounts {
    #[account(signer)]
    pub depositor: TridentAccount,

    #[account(mut)]
    pub pool: TridentAccount,

    #[account(mut)]
    pub pool_deposit: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct RequestPoolWithdrawalInstructionData {
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
impl InstructionHooks for RequestPoolWithdrawalInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_data(&mut self, trident: &mut Trident, _fuzz_accounts: &mut Self::IxAccounts) {
        self.data.amount = trident.gen_range(1..=5_000_000);
    }

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let depositor = fuzz_accounts.depositor.get_or_create(0, trident, None, None);
        let pool = fuzz_accounts.pool.get_or_create(0, trident, None, None);
        let pool_deposit_seeds: &[&[u8]] = &[b"pool_deposit", pool.as_ref(), depositor.as_ref()];
        let pool_deposit = fuzz_accounts.pool_deposit.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(pool_deposit_seeds, program_id)),
            None,
        );

        self.accounts.depositor.set_address(depositor);
        self.accounts.pool.set_address(pool);
        self.accounts.pool_deposit.set_address(pool_deposit);
    }
}
