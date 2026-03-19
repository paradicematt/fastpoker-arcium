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

/// Queue MPC reveal_all_showdown computation via Arcium.
/// Single call reveals ALL active players' hole cards at once using the
/// MXE-packed u128 stored in DeckState by the shuffle_and_deal callback.
///
/// Transitions Showdown → AwaitingShowdown. The callback writes all players'
/// revealed hands to Table.revealed_hands and transitions back to Showdown.
///
/// PERMISSIONLESS — anyone can call when phase is Showdown.

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
        constraint = table.phase == GamePhase::Showdown @ PokerError::InvalidActionForPhase,
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
) -> Result<()> {
    let table = &ctx.accounts.table;
    let deck_state = &ctx.accounts.deck_state;
    let table_key = table.key();

    // Only allow from Showdown phase (single call, not per-player)
    require!(table.phase == GamePhase::Showdown, PokerError::InvalidActionForPhase);

    // Build MPC args for reveal_all_showdown circuit:
    // reveal_all_showdown(packed_holes: Enc<Mxe, Pack<[u8;18]>>, active_mask: u16)
    //
    // Args in ArgBuilder order (1 × Enc<Mxe> pattern):
    //   .plaintext_u128(nonce) + .encrypted_u128(ct)  — from DeckState[9..10]
    //   .plaintext_u16(active_mask)
    let nonce_slot = deck_state.encrypted_hole_cards[9];
    let mxe_nonce = u128::from_le_bytes(nonce_slot[..16].try_into().unwrap());
    let mxe_ct = deck_state.encrypted_hole_cards[10];

    let active_mask = table.seats_occupied & !table.seats_folded;

    let args = ArgBuilder::new()
        .plaintext_u128(mxe_nonce)
        .encrypted_u128(mxe_ct)  // Pack<[u8;18]> = 1 field element, same as any 32-byte ct
        .plaintext_u16(active_mask)
        .build();

    // Build callback instruction pointing to reveal_showdown_callback
    let deck_state_key = deck_state.key();

    // Anchor discriminator = SHA256("global:reveal_showdown_callback")[0..8]
    let callback_disc: Vec<u8> = vec![0xa7, 0xe8, 0xca, 0x3b, 0x69, 0xf3, 0x73, 0xd3];

    // Callback accounts — no per-player SeatCards needed, all data goes to Table.revealed_hands
    let mut cb_accounts = vec![
        CallbackAccount { pubkey: ARCIUM_PROG_ID, is_writable: false },
        CallbackAccount { pubkey: ctx.accounts.comp_def_account.key(), is_writable: false },
        CallbackAccount { pubkey: ctx.accounts.mxe_account.key(), is_writable: false },
        CallbackAccount { pubkey: ctx.accounts.computation_account.key(), is_writable: false },
        CallbackAccount { pubkey: ctx.accounts.cluster_account.key(), is_writable: false },
        CallbackAccount { pubkey: anchor_lang::solana_program::sysvar::instructions::ID, is_writable: false },
        CallbackAccount { pubkey: table_key, is_writable: true },
        CallbackAccount { pubkey: deck_state_key, is_writable: true },
    ];

    // Add SeatCards PDAs for all occupied seats — callback writes plaintext cards to them
    // so settle_hand can read them from SeatCards offsets 73-74.
    for i in 0..table.max_players {
        if table.seats_occupied & (1 << i) != 0 {
            let (seat_cards_pda, _) = Pubkey::find_program_address(
                &[SEAT_CARDS_SEED, table_key.as_ref(), &[i]],
                &PROGRAM_ID,
            );
            cb_accounts.push(CallbackAccount { pubkey: seat_cards_pda, is_writable: true });
        }
    }

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

    // Transition Showdown → AwaitingShowdown
    let table = &mut ctx.accounts.table;
    table.phase = GamePhase::AwaitingShowdown;
    table.action_nonce = table.action_nonce.wrapping_add(1);

    // Record crank action for MPC queue payer
    let tkey = table.key();
    let ckey = ctx.accounts.payer.key();
    try_record_crank_action(ctx.remaining_accounts, &tkey, &ckey, table.hand_number);

    msg!(
        "Queued MPC reveal_all_showdown: hand #{}, active_mask={:#06x}, offset={}",
        table.hand_number, active_mask, computation_offset
    );

    Ok(())
}
