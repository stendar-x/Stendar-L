use crate::fuzz_accounts::FuzzAccounts;
use crate::helpers::{
    associated_token_program_id, ensure_token_account, token_program_id,
};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([140u8, 222u8, 47u8, 32u8, 235u8, 92u8, 82u8, 200u8])]
pub struct CompoundPoolYieldInstruction {
    pub accounts: CompoundPoolYieldInstructionAccounts,
    pub data: CompoundPoolYieldInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(CompoundPoolYieldInstructionData)]
#[storage(FuzzAccounts)]
pub struct CompoundPoolYieldInstructionAccounts {
    #[account(signer)]
    pub caller: TridentAccount,

    pub state: TridentAccount,

    #[account(mut)]
    pub treasury: TridentAccount,

    #[account(mut)]
    pub pool: TridentAccount,

    #[account(mut)]
    pub pool_deposit: TridentAccount,

    pub depositor: TridentAccount,

    #[account(mut)]
    pub pool_vault: TridentAccount,

    #[account(mut)]
    pub treasury_usdc_account: TridentAccount,

    #[account(mut)]
    pub frontend_usdc_ata: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct CompoundPoolYieldInstructionData {}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for CompoundPoolYieldInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let token_program = token_program_id();
        let associated_token_program = associated_token_program_id();
        let state_seeds: &[&[u8]] = &[b"global_state"];
        let state = fuzz_accounts.state.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(state_seeds, program_id)),
            None,
        );
        let treasury_seeds: &[&[u8]] = &[b"treasury"];
        let treasury = fuzz_accounts.treasury.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(treasury_seeds, program_id)),
            None,
        );
        let pool = fuzz_accounts.pool.get_or_create(0, trident, None, None);
        let depositor = fuzz_accounts.depositor.get_or_create(0, trident, None, None);
        let caller = depositor;
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
        let treasury_usdc_seeds: &[&[u8]] =
            &[treasury.as_ref(), token_program.as_ref(), usdc_mint.as_ref()];
        let treasury_usdc_account = fuzz_accounts.treasury_usdc_account.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(treasury_usdc_seeds, associated_token_program)),
            Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
        );
        let frontend_usdc_ata = program_id;

        ensure_token_account(trident, &pool_vault, &usdc_mint, &pool, 0);
        ensure_token_account(trident, &treasury_usdc_account, &usdc_mint, &treasury, 0);

        self.accounts.caller.set_address(caller);
        self.accounts.state.set_address(state);
        self.accounts.treasury.set_address(treasury);
        self.accounts.pool.set_address(pool);
        self.accounts.pool_deposit.set_address(pool_deposit);
        self.accounts.depositor.set_address(depositor);
        self.accounts.pool_vault.set_address(pool_vault);
        self.accounts
            .treasury_usdc_account
            .set_address(treasury_usdc_account);
        self.accounts.frontend_usdc_ata.set_address(frontend_usdc_ata);
    }
}
