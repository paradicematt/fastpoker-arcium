use poker_api::prelude::*;
use steel::*;
use solana_program::{program::invoke_signed, system_instruction, system_program, rent::Rent, sysvar::Sysvar};

/// Join a poker table with a buy-in amount
/// Creates a PlayerSeat PDA for the player at the specified seat
pub fn process_join_table(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    // Parse instruction data
    let args = JoinTable::try_from_bytes(data)?;
    let buyin_amount = u64::from_le_bytes(args.buyin_amount);
    let seat_number = args.seat_number;

    if buyin_amount == 0 {
        return Err(PokerError::InvalidAmount.into());
    }

    if seat_number >= 9 {
        return Err(PokerError::InvalidSeat.into());
    }

    // Parse accounts: player, table, seat, source, system_program
    // (same for both tournaments and cash games - JoinTable is PAID join)
    let [player_info, table_info, seat_info, source_info, system_program_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    
    // Validate player is signer
    player_info.is_signer()?;

    // Load table
    let table = table_info.as_account_mut::<Table>(&poker_api::ID)?;
    
    // Validate system program
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    
    // NOTE: JoinTable is for PAID joins (SOL buy-in)
    // For FREE entries, use JoinTableFree instruction instead

    // Check game phase - can only join during Waiting
    if table.phase() != GamePhase::Waiting as u8 {
        return Err(PokerError::GameInProgress.into());
    }

    // Check if seat is available (seat PDA shouldn't exist or be empty)
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

        // Initialize the seat - write discriminator first
        let mut seat_data = seat_info.try_borrow_mut_data()?;
        seat_data[0] = PokerAccount::PlayerSeat as u8;
        
        // Cast to PlayerSeat using unsafe pointer - PlayerSeat implements Pod so this is safe
        let seat_ptr = seat_data[8..].as_mut_ptr() as *mut PlayerSeat;
        let seat: &mut PlayerSeat = unsafe { &mut *seat_ptr };
        
        seat.wallet = *player_info.key;
        seat.table = *table_info.key;
        
        // For tournaments (stakes_level == 0), use fixed starting stack
        // For cash games, use the buy-in amount in lamports
        let starting_chips = if table.stakes_level() == 0 {
            1500 // Tournament starting stack
        } else {
            buyin_amount
        };
        seat.chips = starting_chips;
        seat.bet_this_round = 0;
        seat.total_bet_this_hand = 0;
        seat.last_action_time = solana_program::clock::Clock::get()?.unix_timestamp;
        seat.hole_cards = [255, 255]; // Not dealt yet
        seat.seat_number = seat_number;
        seat.is_active = 1;
        seat.is_all_in = 0;
        seat.has_folded = 0;
        seat.is_sitting_out = 0;
        seat.bump = seat_bump;
    } else {
        // Seat exists - check if it's empty (player left)
        let seat = seat_info.as_account_mut::<PlayerSeat>(&poker_api::ID)?;
        
        if seat.wallet != Pubkey::default() && seat.chips > 0 {
            return Err(PokerError::SeatOccupied.into());
        }

        // Reuse the seat
        seat.wallet = *player_info.key;
        
        // For tournaments (stakes_level == 0), use fixed starting stack
        let starting_chips = if table.stakes_level() == 0 {
            1500 // Tournament starting stack
        } else {
            buyin_amount
        };
        seat.chips = starting_chips;
        seat.bet_this_round = 0;
        seat.total_bet_this_hand = 0;
        seat.last_action_time = solana_program::clock::Clock::get()?.unix_timestamp;
        seat.hole_cards = [255, 255];
        seat.is_active = 1;
        seat.is_all_in = 0;
        seat.has_folded = 0;
        seat.is_sitting_out = 0;
    }

    // Transfer buy-in from player to table escrow
    solana_program::program::invoke(
        &solana_program::system_instruction::transfer(
            source_info.key,
            table_info.key,
            buyin_amount,
        ),
        &[source_info.clone(), table_info.clone()],
    )?;

    // Update table player count
    table.set_player_count(table.player_count().saturating_add(1));

    Ok(())
}
