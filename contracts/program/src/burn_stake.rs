use poker_api::prelude::*;
use solana_program::{program::invoke_signed, system_instruction, rent::Rent, sysvar::Sysvar};
use steel::*;

/// Burn to Earn: Permanently burn $POKER tokens to stake for SOL rewards
/// Stakers receive 50% of all rake from Fast Poker cash games
pub fn process_burn_stake(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    // Parse instruction data
    let args = BurnStake::try_from_bytes(data)?;
    let amount = u64::from_le_bytes(args.amount);

    if amount == 0 {
        return Err(PokerError::InvalidStakeAmount.into());
    }

    // Parse accounts (includes system_program for account creation)
    let [staker_info, stake_info, pool_info, token_account_info, mint_info, token_program, system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate signer
    staker_info.is_signer()?;
    
    // Validate token program
    token_program.is_program(&spl_token::ID)?;

    // Derive and validate stake PDA
    let (stake_pda_addr, stake_bump) = stake_pda(staker_info.key);
    stake_info.has_address(&stake_pda_addr)?;

    // Load pool
    let pool = pool_info.as_account_mut::<Pool>(&poker_api::ID)?;
    
    // Validate mint matches pool
    if pool.poker_mint != *mint_info.key {
        return Err(PokerError::InvalidTokenMint.into());
    }

    // Create stake account if needed (PDA)
    if stake_info.lamports() == 0 {
        let space = std::mem::size_of::<Stake>() + 8;
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(space);
        
        invoke_signed(
            &system_instruction::create_account(
                staker_info.key,
                stake_info.key,
                lamports,
                space as u64,
                &poker_api::ID,
            ),
            &[staker_info.clone(), stake_info.clone(), system_program.clone()],
            &[&[STAKE, staker_info.key.as_ref(), &[stake_bump]]],
        )?;
        
        // Write discriminator first
        let mut data = stake_info.try_borrow_mut_data()?;
        data[0] = PokerAccount::Stake as u8;
        drop(data);
        
        let stake = stake_info.as_account_mut::<Stake>(&poker_api::ID)?;
        stake.owner = *staker_info.key;
        stake.burned_amount = 0;
        stake.sol_reward_debt = 0;
        stake.pending_sol = 0;
        stake.poker_reward_debt = 0;
        stake.pending_poker = 0;
        stake.last_claim = 0;
        stake.bump = stake_bump;
    }

    // Calculate pending rewards before updating stake
    let stake = stake_info.as_account_mut::<Stake>(&poker_api::ID)?;
    let pending_sol = pool.calculate_pending_sol(stake);
    let pending_poker = pool.calculate_pending_poker(stake);
    stake.pending_sol = stake.pending_sol
        .checked_add(pending_sol)
        .ok_or(PokerError::Overflow)?;
    stake.pending_poker = stake.pending_poker
        .checked_add(pending_poker)
        .ok_or(PokerError::Overflow)?;

    // Burn tokens
    solana_program::program::invoke(
        &spl_token::instruction::burn(
            &spl_token::ID,
            token_account_info.key,
            mint_info.key,
            staker_info.key,
            &[],
            amount,
        )?,
        &[
            token_account_info.clone(),
            mint_info.clone(),
            staker_info.clone(),
        ],
    )?;

    // Update stake
    stake.burned_amount = stake.burned_amount
        .checked_add(amount)
        .ok_or(PokerError::Overflow)?;

    // Update pool total
    pool.total_burned = pool.total_burned
        .checked_add(amount)
        .ok_or(PokerError::Overflow)?;

    // Update reward debts for both SOL and POKER
    stake.sol_reward_debt = (stake.burned_amount as u128)
        .checked_mul(pool.accumulated_sol_per_token)
        .ok_or(PokerError::Overflow)?;
    stake.poker_reward_debt = (stake.burned_amount as u128)
        .checked_mul(pool.accumulated_poker_per_token)
        .ok_or(PokerError::Overflow)?;

    Ok(())
}
