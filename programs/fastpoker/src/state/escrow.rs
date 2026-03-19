use anchor_lang::prelude::*;

/// Token escrow account for cash game buy-ins
/// Each table has an escrow that holds player chips
#[account]
pub struct TableEscrow {
    /// Table this escrow belongs to
    pub table: Pubkey,
    /// Token mint (e.g., USDC, SOL wrapped, or play chips)
    pub token_mint: Pubkey,
    /// Total chips held in escrow
    pub total_chips: u64,
    /// Authority (table PDA)
    pub authority: Pubkey,
    /// PDA bump
    pub bump: u8,
}

impl TableEscrow {
    pub const SIZE: usize = 8 + // discriminator
        32 + // table
        32 + // token_mint
        8 + // total_chips
        32 + // authority
        1 + // bump
        32; // padding
}

pub const ESCROW_SEED: &[u8] = b"escrow";
