use anchor_lang::prelude::*;

/// Player account tracking registration status and free game entries
#[account]
#[derive(Default)]
pub struct PlayerAccount {
    /// Player's wallet pubkey
    pub wallet: Pubkey,
    /// Whether player has paid registration fee
    pub is_registered: bool,
    /// Number of free Sit & Go entries remaining
    pub free_entries: u8,
    /// Total hands played
    pub hands_played: u64,
    /// Total hands won
    pub hands_won: u64,
    /// Total winnings (lifetime, in lamports)
    pub total_winnings: u64,
    /// Total losses (lifetime, in lamports)
    pub total_losses: u64,
    /// Tournaments played
    pub tournaments_played: u32,
    /// Tournaments won (1st place)
    pub tournaments_won: u32,
    /// Registration timestamp
    pub registered_at: i64,
    /// PDA bump
    pub bump: u8,
    
    /// Accumulated SOL winnings from tiered SNGs (lamports), claimable by player
    pub claimable_sol: u64,

    // === XP / Level System ===
    
    /// Total XP earned (lifetime)
    pub xp: u64,
    /// Consecutive hands played at current table without sitting out (for streak bonus)
    pub hand_streak: u16,
}

impl PlayerAccount {
    pub const SIZE: usize = 8 + // discriminator
        32 + // wallet
        1 + // is_registered
        1 + // free_entries
        8 + // hands_played
        8 + // hands_won
        8 + // total_winnings
        8 + // total_losses
        4 + // tournaments_played
        4 + // tournaments_won
        8 + // registered_at
        1 + // bump
        8 + // claimable_sol
        8 + // xp
        2 + // hand_streak
        14; // padding for future fields

    /// Check if player can use a free entry
    pub fn has_free_entry(&self) -> bool {
        self.free_entries > 0
    }

    /// Use a free entry, returns true if successful
    pub fn use_free_entry(&mut self) -> bool {
        if self.free_entries > 0 {
            self.free_entries -= 1;
            true
        } else {
            false
        }
    }

    /// Record a hand result
    pub fn record_hand(&mut self, won: bool, amount: i64) {
        self.hands_played += 1;
        if won {
            self.hands_won += 1;
            if amount > 0 {
                self.total_winnings += amount as u64;
            }
        } else if amount < 0 {
            self.total_losses += (-amount) as u64;
        }
    }

    /// Record a tournament result
    pub fn record_tournament(&mut self, won: bool) {
        self.tournaments_played += 1;
        if won {
            self.tournaments_won += 1;
        }
    }

    /// Add XP and return new total
    pub fn add_xp(&mut self, amount: u64) -> u64 {
        self.xp = self.xp.saturating_add(amount);
        self.xp
    }

    /// Get player level from XP
    pub fn level(&self) -> u8 {
        level_from_xp(self.xp)
    }

    /// Increment hand streak, award bonus XP every 10 hands
    pub fn tick_streak(&mut self) -> u64 {
        self.hand_streak = self.hand_streak.saturating_add(1);
        if self.hand_streak % 10 == 0 {
            self.add_xp(XP_STREAK_10);
            return XP_STREAK_10;
        }
        0
    }
}

/// XP award amounts
pub const XP_HAND_COMPLETE: u64 = 10;   // Completed a hand (didn't fold preflop)
pub const XP_HAND_WIN: u64 = 25;         // Won a hand
pub const XP_SNG_WIN: u64 = 100;         // Won a Sit & Go
pub const XP_SNG_ITM: u64 = 50;          // Finished in the money (2nd/3rd)
pub const XP_SNG_PLAY: u64 = 15;         // Played a Sit & Go (any finish)
pub const XP_STREAK_10: u64 = 20;        // Played 10 consecutive hands
pub const XP_FIRST_HAND: u64 = 50;       // First hand ever (welcome bonus)

/// Calculate level from total XP
pub fn level_from_xp(xp: u64) -> u8 {
    match xp {
        0..=99 => 1,
        100..=299 => 2,
        300..=599 => 3,
        600..=1_099 => 4,
        1_100..=1_999 => 5,
        2_000..=3_499 => 6,
        3_500..=5_999 => 7,
        6_000..=9_999 => 8,
        10_000..=19_999 => 9,
        20_000..=39_999 => 10,
        40_000..=79_999 => 11,
        80_000..=149_999 => 12,
        _ => 13,
    }
}

/// Player account PDA seed
pub const PLAYER_SEED: &[u8] = b"player";
