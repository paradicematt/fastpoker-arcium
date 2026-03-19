use anchor_lang::prelude::*;

/// Short-lived PDA that proves a player deposited funds on L1.
/// Created by `deposit_for_join` on L1, then delegated to ER by the crank/API.
/// `seat_player` on ER reads this to validate buy_in/reserve match the actual deposit.
/// After seating, the proof is consumed (fields zeroed) to prevent replay.
///
/// Seeds: ["deposit_proof", table_pda.as_ref(), &[seat_index]]
#[account]
pub struct DepositProof {
    /// The table this deposit is for
    pub table: Pubkey,
    /// Seat index (0-8)
    pub seat_index: u8,
    /// Player wallet that made the deposit
    pub depositor: Pubkey,
    /// Buy-in amount deposited on L1 (validated by seat_player)
    pub buy_in: u64,
    /// Reserve amount deposited on L1 (validated by seat_player)
    pub reserve: u64,
    /// Whether this proof has been consumed by seat_player
    pub consumed: bool,
    /// Unix timestamp of when the deposit was made (for refund timelock)
    pub deposit_timestamp: i64,
    /// PDA bump
    pub bump: u8,
}

impl DepositProof {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // table
        1 +  // seat_index
        32 + // depositor
        8 +  // buy_in
        8 +  // reserve
        1 +  // consumed
        8 +  // deposit_timestamp
        1;   // bump
    // = 99 bytes
}
