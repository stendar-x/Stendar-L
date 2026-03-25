use crate::contexts::*;
use crate::errors::StendarError;
use crate::state::{
    ContractStatus, DebtContract, InterestPaymentType, LenderContribution, LoanType,
    PaymentFrequency, PrincipalPaymentType, ProposalStatus, ProposerCooldown, TermAmendmentProposal,
    VoteChoice, CURRENT_ACCOUNT_VERSION, PROPOSAL_COOLDOWN_SECONDS, PROPOSAL_EXPIRY_SECONDS,
};
use crate::utils::{
    process_automatic_interest, process_scheduled_principal_payments, require_current_version,
};
use anchor_lang::prelude::*;

const DAY_SECONDS: i64 = 24 * 60 * 60;

fn ensure_cooldown_account_initialized(
    cooldown: &mut Account<ProposerCooldown>,
    contract: Pubkey,
    proposer: Pubkey,
) -> Result<()> {
    if cooldown.account_version == 0 {
        cooldown.initialize_defaults(contract, proposer);
        return Ok(());
    }

    require_current_version(cooldown.account_version)?;
    require!(
        cooldown.contract == contract && cooldown.proposer == proposer,
        StendarError::InvalidContractReference
    );
    Ok(())
}

fn build_participant_snapshot(
    contract: &Account<DebtContract>,
    remaining_accounts: &[AccountInfo<'_>],
) -> Result<Vec<Pubkey>> {
    let contract_key = contract.key();
    let mut participants = vec![contract.borrower];

    for contribution_pubkey in contract.contributions.iter() {
        let contribution_info = remaining_accounts
            .iter()
            .find(|account_info| account_info.key == contribution_pubkey)
            .ok_or(StendarError::MissingContributionAccounts)?;
        require!(
            contribution_info.owner == &crate::ID,
            StendarError::InvalidContribution
        );
        let contribution_data = contribution_info.try_borrow_data()?;
        let mut contribution_bytes: &[u8] = &contribution_data;
        let contribution = LenderContribution::try_deserialize(&mut contribution_bytes)?;
        require_current_version(contribution.account_version)?;
        require!(
            contribution.contract == contract_key,
            StendarError::InvalidContribution
        );
        if contribution.is_refunded {
            continue;
        }
        if !participants
            .iter()
            .any(|participant| *participant == contribution.lender)
        {
            participants.push(contribution.lender);
        }
    }

    Ok(participants)
}

fn validate_proposed_terms(
    contract: &DebtContract,
    proposed_interest_rate: u32,
    proposed_term_days: u32,
    proposed_interest_frequency: PaymentFrequency,
    proposed_principal_frequency: Option<PaymentFrequency>,
    proposed_interest_payment_type: InterestPaymentType,
    proposed_principal_payment_type: PrincipalPaymentType,
    proposed_ltv_ratio: u64,
    proposed_ltv_floor_bps: u16,
) -> Result<()> {
    require!(
        proposed_interest_rate > 0 && proposed_interest_rate <= 10_000,
        StendarError::InvalidProposedTerms
    );
    require!(
        proposed_term_days > 0 && proposed_term_days <= 3_650,
        StendarError::InvalidProposedTerms
    );
    require!(
        proposed_ltv_ratio >= 1_000 && proposed_ltv_ratio <= 20_000,
        StendarError::InvalidProposedTerms
    );
    require!(
        proposed_ltv_floor_bps > 0 && proposed_ltv_floor_bps <= 20_000,
        StendarError::InvalidProposedTerms
    );
    require!(
        proposed_ltv_ratio >= proposed_ltv_floor_bps as u64,
        StendarError::InvalidProposedTerms
    );

    if contract.loan_type == LoanType::Demand {
        require!(
            proposed_ltv_floor_bps >= crate::state::DEMAND_LOAN_MIN_FLOOR_BPS,
            StendarError::InvalidProposedTerms
        );
    }

    if proposed_principal_payment_type == PrincipalPaymentType::NoFixedPayment {
        require!(
            proposed_principal_frequency.is_none(),
            StendarError::InvalidProposedTerms
        );
    } else {
        require!(
            proposed_principal_frequency.is_some(),
            StendarError::InvalidProposedTerms
        );
    }

    let changed = contract.interest_rate != proposed_interest_rate
        || contract.term_days != proposed_term_days
        || contract.interest_frequency != proposed_interest_frequency
        || contract.principal_frequency != proposed_principal_frequency
        || contract.interest_payment_type != proposed_interest_payment_type
        || contract.principal_payment_type != proposed_principal_payment_type
        || contract.ltv_ratio != proposed_ltv_ratio
        || contract.ltv_floor_bps != proposed_ltv_floor_bps;
    require!(changed, StendarError::NoTermChanges);

    Ok(())
}

fn apply_approved_terms(
    contract: &mut Account<DebtContract>,
    proposal: &TermAmendmentProposal,
    current_time: i64,
) -> Result<()> {
    process_automatic_interest(contract, current_time)?;
    process_scheduled_principal_payments(contract, current_time)?;

    let proposed_term_seconds = i64::from(proposal.proposed_term_days)
        .checked_mul(DAY_SECONDS)
        .ok_or(StendarError::ArithmeticOverflow)?;
    let term_reference = if contract.last_interest_update > 0 {
        contract.last_interest_update
    } else {
        contract.created_at
    };
    let proposed_term_end = term_reference
        .checked_add(proposed_term_seconds)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(
        proposed_term_end >= current_time,
        StendarError::InvalidProposedTerms
    );

    contract.interest_rate = proposal.proposed_interest_rate;
    contract.term_days = proposal.proposed_term_days;
    contract.interest_frequency = proposal.proposed_interest_frequency;
    contract.principal_frequency = proposal.proposed_principal_frequency;
    contract.interest_payment_type = proposal.proposed_interest_payment_type;
    contract.principal_payment_type = proposal.proposed_principal_payment_type;
    contract.ltv_ratio = proposal.proposed_ltv_ratio;
    contract.ltv_floor_bps = proposal.proposed_ltv_floor_bps;
    contract.update_bot_tracking(current_time);

    Ok(())
}

pub fn create_term_proposal(
    ctx: Context<CreateTermProposal>,
    proposal_id: u64,
    proposed_interest_rate: u32,
    proposed_term_days: u32,
    proposed_interest_frequency: PaymentFrequency,
    proposed_principal_frequency: Option<PaymentFrequency>,
    proposed_interest_payment_type: InterestPaymentType,
    proposed_principal_payment_type: PrincipalPaymentType,
    proposed_ltv_ratio: u64,
    proposed_ltv_floor_bps: u16,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let contract = &mut ctx.accounts.contract;
    require_current_version(contract.account_version)?;
    require!(
        contract.status == ContractStatus::Active,
        StendarError::ContractNotActive
    );
    require!(
        !contract.has_active_proposal(),
        StendarError::ProposalAlreadyActive
    );

    let expected_proposal_id = contract
        .proposal_count()
        .checked_add(1)
        .ok_or(StendarError::ArithmeticOverflow)?;
    require!(
        proposal_id == expected_proposal_id,
        StendarError::InvalidProposalId
    );

    let participant_keys = build_participant_snapshot(contract, ctx.remaining_accounts)?;
    require!(
        participant_keys
            .iter()
            .any(|participant| *participant == ctx.accounts.proposer.key()),
        StendarError::NotContractParticipant
    );
    let participant_count = participant_keys.len();
    require!(
        participant_count > 0 && participant_count <= TermAmendmentProposal::MAX_PARTICIPANTS,
        StendarError::InvalidProposalParticipants
    );

    validate_proposed_terms(
        contract,
        proposed_interest_rate,
        proposed_term_days,
        proposed_interest_frequency,
        proposed_principal_frequency,
        proposed_interest_payment_type,
        proposed_principal_payment_type,
        proposed_ltv_ratio,
        proposed_ltv_floor_bps,
    )?;

    let proposer_key = ctx.accounts.proposer.key();
    let proposer_cooldown = &mut ctx.accounts.proposer_cooldown;
    ensure_cooldown_account_initialized(proposer_cooldown, contract.key(), proposer_key)?;
    require!(
        now >= proposer_cooldown.cooldown_until,
        StendarError::ProposerOnCooldown
    );

    let proposal = &mut ctx.accounts.proposal;
    proposal.contract = contract.key();
    proposal.proposer = proposer_key;
    proposal.proposal_id = proposal_id;
    proposal.proposed_interest_rate = proposed_interest_rate;
    proposal.proposed_term_days = proposed_term_days;
    proposal.proposed_interest_frequency = proposed_interest_frequency;
    proposal.proposed_principal_frequency = proposed_principal_frequency;
    proposal.proposed_interest_payment_type = proposed_interest_payment_type;
    proposal.proposed_principal_payment_type = proposed_principal_payment_type;
    proposal.proposed_ltv_ratio = proposed_ltv_ratio;
    proposal.proposed_ltv_floor_bps = proposed_ltv_floor_bps;
    proposal.participant_keys = participant_keys;
    proposal.total_participants = u8::try_from(participant_count)
        .map_err(|_| error!(StendarError::InvalidProposalParticipants))?;
    proposal.approvals = 1;
    proposal.rejections = 0;
    proposal.status = ProposalStatus::Pending;
    proposal.created_at = now;
    proposal.expires_at = now
        .checked_add(PROPOSAL_EXPIRY_SECONDS)
        .ok_or(StendarError::ArithmeticOverflow)?;
    proposal.resolved_at = 0;
    proposal._reserved = [0u8; 32];
    proposal.account_version = CURRENT_ACCOUNT_VERSION;

    let proposer_vote = &mut ctx.accounts.proposer_vote;
    proposer_vote.proposal = proposal.key();
    proposer_vote.voter = proposer_key;
    proposer_vote.vote = VoteChoice::Approve;
    proposer_vote.voted_at = now;
    proposer_vote._reserved = [0u8; 16];
    proposer_vote.account_version = CURRENT_ACCOUNT_VERSION;

    contract.set_has_active_proposal(true);
    contract.set_proposal_count(proposal_id);

    if proposal.total_participants == 1 {
        apply_approved_terms(contract, proposal, now)?;
        proposal.status = ProposalStatus::Approved;
        proposal.resolved_at = now;
        contract.set_has_active_proposal(false);
    }

    Ok(())
}

pub fn vote_on_proposal(
    ctx: Context<VoteOnProposal>,
    _proposal_id: u64,
    vote_choice: VoteChoice,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let contract = &mut ctx.accounts.contract;
    let proposal = &mut ctx.accounts.proposal;
    let voter = ctx.accounts.voter.key();

    require_current_version(contract.account_version)?;
    require_current_version(proposal.account_version)?;
    require!(contract.has_active_proposal(), StendarError::ProposalNotPending);
    require!(proposal.is_pending(), StendarError::ProposalNotPending);
    require!(now < proposal.expires_at, StendarError::ProposalExpired);
    require!(
        proposal.includes_participant(voter),
        StendarError::NotContractParticipant
    );
    require!(voter != proposal.proposer, StendarError::ProposerCannotVote);

    let vote = &mut ctx.accounts.vote;
    if vote.account_version != 0 {
        return Err(StendarError::AlreadyVoted.into());
    }

    vote.proposal = proposal.key();
    vote.voter = voter;
    vote.vote = vote_choice;
    vote.voted_at = now;
    vote._reserved = [0u8; 16];
    vote.account_version = CURRENT_ACCOUNT_VERSION;

    match vote_choice {
        VoteChoice::Reject => {
            proposal.rejections = proposal
                .rejections
                .checked_add(1)
                .ok_or(StendarError::ArithmeticOverflow)?;
            proposal.status = ProposalStatus::Rejected;
            proposal.resolved_at = now;
            contract.set_has_active_proposal(false);

            let proposer_cooldown = &mut ctx.accounts.proposer_cooldown;
            ensure_cooldown_account_initialized(
                proposer_cooldown,
                contract.key(),
                proposal.proposer,
            )?;
            proposer_cooldown.cooldown_until = now
                .checked_add(PROPOSAL_COOLDOWN_SECONDS)
                .ok_or(StendarError::ArithmeticOverflow)?;
        }
        VoteChoice::Approve => {
            proposal.approvals = proposal
                .approvals
                .checked_add(1)
                .ok_or(StendarError::ArithmeticOverflow)?;
            if proposal.approvals >= proposal.total_participants {
                apply_approved_terms(contract, proposal, now)?;
                proposal.status = ProposalStatus::Approved;
                proposal.resolved_at = now;
                contract.set_has_active_proposal(false);
            }
        }
    }

    Ok(())
}

pub fn cancel_term_proposal(ctx: Context<CancelTermProposal>, _proposal_id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let contract = &mut ctx.accounts.contract;
    let proposal = &mut ctx.accounts.proposal;

    require_current_version(contract.account_version)?;
    require_current_version(proposal.account_version)?;
    require!(proposal.is_pending(), StendarError::ProposalNotPending);
    require!(
        ctx.accounts.proposer.key() == proposal.proposer,
        StendarError::UnauthorizedProposalCancel
    );

    proposal.status = ProposalStatus::Cancelled;
    proposal.resolved_at = now;
    contract.set_has_active_proposal(false);

    Ok(())
}

pub fn expire_term_proposal(ctx: Context<ExpireTermProposal>, _proposal_id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let contract = &mut ctx.accounts.contract;
    let proposal = &mut ctx.accounts.proposal;

    require_current_version(contract.account_version)?;
    require_current_version(proposal.account_version)?;
    require!(proposal.is_pending(), StendarError::ProposalNotPending);
    require!(now >= proposal.expires_at, StendarError::ProposalNotExpired);

    proposal.status = ProposalStatus::Expired;
    proposal.resolved_at = now;
    contract.set_has_active_proposal(false);

    let proposer_cooldown = &mut ctx.accounts.proposer_cooldown;
    ensure_cooldown_account_initialized(proposer_cooldown, contract.key(), proposal.proposer)?;
    proposer_cooldown.cooldown_until = now
        .checked_add(PROPOSAL_COOLDOWN_SECONDS)
        .ok_or(StendarError::ArithmeticOverflow)?;

    Ok(())
}

pub fn close_proposal_accounts(ctx: Context<CloseProposalAccounts>, _proposal_id: u64) -> Result<()> {
    let proposal = &ctx.accounts.proposal;
    require!(!proposal.is_pending(), StendarError::ProposalNotPending);

    // Defensive reset in case a stale flag remains.
    if ctx.accounts.contract.has_active_proposal() {
        ctx.accounts.contract.set_has_active_proposal(false);
    }

    Ok(())
}
