use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;
use crate::hand_eval::CARD_NOT_DEALT;

/// Declare a misdeal — refund pot to contributors and reset table.
/// 
/// Last-resort safety valve when a hand is unrecoverably stuck.
/// Callers should RETRY the failing instruction first. Only call misdeal
/// after retries are exhausted (e.g., settle_hand keeps failing).
///
/// Admin-only emergency path (super-admin signer).
///
/// Does NOT count as a completed hand — no eliminations, no hand_number increment.

#[derive(Accounts)]
pub struct Misdeal<'info> {
    /// Super-admin only emergency caller
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        // Must be in an active hand (not Waiting or Complete)
        constraint = table.phase != GamePhase::Waiting @ PokerError::InvalidActionForPhase,
        constraint = table.phase != GamePhase::Complete @ PokerError::InvalidActionForPhase,
    )]
    pub table: Account<'info, Table>,

    /// DeckState PDA — reset on misdeal
    #[account(
        mut,
        seeds = [DECK_STATE_SEED, table.key().as_ref()],
        bump = deck_state.bump,
        constraint = deck_state.table == table.key() @ PokerError::InvalidAccountData,
    )]
    pub deck_state: Box<Account<'info, DeckState>>,
    // Remaining accounts: [seat0, seat1, ..., seatN]
    // Only seats needed — refund chips from total_bet_this_hand
}

