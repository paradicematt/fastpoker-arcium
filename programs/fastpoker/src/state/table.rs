use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct Table {
    /// Unique identifier for this table
    pub table_id: [u8; 32],
    /// Authority who can manage this table
    pub authority: Pubkey,
    /// Pool PDA for rake deposits (Steel program)
    pub pool: Pubkey,
    /// Type of game (Sit & Go variants or Cash Game)
    pub game_type: GameType,
    /// Blind levels
    pub small_blind: u64,
    pub big_blind: u64,
    /// Maximum players allowed (2, 6, or 9)
    pub max_players: u8,
    /// Current number of seated players
    pub current_players: u8,
    /// Current hand number
    pub hand_number: u64,
    /// Current pot size
    pub pot: u64,
    /// Minimum bet to call
    pub min_bet: u64,
    /// Accumulated rake this session
    pub rake_accumulated: u64,
    /// Community cards (5 cards, 255 = not dealt)
    pub community_cards: [u8; 5],
    /// Current game phase
    pub phase: GamePhase,
    /// Seat index of current action
    pub current_player: u8,
    /// Actions taken this betting round (for phase advancement)
    pub actions_this_round: u8,
    /// Dealer button position
    pub dealer_button: u8,
    /// Small blind seat
    pub small_blind_seat: u8,
    /// Big blind seat  
    pub big_blind_seat: u8,
    /// Last action slot for timeout detection
    pub last_action_slot: u64,
    /// DEPRECATED: Was for MagicBlock ER delegation. Always false in Arcium architecture.
    /// Cannot remove — changing layout would break all existing Table PDAs.
    pub is_delegated: bool,
    /// Revealed hole cards at showdown (seat 0-8, 2 cards each, 255=hidden)
    pub revealed_hands: [u8; 18],
    /// Hand rank results at showdown (0=none, 1=high_card..10=royal_flush)
    pub hand_results: [u8; 9],
    /// Legacy pre-dealt community buffer (kept for layout compatibility).
    /// Current flow does NOT store unrevealed community cards here.
    pub pre_community: [u8; 5],
    /// Card-usage state for current hand (first 8 bytes store a 52-bit used-card mask).
    /// Remaining bytes are reserved/zero.
    pub deck_seed: [u8; 32],
    /// Number of cards consumed this hand (including burns)
    pub deck_index: u8,
    /// Stakes level identifier
    pub stakes_level: u8,
    /// Current blind level for Sit & Go (0-9)
    pub blind_level: u8,
    /// Slot when tournament started (for blind timing)
    pub tournament_start_slot: u64,
    
    // === Cash Game Enhancements ===
    
    /// Bitmask of occupied seats (bit N = seat N is occupied)
    pub seats_occupied: u16,
    /// Bitmask of all-in seats (bit N = seat N is all-in)
    pub seats_allin: u16,
    /// Bitmask of folded seats (bit N = seat N has folded)
    pub seats_folded: u16,
    /// Whether button is on empty seat (dead button)
    pub dead_button: bool,
    /// Whether flop was reached this hand (for rake eligibility)
    pub flop_reached: bool,
    /// Token escrow PDA for cash game buy-ins
    pub token_escrow: Pubkey,
    
    // === User-Created Table Rake Distribution ===
    
    /// Creator of this table (earns 45% of rake for user-created tables; 5% goes to dealers)
    pub creator: Pubkey,
    /// Whether this is a user-created table (vs system table)
    pub is_user_created: bool,
    /// Total rake distributed to creator
    pub creator_rake_total: u64,
    /// Last epoch when rake was distributed
    pub last_rake_epoch: u64,
    
    /// Whether tournament prizes have been distributed (prevents double-mint)
    pub prizes_distributed: bool,
    
    /// Number of unclaimed balances for this table (must be 0 to close)
    pub unclaimed_balance_count: u8,
    
    /// PDA bump
    pub bump: u8,
    
    // === Sit & Go Elimination Tracking ===
    
    /// Seat indices of eliminated players, in order of elimination
    /// eliminated_seats[0] = first player out (last place)
    /// eliminated_seats[eliminated_count-1] = most recent elimination
    pub eliminated_seats: [u8; 9],
    
    /// Number of players eliminated so far
    pub eliminated_count: u8,
    
    /// Total SOL entry fees escrowed in this table PDA (for SNG refund/distribution)
    pub entry_fees_escrowed: u64,
    
    // === Tiered Sit & Go Buy-ins ===
    
    /// SNG tier (Micro/Bronze/Silver/Gold/Platinum/Diamond) — set at creation, immutable
    pub tier: crate::constants::SnGTier,
    
    /// Entry amount per player in lamports (→ prize pool) — set from tier at creation
    pub entry_amount: u64,
    
    /// Fee amount per player in lamports (→ treasury/stakers via Steel) — set from tier at creation
    pub fee_amount: u64,
    
    /// Running total of entry SOL for prize distribution (incremented on join, drained at distribution)
    pub prize_pool: u64,
    
    // === Multi-Denomination Cash Games ===
    
    /// Token mint for this table's denomination
    /// Pubkey::default() (all zeros) = SOL table
    /// Otherwise = SPL token mint (POKER, USDC, or auction-listed token)
    pub token_mint: Pubkey,
    
    /// Buy-in type: 0=Normal (20-100 BB), 1=Deep Stack (50-250 BB)
    pub buy_in_type: u8,

    // === Protocol Economics (Phase 1+2+8) ===

    /// Rake cap in token units (computed from TokenTierConfig at creation).
    /// 0 = no cap (Micro tier or pre-economics tables).
    pub rake_cap: u64,
    /// Whether this is a private (whitelist-only) table.
    /// Set at creation, immutable after.
    pub is_private: bool,
    /// Monotonically increasing accumulated crank pool (5% of rake, always active).
    /// Never reset on ER. L1 tracks distributed amount via vault.total_crank_distributed.
    pub crank_pool_accumulated: u64,
    /// Monotonic action nonce — incremented on every state-changing action
    /// (player_action, handle_timeout, tee_deal, tee_reveal).
    /// handle_timeout must pass the expected nonce to prevent race conditions
    /// where a player's action and the crank's timeout both succeed on TEE.
    pub action_nonce: u16,
}

