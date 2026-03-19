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
use crate::instructions::init_comp_defs::COMP_DEF_OFFSET_SHOWDOWN;
use crate::instructions::arcium_deal_callback::validate_arcium_callback_context;
use crate::ID as PROGRAM_ID;

/// Showdown reveal — callback from Arcium MPC reveal_player_cards circuit.
///
/// Called once per active player by the Arcium MPC cluster.
/// Receives SignedComputationOutputs containing 1 packed u16 plaintext value.
/// Unpacks to card1/card2 and writes to Table.revealed_hands[seat_idx].
///
/// When all active players' reveals are received (tracked by showdown_reveals_done
/// in DeckState), transitions AwaitingShowdown → Showdown.
///
/// Caller validated via CPI context — preceding IX must be Arcium's callbackComputation.

/// Output type for reveal_player_cards MPC callback.
/// SIZE = 1 packed u16 output = 2 bytes.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RevealShowdownOutput {
    pub _tag: u8, // unused — SIZE is what matters
}

impl HasSize for RevealShowdownOutput {
    // 1 PlaintextU16 value = 2 bytes in MPC raw output
    const SIZE: usize = 2;
}

#[derive(Accounts)]
pub struct RevealShowdownCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,

    #[account(
        address = arcium_pda::computation_definition_acc(&PROGRAM_ID, COMP_DEF_OFFSET_SHOWDOWN),
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
        constraint = table.phase == GamePhase::AwaitingShowdown @ PokerError::InvalidActionForPhase,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [DECK_STATE_SEED, table.key().as_ref()],
        bump = deck_state.bump,
    )]
    pub deck_state: Box<Account<'info, DeckState>>,
    // SeatCards passed as remaining_accounts (9 PDAs, one per seat)
}

pub fn reveal_showdown_callback_handler(
    ctx: Context<RevealShowdownCallback>,
    output: SignedComputationOutputs<RevealShowdownOutput>,
) -> Result<()> {
    // Validate caller: preceding IX must be Arcium's callbackComputation (threat A11)
    validate_arcium_callback_context(
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.arcium_program.key(),
    )?;

    // Read seat_idx from DeckState (written by queue instruction).
    // Callbacks arrive in FIFO order from the cluster, matching queue order.
    let deck_state = &ctx.accounts.deck_state;
    let reveal_idx = deck_state.showdown_reveals_done as usize;
    require!(reveal_idx < 9, PokerError::InvalidSeatNumber);
    let seat_idx = deck_state.showdown_reveal_seats[reveal_idx];
    require!(seat_idx < 9, PokerError::InvalidSeatNumber);

    // Extract raw bytes from MPC output
    let raw_bytes = match output {
        SignedComputationOutputs::Success(bytes, _sig) => bytes,
        SignedComputationOutputs::Failure => {
            msg!("MPC reveal_player_cards failed (Failure variant) for seat {}", seat_idx);
            return Err(PokerError::ArciumComputationTimeout.into());
        }
        _ => return Err(PokerError::ArciumCallbackInvalid.into()),
    };

    msg!("reveal_player_cards MPC SUCCESS: seat={}, {} bytes", seat_idx, raw_bytes.len());
    require!(raw_bytes.len() >= 2, PokerError::ArciumCallbackInvalid);

    // Parse 1 packed u16 — PlaintextU16 output is 2 bytes (LE).
    // card1 = u16 >> 8, card2 = u16 & 0xFF.
    let packed = u16::from_le_bytes([raw_bytes[0], raw_bytes[1]]);
    let card1 = (packed >> 8) as u8;
    let card2 = (packed & 0xFF) as u8;

    let table = &mut ctx.accounts.table;
    let i = seat_idx as usize;
    table.revealed_hands[i * 2] = card1;
    table.revealed_hands[i * 2 + 1] = card2;

    // Write plaintext cards to SeatCards so settle_hand can evaluate hands.
    // SeatCards is passed as remaining_accounts[0] by the callback account list.
    // Layout: disc(8) + table(32) + seat_index(1) + player(32) + card1(1) + card2(1)
    const SC_CARD1_OFFSET: usize = 8 + 32 + 1 + 32; // 73
    const SC_CARD2_OFFSET: usize = SC_CARD1_OFFSET + 1; // 74
    if !ctx.remaining_accounts.is_empty() {
        let sc_info = &ctx.remaining_accounts[0];
        let mut sc_data = sc_info.try_borrow_mut_data()?;
        if sc_data.len() > SC_CARD2_OFFSET {
            sc_data[SC_CARD1_OFFSET] = card1;
            sc_data[SC_CARD2_OFFSET] = card2;
            msg!("SeatCards[{}] plaintext written: card1={}, card2={}", seat_idx, card1, card2);
        }
    }

    // Track completion
    let deck_state = &mut ctx.accounts.deck_state;
    deck_state.showdown_reveals_done += 1;

    msg!(
        "Showdown reveal: seat={}, cards=[{},{}], done={}/{}",
        seat_idx, card1, card2,
        deck_state.showdown_reveals_done, deck_state.showdown_reveals_expected
    );

    // When all active players revealed, transition AwaitingShowdown → Showdown
    if deck_state.showdown_reveals_done >= deck_state.showdown_reveals_expected {
        table.phase = GamePhase::Showdown;
        table.action_nonce = table.action_nonce.wrapping_add(1);
        msg!("All showdown reveals done — phase→Showdown");
    }

    Ok(())
}
