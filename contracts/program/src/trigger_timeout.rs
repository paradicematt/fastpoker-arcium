use poker_api::prelude::*;
use steel::*;

/// Turn timeout duration in seconds
const TURN_TIMEOUT_SECONDS: i64 = 30;

/// Max timeouts before auto sit-out
const MAX_TIMEOUTS: u8 = 3;

/// Trigger timeout for an inactive player
/// Anyone can call this to keep the game moving
pub fn process_trigger_timeout(accounts: &[AccountInfo<'_>], _data: &[u8]) -> ProgramResult {
    // Parse accounts
    let [caller_info, table_info, seat_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate caller is signer (anyone can trigger)
    caller_info.is_signer()?;

    // Load table
    let table = table_info.as_account_mut::<Table>(&poker_api::ID)?;

    // Must be in an active phase (not waiting or showdown)
    let phase = table.phase();
    if phase == GamePhase::Waiting as u8 || phase == GamePhase::Showdown as u8 {
        return Err(PokerError::InvalidAction.into());
    }

    // Load player seat
    let seat = seat_info.as_account_mut::<PlayerSeat>(&poker_api::ID)?;

    // Verify this is the current player's seat
    if seat.seat_number != table.current_player_seat() {
        return Err(PokerError::NotYourTurn.into());
    }

    // Check if timeout has actually occurred
    let clock = solana_program::clock::Clock::get()?;
    let time_since_action = clock.unix_timestamp - seat.last_action_time;
    
    if time_since_action < TURN_TIMEOUT_SECONDS {
        return Err(PokerError::InvalidAction.into()); // Not timed out yet
    }

    // Player has timed out - auto-fold them
    seat.has_folded = 1;
    seat.is_active = 0;
    
    // Increment timeout count (stored in a reserved field or we track separately)
    // For now, just mark as sitting out after timeout
    seat.is_sitting_out = 1;

    // Move to next player
    let next_seat = table.next_active_seat(seat.seat_number);
    if let Some(next) = next_seat {
        table.set_current_player_seat(next);
    } else {
        // No more active players - hand should end
        table.set_phase(GamePhase::Showdown as u8);
        table.set_current_player_seat(255); // No current player
    }

    Ok(())
}
