use anchor_lang::prelude::*;
use crate::state::*;
use crate::constants::VAULT_SEED;

/// Initialize a TableVault PDA for a table.
/// Called once per table — idempotent via init_if_needed.
/// Required for distribute_prizes (SNG fee routing) and distribute_crank_rewards.
///
/// Seeds: ["vault", table]
#[derive(Accounts)]
pub struct InitTableVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: We only need the table key for PDA derivation.
    /// Validated implicitly by vault seeds constraint.
    pub table: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = TableVault::SIZE,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TableVault>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitTableVault>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    // Only initialize if freshly created (table == default means uninitialized)
    if vault.table == Pubkey::default() {
        vault.table = ctx.accounts.table.key();
        vault.total_deposited = 0;
        vault.total_withdrawn = 0;
        vault.bump = ctx.bumps.vault;
        vault.rake_nonce = 0;
        vault.total_rake_distributed = 0;
        vault.token_mint = Pubkey::default(); // SOL
        vault.total_crank_distributed = 0;

        msg!("TableVault initialized for table {}", vault.table);
    } else {
        msg!("TableVault already initialized for table {}", vault.table);
    }

    Ok(())
}
