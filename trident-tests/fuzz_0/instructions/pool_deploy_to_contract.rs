use crate::fuzz_accounts::FuzzAccounts;
use borsh::{BorshDeserialize, BorshSerialize};
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([56u8, 226u8, 178u8, 79u8, 30u8, 133u8, 195u8, 155u8])]
pub struct PoolDeployToContractInstruction {
    pub accounts: PoolDeployToContractInstructionAccounts,
    pub data: PoolDeployToContractInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(PoolDeployToContractInstructionData)]
#[storage(FuzzAccounts)]
pub struct PoolDeployToContractInstructionAccounts {
    #[account(mut, signer)]
    pub operator: TridentAccount,

    #[account(mut)]
    pub pool: TridentAccount,

    #[account(mut)]
    pub pool_vault: TridentAccount,

    #[account(mut)]
    pub contract: TridentAccount,

    pub state: TridentAccount,

    #[account(mut)]
    pub contribution: TridentAccount,

    #[account(mut)]
    pub escrow: TridentAccount,

    #[account(mut)]
    pub contract_usdc_account: TridentAccount,

    #[account(mut)]
    pub borrower: TridentAccount,

    #[account(mut)]
    pub borrower_usdc_account: TridentAccount,

    pub approved_funder: TridentAccount,

    pub usdc_mint: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,

    #[account(address = "11111111111111111111111111111111")]
    pub system_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct PoolDeployToContractInstructionData {
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
impl InstructionHooks for PoolDeployToContractInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_data(&mut self, trident: &mut Trident, _fuzz_accounts: &mut Self::IxAccounts) {
        self.data.amount = trident.gen_range(100_000..=2_000_000);
    }

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let operator = fuzz_accounts.operator.get_or_create(0, trident, None, None);
        let pool = fuzz_accounts.pool.get_or_create(0, trident, None, None);
        let pool_vault = fuzz_accounts.pool_vault.get_or_create(0, trident, None, None);
        let contract = fuzz_accounts.contract.get_or_create(0, trident, None, None);
        let state = fuzz_accounts.state.get_or_create(0, trident, None, None);
        let contribution = fuzz_accounts.contribution.get_or_create(0, trident, None, None);
        let escrow = fuzz_accounts.escrow.get_or_create(0, trident, None, None);
        let contract_usdc_account = fuzz_accounts
            .contract_usdc_account
            .get_or_create(0, trident, None, None);
        let borrower = fuzz_accounts.borrower.get_or_create(0, trident, None, None);
        let borrower_usdc_account = fuzz_accounts
            .borrower_usdc_account
            .get_or_create(0, trident, None, None);
        let approved_funder = fuzz_accounts.approved_funder.get_or_create(0, trident, None, None);
        let usdc_mint = fuzz_accounts.usdc_mint.get_or_create(0, trident, None, None);

        self.accounts.operator.set_address(operator);
        self.accounts.pool.set_address(pool);
        self.accounts.pool_vault.set_address(pool_vault);
        self.accounts.contract.set_address(contract);
        self.accounts.state.set_address(state);
        self.accounts.contribution.set_address(contribution);
        self.accounts.escrow.set_address(escrow);
        self.accounts
            .contract_usdc_account
            .set_address(contract_usdc_account);
        self.accounts.borrower.set_address(borrower);
        self.accounts
            .borrower_usdc_account
            .set_address(borrower_usdc_account);
        self.accounts.approved_funder.set_address(approved_funder);
        self.accounts.usdc_mint.set_address(usdc_mint);
    }
}