pub fn misdeal_handler(ctx: Context<Misdeal>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let caller = &ctx.accounts.caller;
    let clock = Clock::get()?;
    let num_seats = table.max_players as usize;

    // Authorization: super-admin only (temporary lockdown).
    require!(
        caller.key().to_bytes() == SUPER_ADMIN,
        PokerError::InvalidAuthority
    );
    msg!("Misdeal authorized: caller is super-admin");

    // Validate we have enough seat accounts
    require!(
        ctx.remaining_accounts.len() >= num_seats,
        PokerError::InvalidAccountData
    );

    let seats = &ctx.remaining_accounts[..num_seats];

    // Seat data offsets
    const CHIPS_OFFSET: usize = 8 + 32 + 32 + 32;  // 104
    const BET_OFFSET: usize = CHIPS_OFFSET + 8;      // 112 (bet_this_round)
    const TOTAL_BET_OFFSET: usize = BET_OFFSET + 8;  // 120 (total_bet_this_hand)
    const HOLE_OFFSET: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32; // 224
    const STATUS_OFFSET: usize = HOLE_OFFSET + 2 + 1; // 227
    const SEAT_NUM_OFFSET: usize = HOLE_OFFSET + 2; // 226
    const CO_CHIPS: usize = 246;
    const CO_NONCE: usize = 254;
    const V_RESERVE: usize = 262;

    // === Refund: give each player back their total_bet_this_hand ===
    let mut total_refunded: u64 = 0;

    for (i, seat_info) in seats.iter().enumerate() {
        let mut seat_data = seat_info.try_borrow_mut_data()?;
        if seat_data.len() < STATUS_OFFSET + 1 {
            continue;
        }

        let status = seat_data[STATUS_OFFSET];
        // Skip only truly empty (0) and busted (5)
        if status == 0 || status == 5 {
            continue;
        }

        // Read total_bet_this_hand
        let total_bet = if TOTAL_BET_OFFSET + 8 <= seat_data.len() {
            u64::from_le_bytes(seat_data[TOTAL_BET_OFFSET..TOTAL_BET_OFFSET + 8].try_into().unwrap_or([0; 8]))
        } else {
            0
        };

        if total_bet > 0 {
            // Refund: add total_bet back to chips
            let current_chips = u64::from_le_bytes(
                seat_data[CHIPS_OFFSET..CHIPS_OFFSET + 8].try_into().unwrap_or([0; 8])
            );
            let new_chips = current_chips.saturating_add(total_bet);
            seat_data[CHIPS_OFFSET..CHIPS_OFFSET + 8].copy_from_slice(&new_chips.to_le_bytes());
            total_refunded += total_bet;
            msg!("Seat {} refunded {} chips ({} -> {})", i, total_bet, current_chips, new_chips);
        }

        // FIX: Snapshot cashout for Leaving players BEFORE resetting to Waiting.
        // Without this, Leaving players after misdeal have cashout_chips=0 and
        // cashout_nonce=0, so process_cashout_v2 fails (nonce check) and
        // clear_leaving_seat can zero the seat — losing the player's chips.
        if status == 6 && seat_data.len() >= V_RESERVE + 8 {
            let chips_after_refund = u64::from_le_bytes(
                seat_data[CHIPS_OFFSET..CHIPS_OFFSET + 8].try_into().unwrap_or([0; 8])
            );
            let vr = u64::from_le_bytes(
                seat_data[V_RESERVE..V_RESERVE + 8].try_into().unwrap_or([0; 8])
            );
            let total_owed = chips_after_refund.saturating_add(vr);
            seat_data[CO_CHIPS..CO_CHIPS + 8].copy_from_slice(&total_owed.to_le_bytes());
            let n = u64::from_le_bytes(
                seat_data[CO_NONCE..CO_NONCE + 8].try_into().unwrap_or([0; 8])
            );
            seat_data[CO_NONCE..CO_NONCE + 8].copy_from_slice(&n.wrapping_add(1).to_le_bytes());
            seat_data[CHIPS_OFFSET..CHIPS_OFFSET + 8].copy_from_slice(&0u64.to_le_bytes());
            seat_data[V_RESERVE..V_RESERVE + 8].copy_from_slice(&0u64.to_le_bytes());
            // Remove from occupied masks
            if seat_data.len() > SEAT_NUM_OFFSET {
                let sn = seat_data[SEAT_NUM_OFFSET];
                table.seats_occupied &= !(1u16 << (sn as u16));
                table.current_players = table.current_players.saturating_sub(1);
            }
            msg!("Seat {} (Leaving) cashout snapshot: {} chips, nonce={}", i, total_owed, n.wrapping_add(1));
        }

        // Reset bet_this_round
        if BET_OFFSET + 8 <= seat_data.len() {
            seat_data[BET_OFFSET..BET_OFFSET + 8].copy_from_slice(&0u64.to_le_bytes());
        }
        // Reset total_bet_this_hand
        if TOTAL_BET_OFFSET + 8 <= seat_data.len() {
            seat_data[TOTAL_BET_OFFSET..TOTAL_BET_OFFSET + 8].copy_from_slice(&0u64.to_le_bytes());
        }
        // Reset hole cards
        if HOLE_OFFSET + 2 <= seat_data.len() {
            seat_data[HOLE_OFFSET..HOLE_OFFSET + 2].copy_from_slice(&[CARD_NOT_DEALT, CARD_NOT_DEALT]);
        }
        // Reset status to Active (if was folded or all-in)
        if status == 1 || status == 2 || status == 3 {
            seat_data[STATUS_OFFSET] = 1; // Active
        }
    }

    msg!("Misdeal declared — refunded {} chips total (pot was {})", total_refunded, table.pot);

    // === Reset table state ===
    table.pot = 0;
    table.min_bet = 0;
    table.community_cards = [CARD_NOT_DEALT; 5];
    table.revealed_hands = [255; 18];
    table.hand_results = [0; 9];
    table.pre_community = [255; 5];
    table.deck_seed = [0; 32];
    table.deck_index = 0;
    // Reset DeckState for next hand
    let deck_state = &mut ctx.accounts.deck_state;
    deck_state.reset_for_new_hand();
    table.flop_reached = false;
    table.seats_folded = 0;
    table.seats_allin = 0;
    table.phase = GamePhase::Waiting;
    table.last_action_slot = clock.slot;
    // Do NOT rotate button — hand was cancelled, not completed
    // Do NOT increment hand_number — this hand didn't count

    Ok(())
}
