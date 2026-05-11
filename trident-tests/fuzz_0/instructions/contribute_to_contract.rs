use crate::fuzz_accounts::FuzzAccounts;
use crate::helpers::{ensure_token_account, token_program_id};
use crate::types::DebtContractSnapshot;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::account::ReadableAccount;
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([203u8, 38u8, 209u8, 240u8, 212u8, 140u8, 70u8, 80u8])]
pub struct ContributeToContractInstruction {
    pub accounts: ContributeToContractInstructionAccounts,
    pub data: ContributeToContractInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(ContributeToContractInstructionData)]
#[storage(FuzzAccounts)]
pub struct ContributeToContractInstructionAccounts {
    #[account(mut)]
    pub contract: TridentAccount,

    pub state: TridentAccount,

    #[account(mut)]
    pub contribution: TridentAccount,

    #[account(mut)]
    pub escrow: TridentAccount,

    #[account(mut, signer)]
    pub lender: TridentAccount,

    #[account(mut)]
    pub borrower: TridentAccount,

    pub approved_funder: TridentAccount,

    #[account(mut)]
    pub lender_usdc_account: TridentAccount,

    #[account(mut)]
    pub contract_usdc_account: TridentAccount,

    #[account(mut)]
    pub borrower_usdc_account: TridentAccount,

    pub usdc_mint: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct ContributeToContractInstructionData {
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
impl InstructionHooks for ContributeToContractInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_data(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let contract = fuzz_accounts.contract.get_or_create(0, trident, None, None);
        let contract_account = trident.get_client().get_account(&contract);
        if contract_account.data().len() > 8 {
            let mut payload = &contract_account.data()[8..];
            if let Ok(contract_state) = DebtContractSnapshot::deserialize(&mut payload) {
                let remaining = contract_state
                    .target_amount
                    .saturating_sub(contract_state.funded_amount);
                if remaining > 0 {
                    self.data.amount = remaining;
                    return;
                }
            }
        }

        self.data.amount = trident.gen_range(500_000..=2_000_000);
    }

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let program_id =
            Pubkey::from_str("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE").expect("valid program id");
        let token_program = token_program_id();

        let contract = fuzz_accounts.contract.get_or_create(0, trident, None, None);
        let state_seeds: &[&[u8]] = &[b"global_state"];
        let state = fuzz_accounts.state.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(state_seeds, program_id)),
            None,
        );
        let lender = fuzz_accounts.lender.get_or_create(0, trident, None, None);
        let contribution_seeds: &[&[u8]] = &[b"contribution", contract.as_ref(), lender.as_ref()];
        let contribution = fuzz_accounts.contribution.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(contribution_seeds, program_id)),
            None,
        );
        let escrow_seeds: &[&[u8]] = &[b"escrow", contract.as_ref(), lender.as_ref()];
        let escrow = fuzz_accounts.escrow.get_or_create(
            0,
            trident,
            Some(PdaSeeds::new(escrow_seeds, program_id)),
            None,
        );
        let borrower = fuzz_accounts.borrower.get_or_create(0, trident, None, None);
        let approved_funder = program_id;
        let lender_usdc_account = fuzz_accounts
            .lender_usdc_account
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let contract_usdc_account = fuzz_accounts
            .contract_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let borrower_usdc_account = fuzz_accounts
            .borrower_usdc_ata
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 165, token_program)));
        let usdc_mint = fuzz_accounts
            .usdc_mint
            .get_or_create(0, trident, None, Some(AccountMetadata::new(1_000_000_000, 82, token_program)));
        ensure_token_account(
            trident,
            &lender_usdc_account,
            &usdc_mint,
            &lender,
            5_000_000_000,
        );
        ensure_token_account(trident, &contract_usdc_account, &usdc_mint, &contract, 0);
        ensure_token_account(
            trident,
            &borrower_usdc_account,
            &usdc_mint,
            &borrower,
            5_000_000_000,
        );

        self.accounts.contract.set_address(contract);
        self.accounts.state.set_address(state);
        self.accounts.contribution.set_address(contribution);
        self.accounts.escrow.set_address(escrow);
        self.accounts.lender.set_address(lender);
        self.accounts.borrower.set_address(borrower);
        self.accounts.approved_funder.set_address(approved_funder);
        self.accounts.lender_usdc_account.set_address(lender_usdc_account);
        self.accounts.contract_usdc_account.set_address(contract_usdc_account);
        self.accounts.borrower_usdc_account.set_address(borrower_usdc_account);
        self.accounts.usdc_mint.set_address(usdc_mint);
    }
}
