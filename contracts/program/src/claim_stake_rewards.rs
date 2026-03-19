use poker_api::prelude::*;
use steel::*;
use solana_program::msg;

/// Claim staker's share of BOTH rewards:
/// 1. SOL - 50% of registrations + buy-ins
/// 2. POKER - 50% of rake from cash games
/// Single claim instruction gets both reward types
pub fn process_claim_stake_rewards(accounts: &[AccountInfo<'_>], _data: &[u8]) -> ProgramResult {
    // Parse accounts
    let [staker_info, stake_info, pool_info, staker_token_account, pool_token_account, token_program, _system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let stake_lamports_before = stake_info.lamports();
    let staker_token_lamports_before = staker_token_account.lamports();
    let pool_token_lamports_before = pool_token_account.lamports();

    // Validate signer
    staker_info.is_signer()?;

    // Load pool
    let pool = pool_info.as_account_mut::<Pool>(&poker_api::ID)?;

    // Load and validate stake account
    let stake = stake_info.as_account_mut::<Stake>(&poker_api::ID)?;
    
    if stake.owner != *staker_info.key {
        return Err(PokerError::InvalidAuthority.into());
    }

    // Calculate pending SOL rewards
    let pending_sol = pool.calculate_pending_sol(stake);
    let total_sol_claimable = stake.pending_sol
        .checked_add(pending_sol)
        .ok_or(PokerError::Overflow)?;

    // Calculate pending POKER rewards
    let pending_poker = pool.calculate_pending_poker(stake);
    let total_poker_claimable = stake.pending_poker
        .checked_add(pending_poker)
        .ok_or(PokerError::Overflow)?;

    if total_sol_claimable == 0 && total_poker_claimable == 0 {
        return Err(PokerError::NothingToClaim.into());
    }

    // === Claim POKER ===
    // POKER rewards come from cash game rake — transferred to pool's token account
    // by Anchor distribute_rake. We transfer from pool's ATA to staker's ATA.
    if total_poker_claimable > 0 {
        // Derive pool PDA for signing
        let (_pool_pda_addr, pool_bump) = pool_pda();
        
        // Transfer POKER from pool's token account to staker
        solana_program::program::invoke_signed(
            &spl_token::instruction::transfer(
                &spl_token::ID,
                pool_token_account.key,   // pool's POKER token account (source)
                staker_token_account.key, // staker's POKER token account (dest)
                pool_info.key,            // pool PDA as authority
                &[],
                total_poker_claimable,
            )?,
            &[
                pool_token_account.clone(),
                staker_token_account.clone(),
                pool_info.clone(),
                token_program.clone(),
            ],
            &[&[POOL, &[pool_bump]]],
        )?;

        // Update pool POKER tracking
        pool.poker_rewards_available = pool.poker_rewards_available
            .checked_sub(total_poker_claimable)
            .ok_or(PokerError::InsufficientBalance)?;
        
        pool.poker_rewards_distributed = pool.poker_rewards_distributed
            .checked_add(total_poker_claimable)
            .ok_or(PokerError::Overflow)?;
    }

    // === Claim SOL ===
    // Keep SOL transfer AFTER any CPI calls (token transfer). If lamports are moved before
    // CPI, runtime balance checks on invoke can fail with UnbalancedInstruction.
    if total_sol_claimable > 0 {
        let pool_before = pool_info.lamports();
        let staker_before = staker_info.lamports();

        if pool_before < total_sol_claimable {
            return Err(PokerError::InsufficientBalance.into());
        }

        msg!(
            "claim_sol_before pool={} staker={} claimable={}",
            pool_before,
            staker_before,
            total_sol_claimable
        );

        // Transfer SOL from pool to staker
        **pool_info.try_borrow_mut_lamports()? -= total_sol_claimable;
        **staker_info.try_borrow_mut_lamports()? += total_sol_claimable;

        let pool_after = pool_info.lamports();
        let staker_after = staker_info.lamports();
        msg!(
            "claim_sol_after pool={} staker={} delta_pool={} delta_staker={}",
            pool_after,
            staker_after,
            pool_before.saturating_sub(pool_after),
            staker_after.saturating_sub(staker_before)
        );

        // Update pool SOL tracking
        pool.sol_rewards_available = pool.sol_rewards_available
            .checked_sub(total_sol_claimable)
            .ok_or(PokerError::InsufficientBalance)?;
        
        pool.sol_rewards_distributed = pool.sol_rewards_distributed
            .checked_add(total_sol_claimable)
            .ok_or(PokerError::Overflow)?;
    }

    // Update stake debts
    stake.pending_sol = 0;
    stake.pending_poker = 0;
    stake.sol_reward_debt = (stake.burned_amount as u128)
        .checked_mul(pool.accumulated_sol_per_token)
        .ok_or(PokerError::Overflow)?;
    stake.poker_reward_debt = (stake.burned_amount as u128)
        .checked_mul(pool.accumulated_poker_per_token)
        .ok_or(PokerError::Overflow)?;
    stake.last_claim = solana_program::clock::Clock::get()?.unix_timestamp;

    msg!(
        "claim_lamport_check stake_delta={} staker_token_delta={} pool_token_delta={}",
        stake_info.lamports().saturating_sub(stake_lamports_before),
        staker_token_account
            .lamports()
            .saturating_sub(staker_token_lamports_before),
        pool_token_account
            .lamports()
            .saturating_sub(pool_token_lamports_before)
    );

    Ok(())
}
