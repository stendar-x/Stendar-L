use super::ACCOUNT_RESERVED_BYTES;
use anchor_lang::prelude::*;

// Constants for trading operations
// Keep secondary-market minimum aligned with primary-market minimum (0.01 USDC).
pub const MIN_LISTING_AMOUNT: u64 = 10_000; // 0.01 USDC in 6-decimal atomic units
pub const PLATFORM_FEE_BASIS_POINTS: u16 = 10; // 0.1%

/// Trade listing account for secondary market
///
/// Represents a lender's position listed for sale in the secondary market.
/// MVP mode currently supports full-position listings only.
#[account]
pub struct TradeListing {
    /// Contract this listing is for
    pub contract: Pubkey,
    /// Seller's wallet address
    pub seller: Pubkey,
    /// Original contribution account being sold
    pub contribution: Pubkey,
    /// Amount being listed for sale (must be full position in MVP mode)
    pub listing_amount: u64,
    /// Asking price for the listing
    pub asking_price: u64,
    /// Whether this is a full or partial position sale.
    /// MVP mode enforces `FullPosition`.
    pub listing_type: ListingType,
    /// When this listing was created
    pub created_at: i64,
    /// When this listing expires (unix timestamp, required).
    pub expires_at: i64,
    /// Whether this listing is currently active
    pub is_active: bool,
    /// Number of offers received on this listing
    pub offer_count: u32,
    /// Highest offer received (for display purposes)
    pub highest_offer: u64,
    /// Listing nonce for PDA derivation
    pub nonce: u8,
    pub _reserved: [u8; ACCOUNT_RESERVED_BYTES],
    pub account_version: u16,
}

impl TradeListing {
    pub const LEN: usize =
        8 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 8 + 1 + 4 + 8 + 1 + ACCOUNT_RESERVED_BYTES + 2;

    /// Check if the listing is still valid
    pub fn is_valid(&self, current_time: i64) -> bool {
        self.is_active && self.expires_at > 0 && current_time < self.expires_at
    }

    /// Calculate platform fee for this listing
    pub fn calculate_platform_fee(&self, sale_price: u64) -> Result<u64> {
        crate::utils::calculate_secondary_market_fee(sale_price)
    }
}

/// Trade offer account for counter-offers
///
/// Represents a buyer's offer on a trade listing.
/// Allows for negotiation between buyer and seller.
#[account]
pub struct TradeOffer {
    /// The trade listing this offer is for
    pub listing: Pubkey,
    /// Buyer's wallet address
    pub buyer: Pubkey,
    /// Amount buyer wants to purchase
    pub purchase_amount: u64,
    /// Offered price for the purchase
    pub offered_price: u64,
    /// When this offer was created
    pub created_at: i64,
    /// When this offer expires
    pub expires_at: i64,
    /// Whether this offer is still active
    pub is_active: bool,
    /// Offer nonce for PDA derivation
    pub nonce: u8,
    pub _reserved: [u8; ACCOUNT_RESERVED_BYTES],
    pub account_version: u16,
}

impl TradeOffer {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + ACCOUNT_RESERVED_BYTES + 2;

    /// Check if the offer is still valid
    pub fn is_valid(&self, current_time: i64) -> bool {
        self.is_active && current_time < self.expires_at
    }
}

/// Trade event for logging completed trades
///
/// Records all successful trades for analytics and history.
/// Immutable record of secondary market activity.
#[account]
pub struct TradeEvent {
    /// Contract the trade was for
    pub contract: Pubkey,
    /// Original contribution account
    pub contribution: Pubkey,
    /// Seller's wallet address
    pub seller: Pubkey,
    /// Buyer's wallet address
    pub buyer: Pubkey,
    /// Amount traded
    pub amount_traded: u64,
    /// Final sale price
    pub sale_price: u64,
    /// Seller-side platform fee collected
    pub platform_fee: u64,
    /// Buyer-side fee collected
    pub buyer_fee: u64,
    /// Type of trade executed
    pub trade_type: TradeType,
    /// When the trade was executed
    pub timestamp: i64,
    /// Event nonce for PDA derivation
    pub nonce: u8,
    pub _reserved: [u8; ACCOUNT_RESERVED_BYTES],
    pub account_version: u16,
}

impl TradeEvent {
    pub const LEN: usize =
        8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 8 + 1 + ACCOUNT_RESERVED_BYTES + 2;
}

/// Listing type enumeration
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ListingType {
    /// Selling entire position
    FullPosition,
    /// Selling partial position
    PartialPosition,
}

/// Trade type enumeration
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum TradeType {
    /// Direct sale at asking price
    DirectSale,
    /// Sale through accepted offer
    AcceptedOffer,
    /// Partial fill of position
    PartialFill,
}

/// Position valuation result
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PositionValuation {
    /// Current fair value estimate
    pub fair_value: u64,
    /// Remaining interest to be earned
    pub remaining_interest: u64,
    /// Remaining principal to be repaid
    pub remaining_principal: u64,
    /// Risk adjustment factor (basis points)
    pub risk_adjustment: u16,
    /// Days remaining in contract
    pub days_remaining: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::CURRENT_ACCOUNT_VERSION;

    #[test]
    fn trade_listing_len_matches_design() {
        let sample = TradeListing {
            contract: Pubkey::new_unique(),
            seller: Pubkey::new_unique(),
            contribution: Pubkey::new_unique(),
            listing_amount: 500_000,
            asking_price: 525_000,
            listing_type: ListingType::FullPosition,
            created_at: 1_700_000_000,
            expires_at: 1_700_604_800,
            is_active: true,
            offer_count: 2,
            highest_offer: 510_000,
            nonce: 1,
            _reserved: [0u8; ACCOUNT_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        };
        let serialized = sample.try_to_vec().expect("serialize TradeListing");
        assert_eq!(serialized.len() + 8, TradeListing::LEN);
    }

    #[test]
    fn trade_offer_len_matches_design() {
        let sample = TradeOffer {
            listing: Pubkey::new_unique(),
            buyer: Pubkey::new_unique(),
            purchase_amount: 400_000,
            offered_price: 410_000,
            created_at: 1_700_000_000,
            expires_at: 1_700_172_800,
            is_active: true,
            nonce: 4,
            _reserved: [0u8; ACCOUNT_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        };
        let serialized = sample.try_to_vec().expect("serialize TradeOffer");
        assert_eq!(serialized.len() + 8, TradeOffer::LEN);
    }

    #[test]
    fn trade_event_len_matches_design() {
        let sample = TradeEvent {
            contract: Pubkey::new_unique(),
            contribution: Pubkey::new_unique(),
            seller: Pubkey::new_unique(),
            buyer: Pubkey::new_unique(),
            amount_traded: 300_000,
            sale_price: 320_000,
            platform_fee: 320,
            buyer_fee: 160,
            trade_type: TradeType::AcceptedOffer,
            timestamp: 1_700_000_000,
            nonce: 9,
            _reserved: [0u8; ACCOUNT_RESERVED_BYTES],
            account_version: CURRENT_ACCOUNT_VERSION,
        };
        let serialized = sample.try_to_vec().expect("serialize TradeEvent");
        assert_eq!(serialized.len() + 8, TradeEvent::LEN);
    }
}
