use anchor_lang::prelude::*;

/// 7 days in seconds — default/max auction epoch duration
pub const AUCTION_EPOCH_SECS: i64 = 604_800;
/// 1 day in seconds — minimum auction epoch duration
pub const AUCTION_MIN_EPOCH_SECS: i64 = 86_400;
/// 1 day in seconds — step size for epoch duration adjustment
pub const AUCTION_STEP_SECS: i64 = 86_400;

pub const AUCTION_CONFIG_SEED: &[u8] = b"auction_config";

/// Singleton PDA that tracks adaptive auction epoch state.
/// Fully permissionless: initialized once, then self-manages via resolve_auction.
/// Seeds: ["auction_config"]
#[account]
pub struct AuctionConfig {
    /// Current sequential epoch number (starts at 1)
    pub current_epoch: u64,
    /// Unix timestamp when current epoch started
    pub current_epoch_start: i64,
    /// Duration of current epoch in seconds (86_400..604_800)
    pub current_epoch_duration: i64,
    /// Total SOL bid in the last resolved epoch (for comparison)
    pub last_total_bid: u64,
    /// PDA bump
    pub bump: u8,
}

impl AuctionConfig {
    pub const SIZE: usize = 8 + // discriminator
        8 +  // current_epoch
        8 +  // current_epoch_start
        8 +  // current_epoch_duration
        8 +  // last_total_bid
        1;   // bump

    /// Returns the end timestamp of the current epoch
    pub fn current_epoch_end(&self) -> i64 {
        self.current_epoch_start + self.current_epoch_duration
    }
}

/// Status of a token listing auction
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum AuctionStatus {
    #[default]
    Active,
    Resolved,
}

/// Permissionless weekly auction round for listing a new token denomination.
/// Epoch = unix_timestamp / AUCTION_EPOCH_SECS (week number since Unix epoch).
/// Auto-initialized on first bid of the week; resolved by anyone (crank) after the week ends.
#[account]
pub struct AuctionState {
    /// Week number (unix_timestamp / 604800)
    pub epoch: u64,
    /// Unix timestamp when this epoch starts (epoch * 604800)
    pub start_time: i64,
    /// Unix timestamp when this epoch ends ((epoch + 1) * 604800)
    pub end_time: i64,
    /// Current status
    pub status: AuctionStatus,
    /// Winning token mint (set on resolve — highest total_amount)
    pub winning_mint: Pubkey,
    /// Total SOL bid (lamports) across all tokens this round
    pub total_bid: u64,
    /// Number of distinct tokens bid on
    pub token_count: u16,
    /// PDA bump
    pub bump: u8,
}

impl AuctionState {
    pub const SIZE: usize = 8 + // discriminator
        8 +  // epoch
        8 +  // start_time
        8 +  // end_time
        1 +  // status
        32 + // winning_mint
        8 +  // total_bid
        2 +  // token_count
        1;   // bump
}

pub const AUCTION_SEED: &[u8] = b"auction";

/// Per-token bid aggregate within an auction round.
/// Tracks how much POKER was bid for a specific token mint.
#[account]
pub struct TokenBid {
    /// Auction epoch this bid belongs to
    pub epoch: u64,
    /// The SPL token mint being bid for
    pub token_mint: Pubkey,
    /// Total SOL amount bid (lamports) for this token
    pub total_amount: u64,
    /// Number of distinct bidders
    pub bidder_count: u32,
    /// PDA bump
    pub bump: u8,
}

impl TokenBid {
    pub const SIZE: usize = 8 + // discriminator
        8 +  // epoch
        32 + // token_mint
        8 +  // total_amount
        4 +  // bidder_count
        1;   // bump
}

pub const TOKEN_BID_SEED: &[u8] = b"token_bid";

/// Individual user's contribution to a token bid within an auction.
/// Allows refunds if auction is cancelled or tracking for rewards.
#[account]
pub struct BidContribution {
    /// Auction epoch
    pub epoch: u64,
    /// Token mint being bid for
    pub token_mint: Pubkey,
    /// Bidder's wallet
    pub bidder: Pubkey,
    /// SOL amount contributed (lamports)
    pub amount: u64,
    /// PDA bump
    pub bump: u8,
}

impl BidContribution {
    pub const SIZE: usize = 8 + // discriminator
        8 +  // epoch
        32 + // token_mint
        32 + // bidder
        8 +  // amount
        1;   // bump
}

pub const BID_CONTRIBUTION_SEED: &[u8] = b"bid_contrib";

// ─── Persistent Global Bid (carry-over across epochs) ───

pub const GLOBAL_BID_SEED: &[u8] = b"global_bid";
pub const GLOBAL_CONTRIB_SEED: &[u8] = b"global_contrib";

/// Persistent per-token bid that carries across epochs.
/// At epoch end, the #1 token wins (gets listed) and is zeroed/removed.
/// All other tokens retain their bids for the next epoch.
/// Seeds: ["global_bid", token_mint]
#[account]
pub struct GlobalTokenBid {
    /// The SPL token mint being bid for
    pub token_mint: Pubkey,
    /// Total cumulative SOL bid (lamports) for this token
    pub total_amount: u64,
    /// Number of distinct bidders
    pub bidder_count: u32,
    /// PDA bump
    pub bump: u8,
}

impl GlobalTokenBid {
    pub const SIZE: usize = 8 + // discriminator
        32 + // token_mint
        8 +  // total_amount
        4 +  // bidder_count
        1;   // bump
    // = 53 bytes (different from TokenBid's 61 — easy to distinguish)
}

/// Individual user's cumulative contribution to a global token bid.
/// Seeds: ["global_contrib", token_mint, bidder]
#[account]
pub struct GlobalBidContribution {
    /// Token mint being bid for
    pub token_mint: Pubkey,
    /// Bidder's wallet
    pub bidder: Pubkey,
    /// Total SOL contributed (lamports) across all epochs
    pub amount: u64,
    /// Optional anchor vote: the "mid-tier" big blind value (in raw token units)
    /// for rake cap tier calculation. Bigger bids = more voting power (SOL-weighted median).
    pub anchor_vote: Option<u64>,
    /// PDA bump
    pub bump: u8,
}

impl GlobalBidContribution {
    pub const SIZE: usize = 8 + // discriminator
        32 + // token_mint
        32 + // bidder
        8 +  // amount
        9 +  // anchor_vote: Option<u64> = 1 tag + 8 value
        1;   // bump
    // = 90 bytes
}
