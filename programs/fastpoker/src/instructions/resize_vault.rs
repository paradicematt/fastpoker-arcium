use anchor_lang::prelude::*;
use crate::state::TableVault;
use crate::constants::VAULT_SEED;
use crate::errors::PokerError;

/// Resize an old TableVault to current size (113 bytes).
/// Handles 57→73→105→113 byte migrations (adds rake_nonce, total_rake_distributed, token_mint, total_crank_distributed).
/// Idempotent — no-op if vault is already the correct size.
/// New bytes are zero-filled: token_mint defaults to Pubkey::default() (SOL).

#[derive(Accounts)]
pub struct ResizeVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Only used for vault seed derivation
    pub table: UncheckedAccount<'info>,

    /// CHECK: Manually validated — owner, discriminator, seeds.
    /// Cannot use Account<TableVault> because old 57-byte vaults fail deserialization.
    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump,
    )]
    pub vault: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ResizeVault>) -> Result<()> {
    let vault = &ctx.accounts.vault;

    // Must be owned by our program
    require!(
        vault.owner == &crate::ID,
        PokerError::InvalidAccountData
    );

    let data = vault.try_borrow_data()?;
    require!(data.len() >= 57, PokerError::InvalidAccountData);

    // Check discriminator
    let expected_disc = <TableVault as anchor_lang::Discriminator>::DISCRIMINATOR;
    require!(
        data[..8] == *expected_disc,
        PokerError::InvalidAccountData
    );
    drop(data);

    // Already correct size — no-op
    if vault.data_len() >= TableVault::SIZE {
        msg!("Vault already {} bytes, no resize needed", vault.data_len());
        return Ok(());
    }

    // Transfer additional rent from payer
    let rent = Rent::get()?;
    let new_rent = rent.minimum_balance(TableVault::SIZE);
    let old_rent = rent.minimum_balance(vault.data_len());
    let diff = new_rent.saturating_sub(old_rent);

    if diff > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: vault.to_account_info(),
                },
            ),
            diff,
        )?;
    }

    // Realloc — zero new bytes so new fields default to 0
    vault.realloc(TableVault::SIZE, false)?;

    msg!("Vault resized to {} bytes", TableVault::SIZE);
    Ok(())
}
