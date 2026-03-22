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
use crate::instructions::init_comp_defs::COMP_DEF_OFFSET_CLAIM;
use crate::instructions::arcium_deal_callback::extract_mpc_output;
use crate::ID as PROGRAM_ID;

/// claim_hole_cards MPC callback — receives a single Enc<Shared, u16> output.
///
/// Raw output: 3 × 32-byte slots (Output::Ciphertext; 3, SIZE=96).
/// Verified layout for single-value circuits: [ct2, nonce, ct1]
///   slot 0 (bytes 0-31):  ct2 (unused Rescue block)
///   slot 1 (bytes 32-63): nonce (16-byte LE u128, zero-padded to 32)
///   slot 2 (bytes 64-95): ct1 (primary Rescue ciphertext — the one for decryption)
/// Nonce is computed from DeckState input_nonce + 1 (not read from raw output).

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ClaimHoleCardsOutput {
    pub _tag: u8,
}

impl HasSize for ClaimHoleCardsOutput {
    // Raw output size = 3 × 32-byte slots (nonce + ct1 + ct2)
    const SIZE: usize = 96;
}

#[derive(Accounts)]
pub struct ClaimHoleCardsCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,

    #[account(
        address = arcium_pda::computation_definition_acc(&PROGRAM_ID, COMP_DEF_OFFSET_CLAIM),
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,

    #[account(address = arcium_pda::mxe_acc(&PROGRAM_ID))]
    pub mxe_account: Account<'info, MXEAccount>,

    /// CHECK: computation_account — validated by Arcium callback context
    pub computation_account: UncheckedAccount<'info>,

    pub cluster_account: Account<'info, Cluster>,

    /// CHECK: instructions_sysvar
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    // ── FastPoker game accounts ──

    #[account(
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
    )]
    pub table: Account<'info, Table>,

    /// DeckState — used to validate output pubkey matches seat's x25519 pubkey.
    #[account(
        seeds = [DECK_STATE_SEED, table.key().as_ref()],
        bump = deck_state.bump,
    )]
    pub deck_state: Box<Account<'info, DeckState>>,

    /// The target SeatCards account to write encrypted card data to.
    #[account(
        mut,
        seeds = [SEAT_CARDS_SEED, table.key().as_ref(), &[seat_cards.seat_index]],
        bump = seat_cards.bump,
        constraint = seat_cards.table == table.key() @ PokerError::SeatNotAtTable,
    )]
    pub seat_cards: Account<'info, SeatCards>,
}

pub fn claim_hole_cards_callback_handler(
    ctx: Context<ClaimHoleCardsCallback>,
    output: SignedComputationOutputs<ClaimHoleCardsOutput>,
) -> Result<()> {
    let raw_bytes = extract_mpc_output(
        output,
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.arcium_program.key(),
    )?;
    msg!("claim_hole_cards callback: {} bytes raw output", raw_bytes.len());

    let seat_idx = ctx.accounts.seat_cards.seat_index as usize;

    if raw_bytes.len() < 96 {
        msg!("ERROR: claim_hole_cards output too short ({} < 96)", raw_bytes.len());
        return Err(PokerError::ArciumCallbackInvalid.into());
    }

    // Compute output nonce = DeckState input_nonce + 1
    let input_nonce = u128::from_le_bytes(
        ctx.accounts.deck_state.hole_card_nonces[seat_idx]
    );
    let output_nonce = input_nonce.wrapping_add(1);
    let output_nonce_bytes = output_nonce.to_le_bytes();

    // Verified layout for single-value Enc<Shared> with Output::Ciphertext;3:
    //   slot 0 = ct2 (unused), slot 1 = nonce, slot 2 = ct1 (primary ciphertext)
    let mut ct1 = [0u8; 32];
    ct1.copy_from_slice(&raw_bytes[64..96]); // slot 2

    msg!(
        "claim_hole_cards: seat {}, ct1={:02x}{:02x}{:02x}{:02x}..., nonce={}",
        seat_idx, ct1[0], ct1[1], ct1[2], ct1[3], output_nonce,
    );

    // Write to SeatCards
    let seat_cards = &mut ctx.accounts.seat_cards;
    seat_cards.enc_card1 = ct1;
    // Store nonce slot (slot 1) in enc_card2 for diagnostics (matches deal callback pattern)
    let mut nonce_slot = [0u8; 32];
    nonce_slot.copy_from_slice(&raw_bytes[32..64]);
    seat_cards.enc_card2 = nonce_slot;
    seat_cards.nonce = output_nonce_bytes;

    msg!(
        "claim_hole_cards DONE: seat {} encrypted cards written to SeatCards",
        seat_cards.seat_index,
    );

    Ok(())
}
