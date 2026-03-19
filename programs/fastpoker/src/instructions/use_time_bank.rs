use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// Player activates their time bank to get extra time for the current action.
/// Deducts TIME_BANK_CHUNK_SECONDS (15s) from their time_bank_seconds and
/// extends the table's last_action_slot by the equivalent slot count.
///
/// Guards:
///   - Player must be the current actor (table.current_player matches seat)
///   - Time bank must have enough seconds remaining
///   - Can only be used once per action turn (time_bank_active flag)
///   - Table must be in an active betting phase (Preflop/Flop/Turn/River)
#[derive(Accounts)]
pub struct UseTimeBank<'info> {
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat.seat_number]],
        bump = seat.bump,
        constraint = seat.wallet == player.key() || seat.session_key == player.key() @ PokerError::Unauthorized,
        constraint = seat.table == table.key() @ PokerError::InvalidAccountData,
    )]
    pub seat: Account<'info, PlayerSeat>,
}

pub fn handler(ctx: Context<UseTimeBank>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;

    // Must be in an active betting phase
    require!(
        matches!(table.phase, GamePhase::Preflop | GamePhase::Flop | GamePhase::Turn | GamePhase::River),
        PokerError::InvalidActionForPhase
    );

    // Must be the current actor
    require!(
        seat.seat_number == table.current_player,
        PokerError::NotPlayersTurn
    );

    // Must be active
    require!(seat.status == SeatStatus::Active, PokerError::InvalidActionForPhase);

    // Can only use time bank once per action turn
    require!(!seat.time_bank_active, PokerError::InvalidActionForPhase);

    // Must have enough time bank remaining
    require!(
        seat.time_bank_seconds >= TIME_BANK_CHUNK_SECONDS,
        PokerError::InsufficientFunds
    );

    // Deduct chunk from time bank
    seat.time_bank_seconds = seat.time_bank_seconds.saturating_sub(TIME_BANK_CHUNK_SECONDS);
    seat.time_bank_active = true;

    // Extend the action deadline by adding chunk to last_action_slot
    // Convert seconds to slots (~2.5 slots per second on ER, but use unix_timestamp)
    // Since timeout uses unix_timestamp comparison, extend last_action_slot as a timestamp
    let clock = Clock::get()?;
    table.last_action_slot = clock.unix_timestamp as u64 + TIME_BANK_CHUNK_SECONDS as u64;

    msg!(
        "Time bank used: seat {} spent {}s ({}s remaining)",
        seat.seat_number, TIME_BANK_CHUNK_SECONDS, seat.time_bank_seconds
    );

    Ok(())
}
