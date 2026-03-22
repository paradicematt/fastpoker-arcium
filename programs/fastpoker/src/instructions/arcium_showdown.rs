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
use crate::instructions::arcium_deal_callback::extract_mpc_output;
use crate::ID as PROGRAM_ID;

/// Showdown reveal — callback from Arcium MPC reveal_all_showdown circuit.
///
/// Called ONCE by the Arcium MPC cluster. Receives SignedComputationOutputs
/// containing 9 packed u16 plaintext values (one per seat, 0xFFFF for inactive).
/// Unpacks each to card1/card2 and writes to Table.revealed_hands + SeatCards.
///
/// Transitions AwaitingShowdown → Showdown immediately (single callback).
///
/// Caller validated via CPI context — preceding IX must be Arcium's callbackComputation.

/// Output type for reveal_all_showdown MPC callback.
/// SIZE = 9 PlaintextU16 values × 2 bytes each = 18 bytes.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RevealShowdownOutput {
    pub _tag: u8, // unused — SIZE is what matters
}

impl HasSize for RevealShowdownOutput {
    // 9 PlaintextU16 values = 18 bytes in MPC raw output
    const SIZE: usize = 18;
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
    // Extract raw bytes with BLS verification (production) or CPI-only (localnet skip-bls).
    let raw_bytes = extract_mpc_output(
        output,
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.arcium_program.key(),
    )?;

    msg!("reveal_all_showdown MPC SUCCESS: {} bytes (expected 18)", raw_bytes.len());
    require!(raw_bytes.len() >= 18, PokerError::ArciumCallbackInvalid);

    let table = &mut ctx.accounts.table;

    // Parse 9 packed u16 values — PlaintextU16 outputs are 2 bytes each (LE), consecutive.
    // card1 = u16 >> 8, card2 = u16 & 0xFF. 0xFFFF = inactive/folded.
    const SC_CARD1_OFFSET: usize = 8 + 32 + 1 + 32; // 73
    const SC_CARD2_OFFSET: usize = SC_CARD1_OFFSET + 1; // 74

    // remaining_accounts contains SeatCards PDAs for occupied seats (in seat order)
    let seat_cards_accounts = &ctx.remaining_accounts;
    let mut sc_idx = 0usize; // index into remaining_accounts

    for seat in 0..9usize {
        let byte_off = seat * 2;
        let packed = u16::from_le_bytes([raw_bytes[byte_off], raw_bytes[byte_off + 1]]);
        let card1 = (packed >> 8) as u8;
        let card2 = (packed & 0xFF) as u8;

        table.revealed_hands[seat * 2] = card1;
        table.revealed_hands[seat * 2 + 1] = card2;

        // Write plaintext cards to SeatCards for occupied seats
        // so settle_hand can evaluate hands from SeatCards offsets 73-74.
        if table.seats_occupied & (1 << seat) != 0 {
            if sc_idx < seat_cards_accounts.len() {
                let sc_info = &seat_cards_accounts[sc_idx];
                if let Ok(mut sc_data) = sc_info.try_borrow_mut_data() {
                    if sc_data.len() > SC_CARD2_OFFSET {
                        sc_data[SC_CARD1_OFFSET] = card1;
                        sc_data[SC_CARD2_OFFSET] = card2;
                    }
                }
                sc_idx += 1;
            }
        }

        if card1 != 255 {
            msg!("Seat {} revealed: [{}, {}]", seat, card1, card2);
        }
    }

    // Transition AwaitingShowdown → Showdown (single callback does it all)
    table.phase = GamePhase::Showdown;
    table.action_nonce = table.action_nonce.wrapping_add(1);
    msg!("All showdown reveals done — phase→Showdown");

    // Emit verification event — computation_offset identifies this MPC showdown
    emit!(crate::events::ArciumShowdownVerified {
        table: table.key(),
        hand_number: ctx.accounts.deck_state.hand_number,
        computation_offset: ctx.accounts.deck_state.computation_offset,
    });

    Ok(())
}
