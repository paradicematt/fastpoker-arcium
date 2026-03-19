use poker_api::prelude::*;
use solana_program::msg;
use steel::*;

/// Mint unrefined POKER rewards for tournament winner.
/// The winner's Unrefined PDA must already exist (created during registration
/// via init_unrefined). This just increments the balance — no tokens move.
pub fn process_mint_unrefined(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    // Parse instruction data
    let args = MintUnrefined::try_from_bytes(data)?;
    let amount = u64::from_le_bytes(args.amount);

    if amount == 0 {
        return Ok(());
    }

    // Parse accounts
    // winner_info is needed to derive+validate the PDA address
    let [authority_info, unrefined_info, pool_info, mint_info, _mint_authority_info, _token_program, winner_info, _system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate authority is signer
    authority_info.is_signer()?;

    // Load and validate pool
    let pool = pool_info.as_account_mut::<Pool>(&poker_api::ID)?;

    if pool.authority != *authority_info.key {
        return Err(PokerError::InvalidAuthority.into());
    }

    if pool.poker_mint != *mint_info.key {
        return Err(PokerError::InvalidTokenMint.into());
    }

    // Derive and validate unrefined PDA for winner
    let (unrefined_pda_addr, _bump) = unrefined_pda(winner_info.key);
    unrefined_info.has_address(&unrefined_pda_addr)?;

    // PDA must already exist (created during registration via init_unrefined)
    if unrefined_info.lamports() == 0 {
        msg!("Unrefined PDA not initialized for winner — call init_unrefined first");
        return Err(ProgramError::UninitializedAccount);
    }

    // Calculate pending refined rewards before adding new unrefined
    let unrefined = unrefined_info.as_account_mut::<Unrefined>(&poker_api::ID)?;
    unrefined.refined_amount = unrefined.calculate_refined(pool);

    // Add new unrefined rewards
    unrefined.unrefined_amount = unrefined.unrefined_amount
        .checked_add(amount)
        .ok_or(PokerError::Overflow)?;

    // Update pool total unrefined
    pool.total_unrefined = pool.total_unrefined
        .checked_add(amount)
        .ok_or(PokerError::Overflow)?;

    // Update debt for new balance (ORE pattern)
    // debt = new_balance × accumulated_refined_per_token
    unrefined.refined_debt = (unrefined.unrefined_amount as u128)
        .checked_mul(pool.accumulated_refined_per_token)
        .unwrap_or(0);

    Ok(())
}
