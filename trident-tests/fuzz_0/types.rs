use borsh::{BorshDeserialize, BorshSerialize};

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum ContractStatus {
    #[default]
    OpenNotFunded,

    OpenPartiallyFunded,

    Active,

    PendingRecall,

    Completed,

    Cancelled,

    Liquidated,
}

// Instruction fixtures serialize these enum values even when current invariant
// snapshots do not inspect them directly; keep them aligned with program state.
#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum DistributionMethod {
    #[default]
    Manual,

    Automatic,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum FundingAccessMode {
    #[default]
    Public,

    AllowlistOnly,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum InterestPaymentType {
    #[default]
    OutstandingBalance,

    CollateralTransfer,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum LoanType {
    #[default]
    Demand,

    Committed,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum PaymentFrequency {
    #[default]
    Daily,

    Weekly,

    BiWeekly,

    Monthly,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum PrincipalPaymentType {
    #[default]
    CollateralDeduction,

    NoFixedPayment,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct DebtContractSnapshot {
    // Keep this prefix aligned with programs/stendar/src/state/mod.rs::DebtContract.
    // We deserialize only the stable fields needed for invariants in the fuzz harness.
    pub borrower: [u8; 32],
    pub contract_seed: u64,
    pub target_amount: u64,
    pub funded_amount: u64,
    pub interest_rate: u32,
    pub term_days: u32,
    pub collateral_amount: u64,
    pub loan_type: LoanType,
    pub ltv_ratio: u32,
    pub interest_payment_type: InterestPaymentType,
    pub principal_payment_type: PrincipalPaymentType,
    pub interest_frequency: PaymentFrequency,
    pub principal_frequency: Option<PaymentFrequency>,
    pub created_at: i64,
    pub status: ContractStatus,
    pub num_contributions: u32,
    pub outstanding_balance: u64,
    pub accrued_interest: u64,
    pub last_interest_update: i64,
    pub last_principal_payment: i64,
    pub total_principal_paid: u64,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct PoolStateSnapshot {
    pub operator: [u8; 32],
    pub pool_seed: u64,
    pub name: [u8; 32],
    pub rate_bps: u32,
    pub capacity: u64,
    pub current_total_deposits: u64,
    pub current_utilized: u64,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone, Default)]
pub struct PoolDepositSnapshot {
    pub depositor: [u8; 32],
    pub pool: [u8; 32],
    pub deposit_amount: u64,
}
