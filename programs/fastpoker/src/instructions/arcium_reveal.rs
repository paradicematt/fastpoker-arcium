use anchor_lang::prelude::*;
use arcium_anchor::{HasSize, SignedComputationOutputs};
use arcium_client::idl::arcium::{
    accounts::{MXEAccount, ComputationDefinitionAccount, Cluster},
    program::Arcium,
};
use arcium_client::pda as arcium_pda;

use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;
use crate::instructions::init_comp_defs::COMP_DEF_OFFSET_REVEAL;
use crate::instructions::arcium_deal_callback::extract_mpc_output;
use crate::ID as PROGRAM_ID;

/// Reveal community cards — callback from Arcium MPC reveal_community circuit.
///
/// Called by the Arcium MPC cluster after reveal_community computation completes.
/// The crank queues the computation via arcium_reveal_queue; the MPC callback fires
/// this instruction with SignedComputationOutputs containing 5 plaintext card values.
///
/// Flow:
///   1. Betting round ends → phase = *RevealPending
///   2. Crank calls arcium_reveal_queue → queues MPC computation
///   3. MPC callback calls this instruction with SignedComputationOutputs
///   4. This parses plaintext cards, writes to Table, transitions to next phase
///
/// Caller validated via CPI context — preceding IX must be Arcium's callbackComputation.

/// Output type for reveal_community MPC callback.
/// SIZE = 5 plaintext u8 outputs × 1 byte each = 5 bytes.
/// PlaintextU8 MPC outputs are native-sized (1 byte), NOT 32-byte field elements.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RevealCommunityOutput {
    pub _tag: u8, // unused — SIZE is what matters
}

impl HasSize for RevealCommunityOutput {
    // 5 PlaintextU8 values — each is 1 byte in MPC raw output
    const SIZE: usize = 5;
}

const NUM_COMMUNITY_OUTPUTS: usize = 5;

#[derive(Accounts)]
pub struct RevealCommunityCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,

    #[account(
        address = arcium_pda::computation_definition_acc(&PROGRAM_ID, COMP_DEF_OFFSET_REVEAL),
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,

    #[account(address = arcium_pda::mxe_acc(&PROGRAM_ID))]
    pub mxe_account: Account<'info, MXEAccount>,

    /// CHECK: computation_account — validated by Arcium callback context
    pub computation_account: UncheckedAccount<'info>,

    pub cluster_account: Account<'info, Cluster>,

    /// CHECK: instructions_sysvar — used to validate preceding Arcium callbackComputation IX
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    // ── FastPoker game accounts ──

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = matches!(table.phase,
            GamePhase::FlopRevealPending | GamePhase::TurnRevealPending | GamePhase::RiverRevealPending
        ) @ PokerError::InvalidActionForPhase,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [DECK_STATE_SEED, table.key().as_ref()],
        bump = deck_state.bump,
    )]
    pub deck_state: Box<Account<'info, DeckState>>,
}

pub fn reveal_community_callback_handler(
    ctx: Context<RevealCommunityCallback>,
    output: SignedComputationOutputs<RevealCommunityOutput>,
) -> Result<()> {
    // Extract raw bytes with BLS verification (production) or CPI-only (localnet skip-bls).
    let raw_bytes = extract_mpc_output(
        output,
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.arcium_program.key(),
    )?;

    msg!("reveal_community MPC SUCCESS: {} bytes raw output", raw_bytes.len());

    require!(raw_bytes.len() >= NUM_COMMUNITY_OUTPUTS, PokerError::ArciumCallbackInvalid);

    // Parse 5 plaintext card values — each PlaintextU8 output is 1 byte.
    let mut cards = [255u8; 5];
    for i in 0..NUM_COMMUNITY_OUTPUTS {
        cards[i] = raw_bytes[i];
        // Bounds check: valid card is 0-51, 255 = not revealed
        if cards[i] != 255 && cards[i] > 51 {
            msg!("WARNING: card[{}] = {} (out of range, treating as 255)", i, cards[i]);
            cards[i] = 255;
        }
    }

    let table = &mut ctx.accounts.table;
    let deck_state = &mut ctx.accounts.deck_state;

    // Determine num_revealed from current phase
    let num_revealed: u8 = match table.phase {
        GamePhase::FlopRevealPending => 3,
        GamePhase::TurnRevealPending => 4,
        GamePhase::RiverRevealPending => 5,
        _ => return Err(PokerError::InvalidActionForPhase.into()),
    };

    // Write revealed community cards to table
    for i in 0..(num_revealed as usize).min(5) {
        if cards[i] != 255 {
            table.community_cards[i] = cards[i];
        }
    }

    // Update deck state
    deck_state.cards_revealed = num_revealed;

    // Transition to next betting phase
    match table.phase {
        GamePhase::FlopRevealPending => {
            table.phase = GamePhase::Flop;
            table.flop_reached = true;
            msg!("Community reveal: flop [{}, {}, {}]", cards[0], cards[1], cards[2]);
        },
        GamePhase::TurnRevealPending => {
            table.phase = GamePhase::Turn;
            msg!("Community reveal: turn [{}]", cards[3]);
        },
        GamePhase::RiverRevealPending => {
            table.phase = GamePhase::River;
            msg!("Community reveal: river [{}]", cards[4]);
        },
        _ => return Err(PokerError::InvalidActionForPhase.into()),
    }

    // Reset actions for new betting round
    table.actions_this_round = 0;
    table.min_bet = 0;
    table.action_nonce = table.action_nonce.wrapping_add(1);

    // Set next player: post-flop, action starts left of dealer
    let active_mask = table.seats_occupied & !table.seats_folded & !table.seats_allin;
    if active_mask == 0 {
        table.current_player = 255; // All-in runout — no one can act
    } else {
        let dealer = table.dealer_button;
        if let Some(next_player) = table.next_seat_in_mask(dealer, active_mask) {
            table.current_player = next_player;
        }
    }

    // All-in runout: if no one can act, auto-advance to next reveal or showdown
    let active_count = active_mask.count_ones();
    if active_count <= 1 && table.seats_allin > 0 {
        let auto_next = match table.phase {
            GamePhase::Flop => GamePhase::TurnRevealPending,
            GamePhase::Turn => GamePhase::RiverRevealPending,
            GamePhase::River => GamePhase::Showdown,
            _ => table.phase,
        };
        table.phase = auto_next;
        msg!("All-in runout: auto-advancing to {:?}", auto_next);
    }

    Ok(())
}
