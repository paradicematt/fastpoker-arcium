use steel::*;

use super::consts::*;

/// Account discriminators
#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, IntoPrimitive, TryFromPrimitive)]
pub enum PokerAccount {
    Pool = 0,
    Stake = 1,
    Unrefined = 2,
    Epoch = 3,
    Table = 4,
    PlayerSeat = 5,
    TableEscrow = 6,
    PendingWithdrawal = 7,
    Player = 8,
}

/// Global staking pool state
/// Stakers earn TWO types of rewards:
/// 1. SOL - 50% of registrations + buy-ins (immediate)
/// 2. POKER - 50% of rake from cash games (epoch-based)
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct Pool {
    /// Authority that can deposit revenue and mint rewards
    pub authority: Pubkey,
    
    /// POKER token mint
    pub poker_mint: Pubkey,
    
    /// Total POKER tokens burned (total stake weight)
    pub total_burned: u64,
    
    // === SOL Rewards (from registrations + buy-ins) ===
    
    /// Total SOL available for staker claims (lamports)
    pub sol_rewards_available: u64,
    
    /// Total SOL ever distributed to stakers
    pub sol_rewards_distributed: u64,
    
    /// Accumulated SOL rewards per token (scaled by 1e12 for precision)
    pub accumulated_sol_per_token: u128,
    
    // === POKER Rewards (from 50% of rake) ===
    
    /// Total POKER available for staker claims
    pub poker_rewards_available: u64,
    
    /// Total POKER ever distributed to stakers
    pub poker_rewards_distributed: u64,
    
    /// Accumulated POKER rewards per token (scaled by 1e12)
    pub accumulated_poker_per_token: u128,
    
    // === Unrefined/Refined (tournament winners) ===
    
    /// Total unrefined POKER rewards outstanding
    pub total_unrefined: u64,
    
    /// Accumulated refined per unrefined token (scaled by 1e12)
    /// This only increases, never decreases - like ORE pattern
    pub accumulated_refined_per_token: u128,
    
    /// Current epoch number for cash game rake
    pub current_epoch: u64,
    
    /// Bump seed for PDA
    pub bump: u8,
    
    /// Padding for alignment
    pub _padding: [u8; 7],
}

/// Individual staker account
/// Tracks both SOL and POKER pending rewards
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct Stake {
    /// Staker's wallet address
    pub owner: Pubkey,
    
    /// Total POKER tokens burned by this staker
    pub burned_amount: u64,
    
    // === SOL Rewards ===
    
    /// SOL reward debt (for proper reward calculation)
    pub sol_reward_debt: u128,
    
    /// Unclaimed SOL rewards (lamports)
    pub pending_sol: u64,
    
    // === POKER Rewards ===
    
    /// POKER reward debt (for proper reward calculation)
    pub poker_reward_debt: u128,
    
    /// Unclaimed POKER rewards
    pub pending_poker: u64,
    
    /// Timestamp of last claim
    pub last_claim: i64,
    
    /// Bump seed for PDA
    pub bump: u8,
    
    /// Padding for alignment
    pub _padding: [u8; 7],
}

/// Unrefined rewards for a tournament winner
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct Unrefined {
    /// Winner's wallet address
    pub owner: Pubkey,
    
    /// Unrefined POKER tokens (not yet claimed)
    pub unrefined_amount: u64,
    
    /// Refined POKER tokens (from others' 10% tax)
    pub refined_amount: u64,
    
    /// Reward debt for refined calculation (like staking pattern)
    /// debt = unrefined_amount × accumulated_refined_per_token at last update
    pub refined_debt: u128,
    
    /// Bump seed for PDA
    pub bump: u8,
    
    /// Padding for alignment
    pub _padding: [u8; 7],
}

/// Daily epoch for cash game rake distribution
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct Epoch {
    /// Epoch number
    pub epoch_number: u64,
    
    /// Total SOL rake collected this epoch (lamports)
    pub rake_collected: u64,
    
    /// Epoch start timestamp
    pub start_time: i64,
    
    /// Epoch end timestamp
    pub end_time: i64,
    
    /// Whether this epoch has been distributed
    pub distributed: u8,
    
    /// Bump seed for PDA
    pub bump: u8,
    
    /// Padding for alignment
    pub _padding: [u8; 6],
}

account!(PokerAccount, Pool);
account!(PokerAccount, Stake);
account!(PokerAccount, Unrefined);
account!(PokerAccount, Epoch);
account!(PokerAccount, Table);
account!(PokerAccount, PlayerSeat);
account!(PokerAccount, PendingWithdrawal);
account!(PokerAccount, Player);

