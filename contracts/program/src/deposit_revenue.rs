use poker_api::prelude::*;
use steel::*;
use solana_program::system_program;

/// Deposit SOL buy-in revenue - IMMEDIATE distribution to stakers
/// Called when players buy into cash games with SOL
/// Distribution is real-time, weighted by burned $POKER
/// 
/// Split: 50% treasury (immediate), 50% stakers (immediate)
/// If no stakers, 100% goes to treasury
pub fn process_deposit_revenue(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    // Parse instruction data
    let args = DepositRevenue::try_from_bytes(data)?;
    let amount = u64::from_le_bytes(args.amount);
    // source_type: 0 = buy-in, 1 = rake (for tracking)

    if amount == 0 {
        return Ok(());
    }

    // Parse accounts - now includes treasury
    let [authority_info, pool_info, treasury_info, source_info, system_program_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate authority is signer
    authority_info.is_signer()?;
    
    // Validate system program
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Load and validate pool
    let pool = pool_info.as_account_mut::<Pool>(&poker_api::ID)?;
    
    if pool.authority != *authority_info.key {
        return Err(PokerError::InvalidAuthority.into());
    }

    // Calculate shares: 50% treasury, 50% stakers
    // If no stakers, 100% goes to treasury
    let (treasury_share, staker_share) = if pool.total_burned == 0 {
        (amount, 0) // 100% to treasury if no stakers
    } else {
        let staker = calculate_staker_share(amount);
        (amount - staker, staker)
    };

    // Transfer treasury share
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

    // Transfer staker share to pool (only if there are stakers)
    if staker_share > 0 {
        solana_program::program::invoke(
            &solana_program::system_instruction::transfer(
                source_info.key,
                pool_info.key,
                staker_share,
            ),
            &[source_info.clone(), pool_info.clone()],
        )?;

        // Update pool SOL rewards
        pool.sol_rewards_available = pool.sol_rewards_available
            .checked_add(staker_share)
            .ok_or(PokerError::Overflow)?;

        // Update accumulated SOL rewards per token (immediate distribution)
        pool.update_sol_rewards(staker_share);
    }

    Ok(())
}
