use borsh::BorshDeserialize;
use fuzz_accounts::*;
use helpers::{
    associated_token_program_id, current_timestamp, ensure_pyth_price_feed, ensure_token_account,
    token_program_id,
};
use solana_sdk::account::ReadableAccount;
use solana_sdk::pubkey::Pubkey;
use std::convert::TryInto;
use trident_fuzz::fuzzing::*;
use types::{ContractStatus, DebtContractSnapshot, PoolDepositSnapshot, PoolStateSnapshot};
mod fuzz_accounts;
mod helpers;
mod instructions;
mod transactions;
mod types;
pub use transactions::*;

#[derive(FuzzTestMethods)]
struct FuzzTest {
    /// for fuzzing
    trident: Trident,
    /// for storing fuzzing accounts
    fuzz_accounts: FuzzAccounts,
}

#[flow_executor]
impl FuzzTest {
    fn reset_fuzz_accounts_preserving_globals(&mut self) {
        let mut next = FuzzAccounts::default();
        next.state = std::mem::take(&mut self.fuzz_accounts.state);
        next.treasury = std::mem::take(&mut self.fuzz_accounts.treasury);
        next.usdc_mint = std::mem::take(&mut self.fuzz_accounts.usdc_mint);
        next.bot_processor = std::mem::take(&mut self.fuzz_accounts.bot_processor);
        next.collateral_mint = std::mem::take(&mut self.fuzz_accounts.collateral_mint);
        self.fuzz_accounts = next;
    }

    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: FuzzAccounts::default(),
        }
    }

    fn execute_tx<T>(&mut self, transaction: &mut T, name: Option<&str>)
    where
        T: TransactionHooks
            + TransactionGetters
            + TransactionSetters
            + TransactionPrivateMethods
            + std::fmt::Debug,
    {
        self.trident.execute_transaction(transaction, name);
    }

    fn deserialize_account_required<T: BorshDeserialize>(
        &mut self,
        key: &Pubkey,
        discriminator_size: usize,
        label: &str,
    ) -> T {
        let account = self.trident.get_client().get_account(key);
        let data = account.data();
        assert!(
            data.len() > discriminator_size,
            "{label}: expected initialized account {key}, found data_len={} (discriminator_size={discriminator_size})",
            data.len()
        );

        let mut payload = &data[discriminator_size..];
        T::deserialize(&mut payload).unwrap_or_else(|err| {
            panic!(
                "{label}: failed to deserialize account {key} (owner={}, data_len={}): {err}",
                account.owner(),
                data.len()
            )
        })
    }

    fn require_contract_state(&mut self, label: &str) -> DebtContractSnapshot {
        let contract = self
            .fuzz_accounts
            .contract
            .get_or_create(0, &mut self.trident, None, None);
        self.deserialize_account_required::<DebtContractSnapshot>(&contract, 8, label)
    }

    fn require_pool_state(&mut self, label: &str) -> PoolStateSnapshot {
        let pool = self
            .fuzz_accounts
            .pool
            .get_or_create(0, &mut self.trident, None, None);
        self.deserialize_account_required::<PoolStateSnapshot>(&pool, 8, label)
    }

    fn require_pool_deposit_state(&mut self, label: &str) -> PoolDepositSnapshot {
        let pool_deposit =
            self.fuzz_accounts
                .pool_deposit
                .get_or_create(0, &mut self.trident, None, None);
        self.deserialize_account_required::<PoolDepositSnapshot>(&pool_deposit, 8, label)
    }

    fn get_token_amount_required(&mut self, key: &Pubkey, label: &str) -> u64 {
        let account = self.trident.get_client().get_account(key);
        let token_program = token_program_id();
        assert_eq!(
            account.owner(),
            &token_program,
            "{label}: expected token account {key} owned by token program"
        );
        let data = account.data();
        assert!(
            data.len() >= 72,
            "{label}: token account {key} has invalid size {}",
            data.len()
        );
        u64::from_le_bytes(
            data[64..72]
                .try_into()
                .expect("token amount slice must be exactly 8 bytes"),
        )
    }

    fn get_token_amount_or_zero_if_closed(&mut self, key: &Pubkey, label: &str) -> u64 {
        let account = self.trident.get_client().get_account(key);
        let token_program = token_program_id();
        if account.owner() != &token_program || account.data().len() < 72 {
            // Token accounts can be closed into system accounts on terminal flows.
            return 0;
        }
        let data = account.data();
        u64::from_le_bytes(
            data[64..72]
                .try_into()
                .unwrap_or_else(|_| panic!("{label}: token amount slice must be exactly 8 bytes")),
        )
    }

    fn read_token_total_required(
        &mut self,
        labeled_keys: &[(&str, Pubkey)],
        total_label: &str,
    ) -> u128 {
        let mut total: u128 = 0;
        for (account_label, key) in labeled_keys {
            let amount = self.get_token_amount_required(key, account_label) as u128;
            total = total
                .checked_add(amount)
                .unwrap_or_else(|| panic!("{total_label}: overflow while summing token balances"));
        }
        total
    }

    fn read_token_total_or_zero_if_closed(
        &mut self,
        labeled_keys: &[(&str, Pubkey)],
        total_label: &str,
    ) -> u128 {
        let mut total: u128 = 0;
        for (account_label, key) in labeled_keys {
            let amount = self.get_token_amount_or_zero_if_closed(key, account_label) as u128;
            total = total
                .checked_add(amount)
                .unwrap_or_else(|| panic!("{total_label}: overflow while summing token balances"));
        }
        total
    }

    fn get_lender_usdc_accounts_for_invariants(&mut self) -> Vec<Pubkey> {
        let token_program = token_program_id();
        let usdc_mint = self.fuzz_accounts.usdc_mint.get_or_create(
            0,
            &mut self.trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
        );

        let mut lender_usdc_accounts = Vec::with_capacity(3);
        for slot in 0..3u8 {
            let lender =
                self.fuzz_accounts
                    .lender
                    .get_or_create(slot, &mut self.trident, None, None);
            let lender_usdc_account = self.fuzz_accounts.lender_usdc_account.get_or_create(
                slot,
                &mut self.trident,
                None,
                Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
            );
            // Keep lender token accounts initialized so conservation invariants can cover
            // up to max_lenders slots without single-index assumptions.
            ensure_token_account(
                &mut self.trident,
                &lender_usdc_account,
                &usdc_mint,
                &lender,
                0,
            );
            lender_usdc_accounts.push(lender_usdc_account);
        }

        lender_usdc_accounts
    }

    fn get_pool_usdc_accounts_for_invariants(&mut self) -> (Pubkey, Pubkey, Pubkey) {
        let token_program = token_program_id();
        let associated_token_program = associated_token_program_id();
        let pool = self
            .fuzz_accounts
            .pool
            .get_or_create(0, &mut self.trident, None, None);
        let depositor =
            self.fuzz_accounts
                .depositor
                .get_or_create(0, &mut self.trident, None, None);
        let treasury = self
            .fuzz_accounts
            .treasury
            .get_or_create(0, &mut self.trident, None, None);
        let usdc_mint = self.fuzz_accounts.usdc_mint.get_or_create(
            0,
            &mut self.trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 82, token_program)),
        );
        let depositor_usdc_ata = self.fuzz_accounts.depositor_usdc_ata.get_or_create(
            0,
            &mut self.trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
        );
        let treasury_usdc_account = self.fuzz_accounts.treasury_usdc_account.get_or_create(
            0,
            &mut self.trident,
            None,
            Some(AccountMetadata::new(1_000_000_000, 165, token_program)),
        );
        let (pool_vault, _) = Pubkey::find_program_address(
            &[pool.as_ref(), token_program.as_ref(), usdc_mint.as_ref()],
            &associated_token_program,
        );
        ensure_token_account(&mut self.trident, &pool_vault, &usdc_mint, &pool, 0);
        ensure_token_account(
            &mut self.trident,
            &depositor_usdc_ata,
            &usdc_mint,
            &depositor,
            0,
        );
        ensure_token_account(
            &mut self.trident,
            &treasury_usdc_account,
            &usdc_mint,
            &treasury,
            0,
        );
        (depositor_usdc_ata, pool_vault, treasury_usdc_account)
    }

    fn assert_contract_accounting_invariants(&self, snapshot: &DebtContractSnapshot, label: &str) {
        assert!(
            snapshot.funded_amount <= snapshot.target_amount,
            "{label}: funded_amount must be <= target_amount"
        );
        assert!(
            (snapshot.outstanding_balance as u128)
                <= (snapshot.target_amount as u128)
                    .saturating_mul(3)
                    .checked_div(2)
                    .unwrap_or(u128::MAX),
            "{label}: outstanding_balance must be <= 1.5x target_amount (outstanding={}, funded={}, accrued={}, target={}, paid={}, status={:?})",
            snapshot.outstanding_balance,
            snapshot.funded_amount,
            snapshot.accrued_interest,
            snapshot.target_amount,
            snapshot.total_principal_paid,
            snapshot.status
        );
        assert!(
            snapshot.total_principal_paid <= snapshot.target_amount,
            "{label}: total_principal_paid must be <= target_amount (paid={}, target={}, funded={}, outstanding={}, status={:?})",
            snapshot.total_principal_paid,
            snapshot.target_amount,
            snapshot.funded_amount,
            snapshot.outstanding_balance,
            snapshot.status
        );
        let funded_amount = snapshot.funded_amount as u128;
        let accounted_principal =
            (snapshot.outstanding_balance as u128) + (snapshot.total_principal_paid as u128);
        if matches!(
            snapshot.status,
            ContractStatus::OpenNotFunded | ContractStatus::OpenPartiallyFunded
        ) {
            assert!(
                accounted_principal <= funded_amount,
                "{label}: open contract principal accounting exceeds funded_amount"
            );
        }

        if matches!(
            snapshot.status,
            ContractStatus::Active | ContractStatus::PendingRecall
        ) {
            assert!(
                snapshot.num_contributions > 0,
                "{label}: active contract must have at least one contribution"
            );
        }

        if matches!(
            snapshot.status,
            ContractStatus::Completed | ContractStatus::Liquidated
        ) {
            assert_eq!(
                snapshot.outstanding_balance, 0,
                "{label}: terminal contract status must have zero outstanding_balance"
            );
            assert_eq!(
                snapshot.accrued_interest, 0,
                "{label}: terminal contract status must have zero accrued_interest"
            );
        }
    }

    fn assert_recall_invariants(
        &self,
        before: &DebtContractSnapshot,
        after: &DebtContractSnapshot,
    ) {
        self.assert_contract_accounting_invariants(before, "recall.before");
        self.assert_contract_accounting_invariants(after, "recall.after");
        assert!(
            after.funded_amount <= before.funded_amount,
            "recall flows must not increase funded_amount"
        );
        assert!(
            after.outstanding_balance <= before.outstanding_balance,
            "recall flows must not increase outstanding_balance"
        );
        assert!(
            after.num_contributions <= before.num_contributions,
            "recall flows must not increase contribution count"
        );
    }

    fn assert_payment_invariants(
        &self,
        before: &DebtContractSnapshot,
        after: &DebtContractSnapshot,
    ) {
        self.assert_contract_accounting_invariants(before, "payment.before");
        self.assert_contract_accounting_invariants(after, "payment.after");
        assert_eq!(
            after.funded_amount, before.funded_amount,
            "funded_amount must remain unchanged through payment flows"
        );
        assert!(
            after.total_principal_paid >= before.total_principal_paid,
            "payment flows must not reduce total_principal_paid"
        );
        assert!(
            matches!(
                after.status,
                ContractStatus::Active | ContractStatus::PendingRecall | ContractStatus::Completed
            ),
            "plain payment flow produced unexpected contract status"
        );
    }

    fn assert_distribution_payment_invariants(
        &self,
        before: &DebtContractSnapshot,
        after: &DebtContractSnapshot,
    ) {
        self.assert_contract_accounting_invariants(before, "distribution.before");
        self.assert_contract_accounting_invariants(after, "distribution.after");
        assert_eq!(
            after.funded_amount, before.funded_amount,
            "funded_amount must remain unchanged through distribution flows"
        );
        assert!(
            after.total_principal_paid >= before.total_principal_paid,
            "distribution flows must not reduce total_principal_paid"
        );
        assert!(
            matches!(
                after.status,
                ContractStatus::Active
                    | ContractStatus::PendingRecall
                    | ContractStatus::Completed
                    | ContractStatus::Liquidated
            ),
            "distribution flow produced unexpected contract status"
        );
    }

    fn assert_liquidation_invariants(
        &self,
        before: &DebtContractSnapshot,
        after: &DebtContractSnapshot,
    ) {
        self.assert_contract_accounting_invariants(before, "liquidation.before");
        self.assert_contract_accounting_invariants(after, "liquidation.after");
        assert_eq!(
            after.funded_amount, before.funded_amount,
            "funded_amount must remain unchanged through liquidation flows"
        );
        assert!(
            after.outstanding_balance <= before.outstanding_balance,
            "liquidation flows must not increase outstanding_balance"
        );
        assert!(
            matches!(
                after.status,
                ContractStatus::Active
                    | ContractStatus::PendingRecall
                    | ContractStatus::Liquidated
                    | ContractStatus::Completed
            ),
            "liquidation flow produced unexpected contract status"
        );
    }

    fn assert_pool_invariants(&self, before: &PoolStateSnapshot, after: &PoolStateSnapshot) {
        assert_eq!(
            after.pool_seed, before.pool_seed,
            "pool seed should remain immutable"
        );
        assert_eq!(
            after.operator, before.operator,
            "pool operator should remain immutable"
        );
        assert!(
            after.current_total_deposits >= after.current_utilized,
            "pool invariant violated: total deposits must be >= utilized"
        );
    }

    fn assert_pool_deposit_invariants(
        &self,
        before: &PoolDepositSnapshot,
        after: &PoolDepositSnapshot,
    ) {
        assert_eq!(
            after.depositor, before.depositor,
            "pool_deposit.depositor should remain immutable"
        );
        assert_eq!(
            after.pool, before.pool,
            "pool_deposit.pool should remain immutable"
        );
    }

    fn assert_usdc_conservation(&self, before_total: u128, after_total: u128) {
        assert_eq!(
            after_total, before_total,
            "USDC conservation invariant failed"
        );
    }

    fn assert_collateral_conservation(&self, before_total: u128, after_total: u128) {
        assert_eq!(
            after_total, before_total,
            "collateral conservation invariant failed"
        );
    }

    fn seed_payment_scenario(&mut self) {
        self.reset_fuzz_accounts_preserving_globals();

        let mut initialize =
            InitializeTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut initialize, Some("seed_initialize"));

        let mut initialize_treasury =
            InitializeTreasuryTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut initialize_treasury, Some("seed_initialize_treasury"));

        let mut create_contract =
            CreateDebtContractTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut create_contract, Some("seed_create_debt_contract"));

        let mut contribute =
            ContributeToContractTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut contribute, Some("seed_contribute_to_contract"));
    }

    fn seed_recall_lifecycle(&mut self) {
        self.seed_liquidation_scenario();

        let mut request_recall =
            RequestRecallTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut request_recall, Some("seed_request_recall"));
    }

    fn seed_liquidation_scenario(&mut self) {
        self.reset_fuzz_accounts_preserving_globals();

        let mut initialize =
            InitializeTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut initialize, Some("seed_initialize"));

        let mut initialize_treasury =
            InitializeTreasuryTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut initialize_treasury, Some("seed_initialize_treasury"));

        // Marker to enable collateralized create-debt setup in instruction hooks.
        let _ =
            self.fuzz_accounts
                .price_feed_account
                .get_or_create(0, &mut self.trident, None, None);

        let mut create_contract =
            CreateDebtContractTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut create_contract, Some("seed_create_debt_contract"));

        let mut contribute =
            ContributeToContractTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut contribute, Some("seed_contribute_to_contract"));

        let mut add_collateral =
            AddCollateralTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut add_collateral, Some("seed_add_collateral"));
    }

    fn seed_pool_lifecycle(&mut self) {
        self.reset_fuzz_accounts_preserving_globals();

        let mut initialize =
            InitializeTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut initialize, Some("seed_initialize"));

        let mut initialize_treasury =
            InitializeTreasuryTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut initialize_treasury, Some("seed_initialize_treasury"));

        let mut authorize_pool_operator =
            AuthorizePoolOperatorTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(
            &mut authorize_pool_operator,
            Some("seed_authorize_pool_operator"),
        );

        let mut create_pool =
            CreatePoolTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut create_pool, Some("seed_create_pool"));

        let mut deposit_to_pool =
            DepositToPoolTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut deposit_to_pool, Some("seed_deposit_to_pool"));
    }

    fn seed_pool_with_contract(&mut self) {
        self.seed_pool_lifecycle();

        let mut create_contract =
            CreateDebtContractTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut create_contract, Some("seed_create_debt_contract"));
    }

    fn seed_treasury_token_withdrawal(&mut self) {
        self.reset_fuzz_accounts_preserving_globals();

        let mut initialize =
            InitializeTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut initialize, Some("seed_initialize"));

        let mut initialize_treasury =
            InitializeTreasuryTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut initialize_treasury, Some("seed_initialize_treasury"));
    }

    fn seed_open_contract_for_cancellation(&mut self, partially_fund: bool) {
        self.reset_fuzz_accounts_preserving_globals();

        let mut initialize =
            InitializeTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut initialize, Some("seed_initialize"));

        let mut initialize_treasury =
            InitializeTreasuryTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        self.execute_tx(&mut initialize_treasury, Some("seed_initialize_treasury"));

        let mut create_contract =
            CreateDebtContractTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        create_contract.instruction.data.collateral_amount = 0;
        create_contract.instruction.data.max_lenders = 2;
        self.execute_tx(&mut create_contract, Some("seed_create_debt_contract"));

        if partially_fund {
            let contract = self.require_contract_state("seed_cancel_partial.before_contribute");
            let mut contribute =
                ContributeToContractTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
            contribute.instruction.data.amount = std::cmp::max(1, contract.target_amount / 2);
            self.execute_tx(&mut contribute, Some("seed_cancel_partial_contribute"));
        }
    }

    fn seed_pool_recall_scenario(&mut self) {
        self.seed_pool_with_contract();

        // Top up pool liquidity so deployment can satisfy remaining contract principal.
        let mut top_up_pool_deposit =
            DepositToPoolTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        top_up_pool_deposit.instruction.data.amount = self.trident.gen_range(1_000_000..=5_000_000);
        self.execute_tx(
            &mut top_up_pool_deposit,
            Some("seed_pool_recall_top_up_deposit"),
        );

        let contract_before =
            self.require_contract_state("seed_pool_recall_scenario.before_contract");
        let remaining_to_fund = contract_before
            .target_amount
            .saturating_sub(contract_before.funded_amount);
        if remaining_to_fund > 0 {
            let mut deploy_to_contract =
                PoolDeployToContractTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
            deploy_to_contract.instruction.data.amount = remaining_to_fund;
            self.execute_tx(&mut deploy_to_contract, Some("seed_pool_recall_deploy"));
        }
    }

    #[init]
    fn start(&mut self) {
        // no-op
    }

    #[flow(weight = 12)]
    fn borrower_repay_before_grace(&mut self) {
        self.seed_recall_lifecycle();
        self.trident.get_client().forward_in_time(259_199);
        let before_contract =
            self.require_contract_state("borrower_repay_before_grace.before_contract");
        let mut repay =
            BorrowerRepayRecallTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        let borrower_usdc_ata =
            self.fuzz_accounts
                .borrower_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let contract_usdc_ata =
            self.fuzz_accounts
                .contract_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let escrow_usdc_ata =
            self.fuzz_accounts
                .escrow_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let lender_usdc_accounts = self.get_lender_usdc_accounts_for_invariants();
        let usdc_before_total = self.read_token_total_required(
            &[
                ("recall.before.borrower_usdc_ata", borrower_usdc_ata),
                ("recall.before.contract_usdc_ata", contract_usdc_ata),
                ("recall.before.escrow_usdc_ata", escrow_usdc_ata),
                ("recall.before.lender_usdc_ata_0", lender_usdc_accounts[0]),
                ("recall.before.lender_usdc_ata_1", lender_usdc_accounts[1]),
                ("recall.before.lender_usdc_ata_2", lender_usdc_accounts[2]),
            ],
            "borrower_repay_before_grace.usdc_before_total",
        );
        self.execute_tx(&mut repay, Some("borrower_repay_before_grace"));
        let after_contract =
            self.require_contract_state("borrower_repay_before_grace.after_contract");
        let usdc_after_total = self.read_token_total_required(
            &[
                ("recall.after.borrower_usdc_ata", borrower_usdc_ata),
                ("recall.after.contract_usdc_ata", contract_usdc_ata),
                ("recall.after.escrow_usdc_ata", escrow_usdc_ata),
                ("recall.after.lender_usdc_ata_0", lender_usdc_accounts[0]),
                ("recall.after.lender_usdc_ata_1", lender_usdc_accounts[1]),
                ("recall.after.lender_usdc_ata_2", lender_usdc_accounts[2]),
            ],
            "borrower_repay_before_grace.usdc_after_total",
        );

        self.assert_recall_invariants(&before_contract, &after_contract);
        self.assert_usdc_conservation(usdc_before_total, usdc_after_total);
    }

    #[flow(weight = 12)]
    fn process_recall_after_grace(&mut self) {
        self.seed_recall_lifecycle();
        self.trident.get_client().forward_in_time(259_200);
        let before_contract =
            self.require_contract_state("process_recall_after_grace.before_contract");
        let mut process =
            ProcessRecallTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        let bot_usdc_ata =
            self.fuzz_accounts
                .bot_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let contract_usdc_ata =
            self.fuzz_accounts
                .contract_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let escrow_usdc_ata =
            self.fuzz_accounts
                .escrow_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let treasury_usdc_ata =
            self.fuzz_accounts
                .treasury_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let lender_usdc_accounts = self.get_lender_usdc_accounts_for_invariants();
        let usdc_before_total = self.read_token_total_required(
            &[
                ("recall.before.bot_usdc_ata", bot_usdc_ata),
                ("recall.before.contract_usdc_ata", contract_usdc_ata),
                ("recall.before.escrow_usdc_ata", escrow_usdc_ata),
                ("recall.before.treasury_usdc_ata", treasury_usdc_ata),
                ("recall.before.lender_usdc_ata_0", lender_usdc_accounts[0]),
                ("recall.before.lender_usdc_ata_1", lender_usdc_accounts[1]),
                ("recall.before.lender_usdc_ata_2", lender_usdc_accounts[2]),
            ],
            "process_recall_after_grace.usdc_before_total",
        );
        self.execute_tx(&mut process, Some("process_recall_after_grace"));
        let after_contract =
            self.require_contract_state("process_recall_after_grace.after_contract");
        let usdc_after_total = self.read_token_total_required(
            &[
                ("recall.after.bot_usdc_ata", bot_usdc_ata),
                ("recall.after.contract_usdc_ata", contract_usdc_ata),
                ("recall.after.escrow_usdc_ata", escrow_usdc_ata),
                ("recall.after.treasury_usdc_ata", treasury_usdc_ata),
                ("recall.after.lender_usdc_ata_0", lender_usdc_accounts[0]),
                ("recall.after.lender_usdc_ata_1", lender_usdc_accounts[1]),
                ("recall.after.lender_usdc_ata_2", lender_usdc_accounts[2]),
            ],
            "process_recall_after_grace.usdc_after_total",
        );

        self.assert_recall_invariants(&before_contract, &after_contract);
        self.assert_usdc_conservation(usdc_before_total, usdc_after_total);
    }

    #[flow(weight = 6)]
    fn race_repay_vs_process(&mut self) {
        self.seed_recall_lifecycle();
        let grace_offset = self.trident.gen_range(259_199..=259_201);
        self.trident.get_client().forward_in_time(grace_offset);
        let before_contract = self.require_contract_state("race_repay_vs_process.before_contract");
        let mut repay =
            BorrowerRepayRecallTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        let mut process =
            ProcessRecallTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        let borrower_usdc_ata =
            self.fuzz_accounts
                .borrower_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let bot_usdc_ata =
            self.fuzz_accounts
                .bot_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let contract_usdc_ata =
            self.fuzz_accounts
                .contract_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let escrow_usdc_ata =
            self.fuzz_accounts
                .escrow_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let treasury_usdc_ata =
            self.fuzz_accounts
                .treasury_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let lender_usdc_accounts = self.get_lender_usdc_accounts_for_invariants();
        let usdc_before_total = self.read_token_total_required(
            &[
                ("recall.race.before.borrower_usdc_ata", borrower_usdc_ata),
                ("recall.race.before.bot_usdc_ata", bot_usdc_ata),
                ("recall.race.before.contract_usdc_ata", contract_usdc_ata),
                ("recall.race.before.escrow_usdc_ata", escrow_usdc_ata),
                ("recall.race.before.treasury_usdc_ata", treasury_usdc_ata),
                (
                    "recall.race.before.lender_usdc_ata_0",
                    lender_usdc_accounts[0],
                ),
                (
                    "recall.race.before.lender_usdc_ata_1",
                    lender_usdc_accounts[1],
                ),
                (
                    "recall.race.before.lender_usdc_ata_2",
                    lender_usdc_accounts[2],
                ),
            ],
            "race_repay_vs_process.usdc_before_total",
        );

        let repay_first = self.trident.gen_range(0..2) == 0;
        if repay_first {
            self.execute_tx(&mut repay, Some("race_repay_first"));

            self.execute_tx(&mut process, Some("race_process_second"));
        } else {
            self.execute_tx(&mut process, Some("race_process_first"));

            self.execute_tx(&mut repay, Some("race_repay_second"));
        }

        let after_contract = self.require_contract_state("race_repay_vs_process.after_contract");
        let usdc_after_total = self.read_token_total_required(
            &[
                ("recall.race.after.borrower_usdc_ata", borrower_usdc_ata),
                ("recall.race.after.bot_usdc_ata", bot_usdc_ata),
                ("recall.race.after.contract_usdc_ata", contract_usdc_ata),
                ("recall.race.after.escrow_usdc_ata", escrow_usdc_ata),
                ("recall.race.after.treasury_usdc_ata", treasury_usdc_ata),
                (
                    "recall.race.after.lender_usdc_ata_0",
                    lender_usdc_accounts[0],
                ),
                (
                    "recall.race.after.lender_usdc_ata_1",
                    lender_usdc_accounts[1],
                ),
                (
                    "recall.race.after.lender_usdc_ata_2",
                    lender_usdc_accounts[2],
                ),
            ],
            "race_repay_vs_process.usdc_after_total",
        );
        self.assert_recall_invariants(&before_contract, &after_contract);
        self.assert_usdc_conservation(usdc_before_total, usdc_after_total);
    }

    #[flow(weight = 12)]
    fn liquidation_undercollateralized(&mut self) {
        self.seed_liquidation_scenario();
        let time_delta = self
            .trident
            .gen_range((30_i64 * 24 * 60 * 60)..=(180_i64 * 24 * 60 * 60));
        self.trident.get_client().forward_in_time(time_delta);
        let price_feed_account =
            self.fuzz_accounts
                .price_feed_account
                .get_or_create(0, &mut self.trident, None, None);
        let publish_time = current_timestamp(&mut self.trident);
        ensure_pyth_price_feed(
            &mut self.trident,
            &price_feed_account,
            1_000_000,
            0,
            -8,
            publish_time,
        );

        let contract_before =
            self.require_contract_state("liquidation_undercollateralized.before_contract");
        let mut liquidate =
            LiquidateContractTransaction::build(&mut self.trident, &mut self.fuzz_accounts);

        let contract_collateral_ata = self.fuzz_accounts.contract_collateral_ata.get_or_create(
            0,
            &mut self.trident,
            None,
            None,
        );
        let bot_collateral_ata =
            self.fuzz_accounts
                .bot_collateral_ata
                .get_or_create(0, &mut self.trident, None, None);
        let borrower_collateral_ata = self.fuzz_accounts.borrower_collateral_ata.get_or_create(
            0,
            &mut self.trident,
            None,
            None,
        );
        let bot_usdc_ata =
            self.fuzz_accounts
                .bot_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let contract_usdc_ata =
            self.fuzz_accounts
                .contract_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let escrow_usdc_ata =
            self.fuzz_accounts
                .escrow_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let collateral_before_total = self.read_token_total_required(
            &[
                (
                    "liquidation.before.contract_collateral_ata",
                    contract_collateral_ata,
                ),
                ("liquidation.before.bot_collateral_ata", bot_collateral_ata),
                (
                    "liquidation.before.borrower_collateral_ata",
                    borrower_collateral_ata,
                ),
            ],
            "liquidation_undercollateralized.collateral_before_total",
        );
        let usdc_before_total = self.read_token_total_required(
            &[
                ("liquidation.before.bot_usdc_ata", bot_usdc_ata),
                ("liquidation.before.contract_usdc_ata", contract_usdc_ata),
                ("liquidation.before.escrow_usdc_ata", escrow_usdc_ata),
            ],
            "liquidation_undercollateralized.usdc_before_total",
        );

        self.execute_tx(&mut liquidate, Some("liquidation_undercollateralized"));

        let contract_after =
            self.require_contract_state("liquidation_undercollateralized.after_contract");
        let collateral_after_total = self.read_token_total_or_zero_if_closed(
            &[
                (
                    "liquidation.after.contract_collateral_ata",
                    contract_collateral_ata,
                ),
                ("liquidation.after.bot_collateral_ata", bot_collateral_ata),
                (
                    "liquidation.after.borrower_collateral_ata",
                    borrower_collateral_ata,
                ),
            ],
            "liquidation_undercollateralized.collateral_after_total",
        );
        let usdc_after_total = self.read_token_total_or_zero_if_closed(
            &[
                ("liquidation.after.bot_usdc_ata", bot_usdc_ata),
                ("liquidation.after.contract_usdc_ata", contract_usdc_ata),
                ("liquidation.after.escrow_usdc_ata", escrow_usdc_ata),
            ],
            "liquidation_undercollateralized.usdc_after_total",
        );

        self.assert_liquidation_invariants(&contract_before, &contract_after);
        self.assert_collateral_conservation(collateral_before_total, collateral_after_total);
        self.assert_usdc_conservation(usdc_before_total, usdc_after_total);
    }

    #[flow(weight = 8)]
    fn partial_liquidation_recovery(&mut self) {
        self.seed_liquidation_scenario();
        let time_delta = self
            .trident
            .gen_range((14_i64 * 24 * 60 * 60)..=(90_i64 * 24 * 60 * 60));
        self.trident.get_client().forward_in_time(time_delta);
        let price_feed_account =
            self.fuzz_accounts
                .price_feed_account
                .get_or_create(0, &mut self.trident, None, None);
        let publish_time = current_timestamp(&mut self.trident);
        ensure_pyth_price_feed(
            &mut self.trident,
            &price_feed_account,
            1_000_000,
            0,
            -8,
            publish_time,
        );

        let contract_before =
            self.require_contract_state("partial_liquidation_recovery.before_contract");
        let mut partial =
            PartialLiquidateTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        let bot_usdc_ata =
            self.fuzz_accounts
                .bot_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let contract_usdc_ata =
            self.fuzz_accounts
                .contract_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let escrow_usdc_ata =
            self.fuzz_accounts
                .escrow_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let contract_collateral_ata = self.fuzz_accounts.contract_collateral_ata.get_or_create(
            0,
            &mut self.trident,
            None,
            None,
        );
        let bot_collateral_ata =
            self.fuzz_accounts
                .bot_collateral_ata
                .get_or_create(0, &mut self.trident, None, None);
        let borrower_collateral_ata = self.fuzz_accounts.borrower_collateral_ata.get_or_create(
            0,
            &mut self.trident,
            None,
            None,
        );
        let usdc_before_total = self.read_token_total_required(
            &[
                ("partial_liquidation.before.bot_usdc_ata", bot_usdc_ata),
                (
                    "partial_liquidation.before.contract_usdc_ata",
                    contract_usdc_ata,
                ),
                (
                    "partial_liquidation.before.escrow_usdc_ata",
                    escrow_usdc_ata,
                ),
            ],
            "partial_liquidation_recovery.usdc_before_total",
        );
        let collateral_before_total = self.read_token_total_required(
            &[
                (
                    "partial_liquidation.before.contract_collateral_ata",
                    contract_collateral_ata,
                ),
                (
                    "partial_liquidation.before.bot_collateral_ata",
                    bot_collateral_ata,
                ),
                (
                    "partial_liquidation.before.borrower_collateral_ata",
                    borrower_collateral_ata,
                ),
            ],
            "partial_liquidation_recovery.collateral_before_total",
        );

        // operations_fund reimbursements are lamport movements, not SPL-token transfers.
        self.execute_tx(&mut partial, Some("partial_liquidation_recovery"));
        let contract_after =
            self.require_contract_state("partial_liquidation_recovery.after_contract");
        let usdc_after_total = self.read_token_total_required(
            &[
                ("partial_liquidation.after.bot_usdc_ata", bot_usdc_ata),
                (
                    "partial_liquidation.after.contract_usdc_ata",
                    contract_usdc_ata,
                ),
                ("partial_liquidation.after.escrow_usdc_ata", escrow_usdc_ata),
            ],
            "partial_liquidation_recovery.usdc_after_total",
        );
        let contract_collateral_after = self.get_token_amount_or_zero_if_closed(
            &contract_collateral_ata,
            "partial_liquidation.after.contract_collateral_ata",
        ) as u128;
        let bot_collateral_after = self.get_token_amount_required(
            &bot_collateral_ata,
            "partial_liquidation.after.bot_collateral_ata",
        ) as u128;
        let borrower_collateral_after = self.get_token_amount_required(
            &borrower_collateral_ata,
            "partial_liquidation.after.borrower_collateral_ata",
        ) as u128;
        let collateral_after_total = contract_collateral_after
            .checked_add(bot_collateral_after)
            .and_then(|value| value.checked_add(borrower_collateral_after))
            .unwrap_or_else(|| {
                panic!("partial_liquidation_recovery.collateral_after_total: overflow while summing token balances")
            });

        self.assert_liquidation_invariants(&contract_before, &contract_after);
        self.assert_usdc_conservation(usdc_before_total, usdc_after_total);
        self.assert_collateral_conservation(collateral_before_total, collateral_after_total);
    }

    #[flow(weight = 8)]
    fn pool_deposit_withdraw_cycle(&mut self) {
        self.seed_pool_lifecycle();
        let time_delta = self
            .trident
            .gen_range((24_i64 * 60 * 60)..=(90_i64 * 24 * 60 * 60));
        self.trident.get_client().forward_in_time(time_delta);

        let pool_before = self.require_pool_state("pool_deposit_withdraw_cycle.before_pool");
        let deposit_before =
            self.require_pool_deposit_state("pool_deposit_withdraw_cycle.before_pool_deposit");
        let (depositor_usdc_ata, pool_vault, treasury_usdc_account) =
            self.get_pool_usdc_accounts_for_invariants();
        let usdc_before_total = self.read_token_total_required(
            &[
                ("pool_cycle.before.depositor_usdc_ata", depositor_usdc_ata),
                ("pool_cycle.before.pool_vault", pool_vault),
                (
                    "pool_cycle.before.treasury_usdc_account",
                    treasury_usdc_account,
                ),
            ],
            "pool_deposit_withdraw_cycle.usdc_before_total",
        );

        let withdraw_direct = self.trident.gen_range(0..2) == 0;
        if withdraw_direct {
            let mut withdraw =
                WithdrawFromPoolTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
            self.execute_tx(&mut withdraw, Some("pool_withdraw_direct"));
        } else {
            let mut request =
                RequestPoolWithdrawalTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
            self.execute_tx(&mut request, Some("pool_withdraw_request"));

            let mut process =
                ProcessPoolWithdrawalTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
            self.execute_tx(&mut process, Some("pool_withdraw_process"));
        }

        let pool_after = self.require_pool_state("pool_deposit_withdraw_cycle.after_pool");
        let deposit_after =
            self.require_pool_deposit_state("pool_deposit_withdraw_cycle.after_pool_deposit");
        let usdc_after_total = self.read_token_total_required(
            &[
                ("pool_cycle.after.depositor_usdc_ata", depositor_usdc_ata),
                ("pool_cycle.after.pool_vault", pool_vault),
                (
                    "pool_cycle.after.treasury_usdc_account",
                    treasury_usdc_account,
                ),
            ],
            "pool_deposit_withdraw_cycle.usdc_after_total",
        );

        self.assert_pool_invariants(&pool_before, &pool_after);
        self.assert_pool_deposit_invariants(&deposit_before, &deposit_after);
        self.assert_usdc_conservation(usdc_before_total, usdc_after_total);
        assert!(
            deposit_after.deposit_amount <= deposit_before.deposit_amount,
            "pool withdraw cycle must not increase depositor principal"
        );
        assert!(
            pool_after.current_total_deposits <= pool_before.current_total_deposits,
            "pool withdraw cycle must not increase total deposits"
        );
    }

    #[flow(weight = 8)]
    fn pool_deploy_and_yield(&mut self) {
        self.seed_pool_with_contract();
        let time_delta = self
            .trident
            .gen_range((7_i64 * 24 * 60 * 60)..=(180_i64 * 24 * 60 * 60));
        self.trident.get_client().forward_in_time(time_delta);

        let pool_before = self.require_pool_state("pool_deploy_and_yield.before_pool");
        let deposit_before =
            self.require_pool_deposit_state("pool_deploy_and_yield.before_pool_deposit");
        let (depositor_usdc_ata, pool_vault, treasury_usdc_account) =
            self.get_pool_usdc_accounts_for_invariants();
        // frontend/operator fee ATA is wired to a program-id sentinel in this fuzz harness,
        // so only SPL-token accounts are included in conservation totals.
        let usdc_before_total = self.read_token_total_required(
            &[
                ("pool_yield.before.depositor_usdc_ata", depositor_usdc_ata),
                ("pool_yield.before.pool_vault", pool_vault),
                (
                    "pool_yield.before.treasury_usdc_account",
                    treasury_usdc_account,
                ),
            ],
            "pool_deploy_and_yield.usdc_before_total",
        );

        let claim_yield = self.trident.gen_range(0..2) == 0;
        if claim_yield {
            let mut claim =
                ClaimPoolYieldTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
            self.execute_tx(&mut claim, Some("pool_claim_yield"));
        } else {
            let mut compound =
                CompoundPoolYieldTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
            self.execute_tx(&mut compound, Some("pool_compound_yield"));
        }

        let pool_after = self.require_pool_state("pool_deploy_and_yield.after_pool");
        let deposit_after =
            self.require_pool_deposit_state("pool_deploy_and_yield.after_pool_deposit");
        let usdc_after_total = self.read_token_total_required(
            &[
                ("pool_yield.after.depositor_usdc_ata", depositor_usdc_ata),
                ("pool_yield.after.pool_vault", pool_vault),
                (
                    "pool_yield.after.treasury_usdc_account",
                    treasury_usdc_account,
                ),
            ],
            "pool_deploy_and_yield.usdc_after_total",
        );

        self.assert_pool_invariants(&pool_before, &pool_after);
        self.assert_pool_deposit_invariants(&deposit_before, &deposit_after);
        self.assert_usdc_conservation(usdc_before_total, usdc_after_total);
        if claim_yield {
            assert_eq!(
                deposit_after.deposit_amount, deposit_before.deposit_amount,
                "claiming pool yield must not change depositor principal"
            );
            assert_eq!(
                pool_after.current_total_deposits, pool_before.current_total_deposits,
                "claiming pool yield must not change pool total deposits"
            );
        } else {
            assert!(
                deposit_after.deposit_amount >= deposit_before.deposit_amount,
                "compounding pool yield must not decrease depositor principal"
            );
            assert!(
                pool_after.current_total_deposits >= pool_before.current_total_deposits,
                "compounding pool yield must not decrease pool total deposits"
            );
        }
    }

    #[flow(weight = 8)]
    fn borrower_payment_cycle(&mut self) {
        self.seed_payment_scenario();
        let time_delta = self
            .trident
            .gen_range((24_i64 * 60 * 60)..=(30_i64 * 24 * 60 * 60));
        self.trident.get_client().forward_in_time(time_delta);

        let contract_before = self.require_contract_state("borrower_payment_cycle.before_contract");
        let borrower_usdc_ata =
            self.fuzz_accounts
                .borrower_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let contract_usdc_ata =
            self.fuzz_accounts
                .contract_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);

        // operations_fund reimbursements/refunds are lamport movements, not SPL-token transfers.
        let with_distribution = self.trident.gen_range(0..2) == 0;
        if with_distribution {
            let mut make_payment_with_distribution = MakePaymentWithDistributionTransaction::build(
                &mut self.trident,
                &mut self.fuzz_accounts,
            );
            let escrow_usdc_ata =
                self.fuzz_accounts
                    .escrow_usdc_ata
                    .get_or_create(0, &mut self.trident, None, None);
            let lender_usdc_accounts = self.get_lender_usdc_accounts_for_invariants();
            let usdc_before_total = self.read_token_total_required(
                &[
                    (
                        "payment.distribution.before.borrower_usdc_ata",
                        borrower_usdc_ata,
                    ),
                    (
                        "payment.distribution.before.contract_usdc_ata",
                        contract_usdc_ata,
                    ),
                    (
                        "payment.distribution.before.escrow_usdc_ata",
                        escrow_usdc_ata,
                    ),
                    (
                        "payment.distribution.before.lender_usdc_ata_0",
                        lender_usdc_accounts[0],
                    ),
                    (
                        "payment.distribution.before.lender_usdc_ata_1",
                        lender_usdc_accounts[1],
                    ),
                    (
                        "payment.distribution.before.lender_usdc_ata_2",
                        lender_usdc_accounts[2],
                    ),
                ],
                "borrower_payment_cycle.distribution_usdc_before_total",
            );
            self.execute_tx(
                &mut make_payment_with_distribution,
                Some("borrower_payment_with_distribution_cycle"),
            );

            let contract_after =
                self.require_contract_state("borrower_payment_cycle.after_contract");
            let usdc_after_total = self.read_token_total_required(
                &[
                    (
                        "payment.distribution.after.borrower_usdc_ata",
                        borrower_usdc_ata,
                    ),
                    (
                        "payment.distribution.after.contract_usdc_ata",
                        contract_usdc_ata,
                    ),
                    (
                        "payment.distribution.after.escrow_usdc_ata",
                        escrow_usdc_ata,
                    ),
                    (
                        "payment.distribution.after.lender_usdc_ata_0",
                        lender_usdc_accounts[0],
                    ),
                    (
                        "payment.distribution.after.lender_usdc_ata_1",
                        lender_usdc_accounts[1],
                    ),
                    (
                        "payment.distribution.after.lender_usdc_ata_2",
                        lender_usdc_accounts[2],
                    ),
                ],
                "borrower_payment_cycle.distribution_usdc_after_total",
            );

            self.assert_distribution_payment_invariants(&contract_before, &contract_after);
            self.assert_usdc_conservation(usdc_before_total, usdc_after_total);
        } else {
            let usdc_before_total = self.read_token_total_required(
                &[
                    ("payment.before.borrower_usdc_ata", borrower_usdc_ata),
                    ("payment.before.contract_usdc_ata", contract_usdc_ata),
                ],
                "borrower_payment_cycle.usdc_before_total",
            );
            let mut make_payment =
                MakePaymentTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
            self.execute_tx(&mut make_payment, Some("borrower_payment_cycle"));
            let contract_after =
                self.require_contract_state("borrower_payment_cycle.after_contract");
            let usdc_after_total = self.read_token_total_required(
                &[
                    ("payment.after.borrower_usdc_ata", borrower_usdc_ata),
                    ("payment.after.contract_usdc_ata", contract_usdc_ata),
                ],
                "borrower_payment_cycle.usdc_after_total",
            );
            self.assert_payment_invariants(&contract_before, &contract_after);
            self.assert_usdc_conservation(usdc_before_total, usdc_after_total);
        }
    }

    #[flow(weight = 8)]
    fn automated_distribution(&mut self) {
        self.seed_liquidation_scenario();
        let time_delta = self
            .trident
            .gen_range((24_i64 * 60 * 60)..=(14_i64 * 24 * 60 * 60));
        self.trident.get_client().forward_in_time(time_delta);

        let contract_before = self.require_contract_state("automated_distribution.before_contract");
        let interest_transfer = self.trident.gen_range(0..2) == 0;
        let mut automated_interest =
            AutomatedInterestTransferTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        let mut automated_principal = AutomatedPrincipalTransferTransaction::build(
            &mut self.trident,
            &mut self.fuzz_accounts,
        );
        let contract_usdc_ata =
            self.fuzz_accounts
                .contract_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let bot_usdc_ata =
            self.fuzz_accounts
                .bot_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let lender_usdc_accounts = self.get_lender_usdc_accounts_for_invariants();
        let contract_collateral_ata = self.fuzz_accounts.contract_collateral_ata.get_or_create(
            0,
            &mut self.trident,
            None,
            None,
        );
        let bot_collateral_ata =
            self.fuzz_accounts
                .bot_collateral_ata
                .get_or_create(0, &mut self.trident, None, None);
        let usdc_before_total = self.read_token_total_required(
            &[
                ("distribution.before.contract_usdc_ata", contract_usdc_ata),
                ("distribution.before.bot_usdc_ata", bot_usdc_ata),
                (
                    "distribution.before.lender_usdc_ata_0",
                    lender_usdc_accounts[0],
                ),
                (
                    "distribution.before.lender_usdc_ata_1",
                    lender_usdc_accounts[1],
                ),
                (
                    "distribution.before.lender_usdc_ata_2",
                    lender_usdc_accounts[2],
                ),
            ],
            "automated_distribution.usdc_before_total",
        );
        let collateral_before_total = self.read_token_total_required(
            &[
                (
                    "distribution.before.contract_collateral_ata",
                    contract_collateral_ata,
                ),
                ("distribution.before.bot_collateral_ata", bot_collateral_ata),
            ],
            "automated_distribution.collateral_before_total",
        );

        if interest_transfer {
            self.execute_tx(&mut automated_interest, Some("automated_interest_transfer"));
        } else {
            self.execute_tx(
                &mut automated_principal,
                Some("automated_principal_transfer"),
            );
        }

        let contract_after = self.require_contract_state("automated_distribution.after_contract");
        let usdc_after_total = self.read_token_total_required(
            &[
                ("distribution.after.contract_usdc_ata", contract_usdc_ata),
                ("distribution.after.bot_usdc_ata", bot_usdc_ata),
                (
                    "distribution.after.lender_usdc_ata_0",
                    lender_usdc_accounts[0],
                ),
                (
                    "distribution.after.lender_usdc_ata_1",
                    lender_usdc_accounts[1],
                ),
                (
                    "distribution.after.lender_usdc_ata_2",
                    lender_usdc_accounts[2],
                ),
            ],
            "automated_distribution.usdc_after_total",
        );
        let collateral_after_total = self.read_token_total_required(
            &[
                (
                    "distribution.after.contract_collateral_ata",
                    contract_collateral_ata,
                ),
                ("distribution.after.bot_collateral_ata", bot_collateral_ata),
            ],
            "automated_distribution.collateral_after_total",
        );

        // operations_fund reimbursements are lamport movements, not SPL-token transfers.
        self.assert_distribution_payment_invariants(&contract_before, &contract_after);
        self.assert_usdc_conservation(usdc_before_total, usdc_after_total);
        self.assert_collateral_conservation(collateral_before_total, collateral_after_total);
    }

    #[flow(weight = 6)]
    fn cancel_open_contract(&mut self) {
        let partially_fund = self.trident.gen_range(0..2) == 0;
        self.seed_open_contract_for_cancellation(partially_fund);
        let before_contract = self.require_contract_state("cancel_open_contract.before_contract");
        let mut cancel =
            CancelContractTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        let borrower_usdc_ata =
            self.fuzz_accounts
                .borrower_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let contract_usdc_ata =
            self.fuzz_accounts
                .contract_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let mut usdc_before_accounts = vec![
            (
                "cancel_open_contract.before.borrower_usdc_ata",
                borrower_usdc_ata,
            ),
            (
                "cancel_open_contract.before.contract_usdc_ata",
                contract_usdc_ata,
            ),
        ];
        let mut usdc_after_accounts = vec![
            (
                "cancel_open_contract.after.borrower_usdc_ata",
                borrower_usdc_ata,
            ),
            (
                "cancel_open_contract.after.contract_usdc_ata",
                contract_usdc_ata,
            ),
        ];
        if partially_fund {
            let lender_usdc_account = self.fuzz_accounts.lender_usdc_account.get_or_create(
                0,
                &mut self.trident,
                None,
                None,
            );
            usdc_before_accounts.push((
                "cancel_open_contract.before.lender_usdc_account",
                lender_usdc_account,
            ));
            usdc_after_accounts.push((
                "cancel_open_contract.after.lender_usdc_account",
                lender_usdc_account,
            ));
        }
        let usdc_before_total = self.read_token_total_required(
            &usdc_before_accounts,
            "cancel_open_contract.usdc_before_total",
        );

        self.execute_tx(&mut cancel, Some("cancel_open_contract"));
        let after_contract = self.require_contract_state("cancel_open_contract.after_contract");
        let usdc_after_total = self.read_token_total_required(
            &usdc_after_accounts,
            "cancel_open_contract.usdc_after_total",
        );

        self.assert_contract_accounting_invariants(&before_contract, "cancel_open_contract.before");
        self.assert_contract_accounting_invariants(&after_contract, "cancel_open_contract.after");
        assert_eq!(
            after_contract.funded_amount, before_contract.funded_amount,
            "cancel contract must not change funded principal"
        );
        assert_eq!(
            after_contract.outstanding_balance, before_contract.outstanding_balance,
            "cancel contract must not change outstanding balance"
        );
        if partially_fund {
            assert!(
                before_contract.funded_amount > 0,
                "partial cancel seed must create funded principal"
            );
        }
        assert_eq!(
            after_contract.status,
            ContractStatus::Cancelled,
            "cancel contract must transition to Cancelled"
        );
        self.assert_usdc_conservation(usdc_before_total, usdc_after_total);
    }

    #[flow(weight = 6)]
    fn treasury_token_withdrawal(&mut self) {
        self.seed_treasury_token_withdrawal();
        let mut withdraw =
            WithdrawFromTreasuryTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        let treasury_usdc_account = self.fuzz_accounts.treasury_usdc_account.get_or_create(
            0,
            &mut self.trident,
            None,
            None,
        );
        let recipient_usdc_account =
            self.fuzz_accounts
                .borrower_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let treasury_before = self.get_token_amount_required(
            &treasury_usdc_account,
            "treasury_token_withdrawal.before.treasury_usdc_account",
        ) as u128;
        let recipient_before = self.get_token_amount_required(
            &recipient_usdc_account,
            "treasury_token_withdrawal.before.recipient_usdc_account",
        ) as u128;
        let usdc_before_total = treasury_before
            .checked_add(recipient_before)
            .unwrap_or_else(|| panic!("treasury_token_withdrawal.usdc_before_total overflow"));

        self.execute_tx(&mut withdraw, Some("treasury_token_withdrawal"));

        let treasury_after = self.get_token_amount_required(
            &treasury_usdc_account,
            "treasury_token_withdrawal.after.treasury_usdc_account",
        ) as u128;
        let recipient_after = self.get_token_amount_required(
            &recipient_usdc_account,
            "treasury_token_withdrawal.after.recipient_usdc_account",
        ) as u128;
        let usdc_after_total = treasury_after
            .checked_add(recipient_after)
            .unwrap_or_else(|| panic!("treasury_token_withdrawal.usdc_after_total overflow"));

        self.assert_usdc_conservation(usdc_before_total, usdc_after_total);
        assert!(
            treasury_after <= treasury_before,
            "treasury token withdrawal must not increase treasury token balance"
        );
        assert!(
            recipient_after >= recipient_before,
            "treasury token withdrawal must not decrease recipient token balance"
        );
    }

    #[flow(weight = 6)]
    fn pool_operator_request_recall(&mut self) {
        self.seed_pool_recall_scenario();
        let before_contract =
            self.require_contract_state("pool_operator_request_recall.before_contract");
        let mut request_recall =
            PoolRequestRecallTransaction::build(&mut self.trident, &mut self.fuzz_accounts);
        let token_program = token_program_id();
        let associated_token_program = associated_token_program_id();
        let pool = self
            .fuzz_accounts
            .pool
            .get_or_create(0, &mut self.trident, None, None);
        let usdc_mint =
            self.fuzz_accounts
                .usdc_mint
                .get_or_create(0, &mut self.trident, None, None);
        let (pool_vault, _) = Pubkey::find_program_address(
            &[pool.as_ref(), token_program.as_ref(), usdc_mint.as_ref()],
            &associated_token_program,
        );
        let contract_usdc_ata =
            self.fuzz_accounts
                .contract_usdc_ata
                .get_or_create(0, &mut self.trident, None, None);
        let usdc_before_total = self.read_token_total_required(
            &[
                ("pool_operator_request_recall.before.pool_vault", pool_vault),
                (
                    "pool_operator_request_recall.before.contract_usdc_ata",
                    contract_usdc_ata,
                ),
            ],
            "pool_operator_request_recall.usdc_before_total",
        );

        self.execute_tx(&mut request_recall, Some("pool_operator_request_recall"));

        let after_contract =
            self.require_contract_state("pool_operator_request_recall.after_contract");
        let usdc_after_total = self.read_token_total_required(
            &[
                ("pool_operator_request_recall.after.pool_vault", pool_vault),
                (
                    "pool_operator_request_recall.after.contract_usdc_ata",
                    contract_usdc_ata,
                ),
            ],
            "pool_operator_request_recall.usdc_after_total",
        );
        self.assert_recall_invariants(&before_contract, &after_contract);
        self.assert_usdc_conservation(usdc_before_total, usdc_after_total);
        assert_eq!(
            after_contract.funded_amount, before_contract.funded_amount,
            "pool recall request must not change funded amount"
        );
        assert_eq!(
            after_contract.outstanding_balance, before_contract.outstanding_balance,
            "pool recall request must not change outstanding balance"
        );
        if matches!(before_contract.status, ContractStatus::Active) {
            assert!(
                matches!(
                    after_contract.status,
                    ContractStatus::PendingRecall | ContractStatus::Active
                ),
                "active contract should remain active or transition to pending recall"
            );
        }
    }

    #[end]
    fn end(&mut self) {
        // no-op
    }
}

fn main() {
    FuzzTest::fuzz(1000, 100);
}