impl Table {
    pub const SIZE: usize = 8 + // discriminator
        32 + // table_id
        32 + // authority
        32 + // pool
        1 + // game_type
        8 + // small_blind
        8 + // big_blind
        1 + // max_players
        1 + // current_players
        8 + // hand_number
        8 + // pot
        8 + // min_bet
        8 + // rake_accumulated
        5 + // community_cards
        1 + // phase
        1 + // current_player
        1 + // actions_this_round
        1 + // dealer_button
        1 + // small_blind_seat
        1 + // big_blind_seat
        8 + // last_action_slot
        1 + // is_delegated
        18 + // revealed_hands
        9 + // hand_results
        5 + // pre_community
        32 + // deck_seed
        1 + // deck_index
        1 + // stakes_level
        1 + // blind_level
        8 + // tournament_start_slot
        2 + // seats_occupied
        2 + // seats_allin
        2 + // seats_folded
        1 + // dead_button
        1 + // flop_reached
        32 + // token_escrow
        32 + // creator
        1 + // is_user_created
        8 + // creator_rake_total
        8 + // last_rake_epoch
        1 + // prizes_distributed
        1 + // unclaimed_balance_count
        1 + // bump
        9 + // eliminated_seats
        1 + // eliminated_count
        8 + // entry_fees_escrowed
        1 + // tier (SnGTier enum)
        8 + // entry_amount
        8 + // fee_amount
        8 + // prize_pool
        32 + // token_mint
        1 + // buy_in_type
        8 + // rake_cap
        1 + // is_private
        8 + // crank_pool_accumulated
        2; // action_nonce (u16) — replaces reserved padding, keeps SIZE=437

