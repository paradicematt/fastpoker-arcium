use anchor_lang::prelude::*;
use crate::state::*;

/// Register as a crank operator (Dealer).
/// Creates a CrankOperator PDA on L1. Anyone can register.
/// Operator pays rent for their own PDA.
///
/// Seeds: ["crank", authority]
#[derive(Accounts)]
pub struct RegisterCrankOperator<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = CrankOperator::SIZE,
        seeds = [CRANK_OPERATOR_SEED, authority.key().as_ref()],
        bump,
    )]
    pub crank_operator: Account<'info, CrankOperator>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RegisterCrankOperator>) -> Result<()> {
    let clock = Clock::get()?;
    let op = &mut ctx.accounts.crank_operator;

    op.authority = ctx.accounts.authority.key();
    op.mode = CrankMode::AcceptAll;
    op.rake_dist_interval = 0; // manual by default
    op.lifetime_actions = 0;
    op.lifetime_sol_earned = 0;
    op.lifetime_token_earned = 0;
    op.registered_at = clock.unix_timestamp;
    op.bump = ctx.bumps.crank_operator;

    msg!("Crank operator registered: {}", op.authority);
    Ok(())
}

/// Update crank operator configuration (mode, rake_dist_interval).
/// Only the operator themselves can update.
#[derive(Accounts)]
pub struct UpdateCrankOperator<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CRANK_OPERATOR_SEED, authority.key().as_ref()],
        bump = crank_operator.bump,
        constraint = crank_operator.authority == authority.key(),
    )]
    pub crank_operator: Account<'info, CrankOperator>,
}

pub fn update_handler(
    ctx: Context<UpdateCrankOperator>,
    mode: CrankMode,
    rake_dist_interval: u64,
) -> Result<()> {
    let op = &mut ctx.accounts.crank_operator;
    op.mode = mode;
    op.rake_dist_interval = rake_dist_interval;

    msg!("Crank operator updated: mode={:?}, interval={}", mode, rake_dist_interval);
    Ok(())
}
