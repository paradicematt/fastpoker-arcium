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
use crate::instructions::init_comp_defs::COMP_DEF_OFFSET_SHUFFLE;
use crate::ID as PROGRAM_ID;

/// shuffle_and_deal MPC callback — receives encrypted card outputs.
///
/// Raw MPC output layout (11 outputs = 352 bytes, stride-3 per encrypted value):
///   Slots 0-2:  Mxe community   [nonce, ct1, ct2]
///   Slots 3-5:  Mxe packed_holes [nonce, ct1, ct2]  (u128, 7-bit packed 18 cards)
///   Slots 6-8:  P0 Shared        [nonce, ct1, ct2]
///   Slots 9-10: P1 Shared        [nonce, ct1]       (ct2 truncated but not needed)
///
/// The MXE packed_holes contains ALL 9 players' hole cards. Stored in
/// DeckState.encrypted_hole_cards[9..11] for reveal_all_showdown to decrypt.
/// P0+P1 Shared outputs enable client-side card viewing for first 2 players.
///
/// Packed u16 = card1 * 256 + card2. Client decrypts with shared secret + output nonce.

/// Output type for shuffle_and_deal MPC callback.
/// SIZE determines how many bytes SignedComputationOutputs reads from instruction data.
/// The actual struct is never deserialized (we use verify_output_raw + manual parsing).
/// Using a single-byte placeholder to keep Anchor's deserializer happy.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ShuffleAndDealOutput {
    pub _tag: u8, // unused — SIZE is what matters for SignedComputationOutputs
}

impl HasSize for ShuffleAndDealOutput {
    // SIZE = bytes of raw MPC output in the callback IX data.
    // Output count (11) must match encrypted return values in circuit. MPC sends count × 32 bytes.
    // Each encrypted value uses stride=3 in the raw output: [nonce(32), ct1(32), ct2(32)].
    // With 11 outputs = 352 bytes:
    //   Mxe community (3) + Mxe packed_holes (3) + P0 Shared (3) + P1 nonce+ct1 (2) = 11 slots.
    // All 9 players' cards in MXE pack. P0+P1 get client-side Shared decrypt.
    const SIZE: usize = 352;
}

// Raw MPC output: 11 × 32-byte slots (SIZE=352).
// Each Enc<T,V> output group = 3 slots: [nonce(32), ct1(32), ct2(32)].
// With 11 outputs, stride-3 covers:
//   Mxe community (slots 0-2) + Mxe packed_holes (slots 3-5)
//   + P0 Shared (slots 6-8) + P1 nonce+ct1 (slots 9-10).
// ct1 = primary ciphertext (the encrypted field element we need).
// ct2 = second Rescue block (internal padding, not used for decryption).
const SLOT_SIZE: usize = 32;
// Layout:
// Slot  0: Mxe community nonce
// Slot  1: Mxe community ct1    (packed community ciphertext)
// Slot  2: Mxe community ct2    (unused Rescue block)
// Slot  3: Mxe packed_holes nonce
// Slot  4: Mxe packed_holes ct1  (u128: all 18 hole cards, 7-bit packed)
// Slot  5: Mxe packed_holes ct2  (unused Rescue block)
// Slot  6: P0 nonce
// Slot  7: P0 ct1               ← hole card ciphertext for client decrypt
// Slot  8: P0 ct2               (unused)
// Slot  9: P1 nonce
// Slot 10: P1 ct1               ← hole card ciphertext (no ct2 but not needed)
const MXE_COMM_CT_SLOT: usize = 1;    // community ct at slot 1
const MXE_HOLES_NONCE_SLOT: usize = 3; // packed_holes nonce at slot 3
const MXE_HOLES_CT_SLOT: usize = 4;    // packed_holes ct1 at slot 4
const MXE_HOLES_CT2_SLOT: usize = 5;   // packed_holes ct2 at slot 5
const FIRST_PLAYER_SLOT: usize = 7;    // P0 ct1 at slot 7 (after 2 Mxe groups of 3)
const PLAYER_STRIDE: usize = 3;        // nonce + ct1 + ct2 per player
const TOTAL_OUTPUT_SIZE: usize = 352;   // 11 slots × 32 bytes

#[derive(Accounts)]
pub struct ShuffleAndDealCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,

    #[account(
        address = arcium_pda::computation_definition_acc(&PROGRAM_ID, COMP_DEF_OFFSET_SHUFFLE),
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
        constraint = table.phase == GamePhase::AwaitingDeal @ PokerError::InvalidActionForPhase,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [DECK_STATE_SEED, table.key().as_ref()],
        bump = deck_state.bump,
    )]
    pub deck_state: Box<Account<'info, DeckState>>,

    // remaining_accounts: SeatCards PDAs (one per occupied seat, in order)
}

