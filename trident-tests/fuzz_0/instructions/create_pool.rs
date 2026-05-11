use crate::fuzz_accounts::FuzzAccounts;
use crate::helpers::{
    associated_token_program_id, ensure_mint_account, token_program_id,
};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([233u8, 146u8, 209u8, 142u8, 207u8, 104u8, 64u8, 188u8])]
pub struct CreatePoolInstruction {
    pub accounts: CreatePoolInstructionAccounts,
    pub data: CreatePoolInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(CreatePoolInstructionData)]
#[storage(FuzzAccounts)]
pub struct CreatePoolInstructionAccounts {
    #[account(mut, signer)]
    pub operator: TridentAccount,

    pub operator_auth: TridentAccount,

    #[account(mut)]
    pub pool: TridentAccount,

    #[account(mut)]
    pub pool_vault: TridentAccount,

    pub state: TridentAccount,

    pub usdc_mint: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,

    #[account(address = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")]
    pub associated_token_program: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct CreatePoolInstructionData {
    pub pool_seed: u64,
    pub name: [u8; 32],
    pub rate_bps: u32,
    pub capacity: u64,
    pub minimum_deposit: u64,
    pub withdrawal_queue_enabled: bool,
    pub allowed_loan_type: u8,
    pub min_ltv_bps: u16,
    pub max_term_days: u32,
}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for CreatePoolInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_data(&mut self, trident: &mut Trident, _fuzz_accounts: &mut Self::IxAccounts) {
        self.data.pool_seed = trident.gen_range(1..u64::MAX);
        self.data.name = [0u8; 32];
        self.data.rate_bps = trident.gen_range(100..=2_000);
        self.data.capacity = trident.gen_range(10_000_000..=100_000_000);
        self.data.minimum_deposit = trident.gen_range(100_000..=1_000_000);
        self.data.withdrawal_queue_enabled = false;
        self.data.allowed_loan_type = 0;
        self.data.min_ltv_bps = trident.gen_range(10_000..=14_000);
        self.data.max_term_days = trident.gen_range(30..=365);
    }

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let token_program = token_program_id();
        let associated_token_program = associated_token_program_id();
        let operator = fuzz_accounts.operator.get_or_create(0, trident, None, None);
        let operator_auth_seeds: &[&[u8]] = &[b"pool_operator", operator.as_ref()];
        let operator_auth = fuzz_accounts.operator_auth.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(operator_auth_seeds, program_id)),
            None,
        );
        let pool_seed_bytes = self.data.pool_seed.to_le_bytes();
        let pool_seeds: &[&[u8]] = &[b"pool", operator.as_ref(), &pool_seed_bytes];
        let pool = fuzz_accounts.pool.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(pool_seeds, program_id)),
            None,
        );
        let state_seeds: &[&[u8]] = &[b"global_state"];
        let state = fuzz_accounts.state.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(state_seeds, program_id)),
            None,
        );
        let usdc_mint = fuzz_accounts.usdc_mint.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
        );
        ensure_mint_account(trident, &usdc_mint, &operator, 6);
        let (pool_vault, _) = Pubkey::find_program_address(
            &[pool.as_ref(), token_program.as_ref(), usdc_mint.as_ref()],
            &associated_token_program,
        );
        // Keep the vault uninitialized here: on-chain CreatePool uses `init` for this ATA.
        // Downstream pool instructions ensure token-account layout when reusing the address.

        self.accounts.operator.set_address(operator);
        self.accounts.operator_auth.set_address(operator_auth);
        self.accounts.pool.set_address(pool);
        self.accounts.pool_vault.set_address(pool_vault);
        self.accounts.state.set_address(state);
        self.accounts.usdc_mint.set_address(usdc_mint);
    }
}
