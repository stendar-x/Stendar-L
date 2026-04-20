use anchor_lang::prelude::*;

use super::{
    InterestPaymentType, PaymentFrequency, PrincipalPaymentType, ProposalStatus, VoteChoice,
    ACCOUNT_RESERVED_BYTES, CURRENT_ACCOUNT_VERSION,
};

pub const TERM_PROPOSAL_SEED: &[u8] = b"term_proposal";
pub const PROPOSAL_VOTE_SEED: &[u8] = b"proposal_vote";
pub const PROPOSER_COOLDOWN_SEED: &[u8] = b"proposer_cooldown";
pub const PROPOSAL_EXPIRY_SECONDS: i64 = 7 * 24 * 60 * 60;
pub const PROPOSAL_COOLDOWN_SECONDS: i64 = 7 * 24 * 60 * 60;

/// A snapshot proposal to amend mutable terms on an existing debt contract.
#[account]
pub struct TermAmendmentProposal {
    pub contract: Pubkey,
    pub proposer: Pubkey,
    pub proposal_id: u64,
    pub proposed_interest_rate: u32,
    pub proposed_term_days: u32,
    pub proposed_interest_frequency: PaymentFrequency,
    pub proposed_principal_frequency: Option<PaymentFrequency>,
    pub proposed_interest_payment_type: InterestPaymentType,
    pub proposed_principal_payment_type: PrincipalPaymentType,
    pub proposed_ltv_ratio: u32,
    pub proposed_ltv_floor_bps: u32,
    /// Snapshot of wallets required to vote when the proposal is created.
    pub participant_keys: Vec<Pubkey>,
    pub total_participants: u8,
    pub approvals: u8,
    pub rejections: u8,
    pub status: ProposalStatus,
    pub created_at: i64,
    pub expires_at: i64,
    pub resolved_at: i64,
    /// Number of participants who pledged recall on rejection/expiry.
    pub recall_pledged_count: u32,
    /// Total contribution amount pledged for recall, in atomic units.
    pub recall_pledged_amount: u64,
    /// Number of pledged recalls already processed by the bot.
    pub recalls_processed: u32,
    /// Recall grace start timestamp (0 when no grace period is active).
    pub recall_grace_start: i64,
    pub _reserved: [u8; ACCOUNT_RESERVED_BYTES],
    pub account_version: u16,
}

impl TermAmendmentProposal {
    pub const LEGACY_MAX_PARTICIPANTS: usize = 15;
    pub const PARTICIPANT_KEY_BYTES: usize = 32;
    pub const BASE_LEN: usize = 8 // discriminator
        + 32 // contract
        + 32 // proposer
        + 8 // proposal_id
        + 4 // proposed_interest_rate
        + 4 // proposed_term_days
        + 1 // proposed_interest_frequency
        + 2 // proposed_principal_frequency (Option<u8> max encoded size)
        + 1 // proposed_interest_payment_type
        + 1 // proposed_principal_payment_type
        + 4 // proposed_ltv_ratio
        + 4 // proposed_ltv_floor_bps
        + 4 // participant_keys vec len
        + 1 // total_participants
        + 1 // approvals
        + 1 // rejections
        + 1 // status
        + 8 // created_at
        + 8 // expires_at
        + 8 // resolved_at
        + 4 // recall_pledged_count
        + 8 // recall_pledged_amount
        + 4 // recalls_processed
        + 8 // recall_grace_start
        + ACCOUNT_RESERVED_BYTES // _reserved
        + 2; // account_version
    pub const LEN: usize = Self::space(Self::LEGACY_MAX_PARTICIPANTS);

    pub const fn space(max_participants: usize) -> usize {
        Self::BASE_LEN + (Self::PARTICIPANT_KEY_BYTES * max_participants)
    }

    pub fn is_pending(&self) -> bool {
        self.status == ProposalStatus::Pending
    }

    pub fn includes_participant(&self, wallet: Pubkey) -> bool {
        self.participant_keys
            .iter()
            .any(|participant| *participant == wallet)
    }
}

/// A single immutable vote record for a proposal participant.
#[account]
pub struct ProposalVote {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub vote: VoteChoice,
    pub voted_at: i64,
    pub recall_on_rejection: bool,
    pub _reserved: [u8; ACCOUNT_RESERVED_BYTES],
    pub account_version: u16,
}

impl ProposalVote {
    pub const LEN: usize = 8 + 32 + 32 + 1 + 8 + 1 + ACCOUNT_RESERVED_BYTES + 2;
}

/// Cooldown state per proposer per contract to rate-limit failed proposals.
#[account]
pub struct ProposerCooldown {
    pub contract: Pubkey,
    pub proposer: Pubkey,
    pub cooldown_until: i64,
    pub _reserved: [u8; ACCOUNT_RESERVED_BYTES],
    pub account_version: u16,
}

impl ProposerCooldown {
    pub const LEN: usize = 8 + 32 + 32 + 8 + ACCOUNT_RESERVED_BYTES + 2;

    pub fn initialize_defaults(&mut self, contract: Pubkey, proposer: Pubkey) {
        self.contract = contract;
        self.proposer = proposer;
        self.cooldown_until = 0;
        self._reserved = [0u8; ACCOUNT_RESERVED_BYTES];
        self.account_version = CURRENT_ACCOUNT_VERSION;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn term_proposal_space_matches_layout() {
        assert_eq!(
            TermAmendmentProposal::space(0)
                + (TermAmendmentProposal::PARTICIPANT_KEY_BYTES
                    * TermAmendmentProposal::LEGACY_MAX_PARTICIPANTS),
            TermAmendmentProposal::LEN
        );

        let proposal = TermAmendmentProposal {
            contract: Pubkey::new_unique(),
            proposer: Pubkey::new_unique(),
            proposal_id: 1,
            proposed_interest_rate: 750,
            proposed_term_days: 30,
            proposed_interest_frequency: PaymentFrequency::Weekly,
            proposed_principal_frequency: Some(PaymentFrequency::Monthly),
            proposed_interest_payment_type: InterestPaymentType::OutstandingBalance,
            proposed_principal_payment_type: PrincipalPaymentType::NoFixedPayment,
            proposed_ltv_ratio: 11_000,
            proposed_ltv_floor_bps: 10_000,
            participant_keys: vec![Pubkey::new_unique(), Pubkey::new_unique()],
            total_participants: 2,
            approvals: 1,
            rejections: 0,
            status: ProposalStatus::Pending,
            created_at: 1_700_000_000,
            expires_at: 1_700_100_000,
            resolved_at: 0,
            recall_pledged_count: 0,
            recall_pledged_amount: 0,
            recalls_processed: 0,
            recall_grace_start: 0,
            _reserved: [0u8; ACCOUNT_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        };
        let serialized = proposal.try_to_vec().expect("serialize term proposal");
        assert_eq!(
            serialized.len() + 8,
            TermAmendmentProposal::space(proposal.participant_keys.len())
        );
    }
}