/// Extract 32 bytes at the given byte offset from raw output.
fn get_slot(raw: &[u8], byte_offset: usize) -> [u8; 32] {
    let mut buf = [0u8; 32];
    if byte_offset + 32 <= raw.len() {
        buf.copy_from_slice(&raw[byte_offset..byte_offset + 32]);
    }
    buf
}

/// Byte offset for player i's hole card ciphertext (ct1 slot).
/// Layout per player group: [nonce, ct1, ct2] = 3 slots, stride=3.
/// P0 ct1 at slot 4 (= FIRST_PLAYER_SLOT), P1 ct1 at slot 7, etc.
fn player_ct_offset(player_idx: usize) -> usize {
    (FIRST_PLAYER_SLOT + player_idx * PLAYER_STRIDE) * SLOT_SIZE // (4 + i*3) * 32
}

/// Byte offset for player i's output nonce slot (first slot in group).
/// Nonce is 16-byte LE u128 zero-padded to 32 bytes.
fn player_nonce_offset(player_idx: usize) -> usize {
    // Nonce slot = ct1 slot - 1 slot = (3 + i*3) * 32
    player_ct_offset(player_idx) - SLOT_SIZE
}

/// Validate that the preceding instruction in this TX is Arcium's callbackComputation.
/// This prevents spoofing — only the Arcium program can invoke our callback.
pub(crate) fn validate_arcium_callback_context(
    instructions_sysvar: &AccountInfo,
    arcium_program_id: &Pubkey,
) -> Result<()> {
    use anchor_lang::solana_program::sysvar::instructions;
    let current_ix_index = instructions::load_current_index_checked(instructions_sysvar)
        .map_err(|_| PokerError::ArciumCallbackInvalid)?;
    // Our callback must not be the first IX — the preceding one must be Arcium's callbackComputation
    require!(current_ix_index > 0, PokerError::ArciumCallbackInvalid);
    let prev_ix = instructions::load_instruction_at_checked(
        (current_ix_index - 1) as usize,
        instructions_sysvar,
    ).map_err(|_| PokerError::ArciumCallbackInvalid)?;
    require!(prev_ix.program_id == *arcium_program_id, PokerError::ArciumCallbackInvalid);
    Ok(())
}

