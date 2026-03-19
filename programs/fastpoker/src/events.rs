use anchor_lang::prelude::*;
use crate::state::{GamePhase, PokerAction};

#[event]
pub struct TableCreated {
    pub table: Pubkey,
    pub table_id: [u8; 32],
    pub authority: Pubkey,
    pub max_players: u8,
    pub small_blind: u64,
    pub big_blind: u64,
}

#[event]
pub struct TableClosed {
    pub table: Pubkey,
    pub final_rake: u64,
}

#[event]
pub struct PlayerJoined {
    pub table: Pubkey,
    pub player: Pubkey,
    pub seat_number: u8,
    pub buy_in: u64,
}

#[event]
pub struct PlayerLeft {
    pub table: Pubkey,
    pub player: Pubkey,
    pub seat_number: u8,
    pub chips_cashed_out: u64,
}

#[event]
pub struct HandStarted {
    pub table: Pubkey,
    pub hand_number: u64,
    pub dealer_seat: u8,
    pub small_blind_seat: u8,
    pub big_blind_seat: u8,
}

#[event]
pub struct HoleCardsDealt {
    pub table: Pubkey,
    pub hand_number: u64,
    pub cards_dealt_securely: bool,
}

#[event]
pub struct CommunityCardsDealt {
    pub table: Pubkey,
    pub hand_number: u64,
    pub phase: GamePhase,
    pub cards: Vec<u8>,
}

#[event]
pub struct PlayerActed {
    pub table: Pubkey,
    pub player: Pubkey,
    pub seat_number: u8,
    pub action: PokerAction,
    pub pot_after: u64,
}

#[event]
pub struct PlayerTimedOut {
    pub table: Pubkey,
    pub player: Pubkey,
    pub seat_number: u8,
}

#[event]
pub struct PhaseChanged {
    pub table: Pubkey,
    pub hand_number: u64,
    pub new_phase: GamePhase,
}

#[event]
pub struct HandSettled {
    pub table: Pubkey,
    pub hand_number: u64,
    pub winners: Vec<Pubkey>,
    pub amounts: Vec<u64>,
    pub rake_collected: u64,
}

#[event]
pub struct CardsRevealed {
    pub table: Pubkey,
    pub seat: u8,
    pub card1: u8,
    pub card2: u8,
}

#[event]
pub struct TableDelegated {
    pub table: Pubkey,
    pub delegated_at_slot: u64,
}

#[event]
pub struct TableUndelegated {
    pub table: Pubkey,
    pub undelegated_at_slot: u64,
    pub total_rake: u64,
}

#[event]
pub struct SessionCreated {
    pub owner: Pubkey,
    pub session_key: Pubkey,
    pub table: Pubkey,
    pub valid_until: i64,
}

#[event]
pub struct SessionRevoked {
    pub owner: Pubkey,
    pub session_key: Pubkey,
    pub table: Pubkey,
}

#[event]
pub struct RakeDeposited {
    pub table: Pubkey,
    pub amount: u64,
    pub pool: Pubkey,
}

#[event]
pub struct TournamentRewardMinted {
    pub winner: Pubkey,
    pub amount: u64,
    pub tournament_type: u8,
}

#[event]
pub struct ShowdownResult {
    pub table: Pubkey,
    pub hand_number: u64,
    pub winners: Vec<u8>,
    pub winning_hand_rank: u8,
}

#[event]
pub struct PlayerRegistered {
    pub player: Pubkey,
    pub free_entries: u8,
    pub timestamp: i64,
}

#[event]
pub struct FreeEntryUsed {
    pub player: Pubkey,
    pub entries_remaining: u8,
    pub table: Pubkey,
}

#[event]
pub struct BlindPosted {
    pub table: Pubkey,
    pub player: Pubkey,
    pub seat_number: u8,
    pub amount: u64,
    pub blind_type: BlindType,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum BlindType {
    SmallBlind,
    BigBlind,
    DeadSmall,
}

#[event]
pub struct PlayerSatOut {
    pub table: Pubkey,
    pub player: Pubkey,
    pub seat_number: u8,
}

#[event]
pub struct PlayerSatIn {
    pub table: Pubkey,
    pub player: Pubkey,
    pub seat_number: u8,
    pub missed_blinds_posted: u64,
}

#[event]
pub struct RakeDistributed {
    pub table: Pubkey,
    pub total_rake: u64,
    pub staker_share: u64,
    pub creator_share: u64,
    pub treasury_share: u64,
}

#[event]
pub struct PlayerKicked {
    pub table: Pubkey,
    pub player: Pubkey,
    pub seat_number: u8,
    pub chips_owed: u64,
    pub reason: KickReason,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum KickReason {
    SitOutTimeout,    // 5+ minutes sitting out
    LegacyOrbit,      // 3+ button passes (no timestamp)
    BustTimeout,      // 0 chips for 3+ hands
}

#[event]
pub struct PrizesDistributed {
    pub table: Pubkey,
    pub table_id: [u8; 32],
    pub game_type: u8,
    pub winner: Pubkey,
    pub prize_pool: u64,
    pub payouts: Vec<crate::instructions::distribute_prizes::PrizeEntry>,
}
