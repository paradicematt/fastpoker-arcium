use poker_api::prelude::*;
use steel::*;

/// Claim pending withdrawal - transfer POKER tokens to player
pub fn process_claim_pending_withdrawal(accounts: &[AccountInfo<'_>], _data: &[u8]) -> ProgramResult {
    // Parse accounts
    let [player_info, pending_info, player_token_info, escrow_token_info, token_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate player is signer
    player_info.is_signer()?;
    
    // Validate token program
    token_program.is_program(&spl_token::ID)?;

    // Load pending withdrawal
    let pending = pending_info.as_account::<PendingWithdrawal>(&poker_api::ID)?;

    // Verify this is the player's pending withdrawal
    if pending.owner != *player_info.key {
        return Err(PokerError::InvalidAuthority.into());
    }

    let amount = pending.amount;
    if amount == 0 {
        return Err(PokerError::NothingToClaim.into());
    }

    // Derive PDA for signing
    let (expected_pda, bump) = Pubkey::find_program_address(
        &[b"pending", player_info.key.as_ref()],
        &poker_api::ID,
    );

    if *pending_info.key != expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Transfer POKER tokens from escrow to player
    solana_program::program::invoke_signed(
        &spl_token::instruction::transfer(
            &spl_token::ID,
            escrow_token_info.key,
            player_token_info.key,
            pending_info.key, // PDA is authority over escrow
            &[],
            amount,
        )?,
        &[
            escrow_token_info.clone(),
            player_token_info.clone(),
            pending_info.clone(),
            token_program.clone(),
        ],
        &[&[b"pending", player_info.key.as_ref(), &[bump]]],
    )?;

    // Close the pending withdrawal account (return rent to player)
    let pending_lamports = pending_info.lamports();
    **pending_info.try_borrow_mut_lamports()? = 0;
    **player_info.try_borrow_mut_lamports()? += pending_lamports;

    // Zero out the account data
    let mut pending_data = pending_info.try_borrow_mut_data()?;
    pending_data.fill(0);

    Ok(())
}
