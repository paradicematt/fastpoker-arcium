use anchor_lang::prelude::*;
use crate::state::TableVault;
use crate::constants::VAULT_SEED;
use crate::errors::PokerError;

// GkfdM1vqRYrU2LJ4ipwCJ3vsr2PGYLpdtdKK121ZkQZg
const SUPER_ADMIN: [u8; 32] = [
    0xea, 0x0e, 0xf4, 0x37, 0x22, 0x4d, 0x04, 0xe8,
    0x81, 0xdd, 0x10, 0xfd, 0x84, 0xb2, 0x4e, 0xa7,
    0x2b, 0x88, 0xa5, 0x0d, 0x17, 0x8b, 0xfe, 0x62,
    0xd4, 0x1b, 0x2d, 0xd7, 0xf5, 0x0a, 0xd0, 0x9b,
];

/// Super-admin emergency vault recovery for stuck/orphaned tables.
/// Transfers a specified amount from the vault to a destination wallet.
/// Used when seat data is lost (ER dropped delegation) and normal cashout is impossible.
/// SUPER_ADMIN only — not permissionless.

#[derive(Accounts)]
pub struct AdminRecoverVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Only used for vault seed derivation
    pub table: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, TableVault>,

    /// CHECK: Destination wallet for recovered funds
    #[account(mut)]
    pub destination: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AdminRecoverVault>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.authority.key().to_bytes() == SUPER_ADMIN,
        anchor_lang::error::ErrorCode::ConstraintOwner
    );

    let vault = &mut ctx.accounts.vault;

    // Verify vault has enough SOL
    let rent = Rent::get()?;
    let vault_rent = rent.minimum_balance(TableVault::SIZE);
    let vault_lamports = vault.to_account_info().lamports();
    require!(
        vault_lamports >= amount.checked_add(vault_rent).unwrap_or(u64::MAX),
        PokerError::VaultInsufficient
    );

    // Transfer from vault to destination
    **vault.to_account_info().try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.destination.try_borrow_mut_lamports()? += amount;

    vault.total_withdrawn = vault.total_withdrawn
        .checked_add(amount)
        .ok_or(PokerError::Overflow)?;

    msg!(
        "Admin vault recovery: {} lamports from vault {} to {}",
        amount,
        vault.key(),
        ctx.accounts.destination.key()
    );

    Ok(())
}
