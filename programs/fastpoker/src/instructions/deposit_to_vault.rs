use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::PokerError;

/// Deposit rake tokens into a RakeVault.
/// Called by the crank after process_rake_distribution moves tokens to the pool.
/// The depositor transfers tokens from a source account into the vault's ATA.
/// Increments current_epoch so stakers can claim the new batch.

#[derive(Accounts)]
pub struct DepositToVault<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [RAKE_VAULT_SEED, rake_vault.token_mint.as_ref()],
        bump = rake_vault.bump,
    )]
    pub rake_vault: Account<'info, RakeVault>,

    /// Source token account (e.g., pool's ATA for this token)
    #[account(
        mut,
        constraint = source_token_account.mint == rake_vault.token_mint @ PokerError::InvalidTokenMint,
    )]
    pub source_token_account: Account<'info, TokenAccount>,

    /// Vault's token account (receives deposited tokens)
    #[account(
        mut,
        constraint = vault_token_account.key() == rake_vault.vault_token_account @ PokerError::InvalidTokenAccount,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<DepositToVault>, amount: u64) -> Result<()> {
    require!(amount > 0, PokerError::ZeroBidAmount);

    // Transfer tokens from source to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )?;

    let vault = &mut ctx.accounts.rake_vault;
    vault.total_deposited += amount;
    vault.current_epoch += 1;
    vault.last_deposit_time = Clock::get()?.unix_timestamp;

    msg!(
        "Deposited {} tokens to RakeVault (mint={}) | epoch={} | total_deposited={}",
        amount,
        vault.token_mint,
        vault.current_epoch,
        vault.total_deposited,
    );

    Ok(())
}
