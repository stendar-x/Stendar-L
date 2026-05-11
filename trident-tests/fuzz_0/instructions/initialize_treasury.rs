use crate::fuzz_accounts::FuzzAccounts;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signer;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([124u8, 186u8, 211u8, 195u8, 85u8, 165u8, 129u8, 166u8])]
pub struct InitializeTreasuryInstruction {
    pub accounts: InitializeTreasuryInstructionAccounts,
    pub data: InitializeTreasuryInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(InitializeTreasuryInstructionData)]
#[storage(FuzzAccounts)]
pub struct InitializeTreasuryInstructionAccounts {
    #[account(mut)]
    pub treasury: TridentAccount,

    pub state: TridentAccount,

    #[account(mut, signer)]
    pub authority: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct InitializeTreasuryInstructionData {
    pub bot_authority: TridentPubkey,

    pub usdc_mint: TridentPubkey,
}

/// Implementation of instruction setters for fuzzing
///
/// Provides methods to:
/// - Set instruction data during fuzzing
/// - Configure instruction accounts during fuzzing
/// - (Optional) Set remaining accounts during fuzzing
///
/// Docs: https://ackee.xyz/trident/docs/latest/start-fuzzing/writting-fuzz-test/
impl InstructionHooks for InitializeTreasuryInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_data(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let bot_authority = fuzz_accounts.bot_processor.get_or_create(0, trident, None, None);
        let token_program =
            Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").expect("token program");
        let usdc_mint = fuzz_accounts.usdc_mint.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
        );

        self.data.bot_authority = 0u8.into();
        self.data.bot_authority.set_pubkey(bot_authority);
        self.data.usdc_mint = 0u8.into();
        self.data.usdc_mint.set_pubkey(usdc_mint);
    }

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let treasury_seeds: &[&[u8]] = &[b"treasury"];
        let state_seeds: &[&[u8]] = &[b"global_state"];
        let treasury = fuzz_accounts.treasury.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(treasury_seeds, program_id)),
            None,
        );
        let state = fuzz_accounts.state.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(state_seeds, program_id)),
            None,
        );
        let authority = trident.get_client().payer().pubkey();

        self.accounts.treasury.set_address(treasury);
        self.accounts.state.set_address(state);
        self.accounts.authority.set_address(authority);
    }
}
