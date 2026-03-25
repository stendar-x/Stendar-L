use crate::errors::StendarError;
use crate::state::{
    DebtContract, ProposerCooldown, ProposalVote, TermAmendmentProposal, PROPOSER_COOLDOWN_SEED,
    PROPOSAL_VOTE_SEED, TERM_PROPOSAL_SEED,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct CreateTermProposal<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        init,
        payer = proposer,
        space = TermAmendmentProposal::LEN,
        seeds = [TERM_PROPOSAL_SEED, contract.key().as_ref(), &proposal_id.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, TermAmendmentProposal>,
    #[account(
        init,
        payer = proposer,
        space = ProposalVote::LEN,
        seeds = [PROPOSAL_VOTE_SEED, proposal.key().as_ref(), proposer.key().as_ref()],
        bump
    )]
    pub proposer_vote: Account<'info, ProposalVote>,
    #[account(
        init_if_needed,
        payer = proposer,
        space = ProposerCooldown::LEN,
        seeds = [PROPOSER_COOLDOWN_SEED, contract.key().as_ref(), proposer.key().as_ref()],
        bump
    )]
    pub proposer_cooldown: Account<'info, ProposerCooldown>,
    #[account(mut)]
    pub proposer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct VoteOnProposal<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        seeds = [TERM_PROPOSAL_SEED, contract.key().as_ref(), &proposal_id.to_le_bytes()],
        bump,
        constraint = proposal.contract == contract.key() @ StendarError::InvalidContractReference
    )]
    pub proposal: Account<'info, TermAmendmentProposal>,
    #[account(
        init_if_needed,
        payer = voter,
        space = ProposalVote::LEN,
        seeds = [PROPOSAL_VOTE_SEED, proposal.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub vote: Account<'info, ProposalVote>,
    #[account(
        init_if_needed,
        payer = voter,
        space = ProposerCooldown::LEN,
        seeds = [PROPOSER_COOLDOWN_SEED, contract.key().as_ref(), proposal.proposer.as_ref()],
        bump
    )]
    pub proposer_cooldown: Account<'info, ProposerCooldown>,
    #[account(mut)]
    pub voter: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct CancelTermProposal<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        seeds = [TERM_PROPOSAL_SEED, contract.key().as_ref(), &proposal_id.to_le_bytes()],
        bump,
        constraint = proposal.contract == contract.key() @ StendarError::InvalidContractReference
    )]
    pub proposal: Account<'info, TermAmendmentProposal>,
    #[account(
        mut,
        constraint = proposer.key() == proposal.proposer @ StendarError::UnauthorizedProposalCancel
    )]
    pub proposer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct ExpireTermProposal<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        seeds = [TERM_PROPOSAL_SEED, contract.key().as_ref(), &proposal_id.to_le_bytes()],
        bump,
        constraint = proposal.contract == contract.key() @ StendarError::InvalidContractReference
    )]
    pub proposal: Account<'info, TermAmendmentProposal>,
    #[account(
        init_if_needed,
        payer = executor,
        space = ProposerCooldown::LEN,
        seeds = [PROPOSER_COOLDOWN_SEED, contract.key().as_ref(), proposal.proposer.as_ref()],
        bump
    )]
    pub proposer_cooldown: Account<'info, ProposerCooldown>,
    #[account(mut)]
    pub executor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct CloseProposalAccounts<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        mut,
        close = proposer_receiver,
        seeds = [TERM_PROPOSAL_SEED, contract.key().as_ref(), &proposal_id.to_le_bytes()],
        bump,
        constraint = proposal.contract == contract.key() @ StendarError::InvalidContractReference
    )]
    pub proposal: Account<'info, TermAmendmentProposal>,
    /// CHECK: Receives proposal rent; must be original proposer.
    #[account(mut, address = proposal.proposer)]
    pub proposer_receiver: AccountInfo<'info>,
}
