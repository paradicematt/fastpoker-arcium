use poker_api::prelude::*;
use steel::*;

/// Claim all (unrefined + refined) at once
pub fn process_claim_all(accounts: &[AccountInfo<'_>], _data: &[u8]) -> ProgramResult {
    // Parse accounts
    let [winner_info, unrefined_info, pool_info, token_account_info, mint_info, mint_authority_info, token_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate signer
    winner_info.is_signer()?;
    
    // Validate token program
    token_program.is_program(&spl_token::ID)?;

    // Load pool
    let pool = pool_info.as_account_mut::<Pool>(&poker_api::ID)?;

    if pool.poker_mint != *mint_info.key {
        return Err(PokerError::InvalidTokenMint.into());
    }

    // Load and validate unrefined account
    let unrefined = unrefined_info.as_account_mut::<Unrefined>(&poker_api::ID)?;
    
    if unrefined.owner != *winner_info.key {
        return Err(PokerError::InvalidAuthority.into());
    }

    // Update refined from tax redistribution
    unrefined.refined_amount = unrefined.calculate_refined(pool);

    // Calculate total claimable
    let unrefined_amount = unrefined.unrefined_amount;
    let refined_amount = unrefined.refined_amount;
    
    if unrefined_amount == 0 && refined_amount == 0 {
        return Err(PokerError::NothingToClaim.into());
    }

    // Calculate after-tax amount for unrefined (90%)
    let (net_unrefined, tax_amount) = calculate_claim_after_tax(unrefined_amount);
    
    // Total to mint = net unrefined + all refined (refined is already taxed)
    let total_to_mint = net_unrefined
        .checked_add(refined_amount)
        .ok_or(PokerError::Overflow)?;

    // Derive mint authority PDA
    let (pool_pda_addr, pool_bump) = pool_pda();

    // Scale from 6-decimal (unrefined) to 9-decimal (SPL mint)
    let mint_amount = total_to_mint
        .checked_mul(UNREFINED_TO_SPL_SCALE)
        .ok_or(PokerError::Overflow)?;

    // Mint tokens to winner
    if mint_amount > 0 {
        solana_program::program::invoke_signed(
            &spl_token::instruction::mint_to(
                &spl_token::ID,
                mint_info.key,
                token_account_info.key,
                &pool_pda_addr,
                &[],
                mint_amount,
            )?,
            &[
                mint_info.clone(),
                token_account_info.clone(),
                mint_authority_info.clone(),
            ],
            &[&[POOL, &[pool_bump]]],
        )?;
    }

    // Update accumulated_refined_per_token (ORE pattern)
    // Tax is distributed proportionally to all unrefined holders
    if pool.total_unrefined > 0 {
        let refined_per_token = (tax_amount as u128)
            .checked_mul(1_000_000_000_000) // Scale up by 1e12
            .unwrap_or(0)
            .checked_div(pool.total_unrefined as u128)
            .unwrap_or(0);
        
        pool.accumulated_refined_per_token = pool.accumulated_refined_per_token
            .checked_add(refined_per_token)
            .unwrap_or(pool.accumulated_refined_per_token);
    }

    // Reduce total unrefined AFTER updating accumulated (important!)
    pool.total_unrefined = pool.total_unrefined
        .checked_sub(unrefined_amount)
        .ok_or(PokerError::InsufficientBalance)?;

    // Clear amounts and reset debt
    unrefined.unrefined_amount = 0;
    unrefined.refined_amount = 0;
    unrefined.refined_debt = 0; // Reset debt since balance is 0

    Ok(())
}
