use poker_api::prelude::*;
use steel::*;
use solana_program::{program::invoke_signed, system_instruction, system_program, rent::Rent, sysvar::Sysvar};

/// Create a new poker table with escrow
pub fn process_create_table(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    // Parse instruction data
    let args = CreateTable::try_from_bytes(data)?;
    let table_id = args.table_id;
    let small_blind = u64::from_le_bytes(args.small_blind);
    let big_blind = u64::from_le_bytes(args.big_blind);
    let stakes_level = args.stakes_level;

    // Validate blinds
    if small_blind == 0 || big_blind == 0 || big_blind < small_blind {
        return Err(PokerError::InvalidAmount.into());
    }

    // Parse accounts
    let [authority_info, table_info, pool_info, system_program_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate authority is signer (using native check instead of Steel)
    if !authority_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Validate system program
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Derive expected table PDA
    let (expected_table_pda, table_bump) = Pubkey::find_program_address(
        &[b"table", &table_id],
        &poker_api::ID,
    );

    if *table_info.key != expected_table_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Create table account if it doesn't exist
    if table_info.data_is_empty() {
        let table_size = 8 + std::mem::size_of::<Table>();
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(table_size);

        invoke_signed(
            &system_instruction::create_account(
                authority_info.key,
                table_info.key,
                lamports,
                table_size as u64,
                &poker_api::ID,
            ),
            &[authority_info.clone(), table_info.clone(), system_program_info.clone()],
            &[&[b"table", &table_id, &[table_bump]]],
        )?;

        // Initialize the table - write discriminator first
        let mut table_data = table_info.try_borrow_mut_data()?;
        table_data[0] = PokerAccount::Table as u8;
        
        // Cast to Table using unsafe pointer - Table implements Pod so this is safe
        let table_ptr = table_data[8..].as_mut_ptr() as *mut Table;
        let table: &mut Table = unsafe { &mut *table_ptr };
        
        // Initialize fields
        table.table_id = table_id;
        table.authority = *authority_info.key;
        table.pool = *pool_info.key;
        table.deck_seed = [0u8; 32]; // Will be set when dealing
        table.pot = 0;
        table.min_bet = big_blind;
        table.rake_accumulated = 0;
        table.hand_number = 0;
        table.small_blind = small_blind;
        table.big_blind = big_blind;
        
        // Initialize community_cards to empty (255 = not dealt)
        table.community_cards = [255, 255, 255, 255, 255, 255, 255, 255];
        
        // Initialize table_state: [phase, current_player, dealer, sb, bb, player_count, deck_index, stakes_level]
        table.table_state = [
            GamePhase::Waiting as u8, // phase
            255,                       // current_player_seat (none)
            0,                         // dealer_seat
            1,                         // sb_seat
            2,                         // bb_seat
            0,                         // player_count
            0,                         // deck_index
            stakes_level,              // stakes_level
        ];
        
        // Initialize flags: [is_delegated, bump, ...]
        table.flags = [0, table_bump, 0, 0, 0, 0, 0, 0];
    } else {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    Ok(())
}
