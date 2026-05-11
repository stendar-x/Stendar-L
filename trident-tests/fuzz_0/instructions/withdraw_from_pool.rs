use crate::fuzz_accounts::FuzzAccounts;
use crate::helpers::{associated_token_program_id, ensure_token_account, token_program_id};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([62u8, 33u8, 128u8, 81u8, 40u8, 234u8, 29u8, 77u8])]
pub struct WithdrawFromPoolInstruction {
    pub accounts: WithdrawFromPoolInstructionAccounts,
    pub data: WithdrawFromPoolInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(WithdrawFromPoolInstructionData)]
#[storage(FuzzAccounts)]
pub struct WithdrawFromPoolInstructionAccounts {
    #[account(signer)]
    pub depositor: TridentAccount,

    #[account(mut)]
    pub pool: TridentAccount,

    #[account(mut)]
    pub pool_deposit: TridentAccount,

    #[account(mut)]
    pub pool_vault: TridentAccount,

    #[account(mut)]
    pub depositor_usdc_ata: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct WithdrawFromPoolInstructionData {
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
impl InstructionHooks for WithdrawFromPoolInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_data(&mut self, trident: &mut Trident, _fuzz_accounts: &mut Self::IxAccounts) {
        self.data.amount = trident.gen_range(1..=5_000_000);
    }

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let token_program = token_program_id();
        let associated_token_program = associated_token_program_id();
        let depositor = fuzz_accounts.depositor.get_or_create(0, trident, None, None);
        let pool = fuzz_accounts.pool.get_or_create(0, trident, None, None);
        let pool_deposit_seeds: &[&[u8]] = &[b"pool_deposit", pool.as_ref(), depositor.as_ref()];
        let pool_deposit = fuzz_accounts.pool_deposit.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(pool_deposit_seeds, program_id)),
            None,
        );
        let usdc_mint = fuzz_accounts.usdc_mint.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
        );
        let (pool_vault, _) = Pubkey::find_program_address(
            &[pool.as_ref(), token_program.as_ref(), usdc_mint.as_ref()],
            &associated_token_program,
        );
        let depositor_usdc_ata = fuzz_accounts
            .depositor_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));

        ensure_token_account(trident, &pool_vault, &usdc_mint, &pool, 0);
        ensure_token_account(
            trident,
            &depositor_usdc_ata,
            &usdc_mint,
            &depositor,
            5_000_000_000,
        );

        self.accounts.depositor.set_address(depositor);
        self.accounts.pool.set_address(pool);
        self.accounts.pool_deposit.set_address(pool_deposit);
        self.accounts.pool_vault.set_address(pool_vault);
        self.accounts.depositor_usdc_ata.set_address(depositor_usdc_ata);
    }
}
