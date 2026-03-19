use anchor_lang::prelude::*;
use crate::state::TableVault;
use crate::constants::VAULT_SEED;

// GkfdM1vqRYrU2LJ4ipwCJ3vsr2PGYLpdtdKK121ZkQZg
const SUPER_ADMIN: [u8; 32] = [
    0xea, 0x0e, 0xf4, 0x37, 0x22, 0x4d, 0x04, 0xe8,
    0x81, 0xdd, 0x10, 0xfd, 0x84, 0xb2, 0x4e, 0xa7,
    0x2b, 0x88, 0xa5, 0x0d, 0x17, 0x8b, 0xfe, 0x62,
    0xd4, 0x1b, 0x2d, 0xd7, 0xf5, 0x0a, 0xd0, 0x9b,
];

/// Admin-only: reset vault counters for testing.
/// Resets total_withdrawn, total_rake_distributed, and rake_nonce to 0.
/// Does NOT touch total_deposited or vault balance.

#[derive(Accounts)]
pub struct AdminResetVault<'info> {
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
}

pub fn handler(ctx: Context<AdminResetVault>) -> Result<()> {
    require!(
        ctx.accounts.authority.key().to_bytes() == SUPER_ADMIN,
        anchor_lang::error::ErrorCode::ConstraintOwner
    );

    let vault = &mut ctx.accounts.vault;
    
    msg!("Admin reset vault: nonce {} -> 0, rake_distributed {} -> 0, withdrawn {} -> 0",
        vault.rake_nonce, vault.total_rake_distributed, vault.total_withdrawn);
    
    vault.rake_nonce = 0;
    vault.total_rake_distributed = 0;
    vault.total_withdrawn = 0;
    
    Ok(())
}
