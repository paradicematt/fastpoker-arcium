use anchor_lang::prelude::*;
use arcium_anchor::{
    queue_computation, ArgBuilder, SIGN_PDA_SEED,
    ARCIUM_CLOCK_ACCOUNT_ADDRESS, ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    traits::QueueCompAccs,
};
use arcium_client::idl::arcium::{
    accounts::{MXEAccount, ComputationDefinitionAccount, Cluster, FeePool, ClockAccount},
    cpi::accounts::QueueComputation,
    program::Arcium,
    types::{CallbackInstruction, CallbackAccount},
    ID_CONST as ARCIUM_PROG_ID,
};
use arcium_client::pda as arcium_pda;

use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;
use crate::instructions::arcium_deal::ArciumSignerAccount;
use crate::instructions::init_comp_defs::COMP_DEF_OFFSET_CLAIM;
use crate::ID as PROGRAM_ID;

/// Queue MPC claim_hole_cards computation for a single player (P2+).
///
/// Re-encrypts the player's hole cards from the MXE Pack<[u8;23]>
/// (already stored in DeckState from the deal callback) to the player's
/// Shared key. The callback writes encrypted data to SeatCards.
///
/// PERMISSIONLESS — crank or player can call during AwaitingDeal or Preflop.
/// Safe to call multiple times (MPC is idempotent — same result each time).

#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ArciumClaimCardsQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [SIGN_PDA_SEED],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,

    #[account(address = arcium_pda::mxe_acc(&PROGRAM_ID))]
    pub mxe_account: Account<'info, MXEAccount>,

    /// CHECK: mempool — validated by address constraint
    #[account(mut)]
    pub mempool_account: UncheckedAccount<'info>,

    /// CHECK: executing_pool — validated by address constraint
    #[account(mut)]
    pub executing_pool: UncheckedAccount<'info>,

    /// CHECK: computation_account — validated by Arcium CPI
    #[account(mut)]
    pub computation_account: UncheckedAccount<'info>,

    #[account(
        address = arcium_pda::computation_definition_acc(&PROGRAM_ID, COMP_DEF_OFFSET_CLAIM),
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,

    #[account(mut)]
    pub cluster_account: Account<'info, Cluster>,

    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,

    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,

    pub arcium_program: Program<'info, Arcium>,

    // ── FastPoker game accounts ──

    #[account(
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
    )]
    pub table: Account<'info, Table>,

    #[account(
        seeds = [DECK_STATE_SEED, table.key().as_ref()],
        bump = deck_state.bump,
    )]
    pub deck_state: Box<Account<'info, DeckState>>,

    pub system_program: Program<'info, System>,
}

impl<'info> QueueCompAccs<'info> for ArciumClaimCardsQueue<'info> {
    fn comp_def_offset(&self) -> u32 { COMP_DEF_OFFSET_CLAIM }
    fn queue_comp_accs(&self) -> QueueComputation<'info> {
        QueueComputation {
            signer: self.payer.to_account_info(),
            sign_seed: self.sign_pda_account.to_account_info(),
            comp: self.computation_account.to_account_info(),
            mxe: self.mxe_account.to_account_info(),
            executing_pool: self.executing_pool.to_account_info(),
            mempool: self.mempool_account.to_account_info(),
            comp_def_acc: self.comp_def_account.to_account_info(),
            cluster: self.cluster_account.to_account_info(),
            pool_account: self.pool_account.to_account_info(),
            system_program: self.system_program.to_account_info(),
            clock: self.clock_account.to_account_info(),
        }
    }
    fn arcium_program(&self) -> AccountInfo<'info> { self.arcium_program.to_account_info() }
    fn mxe_program(&self) -> Pubkey { PROGRAM_ID }
    fn signer_pda_bump(&self) -> u8 { self.sign_pda_account.bump }
}