    /// Check if a seat is occupied
    pub fn is_seat_occupied(&self, seat: u8) -> bool {
        if seat >= self.max_players {
            return false;
        }
        (self.seats_occupied & (1 << seat)) != 0
    }

    /// Mark a seat as occupied
    pub fn occupy_seat(&mut self, seat: u8) {
        if seat < self.max_players {
            self.seats_occupied |= 1 << seat;
        }
    }

    /// Mark a seat as empty
    pub fn vacate_seat(&mut self, seat: u8) {
        if seat < self.max_players {
            self.seats_occupied &= !(1 << seat);
        }
    }

    /// Find next occupied seat after given seat (skips empty seats)
    pub fn next_occupied_seat(&self, from: u8) -> Option<u8> {
        for i in 1..=self.max_players {
            let seat = (from + i) % self.max_players;
            if self.is_seat_occupied(seat) {
                return Some(seat);
            }
        }
        None
    }

    /// Find next seat set in a given bitmask (for active-only traversal)
    pub fn next_seat_in_mask(&self, from: u8, mask: u16) -> Option<u8> {
        for i in 1..=self.max_players {
            let seat = (from + i) % self.max_players;
            if (mask & (1 << seat)) != 0 {
                return Some(seat);
            }
        }
        None
    }

    /// Rotate button to next occupied seat
    pub fn rotate_button(&mut self) {
        if let Some(next) = self.next_occupied_seat(self.dealer_button) {
            self.dealer_button = next;
            self.dead_button = false;
        } else {
            // No occupied seats - shouldn't happen, mark dead
            self.dead_button = true;
        }
    }

    /// Set up blinds based on button position (handles heads-up and dead button)
    pub fn setup_blinds(&mut self) {
        let active_count = self.seats_occupied.count_ones() as u8;
        
        if active_count < 2 {
            return; // Can't set blinds with < 2 players
        }

        if active_count == 2 {
            // Heads-up: dealer is SB
            self.small_blind_seat = self.dealer_button;
            self.big_blind_seat = self.next_occupied_seat(self.dealer_button).unwrap_or(0);
        } else {
            // 3+ players: SB is left of button, BB is left of SB
            self.small_blind_seat = self.next_occupied_seat(self.dealer_button).unwrap_or(0);
            self.big_blind_seat = self.next_occupied_seat(self.small_blind_seat).unwrap_or(0);
        }
    }

    /// Get first player to act preflop (left of BB, or SB in heads-up)
    pub fn first_to_act_preflop(&self) -> u8 {
        let active_count = self.seats_occupied.count_ones() as u8;
        
        if active_count == 2 {
            // Heads-up: SB acts first preflop
            self.small_blind_seat
        } else {
            // 3+: UTG (left of BB) acts first
            self.next_occupied_seat(self.big_blind_seat).unwrap_or(0)
        }
    }

    /// Get first player to act postflop (left of button)
    pub fn first_to_act_postflop(&self) -> u8 {
        self.next_occupied_seat(self.dealer_button).unwrap_or(0)
    }

    pub fn active_player_count(&self) -> u8 {
        self.current_players
    }

    pub fn is_betting_complete(&self) -> bool {
        // Will be set by game logic when all players have acted
        self.min_bet == 0 || self.current_player == 255
    }

    pub fn next_street(&self) -> GamePhase {
        match self.phase {
            GamePhase::Preflop => GamePhase::Flop,
            GamePhase::Flop => GamePhase::Turn,
            GamePhase::Turn => GamePhase::River,
            GamePhase::River => GamePhase::Showdown,
            _ => self.phase,
        }
    }

    pub fn is_betting_phase(&self) -> bool {
        matches!(
            self.phase,
            GamePhase::Preflop | GamePhase::Flop | GamePhase::Turn | GamePhase::River
        )
    }

