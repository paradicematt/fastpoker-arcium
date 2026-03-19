use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;
use crate::hand_eval::CARD_NOT_DEALT;

/// Step 2 of the two-step join for delegated cash game tables.
/// Runs on ER where the table is writable.
///
/// PERMISSIONLESS: Any funded ER account can relay this instruction.
/// Security comes from the DepositProof PDA (created by deposit_for_join on L1,
/// then delegated to ER). buy_in/reserve/player_wallet are read from the proof,
/// NOT from instruction args — the caller cannot lie about amounts.
///
/// After seating, the proof is consumed.
/// Undelegation of the proof is handled separately by cleanup_deposit_proof (crank).

#[derive(Accounts)]
#[instruction(seat_index: u8)]
pub struct SeatPlayer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.current_players < table.max_players @ PokerError::TableFull,
        constraint = table.game_type == GameType::CashGame @ PokerError::InvalidActionForPhase,
    )]
    pub table: Account<'info, Table>,

    /// Seat PDA — pre-created via init_table_seat, must already exist
    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat_index]],
        bump = seat.bump,
    )]
    pub seat: Account<'info, PlayerSeat>,

    /// DepositProof PDA — created on L1 by deposit_for_join, delegated to ER.
    /// Contains the L1-verified deposit amounts. Must not be consumed.
    #[account(
        mut,
        seeds = [DEPOSIT_PROOF_SEED, table.key().as_ref(), &[seat_index]],
        bump = deposit_proof.bump,
        constraint = !deposit_proof.consumed @ PokerError::InvalidAccountData,
        constraint = deposit_proof.table == table.key() @ PokerError::InvalidAccountData,
        constraint = deposit_proof.seat_index == seat_index @ PokerError::InvalidAccountData,
    )]
    pub deposit_proof: Account<'info, DepositProof>,

}

pub fn handler(
    ctx: Context<SeatPlayer>,
    seat_index: u8,
) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;
    let proof = &mut ctx.accounts.deposit_proof;
    let clock = Clock::get()?;

    // Read deposit amounts from proof — NOT from instruction args
    let buy_in = proof.buy_in;
    let reserve = proof.reserve;
    let player_wallet = proof.depositor;

    // Validate seat index
    require!(seat_index < table.max_players, PokerError::TableFull);

    // Validate seat is available (empty or fully cleared by clear_leaving_seat)
    require!(
        seat.wallet == Pubkey::default()
            || seat.status == SeatStatus::Empty,
        PokerError::SeatOccupied
    );

    // Validate buy-in range
    let (min_bb, max_bb): (u64, u64) = if table.buy_in_type == 1 { (50, 250) } else { (20, 100) };
    let min_buy_in = table.big_blind * min_bb;
    let max_buy_in = table.big_blind * max_bb;
    require!(
        buy_in >= min_buy_in && buy_in <= max_buy_in,
        PokerError::InvalidBuyIn
    );

    // Mark proof as consumed BEFORE seating to prevent replay
    proof.consumed = true;

    // Initialize seat
    seat.wallet = player_wallet;
    seat.session_key = Pubkey::default();
    seat.table = table.key();
    seat.chips = buy_in;
    seat.bet_this_round = 0;
    seat.total_bet_this_hand = 0;
    seat.hole_cards_encrypted = [0; 64];
    seat.hole_cards_commitment = [0; 32];
    seat.hole_cards = [CARD_NOT_DEALT, CARD_NOT_DEALT];
    seat.seat_number = seat_index;
    seat.last_action_slot = clock.slot;
    seat.missed_sb = false;
    seat.missed_bb = false;
    seat.posted_blind = false;
    // bump already set by init_table_seat — keep existing value
    let is_mid_hand_join = table.phase != GamePhase::Waiting && table.phase != GamePhase::Complete;
    if is_mid_hand_join {
        // Mid-hand join: seat now, but defer participation until next hand.
        // Also mark folded in current-hand bitmask so turn traversal never lands here.
        seat.waiting_for_bb = true;
        seat.status = SeatStatus::SittingOut;
        table.seats_folded |= 1u16 << seat_index;
    } else {
        seat.waiting_for_bb = false;
        seat.status = SeatStatus::Active;
    }
    seat.vault_reserve = reserve;
    seat.cashout_chips = 0;
    // DO NOT zero cashout_nonce — monotonically increasing per seat PDA.
    // New occupant inherits nonce; their first leave increments past receipt.last_processed_nonce.
    seat.sit_out_timestamp = 0;
    seat.time_bank_seconds = TIME_BANK_MAX_SECONDS;
    seat.time_bank_active = false;

    // Update table
    table.current_players += 1;
    table.occupy_seat(seat_index);

    if is_mid_hand_join {
        msg!(
            "Seated player {} at seat {} with {} chips (reserve={}) as SittingOut+waiting_for_bb [proof-validated]",
            player_wallet,
            seat_index,
            buy_in,
            reserve
        );
    } else {
        msg!(
            "Seated player {} at seat {} with {} chips (reserve={}) [proof-validated]",
            player_wallet,
            seat_index,
            buy_in,
            reserve
        );
    }


    Ok(())
}
