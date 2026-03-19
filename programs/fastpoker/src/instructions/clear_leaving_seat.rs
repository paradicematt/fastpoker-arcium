use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// Clear a Leaving seat on ER after L1 cashout has been processed.
/// Zeros all seat fields and sets status to Empty, freeing the seat for reuse.
///
/// PERMISSIONLESS — anyone can call this (crank, player, etc.).
/// TEE-SAFE — only references delegated accounts (table + seat).
/// Receipt nonce check and permission reset are handled off-chain by the crank
/// (receipt lives on L1 and is unreachable from TEE; Permission Program CPI
/// also crashes the TEE proxy). clear_leaving_seat transfers NO funds.
#[derive(Accounts)]
pub struct ClearLeavingSeat<'info> {
    /// Crank or anyone — fully permissionless
    pub payer: Signer<'info>,

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
        constraint = seat.table == table.key() @ PokerError::SeatNotAtTable,
    )]
    pub seat: Account<'info, PlayerSeat>,
}

pub fn handler(ctx: Context<ClearLeavingSeat>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;

    // Must be Leaving (6) or SittingOut (4) with processed cashout — or already Empty.
    // SittingOut with cashout can happen when sit_out.rs bug overwrites Leaving → SittingOut.
    if seat.status == SeatStatus::Empty {
        msg!("Seat {} already empty — no-op", seat.seat_number);
        return Ok(());
    }
    require!(
        seat.status == SeatStatus::Leaving || seat.status == SeatStatus::SittingOut,
        PokerError::SeatNotLeaving
    );

    // Receipt nonce check removed — receipt lives on L1 (never delegated) and is
    // unreachable from TEE proxy (crashes with 500). Crank verifies cashout off-chain
    // before calling this. This instruction transfers NO funds — safe to skip.

    let seat_num = seat.seat_number;

    // Zero all gameplay fields
    seat.wallet = Pubkey::default();
    seat.session_key = Pubkey::default();
    seat.chips = 0;
    seat.bet_this_round = 0;
    seat.total_bet_this_hand = 0;
    seat.hole_cards_encrypted = [0; 64];
    seat.hole_cards_commitment = [0; 32];
    seat.hole_cards = [255, 255];
    seat.status = SeatStatus::Empty;
    seat.last_action_slot = 0;
    seat.missed_sb = false;
    seat.missed_bb = false;
    seat.posted_blind = false;
    seat.waiting_for_bb = false;
    seat.sit_out_button_count = 0;
    seat.hands_since_bust = 0;
    seat.auto_fold_count = 0;
    seat.missed_bb_count = 0;
    seat.paid_entry = false;
    seat.cashout_chips = 0;
    // DO NOT zero cashout_nonce — it must be monotonically increasing per seat PDA.
    // Receipt tracks last_processed_nonce; new occupants inherit the nonce so their
    // first leave increments to nonce+1, passing the nonce > receipt check.
    seat.vault_reserve = 0;
    seat.sit_out_timestamp = 0;

    // Update table masks (safety — leave_cash_game or settle may have already done this)
    let mask = 1u16 << seat_num;
    if (table.seats_occupied & mask) != 0 {
        table.seats_occupied &= !mask;
        table.current_players = table.current_players.saturating_sub(1);
    }
    table.seats_folded &= !mask;
    table.seats_allin &= !mask;

    // Permission reset removed — Permission CPI crashes TEE proxy (500).
    // Next player's update_seat_cards_permission overwrites permissions on L1 before delegation.

    msg!("Seat {} cleared (was Leaving). Table now has {} players.", seat_num, table.current_players);
    Ok(())
}
