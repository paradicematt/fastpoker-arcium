use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// Player claims their unclaimed balance from a table
/// Only the original player can claim (before expiry)
/// Transfers POKER tokens from table escrow to player's token account

#[derive(Accounts)]
pub struct ClaimUnclaimed<'info> {
    /// Player claiming their balance - must match unclaimed.player
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
    )]
    pub table: Account<'info, Table>,

    /// Unclaimed balance PDA - closed after claim
    #[account(
        mut,
        seeds = [UNCLAIMED_SEED, table.key().as_ref(), player.key().as_ref()],
        bump = unclaimed.bump,
        constraint = unclaimed.player == player.key() @ PokerError::Unauthorized,
        constraint = unclaimed.table == table.key() @ PokerError::InvalidAccountData,
        constraint = unclaimed.amount > 0 @ PokerError::NothingToWithdraw,
        close = player,
    )]
    pub unclaimed: Account<'info, UnclaimedBalance>,

    /// Table's token escrow — mint must match table.token_mint
    #[account(
        mut,
        constraint = table_token_account.key() == table.token_escrow @ PokerError::InvalidEscrow,
        constraint = table_token_account.mint == table.token_mint @ PokerError::InvalidTokenMint,
    )]
    pub table_token_account: Account<'info, TokenAccount>,

    /// Player's token account — mint must match table.token_mint
    #[account(
        mut,
        constraint = player_token_account.owner == player.key() @ PokerError::InvalidTokenAccount,
        constraint = player_token_account.mint == table.token_mint @ PokerError::InvalidTokenMint,
    )]
    pub player_token_account: Account<'info, TokenAccount>,

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

pub fn handler(ctx: Context<ClaimUnclaimed>) -> Result<()> {
    let unclaimed = &ctx.accounts.unclaimed;
    let table = &mut ctx.accounts.table;
    let clock = Clock::get()?;

    // Check not expired (player can only claim before expiry)
    require!(
        !unclaimed.is_expired(clock.unix_timestamp),
        PokerError::UnclaimedExpired
    );

    let amount = unclaimed.amount;

    // Transfer tokens from table escrow to player
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
                to: ctx.accounts.player_token_account.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            &[escrow_seeds],
        ),
        amount,
    )?;

    // Decrement table's unclaimed balance count
    table.unclaimed_balance_count = table.unclaimed_balance_count.saturating_sub(1);

    msg!(
        "Player {} claimed {} POKER from table {}",
        ctx.accounts.player.key(),
        amount,
        table.key()
    );

    // Account is closed by Anchor due to `close = player`
    Ok(())
}
