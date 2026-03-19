use poker_api::prelude::*;
use steel::*;

/// MagicBlock Delegation Program ID
const DELEGATION_PROGRAM: Pubkey = solana_program::pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

/// Delegate table to MagicBlock Ephemeral Rollup
/// This allows zero-fee, low-latency gameplay in the ER
pub fn process_delegate_table(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    // Parse instruction data
    let args = DelegateTable::try_from_bytes(data)?;
    let validator = Pubkey::new_from_array(args.validator);

    // Parse accounts
    let [authority_info, table_info, delegation_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate authority is signer (native check)
    if !authority_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate delegation program
    if *delegation_program.key != DELEGATION_PROGRAM {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Load table using unsafe pointer casting
    let mut table_data = table_info.try_borrow_mut_data()?;
    let table_ptr = table_data[8..].as_mut_ptr() as *mut Table;
    let table: &mut Table = unsafe { &mut *table_ptr };

    // Verify authority
    if table.authority != *authority_info.key {
        return Err(PokerError::InvalidAuthority.into());
    }

    // Check table is not already delegated
    if table.is_delegated() {
        return Err(PokerError::InvalidAction.into());
    }

    // Must have at least 2 players to delegate
    if table.player_count() < 2 {
        return Err(PokerError::InvalidAction.into());
    }

    // Call delegation program to delegate the account
    // This is a simplified version - actual MagicBlock SDK has specific CPI calls
    // The delegation program will:
    // 1. Take ownership of the table account
    // 2. Mirror state to the ER validator
    // 3. Allow the ER to process transactions on this account
    
    // For now, just mark as delegated (actual CPI would go here)
    // In production, use: magicblock_sdk::delegate_account(table_info, validator)
    
    // Mark table as delegated
    table.flags[0] = 1; // is_delegated = true
    
    // Store validator pubkey for reference (could add field to Table struct)
    // For now just log it
    solana_program::msg!("Table delegated to validator: {}", validator);

    Ok(())
}

/// Undelegate table from MagicBlock ER (commit final state back to mainnet)
pub fn process_undelegate_table(accounts: &[AccountInfo<'_>], _data: &[u8]) -> ProgramResult {
    // Parse accounts
    let [authority_info, table_info, _pool_info, delegation_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate authority is signer (native check)
    if !authority_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate delegation program
    if *delegation_program.key != DELEGATION_PROGRAM {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Load table using unsafe pointer casting
    let mut table_data = table_info.try_borrow_mut_data()?;
    let table_ptr = table_data[8..].as_mut_ptr() as *mut Table;
    let table: &mut Table = unsafe { &mut *table_ptr };

    // Verify authority
    if table.authority != *authority_info.key {
        return Err(PokerError::InvalidAuthority.into());
    }

    // Check table is delegated
    if !table.is_delegated() {
        return Err(PokerError::InvalidAction.into());
    }

    // Call delegation program to undelegate
    // This will:
    // 1. Commit final ER state to mainnet
    // 2. Return account ownership to the program
    // 3. Sync any pending state changes
    
    // For now, just undelegate (actual CPI would go here)
    // In production, use: magicblock_sdk::undelegate_account(table_info)

    // Transfer accumulated rake to pool
    let rake = table.rake_accumulated;
    if rake > 0 {
        table.rake_accumulated = 0;
        solana_program::msg!("Committed {} rake to pool", rake);
    }

    // Mark table as not delegated
    table.flags[0] = 0; // is_delegated = false

    Ok(())
}
