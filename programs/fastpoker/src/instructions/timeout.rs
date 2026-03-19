use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::events::PlayerTimedOut;
use crate::constants::*;

#[derive(Accounts)]
pub struct HandleTimeout<'info> {
    /// CHECK: Anyone can trigger timeout (crank, tick scheduler, or authority)
    /// Permissionless so MagicBlock scheduler can execute via native crank
    pub caller: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        // Works on both L1 and ER - no delegation requirement
        constraint = table.phase != GamePhase::Waiting @ PokerError::InvalidActionForPhase,
        constraint = table.phase != GamePhase::Complete @ PokerError::InvalidActionForPhase,
        constraint = table.phase != GamePhase::Starting @ PokerError::InvalidActionForPhase,
        constraint = table.phase != GamePhase::Showdown @ PokerError::InvalidActionForPhase,
        constraint = table.phase != GamePhase::FlopRevealPending @ PokerError::InvalidActionForPhase,
        constraint = table.phase != GamePhase::TurnRevealPending @ PokerError::InvalidActionForPhase,
        constraint = table.phase != GamePhase::RiverRevealPending @ PokerError::InvalidActionForPhase,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[current_seat.seat_number]],
        bump = current_seat.bump,
        constraint = current_seat.seat_number == table.current_player @ PokerError::NotPlayersTurn,
    )]
    pub current_seat: Account<'info, PlayerSeat>,
}

pub fn handler(ctx: Context<HandleTimeout>, expected_nonce: u16) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.current_seat;
    let clock = Clock::get()?;

    // Nonce guard: reject stale timeouts. If a player action (or any state change)
    // already incremented the nonce since the crank read the table, this timeout
    // is racing against a completed action and must be rejected.
    // This prevents the TEE race condition where both player_action and
    // handle_timeout succeed against the same pre-state snapshot.
    require!(
        table.action_nonce == expected_nonce,
        PokerError::ActionTimeout
    );

    // Timing guard: require minimum elapsed time before timeout fires.
    // Clock::slot doesn't advance on MagicBlock ER, so we use unix_timestamp.
    // table.last_action_slot stores unix_timestamp (set by player_action, tee_deal, etc.)
    // Without this check, anyone can call handle_timeout immediately to force-fold players (A22).
    let elapsed = (clock.unix_timestamp as u64).saturating_sub(table.last_action_slot);
    require!(
        elapsed >= TIMEOUT_SECONDS,
        PokerError::ActionTimeout
    );

    let timed_out_player = seat.wallet;
    let timed_out_seat = seat.seat_number;

    // Check if the player can CHECK (their bet already covers the required amount).
    // e.g. BB's blind covers a short all-in — auto-check lets the hand see community cards.
    let amount_to_call = table.min_bet.saturating_sub(seat.bet_this_round);
    let can_check = amount_to_call == 0;

    // Preserve Leaving status — if player marked Leaving, keep it so settle.rs
    // knows to snapshot their cashout. Only overwrite to Folded for non-Leaving players.
    let is_leaving = seat.status == SeatStatus::Leaving;

    if can_check {
        // Auto-CHECK: player's bet already covers, just advance action
        seat.last_action_slot = clock.slot;
        seat.auto_fold_count = seat.auto_fold_count.saturating_add(1);
        msg!("Player {} at seat {} timed out — auto-CHECK (bet {} >= min_bet {})",
             timed_out_player, timed_out_seat, seat.bet_this_round, table.min_bet);
    } else {
        // Auto-FOLD: add to folded mask for hand mechanics
        table.seats_folded |= 1 << seat.seat_number;
        seat.last_action_slot = clock.slot;
        seat.auto_fold_count = seat.auto_fold_count.saturating_add(1);
        // Only change status to Folded if NOT Leaving — preserve Leaving for cashout
        if !is_leaving {
            seat.status = SeatStatus::Folded;
        }
        msg!("Player {} at seat {} timed out — auto-FOLD (bet {} < min_bet {}){}", 
             timed_out_player, timed_out_seat, seat.bet_this_round, table.min_bet,
             if is_leaving { " [Leaving — preserved]" } else { "" });
    }

    let fold_count = seat.auto_fold_count;

    emit!(PlayerTimedOut {
        table: table.key(),
        player: timed_out_player,
        seat_number: timed_out_seat,
    });

    // Cash game: 3 consecutive auto-folds = sitting out (booted from table)
    // Skip for Leaving players — they're already on the way out
    const MAX_AUTO_FOLDS: u8 = 3;
    if fold_count >= MAX_AUTO_FOLDS && !table.is_sit_and_go() && !is_leaving {
        seat.status = SeatStatus::SittingOut;
        seat.sit_out_timestamp = clock.unix_timestamp;
        msg!("💤 Seat {} sat out after {} consecutive auto-folds (cash game)", timed_out_seat, fold_count);
    }

    // Reuse the same advance_action logic as normal fold/check
    // This properly handles: next player finding, betting round completion,
    // phase transitions, all-in runouts, and multi-player scenarios
    super::player_action::advance_action(table)?;

    table.last_action_slot = clock.unix_timestamp as u64;
    table.action_nonce = table.action_nonce.wrapping_add(1);

    // Record crank action in CrankTallyER (if appended to remaining_accounts)
    let tkey = table.key();
    let hnum = table.hand_number;
    let ckey = ctx.accounts.caller.key();
    try_record_crank_action(ctx.remaining_accounts, &tkey, &ckey, hnum);

    Ok(())
}

/// Tick-based timeout checker (called by MagicBlock tick scheduler)
/// This would be registered as a tick function in the ER
/// 
/// Example tick registration (pseudo-code):
/// ```ignore
/// #[tick(interval = 1000)] // Every ~1 second
/// pub fn tick_check_timeout(ctx: Context<TickContext>) -> Result<()> {
///     let table = &mut ctx.accounts.table;
///     let clock = Clock::get()?;
///     
///     if table.phase != GamePhase::Waiting && table.phase != GamePhase::Complete {
///         let slots_since_action = clock.slot.saturating_sub(table.last_action_slot);
///         
///         if slots_since_action >= TIMEOUT_SLOTS {
///             // Emit event or call handle_timeout
///             // The ER tick scheduler would then call handle_timeout instruction
///         }
///     }
///     
///     Ok(())
/// }
/// ```
/// Check if the current player should be timed out.
/// `current_timestamp` must be unix_timestamp (not slot) — matches handler's elapsed check.
/// table.last_action_slot stores unix_timestamp (set by player_action, handle_timeout, etc.)
pub fn should_timeout(table: &Table, current_timestamp: u64) -> bool {
    if table.phase == GamePhase::Waiting
        || table.phase == GamePhase::Complete
        || table.phase == GamePhase::Starting
        || table.phase == GamePhase::Showdown
        || table.phase == GamePhase::FlopRevealPending
        || table.phase == GamePhase::TurnRevealPending
        || table.phase == GamePhase::RiverRevealPending
    {
        return false;
    }
    
    let elapsed = current_timestamp.saturating_sub(table.last_action_slot);
    elapsed >= TIMEOUT_SECONDS
}
