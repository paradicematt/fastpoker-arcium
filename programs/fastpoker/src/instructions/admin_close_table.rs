use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use crate::state::Table;

/// Admin force-close a table regardless of player count or unclaimed balances.
/// Uses UncheckedAccount to bypass Borsh deserialization — handles corrupted/old accounts.
/// Super-admin (program deployer) can close ANY table. Table authority can close their own.

// Program deployer / super-admin key
// GkfdM1vqRYrU2LJ4ipwCJ3vsr2PGYLpdtdKK121ZkQZg
const SUPER_ADMIN: [u8; 32] = [
    0xea, 0x0e, 0xf4, 0x37, 0x22, 0x4d, 0x04, 0xe8,
    0x81, 0xdd, 0x10, 0xfd, 0x84, 0xb2, 0x4e, 0xa7,
    0x2b, 0x88, 0xa5, 0x0d, 0x17, 0x8b, 0xfe, 0x62,
    0xd4, 0x1b, 0x2d, 0xd7, 0xf5, 0x0a, 0xd0, 0x9b,
];
#[derive(Accounts)]
pub struct AdminCloseTable<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Manual validation below — we intentionally skip Anchor deserialization
    #[account(mut)]
    pub table: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AdminCloseTable>) -> Result<()> {
    let table_info = &ctx.accounts.table;
    let authority = &ctx.accounts.authority;
    let data = table_info.try_borrow_data()?;

    // Must be owned by our program
    require!(
        table_info.owner == ctx.program_id,
        anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram
    );

    // Must have enough data for discriminator + authority check
    require!(data.len() >= 175, anchor_lang::error::ErrorCode::AccountDidNotDeserialize);

    // Check Table discriminator (first 8 bytes)
    // Pre-computed: SHA256("account:Table")[..8]
    let expected_disc = Table::DISCRIMINATOR;
    require!(
        data[..8] == expected_disc[..],
        anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch
    );

    // Check authority: must be table authority OR super-admin
    let stored_authority = Pubkey::try_from(&data[40..72])
        .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize)?;
    let is_table_authority = stored_authority == authority.key();
    let is_super_admin = authority.key().to_bytes() == SUPER_ADMIN;
    require!(
        is_table_authority || is_super_admin,
        anchor_lang::error::ErrorCode::ConstraintOwner
    );

    // Note: we skip the is_delegated check — if the account is owned by our program
    // (not the Delegation Program), delegation is broken/stale and it's safe to close.

    let current_players = data[122];

    // Drop borrow before modifying
    drop(data);

    msg!("Admin force-closed table: {} (had {} players)", table_info.key(), current_players);

    // Transfer all lamports to authority (same as Anchor close = authority)
    let table_lamports = table_info.lamports();
    **table_info.try_borrow_mut_lamports()? = 0;
    **authority.try_borrow_mut_lamports()? = authority
        .lamports()
        .checked_add(table_lamports)
        .unwrap();

    // Zero out data and assign to system program
    let mut data = table_info.try_borrow_mut_data()?;
    for byte in data.iter_mut() {
        *byte = 0;
    }
    // Anchor's close sets owner to system program via sol_memset + assign
    table_info.assign(&anchor_lang::system_program::ID);

    Ok(())
}
