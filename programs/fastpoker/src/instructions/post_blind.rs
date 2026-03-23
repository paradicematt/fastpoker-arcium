use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// OPEN-4: Player posts their blind during Starting phase (cash games only).
/// Session key can auto-fire this; UI has a 15-second manual fallback.
///
/// Validates: phase is Starting, game is cash, seat is SB or BB, blind not already posted.
/// Deducts blind amount from seat chips, marks blind in table.blinds_posted bitmask.

#[derive(Accounts)]
pub struct PostBlind<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

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
        constraint = seat.wallet == player.key() || seat.session_key == player.key() @ PokerError::Unauthorized,
    )]
    pub seat: Account<'info, PlayerSeat>,
}

pub fn post_blind_handler(ctx: Context<PostBlind>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;

    let seat_num = seat.seat_number;

    // Must be SB or BB
    let is_sb = seat_num == table.small_blind_seat;
    let is_bb = seat_num == table.big_blind_seat;
    require!(is_sb || is_bb, PokerError::InvalidActionForPhase);

    // Must not have already posted
    let seat_bit = 1u16 << seat_num;
    require!(
        (table.blinds_posted & seat_bit) == 0,
        PokerError::InvalidActionForPhase
    );

    // Determine blind amount
    let blind_amount = if is_sb { table.small_blind } else { table.big_blind };
    let actual_blind = seat.chips.min(blind_amount);

    // Deduct chips
    seat.chips = seat.chips.saturating_sub(actual_blind);
    seat.bet_this_round = actual_blind;
    seat.total_bet_this_hand = actual_blind;

    // Add to pot
    table.pot += actual_blind;
    if actual_blind > table.min_bet {
        table.min_bet = actual_blind;
    }

    // Mark as posted
    table.blinds_posted |= seat_bit;
    seat.posted_blind = true;

    // All-in check
    if seat.chips == 0 && actual_blind > 0 {
        seat.status = SeatStatus::AllIn;
        table.seats_allin |= seat_bit;
    }

    msg!(
        "post_blind: seat {} posted {} as {} (chips left: {})",
        seat_num,
        actual_blind,
        if is_sb { "SB" } else { "BB" },
        seat.chips
    );

    Ok(())
}