/// Player account for tracking registration and free buy-ins
/// seeds: ["player", wallet_pubkey]
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct Player {
    /// Player's wallet address
    pub wallet: Pubkey,
    
    /// Free tournament entries remaining (starts at 5 after 0.5 SOL registration)
    pub free_entries: u8,
    
    /// Whether player is registered (paid 0.5 SOL)
    pub is_registered: u8,
    
    /// Total tournaments played
    pub tournaments_played: u16,
    
    /// Total tournaments won
    pub tournaments_won: u16,
    
    /// Bump seed for PDA
    pub bump: u8,
    
    /// Padding for alignment
    pub _padding: [u8; 1],
}

/// Pending withdrawal for disconnected players
/// seeds: ["pending", owner_wallet]
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct PendingWithdrawal {
    /// Player's wallet address
    pub owner: Pubkey,
    
    /// POKER tokens to claim (in smallest unit)
    pub amount: u64,
    
    /// Source table ID
    pub table_id: [u8; 32],
    
    /// Timestamp when created
    pub created_at: i64,
    
    /// Reason: 0=disconnect, 1=table_closed, 2=timeout
    pub reason: u8,
    
    /// Bump seed for PDA
    pub bump: u8,
    
    /// Padding for alignment
    pub _padding: [u8; 6],
}

/// Withdrawal reason enum
#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, IntoPrimitive, TryFromPrimitive)]
pub enum WithdrawalReason {
    Disconnect = 0,
    TableClosed = 1,
    Timeout = 2,
}

/// Connection status for players
#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, IntoPrimitive, TryFromPrimitive)]
pub enum ConnectionStatus {
    Connected = 0,
    Disconnected = 1,
    SittingOut = 2,
}

/// Game phase enumeration
#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, IntoPrimitive, TryFromPrimitive)]
pub enum GamePhase {
    Waiting = 0,
    PreFlop = 1,
    Flop = 2,
    Turn = 3,
    River = 4,
    Showdown = 5,
}

/// Player action enumeration
#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, IntoPrimitive, TryFromPrimitive)]
pub enum PlayerActionType {
    Fold = 0,
    Check = 1,
    Call = 2,
    Raise = 3,
    AllIn = 4,
}

/// On-chain poker table state (for MagicBlock Ephemeral Rollups)
/// This account is delegated to ER during active games
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct Table {
    /// Table identifier (hash of table config)
    pub table_id: [u8; 32],
    
    /// Authority that can manage this table
    pub authority: Pubkey,
    
    /// Pool PDA for rake deposits
    pub pool: Pubkey,
    
    /// VRF seed for deck shuffling
    pub deck_seed: [u8; 32],
    
    /// Current pot size (in chips/lamports)
    pub pot: u64,
    
    /// Minimum bet for current round
    pub min_bet: u64,
    
    /// Rake accumulated this session (lamports)
    pub rake_accumulated: u64,
    
    /// Current hand number
    pub hand_number: u64,
    
    /// Small blind amount
    pub small_blind: u64,
    
    /// Big blind amount
    pub big_blind: u64,
    
    /// Community cards (encoded, 255 = not dealt) + padding to 8 bytes
    pub community_cards: [u8; 8],
    
    /// Phase, seats, counts packed together (8 bytes)
    /// [phase, current_player_seat, dealer_seat, sb_seat, bb_seat, player_count, deck_index, stakes_level]
    pub table_state: [u8; 8],
    
    /// Flags: is_delegated, bump, and padding (8 bytes)
    pub flags: [u8; 8],
}

/// Player seat at a table
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct PlayerSeat {
    /// Player's wallet address
    pub wallet: Pubkey,
    
    /// Table this seat belongs to
    pub table: Pubkey,
    
    /// Current chip stack
    pub chips: u64,
    
    /// Bet amount this round
    pub bet_this_round: u64,
    
    /// Total bet this hand (for side pots)
    pub total_bet_this_hand: u64,
    
    /// Last action timestamp (for timeout detection)
    pub last_action_time: i64,
    
    /// Hole cards (encoded, 255 = not dealt)
    pub hole_cards: [u8; 2],
    
    /// Seat number (0-8)
    pub seat_number: u8,
    
    /// Whether player is active in current hand
    pub is_active: u8,
    
    /// Whether player is all-in
    pub is_all_in: u8,
    
    /// Whether player has folded this hand
    pub has_folded: u8,
    
    /// Whether player is sitting out
    pub is_sitting_out: u8,
    
    /// Bump seed for PDA
    pub bump: u8,
}

impl Table {
    // Accessors for packed table_state: [phase, current_player_seat, dealer_seat, sb_seat, bb_seat, player_count, deck_index, stakes_level]
    pub fn phase(&self) -> u8 { self.table_state[0] }
    pub fn set_phase(&mut self, v: u8) { self.table_state[0] = v; }
    
    pub fn current_player_seat(&self) -> u8 { self.table_state[1] }
    pub fn set_current_player_seat(&mut self, v: u8) { self.table_state[1] = v; }
    
    pub fn dealer_seat(&self) -> u8 { self.table_state[2] }
    pub fn set_dealer_seat(&mut self, v: u8) { self.table_state[2] = v; }
    
