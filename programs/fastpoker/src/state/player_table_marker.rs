use anchor_lang::prelude::*;

/// Marker account that proves a player is seated at a specific table.
/// This PDA is unique per player+table combination.
/// Seeds: ["player_table", player_pubkey, table_pubkey]
/// 
/// When a player joins a table, this account is created with `init_if_needed`.
/// If the player tries to join the same table again (different seat),
/// Anchor will fail because the account already exists with a valid player.
/// 
/// When the player leaves, the marker is NOT closed — it stores chip lock data
/// in the trailing bytes (offsets 74-89) via raw byte access.
/// If the player rejoins within 12 hours, they must bring at least `chips_at_leave`.
/// After 12 hours the lock expires and normal min/max buy-in applies.
#[account]
pub struct PlayerTableMarker {
    /// The player's wallet
    pub player: Pubkey,
    /// The table PDA
    pub table: Pubkey,
    /// The seat number the player occupies
    pub seat_number: u8,
    /// Bump seed for this PDA
    pub bump: u8,
    // Chip lock fields live in trailing bytes (74..90), NOT in the Anchor struct.
    // This allows backwards compatibility with old 74-byte markers.
    // See CHIP_LOCK_CHIPS_OFFSET / CHIP_LOCK_TIME_OFFSET.
}

impl PlayerTableMarker {
    /// Allocate 99 bytes: 74 (struct) + 16 (chip lock) + 9 (kick tracking)
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 1 + 8 + 8 + 8 + 1;
    // = 74 + 16 + 9 = 99

    /// Byte offset for chips_at_leave (u64 LE) in raw account data
    pub const CHIP_LOCK_CHIPS_OFFSET: usize = 74;
    /// Byte offset for leave_time (i64 LE) in raw account data
    pub const CHIP_LOCK_TIME_OFFSET: usize = 82;
    /// 12 hours in seconds
    pub const CHIP_LOCK_DURATION: i64 = 12 * 60 * 60;

    // --- Anti-abuse kick tracking (Phase 5) ---
    /// Byte offset for kick_time (i64 LE) — unix timestamp when player was kicked
    pub const KICK_TIME_OFFSET: usize = 90;
    /// Byte offset for kick_reason (u8) — KickReason enum value
    pub const KICK_REASON_OFFSET: usize = 98;
    /// Rejoin penalty window: 30 minutes
    pub const KICK_PENALTY_DURATION: i64 = 30 * 60;
}

pub const PLAYER_TABLE_MARKER_SEED: &[u8] = b"player_table";