    pub fn is_reveal_pending(&self) -> bool {
        matches!(
            self.phase,
            GamePhase::FlopRevealPending
                | GamePhase::TurnRevealPending
                | GamePhase::RiverRevealPending
        )
    }

    /// Calculate current Sit & Go blind level based on elapsed wall-clock time
    /// tournament_start_slot stores unix_timestamp (repurposed field, no layout change)
    pub fn calculate_sng_blind_level(&self, current_timestamp: u64) -> u8 {
        use crate::constants::{SNG_BLIND_INTERVAL_SECONDS, SNG_BLIND_LEVELS};
        
        if self.tournament_start_slot == 0 {
            return 0;
        }
        
        let elapsed_seconds = current_timestamp.saturating_sub(self.tournament_start_slot);
        let level = (elapsed_seconds / SNG_BLIND_INTERVAL_SECONDS) as u8;
        let max_level = (SNG_BLIND_LEVELS.len() - 1) as u8;
        level.min(max_level)
    }

    /// Get Sit & Go blinds for current level (uses wall-clock timestamp)
    pub fn get_sng_blinds(&self, current_timestamp: u64) -> (u64, u64) {
        use crate::constants::SNG_BLIND_LEVELS;
        
        let level = self.calculate_sng_blind_level(current_timestamp) as usize;
        let max_level = SNG_BLIND_LEVELS.len() - 1;
        SNG_BLIND_LEVELS[level.min(max_level)]
    }

    /// Check if this is a Sit & Go game type
    pub fn is_sit_and_go(&self) -> bool {
        matches!(
            self.game_type,
            GameType::SitAndGoHeadsUp | GameType::SitAndGo6Max | GameType::SitAndGo9Max
        )
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum GameType {
    #[default]
    SitAndGoHeadsUp,
    SitAndGo6Max,
    SitAndGo9Max,
    CashGame,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum GamePhase {
    #[default]
    Waiting,    // Waiting for players to join
    Starting,   // Game starting, blinds posted
    AwaitingDeal, // MPC shuffle_and_deal queued, waiting for callback
    Preflop,    // Hole cards dealt, first betting round
    Flop,       // 3 community cards, second betting round
    Turn,       // 4th community card, third betting round
    River,      // 5th community card, final betting round
    Showdown,   // Reveal cards, determine winner
    AwaitingShowdown, // MPC reveal_showdown queued, waiting for callback
    Complete,   // Hand finished, settling payouts
    FlopRevealPending, // Betting round ended, waiting MPC reveal for flop
    TurnRevealPending, // Betting round ended, waiting MPC reveal for turn
    RiverRevealPending, // Betting round ended, waiting MPC reveal for river
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Stakes {
    Micro,  // 1/2
    Low,    // 5/10
    Mid,    // 25/50
    High,   // 100/200
}

impl Stakes {
    pub fn blinds(&self) -> (u64, u64) {
        match self {
            Stakes::Micro => (1_000, 2_000),
            Stakes::Low => (5_000, 10_000),
            Stakes::Mid => (25_000, 50_000),
            Stakes::High => (100_000, 200_000),
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct TableConfig {
    pub table_id: [u8; 32],
    pub game_type: GameType,
    pub stakes: Stakes,
    pub max_players: u8,
    pub tier: crate::constants::SnGTier,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PokerAction {
    Fold,
    Check,
    Call,
    Bet { amount: u64 },
    Raise { amount: u64 },
    AllIn,
    SitOut,        // Player sits out - won't be dealt into next hand
    ReturnToPlay,  // Player returns from sitting out
    LeaveCashGame, // Player voluntarily leaves cash game
    RebuyTopUp { amount: u64 }, // DEPRECATED: Was for ER instant rebuys. Cannot remove — shifts serialization.
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EncryptedCard {
    pub seat_index: u8,
    pub encrypted_data: [u8; 64],
    pub commitment: [u8; 32],
}
