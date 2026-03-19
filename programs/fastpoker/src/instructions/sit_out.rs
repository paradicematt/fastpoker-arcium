use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::events::PlayerSatOut;
use crate::constants::*;

/// Sit out - player remains at table but skips hands
/// Tracks missed blinds for when they return
#[derive(Accounts)]
pub struct SitOut<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat.seat_number]],
        bump = seat.bump,
        constraint = seat.wallet == player.key() @ PokerError::Unauthorized,
    )]
    pub seat: Account<'info, PlayerSeat>,
}

pub fn sit_out_handler(ctx: Context<SitOut>) -> Result<()> {
    let seat = &mut ctx.accounts.seat;
    let table = &ctx.accounts.table;

    // Can only sit out between hands
    require!(
        table.phase == GamePhase::Waiting || table.phase == GamePhase::Complete,
        PokerError::HandInProgress
    );

    // Already sitting out or leaving — never overwrite Leaving status.
    // A duplicate sit_out after leave_cash_game would destroy the cashout snapshot.
    if seat.status == SeatStatus::SittingOut || seat.status == SeatStatus::Leaving {
        return Ok(());
    }

    seat.status = SeatStatus::SittingOut;

    emit!(PlayerSatOut {
        table: table.key(),
        player: seat.wallet,
        seat_number: seat.seat_number,
    });

    msg!("Player {} is now sitting out", seat.wallet);
    Ok(())
}

/// Return from sitting out - may need to post missed blinds
#[derive(Accounts)]
pub struct SitIn<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat.seat_number]],
        bump = seat.bump,
        constraint = seat.wallet == player.key() @ PokerError::Unauthorized,
        constraint = seat.status == SeatStatus::SittingOut @ PokerError::InvalidActionForPhase,
    )]
    pub seat: Account<'info, PlayerSeat>,
}

pub fn sit_in_handler(ctx: Context<SitIn>, post_missed_blinds: bool) -> Result<()> {
    let seat = &mut ctx.accounts.seat;
    let table = &ctx.accounts.table;

    // Can only sit in between hands
    require!(
        table.phase == GamePhase::Waiting || table.phase == GamePhase::Complete,
        PokerError::HandInProgress
    );

    // Check if player owes missed blinds
    let owes_blinds = seat.missed_bb || seat.missed_sb;

    // Reset sit-out tracking counters
    seat.sit_out_button_count = 0;
    seat.hands_since_bust = 0;

    if owes_blinds && !post_missed_blinds {
        // Player must wait for BB position or post
        seat.waiting_for_bb = true;
        msg!("Player owes missed blinds - waiting for BB position");
    } else if owes_blinds && post_missed_blinds {
        // Calculate total owed
        let mut total_owed: u64 = 0;
        if seat.missed_bb {
            total_owed += table.big_blind;
        }
        if seat.missed_sb {
            total_owed += table.small_blind; // Dead small
        }

        require!(seat.chips >= total_owed, PokerError::InsufficientChips);

        // Deduct missed blinds from chips.
        // bet_this_round = live BB only (what counts as the player's bet).
        // total_bet_this_hand = full amount including dead SB (for pot tracking).
        // start_game will add total_bet_this_hand to pot and skip double-charging.
        seat.chips = seat.chips.saturating_sub(total_owed);
        let live_bet = if seat.missed_bb { table.big_blind.min(total_owed) } else { 0 };
        seat.bet_this_round = live_bet;
        seat.total_bet_this_hand = total_owed;
        seat.posted_blind = true;
        seat.missed_bb = false;
        seat.missed_sb = false;
        seat.waiting_for_bb = false;
        seat.status = SeatStatus::Active;

        msg!("Player posted {} in missed blinds", total_owed);
    } else {
        // No missed blinds owed
        seat.status = SeatStatus::Active;
        seat.waiting_for_bb = false;
    }

    msg!("Player {} is back in the game", seat.wallet);
    Ok(())
}

/// Track missed blinds when a sitting-out player should have posted
/// Called by deal instruction when setting up blinds
pub fn mark_missed_blind(seat: &mut PlayerSeat, is_sb: bool, is_bb: bool) {
    if seat.status == SeatStatus::SittingOut {
        if is_sb {
            seat.missed_sb = true;
        }
        if is_bb {
            seat.missed_bb = true;
        }
    }
}
