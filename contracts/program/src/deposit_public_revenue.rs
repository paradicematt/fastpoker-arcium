use poker_api::prelude::*;
use steel::*;
use solana_program::system_program;

/// Deposit SOL revenue - PUBLIC (anyone can call)
/// Splits 50/50 between treasury and stakers with proper pool accounting.
/// Called via CPI from Anchor program during registration, SNG entry, etc.
///
/// Accounts:
/// 0. [signer, writable] Payer (source of SOL)
/// 1. [writable] Pool account
/// 2. [writable] Treasury account
/// 3. [] System program
pub fn process_deposit_public_revenue(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    let args = DepositPublicRevenue::try_from_bytes(data)?;
    let amount = u64::from_le_bytes(args.amount);

    if amount == 0 {
        return Ok(());
    }

    let [payer_info, pool_info, treasury_info, system_program_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate payer is signer
    payer_info.is_signer()?;

    // Validate system program
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Validate pool PDA
    let (expected_pool, _) = pool_pda();
    if *pool_info.key != expected_pool {
        return Err(ProgramError::InvalidSeeds);
    }

    // Load pool
    let pool = pool_info.as_account_mut::<Pool>(&poker_api::ID)?;

    // Calculate shares: 50% treasury, 50% stakers
    // If no stakers, 100% goes to treasury
    let (treasury_share, staker_share) = if pool.total_burned == 0 {
        (amount, 0)
    } else {
        let staker = calculate_staker_share(amount);
        (amount - staker, staker)
    };

    // Transfer treasury share
    if treasury_share > 0 {
        solana_program::program::invoke(
            &solana_program::system_instruction::transfer(
                payer_info.key,
                treasury_info.key,
                treasury_share,
            ),
            &[payer_info.clone(), treasury_info.clone()],
        )?;
    }

    // Transfer staker share to pool
    if staker_share > 0 {
        solana_program::program::invoke(
            &solana_program::system_instruction::transfer(
                payer_info.key,
                pool_info.key,
                staker_share,
            ),
            &[payer_info.clone(), pool_info.clone()],
        )?;

        // Update pool SOL rewards accounting
        pool.sol_rewards_available = pool.sol_rewards_available
            .checked_add(staker_share)
            .ok_or(PokerError::Overflow)?;

        // Update accumulated SOL rewards per token (immediate distribution)
        pool.update_sol_rewards(staker_share);
    }

    Ok(())
}
