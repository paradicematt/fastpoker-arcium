use anchor_lang::prelude::*;

pub const LISTED_TOKEN_SEED: &[u8] = b"listed_token";

/// Marker PDA created when a token wins an auction.
/// Existence of this PDA = token is approved for cash game tables.
/// Seeds: ["listed_token", token_mint]
#[account]
pub struct ListedToken {
    /// The token mint that won the auction
    pub token_mint: Pubkey,
    /// The auction epoch in which this token won
    pub winning_epoch: u64,
    /// Unix timestamp when listed
    pub listed_at: i64,
    /// PDA bump
    pub bump: u8,
}

impl ListedToken {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // token_mint
        8 +  // winning_epoch
        8 +  // listed_at
        1;   // bump
}
