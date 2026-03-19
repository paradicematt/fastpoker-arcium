use poker_api::prelude::*;
use solana_program::msg;
use solana_program::pubkey::Pubkey;
use steel::*;

/// Notify the pool that SOL has been deposited directly (via lamport manipulation).
///
/// Called via CPI from CQ-Poker's distribute_prizes after it transfers SOL
/// directly to pool + treasury. This instruction ONLY updates pool accounting
/// (sol_rewards_available, accumulated rewards) — no system_instruction::transfer.
///
/// Authorization: signer must be the prize_authority PDA derived from CQ-Poker.
///
/// Accounts:
/// 0. [signer] Program signer (prize_authority PDA from CQ-Poker)
/// 1. [writable] Pool account
pub fn process_notify_pool_sol_deposit(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    let args = NotifyPoolSolDeposit::try_from_bytes(data)?;
    let staker_share = u64::from_le_bytes(args.amount);

    if staker_share == 0 {
        return Ok(());
    }

    let [program_signer_info, pool_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate signer is the prize_authority PDA from FastPoker
    program_signer_info.is_signer()?;

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

    // Validate pool PDA
    let (expected_pool, _) = pool_pda();
    if *pool_info.key != expected_pool {
        return Err(ProgramError::InvalidSeeds);
    }

    // Load pool and update SOL rewards accounting
    let pool = pool_info.as_account_mut::<Pool>(&poker_api::ID)?;

    pool.sol_rewards_available = pool.sol_rewards_available
        .checked_add(staker_share)
        .ok_or(PokerError::Overflow)?;

    pool.update_sol_rewards(staker_share);

    msg!(
        "Pool SOL rewards updated: +{} lamports (notify from CQ-Poker distribute_prizes)",
        staker_share
    );

    Ok(())
}
