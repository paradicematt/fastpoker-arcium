use anchor_lang::prelude::*;

/// Admin-only: close any program-owned accounts passed as remaining_accounts.
/// Transfers lamports to authority, zeros data, assigns to system program.
/// No discriminator check — works for seats, markers, seat_cards, etc.

// Program deployer / super-admin key
const SUPER_ADMIN: [u8; 32] = [
    0xea, 0x0e, 0xf4, 0x37, 0x22, 0x4d, 0x04, 0xe8,
    0x81, 0xdd, 0x10, 0xfd, 0x84, 0xb2, 0x4e, 0xa7,
    0x2b, 0x88, 0xa5, 0x0d, 0x17, 0x8b, 0xfe, 0x62,
    0xd4, 0x1b, 0x2d, 0xd7, 0xf5, 0x0a, 0xd0, 0x9b,
];

#[derive(Accounts)]
pub struct AdminCloseAccounts<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, AdminCloseAccounts<'info>>,
) -> Result<()> {
    require!(
        ctx.accounts.authority.key().to_bytes() == SUPER_ADMIN,
        anchor_lang::error::ErrorCode::ConstraintOwner
    );

    let program_id = ctx.program_id;
    let mut closed = 0u32;
    let mut total_recovered = 0u64;

    for (i, account_info) in ctx.remaining_accounts.iter().enumerate() {
        // Only close accounts owned by our program
        if account_info.owner != program_id {
            msg!("Skip {}: not owned by program (owner={})", i, account_info.owner);
            continue;
        }

        let lamports = account_info.lamports();
        if lamports == 0 {
            msg!("Skip {}: zero lamports", i);
            continue;
        }

        // Transfer lamports to authority
        **account_info.try_borrow_mut_lamports()? = 0;
        **ctx.accounts.authority.try_borrow_mut_lamports()? = ctx
            .accounts
            .authority
            .lamports()
            .checked_add(lamports)
            .unwrap();

        // Zero out data
        let mut data = account_info.try_borrow_mut_data()?;
        for byte in data.iter_mut() {
            *byte = 0;
        }
        drop(data);

        // Assign to system program
        account_info.assign(&anchor_lang::system_program::ID);

        closed += 1;
        total_recovered += lamports;
        msg!("Closed {} (+{} lam)", account_info.key(), lamports);
    }

    msg!("Admin close complete: {} accounts, {} lamports recovered", closed, total_recovered);
    Ok(())
}
