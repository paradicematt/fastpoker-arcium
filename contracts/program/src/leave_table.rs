use poker_api::prelude::*;
use steel::*;
use solana_program::system_program;

/// Leave table and withdraw chips
/// If player is in an active hand, they will be folded first
pub fn process_leave_table(accounts: &[AccountInfo<'_>], _data: &[u8]) -> ProgramResult {
    // Parse accounts
    let [player_info, table_info, seat_info, destination_info, system_program_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate player is signer (native check)
    if !player_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Validate system program
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Load table using unsafe pointer casting
    let mut table_data = table_info.try_borrow_mut_data()?;
    let table_ptr = table_data[8..].as_mut_ptr() as *mut Table;
    let table: &mut Table = unsafe { &mut *table_ptr };

    // Load player seat using unsafe pointer casting
    let mut seat_data = seat_info.try_borrow_mut_data()?;
    let seat_ptr = seat_data[8..].as_mut_ptr() as *mut PlayerSeat;
    let seat: &mut PlayerSeat = unsafe { &mut *seat_ptr };

    // Verify this is the player's seat
    if seat.wallet != *player_info.key {
        return Err(PokerError::NotYourSeat.into());
    }

    // If in active hand and not folded, fold first
    let phase = table.phase();
    if phase != GamePhase::Waiting as u8 && phase != GamePhase::Showdown as u8 {
        if seat.is_active == 1 && seat.has_folded == 0 {
            seat.has_folded = 1;
            seat.is_active = 0;
        }
    }

    // Get withdrawal amount (remaining chips)
    let withdraw_amount = seat.chips;
    
    if withdraw_amount == 0 {
        // No chips to withdraw, just clear the seat
        seat.wallet = Pubkey::default();
        seat.is_active = 0;
        seat.is_sitting_out = 1;
        table.set_player_count(table.player_count().saturating_sub(1));
        return Ok(());
    }

    // Transfer chips back to player from table escrow
    // Table PDA holds the lamports/tokens
    **table_info.try_borrow_mut_lamports()? -= withdraw_amount;
    **destination_info.try_borrow_mut_lamports()? += withdraw_amount;

    // Clear the seat
    seat.wallet = Pubkey::default();
    seat.chips = 0;
    seat.hole_cards = [255, 255];
    seat.bet_this_round = 0;
    seat.total_bet_this_hand = 0;
    seat.is_active = 0;
    seat.is_all_in = 0;
    seat.has_folded = 0;
    seat.is_sitting_out = 1;

    // Update table player count
    table.set_player_count(table.player_count().saturating_sub(1));

    Ok(())
}
