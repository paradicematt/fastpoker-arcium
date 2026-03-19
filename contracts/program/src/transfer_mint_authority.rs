use poker_api::prelude::*;
use solana_program::program::invoke_signed;
use solana_program::pubkey::Pubkey;
use steel::*;

/// Transfer mint authority from Pool PDA to a new authority
/// This is a one-time migration instruction
/// Note: Handles old Pool struct (144 bytes) by reading authority directly
pub fn process_transfer_mint_authority(accounts: &[AccountInfo<'_>], _data: &[u8]) -> ProgramResult {
    // Parse accounts
    let [authority_info, pool_info, mint_info, new_authority_info, token_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate authority is signer (must be pool authority)
    if !authority_info.is_signer {
        return Err(solana_program::program_error::ProgramError::MissingRequiredSignature);
    }

    // Validate token program
    if *token_program.key != spl_token::ID {
        return Err(solana_program::program_error::ProgramError::IncorrectProgramId);
    }

    // Read authority directly from pool data (offset 8 = after discriminator)
    let pool_data = pool_info.try_borrow_data()?;
    if pool_data.len() < 40 {
        return Err(solana_program::program_error::ProgramError::InvalidAccountData);
    }
    let stored_authority = Pubkey::try_from(&pool_data[8..40])
        .map_err(|_| solana_program::program_error::ProgramError::InvalidAccountData)?;
    
    if stored_authority != *authority_info.key {
        solana_program::msg!("Authority mismatch: stored={}, signer={}", stored_authority, authority_info.key);
        return Err(PokerError::InvalidAuthority.into());
    }
    drop(pool_data);

    // Derive pool PDA for signing
    let (pool_pda, bump) = pool_pda();
    if pool_pda != *pool_info.key {
        return Err(solana_program::program_error::ProgramError::InvalidSeeds);
    }

    // Transfer mint authority using set_authority
    invoke_signed(
        &spl_token::instruction::set_authority(
            &spl_token::ID,
            mint_info.key,
            Some(new_authority_info.key),
            spl_token::instruction::AuthorityType::MintTokens,
            &pool_pda,
            &[],
        )?,
        &[mint_info.clone(), pool_info.clone()],
        &[&[POOL, &[bump]]],
    )?;

    solana_program::msg!("Mint authority transferred to {}", new_authority_info.key);

    Ok(())
}
