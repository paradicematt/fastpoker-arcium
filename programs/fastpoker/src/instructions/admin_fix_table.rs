use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use crate::state::Table;

/// Admin: patch corrupted bool fields in table accounts so they can be deserialized.
/// Uses UncheckedAccount to bypass Borsh. Fixes known corrupted offsets to valid values.
/// Super-admin (program deployer) can fix ANY table.

// GkfdM1vqRYrU2LJ4ipwCJ3vsr2PGYLpdtdKK121ZkQZg
const SUPER_ADMIN: [u8; 32] = [
    0xea, 0x0e, 0xf4, 0x37, 0x22, 0x4d, 0x04, 0xe8,
    0x81, 0xdd, 0x10, 0xfd, 0x84, 0xb2, 0x4e, 0xa7,
    0x2b, 0x88, 0xa5, 0x0d, 0x17, 0x8b, 0xfe, 0x62,
    0xd4, 0x1b, 0x2d, 0xd7, 0xf5, 0x0a, 0xd0, 0x9b,
];

#[derive(Accounts)]
pub struct AdminFixTable<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Manual validation below — intentionally skip Anchor deserialization
    #[account(mut)]
    pub table: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<AdminFixTable>, reset_to_waiting: bool) -> Result<()> {
    let table_info = &ctx.accounts.table;
    let authority = &ctx.accounts.authority;

    {
        let data = table_info.try_borrow_data()?;

        // Must be owned by our program
        require!(
            table_info.owner == ctx.program_id,
            anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram
        );

        require!(data.len() >= 342, anchor_lang::error::ErrorCode::AccountDidNotDeserialize);

        // Check discriminator
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
    }

    // Now fix corrupted fields
    let mut fixed = 0u8;

    {
        let mut data = table_info.try_borrow_mut_data()?;

        // Fix corrupted bool fields
        // Bool offsets: is_delegated=174, dead_button=256, flop_reached=257,
        //              is_user_created=322, prizes_distributed=339
        let bool_offsets: [usize; 5] = [174, 256, 257, 322, 339];
        for &off in &bool_offsets {
            if off < data.len() {
                let v = data[off];
                if v != 0 && v != 1 {
                    msg!("Fixing bool at offset {} from {} to 0", off, v);
                    data[off] = 0;
                    fixed += 1;
                }
            }
        }

        // Fix bump at offset 341 — compute correct PDA bump from table_id
        let table_id: [u8; 32] = data[8..40].try_into().unwrap();
        let (expected_pda, correct_bump) = Pubkey::find_program_address(
            &[b"table", &table_id],
            ctx.program_id,
        );
        if expected_pda == table_info.key() {
            let stored_bump = data[341];
            if stored_bump != correct_bump {
                msg!("Fixing bump at offset 341 from {} to {}", stored_bump, correct_bump);
                data[341] = correct_bump;
                fixed += 1;
            }
        } else {
            msg!("WARNING: PDA mismatch, expected {} got {}", expected_pda, table_info.key());
        }
    }

    // Optional: full reset to Waiting state (super-admin only)
    if reset_to_waiting {
        let is_super = authority.key().to_bytes() == SUPER_ADMIN;
        require!(is_super, anchor_lang::error::ErrorCode::ConstraintOwner);
        let clock = Clock::get()?;
        let mut data = table_info.try_borrow_mut_data()?;
        // phase (offset 160) = 0 (Waiting)
        data[160] = 0;
        // current_players (offset 122) = 0
        data[122] = 0;
        // seats_occupied (offset 250, u16 LE) = 0
        data[250..252].copy_from_slice(&0u16.to_le_bytes());
        // last_action_slot (offset 162, u64 LE) = current slot
        data[162..170].copy_from_slice(&clock.slot.to_le_bytes());
        // pot (offset 131, u64 LE) = 0
        data[131..139].copy_from_slice(&0u64.to_le_bytes());
        // seats_folded (offset 252, u16 LE) = 0
        data[252..254].copy_from_slice(&0u16.to_le_bytes());
        // seats_allin (offset 254, u16 LE) = 0
        data[254..256].copy_from_slice(&0u16.to_le_bytes());
        msg!("Reset table to Waiting state");
        fixed += 1;
    }

    msg!("admin_fix_table: {} (fixed {} fields)", table_info.key(), fixed);
    Ok(())
}
