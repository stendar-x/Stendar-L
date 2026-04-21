use super::lending::calculate_recall_fee;
#[cfg(feature = "testing")]
use super::lending::with_test_clock_offset;
use crate::contexts::*;
use crate::errors::StendarError;
use crate::state::{
    ContractStatus, DebtContract, FrontendFeeSplit, InterestPaymentType, LenderContribution,
    LoanType, PaymentFrequency, PrincipalPaymentType, ProposalStatus, ProposerCooldown,
    TermAmendmentProposal, VoteChoice, ACCOUNT_RESERVED_BYTES, CURRENT_ACCOUNT_VERSION,
    PROPOSAL_COOLDOWN_SECONDS, PROPOSAL_EXPIRY_SECONDS, RECALL_GRACE_PERIOD_SECONDS,
};
use crate::utils::{
    calculate_frontend_share, calculate_proportional_collateral, process_automatic_interest,
    process_scheduled_principal_payments, require_current_version, MAX_LENDERS_PER_TX,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

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

fn find_active_lender_contribution_amount(
    contract: &Account<DebtContract>,
    lender: Pubkey,
    remaining_accounts: &[AccountInfo<'_>],
) -> Result<Option<u64>> {
    let contract_key = contract.key();

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

        if contribution.lender == lender
            && !contribution.is_refunded
            && contribution.contribution_amount > 0
        {
            return Ok(Some(contribution.contribution_amount));
        }
    }

    Ok(None)
}

fn validate_proposed_terms(
    contract: &DebtContract,
    proposed_interest_rate: u32,
    proposed_term_days: u32,
    proposed_interest_frequency: PaymentFrequency,
    proposed_principal_frequency: Option<PaymentFrequency>,
    proposed_interest_payment_type: InterestPaymentType,
    proposed_principal_payment_type: PrincipalPaymentType,
    proposed_ltv_ratio: u32,
    proposed_ltv_floor_bps: u32,
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
        proposed_ltv_ratio >= proposed_ltv_floor_bps,
        StendarError::InvalidProposedTerms
    );
    if proposed_ltv_ratio == 0 {
        require!(
            proposed_interest_payment_type != InterestPaymentType::CollateralTransfer,
            StendarError::InvalidProposedTerms
        );
        require!(
            proposed_principal_payment_type != PrincipalPaymentType::CollateralDeduction,
            StendarError::InvalidProposedTerms
        );
    } else if proposed_interest_payment_type == InterestPaymentType::CollateralTransfer
        || proposed_principal_payment_type == PrincipalPaymentType::CollateralDeduction
    {
        require!(
            proposed_ltv_ratio >= 1_000,
            StendarError::InvalidProposedTerms
        );
    }

    if contract.loan_type == LoanType::Demand && proposed_ltv_floor_bps > 0 {
        require!(
            proposed_ltv_floor_bps >= crate::state::DEMAND_LOAN_MIN_FLOOR_BPS as u32,
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
    proposed_ltv_ratio: u32,
    proposed_ltv_floor_bps: u32,
    recall_on_rejection: bool,
) -> Result<()> {
    require!(!ctx.accounts.state.is_paused, StendarError::PlatformPaused);
    let now = Clock::get()?.unix_timestamp;
    let contract = &mut ctx.accounts.contract;
    require_current_version(contract.account_version)?;
    require!(
        contract.status == ContractStatus::Active,
        StendarError::ContractNotActive
    );
    require!(
        !contract.has_active_proposal,
        StendarError::ProposalAlreadyActive
    );

    let expected_proposal_id = contract
        .proposal_count
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
    let lender_cap = if contract.max_lenders == 0 {
        MAX_LENDERS_PER_TX
    } else {
        contract.max_lenders
    };
    let max_participants = usize::from(lender_cap) + 1;
    require!(
        participant_count > 0 && participant_count <= max_participants,
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
    let proposer_recall_pledge_amount = if recall_on_rejection {
        require!(
            contract.loan_type == LoanType::Demand,
            StendarError::RecallPledgeNotAllowedForCommittedLoans
        );
        require!(
            proposer_key != contract.borrower,
            StendarError::RecallPledgeLenderOnly
        );
        find_active_lender_contribution_amount(contract, proposer_key, ctx.remaining_accounts)?
            .ok_or(StendarError::RecallPledgeLenderOnly)?
    } else {
        0
    };

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
    proposal.recall_pledged_count = if recall_on_rejection { 1 } else { 0 };
    proposal.recall_pledged_amount = proposer_recall_pledge_amount;
    proposal.recalls_processed = 0;
    proposal.recall_grace_start = 0;
    proposal._reserved = [0u8; ACCOUNT_RESERVED_BYTES];
    proposal.account_version = CURRENT_ACCOUNT_VERSION;

    let proposer_vote = &mut ctx.accounts.proposer_vote;
    proposer_vote.proposal = proposal.key();
    proposer_vote.voter = proposer_key;
    proposer_vote.vote = VoteChoice::Approve;
    proposer_vote.voted_at = now;
    proposer_vote.recall_on_rejection = recall_on_rejection;
    proposer_vote._reserved = [0u8; ACCOUNT_RESERVED_BYTES];
    proposer_vote.account_version = CURRENT_ACCOUNT_VERSION;

    contract.has_active_proposal = true;
    contract.proposal_count = proposal_id;

    if proposal.total_participants == 1 {
        require!(
            contract.status != ContractStatus::Active,
            StendarError::InvalidProposedTerms
        );
        apply_approved_terms(contract, proposal, now)?;
        proposal.status = ProposalStatus::Approved;
        proposal.resolved_at = now;
        contract.has_active_proposal = false;
    }

    Ok(())
}

pub fn vote_on_proposal(
    ctx: Context<VoteOnProposal>,
    _proposal_id: u64,
    vote_choice: VoteChoice,
    recall_on_rejection: bool,
) -> Result<()> {
    require!(!ctx.accounts.state.is_paused, StendarError::PlatformPaused);
    let now = Clock::get()?.unix_timestamp;
    let contract = &mut ctx.accounts.contract;
    let proposal = &mut ctx.accounts.proposal;
    let voter = ctx.accounts.voter.key();

    require_current_version(contract.account_version)?;
    require_current_version(proposal.account_version)?;
    require!(
        contract.has_active_proposal,
        StendarError::ProposalNotPending
    );
    require!(proposal.is_pending(), StendarError::ProposalNotPending);
    require!(now < proposal.expires_at, StendarError::ProposalExpired);
    require!(
        proposal.includes_participant(voter),
        StendarError::NotContractParticipant
    );
    require!(voter != proposal.proposer, StendarError::ProposerCannotVote);

    let recall_pledge_amount = if recall_on_rejection {
        require!(
            contract.loan_type == LoanType::Demand,
            StendarError::RecallPledgeNotAllowedForCommittedLoans
        );
        require!(
            voter != contract.borrower,
            StendarError::RecallPledgeLenderOnly
        );
        let voter_contribution = ctx
            .accounts
            .voter_contribution
            .as_ref()
            .ok_or(StendarError::RecallPledgeLenderOnly)?;
        require_current_version(voter_contribution.account_version)?;
        require!(
            voter_contribution.contract == contract.key(),
            StendarError::InvalidContribution
        );
        require!(
            voter_contribution.lender == voter,
            StendarError::InvalidContribution
        );
        require!(
            !voter_contribution.is_refunded && voter_contribution.contribution_amount > 0,
            StendarError::RecallPledgeLenderOnly
        );
        voter_contribution.contribution_amount
    } else {
        0
    };

    let vote = &mut ctx.accounts.vote;
    if vote.account_version != 0 {
        return Err(StendarError::AlreadyVoted.into());
    }

    vote.proposal = proposal.key();
    vote.voter = voter;
    vote.vote = vote_choice;
    vote.voted_at = now;
    vote.recall_on_rejection = recall_on_rejection;
    vote._reserved = [0u8; ACCOUNT_RESERVED_BYTES];
    vote.account_version = CURRENT_ACCOUNT_VERSION;

    if recall_on_rejection {
        proposal.recall_pledged_count = proposal
            .recall_pledged_count
            .checked_add(1)
            .ok_or(StendarError::ArithmeticOverflow)?;
        proposal.recall_pledged_amount = proposal
            .recall_pledged_amount
            .checked_add(recall_pledge_amount)
            .ok_or(StendarError::ArithmeticOverflow)?;
    }

    match vote_choice {
        VoteChoice::Reject => {
            proposal.rejections = proposal
                .rejections
                .checked_add(1)
                .ok_or(StendarError::ArithmeticOverflow)?;
            proposal.status = ProposalStatus::Rejected;
            proposal.resolved_at = now;
            if proposal.recall_pledged_count > 0 {
                proposal.recall_grace_start = now;
            }
            contract.has_active_proposal = false;

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
                contract.has_active_proposal = false;
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
    contract.has_active_proposal = false;

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
    if proposal.recall_pledged_count > 0 {
        proposal.recall_grace_start = now;
    }
    contract.has_active_proposal = false;

    let proposer_cooldown = &mut ctx.accounts.proposer_cooldown;
    ensure_cooldown_account_initialized(proposer_cooldown, contract.key(), proposal.proposer)?;
    proposer_cooldown.cooldown_until = now
        .checked_add(PROPOSAL_COOLDOWN_SECONDS)
        .ok_or(StendarError::ArithmeticOverflow)?;

    Ok(())
}

pub fn process_proposal_recall(
    ctx: Context<ProcessProposalRecall>,
    _proposal_id: u64,
) -> Result<()> {
    require_current_version(ctx.accounts.contract.account_version)?;
    require_current_version(ctx.accounts.proposal.account_version)?;
    require_current_version(ctx.accounts.vote.account_version)?;
    require_current_version(ctx.accounts.contribution.account_version)?;
    require_current_version(ctx.accounts.escrow.account_version)?;
    require_current_version(ctx.accounts.state.account_version)?;
    require_current_version(ctx.accounts.treasury.account_version)?;

    require!(
        ctx.accounts.treasury.bot_authority == ctx.accounts.bot_authority.key(),
        StendarError::UnauthorizedBotOperation
    );

    #[cfg(feature = "testing")]
    let current_time = with_test_clock_offset(
        Clock::get()?.unix_timestamp,
        ctx.accounts.state.authority,
        ctx.accounts.test_clock_offset.as_deref(),
    )?;
    #[cfg(not(feature = "testing"))]
    let current_time = Clock::get()?.unix_timestamp;
    let treasury = &mut ctx.accounts.treasury;
    require!(
        treasury.usdc_mint != Pubkey::default(),
        StendarError::InvalidMint
    );
    require!(
        treasury.usdc_mint == ctx.accounts.contract.loan_mint,
        StendarError::InvalidUsdcMint
    );
    require!(
        treasury.treasury_usdc_account == ctx.accounts.treasury_usdc_ata.key(),
        StendarError::TokenAccountMismatch
    );
    require!(
        ctx.accounts.treasury_usdc_ata.owner == treasury.key(),
        StendarError::TokenAccountMismatch
    );

    {
        let contract = &ctx.accounts.contract;
        let proposal = &ctx.accounts.proposal;
        let vote = &ctx.accounts.vote;

        require!(
            contract.loan_type == LoanType::Demand,
            StendarError::NotDemandLoan
        );
        require!(
            proposal.status == ProposalStatus::Rejected
                || proposal.status == ProposalStatus::Expired,
            StendarError::ProposalNotRejectedOrExpired
        );
        require!(vote.recall_on_rejection, StendarError::NoRecallPledgeOnVote);
        require!(
            vote.voter == ctx.accounts.contribution.lender,
            StendarError::InvalidContribution
        );
        require!(
            proposal.recall_grace_start > 0,
            StendarError::ProposalRecallGraceNotElapsed
        );
        let grace_end = proposal
            .recall_grace_start
            .checked_add(RECALL_GRACE_PERIOD_SECONDS)
            .ok_or(StendarError::ArithmeticOverflow)?;
        require!(
            current_time >= grace_end,
            StendarError::ProposalRecallGraceNotElapsed
        );
    }

    let recall_amount = ctx.accounts.contribution.contribution_amount;
    require!(recall_amount > 0, StendarError::InvalidContributionAmount);
    let recall_fee = calculate_recall_fee(recall_amount)?;
    let lender_receives = recall_amount
        .checked_sub(recall_fee)
        .ok_or(StendarError::ArithmeticOverflow)?;

    let funded_amount = ctx.accounts.contract.funded_amount;
    let total_collateral = ctx.accounts.contract.collateral_amount;
    let proportional_collateral =
        calculate_proportional_collateral(recall_amount, funded_amount, total_collateral)?;

    // Keep escrow token account pinned once it is first observed.
    {
        let escrow = &mut ctx.accounts.escrow;
        if escrow.escrow_token_account == Pubkey::default() {
            escrow.escrow_token_account = ctx.accounts.escrow_usdc_ata.key();
        } else {
            require!(
                escrow.escrow_token_account == ctx.accounts.escrow_usdc_ata.key(),
                StendarError::TokenAccountMismatch
            );
        }
    }

    if lender_receives > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bot_usdc_ata.to_account_info(),
                    to: ctx.accounts.escrow_usdc_ata.to_account_info(),
                    authority: ctx.accounts.bot_authority.to_account_info(),
                },
            ),
            lender_receives,
        )?;
    }

    let mut treasury_recall_received = recall_fee;
    if recall_fee > 0 {
        let stored_frontend = ctx.accounts.contract.frontend;
        let frontend_share = if stored_frontend != Pubkey::default() {
            if let Some(frontend_ata) = ctx.accounts.frontend_usdc_ata.as_ref() {
                require!(
                    frontend_ata.owner == stored_frontend,
                    StendarError::FrontendTokenAccountMismatch
                );
                require!(
                    frontend_ata.mint == ctx.accounts.contract.loan_mint,
                    StendarError::TokenAccountMismatch
                );
                calculate_frontend_share(recall_fee)?
            } else {
                0
            }
        } else {
            0
        };

        if frontend_share > 0 {
            let frontend_ata = ctx
                .accounts
                .frontend_usdc_ata
                .as_ref()
                .ok_or(StendarError::MissingTokenAccounts)?;
            let treasury_share = recall_fee
                .checked_sub(frontend_share)
                .ok_or(StendarError::ArithmeticOverflow)?;
            treasury_recall_received = treasury_share;
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.bot_usdc_ata.to_account_info(),
                        to: ctx.accounts.treasury_usdc_ata.to_account_info(),
                        authority: ctx.accounts.bot_authority.to_account_info(),
                    },
                ),
                treasury_share,
            )?;
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.bot_usdc_ata.to_account_info(),
                        to: frontend_ata.to_account_info(),
                        authority: ctx.accounts.bot_authority.to_account_info(),
                    },
                ),
                frontend_share,
            )?;
            emit!(FrontendFeeSplit {
                frontend: stored_frontend,
                fee_type: 4,
                total_fee: recall_fee,
                frontend_share,
                treasury_share,
            });
        } else {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.bot_usdc_ata.to_account_info(),
                        to: ctx.accounts.treasury_usdc_ata.to_account_info(),
                        authority: ctx.accounts.bot_authority.to_account_info(),
                    },
                ),
                recall_fee,
            )?;
        }
    }

    if proportional_collateral > 0 {
        let contract = &ctx.accounts.contract;
        let contract_seed_bytes = contract.contract_seed.to_le_bytes();
        let (expected_contract_pda, contract_bump) = Pubkey::find_program_address(
            &[
                b"debt_contract",
                contract.borrower.as_ref(),
                &contract_seed_bytes,
            ],
            ctx.program_id,
        );
        require!(
            expected_contract_pda == contract.key(),
            StendarError::InvalidContractReference
        );
        let bump_seed = [contract_bump];
        let signer_seeds: &[&[u8]] = &[
            b"debt_contract",
            contract.borrower.as_ref(),
            &contract_seed_bytes,
            &bump_seed,
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.contract_collateral_ata.to_account_info(),
                    to: ctx.accounts.bot_collateral_ata.to_account_info(),
                    authority: ctx.accounts.contract.to_account_info(),
                },
                &[signer_seeds],
            ),
            proportional_collateral,
        )?;
    }

    let escrow = &mut ctx.accounts.escrow;
    escrow.available_principal = escrow
        .available_principal
        .checked_add(lender_receives)
        .ok_or(StendarError::ArithmeticOverflow)?;
    escrow.escrow_amount = escrow
        .escrow_amount
        .checked_add(lender_receives)
        .ok_or(StendarError::ArithmeticOverflow)?;

    let contribution_key = ctx.accounts.contribution.key();
    let contract = &mut ctx.accounts.contract;
    contract.outstanding_balance = contract
        .outstanding_balance
        .checked_sub(recall_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.collateral_amount = contract
        .collateral_amount
        .checked_sub(proportional_collateral)
        .ok_or(StendarError::ArithmeticOverflow)?;
    contract.funded_amount = contract
        .funded_amount
        .checked_sub(recall_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;

    let contribution = &mut ctx.accounts.contribution;
    contribution.is_refunded = true;
    let recalled_lender = contribution.lender;

    let index = contract
        .contributions
        .iter()
        .position(|key| *key == contribution_key)
        .ok_or(StendarError::InvalidContribution)?;
    contract.contributions.swap_remove(index);
    contract.num_contributions = u32::try_from(contract.contributions.len())
        .map_err(|_| error!(StendarError::ArithmeticOverflow))?;

    contract.status = if contract.outstanding_balance == 0 || contract.contributions.is_empty() {
        ContractStatus::Completed
    } else {
        ContractStatus::Active
    };
    contract.update_bot_tracking(current_time);
    let contract_seed = contract.contract_seed;

    let proposal = &mut ctx.accounts.proposal;
    proposal.recalls_processed = proposal
        .recalls_processed
        .checked_add(1)
        .ok_or(StendarError::ArithmeticOverflow)?;

    let state = &mut ctx.accounts.state;
    state.total_debt = state
        .total_debt
        .checked_sub(recall_amount)
        .ok_or(StendarError::ArithmeticOverflow)?;
    state.total_collateral = state
        .total_collateral
        .checked_sub(proportional_collateral)
        .ok_or(StendarError::ArithmeticOverflow)?;

    treasury.total_recall_fees = treasury
        .total_recall_fees
        .checked_add(treasury_recall_received)
        .ok_or(StendarError::ArithmeticOverflow)?;

    msg!(
        "Processed proposal recall for lender {} on contract {}, amount {}, fee {}",
        recalled_lender,
        contract_seed,
        recall_amount,
        recall_fee
    );

    Ok(())
}

pub fn close_proposal_accounts(
    ctx: Context<CloseProposalAccounts>,
    _proposal_id: u64,
) -> Result<()> {
    let proposal = &ctx.accounts.proposal;
    require!(!proposal.is_pending(), StendarError::ProposalNotPending);

    // Defensive reset in case a stale flag remains.
    if ctx.accounts.contract.has_active_proposal {
        ctx.accounts.contract.has_active_proposal = false;
    }

    Ok(())
}
