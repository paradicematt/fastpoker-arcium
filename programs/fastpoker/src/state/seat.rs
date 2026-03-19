use anchor_lang::prelude::*;

#[account]
pub struct PlayerSeat {
    /// Player's main wallet
    pub wallet: Pubkey,
    /// Delegated session signer (for gasless gameplay)
    pub session_key: Pubkey,
    /// Table this seat belongs to
    pub table: Pubkey,
    /// Current chip stack
    pub chips: u64,
    /// Bet amount this betting round
    pub bet_this_round: u64,
    /// Total bet this hand (for side pots)
    pub total_bet_this_hand: u64,
    /// TEE encrypted hole cards (64 bytes for 2 cards + encryption overhead)
    pub hole_cards_encrypted: [u8; 64],
    /// Commitment hash for hole card verification
    pub hole_cards_commitment: [u8; 32],
    /// Revealed hole cards (only set at showdown, 255 = hidden)
    pub hole_cards: [u8; 2],
    /// Seat number (0-8)
    pub seat_number: u8,
    /// Current seat status
    pub status: SeatStatus,
    /// Last action timestamp (for timeout tracking)
    pub last_action_slot: u64,
    /// Missed small blind (must post when returning)
    pub missed_sb: bool,
    /// Missed big blind (must post when returning)
    pub missed_bb: bool,
    /// Has posted blind this session (for new player posting)
    pub posted_blind: bool,
    /// Waiting for natural BB position (new player option)
    pub waiting_for_bb: bool,
    /// Number of times dealer button has passed while sitting out (cash games: 3 = removed)
    pub sit_out_button_count: u8,
    /// Hands since going bust (0 chips) - for 3-hand rebuy window in cash games
    pub hands_since_bust: u8,
    /// Consecutive auto-folds (timeout) - 3 = crank sits player out
    pub auto_fold_count: u8,
    /// Number of missed big blinds (cash games: 3 = removed to unclaimed funds)
    pub missed_bb_count: u8,
    /// PDA bump
    pub bump: u8,
    /// Whether this player paid SOL entry fee (false = free entry, for SNG refund logic)
    pub paid_entry: bool,
    /// Chip snapshot at time of leaving (chips + vault_reserve) — for L1 cashout
    pub cashout_chips: u64,
    /// Incremented each leave — for idempotent cashout processing
    pub cashout_nonce: u64,
    /// DEPRECATED: Was for ER instant rebuys. Always 0 in Arcium architecture.
    /// Cannot remove — changing layout would break all existing PlayerSeat PDAs.
    pub vault_reserve: u64,
    /// Unix timestamp when player entered SittingOut status (0 = not sitting out).
    /// Crank checks this to auto-remove players sitting out > 5 minutes.
    pub sit_out_timestamp: i64,

    // === Time Bank (Phase 3) ===

    /// Remaining time bank in seconds (max 60, regen 5s per hand played).
    /// Player manually activates in 15s chunks via use_time_bank instruction.
    pub time_bank_seconds: u16,
    /// Whether time bank has been activated for the current action window.
    /// Reset to false at start of each new action turn.
    pub time_bank_active: bool,
}

impl PlayerSeat {
    pub const SIZE: usize = 8 + // discriminator
        32 + // wallet
        32 + // session_key
        32 + // table
        8 + // chips
        8 + // bet_this_round
        8 + // total_bet_this_hand
        64 + // hole_cards_encrypted
        32 + // hole_cards_commitment
        2 + // hole_cards
        1 + // seat_number
        1 + // status
        8 + // last_action_slot
        1 + // missed_sb
        1 + // missed_bb
        1 + // posted_blind
        1 + // waiting_for_bb
        1 + // sit_out_button_count
        1 + // hands_since_bust
        1 + // auto_fold_count
        1 + // missed_bb_count
        1 + // bump
        1 + // paid_entry
        8 + // cashout_chips
        8 + // cashout_nonce
        8 + // vault_reserve
        8 + // sit_out_timestamp
        2 + // time_bank_seconds
        1; // time_bank_active
    // = 281 bytes

    pub fn is_active(&self) -> bool {
        matches!(self.status, SeatStatus::Active | SeatStatus::AllIn)
    }

    pub fn can_act(&self) -> bool {
        self.status == SeatStatus::Active
    }

    pub fn has_folded(&self) -> bool {
        self.status == SeatStatus::Folded
    }

    pub fn is_all_in(&self) -> bool {
        self.status == SeatStatus::AllIn
    }

    pub fn reset_for_new_hand(&mut self) {
        self.bet_this_round = 0;
        self.total_bet_this_hand = 0;
        self.hole_cards_encrypted = [0; 64];
        // NOTE: Do NOT zero hole_cards_commitment — it stores the player's x25519 pubkey
        // for Arcium MPC card encryption. Set once via set_x25519_key, persists across hands.
        self.hole_cards = [255, 255];
        self.posted_blind = false;
        // NEVER overwrite Leaving (cashout in progress) or Busted (eliminated).
        // Only reset Active/Folded/AllIn back to Active for the next hand.
        if self.status != SeatStatus::Empty
            && self.status != SeatStatus::SittingOut
            && self.status != SeatStatus::Leaving
            && self.status != SeatStatus::Busted
        {
            if self.waiting_for_bb {
                self.waiting_for_bb = false;
            }
            self.status = SeatStatus::Active;
        }
    }

    /// Check if player can participate in current hand
    pub fn can_play_hand(&self) -> bool {
        self.status == SeatStatus::Active && !self.waiting_for_bb
    }

    /// Check if player needs to post blind to play
    pub fn needs_to_post(&self) -> bool {
        self.missed_bb || (self.missed_sb && self.missed_bb)
    }

    pub fn reset_for_new_round(&mut self) {
        self.bet_this_round = 0;
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum SeatStatus {
    #[default]
    Empty,      // 0 - No player in seat
    Active,     // 1 - Player actively in hand
    Folded,     // 2 - Player folded this hand
    AllIn,      // 3 - Player is all-in
    SittingOut, // 4 - Player sitting out (skips hands, can return)
    Busted,     // 5 - Player eliminated (0 chips in tournament)
    Leaving,    // 6 - Player wants to cash out (crank processes between hands)
}

impl SeatStatus {
    pub fn is_in_hand(&self) -> bool {
        matches!(self, SeatStatus::Active | SeatStatus::AllIn)
    }
}
