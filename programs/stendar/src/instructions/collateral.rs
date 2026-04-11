use crate::contexts::*;
use crate::errors::StendarError;
use crate::state::{CollateralRegistry, CollateralType};
use crate::utils::validate_price_feed_registration_account;
use anchor_lang::prelude::*;

const MAX_LIQUIDATION_BUFFER_BPS: u16 = 2_000;

fn validate_authority(signer: Pubkey, state_authority: Pubkey) -> Result<()> {
    require!(
        signer == state_authority,
        StendarError::UnauthorizedAuthorityUpdate
    );
    Ok(())
}

fn validate_registry_authority(registry_authority: Pubkey, state_authority: Pubkey) -> Result<()> {
    require!(
        registry_authority == state_authority,
        StendarError::UnauthorizedAuthorityUpdate
    );
    Ok(())
}

fn validate_collateral_values(
    liquidation_buffer_bps: u16,
    min_committed_floor_bps: u16,
) -> Result<()> {
    require!(
        liquidation_buffer_bps > 0 && liquidation_buffer_bps <= MAX_LIQUIDATION_BUFFER_BPS,
        StendarError::InvalidLiquidationBuffer
    );
    require!(min_committed_floor_bps > 0, StendarError::InvalidMinFloor);
    Ok(())
}

fn validate_oracle_price_feed_account(
    expected_feed_key: Pubkey,
    oracle_price_feed: &AccountInfo,
) -> Result<()> {
    require!(
        oracle_price_feed.key() == expected_feed_key,
        StendarError::OraclePriceFeedMismatch
    );
    validate_price_feed_registration_account(oracle_price_feed)
}

fn validate_oracle_feed_owner_for_environment(oracle_price_feed: &AccountInfo) -> Result<()> {
    #[cfg(not(feature = "testing"))]
    {
        require!(
            oracle_price_feed.owner == &pyth_solana_receiver_sdk::id(),
            StendarError::OraclePriceUnavailable
        );
    }

    #[cfg(feature = "testing")]
    {
        require!(
            oracle_price_feed.owner == &pyth_solana_receiver_sdk::id()
                || oracle_price_feed.owner == &crate::ID,
            StendarError::OraclePriceUnavailable
        );
    }

    Ok(())
}

pub fn initialize_collateral_registry(ctx: Context<InitializeCollateralRegistry>) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    validate_authority(authority, ctx.accounts.state.authority)?;

    let registry = &mut ctx.accounts.collateral_registry;
    registry.authority = authority;
    registry.num_collateral_types = 0;
    registry.collateral_types = vec![];
    Ok(())
}

pub fn add_collateral_type(
    ctx: Context<AddCollateralType>,
    oracle_price_feed: Pubkey,
    decimals: u8,
    liquidation_buffer_bps: u16,
    min_committed_floor_bps: u16,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let state_authority = ctx.accounts.state.authority;
    validate_authority(authority, state_authority)?;

    let registry = &mut ctx.accounts.collateral_registry;
    validate_registry_authority(registry.authority, state_authority)?;

    require!(
        (registry.num_collateral_types as usize) < CollateralRegistry::MAX_COLLATERAL_TYPES,
        StendarError::CollateralRegistryFull
    );

    let mint = ctx.accounts.collateral_mint.key();
    require!(
        registry.find_collateral_type(&mint).is_none(),
        StendarError::CollateralTypeAlreadyExists
    );

    validate_collateral_values(liquidation_buffer_bps, min_committed_floor_bps)?;

    require!(
        decimals == ctx.accounts.collateral_mint.decimals,
        StendarError::DecimalsMismatch
    );
    validate_oracle_feed_owner_for_environment(&ctx.accounts.oracle_price_feed)?;
    validate_oracle_price_feed_account(oracle_price_feed, &ctx.accounts.oracle_price_feed)?;

    registry.collateral_types.push(CollateralType {
        mint,
        oracle_price_feed,
        decimals,
        liquidation_buffer_bps,
        min_committed_floor_bps,
        is_active: true,
    });
    registry.num_collateral_types = registry.collateral_types.len() as u8;
    Ok(())
}

