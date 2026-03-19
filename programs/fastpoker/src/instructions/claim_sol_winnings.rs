use anchor_lang::prelude::*;
use crate::state::player::{PlayerAccount, PLAYER_SEED};
use crate::errors::PokerError;

#[derive(Accounts)]
pub struct ClaimSolWinnings<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump = player_account.bump,
        constraint = player_account.wallet == player.key() @ PokerError::Unauthorized,
        constraint = player_account.claimable_sol > 0 @ PokerError::NothingToClaim,
    )]
    pub player_account: Account<'info, PlayerAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimSolWinnings>) -> Result<()> {
    let amount = ctx.accounts.player_account.claimable_sol;

    // Transfer claimable SOL from Player PDA to player wallet
    // Player PDA is owned by our program → we can debit its lamports
    // Player wallet can always be credited
    **ctx.accounts.player_account.to_account_info().try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += amount;

    // Zero out claimable balance
    ctx.accounts.player_account.claimable_sol = 0;

    msg!("Claimed {} SOL winnings to {}", amount, ctx.accounts.player.key());
    Ok(())
}
