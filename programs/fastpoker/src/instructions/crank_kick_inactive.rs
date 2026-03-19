use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::events::{PlayerKicked, KickReason};
use crate::constants::*;

/// TEE-compatible permissionless kick for inactive cash game players.
///
/// Unlike `crank_remove_player` (which creates an UnclaimedBalance PDA and
/// therefore can't run on TEE), this instruction only modifies the table and
/// seat accounts — both of which are already delegated to the Ephemeral Rollup.
///
/// Flow:
///   1. Crank calls `crank_kick_inactive` on TEE (ER)
///   2. Seat is marked Leaving with cashout_chips snapshotted (same as leave_cash_game)
///   3. Crank's existing Waiting-phase handler detects Leaving seats
///   4. Crank calls CommitState → process_cashout_v2 on L1 → vault pays player wallet
///
/// Requirements:
///   - Table must be CashGame in Waiting or Complete phase
///   - Seat must be SittingOut
///   - One of: sit_out > 5min, button_count >= 3 (legacy), bust 3+ hands

const SIT_OUT_TIMEOUT_SECS: i64 = 5 * 60;
const LEGACY_ORBIT_REMOVAL_THRESHOLD: u8 = 3;
const BUST_REMOVAL_THRESHOLD: u8 = 3;

#[derive(Accounts)]
pub struct CrankKickInactive<'info> {
    /// Anyone can crank — NOT mut because non-delegated accounts
    /// cannot be writable on TEE (causes 127.0.0.1:8899 error).
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.game_type == GameType::CashGame @ PokerError::InvalidTableConfig,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat.seat_number]],
        bump = seat.bump,
    )]
    pub seat: Account<'info, PlayerSeat>,
}

pub fn handler(ctx: Context<CrankKickInactive>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;
    let clock = Clock::get()?;

    // Phase gate: only between hands
    require!(
        table.phase == GamePhase::Waiting || table.phase == GamePhase::Complete,
        PokerError::InvalidActionForPhase
    );

    // Must be sitting out
    require!(
        seat.status == SeatStatus::SittingOut,
        PokerError::PlayerNotSittingOut
    );

    // Check removal conditions (same as crank_remove_player)
    let sit_out_elapsed = if seat.sit_out_timestamp > 0 {
        clock.unix_timestamp.saturating_sub(seat.sit_out_timestamp)
    } else {
        0
    };
    let time_expired = sit_out_elapsed >= SIT_OUT_TIMEOUT_SECS;
    let legacy_orbit_expired =
        seat.sit_out_timestamp <= 0 && seat.sit_out_button_count >= LEGACY_ORBIT_REMOVAL_THRESHOLD;
    let bust_expired = seat.chips == 0 && seat.hands_since_bust >= BUST_REMOVAL_THRESHOLD;

    require!(
        time_expired || legacy_orbit_expired || bust_expired,
        PokerError::PlayerNotRemovable
    );

    let reason = if time_expired {
        KickReason::SitOutTimeout
    } else if bust_expired {
        KickReason::BustTimeout
    } else {
        KickReason::LegacyOrbit
    };

    let player_wallet = seat.wallet;
    let seat_number = seat.seat_number;

    // Snapshot cashout (same logic as process_leave_cash_game)
    let total_owed = seat.chips.checked_add(seat.vault_reserve).unwrap_or(seat.chips);

    // Mark as Leaving — the existing cashout flow handles L1 payout
    seat.status = SeatStatus::Leaving;
    seat.cashout_chips = total_owed;
    seat.cashout_nonce = seat.cashout_nonce.wrapping_add(1);
    seat.chips = 0;
    seat.vault_reserve = 0;
    seat.last_action_slot = clock.slot;

    // Remove from active bitmasks
    let mask = 1u16 << seat_number;
    table.seats_occupied &= !mask;
    table.seats_folded &= !mask;
    table.seats_allin &= !mask;
    table.current_players = table.current_players.saturating_sub(1);

    emit!(PlayerKicked {
        table: table.key(),
        player: player_wallet,
        seat_number,
        chips_owed: total_owed,
        reason,
    });

    msg!(
        "Kicked inactive player {} from seat {} (owed {} chips, reason={:?})",
        player_wallet,
        seat_number,
        total_owed,
        reason,
    );

    Ok(())
}
