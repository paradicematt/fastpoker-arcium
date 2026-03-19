use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Mint};
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::SUPER_ADMIN;

/// Admin initializes a RakeVault for a specific token mint.
/// One vault per token — accumulates distributed rake for stakers.
/// The vault_token_account is an ATA owned by the vault PDA.

#[derive(Accounts)]
pub struct InitRakeVault<'info> {
    #[account(
        mut,
        constraint = admin.key().to_bytes() == SUPER_ADMIN @ PokerError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = RakeVault::SIZE,
        seeds = [RAKE_VAULT_SEED, token_mint.key().as_ref()],
        bump,
    )]
    pub rake_vault: Account<'info, RakeVault>,

    /// The SPL token mint this vault will hold rake for
    pub token_mint: Account<'info, Mint>,

    /// Token account to hold vault funds (must be owned by rake_vault PDA)
    #[account(
        mut,
        constraint = vault_token_account.mint == token_mint.key() @ PokerError::InvalidTokenMint,
        constraint = vault_token_account.owner == rake_vault.key() @ PokerError::InvalidTokenAccount,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitRakeVault>) -> Result<()> {
    let vault = &mut ctx.accounts.rake_vault;

    vault.token_mint = ctx.accounts.token_mint.key();
    vault.total_deposited = 0;
    vault.total_claimed = 0;
    vault.current_epoch = 0;
    vault.last_deposit_time = Clock::get()?.unix_timestamp;
    vault.vault_token_account = ctx.accounts.vault_token_account.key();
    vault.bump = ctx.bumps.rake_vault;

    msg!(
        "RakeVault initialized for mint {} | vault_ata={}",
        vault.token_mint,
        vault.vault_token_account,
    );

    Ok(())
}