    pub fn sb_seat(&self) -> u8 { self.table_state[3] }
    pub fn bb_seat(&self) -> u8 { self.table_state[4] }
    
    pub fn player_count(&self) -> u8 { self.table_state[5] }
    pub fn set_player_count(&mut self, v: u8) { self.table_state[5] = v; }
    
    pub fn deck_index(&self) -> u8 { self.table_state[6] }
    pub fn stakes_level(&self) -> u8 { self.table_state[7] }
    
    // Accessors for flags: [is_delegated, bump, ...]
    pub fn is_delegated(&self) -> bool { self.flags[0] == 1 }
    pub fn bump(&self) -> u8 { self.flags[1] }
    
    /// Check if table is ready to start a hand
    pub fn can_start_hand(&self) -> bool {
        self.phase() == GamePhase::Waiting as u8 && self.player_count() >= 2
    }
    
    /// Get next active seat after given seat
    pub fn next_active_seat(&self, current: u8) -> Option<u8> {
        let next = (current + 1) % 9;
        if next < self.player_count() {
            Some(next)
        } else {
            Some(0)
        }
    }
}

impl PlayerSeat {
    /// Check if player can act
    pub fn can_act(&self) -> bool {
        self.is_active == 1 && self.is_all_in == 0 && self.has_folded == 0
    }
    
    /// Reset for new hand
    pub fn reset_for_hand(&mut self) {
        self.hole_cards = [255, 255];
        self.bet_this_round = 0;
        self.total_bet_this_hand = 0;
        self.is_active = 1;
        self.is_all_in = 0;
        self.has_folded = 0;
    }
}

impl Pool {
    /// Calculate pending SOL rewards for a staker
    pub fn calculate_pending_sol(&self, stake: &Stake) -> u64 {
        if self.total_burned == 0 {
            return 0;
        }
        
        let accumulated = (stake.burned_amount as u128)
            .checked_mul(self.accumulated_sol_per_token)
            .unwrap_or(0);
        
        accumulated
            .checked_sub(stake.sol_reward_debt)
            .unwrap_or(0)
            .checked_div(1_000_000_000_000) // Scale down from 1e12
            .unwrap_or(0) as u64
    }
    
    /// Calculate pending POKER rewards for a staker
    pub fn calculate_pending_poker(&self, stake: &Stake) -> u64 {
        if self.total_burned == 0 {
            return 0;
        }
        
        let accumulated = (stake.burned_amount as u128)
            .checked_mul(self.accumulated_poker_per_token)
            .unwrap_or(0);
        
        accumulated
            .checked_sub(stake.poker_reward_debt)
            .unwrap_or(0)
            .checked_div(1_000_000_000_000) // Scale down from 1e12
            .unwrap_or(0) as u64
    }
    
    /// Update accumulated SOL rewards when new revenue is deposited
    pub fn update_sol_rewards(&mut self, new_revenue: u64) {
        if self.total_burned == 0 {
            return;
        }
        
        // Scale up for precision (1e12)
        let reward_per_token = (new_revenue as u128)
            .checked_mul(1_000_000_000_000)
            .unwrap_or(0)
            .checked_div(self.total_burned as u128)
            .unwrap_or(0);
        
        self.accumulated_sol_per_token = self.accumulated_sol_per_token
            .checked_add(reward_per_token)
            .unwrap_or(self.accumulated_sol_per_token);
    }
    
    /// Update accumulated POKER rewards when rake is distributed
    pub fn update_poker_rewards(&mut self, new_poker: u64) {
        if self.total_burned == 0 {
            return;
        }
        
        // Scale up for precision (1e12)
        let reward_per_token = (new_poker as u128)
            .checked_mul(1_000_000_000_000)
            .unwrap_or(0)
            .checked_div(self.total_burned as u128)
            .unwrap_or(0);
        
        self.accumulated_poker_per_token = self.accumulated_poker_per_token
            .checked_add(reward_per_token)
            .unwrap_or(self.accumulated_poker_per_token);
    }
}

impl Unrefined {
    /// Calculate refined rewards from tax redistribution (ORE pattern)
    /// Uses accumulated_refined_per_token which only increases
    pub fn calculate_refined(&self, pool: &Pool) -> u64 {
        if self.unrefined_amount == 0 {
            return self.refined_amount;
        }
        
        // pending = unrefined_amount × accumulated - debt
        let accumulated = (self.unrefined_amount as u128)
            .checked_mul(pool.accumulated_refined_per_token)
            .unwrap_or(0);
        
        let pending = accumulated
            .checked_sub(self.refined_debt)
            .unwrap_or(0)
            .checked_div(1_000_000_000_000) // Scale down from 1e12
            .unwrap_or(0) as u64;
        
        self.refined_amount.checked_add(pending).unwrap_or(self.refined_amount)
    }
}
