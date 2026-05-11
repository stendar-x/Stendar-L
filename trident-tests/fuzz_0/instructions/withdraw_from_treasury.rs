use crate::fuzz_accounts::FuzzAccounts;
use crate::helpers::{
    associated_token_program_id, ensure_mint_account, ensure_token_account, token_program_id,
};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signer;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([0u8, 164u8, 86u8, 76u8, 56u8, 72u8, 12u8, 170u8])]
pub struct WithdrawFromTreasuryInstruction {
    pub accounts: WithdrawFromTreasuryInstructionAccounts,
    pub data: WithdrawFromTreasuryInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(WithdrawFromTreasuryInstructionData)]
#[storage(FuzzAccounts)]
pub struct WithdrawFromTreasuryInstructionAccounts {
    #[account(mut)]
    pub treasury: TridentAccount,

    #[account(mut, signer)]
    pub authority: TridentAccount,

    #[account(mut)]
    pub recipient: TridentAccount,

    #[account(mut)]
    pub treasury_usdc_account: TridentAccount,

    #[account(mut)]
    pub recipient_usdc_account: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct WithdrawFromTreasuryInstructionData {
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
impl InstructionHooks for WithdrawFromTreasuryInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_data(&mut self, trident: &mut Trident, _fuzz_accounts: &mut Self::IxAccounts) {
        self.data.amount = trident.gen_range(1..=1_000_000);
    }

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id = Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")
            .expect("valid program id");
        let token_program = token_program_id();
        let associated_token_program = associated_token_program_id();
        let treasury_seeds: &[&[u8]] = &[b"treasury"];
        let treasury = fuzz_accounts.treasury.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(treasury_seeds, program_id)),
            None,
        );
        let authority = trident.get_client().payer().pubkey();
        let recipient = fuzz_accounts.borrower.get_or_create(0, trident, None, None);
        let usdc_mint = fuzz_accounts.usdc_mint.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
        );
        let treasury_usdc_seeds: &[&[u8]] = &[
            treasury.as_ref(),
            token_program.as_ref(),
            usdc_mint.as_ref(),
        ];
        let treasury_usdc_account = fuzz_accounts.treasury_usdc_account.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(treasury_usdc_seeds, associated_token_program)),
            Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
        );
        let recipient_usdc_account = fuzz_accounts.borrower_usdc_ata.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
        );

        ensure_mint_account(trident, &usdc_mint, &authority, 6);
        ensure_token_account(
            trident,
            &treasury_usdc_account,
            &usdc_mint,
            &treasury,
            5_000_000_000,
        );
        ensure_token_account(trident, &recipient_usdc_account, &usdc_mint, &recipient, 0);

        self.accounts.treasury.set_address(treasury);
        self.accounts.authority.set_address(authority);
        self.accounts.recipient.set_address(recipient);
        self.accounts
            .treasury_usdc_account
            .set_address(treasury_usdc_account);
        self.accounts
            .recipient_usdc_account
            .set_address(recipient_usdc_account);
    }
}
