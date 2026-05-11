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
- Supports both full and partial listings (`listing_amount <= contribution.contribution_amount`).
- Automatically sets `ListingType::FullPosition` or `ListingType::PartialPosition` based on the amount.
- Validates that any remaining position after a partial listing is at least `MIN_LISTING_AMOUNT` (no dust).
- **Nonce reuse:** The `nonce: u8` is part of the listing PDA seed. Once a listing is closed or cancelled, the same nonce value can be reused for a new listing by the same seller. Callers should use a monotonically increasing nonce per contribution to keep off-chain indexing unambiguous.

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
- Offers must match the listing amount exactly (`purchase_amount == listing.listing_amount`).

### `accept_trade_offer`

```rust
pub fn accept_trade_offer(ctx: Context<AcceptTradeOffer>, nonce: u8) -> Result<()>
```

- Seller accepts one active offer.
- The `DebtContract` account is mutable — partial trades increment `num_contributions` and enforce `max_lenders`.
- Transfers the position (or a portion) to the buyer and emits a `TradeEvent`.
- For partial fills, `TradeType::PartialFill` is recorded; for full fills, the original `TradeType::AcceptedOffer` is preserved.
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
- Supports both full and partial transfers (`transfer_amount <= contribution.contribution_amount`).
- Validates minimum remainder and enforces lender cap for partial transfers.
- Updates contribution/escrow ownership and writes a transfer event.

## Partial Position Trading

Both `create_trade_listing` and `transfer_lender_position` support partial amounts. The core rules:

- **Minimum listing/transfer amount**: Must be at least `MIN_LISTING_AMOUNT` (defined in `state/mod.rs`).
- **Minimum remainder**: If a partial listing/transfer leaves a remainder, that remainder must also be at least `MIN_LISTING_AMOUNT`. This prevents dust positions.
- **Lender cap**: Partial trades create a new `LenderContribution` account, so `num_contributions` is incremented and checked against `max_lenders` (borrower-selected at creation, protocol-capped at 100). For legacy contracts where `max_lenders` is unset (`0`), the fallback remains `MAX_LENDERS_PER_TX = 14`. Full transfers are a 1-for-1 swap and do not increment the count.
- **Escrow splitting**: `compute_transfer_computation` proportionally divides `escrow_amount`, `available_interest`, and `available_principal` between seller and buyer based on the transfer ratio.
- **Offer matching**: Offers must match the listing amount exactly — partial offers against a listing are not supported.

## Important Constraints

- PDA uniqueness for listings/offers is currently nonce-based (`u8`).
- Trades depend on contract/contribution status checks from `validate_trade_conditions`.
- Solana's atomic transaction model prevents race conditions on `num_contributions`.

## Related Files

- `programs/stendar/src/instructions/trading.rs`
- `programs/stendar/src/contexts/trading.rs`
- `programs/stendar/src/state/trading.rs`
