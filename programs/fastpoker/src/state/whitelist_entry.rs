use anchor_lang::prelude::*;

pub const WHITELIST_SEED: &[u8] = b"whitelist";

/// Per-player whitelist entry for private tables.
/// Created by table creator, checked by join_table.
/// Seeds: ["whitelist", table, player]
#[account]
pub struct WhitelistEntry {
    /// Table this entry belongs to
    pub table: Pubkey,
    /// Player allowed to join
    pub player: Pubkey,
    /// Unix timestamp when added
    pub added_at: i64,
    /// PDA bump
    pub bump: u8,
}

impl WhitelistEntry {
    pub const SIZE: usize = 8 +  // discriminator
        32 +                      // table
        32 +                      // player
        8 +                       // added_at
        1;                        // bump
    // = 81 bytes
}