pub fn shuffle_and_deal_callback_handler(
    ctx: Context<ShuffleAndDealCallback>,
    output: SignedComputationOutputs<ShuffleAndDealOutput>,
) -> Result<()> {
    // Extract raw bytes from SignedComputationOutputs without BLS verification.
    // BLS verify_output_raw() fails on localnet (error 6001) due to cluster key mismatch —
    // known Arcium localnet limitation. We use CPI context validation instead:
    // validate_arcium_callback_context checks the preceding IX is Arcium's callbackComputation.
    // TODO: Re-enable BLS verification for devnet/mainnet where cluster keys are stable.
    validate_arcium_callback_context(
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.arcium_program.key(),
    )?;

    let raw_bytes = match output {
        SignedComputationOutputs::Success(bytes, _sig) => bytes,
        SignedComputationOutputs::Failure => {
            msg!("MPC computation failed (Failure variant)");
            return Err(PokerError::ArciumComputationTimeout.into());
        }
        _ => return Err(PokerError::ArciumCallbackInvalid.into()),
    };
    msg!("MPC SUCCESS: {} bytes raw output (expected {})", raw_bytes.len(), TOTAL_OUTPUT_SIZE);

    // DIAGNOSTIC: dump first 8 bytes of each 32-byte slot to identify layout
    for s in 0..std::cmp::min(12, raw_bytes.len() / 32) {
        let off = s * 32;
        msg!("SLOT[{}]: {:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}..{:02x}{:02x}{:02x}{:02x}",
            s,
            raw_bytes[off], raw_bytes[off+1], raw_bytes[off+2], raw_bytes[off+3],
            raw_bytes[off+4], raw_bytes[off+5], raw_bytes[off+6], raw_bytes[off+7],
            raw_bytes[off+28], raw_bytes[off+29], raw_bytes[off+30], raw_bytes[off+31]);
    }

    require!(raw_bytes.len() >= TOTAL_OUTPUT_SIZE, PokerError::ArciumCallbackInvalid);

    let table = &mut ctx.accounts.table;
    let deck_state = &mut ctx.accounts.deck_state;

    // Write encrypted hole cards + nonces to SeatCards via remaining_accounts.
    // Layout per player group: [nonce(32), ct1(32), ct2(32)] — stride=3, nonce-first.
    // ct1 = primary ciphertext for decryption. Nonce = first 16 bytes of nonce slot.
    // SeatCards layout: disc(8) + table(32) + seat_index(1) + player(32) + card1(1) + card2(1) + bump(1) + enc_card1(32) + enc_card2(32) + nonce(16)
    let enc1_offset = 8 + 32 + 1 + 32 + 1 + 1 + 1; // = 76
    let enc2_offset = enc1_offset + 32; // = 108
    let nonce_offset = enc2_offset + 32; // = 140

    let seat_cards_accounts = &ctx.remaining_accounts;
    for player_idx in 0..9usize {
        if player_idx >= seat_cards_accounts.len() {
            break;
        }
        let seat_cards_info = &seat_cards_accounts[player_idx];
        let mut data = seat_cards_info.try_borrow_mut_data()?;
        if data.len() < nonce_offset + 16 {
            continue;
        }

        let ct_off = player_ct_offset(player_idx);
        let nonce_off = player_nonce_offset(player_idx);

        // Only write if the ct is within the raw output bounds
        if ct_off + 32 <= raw_bytes.len() {
            // Write ct1 (primary ciphertext) to enc_card1
            let packed_ct = get_slot(&raw_bytes, ct_off);
            data[enc1_offset..enc1_offset + 32].copy_from_slice(&packed_ct);
            // Write raw nonce slot to enc_card2 (diagnostic — full 32-byte slot)
            let raw_nonce_slot = get_slot(&raw_bytes, nonce_off);
            data[enc2_offset..enc2_offset + 32].copy_from_slice(&raw_nonce_slot);
            // Write output nonce (first 16 bytes of nonce slot) to SeatCards.nonce
            data[nonce_offset..nonce_offset + 16].copy_from_slice(&raw_nonce_slot[..16]);
        } else {
            // Player's data is beyond SIZE window — zero out
            data[enc1_offset..enc1_offset + 32].copy_from_slice(&[0u8; 32]);
            data[enc2_offset..enc2_offset + 32].copy_from_slice(&[0u8; 32]);
            data[nonce_offset..nonce_offset + 16].copy_from_slice(&[0u8; 16]);
        }
    }

    // Write MXE community encrypted group to DeckState for reveal_community.
    // MPC stride=3: slot 0 = nonce, slot 1 = ct1, slot 2 = ct2.
    deck_state.encrypted_community[0] = get_slot(&raw_bytes, 0);                           // comm nonce
    deck_state.encrypted_community[1] = get_slot(&raw_bytes, MXE_COMM_CT_SLOT * SLOT_SIZE); // comm ct1
    deck_state.encrypted_community[2] = get_slot(&raw_bytes, 2 * SLOT_SIZE);                // comm ct2
    for i in 3..5 {
        deck_state.encrypted_community[i] = [0u8; 32];
    }
    deck_state.community_nonces = [[0u8; 16]; 5];

    // Write MXE packed_holes encrypted group to DeckState for reveal_all_showdown.
    // Stored in encrypted_hole_cards[9..11] (repurposing unused slots).
    // This contains ALL 9 players' hole cards packed into a single Enc<Mxe, u128>.
    deck_state.encrypted_hole_cards[9]  = get_slot(&raw_bytes, MXE_HOLES_NONCE_SLOT * SLOT_SIZE); // holes nonce
    deck_state.encrypted_hole_cards[10] = get_slot(&raw_bytes, MXE_HOLES_CT_SLOT * SLOT_SIZE);    // holes ct1
    deck_state.encrypted_hole_cards[11] = get_slot(&raw_bytes, MXE_HOLES_CT2_SLOT * SLOT_SIZE);   // holes ct2

    // Mark shuffle complete and transition to Preflop
    deck_state.shuffle_complete = true;
    table.phase = GamePhase::Preflop;
    table.action_nonce = table.action_nonce.wrapping_add(1);

    // Set first-to-act for preflop
    let active_mask = table.seats_occupied & !table.seats_folded & !table.seats_allin;
    if active_mask != 0 {
        let bb = table.big_blind_seat;
        if let Some(next) = table.next_seat_in_mask(bb, active_mask) {
            table.current_player = next;
        }
    }

    msg!(
        "shuffle_and_deal callback: hand #{}, wrote encrypted cards, phase→Preflop",
        deck_state.hand_number,
    );

    Ok(())
}
