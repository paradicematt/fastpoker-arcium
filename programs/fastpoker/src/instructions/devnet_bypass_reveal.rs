use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// Mock community card reveal for testing without Arcium MPC.
/// Advances from *RevealPending phases to the next betting round.
///
/// In mock mode, devnet_bypass_deal already wrote all community cards
/// to table.community_cards and table.pre_community. This instruction
/// just advances the phase and sets the next player to act.
///
/// PERMISSIONLESS — anyone can call when phase is *RevealPending.

#[derive(Accounts)]
pub struct DevnetBypassReveal<'info> {
    /// CHECK: Permissionless
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
    )]
    pub table: Account<'info, Table>,
}

pub fn handler(ctx: Context<DevnetBypassReveal>) -> Result<()> {
    let table = &mut ctx.accounts.table;

    // Determine target phase based on current reveal-pending phase
    let (next_phase, cards_to_reveal) = match table.phase {
        GamePhase::FlopRevealPending => (GamePhase::Flop, 3),
        GamePhase::TurnRevealPending => (GamePhase::Turn, 4),
        GamePhase::RiverRevealPending => (GamePhase::River, 5),
        _ => return Err(PokerError::InvalidActionForPhase.into()),
    };

    // Verify community cards are already written (by devnet_bypass_deal)
    let cards_present = table.pre_community.iter().filter(|&&c| c != 255).count();
    require!(
        cards_present >= cards_to_reveal,
        PokerError::CommunityCardsNotDealt
    );

    // Copy from pre_community to community_cards (may already be done by deal)
    for i in 0..cards_to_reveal {
        table.community_cards[i] = table.pre_community[i];
    }

    // Mark flop_reached for rake calculation
    if next_phase == GamePhase::Flop {
        table.flop_reached = true;
    }

    // Advance phase
    table.phase = next_phase;
    table.actions_this_round = 0;
    table.min_bet = 0;

    // Set next player: in post-flop, action starts left of dealer
    // For HU: dealer is SB, so BB acts first post-flop
    let active_mask = table.seats_occupied & !table.seats_folded & !table.seats_allin;
    if active_mask == 0 {
        // All-in runout — no one can act, just advance
        table.current_player = 255;
    } else {
        // Find first active player after dealer
        let dealer = table.dealer_button;
        if let Some(next_player) = table.next_seat_in_mask(dealer, active_mask) {
            table.current_player = next_player;
        }
    }

    // Check if this is an all-in runout (no one can act)
    let active_count = active_mask.count_ones();
    if active_count <= 1 && table.seats_allin > 0 {
        // All-in runout: auto-advance to next reveal or showdown
        let auto_next = match table.phase {
            GamePhase::Flop => GamePhase::TurnRevealPending,
            GamePhase::Turn => GamePhase::RiverRevealPending,
            GamePhase::River => GamePhase::Showdown,
            _ => table.phase,
        };
        table.phase = auto_next;
        msg!("All-in runout: auto-advancing to {:?}", auto_next);
    }

    msg!(
        "MOCK REVEAL: {} community cards, phase={:?}, next_player={}",
        cards_to_reveal,
        table.phase,
        table.current_player,
    );

    Ok(())
}
