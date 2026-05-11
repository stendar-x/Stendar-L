use crate::fuzz_accounts::FuzzAccounts;
use borsh::{BorshDeserialize, BorshSerialize};
use trident_fuzz::fuzzing::*;

#[derive(TridentInstruction, Default)]
#[program_id("278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE")]
#[discriminator([127u8, 82u8, 121u8, 42u8, 161u8, 176u8, 249u8, 206u8])]
pub struct AddCollateralInstruction {
    pub accounts: AddCollateralInstructionAccounts,
    pub data: AddCollateralInstructionData,
}

/// Instruction Accounts
#[derive(Debug, Clone, TridentAccounts, Default)]
#[instruction_data(AddCollateralInstructionData)]
#[storage(FuzzAccounts)]
pub struct AddCollateralInstructionAccounts {
    #[account(mut)]
    pub contract: TridentAccount,

    pub state: TridentAccount,

    #[account(mut, signer)]
    pub borrower: TridentAccount,

    #[account(mut)]
    pub borrower_collateral_ata: TridentAccount,

    #[account(mut)]
    pub contract_collateral_ata: TridentAccount,

    #[account(address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
    pub token_program: TridentAccount,
}

/// Instruction Data
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct AddCollateralInstructionData {
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
impl InstructionHooks for AddCollateralInstruction {
    type IxAccounts = FuzzAccounts;

    fn set_data(&mut self, trident: &mut Trident, _fuzz_accounts: &mut Self::IxAccounts) {
        self.data.amount = trident.gen_range(1_000_000..=10_000_000);
    }

    fn set_accounts(&mut self, trident: &mut Trident, fuzz_accounts: &mut Self::IxAccounts) {
        let contract = fuzz_accounts.contract.get_or_create(0, trident, None, None);
        let state = fuzz_accounts.state.get_or_create(0, trident, None, None);
        let borrower = fuzz_accounts.borrower.get_or_create(0, trident, None, None);
        let borrower_collateral_ata = fuzz_accounts
            .borrower_collateral_ata
            .get_or_create(0, trident, None, None);
        let contract_collateral_ata = fuzz_accounts
            .contract_collateral_ata
            .get_or_create(0, trident, None, None);

        self.accounts.contract.set_address(contract);
        self.accounts.state.set_address(state);
        self.accounts.borrower.set_address(borrower);
        self.accounts
            .borrower_collateral_ata
            .set_address(borrower_collateral_ata);
        self.accounts
            .contract_collateral_ata
            .set_address(contract_collateral_ata);
    }
}
