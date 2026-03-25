use anchor_lang::prelude::*;

use super::DebtContract;

/// Contract status tracking the lifecycle of a debt contract
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ContractStatus {
    OpenNotFunded,       // Just created, no funding received
    OpenPartiallyFunded, // Some funding received, still accepting more
    Active,              // Fully funded, loan is active and accruing interest
    PendingRecall,       // Demand recall requested; grace period in progress
    Completed,           // Fully repaid
    Cancelled,           // Cancelled before full funding
    Liquidated,          // Defaulted and liquidated
}

impl ContractStatus {
    /// Check if contract is in an open state (accepting funding)
    pub fn is_open(&self) -> bool {
        matches!(
            self,
            ContractStatus::OpenNotFunded | ContractStatus::OpenPartiallyFunded
        )
    }

    /// Check if contract is active and generating interest
    pub fn is_active(&self) -> bool {
        matches!(self, ContractStatus::Active | ContractStatus::PendingRecall)
    }

    /// Check if contract is in a terminal state (no more changes expected)
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            ContractStatus::Completed | ContractStatus::Cancelled | ContractStatus::Liquidated
        )
    }

    /// Get the next valid state transition options
    pub fn valid_transitions(&self) -> Vec<ContractStatus> {
        match self {
            ContractStatus::OpenNotFunded => vec![
                ContractStatus::OpenPartiallyFunded,
                ContractStatus::Active,
                ContractStatus::Cancelled,
            ],
            ContractStatus::OpenPartiallyFunded => {
                vec![ContractStatus::Active, ContractStatus::Cancelled]
            }
            ContractStatus::Active => vec![
                ContractStatus::PendingRecall,
                ContractStatus::Completed,
                ContractStatus::Liquidated,
            ],
            ContractStatus::PendingRecall => vec![
                ContractStatus::Active,
                ContractStatus::Completed,
                ContractStatus::Liquidated,
            ],
            _ => vec![], // Terminal states have no transitions
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub enum ContractVersion {
    Unsupported,
    Standard,
}

/// Loan type enumeration
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum LoanType {
    Demand,
    Committed,
}

/// Payment frequency for interest and principal payments
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PaymentFrequency {
    Daily,    // Every 24 hours
    Weekly,   // Every 168 hours (7 days)
    BiWeekly, // Every 336 hours (14 days)
    Monthly,  // Every 720 hours (30 days)
}

/// How lender distributions are handled for a contract
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DistributionMethod {
    /// Borrower distributes into lender escrows; lenders claim manually
    Manual,
    /// Bot distributes directly to lender wallets on schedule
    Automatic,
}

/// Controls who is allowed to fund a contract while it is open.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum FundingAccessMode {
    /// Any lender can contribute while the contract is open.
    Public,
    /// Only borrower-approved lender wallets can contribute.
    AllowlistOnly,
}

impl FundingAccessMode {
    pub fn from_reserved_byte(value: u8) -> Self {
        match value {
            1 => FundingAccessMode::AllowlistOnly,
            _ => FundingAccessMode::Public,
        }
    }

    pub fn to_reserved_byte(self) -> u8 {
        match self {
            FundingAccessMode::Public => 0,
            FundingAccessMode::AllowlistOnly => 1,
        }
    }
}

impl PaymentFrequency {
    /// Convert frequency to seconds
    pub fn to_seconds(&self) -> i64 {
        match self {
            PaymentFrequency::Daily => 24 * 60 * 60,
            PaymentFrequency::Weekly => 7 * 24 * 60 * 60,
            PaymentFrequency::BiWeekly => 14 * 24 * 60 * 60,
            PaymentFrequency::Monthly => 30 * 24 * 60 * 60,
        }
    }

    /// Check if this frequency matches the contract's interest frequency
    pub fn matches_interest_frequency(&self, contract: &DebtContract) -> bool {
        contract.interest_frequency == *self
    }

    /// Check if this frequency matches the contract's principal frequency
    pub fn matches_principal_frequency(&self, contract: &DebtContract) -> bool {
        if let Some(principal_freq) = contract.principal_frequency {
            principal_freq == *self
        } else {
            false
        }
    }
}

/// Interest payment type enumeration
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum InterestPaymentType {
    OutstandingBalance,
    CollateralTransfer,
}

/// Principal payment type enumeration
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PrincipalPaymentType {
    CollateralDeduction,
    NoFixedPayment,
}

/// Proposal status for loan term amendments.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProposalStatus {
    Pending,
    Approved,
    Rejected,
    Expired,
    Cancelled,
}

/// Vote choice for term amendment proposals.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum VoteChoice {
    Approve,
    Reject,
}

#[cfg(test)]
mod tests {
    use super::ContractStatus;

    #[test]
    fn pending_recall_is_active_and_non_terminal() {
        assert!(ContractStatus::PendingRecall.is_active());
        assert!(!ContractStatus::PendingRecall.is_terminal());
    }

    #[test]
    fn pending_recall_has_expected_valid_transitions() {
        let transitions = ContractStatus::PendingRecall.valid_transitions();
        assert_eq!(transitions.len(), 3);
        assert!(transitions.contains(&ContractStatus::Active));
        assert!(transitions.contains(&ContractStatus::Completed));
        assert!(transitions.contains(&ContractStatus::Liquidated));
    }
}
