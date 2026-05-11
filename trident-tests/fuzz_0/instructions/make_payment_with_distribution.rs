use crate::fuzz_accounts::FuzzAccounts;
use crate::helpers::{ensure_token_account, token_program_id};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(Debug, Clone, TridentRemainingAccounts, Default)]
pub struct MakePaymentWithDistributionRemainingAccounts {
    pub accounts: [TridentAccount; 3],
}

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([69u8, 20u8, 240u8, 232u8, 172u8, 174u8, 130u8, 174u8])]
pub struct MakePaymentWithDistributionInstruction {
    pub accounts: MakePaymentWithDistributionInstructionAccounts,
    pub remaining_accounts: MakePaymentWithDistributionRemainingAccounts,
    pub data: MakePaymentWithDistributionInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(MakePaymentWithDistributionInstructionData)]
#[storage(FuzzAccounts)]
pub struct MakePaymentWithDistributionInstructionAccounts {
    #[account(mut)]
    pub contract: TridentAccount,

    #[account(mut)]
    pub operations_fund: TridentAccount,

    #[account(mut)]
    pub state: TridentAccount,

    #[account(mut, signer)]
    pub borrower: TridentAccount,

    #[account(mut)]
    pub borrower_usdc_account: TridentAccount,

    #[account(mut)]
    pub contract_usdc_account: TridentAccount,

    #[account(mut)]
    pub contract_collateral_account: TridentAccount,

    #[account(mut)]
    pub borrower_collateral_account: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct MakePaymentWithDistributionInstructionData {
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
impl InstructionHooks for MakePaymentWithDistributionInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_data(&mut self, trident: &mut Trident, _fuzz_accounts: &mut Self::IxAccounts) {
        self.data.amount = trident.gen_range(1..=500_000);
    }

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id = Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")
            .expect("valid program id");
        let token_program = token_program_id();
        let contract = fuzz_accounts.contract.get_or_create(0, trident, None, None);
        let operations_fund = fuzz_accounts
            .operations_fund
            .get_or_create(0, trident, None, None);
        let state = fuzz_accounts.state.get_or_create(0, trident, None, None);
        let borrower = fuzz_accounts.borrower.get_or_create(0, trident, None, None);
        let usdc_mint = fuzz_accounts.usdc_mint.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
        );
        let borrower_usdc_account = fuzz_accounts.borrower_usdc_ata.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
        );
        let contract_usdc_account = fuzz_accounts.contract_usdc_ata.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
        );
        ensure_token_account(
            trident,
            &borrower_usdc_account,
            &usdc_mint,
            &borrower,
            5_000_000_000,
        );
        ensure_token_account(trident, &contract_usdc_account, &usdc_mint, &contract, 0);
        // Optional collateral accounts are omitted for zero-collateral contracts.
        let contract_collateral_account = program_id;
        let borrower_collateral_account = program_id;

        self.accounts.contract.set_address(contract);
        self.accounts.operations_fund.set_address(operations_fund);
        self.accounts.state.set_address(state);
        self.accounts.borrower.set_address(borrower);
        self.accounts
            .borrower_usdc_account
            .set_address(borrower_usdc_account);
        self.accounts
            .contract_usdc_account
            .set_address(contract_usdc_account);
        self.accounts
            .contract_collateral_account
            .set_address(contract_collateral_account);
        self.accounts
            .borrower_collateral_account
            .set_address(borrower_collateral_account);
    }

    fn set_remaining_accounts(
        &mut self,
        trident: &mut Trident,
        fuzz_accounts: &mut Self::IxAccounts,
    ) {
        let token_program = token_program_id();
        let contribution = fuzz_accounts
            .contribution
            .get_or_create(0, trident, None, None);
        let escrow = fuzz_accounts.escrow.get_or_create(0, trident, None, None);
        let usdc_mint = fuzz_accounts.usdc_mint.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
        );
        let escrow_usdc_ata = fuzz_accounts.escrow_usdc_ata.get_or_create(
            0,
            trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
        );
        ensure_token_account(trident, &escrow_usdc_ata, &usdc_mint, &escrow, 0);

        self.remaining_accounts.accounts[0].set_account_meta(contribution, false, true);
        self.remaining_accounts.accounts[1].set_account_meta(escrow, false, true);
        self.remaining_accounts.accounts[2].set_account_meta(escrow_usdc_ata, false, true);
    }
}
