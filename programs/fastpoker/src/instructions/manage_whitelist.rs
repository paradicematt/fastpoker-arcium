use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::TABLE_SEED;

/// Add a player to a private table's whitelist.
/// Only the table creator can add players. Table must be private.
///
/// Seeds: ["whitelist", table, player]
#[derive(Accounts)]
#[instruction(player: Pubkey)]
pub struct AddWhitelist<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.creator == creator.key() @ PokerError::Unauthorized,
        constraint = table.is_private @ PokerError::InvalidTableConfig,
    )]
    pub table: Account<'info, Table>,

    #[account(
        init,
        payer = creator,
        space = WhitelistEntry::SIZE,
        seeds = [WHITELIST_SEED, table.key().as_ref(), player.as_ref()],
        bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    pub system_program: Program<'info, System>,
}

pub fn add_handler(ctx: Context<AddWhitelist>, player: Pubkey) -> Result<()> {
    let clock = Clock::get()?;
    let entry = &mut ctx.accounts.whitelist_entry;

    entry.table = ctx.accounts.table.key();
    entry.player = player;
    entry.added_at = clock.unix_timestamp;
    entry.bump = ctx.bumps.whitelist_entry;

    msg!("Whitelisted {} for table {}", player, entry.table);
    Ok(())
}

/// Remove a player from a private table's whitelist.
/// Only the table creator can remove players.
/// Closes the PDA and returns rent to creator.
///
/// Seeds: ["whitelist", table, player]
#[derive(Accounts)]
#[instruction(player: Pubkey)]
pub struct RemoveWhitelist<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.creator == creator.key() @ PokerError::Unauthorized,
        constraint = table.is_private @ PokerError::InvalidTableConfig,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        close = creator,
        seeds = [WHITELIST_SEED, table.key().as_ref(), player.as_ref()],
        bump = whitelist_entry.bump,
        constraint = whitelist_entry.table == table.key() @ PokerError::InvalidAccountData,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
}

pub fn remove_handler(ctx: Context<RemoveWhitelist>, player: Pubkey) -> Result<()> {
    msg!("Removed {} from whitelist for table {}", player, ctx.accounts.table.key());
    Ok(())
}
