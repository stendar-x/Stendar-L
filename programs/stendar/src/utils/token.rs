#![allow(dead_code)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program, system_instruction};
use anchor_spl::token::spl_token;
use anchor_spl::token::{self, CloseAccount, SyncNative, Transfer};

#[allow(dead_code)]
pub fn transfer_spl_tokens<'info>(
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<()> {
    let cpi_accounts = Transfer {
        from,
        to,
        authority,
    };
    let cpi_ctx = CpiContext::new(token_program, cpi_accounts);

    if let Some(seeds) = signer_seeds {
        token::transfer(cpi_ctx.with_signer(seeds), amount)
    } else {
        token::transfer(cpi_ctx, amount)
    }
}

#[allow(dead_code)]
pub fn wrap_sol_to_wsol<'info>(
    source_sol_account: AccountInfo<'info>,
    dest_wsol_token_account: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let transfer_ix =
        system_instruction::transfer(source_sol_account.key, dest_wsol_token_account.key, amount);

    program::invoke(
        &transfer_ix,
        &[
            source_sol_account.clone(),
            dest_wsol_token_account.clone(),
            system_program,
        ],
    )?;

    let cpi_accounts = SyncNative {
        account: dest_wsol_token_account,
    };
    let cpi_ctx = CpiContext::new(token_program, cpi_accounts);
    token::sync_native(cpi_ctx)
}

#[allow(dead_code)]
pub fn unwrap_wsol_to_sol<'info>(
    wsol_token_account: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<()> {
    close_token_account(
        wsol_token_account,
        destination,
        authority,
        token_program,
        signer_seeds,
    )
}

#[allow(dead_code)]
pub fn close_token_account<'info>(
    account: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<()> {
    let cpi_accounts = CloseAccount {
        account,
        destination,
        authority,
    };
    let cpi_ctx = CpiContext::new(token_program, cpi_accounts);

    if let Some(seeds) = signer_seeds {
        token::close_account(cpi_ctx.with_signer(seeds))
    } else {
        token::close_account(cpi_ctx)
    }
}

