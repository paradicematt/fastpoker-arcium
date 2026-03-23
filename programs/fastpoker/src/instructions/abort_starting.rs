use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// OPEN-4: Abort a Starting phase hand when < 2 active players remain.
/// Called by crank after handle_blind_timeout leaves insufficient players.
///
/// Refunds all posted blinds, resets table to Waiting, no hand number increment.

#[derive(Accounts)]
pub struct AbortStarting<'info> {
    /// CHECK: Permissionless — anyone can call (crank)
    pub initiator: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.phase == GamePhase::Starting @ PokerError::InvalidActionForPhase,
        constraint = table.game_type == GameType::CashGame @ PokerError::InvalidGameType,
    )]
    pub table: Account<'info, Table>,
    // Seat accounts passed as remaining_accounts
}

pub fn abort_starting_handler(ctx: Context<AbortStarting>) -> Result<()> {
    let table = &mut ctx.accounts.table;

    // Verify < 2 active (or blind_deadline cleared by handle_blind_timeout)
    let mut active_count = 0u8;
    for s in 0..table.max_players {
        let bit = 1u16 << s;
        if (table.seats_occupied & bit) != 0
            && (table.seats_folded & bit) == 0
        {
            active_count += 1;
        }
    }
    require!(active_count < 2, PokerError::InvalidActionForPhase);

    // Refund posted blinds via remaining_accounts
    let chips_offset: usize = 104;
    let bet_offset: usize = 112;
    let total_bet_offset: usize = 120;
    let seat_num_offset: usize = 96;
    let status_offset: usize = 227;

    for seat_info in ctx.remaining_accounts.iter() {
        if let Ok(mut data) = seat_info.try_borrow_mut_data() {
            if data.len() > total_bet_offset + 8 {
                let total_bet = u64::from_le_bytes(
                    data[total_bet_offset..total_bet_offset + 8].try_into().unwrap_or([0; 8])
                );
                if total_bet > 0 {
                    // Refund chips
                    let chips = u64::from_le_bytes(
                        data[chips_offset..chips_offset + 8].try_into().unwrap_or([0; 8])
                    );
                    let new_chips = chips + total_bet;
                    data[chips_offset..chips_offset + 8].copy_from_slice(&new_chips.to_le_bytes());

                    // Clear bets
                    data[bet_offset..bet_offset + 8].copy_from_slice(&0u64.to_le_bytes());
                    data[total_bet_offset..total_bet_offset + 8].copy_from_slice(&0u64.to_le_bytes());

                    let sn = data[seat_num_offset];

                    // Restore AllIn players to Active if they were forced all-in by blind
                    if status_offset < data.len() && data[status_offset] == 3 {
                        data[status_offset] = 1; // Active
                        table.seats_allin &= !(1u16 << sn);
                    }

                    msg!("abort_starting: refunded {} to seat {} (chips: {} -> {})", total_bet, sn, chips, new_chips);
                }
            }
        }
    }

    // Reset table state
    table.pot = 0;
    table.min_bet = 0;
    table.blinds_posted = 0;
    table.blind_deadline = 0;
    table.seats_folded = 0;
    table.seats_allin = 0;
    table.phase = GamePhase::Waiting;
    // Do NOT increment hand_number — hand never started

    msg!("abort_starting: hand aborted, table reset to Waiting");

    Ok(())
}
