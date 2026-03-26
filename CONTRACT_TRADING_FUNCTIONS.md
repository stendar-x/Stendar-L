# Trading Contract Functions (Current Behavior)

This document reflects the current on-chain implementation in `programs/stendar/src/instructions/trading.rs`.

## Core Instructions

### `create_trade_listing`

```rust
pub fn create_trade_listing(
    ctx: Context<CreateTradeListing>,
    listing_amount: u64,
    asking_price: u64,
    expires_at: i64,
    nonce: u8,
) -> Result<()>
```

- Creates a `TradeListing` PDA for a lender contribution.
- Requires the seller to own the contribution and the contract to be in `Active` status.
- Enforces full-position listings (`listing_amount == contribution.contribution_amount`).

### `create_trade_offer`

```rust
pub fn create_trade_offer(
    ctx: Context<CreateTradeOffer>,
    purchase_amount: u64,
    offered_price: u64,
    expires_at: i64,
    nonce: u8,
) -> Result<()>
```

- Creates a `TradeOffer` PDA for an existing listing.
- Requires active listing and valid offer window.
- Enforces full-position offers (`purchase_amount == listing.listing_amount`).

### `accept_trade_offer`

```rust
pub fn accept_trade_offer(ctx: Context<AcceptTradeOffer>, nonce: u8) -> Result<()>
```

- Seller accepts one active offer.
- Transfers lender position to buyer and emits a `TradeEvent`.
- Closes listing and accepted offer accounts.

### `cancel_trade_listing`

```rust
pub fn cancel_trade_listing(ctx: Context<CancelTradeListing>) -> Result<()>
```

- Marks listing inactive.
- Only listing seller can cancel.

### `transfer_lender_position`

```rust
pub fn transfer_lender_position(
    ctx: Context<TransferLenderPosition>,
    transfer_amount: u64,
    sale_price: u64,
    nonce: u8,
) -> Result<()>
```

- Direct transfer path without marketplace offer acceptance.
- Enforces full transfer only (`transfer_amount == contribution.contribution_amount`).
- Updates contribution/escrow ownership and writes a transfer event.

## Important Constraints

- Partial position trading is **not** currently implemented.
- PDA uniqueness for listings/offers is currently nonce-based (`u8`).
- Trades depend on contract/contribution status checks from `validate_trade_conditions`.

## Related Files

- `programs/stendar/src/instructions/trading.rs`
- `programs/stendar/src/contexts/trading.rs`
- `programs/stendar/src/state/trading.rs`
