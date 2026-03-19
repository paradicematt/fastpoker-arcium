use poker_api::prelude::*;
use solana_program::program_pack::Pack;
use steel::*;

/// Record POKER rake for staker rewards.
/// Called by crank after Anchor distribute_rake moves POKER to pool's token account.
/// Updates pool.poker_rewards_available and accumulated_poker_per_token so stakers
/// can claim their share of cash game rake.
///
/// SECURITY: Requires the pool's POKER token account as a 3rd account.
/// Verifies that the actual SPL token balance >= poker_rewards_available + new amount.
/// This prevents recording phantom POKER that doesn't exist as real tokens.
///
/// Accounts:
/// 0. [signer] Authority (pool authority)
/// 1. [writable] Pool account
/// 2. [] Pool's POKER token account (ATA — balance proof)
pub fn process_record_poker_rake(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    // Parse instruction data
    let args = RecordPokerRake::try_from_bytes(data)?;
    let amount = u64::from_le_bytes(args.amount);

    if amount == 0 {
        return Ok(());
    }

    // Parse accounts
    let [authority_info, pool_info, pool_token_account_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate authority is signer
    authority_info.is_signer()?;

    // Load and validate pool
    let pool = pool_info.as_account_mut::<Pool>(&poker_api::ID)?;

    if pool.authority != *authority_info.key {
        return Err(PokerError::InvalidAuthority.into());
    }

    // Skip if no stakers
    if pool.total_burned == 0 {
        return Ok(());
    }

    // === Token balance proof ===
    // Verify the pool's POKER token account actually has enough tokens
    // to back all poker_rewards_available + this new amount.
    let token_account_data = pool_token_account_info.try_borrow_data()?;
    let token_account = spl_token::state::Account::unpack(&token_account_data)?;

    // Verify token account is owned by SPL Token program
    if *pool_token_account_info.owner != spl_token::ID {
        return Err(ProgramError::IllegalOwner);
    }

    // Verify token account authority is the pool PDA
    if token_account.owner != *pool_info.key {
        solana_program::msg!("Token account owner mismatch: expected pool PDA");
        return Err(PokerError::InvalidAuthority.into());
    }

    // Verify token account mint matches pool's poker_mint
    if token_account.mint != pool.poker_mint {
        solana_program::msg!("Token account mint mismatch: expected POKER mint");
        return Err(PokerError::InvalidAuthority.into());
    }

    let new_total_available = pool.poker_rewards_available
        .checked_add(amount)
        .ok_or(PokerError::Overflow)?;

    // CRITICAL: actual token balance must cover all claimed rewards
    if token_account.amount < new_total_available {
        solana_program::msg!(
            "Token balance proof failed: account has {} but need {} (available {} + new {})",
            token_account.amount,
            new_total_available,
            pool.poker_rewards_available,
            amount,
        );
        return Err(PokerError::InsufficientBalance.into());
    }

    // Update POKER rewards accounting
    pool.poker_rewards_available = new_total_available;
    pool.update_poker_rewards(amount);

    solana_program::msg!(
        "Recorded {} POKER rake for stakers. Total available: {} (token balance: {})",
        amount,
        pool.poker_rewards_available,
        token_account.amount,
    );

    Ok(())
}
