use borsh::BorshSerialize;
use solana_sdk::account::{AccountSharedData, ReadableAccount};
use solana_sdk::clock::Clock;
use solana_sdk::hash::hash;
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use trident_fuzz::fuzzing::Trident;
use trident_fuzz::traits::FuzzClient;

pub const TOKEN_PROGRAM_STR: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const ASSOCIATED_TOKEN_PROGRAM_STR: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const PYTH_RECEIVER_PROGRAM_STR: &str = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

#[derive(BorshSerialize)]
struct CollateralTypeSnapshot {
    mint: Pubkey,
    oracle_price_feed: Pubkey,
    decimals: u8,
    liquidation_buffer_bps: u16,
    min_committed_floor_bps: u16,
    is_active: bool,
}

#[derive(BorshSerialize)]
struct CollateralRegistrySnapshot {
    authority: Pubkey,
    num_collateral_types: u8,
    collateral_types: Vec<CollateralTypeSnapshot>,
    _reserved: [u8; 96],
    account_version: u16,
}

pub fn token_program_id() -> Pubkey {
    Pubkey::from_str(TOKEN_PROGRAM_STR).expect("token program")
}

pub fn associated_token_program_id() -> Pubkey {
    Pubkey::from_str(ASSOCIATED_TOKEN_PROGRAM_STR).expect("ata program")
}

pub fn pyth_receiver_program_id() -> Pubkey {
    Pubkey::from_str(PYTH_RECEIVER_PROGRAM_STR).expect("pyth receiver program")
}

fn anchor_account_discriminator(name: &str) -> [u8; 8] {
    let preimage = format!("account:{name}");
    let digest = hash(preimage.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest.to_bytes()[..8]);
    out
}

pub fn current_timestamp(trident: &mut Trident) -> i64 {
    trident.get_client().get_sysvar::<Clock>().unix_timestamp
}

pub fn ensure_mint_account(
    trident: &mut Trident,
    address: &Pubkey,
    mint_authority: &Pubkey,
    decimals: u8,
) {
    let token_program = token_program_id();
    let existing = trident.get_client().get_account(address);
    if existing.owner() == &token_program && existing.data().len() == 82 {
        let data = existing.data();
        let authority_matches = data.get(4..36) == Some(mint_authority.as_ref());
        let decimals_match = data.get(44).copied() == Some(decimals);
        let initialized = data.get(45).copied() == Some(1u8);
        if authority_matches && decimals_match && initialized {
            return;
        }
    }

    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(mint_authority.as_ref());
    data[36..44].copy_from_slice(&1_000_000_000_000u64.to_le_bytes());
    data[44] = decimals;
    data[45] = 1;
    data[46..50].copy_from_slice(&0u32.to_le_bytes());

    let mut account = AccountSharedData::new(1_000_000_000, 82, &token_program);
    account.set_data_from_slice(&data);
    trident.get_client().set_account_custom(address, &account);
}

pub fn ensure_token_account(
    trident: &mut Trident,
    address: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
) {
    let token_program = token_program_id();
    let existing = trident.get_client().get_account(address);
    if existing.owner() == &token_program && existing.data().len() == 165 {
        let data = existing.data();
        let mint_matches = data.get(0..32) == Some(mint.as_ref());
        let owner_matches = data.get(32..64) == Some(owner.as_ref());
        let initialized = data.get(108).copied() == Some(1u8);
        if mint_matches && owner_matches && initialized {
            return;
        }
    }

    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[72..76].copy_from_slice(&0u32.to_le_bytes());
    data[108] = 1;
    data[109..113].copy_from_slice(&0u32.to_le_bytes());
    data[121..129].copy_from_slice(&0u64.to_le_bytes());
    data[129..133].copy_from_slice(&0u32.to_le_bytes());

    let mut account = AccountSharedData::new(1_000_000_000, 165, &token_program);
    account.set_data_from_slice(&data);
    trident.get_client().set_account_custom(address, &account);
}

pub fn ensure_pyth_price_feed(
    trident: &mut Trident,
    address: &Pubkey,
    price: i64,
    conf: u64,
    exponent: i32,
    publish_time: i64,
) {
    let mut data = Vec::new();
    data.extend_from_slice(&anchor_account_discriminator("PriceUpdateV2"));
    data.extend_from_slice(&Pubkey::default().to_bytes());
    data.push(1); // VerificationLevel::Full
    data.extend_from_slice(&[0u8; 32]); // feed_id
    data.extend_from_slice(&price.to_le_bytes());
    data.extend_from_slice(&conf.to_le_bytes());
    data.extend_from_slice(&exponent.to_le_bytes());
    data.extend_from_slice(&publish_time.to_le_bytes());
    data.extend_from_slice(&(publish_time - 1).to_le_bytes()); // prev_publish_time
    data.extend_from_slice(&price.to_le_bytes()); // ema_price
    data.extend_from_slice(&0u64.to_le_bytes()); // ema_conf
    data.extend_from_slice(&0u64.to_le_bytes()); // posted_slot

    let mut account =
        AccountSharedData::new(1_000_000_000, data.len(), &pyth_receiver_program_id());
    account.set_data_from_slice(&data);
    trident.get_client().set_account_custom(address, &account);
}

pub fn ensure_collateral_registry_account(
    trident: &mut Trident,
    address: &Pubkey,
    authority: &Pubkey,
    collateral_mint: &Pubkey,
    oracle_price_feed: &Pubkey,
    owner_program_id: &Pubkey,
) {
    let registry = CollateralRegistrySnapshot {
        authority: *authority,
        num_collateral_types: 1,
        collateral_types: vec![CollateralTypeSnapshot {
            mint: *collateral_mint,
            oracle_price_feed: *oracle_price_feed,
            decimals: 6,
            liquidation_buffer_bps: 500,
            min_committed_floor_bps: 10_500,
            is_active: true,
        }],
        _reserved: [0u8; 96],
        account_version: 1,
    };

    let mut payload = Vec::new();
    payload.extend_from_slice(&anchor_account_discriminator("CollateralRegistry"));
    payload.extend_from_slice(&borsh::to_vec(&registry).expect("serialize collateral registry"));

    let mut account = AccountSharedData::new(1_000_000_000, payload.len(), owner_program_id);
    account.set_data_from_slice(&payload);
    trident.get_client().set_account_custom(address, &account);
}
