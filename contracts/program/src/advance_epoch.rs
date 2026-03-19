use poker_api::prelude::*;
use solana_program::{program::invoke_signed, system_instruction, rent::Rent, sysvar::Sysvar};
use steel::*;

/// Advance epoch - distributes accumulated rake to stakers and starts new epoch
/// Called by backend every X hours (e.g., every 6 hours)
/// 
/// Flow:
/// 1. Distribute accumulated rake from current epoch to weighted stakers
/// 2. Create new epoch account
/// 3. Update pool.current_epoch
pub fn process_advance_epoch(accounts: &[AccountInfo<'_>], _data: &[u8]) -> ProgramResult {
    // Parse accounts
    let [authority_info, current_epoch_info, new_epoch_info, pool_info, system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate authority is signer
    authority_info.is_signer()?;

    // Load and validate pool
    let pool = pool_info.as_account_mut::<Pool>(&poker_api::ID)?;
    
    if pool.authority != *authority_info.key {
        return Err(PokerError::InvalidAuthority.into());
    }

    let clock = solana_program::clock::Clock::get()?;
    let current_time = clock.unix_timestamp;

    // Validate current epoch PDA
    let (current_epoch_pda, _) = epoch_pda(pool.current_epoch);
    current_epoch_info.has_address(&current_epoch_pda)?;

    // Load current epoch and distribute accumulated rake
    let current_epoch = current_epoch_info.as_account_mut::<Epoch>(&poker_api::ID)?;
    let rake_to_distribute = current_epoch.rake_collected;

    if rake_to_distribute > 0 && pool.total_burned > 0 {
        // Distribute POKER rake to stakers using weighted distribution
        pool.poker_rewards_available = pool.poker_rewards_available
            .checked_add(rake_to_distribute)
            .ok_or(PokerError::Overflow)?;

        // Update accumulated POKER rewards per token for weighted claiming
        pool.update_poker_rewards(rake_to_distribute);

        // Mark as distributed (1 = true)
        current_epoch.distributed = 1;
    }

    // Close the current epoch (return lamports to authority)
    current_epoch.end_time = current_time;

    // Calculate new epoch number
    let new_epoch_number = pool.current_epoch
        .checked_add(1)
        .ok_or(PokerError::Overflow)?;

    // Derive and validate new epoch PDA
    let (new_epoch_pda_addr, new_epoch_bump) = epoch_pda(new_epoch_number);
    new_epoch_info.has_address(&new_epoch_pda_addr)?;

    // Create new epoch account (PDA)
    let space = std::mem::size_of::<Epoch>() + 8;
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);
    
    invoke_signed(
        &system_instruction::create_account(
            authority_info.key,
            new_epoch_info.key,
            lamports,
            space as u64,
            &poker_api::ID,
        ),
        &[authority_info.clone(), new_epoch_info.clone(), system_program.clone()],
        &[&[EPOCH, &new_epoch_number.to_le_bytes(), &[new_epoch_bump]]],
    )?;

    // Initialize new epoch data
    let new_epoch = new_epoch_info.as_account_mut::<Epoch>(&poker_api::ID)?;
    new_epoch.epoch_number = new_epoch_number;
    new_epoch.rake_collected = 0;
    new_epoch.start_time = current_time;
    new_epoch.end_time = 0; // Set when epoch ends
    new_epoch.distributed = 0;
    new_epoch.bump = new_epoch_bump;

    // Update pool current epoch
    pool.current_epoch = new_epoch_number;

    Ok(())
}