pub fn handler(
    ctx: Context<ArciumClaimCardsQueue>,
    computation_offset: u64,
    seat_index: u8,
) -> Result<()> {
    let table = &ctx.accounts.table;
    let deck_state = &ctx.accounts.deck_state;

    // Allow during Preflop or later betting phases (cards already dealt).
    // Also allow AwaitingDeal → the deal callback will set phase to Preflop
    // before claim_hole_cards callback arrives.
    require!(
        table.phase == GamePhase::Preflop
            || table.phase == GamePhase::Flop
            || table.phase == GamePhase::Turn
            || table.phase == GamePhase::River
            || table.phase == GamePhase::AwaitingDeal,
        PokerError::InvalidActionForPhase
    );

    require!(seat_index < 9, PokerError::InvalidPlayerCount);

    // Verify this seat is occupied
    require!(
        (table.seats_occupied & (1u16 << seat_index)) != 0,
        PokerError::SeatNotOccupied
    );

    // Read MXE Pack nonce + ct from DeckState (stored by deal callback)
    // encrypted_community[0] = MXE all-cards nonce, [1] = MXE all-cards ct1
    let mxe_nonce = u128::from_le_bytes(
        deck_state.encrypted_community[0][..16].try_into().unwrap()
    );
    let mxe_ct = deck_state.encrypted_community[1];

    // Read player's x25519 pubkey and input nonce from DeckState
    let player_pubkey = deck_state.encrypted_hole_cards[seat_index as usize];
    let player_nonce = u128::from_le_bytes(
        deck_state.hole_card_nonces[seat_index as usize]
    );

    // Build MPC args: Enc<Mxe> (nonce + ct) + Shared (pubkey + nonce) + u8 seat_index
    let args = ArgBuilder::new()
        .plaintext_u128(mxe_nonce)
        .encrypted_u128(mxe_ct)
        .x25519_pubkey(player_pubkey)
        .plaintext_u128(player_nonce)
        .plaintext_u8(seat_index)
        .build();

    // Build callback — write to this player's SeatCards
    let table_key = table.key();
    let comp_def_key = ctx.accounts.comp_def_account.key();
    let mxe_key = ctx.accounts.mxe_account.key();
    let cluster_key = ctx.accounts.cluster_account.key();

    // Anchor discriminator = SHA256("global:claim_hole_cards_callback")[0..8]
    let callback_disc: Vec<u8> = vec![0xae, 0xcb, 0xcb, 0x2e, 0xda, 0xff, 0x89, 0xf2];

    let (seat_cards_pda, _) = Pubkey::find_program_address(
        &[SEAT_CARDS_SEED, table_key.as_ref(), &[seat_index]],
        &PROGRAM_ID,
    );

    let (deck_state_pda, _) = Pubkey::find_program_address(
        &[DECK_STATE_SEED, table_key.as_ref()],
        &PROGRAM_ID,
    );

    let cb_accounts = vec![
        CallbackAccount { pubkey: ARCIUM_PROG_ID, is_writable: false },
        CallbackAccount { pubkey: comp_def_key, is_writable: false },
        CallbackAccount { pubkey: mxe_key, is_writable: false },
        CallbackAccount { pubkey: ctx.accounts.computation_account.key(), is_writable: false },
        CallbackAccount { pubkey: cluster_key, is_writable: false },
        CallbackAccount { pubkey: anchor_lang::solana_program::sysvar::instructions::ID, is_writable: false },
        CallbackAccount { pubkey: table_key, is_writable: false },         // read-only
        CallbackAccount { pubkey: deck_state_pda, is_writable: false },    // read nonce for output_nonce computation
        CallbackAccount { pubkey: seat_cards_pda, is_writable: true },     // write encrypted cards
    ];

    let callbacks = vec![CallbackInstruction {
        program_id: PROGRAM_ID,
        discriminator: callback_disc,
        accounts: cb_accounts,
    }];

    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        callbacks,
        1,
        0,
    )?;

    msg!(
        "Queued claim_hole_cards: seat {}, hand #{}, offset={}",
        seat_index, table.hand_number, computation_offset
    );

    Ok(())
}
