use poker_api::prelude::*;
use steel::*;
use solana_program::{program::invoke_signed, system_instruction, system_program, rent::Rent, sysvar::Sysvar};

/// Create a pending withdrawal for a player who disconnected or left without withdrawing
/// This is called by the server/authority when a player's session ends unexpectedly
pub fn process_create_pending_withdrawal(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    // Parse instruction data
    let args = CreatePendingWithdrawal::try_from_bytes(data)?;
    let amount = u64::from_le_bytes(args.amount);
    let reason = args.reason;

    // Parse accounts
    let [authority_info, table_info, seat_info, pending_info, owner_info, system_program_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate authority is signer
    authority_info.is_signer()?;
    
    // Validate system program
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Load table
    let table = table_info.as_account_mut::<Table>(&poker_api::ID)?;

    // Verify authority
    if table.authority != *authority_info.key {
        return Err(PokerError::InvalidAuthority.into());
    }

    // Load player seat
    let seat = seat_info.as_account_mut::<PlayerSeat>(&poker_api::ID)?;

    // Verify the seat belongs to this owner
    if seat.wallet != *owner_info.key {
        return Err(PokerError::NotYourSeat.into());
    }

    // Verify there are chips to withdraw
    if seat.chips < amount {
        return Err(PokerError::InsufficientBalance.into());
    }

    // Derive expected pending withdrawal PDA
    let (expected_pending_pda, pending_bump) = Pubkey::find_program_address(
        &[b"pending", owner_info.key.as_ref()],
        &poker_api::ID,
    );

    if *pending_info.key != expected_pending_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Create pending withdrawal account if it doesn't exist
    if pending_info.data_is_empty() {
        let pending_size = 8 + std::mem::size_of::<PendingWithdrawal>();
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(pending_size);

        invoke_signed(
            &system_instruction::create_account(
                authority_info.key,
                pending_info.key,
                lamports,
                pending_size as u64,
                &poker_api::ID,
            ),
            &[authority_info.clone(), pending_info.clone(), system_program_info.clone()],
            &[&[b"pending", owner_info.key.as_ref(), &[pending_bump]]],
        )?;

        // Initialize pending withdrawal
        let mut pending_data = pending_info.try_borrow_mut_data()?;
        pending_data[0] = PokerAccount::PendingWithdrawal as u8;
        
        let pending = PendingWithdrawal::try_from_bytes_mut(&mut pending_data[8..])?;
        pending.owner = *owner_info.key;
        pending.table_id = table.table_id;
        pending.amount = amount;
        pending.reason = reason;
        pending.created_at = solana_program::clock::Clock::get()?.unix_timestamp;
        pending.bump = pending_bump;
    } else {
        // Add to existing pending withdrawal
        let mut pending_data = pending_info.try_borrow_mut_data()?;
        let pending = PendingWithdrawal::try_from_bytes_mut(&mut pending_data[8..])?;
        
        // Verify owner matches
        if pending.owner != *owner_info.key {
            return Err(PokerError::InvalidAuthority.into());
        }
        
        // Add amount to existing pending
        pending.amount = pending.amount.checked_add(amount)
            .ok_or(PokerError::InvalidAmount)?;
    }

    // Deduct chips from seat
    seat.chips -= amount;
    
    // If seat is now empty, clear it
    if seat.chips == 0 {
        seat.wallet = Pubkey::default();
        seat.is_active = 0;
        seat.is_sitting_out = 1;
        table.set_player_count(table.player_count().saturating_sub(1));
    }

    // Transfer lamports from table to pending PDA for the withdrawal amount
    // (In production, this would be token transfer)
    **table_info.try_borrow_mut_lamports()? -= amount;
    **pending_info.try_borrow_mut_lamports()? += amount;

    solana_program::msg!("Created pending withdrawal: {} for {}", amount, owner_info.key);

    Ok(())
}
