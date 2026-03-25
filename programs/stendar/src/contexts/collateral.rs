use crate::errors::StendarError;
use crate::state::{
    CollateralRegistry, MockOraclePriceFeed, State, TestClockOffset, COLLATERAL_REGISTRY_SEED,
    MOCK_ORACLE_PRICE_FEED_SEED, TEST_CLOCK_OFFSET_SEED,
};
use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

#[derive(Accounts)]
pub struct InitializeCollateralRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"global_state"],
        bump,
        has_one = authority @ StendarError::InvalidAuthority
    )]
    pub state: Account<'info, State>,
    #[account(
        init,
        payer = authority,
        space = CollateralRegistry::LEN,
        seeds = [COLLATERAL_REGISTRY_SEED],
        bump
    )]
    pub collateral_registry: Account<'info, CollateralRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddCollateralType<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"global_state"],
        bump,
        has_one = authority @ StendarError::InvalidAuthority
    )]
    pub state: Account<'info, State>,
    #[account(
        mut,
        seeds = [COLLATERAL_REGISTRY_SEED],
        bump
    )]
    pub collateral_registry: Account<'info, CollateralRegistry>,
    pub collateral_mint: Account<'info, Mint>,
    /// CHECK: Owner/structure are validated when registering this collateral type.
    #[account(
        constraint = oracle_price_feed.owner == &pyth_solana_receiver_sdk::id()
            || oracle_price_feed.owner == &crate::ID
            @ StendarError::OraclePriceUnavailable
    )]
    pub oracle_price_feed: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateCollateralType<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"global_state"],
        bump,
        has_one = authority @ StendarError::InvalidAuthority
    )]
    pub state: Account<'info, State>,
    #[account(
        mut,
        seeds = [COLLATERAL_REGISTRY_SEED],
        bump
    )]
    pub collateral_registry: Account<'info, CollateralRegistry>,
    /// CHECK: Optional oracle feed account used when updating the oracle feed pubkey.
    pub oracle_price_feed: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
pub struct DeactivateCollateralType<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"global_state"],
        bump,
        has_one = authority @ StendarError::InvalidAuthority
    )]
    pub state: Account<'info, State>,
    #[account(
        mut,
        seeds = [COLLATERAL_REGISTRY_SEED],
        bump
    )]
    pub collateral_registry: Account<'info, CollateralRegistry>,
}

#[derive(Accounts)]
#[instruction(feed_seed: u64)]
pub struct InitializeMockOraclePriceFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"global_state"],
        bump,
        has_one = authority @ StendarError::InvalidAuthority
    )]
    pub state: Account<'info, State>,
    #[account(
        init,
        payer = authority,
        space = MockOraclePriceFeed::LEN,
        seeds = [MOCK_ORACLE_PRICE_FEED_SEED, &feed_seed.to_le_bytes()],
        bump
    )]
    pub mock_oracle_price_feed: Account<'info, MockOraclePriceFeed>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetMockOraclePriceFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"global_state"],
        bump,
        has_one = authority @ StendarError::InvalidAuthority
    )]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub mock_oracle_price_feed: Account<'info, MockOraclePriceFeed>,
}

#[derive(Accounts)]
pub struct InitializeTestClockOffset<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"global_state"],
        bump,
        has_one = authority @ StendarError::InvalidAuthority
    )]
    pub state: Account<'info, State>,
    #[account(
        init,
        payer = authority,
        space = TestClockOffset::LEN,
        seeds = [TEST_CLOCK_OFFSET_SEED],
        bump
    )]
    pub test_clock_offset: Account<'info, TestClockOffset>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetTestClockOffset<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"global_state"],
        bump,
        has_one = authority @ StendarError::InvalidAuthority
    )]
    pub state: Account<'info, State>,
    #[account(
        mut,
        seeds = [TEST_CLOCK_OFFSET_SEED],
        bump
    )]
    pub test_clock_offset: Account<'info, TestClockOffset>,
}
