use anchor_lang::prelude::*;

use super::{BotPaymentType, ContractStatus, DebtContract, PaymentFrequency};

/// Query filter structure for bot operations
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ContractQueryFilter {
    pub status_filter: Option<ContractStatus>,
    pub interest_frequency_filter: Option<PaymentFrequency>,
    pub principal_frequency_filter: Option<PaymentFrequency>,
    pub due_before_timestamp: Option<i64>,
    pub min_funded_amount: Option<u64>,
}

impl ContractQueryFilter {
    /// Create a filter for contracts due for interest payments
    pub fn interest_due_filter(frequency: PaymentFrequency, current_time: i64) -> Self {
        Self {
            status_filter: Some(ContractStatus::Active),
            interest_frequency_filter: Some(frequency),
            principal_frequency_filter: None,
            due_before_timestamp: Some(current_time),
            min_funded_amount: None,
        }
    }

    /// Create a filter for contracts due for principal payments
    pub fn principal_due_filter(frequency: PaymentFrequency, current_time: i64) -> Self {
        Self {
            status_filter: Some(ContractStatus::Active),
            interest_frequency_filter: None,
            principal_frequency_filter: Some(frequency),
            due_before_timestamp: Some(current_time),
            min_funded_amount: None,
        }
    }

    /// Create a filter for contracts by status
    pub fn status_filter(status: ContractStatus) -> Self {
        Self {
            status_filter: Some(status),
            interest_frequency_filter: None,
            principal_frequency_filter: None,
            due_before_timestamp: None,
            min_funded_amount: None,
        }
    }

    /// Create an optimized filter for high-frequency bot operations
    pub fn optimized_bot_filter(
        frequency: PaymentFrequency,
        current_time: i64,
        payment_type: BotPaymentType,
    ) -> Self {
        match payment_type {
            BotPaymentType::Interest => Self::interest_due_filter(frequency, current_time),
            BotPaymentType::Principal => Self::principal_due_filter(frequency, current_time),
            BotPaymentType::Both => Self {
                status_filter: Some(ContractStatus::Active),
                interest_frequency_filter: Some(frequency),
                principal_frequency_filter: Some(frequency),
                due_before_timestamp: Some(current_time),
                min_funded_amount: Some(1), // Only funded contracts
            },
        }
    }

    /// Create filter for batch processing with size limits
    pub fn batch_filter(
        status: ContractStatus,
        _max_contracts: u32,
        frequency: Option<PaymentFrequency>,
    ) -> Self {
        Self {
            status_filter: Some(status),
            interest_frequency_filter: frequency,
            principal_frequency_filter: frequency,
            due_before_timestamp: None,
            min_funded_amount: None,
        }
    }

    /// Check if this filter is optimized for large-scale operations
    pub fn is_optimized(&self) -> bool {
        // A filter is optimized if it has specific criteria that reduce search space
        self.status_filter.is_some()
            || self.interest_frequency_filter.is_some()
            || self.principal_frequency_filter.is_some()
            || self.min_funded_amount.is_some()
    }

    /// Get estimated selectivity of this filter (0.0 to 1.0)
    pub fn estimated_selectivity(&self) -> f64 {
        let mut selectivity = 1.0;

        if self.status_filter.is_some() {
            selectivity *= 0.6; // Status filter typically reduces by 40%
        }

        if self.interest_frequency_filter.is_some() {
            selectivity *= 0.25; // Frequency filter reduces by 75%
        }

        if self.principal_frequency_filter.is_some() {
            selectivity *= 0.25;
        }

        if self.due_before_timestamp.is_some() {
            selectivity *= 0.1; // Due date filter is very selective
        }

        if self.min_funded_amount.is_some() {
            selectivity *= 0.8; // Min amount filter reduces by 20%
        }

        selectivity
    }

    /// Check if a contract matches this filter
    pub fn matches(&self, contract: &DebtContract, current_time: i64) -> bool {
        // Check status filter
        if let Some(status) = self.status_filter {
            if contract.status != status {
                return false;
            }
        }

        // Check interest frequency filter
        if let Some(freq) = self.interest_frequency_filter {
            if contract.interest_frequency != freq {
                return false;
            }
        }

        // Check principal frequency filter
        if let Some(freq) = self.principal_frequency_filter {
            if contract.principal_frequency != Some(freq) {
                return false;
            }
        }

        // Check due date filter (for both interest and principal)
        if let Some(_due_before) = self.due_before_timestamp {
            let interest_due = contract.is_interest_payment_due(current_time);
            let principal_due = contract.is_principal_payment_due(current_time);

            if self.interest_frequency_filter.is_some() && !interest_due {
                return false;
            }

            if self.principal_frequency_filter.is_some() && !principal_due {
                return false;
            }
        }

        // Check minimum funded amount
        if let Some(min_amount) = self.min_funded_amount {
            if contract.funded_amount < min_amount {
                return false;
            }
        }

        true
    }
}

/// Advanced query result with pagination and optimization
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ContractQueryResult {
    pub contracts: Vec<Pubkey>,
    pub total_count: u64,
    pub page_size: u32,
    pub page_offset: u32,
    pub has_more: bool,
    pub query_execution_time: i64,
}

impl ContractQueryResult {
    pub fn new(
        contracts: Vec<Pubkey>,
        total_count: u64,
        page_size: u32,
        page_offset: u32,
        execution_time: i64,
    ) -> Self {
        let has_more = (page_offset as u64 + page_size as u64) < total_count;

        Self {
            contracts,
            total_count,
            page_size,
            page_offset,
            has_more,
            query_execution_time: execution_time,
        }
    }
}

/// Performance optimization hints for query execution
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct QueryOptimizationHints {
    pub use_index_scan: bool,
    pub parallel_processing: bool,
    pub cache_results: bool,
    pub estimated_result_size: u32,
}

impl QueryOptimizationHints {
    /// Create hints for small result sets
    pub fn small_result_hints() -> Self {
        Self {
            use_index_scan: true,
            parallel_processing: false,
            cache_results: true,
            estimated_result_size: 100,
        }
    }

    /// Create hints for large result sets
    pub fn large_result_hints() -> Self {
        Self {
            use_index_scan: false,
            parallel_processing: true,
            cache_results: false,
            estimated_result_size: 10000,
        }
    }

    /// Create hints based on filter selectivity
    pub fn from_filter(filter: &ContractQueryFilter) -> Self {
        let selectivity = filter.estimated_selectivity();

        if selectivity < 0.1 {
            Self::small_result_hints()
        } else {
            Self::large_result_hints()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ContractQueryResult;
    use anchor_lang::prelude::Pubkey;

    #[test]
    fn contract_query_result_handles_large_total_count_without_truncation() {
        let result = ContractQueryResult::new(vec![], u32::MAX as u64 + 5, 1, u32::MAX, 10);
        assert!(result.has_more);
    }

    #[test]
    fn contract_query_result_has_more_false_when_page_reaches_total() {
        let result = ContractQueryResult::new(vec![Pubkey::new_unique()], 100, 20, 80, 10);
        assert!(!result.has_more);
    }
}
