use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// OPEN-4: Crank calls this when blind_deadline expires and a player hasn't posted.
/// Auto-deducts blind as dead money, sits player out.

#[derive(Accounts)]
pub struct HandleBlindTimeout<'info> {
    /// CHECK: Permissionless — anyone can call (crank)
    pub initiator: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.phase == GamePhase::Starting @ PokerError::InvalidActionForPhase,
        constraint = table.game_type == GameType::CashGame @ PokerError::InvalidGameType,
        constraint = table.blind_deadline > 0 @ PokerError::InvalidActionForPhase,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat.seat_number]],
        bump = seat.bump,
    )]
    pub seat: Account<'info, PlayerSeat>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn handle_blind_timeout_handler(ctx: Context<HandleBlindTimeout>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;
    let clock = &ctx.accounts.clock;

    // Validate deadline has expired
    require!(
        clock.unix_timestamp >= table.blind_deadline,
        PokerError::InvalidActionForPhase
    );

    let seat_num = seat.seat_number;
    let seat_bit = 1u16 << seat_num;

    // Must not have already posted
    require!(
        (table.blinds_posted & seat_bit) == 0,
        PokerError::InvalidActionForPhase
    );

    let is_sb = seat_num == table.small_blind_seat;
    let is_bb = seat_num == table.big_blind_seat;
    require!(is_sb || is_bb, PokerError::InvalidActionForPhase);

    if is_sb {
        // SB timeout: auto-deduct as dead money
        let blind_amount = table.small_blind;
        let actual = seat.chips.min(blind_amount);
        seat.chips = seat.chips.saturating_sub(actual);
        seat.total_bet_this_hand = actual;
        table.pot += actual;
        msg!("Blind timeout: SB seat {} auto-deducted {} (dead blind)", seat_num, actual);
    }

    // Sit player out
    seat.status = SeatStatus::SittingOut;
    seat.sit_out_timestamp = clock.unix_timestamp;
    seat.missed_bb = true;

    // Mark as folded for this hand
    table.seats_folded |= seat_bit;

    // Mark as "posted" so we don't process again
    table.blinds_posted |= seat_bit;

    msg!(
        "handle_blind_timeout: seat {} sat out (was {}), missed_bb=true",
        seat_num,
        if is_sb { "SB" } else { "BB" }
    );

    // Count remaining active players
    let mut active_count = 0u8;
    for s in 0..table.max_players {
        let bit = 1u16 << s;
        if (table.seats_occupied & bit) != 0
            && (table.seats_folded & bit) == 0
        {
            active_count += 1;
        }
    }

    // If < 2 active remain, clear deadline to signal abort_starting needed
    if active_count < 2 {
        table.blind_deadline = 0;
        msg!("< 2 active players after timeout — abort_starting needed");
    }

    Ok(())
}
