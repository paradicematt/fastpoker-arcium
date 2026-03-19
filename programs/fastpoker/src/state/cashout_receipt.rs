use anchor_lang::prelude::*;

/// Receipt PDA for idempotent cashout processing.
/// Tracks the last processed nonce per seat to prevent double cashouts.
/// Also tracks the current depositor to prevent overfill (two players depositing
/// for the same seat — the second deposit would leave SOL stuck in vault).
/// NEVER delegated — stays on L1 permanently.
/// Seeds: ["receipt", table_pda.as_ref(), &[seat_index]]
#[account]
pub struct CashoutReceipt {
    /// The table this receipt belongs to
    pub table: Pubkey,
    /// Seat index (0-8)
    pub seat_index: u8,
    /// Last processed cashout nonce (prevents double cashout)
    pub last_processed_nonce: u64,
    /// PDA bump
    pub bump: u8,
    /// Current depositor — set on deposit_for_join, cleared on cashout/clear_leaving_seat.
    /// Prevents a second player from depositing to an already-occupied seat.
    pub depositor: Pubkey,
}

impl CashoutReceipt {
    pub const SIZE: usize = 8 + // discriminator
        32 + // table
        1 +  // seat_index
        8 +  // last_processed_nonce
        1 +  // bump
        32;  // depositor
    // = 82 bytes
}

// RECEIPT_SEED is defined in constants.rs
