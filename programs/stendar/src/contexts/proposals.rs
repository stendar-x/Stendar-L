use crate::errors::StendarError;
#[cfg(feature = "testing")]
use crate::state::TestClockOffset;
use crate::state::{
    DebtContract, LenderContribution, LenderEscrow, ProposalVote, ProposerCooldown, State,
    TermAmendmentProposal, Treasury, PROPOSAL_VOTE_SEED, PROPOSER_COOLDOWN_SEED,
    TERM_PROPOSAL_SEED, TREASURY_SEED,
};
use crate::utils::MAX_LENDERS_PER_TX;
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct CreateTermProposal<'info> {
    #[account(mut)]
    pub contract: Account<'info, DebtContract>,
    #[account(
        init,
        payer = proposer,
        space = TermAmendmentProposal::space(
            (if contract.max_lenders == 0 {
                MAX_LENDERS_PER_TX
            } else {
                contract.max_lenders
            }) as usize + 1
        ),
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
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
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
    pub voter_contribution: Option<Account<'info, LenderContribution>>,
    #[account(
        init_if_needed,
        payer = voter,
        space = ProposerCooldown::LEN,
        seeds = [PROPOSER_COOLDOWN_SEED, contract.key().as_ref(), proposal.proposer.as_ref()],
        bump
    )]
    pub proposer_cooldown: Account<'info, ProposerCooldown>,
    #[account(
        seeds = [b"global_state"],
        bump
    )]
    pub state: Account<'info, State>,
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
    /// Original proposer must authorize account closure and receives proposal rent.
    #[account(mut, address = proposal.proposer)]
    pub proposer_receiver: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct ProcessProposalRecall<'info> {
    #[account(mut)]
    pub contract: Box<Account<'info, DebtContract>>,
    #[account(
        mut,
        seeds = [TERM_PROPOSAL_SEED, contract.key().as_ref(), &proposal_id.to_le_bytes()],
        bump,
        constraint = proposal.contract == contract.key() @ StendarError::InvalidContractReference
    )]
    pub proposal: Box<Account<'info, TermAmendmentProposal>>,
    #[account(
        constraint = vote.proposal == proposal.key() @ StendarError::InvalidContractReference,
    )]
    pub vote: Box<Account<'info, ProposalVote>>,
    pub bot_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
    )]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        mut,
        constraint = contribution.contract == contract.key() @ StendarError::InvalidContribution,
        constraint = !contribution.is_refunded @ StendarError::AlreadyRefunded,
    )]
    pub contribution: Box<Account<'info, LenderContribution>>,
    #[account(
        mut,
        constraint = escrow.contract == contract.key() @ StendarError::InvalidContribution,
        constraint = escrow.lender == contribution.lender @ StendarError::UnauthorizedClaim,
    )]
    pub escrow: Box<Account<'info, LenderEscrow>>,
    #[account(
        mut,
        constraint = bot_usdc_ata.owner == bot_authority.key() @ StendarError::UnauthorizedBotOperation,
        constraint = bot_usdc_ata.mint == contract.loan_mint @ StendarError::TokenAccountMismatch,
    )]
    pub bot_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = escrow_usdc_ata.owner == escrow.key() @ StendarError::TokenAccountMismatch,
        constraint = escrow_usdc_ata.mint == contract.loan_mint @ StendarError::TokenAccountMismatch,
    )]
    pub escrow_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = treasury.treasury_usdc_account == Pubkey::default() || treasury_usdc_ata.key() == treasury.treasury_usdc_account @ StendarError::TokenAccountMismatch,
        constraint = treasury_usdc_ata.mint == contract.loan_mint @ StendarError::TokenAccountMismatch,
    )]
    pub treasury_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = contract_collateral_ata.key() == contract.collateral_token_account @ StendarError::TokenAccountMismatch,
        constraint = contract_collateral_ata.mint == contract.collateral_mint @ StendarError::TokenAccountMismatch,
    )]
    pub contract_collateral_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = bot_collateral_ata.owner == bot_authority.key() @ StendarError::UnauthorizedBotOperation,
        constraint = bot_collateral_ata.mint == contract.collateral_mint @ StendarError::TokenAccountMismatch,
    )]
    pub bot_collateral_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: Borrower reference validation for contract consistency.
    #[account(
        constraint = borrower.key() == contract.borrower @ StendarError::InvalidContractReference,
    )]
    pub borrower: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"global_state"],
        bump
    )]
    pub state: Box<Account<'info, State>>,
    #[cfg(feature = "testing")]
    pub test_clock_offset: Option<Box<Account<'info, TestClockOffset>>>,
    #[account(mut)]
    pub frontend_usdc_ata: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
