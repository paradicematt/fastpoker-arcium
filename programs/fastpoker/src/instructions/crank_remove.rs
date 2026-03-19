use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// Crank instruction to remove inactive players from cash game tables
/// Anyone can call this to remove players who:
/// 1. Have sat out for 5+ minutes
/// 2. Have sat out for 3+ dealer button passes (legacy fallback)
/// 3. Have been bust (0 chips) for 3+ hands without rebuying
///
/// If the player has remaining chips, they are moved to an UnclaimedBalance PDA
/// (same as force_release_seat) so the player can reclaim them later.

const SIT_OUT_TIMEOUT_SECS: i64 = 5 * 60;
const LEGACY_ORBIT_REMOVAL_THRESHOLD: u8 = 3;
const BUST_REMOVAL_THRESHOLD: u8 = 3;

#[derive(Accounts)]
pub struct CrankRemovePlayer<'info> {
    /// Anyone can crank - pays for the transaction
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.game_type == GameType::CashGame @ PokerError::InvalidTableConfig,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat.seat_number]],
        bump = seat.bump,
    )]
    pub seat: Account<'info, PlayerSeat>,

    /// Unclaimed balance PDA - created if player has remaining chips
    #[account(
        init_if_needed,
        payer = cranker,
        space = UnclaimedBalance::SIZE,
        seeds = [UNCLAIMED_SEED, table.key().as_ref(), seat.wallet.as_ref()],
        bump,
    )]
    pub unclaimed_balance: Account<'info, UnclaimedBalance>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CrankRemovePlayer>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;
    let unclaimed = &mut ctx.accounts.unclaimed_balance;
    let clock = Clock::get()?;

    // Keep removal between hands to avoid mutating player counts during active action flow.
    require!(
        table.phase == GamePhase::Waiting || table.phase == GamePhase::Complete,
        PokerError::InvalidActionForPhase
    );
    
    // Must be sitting out
    require!(
        seat.status == SeatStatus::SittingOut,
        PokerError::PlayerNotSittingOut
    );
    
    // Check removal conditions
    let sit_out_elapsed = if seat.sit_out_timestamp > 0 {
        clock.unix_timestamp.saturating_sub(seat.sit_out_timestamp)
    } else {
        0
    };
    let time_expired = sit_out_elapsed >= SIT_OUT_TIMEOUT_SECS;
    let legacy_orbit_expired =
        seat.sit_out_timestamp <= 0 && seat.sit_out_button_count >= LEGACY_ORBIT_REMOVAL_THRESHOLD;
    let bust_expired = seat.chips == 0 && seat.hands_since_bust >= BUST_REMOVAL_THRESHOLD;
    let should_remove = time_expired || legacy_orbit_expired || bust_expired;
    
    require!(should_remove, PokerError::PlayerNotRemovable);
    
    let player_wallet = seat.wallet;
    let chips_to_move = seat.chips;
    
    // If player has remaining chips, move them to UnclaimedBalance PDA
    let had_existing_unclaimed = unclaimed.amount > 0;
    if chips_to_move > 0 {
        unclaimed.player = player_wallet;
        unclaimed.table = table.key();
        unclaimed.amount = unclaimed.amount.saturating_add(chips_to_move);
        unclaimed.last_active_at = clock.unix_timestamp;
        unclaimed.bump = ctx.bumps.unclaimed_balance;

        if !had_existing_unclaimed {
            table.unclaimed_balance_count = table.unclaimed_balance_count.saturating_add(1);
        }
        
        msg!(
            "Moved {} chips to unclaimed balance for player {}",
            chips_to_move,
            player_wallet
        );
    }
    
    // Remove player from table
    let seat_number = seat.seat_number;
    let seat_mask = 1u16 << seat_number;
    table.seats_occupied &= !seat_mask;
    table.seats_folded &= !seat_mask;
    table.seats_allin &= !seat_mask;
    table.current_players = table.current_players.saturating_sub(1);
    
    // Reset seat state
    seat.status = SeatStatus::Empty;
    seat.chips = 0;
    seat.wallet = Pubkey::default();
    seat.session_key = Pubkey::default();
    seat.bet_this_round = 0;
    seat.total_bet_this_hand = 0;
    seat.hole_cards = [255, 255];
    seat.hole_cards_encrypted = [0; 64];
    seat.hole_cards_commitment = [0; 32];
    seat.missed_sb = false;
    seat.missed_bb = false;
    seat.posted_blind = false;
    seat.waiting_for_bb = false;
    seat.sit_out_button_count = 0;
    seat.hands_since_bust = 0;
    seat.auto_fold_count = 0;
    seat.missed_bb_count = 0;
    seat.paid_entry = false;
    seat.cashout_chips = 0;
    seat.cashout_nonce = 0;
    seat.vault_reserve = 0;
    seat.sit_out_timestamp = 0;
    
    msg!(
        "Player {} removed from seat {}. {} chips moved to unclaimed balance.",
        player_wallet,
        seat_number,
        chips_to_move
    );
    
    Ok(())
}