pub fn is_native_mint(mint: &Pubkey) -> bool {
    mint == &spl_token::native_mint::ID
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::{
        account_info::AccountInfo,
        clock::Epoch,
        instruction::Instruction,
        program_error::ProgramError,
        program_option::COption,
        program_pack::Pack,
        program_stubs::{self, SyscallStubs},
        pubkey::Pubkey,
        system_program,
    };
    use anchor_spl::token::spl_token::{
        self,
        instruction::TokenInstruction,
        native_mint,
        state::{Account as SplTokenAccount, AccountState},
    };

    static SYSCALL_STUB_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct TokenTestSyscallStubs;

    impl SyscallStubs for TokenTestSyscallStubs {
        fn sol_invoke_signed(
            &self,
            instruction: &Instruction,
            account_infos: &[AccountInfo],
            _signers_seeds: &[&[&[u8]]],
        ) -> std::result::Result<(), ProgramError> {
            if instruction.program_id == system_program::ID {
                return handle_system_transfer(instruction, account_infos);
            }

            if instruction.program_id == spl_token::id() {
                return handle_token_instruction(instruction, account_infos);
            }

            Err(ProgramError::IncorrectProgramId)
        }
    }

    struct StubGuard {
        previous: Option<Box<dyn SyscallStubs>>,
    }

    impl StubGuard {
        fn install() -> Self {
            let previous = program_stubs::set_syscall_stubs(Box::new(TokenTestSyscallStubs));
            Self {
                previous: Some(previous),
            }
        }
    }

    impl Drop for StubGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.take() {
                let _ = program_stubs::set_syscall_stubs(previous);
            }
        }
    }

    fn with_syscall_stubs<T>(test: impl FnOnce() -> T) -> T {
        let _lock = SYSCALL_STUB_LOCK.lock().unwrap();
        let _guard = StubGuard::install();
        test()
    }

    fn handle_system_transfer(
        instruction: &Instruction,
        account_infos: &[AccountInfo],
    ) -> std::result::Result<(), ProgramError> {
        if account_infos.len() < 2 || instruction.data.len() < 12 {
            return Err(ProgramError::InvalidInstructionData);
        }

        // bincode layout: variant u32 (2 = transfer), then lamports u64.
        let discriminator = u32::from_le_bytes(
            instruction.data[0..4]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        if discriminator != 2 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let lamports = u64::from_le_bytes(
            instruction.data[4..12]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );

        let from = &account_infos[0];
        let to = &account_infos[1];
        if from.lamports() < lamports {
            return Err(ProgramError::InsufficientFunds);
        }

        **from.try_borrow_mut_lamports()? -= lamports;
        **to.try_borrow_mut_lamports()? += lamports;
        Ok(())
    }

    fn handle_token_instruction(
        instruction: &Instruction,
        account_infos: &[AccountInfo],
    ) -> std::result::Result<(), ProgramError> {
        match TokenInstruction::unpack(&instruction.data)? {
            TokenInstruction::Transfer { amount } => handle_token_transfer(account_infos, amount),
            TokenInstruction::SyncNative => handle_sync_native(account_infos),
            TokenInstruction::CloseAccount => handle_close_account(account_infos),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }

    fn handle_token_transfer(
        account_infos: &[AccountInfo],
        amount: u64,
    ) -> std::result::Result<(), ProgramError> {
        if account_infos.len() < 3 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let source_info = &account_infos[0];
        let destination_info = &account_infos[1];
        let authority_info = &account_infos[2];

        let mut source_account = unpack_token_account(source_info)?;
        let mut destination_account = unpack_token_account(destination_info)?;

        if source_account.mint != destination_account.mint {
            return Err(ProgramError::InvalidAccountData);
        }
        if source_account.owner != *authority_info.key {
            return Err(ProgramError::IllegalOwner);
        }
        if source_account.amount < amount {
            return Err(ProgramError::InsufficientFunds);
        }

        source_account.amount -= amount;
        destination_account.amount = destination_account
            .amount
            .checked_add(amount)
            .ok_or(ProgramError::InvalidInstructionData)?;

        pack_token_account(source_info, source_account)?;
        pack_token_account(destination_info, destination_account)?;
        Ok(())
    }

    fn handle_sync_native(account_infos: &[AccountInfo]) -> std::result::Result<(), ProgramError> {
        if account_infos.is_empty() {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let token_account_info = &account_infos[0];
        let mut token_account = unpack_token_account(token_account_info)?;
        if token_account.mint != native_mint::ID {
            return Err(ProgramError::InvalidAccountData);
        }

        let rent_reserve = match token_account.is_native {
            COption::Some(value) => value,
            COption::None => return Err(ProgramError::InvalidAccountData),
        };

        token_account.amount = token_account_info.lamports().saturating_sub(rent_reserve);
        pack_token_account(token_account_info, token_account)?;
        Ok(())
    }

    fn handle_close_account(
        account_infos: &[AccountInfo],
    ) -> std::result::Result<(), ProgramError> {
        if account_infos.len() < 3 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let account_info = &account_infos[0];
        let destination_info = &account_infos[1];
        let authority_info = &account_infos[2];
        let mut token_account = unpack_token_account(account_info)?;

        if token_account.owner != *authority_info.key {
            return Err(ProgramError::IllegalOwner);
        }
        if token_account.is_native == COption::None && token_account.amount != 0 {
            return Err(ProgramError::InvalidAccountData);
        }

        let reclaimed_lamports = account_info.lamports();
        **account_info.try_borrow_mut_lamports()? = 0;
        **destination_info.try_borrow_mut_lamports()? += reclaimed_lamports;

        token_account.amount = 0;
        token_account.state = AccountState::Uninitialized;
        pack_token_account(account_info, token_account)?;
        Ok(())
    }

    fn unpack_token_account(
        account_info: &AccountInfo,
    ) -> std::result::Result<SplTokenAccount, ProgramError> {
        SplTokenAccount::unpack(&account_info.try_borrow_data()?)
    }

    fn pack_token_account(
        account_info: &AccountInfo,
        account: SplTokenAccount,
    ) -> std::result::Result<(), ProgramError> {
        SplTokenAccount::pack(account, &mut account_info.try_borrow_mut_data()?)
    }

    fn create_account_info(
        key: Pubkey,
        owner: Pubkey,
        lamports: u64,
        data: Vec<u8>,
        is_signer: bool,
    ) -> AccountInfo<'static> {
        let key_ref = Box::leak(Box::new(key));
        let owner_ref = Box::leak(Box::new(owner));
        let lamports_ref = Box::leak(Box::new(lamports));
        let data_ref = Box::leak(data.into_boxed_slice());
        AccountInfo::new(
            key_ref,
            is_signer,
            true,
            lamports_ref,
            data_ref,
            owner_ref,
            false,
            Epoch::default(),
        )
    }

    fn create_system_account(lamports: u64, is_signer: bool) -> AccountInfo<'static> {
        create_account_info(
            Pubkey::new_unique(),
            system_program::ID,
            lamports,
            vec![],
            is_signer,
        )
    }

    fn create_program_account(program_id: Pubkey) -> AccountInfo<'static> {
        create_account_info(program_id, system_program::ID, 0, vec![], false)
    }

    fn create_token_account(
        mint: Pubkey,
        owner: Pubkey,
        amount: u64,
        lamports: u64,
        is_native: bool,
    ) -> AccountInfo<'static> {
        let token_account = SplTokenAccount {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: AccountState::Initialized,
            is_native: if is_native {
                COption::Some(0)
            } else {
                COption::None
            },
            delegated_amount: 0,
            close_authority: COption::None,
        };

        let mut data = vec![0u8; SplTokenAccount::LEN];
        SplTokenAccount::pack(token_account, &mut data).unwrap();
        create_account_info(Pubkey::new_unique(), spl_token::id(), lamports, data, false)
    }

    fn token_amount(account_info: &AccountInfo) -> u64 {
        unpack_token_account(account_info).unwrap().amount
    }

    #[test]
    fn transfer_spl_tokens_moves_balance() {
        with_syscall_stubs(|| {
            let mint = Pubkey::new_unique();
            let authority_key = Pubkey::new_unique();
            let from = create_token_account(mint, authority_key, 100, 0, false);
            let to = create_token_account(mint, Pubkey::new_unique(), 5, 0, false);
            let authority = create_account_info(authority_key, system_program::ID, 0, vec![], true);
            let token_program = create_program_account(spl_token::id());

            transfer_spl_tokens(from.clone(), to.clone(), authority, token_program, 40, None)
                .unwrap();

            assert_eq!(token_amount(&from), 60);
            assert_eq!(token_amount(&to), 45);
        });
    }

    #[test]
    fn wrap_sol_to_wsol_updates_native_amount() {
        with_syscall_stubs(|| {
            let source = create_system_account(1_000_000, true);
            let destination =
                create_token_account(native_mint::ID, Pubkey::new_unique(), 0, 0, true);
            let system_program = create_program_account(system_program::ID);
            let token_program = create_program_account(spl_token::id());

            wrap_sol_to_wsol(
                source.clone(),
                destination.clone(),
                system_program,
                token_program,
                250_000,
            )
            .unwrap();

            assert_eq!(source.lamports(), 750_000);
            assert_eq!(destination.lamports(), 250_000);
            assert_eq!(token_amount(&destination), 250_000);
        });
    }

    #[test]
    fn unwrap_wsol_to_sol_returns_lamports_to_destination() {
        with_syscall_stubs(|| {
            let authority_key = Pubkey::new_unique();
            let wsol_account =
                create_token_account(native_mint::ID, authority_key, 500_000, 500_000, true);
            let destination = create_system_account(100, false);
            let authority = create_account_info(authority_key, system_program::ID, 0, vec![], true);
            let token_program = create_program_account(spl_token::id());

            unwrap_wsol_to_sol(
                wsol_account.clone(),
                destination.clone(),
                authority,
                token_program,
                None,
            )
            .unwrap();

            assert_eq!(wsol_account.lamports(), 0);
            assert_eq!(destination.lamports(), 500_100);
        });
    }

    #[test]
    fn native_mint_detection_matches_spl_native_mint() {
        assert!(is_native_mint(&native_mint::ID));
        assert!(!is_native_mint(&Pubkey::new_unique()));
    }

    #[test]
    fn wrap_then_unwrap_round_trip_restores_sol_balance() {
        with_syscall_stubs(|| {
            let authority = create_system_account(900_000, true);
            let wsol_account = create_token_account(native_mint::ID, *authority.key, 0, 0, true);
            let system_program = create_program_account(system_program::ID);
            let token_program = create_program_account(spl_token::id());

            wrap_sol_to_wsol(
                authority.clone(),
                wsol_account.clone(),
                system_program,
                token_program.clone(),
                300_000,
            )
            .unwrap();
            assert_eq!(authority.lamports(), 600_000);
            assert_eq!(token_amount(&wsol_account), 300_000);

            // Use signer seeds path to cover PDA-signing branch.
            let bump = [255u8];
            let seed_set: &[&[u8]] = &[b"authority", &bump];
            let signer_seeds: &[&[&[u8]]] = &[seed_set];

            unwrap_wsol_to_sol(
                wsol_account.clone(),
                authority.clone(),
                authority.clone(),
                token_program,
                Some(signer_seeds),
            )
            .unwrap();

            assert_eq!(wsol_account.lamports(), 0);
            assert_eq!(authority.lamports(), 900_000);
        });
    }

    #[test]
    fn transfer_errors_on_insufficient_balance() {
        with_syscall_stubs(|| {
            let mint = Pubkey::new_unique();
            let authority_key = Pubkey::new_unique();
            let from = create_token_account(mint, authority_key, 9, 0, false);
            let to = create_token_account(mint, Pubkey::new_unique(), 0, 0, false);
            let authority = create_account_info(authority_key, system_program::ID, 0, vec![], true);
            let token_program = create_program_account(spl_token::id());

            let result = transfer_spl_tokens(from, to, authority, token_program, 10, None);
            assert!(result.is_err());
        });
    }

    #[test]
    fn transfer_errors_on_wrong_mint() {
        with_syscall_stubs(|| {
            let authority_key = Pubkey::new_unique();
            let from = create_token_account(Pubkey::new_unique(), authority_key, 10, 0, false);
            let to = create_token_account(Pubkey::new_unique(), Pubkey::new_unique(), 0, 0, false);
            let authority = create_account_info(authority_key, system_program::ID, 0, vec![], true);
            let token_program = create_program_account(spl_token::id());

            let result = transfer_spl_tokens(from, to, authority, token_program, 5, None);
            assert!(result.is_err());
        });
    }

    #[test]
    fn transfer_errors_on_wrong_authority() {
        with_syscall_stubs(|| {
            let mint = Pubkey::new_unique();
            let real_authority = Pubkey::new_unique();
            let from = create_token_account(mint, real_authority, 100, 0, false);
            let to = create_token_account(mint, Pubkey::new_unique(), 0, 0, false);
            let wrong_authority =
                create_account_info(Pubkey::new_unique(), system_program::ID, 0, vec![], true);
            let token_program = create_program_account(spl_token::id());

            let result = transfer_spl_tokens(from, to, wrong_authority, token_program, 10, None);
            assert!(result.is_err());
        });
    }

    #[test]
    fn wrap_errors_when_destination_is_not_native_mint() {
        with_syscall_stubs(|| {
            let source = create_system_account(1_000_000, true);
            let wrong_mint_account =
                create_token_account(Pubkey::new_unique(), Pubkey::new_unique(), 0, 0, false);
            let system_program = create_program_account(system_program::ID);
            let token_program = create_program_account(spl_token::id());

            let result = wrap_sol_to_wsol(
                source,
                wrong_mint_account,
                system_program,
                token_program,
                100_000,
            );
            assert!(result.is_err());
        });
    }

    #[test]
    fn unwrap_errors_on_wrong_authority() {
        with_syscall_stubs(|| {
            let owner_key = Pubkey::new_unique();
            let wsol_account = create_token_account(native_mint::ID, owner_key, 1, 1, true);
            let destination = create_system_account(0, false);
            let wrong_authority =
                create_account_info(Pubkey::new_unique(), system_program::ID, 0, vec![], true);
            let token_program = create_program_account(spl_token::id());

            let result = unwrap_wsol_to_sol(
                wsol_account,
                destination,
                wrong_authority,
                token_program,
                None,
            );
            assert!(result.is_err());
        });
    }
}