pub fn update_collateral_type(
    ctx: Context<UpdateCollateralType>,
    mint: Pubkey,
    new_oracle_price_feed: Option<Pubkey>,
    new_liquidation_buffer_bps: Option<u16>,
    new_min_committed_floor_bps: Option<u16>,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let state_authority = ctx.accounts.state.authority;
    validate_authority(authority, state_authority)?;

    let registry = &mut ctx.accounts.collateral_registry;
    validate_registry_authority(registry.authority, state_authority)?;

    let collateral_type = registry
        .collateral_types
        .iter_mut()
        .find(|collateral_type| collateral_type.mint == mint)
        .ok_or(error!(StendarError::CollateralTypeNotFound))?;

    if let Some(oracle_price_feed) = new_oracle_price_feed {
        let oracle_price_feed_account = ctx
            .accounts
            .oracle_price_feed
            .as_ref()
            .ok_or(error!(StendarError::OraclePriceUnavailable))?;
        validate_oracle_price_feed_account(oracle_price_feed, oracle_price_feed_account)?;
        collateral_type.oracle_price_feed = oracle_price_feed;
    }

    if let Some(liquidation_buffer_bps) = new_liquidation_buffer_bps {
        require!(
            liquidation_buffer_bps > 0 && liquidation_buffer_bps <= MAX_LIQUIDATION_BUFFER_BPS,
            StendarError::InvalidLiquidationBuffer
        );
        collateral_type.liquidation_buffer_bps = liquidation_buffer_bps;
    }

    if let Some(min_committed_floor_bps) = new_min_committed_floor_bps {
        require!(min_committed_floor_bps > 0, StendarError::InvalidMinFloor);
        collateral_type.min_committed_floor_bps = min_committed_floor_bps;
    }

    Ok(())
}

pub fn deactivate_collateral_type(
    ctx: Context<DeactivateCollateralType>,
    mint: Pubkey,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let state_authority = ctx.accounts.state.authority;
    validate_authority(authority, state_authority)?;

    let registry = &mut ctx.accounts.collateral_registry;
    validate_registry_authority(registry.authority, state_authority)?;

    let collateral_type = registry
        .collateral_types
        .iter_mut()
        .find(|collateral_type| collateral_type.mint == mint)
        .ok_or(error!(StendarError::CollateralTypeNotFound))?;
    collateral_type.is_active = false;

    Ok(())
}

#[cfg(feature = "testing")]
pub fn reset_collateral_registry(ctx: Context<DeactivateCollateralType>) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let state_authority = ctx.accounts.state.authority;
    validate_authority(authority, state_authority)?;

    let registry = &mut ctx.accounts.collateral_registry;
    validate_registry_authority(registry.authority, state_authority)?;

    registry.collateral_types.clear();
    registry.num_collateral_types = 0;
    Ok(())
}

#[cfg(feature = "testing")]
pub fn reset_treasury_usdc_mint(
    ctx: Context<ResetTreasuryUsdcMint>,
    usdc_mint: Pubkey,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    validate_authority(authority, ctx.accounts.state.authority)?;

    let treasury = &mut ctx.accounts.treasury;
    treasury.usdc_mint = usdc_mint;
    if usdc_mint != Pubkey::default() {
        let treasury_key = treasury.key();
        treasury.treasury_usdc_account =
            anchor_spl::associated_token::get_associated_token_address(&treasury_key, &usdc_mint);
    } else {
        treasury.treasury_usdc_account = Pubkey::default();
    }
    Ok(())
}

#[cfg(feature = "testing")]
pub fn initialize_mock_oracle_price_feed(
    ctx: Context<InitializeMockOraclePriceFeed>,
    feed_seed: u64,
    price: i64,
    exponent: i32,
    publish_time: i64,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let state_authority = ctx.accounts.state.authority;
    validate_authority(authority, state_authority)?;
    require!(price > 0, StendarError::OraclePriceNegative);

    let feed = &mut ctx.accounts.mock_oracle_price_feed;
    feed.authority = authority;
    feed.feed_seed = feed_seed;
    feed.price = price;
    feed.exponent = exponent;
    feed.publish_time = publish_time;
    Ok(())
}

#[cfg(feature = "testing")]
pub fn set_mock_oracle_price_feed(
    ctx: Context<SetMockOraclePriceFeed>,
    price: i64,
    exponent: i32,
    publish_time: i64,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let state_authority = ctx.accounts.state.authority;
    validate_authority(authority, state_authority)?;
    require!(price > 0, StendarError::OraclePriceNegative);

    let feed = &mut ctx.accounts.mock_oracle_price_feed;
    require!(
        feed.authority == state_authority,
        StendarError::UnauthorizedAuthorityUpdate
    );
    feed.price = price;
    feed.exponent = exponent;
    feed.publish_time = publish_time;
    Ok(())
}

#[cfg(feature = "testing")]
pub fn initialize_test_clock_offset(
    ctx: Context<InitializeTestClockOffset>,
    offset_seconds: i64,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let state_authority = ctx.accounts.state.authority;
    validate_authority(authority, state_authority)?;

    let test_clock = &mut ctx.accounts.test_clock_offset;
    test_clock.authority = authority;
    test_clock.offset_seconds = offset_seconds;
    Ok(())
}

#[cfg(feature = "testing")]
pub fn set_test_clock_offset(ctx: Context<SetTestClockOffset>, offset_seconds: i64) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let state_authority = ctx.accounts.state.authority;
    validate_authority(authority, state_authority)?;

    let test_clock = &mut ctx.accounts.test_clock_offset;
    require!(
        test_clock.authority == state_authority,
        StendarError::UnauthorizedAuthorityUpdate
    );
    test_clock.offset_seconds = offset_seconds;
    Ok(())
}
