use poker_api::prelude::*;
use steel::*;
use solana_program::system_program;

/// Cancel buy-in and refund player (only if game hasn't started)
pub fn process_cancel_buyin(accounts: &[AccountInfo<'_>], _data: &[u8]) -> ProgramResult {
    // Parse accounts
    let [player_info, table_info, seat_info, destination_info, system_program_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate player is signer
    player_info.is_signer()?;
    
    // Validate system program
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Load table
    let table = table_info.as_account_mut::<Table>(&poker_api::ID)?;

    // Check game phase - can only cancel during Waiting
    if table.phase() != GamePhase::Waiting as u8 {
        return Err(PokerError::GameInProgress.into());
    }

    // Load player seat
    let seat = seat_info.as_account_mut::<PlayerSeat>(&poker_api::ID)?;

    // Verify this is the player's seat
    if seat.wallet != *player_info.key {
        return Err(PokerError::NotYourSeat.into());
    }

    // Get refund amount
    let refund_amount = seat.chips;
    
    if refund_amount == 0 {
        return Err(PokerError::NoChips.into());
    }

    // Transfer chips back to player from table escrow
    **table_info.try_borrow_mut_lamports()? -= refund_amount;
    **destination_info.try_borrow_mut_lamports()? += refund_amount;

    // Clear the seat
    seat.wallet = Pubkey::default();
    seat.chips = 0;
    seat.is_active = 0;

    // Update table player count
    table.set_player_count(table.player_count().saturating_sub(1));

    Ok(())
}
