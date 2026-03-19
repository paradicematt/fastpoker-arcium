use poker_api::prelude::*;
use steel::*;
use solana_program::system_program;

/// Deposit cash game rake - ACCUMULATED for epoch-based distribution
/// Called by game server after each hand with rake
/// Rake is accumulated in the current Epoch account
/// Distribution happens when backend calls advance_epoch
/// 
/// Split: 50% treasury (immediate), 50% stakers (epoch-based)
/// If no stakers, 100% goes to treasury immediately
pub fn process_deposit_rake(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    // Parse instruction data
    let args = DepositRake::try_from_bytes(data)?;
    let amount = u64::from_le_bytes(args.amount);

    if amount == 0 {
        return Ok(());
    }

    // Parse accounts
    let [authority_info, epoch_info, pool_info, treasury_info, source_info, system_program_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate authority is signer
    authority_info.is_signer()?;
    
    // Validate system program
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Load and validate pool
    let pool = pool_info.as_account::<Pool>(&poker_api::ID)?;
    
    if pool.authority != *authority_info.key {
        return Err(PokerError::InvalidAuthority.into());
    }

    // Validate epoch PDA matches current epoch
    let (epoch_pda_addr, _) = epoch_pda(pool.current_epoch);
    epoch_info.has_address(&epoch_pda_addr)?;

    // Calculate shares: 50% treasury, 50% stakers
    // If no stakers, 100% goes to treasury
    let (treasury_share, staker_share) = if pool.total_burned == 0 {
        (amount, 0) // 100% to treasury if no stakers
    } else {
        let staker = calculate_staker_share(amount);
        (amount - staker, staker)
    };

    // Transfer treasury share IMMEDIATELY
    if treasury_share > 0 {
        solana_program::program::invoke(
            &solana_program::system_instruction::transfer(
                source_info.key,
                treasury_info.key,
                treasury_share,
            ),
            &[source_info.clone(), treasury_info.clone()],
        )?;
    }

    // Staker share: transfer to pool but DON'T distribute yet
    // Accumulate in epoch for batch distribution
    if staker_share > 0 {
        solana_program::program::invoke(
            &solana_program::system_instruction::transfer(
                source_info.key,
                pool_info.key,
                staker_share,
            ),
            &[source_info.clone(), pool_info.clone()],
        )?;

        // Accumulate in current epoch (NOT distributed yet)
        let epoch = epoch_info.as_account_mut::<Epoch>(&poker_api::ID)?;
        epoch.rake_collected = epoch.rake_collected
            .checked_add(staker_share)
            .ok_or(PokerError::Overflow)?;
    }

    Ok(())
}
