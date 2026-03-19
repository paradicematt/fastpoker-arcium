use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// Table creator reclaims expired unclaimed balances
/// Only callable after UNCLAIMED_EXPIRY_SECONDS (100 days) from last_active_at
/// Transfers POKER tokens from table escrow to creator's token account

#[derive(Accounts)]
#[instruction(player: Pubkey)]
pub struct ReclaimExpired<'info> {
    /// Table creator - must match table.creator
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.is_user_created @ PokerError::NotUserCreatedTable,
        constraint = table.creator == creator.key() @ PokerError::NotTableCreator,
    )]
    pub table: Account<'info, Table>,

    /// Unclaimed balance PDA for specific player - closed after reclaim
    #[account(
        mut,
        seeds = [UNCLAIMED_SEED, table.key().as_ref(), player.as_ref()],
        bump = unclaimed.bump,
        constraint = unclaimed.table == table.key() @ PokerError::InvalidAccountData,
        constraint = unclaimed.amount > 0 @ PokerError::NothingToWithdraw,
        close = creator,
    )]
    pub unclaimed: Account<'info, UnclaimedBalance>,

    /// Table's token escrow
    #[account(
        mut,
        constraint = table_token_account.key() == table.token_escrow @ PokerError::InvalidEscrow,
    )]
    pub table_token_account: Account<'info, TokenAccount>,

    /// Creator's POKER token account
    #[account(
        mut,
        constraint = creator_token_account.owner == creator.key() @ PokerError::InvalidTokenAccount,
    )]
    pub creator_token_account: Account<'info, TokenAccount>,

    /// Table escrow authority PDA
    /// CHECK: PDA that controls the table token escrow
    #[account(
        seeds = [b"escrow", table.key().as_ref()],
        bump,
    )]
    pub escrow_authority: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ReclaimExpired>, _player: Pubkey) -> Result<()> {
    let unclaimed = &ctx.accounts.unclaimed;
    let table = &mut ctx.accounts.table;
    let clock = Clock::get()?;

    // Check that balance IS expired (creator can only claim after expiry)
    require!(
        unclaimed.is_expired(clock.unix_timestamp),
        PokerError::UnclaimedNotExpired
    );

    let amount = unclaimed.amount;
    let original_player = unclaimed.player;

    // Transfer tokens from table escrow to creator
    let table_key = table.key();
    let escrow_seeds = &[
        b"escrow".as_ref(),
        table_key.as_ref(),
        &[ctx.bumps.escrow_authority],
    ];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.table_token_account.to_account_info(),
                to: ctx.accounts.creator_token_account.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            &[escrow_seeds],
        ),
        amount,
    )?;

    // Decrement table's unclaimed balance count
    table.unclaimed_balance_count = table.unclaimed_balance_count.saturating_sub(1);

    msg!(
        "Creator {} reclaimed {} expired POKER from player {} on table {}",
        ctx.accounts.creator.key(),
        amount,
        original_player,
        table.key()
    );

    // Account is closed by Anchor due to `close = creator`
    Ok(())
}
