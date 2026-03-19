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
use crate::state::crank_tally::try_record_crank_action;
use crate::errors::PokerError;
use crate::constants::*;
use crate::instructions::init_comp_defs::COMP_DEF_OFFSET_SHOWDOWN;
use crate::instructions::arcium_deal::ArciumSignerAccount;
use crate::ID as PROGRAM_ID;

/// Queue MPC reveal_player_cards computation for a single player via Arcium.
/// Called once per active (non-folded) player at showdown.
///
/// First call transitions Showdown → AwaitingShowdown.
/// Subsequent calls for other seats stay in AwaitingShowdown.
/// The callback writes each player's revealed hand to Table.revealed_hands.
/// When the last active player's callback arrives, transitions → Showdown.
///
/// PERMISSIONLESS — anyone can call when phase is Showdown or AwaitingShowdown.

#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ArciumShowdownQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [SIGN_PDA_SEED],
        bump = sign_pda_account.bump,
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
        address = arcium_pda::computation_definition_acc(&PROGRAM_ID, COMP_DEF_OFFSET_SHOWDOWN),
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
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = (table.phase == GamePhase::Showdown || table.phase == GamePhase::AwaitingShowdown) @ PokerError::InvalidActionForPhase,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [DECK_STATE_SEED, table.key().as_ref()],
        bump = deck_state.bump,
        constraint = deck_state.shuffle_complete @ PokerError::ShuffleNotComplete,
    )]
    pub deck_state: Box<Account<'info, DeckState>>,

    pub system_program: Program<'info, System>,
}

/// Manual QueueCompAccs implementation for reveal_showdown
impl<'info> QueueCompAccs<'info> for ArciumShowdownQueue<'info> {
    fn comp_def_offset(&self) -> u32 {
        COMP_DEF_OFFSET_SHOWDOWN
    }

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

    fn arcium_program(&self) -> AccountInfo<'info> {
        self.arcium_program.to_account_info()
    }

    fn mxe_program(&self) -> Pubkey {
        PROGRAM_ID
    }

    fn signer_pda_bump(&self) -> u8 {
        self.sign_pda_account.bump
    }
}

