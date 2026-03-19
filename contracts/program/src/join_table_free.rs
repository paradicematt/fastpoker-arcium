use poker_api::prelude::*;
use steel::*;
use solana_program::system_program;

/// Join a tournament table using a free entry (no SOL transfer)
/// Decrements the player's free_entries count
pub fn process_join_table_free(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    // Parse instruction data
    let args = JoinTableFree::try_from_bytes(data)?;
    let seat_number = args.seat_number;

    if seat_number >= 9 {
        return Err(PokerError::InvalidSeat.into());
    }

    // Parse accounts: player, player_pda, table, seat, system_program
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    
    let player_info = &accounts[0];
    let player_pda_info = &accounts[1];
    let table_info = &accounts[2];
    let seat_info = &accounts[3];
    let system_program_info = &accounts[4];

    // Validate player is signer
    player_info.is_signer()?;
    
    // Validate system program
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Verify Player PDA
    let (expected_player_pda, _) = Pubkey::find_program_address(
        &[b"player", player_info.key.as_ref()],
        &poker_api::ID,
    );
    
    if *player_pda_info.key != expected_player_pda {
        return Err(PokerError::InvalidAccount.into());
    }
    
    // Load and update Player account
    let player = player_pda_info.as_account_mut::<Player>(&poker_api::ID)?;
    
    if player.is_registered == 0 {
        return Err(PokerError::NotRegistered.into());
    }
    
    if player.free_entries == 0 {
        return Err(PokerError::NoFreeEntries.into());
    }
    
    // Decrement free entries
    player.free_entries = player.free_entries.saturating_sub(1);

    // Load table
    let table = table_info.as_account_mut::<Table>(&poker_api::ID)?;
    
    // Only tournaments allow free entries
    if table.stakes_level() != 0 {
        return Err(PokerError::InvalidAction.into());
    }

    // Check game phase - can only join during Waiting
    if table.phase() != GamePhase::Waiting as u8 {
        return Err(PokerError::GameInProgress.into());
    }

    // Check if seat is available
    let (expected_seat_pda, seat_bump) = Pubkey::find_program_address(
        &[
            b"seat",
            table_info.key.as_ref(),
            &[seat_number],
        ],
        &poker_api::ID,
    );

    if *seat_info.key != expected_seat_pda {
        return Err(PokerError::InvalidSeat.into());
    }

    // Create PlayerSeat account if it doesn't exist
    if seat_info.data_is_empty() {
        let seat_size = 8 + std::mem::size_of::<PlayerSeat>();
        let rent = solana_program::rent::Rent::get()?;
        let lamports = rent.minimum_balance(seat_size);

        solana_program::program::invoke_signed(
            &solana_program::system_instruction::create_account(
                player_info.key,
                seat_info.key,
                lamports,
                seat_size as u64,
                &poker_api::ID,
            ),
            &[player_info.clone(), seat_info.clone(), system_program_info.clone()],
            &[&[
                b"seat",
                table_info.key.as_ref(),
                &[seat_number],
                &[seat_bump],
            ]],
        )?;

        // Initialize the seat
        let mut seat_data = seat_info.try_borrow_mut_data()?;
        seat_data[0] = PokerAccount::PlayerSeat as u8;
        
        let seat_ptr = seat_data[8..].as_mut_ptr() as *mut PlayerSeat;
        let seat: &mut PlayerSeat = unsafe { &mut *seat_ptr };
        
        seat.wallet = *player_info.key;
        seat.table = *table_info.key;
        seat.chips = 1500; // Tournament starting stack
        seat.bet_this_round = 0;
        seat.total_bet_this_hand = 0;
        seat.last_action_time = solana_program::clock::Clock::get()?.unix_timestamp;
        seat.hole_cards = [255, 255];
        seat.seat_number = seat_number;
        seat.is_active = 1;
        seat.is_all_in = 0;
        seat.has_folded = 0;
        seat.is_sitting_out = 0;
        seat.bump = seat_bump;
    } else {
        // Seat exists - check if it's empty
        let seat = seat_info.as_account_mut::<PlayerSeat>(&poker_api::ID)?;
        
        if seat.wallet != Pubkey::default() && seat.chips > 0 {
            return Err(PokerError::SeatOccupied.into());
        }

        // Reuse the seat
        seat.wallet = *player_info.key;
        seat.chips = 1500; // Tournament starting stack
        seat.bet_this_round = 0;
        seat.total_bet_this_hand = 0;
        seat.last_action_time = solana_program::clock::Clock::get()?.unix_timestamp;
        seat.hole_cards = [255, 255];
        seat.is_active = 1;
        seat.is_all_in = 0;
        seat.has_folded = 0;
        seat.is_sitting_out = 0;
    }

    // Update table player count
    table.set_player_count(table.player_count().saturating_add(1));

    // NO SOL TRANSFER - using free entry

    Ok(())
}
