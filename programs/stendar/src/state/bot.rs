use anchor_lang::prelude::*;

use super::{ContractQueryFilter, PaymentFrequency};

/// Bot payment operation types
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BotPaymentType {
    Interest,
    Principal,
    Both,
}

/// Statistics for bot operations
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BotOperationStats {
    pub contracts_processed: u64,
    pub interest_payments_processed: u64,
    pub principal_payments_processed: u64,
    pub total_amount_processed: u64,
    pub last_operation_time: i64,
    pub average_processing_time: i64,
}

impl BotOperationStats {
    pub fn new() -> Self {
        Self {
            contracts_processed: 0,
            interest_payments_processed: 0,
            principal_payments_processed: 0,
            total_amount_processed: 0,
            last_operation_time: 0,
            average_processing_time: 0,
        }
    }

    /// Update statistics after processing a batch of contracts
    pub fn update_batch_stats(
        &mut self,
        contracts_count: u64,
        amount_processed: u64,
        processing_time: i64,
    ) {
        let had_previous_batches = self.contracts_processed > 0;
        self.contracts_processed += contracts_count;
        self.total_amount_processed += amount_processed;
        self.last_operation_time = processing_time;

        // Calculate moving average for processing time
        if had_previous_batches {
            self.average_processing_time = (self.average_processing_time + processing_time) / 2;
        } else {
            self.average_processing_time = processing_time;
        }
    }

    /// Update interest payment statistics
    pub fn update_interest_stats(&mut self, payments_count: u64, amount: u64) {
        self.interest_payments_processed += payments_count;
        self.total_amount_processed += amount;
    }

    /// Update principal payment statistics
    pub fn update_principal_stats(&mut self, payments_count: u64, amount: u64) {
        self.principal_payments_processed += payments_count;
        self.total_amount_processed += amount;
    }
}

/// Batch processing configuration for bot operations
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BatchProcessingConfig {
    pub max_contracts_per_batch: u32,
    pub max_processing_time_ms: i64,
    pub min_batch_size: u32,
    pub frequency_priority: Vec<PaymentFrequency>,
}

impl BatchProcessingConfig {
    /// Create optimized batch config for production use
    pub fn production_config() -> Self {
        Self {
            max_contracts_per_batch: 100,
            max_processing_time_ms: 10000, // 10 seconds
            min_batch_size: 10,
            frequency_priority: vec![
                PaymentFrequency::Daily,
                PaymentFrequency::Weekly,
                PaymentFrequency::BiWeekly,
                PaymentFrequency::Monthly,
            ],
        }
    }

    /// Create test config for smaller batches
    pub fn test_config() -> Self {
        Self {
            max_contracts_per_batch: 10,
            max_processing_time_ms: 1000, // 1 second
            min_batch_size: 1,
            frequency_priority: vec![
                PaymentFrequency::Daily,
                PaymentFrequency::Weekly,
                PaymentFrequency::BiWeekly,
                PaymentFrequency::Monthly,
            ],
        }
    }
}

/// Contract batch for efficient processing
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ContractBatch {
    pub contracts: Vec<Pubkey>,
    pub batch_id: u64,
    pub payment_type: BotPaymentType,
    pub frequency: PaymentFrequency,
    pub estimated_processing_time: i64,
    pub priority: u8,
}

impl ContractBatch {
    /// Create a new batch with optimal sizing
    pub fn new(
        contracts: Vec<Pubkey>,
        batch_id: u64,
        payment_type: BotPaymentType,
        frequency: PaymentFrequency,
    ) -> Self {
        let estimated_time = contracts.len() as i64 * 50; // 50ms per contract estimate
        let priority = match frequency {
            PaymentFrequency::Daily => 4,
            PaymentFrequency::Weekly => 3,
            PaymentFrequency::BiWeekly => 2,
            PaymentFrequency::Monthly => 1,
        };

        Self {
            contracts,
            batch_id,
            payment_type,
            frequency,
            estimated_processing_time: estimated_time,
            priority,
        }
    }

    /// Check if this batch should be processed with high priority
    pub fn is_high_priority(&self) -> bool {
        self.priority >= 3
    }

    /// Get optimal chunk size for this batch
    pub fn optimal_chunk_size(&self) -> usize {
        match self.frequency {
            PaymentFrequency::Daily => 20,    // Higher frequency, smaller chunks
            PaymentFrequency::Weekly => 50,   // Medium chunks
            PaymentFrequency::BiWeekly => 75, // Larger chunks
            PaymentFrequency::Monthly => 100, // Largest chunks
        }
    }
}

/// Memory-efficient contract iterator for large datasets
pub struct ContractIterator {
    pub current_offset: u32,
    pub page_size: u32,
    pub total_contracts: u32,
    pub filter: ContractQueryFilter,
}

impl ContractIterator {
    pub fn new(filter: ContractQueryFilter, page_size: u32, total_contracts: u32) -> Self {
        Self {
            current_offset: 0,
            page_size,
            total_contracts,
            filter,
        }
    }

    /// Check if there are more contracts to process
    pub fn has_next(&self) -> bool {
        self.current_offset < self.total_contracts
    }

    /// Get the next batch of contracts
    pub fn next_batch(&mut self) -> Option<(u32, u32)> {
        if !self.has_next() {
            return None;
        }

        let start = self.current_offset;
        let end = std::cmp::min(start + self.page_size, self.total_contracts);

        self.current_offset = end;

        Some((start, end))
    }

    /// Reset iterator to beginning
    pub fn reset(&mut self) {
        self.current_offset = 0;
    }

    /// Get progress percentage (0.0 to 1.0)
    pub fn progress(&self) -> f64 {
        if self.total_contracts == 0 {
            1.0
        } else {
            self.current_offset as f64 / self.total_contracts as f64
        }
    }
}