pub fn handler(
    ctx: Context<ArciumShowdownQueue>,
    computation_offset: u64,
    seat_idx: u8,
) -> Result<()> {
    let deck_state = &ctx.accounts.deck_state;
    let table_key = ctx.accounts.table.key();
    let max_p = ctx.accounts.table.max_players;

    require!(seat_idx < max_p, PokerError::InvalidSeatNumber);

    // Build MPC args for reveal_player_cards circuit:
    // reveal_player_cards(packed: Enc<Shared, u16>) -> u16
    //
    // Args in ArgBuilder order (Enc<Shared> pattern):
    //   .x25519_pubkey(pubkey)       — from DeckState.encrypted_hole_cards[seat_idx]
    //   .plaintext_u128(output_nonce)— OUTPUT nonce from SeatCards offset 140 (= input_nonce + 1)
    //   .encrypted_u16(ct_bytes)     — ciphertext read from SeatCards remaining_accounts[0]
    //
    // SeatCards layout: disc(8) + table(32) + seat_index(1) + player(32) + card1(1) + card2(1) + bump(1) = 76
    // enc_card1(32) at offset 76, enc_card2(32) at offset 108, nonce(16) at offset 140
    const ENC1_OFFSET: usize = 76;
    const NONCE_OFFSET: usize = 140; // OUTPUT nonce written by deal callback (= input_nonce + 1)

    let i = seat_idx as usize;
    let pubkey = deck_state.encrypted_hole_cards[i];

    // Read ciphertext + OUTPUT nonce from SeatCards passed as remaining_accounts[0].
    // CRITICAL: pass the OUTPUT nonce (input_nonce + 1), NOT the input nonce.
    // reveal_community works because it reads the output nonce from encrypted_community[0].
    // Same pattern here — the deal callback stored the output nonce at SeatCards offset 140.
    require!(!ctx.remaining_accounts.is_empty(), PokerError::InvalidAccountCount);
    let seat_cards_info = &ctx.remaining_accounts[0];
    let seat_data = seat_cards_info.try_borrow_data()?;
    require!(seat_data.len() >= NONCE_OFFSET + 16, PokerError::InvalidSeatCardsAccount);
    let mut ct_bytes = [0u8; 32];
    ct_bytes.copy_from_slice(&seat_data[ENC1_OFFSET..ENC1_OFFSET + 32]);
    let mut nonce_bytes = [0u8; 16];
    nonce_bytes.copy_from_slice(&seat_data[NONCE_OFFSET..NONCE_OFFSET + 16]);
    let output_nonce = u128::from_le_bytes(nonce_bytes);
    drop(seat_data);

    let args = ArgBuilder::new()
        .x25519_pubkey(pubkey)
        .plaintext_u128(output_nonce)
        .encrypted_u16(ct_bytes)
        .build();

    // Build callback instruction pointing to reveal_player_cards_callback
    let deck_state_key = ctx.accounts.deck_state.key();

    // Anchor discriminator = SHA256("global:reveal_showdown_callback")[0..8]
    // seat_idx is passed via DeckState.showdown_reveal_seats (not in discriminator,
    // because Arcium comp account serialization fails with >8 byte discriminators)
    let callback_disc: Vec<u8> = vec![0xa7, 0xe8, 0xca, 0x3b, 0x69, 0xf3, 0x73, 0xd3];

    // Derive SeatCards PDA for this seat — callback writes plaintext cards here
    // so settle_hand can read them from SeatCards offsets 73-74.
    let (seat_cards_pda, _) = Pubkey::find_program_address(
        &[SEAT_CARDS_SEED, table_key.as_ref(), &[seat_idx]],
        &PROGRAM_ID,
    );

    let cb_accounts = vec![
        CallbackAccount { pubkey: ARCIUM_PROG_ID, is_writable: false },
        CallbackAccount { pubkey: ctx.accounts.comp_def_account.key(), is_writable: false },
        CallbackAccount { pubkey: ctx.accounts.mxe_account.key(), is_writable: false },
        CallbackAccount { pubkey: ctx.accounts.computation_account.key(), is_writable: false },
        CallbackAccount { pubkey: ctx.accounts.cluster_account.key(), is_writable: false },
        CallbackAccount { pubkey: anchor_lang::solana_program::sysvar::instructions::ID, is_writable: false },
        CallbackAccount { pubkey: table_key, is_writable: true },
        CallbackAccount { pubkey: deck_state_key, is_writable: true },
        // SeatCards for this seat — callback writes plaintext card1/card2 here
        CallbackAccount { pubkey: seat_cards_pda, is_writable: true },
    ];

    let callbacks = vec![CallbackInstruction {
        program_id: PROGRAM_ID,
        discriminator: callback_disc,
        accounts: cb_accounts,
    }];

    // CPI to Arcium queue_computation
    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        callbacks,
        1,  // num_callback_txs
        0,  // cu_price_micro
    )?;

    // Record seat_idx in DeckState for the callback to read
    {
        let deck_state = &mut ctx.accounts.deck_state;
        let q = deck_state.showdown_reveals_queued as usize;
        require!(q < 9, PokerError::InvalidSeatNumber);
        deck_state.showdown_reveal_seats[q] = seat_idx;
        deck_state.showdown_reveals_queued += 1;
    }

    // Transition Showdown → AwaitingShowdown on first call; set expected count
    let table = &mut ctx.accounts.table;
    if table.phase == GamePhase::Showdown {
        table.phase = GamePhase::AwaitingShowdown;
        let active_mask = table.seats_occupied & !table.seats_folded;
        let active_count = active_mask.count_ones() as u8;
        let deck_state = &mut ctx.accounts.deck_state;
        deck_state.showdown_reveals_expected = active_count;
        deck_state.showdown_reveals_done = 0;
    }
    table.action_nonce = table.action_nonce.wrapping_add(1);

    // Record crank action for MPC queue payer
    let tkey = table.key();
    let ckey = ctx.accounts.payer.key();
    try_record_crank_action(ctx.remaining_accounts, &tkey, &ckey, table.hand_number);

    msg!(
        "Queued MPC reveal_player_cards: hand #{}, seat={}, offset={}",
        table.hand_number, seat_idx, computation_offset
    );

    Ok(())
}
