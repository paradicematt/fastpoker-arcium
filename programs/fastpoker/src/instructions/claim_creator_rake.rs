use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::table::Table;
use crate::errors::PokerError;
use crate::constants::TABLE_SEED;

#[derive(Accounts)]
pub struct ClaimCreatorRake<'info> {
    /// Creator claiming their rake - must match table.creator
    #[account(mut)]
    pub creator: Signer<'info>,

    /// Table with accumulated creator rake
    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.is_user_created @ PokerError::NotUserCreatedTable,
        constraint = table.creator == creator.key() @ PokerError::NotTableCreator,
    )]
    pub table: Account<'info, Table>,

    /// Table's SOL escrow to transfer rake from
    /// CHECK: Table escrow PDA
    #[account(
        mut,
        seeds = [b"escrow", table.key().as_ref()],
        bump
    )]
    pub table_escrow: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Claim accumulated creator rake (25% of table rake for user-created tables)
pub fn handler(ctx: Context<ClaimCreatorRake>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let creator = &ctx.accounts.creator;
    
    let amount = table.creator_rake_total;
    require!(amount > 0, PokerError::NoRakeToClaim);

    // Transfer from table escrow to creator
    let table_key = table.key();
    let escrow_seeds = &[
        b"escrow".as_ref(),
        table_key.as_ref(),
        &[ctx.bumps.table_escrow],
    ];

    // Transfer SOL from escrow to creator
    let escrow_lamports = ctx.accounts.table_escrow.lamports();
    require!(escrow_lamports >= amount, PokerError::InsufficientFunds);

    **ctx.accounts.table_escrow.try_borrow_mut_lamports()? -= amount;
    **creator.try_borrow_mut_lamports()? += amount;

    // Reset creator rake total
    table.creator_rake_total = 0;

    msg!(
        "Creator {} claimed {} lamports rake from table {}",
        creator.key(),
        amount,
        table.key()
    );

    Ok(())
}
