use poker_api::prelude::*;
use solana_program::{program::invoke_signed, system_instruction, system_program, rent::Rent, sysvar::Sysvar};
use steel::*;

/// Initialize the staking pool
pub fn process_initialize(accounts: &[AccountInfo<'_>], _data: &[u8]) -> ProgramResult {
    // Parse accounts
    let [authority_info, pool_info, poker_mint_info, system_program_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate authority is signer (using native check instead of Steel)
    if !authority_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Validate system program
    if *system_program_info.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Derive and validate pool PDA
    let (pool_pda, bump) = pool_pda();
    pool_info.has_address(&pool_pda)?;

    // Create pool account (PDA)
    let space = std::mem::size_of::<Pool>() + 8;
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);
    
    invoke_signed(
        &system_instruction::create_account(
            authority_info.key,
            pool_info.key,
            lamports,
            space as u64,
            &poker_api::ID,
        ),
        &[authority_info.clone(), pool_info.clone(), system_program_info.clone()],
        &[&[POOL, &[bump]]],
    )?;

    // Initialize pool data
    let pool = pool_info.as_account_mut::<Pool>(&poker_api::ID)?;
    pool.authority = *authority_info.key;
    pool.poker_mint = *poker_mint_info.key;
    pool.total_burned = 0;
    pool.sol_rewards_available = 0;
    pool.sol_rewards_distributed = 0;
    pool.accumulated_sol_per_token = 0;
    pool.poker_rewards_available = 0;
    pool.poker_rewards_distributed = 0;
    pool.accumulated_poker_per_token = 0;
    pool.total_unrefined = 0;
    pool.accumulated_refined_per_token = 0;
    pool.current_epoch = 0;
    pool.bump = bump;

    Ok(())
}
