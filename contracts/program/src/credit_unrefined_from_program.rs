use poker_api::prelude::*;
use solana_program::msg;
use solana_program::pubkey::Pubkey;
use steel::*;

/// Credit unrefined POKER rewards via CPI from the authorized CQ-Poker program.
///
/// Authorization: The signer must be a PDA derived from the CQ-Poker program ID
/// with seeds ["prize_authority"]. This proves the call originated from the poker
/// program's distribute_prizes instruction — no pool authority keypair needed.
///
/// Winner pubkey is passed in instruction data (not as an account) to simplify
/// CPI from the poker program which doesn't have winner wallet AccountInfos.
///
/// Same logic as mint_unrefined: increments unrefined_amount, updates pool totals,
/// recalculates refined debt (ORE pattern).
pub fn process_credit_unrefined_from_program(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    let args = CreditUnrefinedFromProgram::try_from_bytes(data)?;
    let amount = u64::from_le_bytes(args.amount);

    if amount == 0 {
        return Ok(());
    }

    // Read winner pubkey from instruction data
    let winner_key = Pubkey::new_from_array(args.winner);

    // Parse accounts (3 accounts: signer, unrefined, pool)
    let [program_signer_info, unrefined_info, pool_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate signer
    program_signer_info.is_signer()?;

    // Verify the signer PDA was derived from the authorized FastPoker program
    let poker_program_id = Pubkey::new_from_array(FASTPOKER_PROGRAM_ID);
    let (expected_pda, _bump) = Pubkey::find_program_address(
        &[PRIZE_AUTHORITY_SEED],
        &poker_program_id,
    );

    if *program_signer_info.key != expected_pda {
        msg!(
            "Prize authority mismatch: expected {} (from FastPoker {}), got {}",
            expected_pda,
            poker_program_id,
            program_signer_info.key
        );
        return Err(PokerError::InvalidAuthority.into());
    }

    // Load and validate pool
    let pool = pool_info.as_account_mut::<Pool>(&poker_api::ID)?;

    // Derive and validate unrefined PDA for winner (from data, not account)
    let (unrefined_pda_addr, _bump) = unrefined_pda(&winner_key);
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
    unrefined.refined_debt = (unrefined.unrefined_amount as u128)
        .checked_mul(pool.accumulated_refined_per_token)
        .unwrap_or(0);

    msg!(
        "Credited {} unrefined POKER to {} via CQ-Poker CPI",
        amount,
        winner_key
    );

    Ok(())
}
