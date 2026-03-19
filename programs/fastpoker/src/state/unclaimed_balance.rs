use anchor_lang::prelude::*;

/// Per-table-per-player unclaimed token balance PDA
/// Seeds: ["unclaimed", table_pubkey, player_pubkey]
/// 
/// Flow:
/// 1. Player leaves/disconnects/force-released → UnclaimedBalance created
/// 2. Player can claim anytime with wallet signature
/// 3. Player rejoins same table → auto-uses these funds as buy-in
/// 4. After UNCLAIMED_EXPIRY_DAYS, table creator can reclaim
#[account]
#[derive(Default)]
pub struct UnclaimedBalance {
    /// Player who owns this balance
    pub player: Pubkey,
    /// Table this balance is from
    pub table: Pubkey,
    /// Amount in POKER tokens (6 decimals)
    pub amount: u64,
    /// Unix timestamp when player last played/sat down
    pub last_active_at: i64,
    /// PDA bump
    pub bump: u8,
}

impl UnclaimedBalance {
    pub const SIZE: usize = 8 + // discriminator
        32 + // player
        32 + // table
        8 +  // amount
        8 +  // last_active_at (i64)
        1 +  // bump
        16;  // padding

    /// Check if unclaimed balance has expired (owner can no longer claim, creator can)
    pub fn is_expired(&self, current_timestamp: i64) -> bool {
        current_timestamp >= self.last_active_at + UNCLAIMED_EXPIRY_SECONDS
    }
}

/// 100 days in seconds for expiration
pub const UNCLAIMED_EXPIRY_SECONDS: i64 = 100 * 24 * 60 * 60;
/// For testing: 1 hour
pub const UNCLAIMED_EXPIRY_SECONDS_TESTING: i64 = 60 * 60;
