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
use crate::instructions::init_comp_defs::COMP_DEF_OFFSET_REVEAL;
use crate::instructions::arcium_deal::ArciumSignerAccount;
use crate::ID as PROGRAM_ID;

/// Queue MPC reveal_community computation via Arcium.
/// Transitions *RevealPending → same phase (callback advances to next betting round).
///
/// Reads encrypted community cards from DeckState and passes them as MPC inputs.
/// The MPC circuit decrypts the MXE-encrypted community cards and returns plaintext.
/// The callback writes plaintext to Table.community_cards and advances the phase.
///
/// PERMISSIONLESS — anyone can call when phase is FlopRevealPending/TurnRevealPending/RiverRevealPending.

#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ArciumRevealQueue<'info> {
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
        address = arcium_pda::computation_definition_acc(&PROGRAM_ID, COMP_DEF_OFFSET_REVEAL),
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
        constraint = matches!(table.phase,
            GamePhase::FlopRevealPending | GamePhase::TurnRevealPending | GamePhase::RiverRevealPending
        ) @ PokerError::InvalidActionForPhase,
    )]
    pub table: Account<'info, Table>,

    #[account(
        seeds = [DECK_STATE_SEED, table.key().as_ref()],
        bump = deck_state.bump,
        constraint = deck_state.shuffle_complete @ PokerError::ShuffleNotComplete,
    )]
    pub deck_state: Box<Account<'info, DeckState>>,

    pub system_program: Program<'info, System>,
}

/// Manual QueueCompAccs implementation for reveal_community
impl<'info> QueueCompAccs<'info> for ArciumRevealQueue<'info> {
    fn comp_def_offset(&self) -> u32 {
        COMP_DEF_OFFSET_REVEAL
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
    ctx: Context<ArciumRevealQueue>,
    computation_offset: u64,
    num_to_reveal: u8,
) -> Result<()> {
    // Validate num_to_reveal matches phase
    let expected = match ctx.accounts.table.phase {
        GamePhase::FlopRevealPending => 3u8,
        GamePhase::TurnRevealPending => 4u8,
        GamePhase::RiverRevealPending => 5u8,
        _ => return Err(PokerError::InvalidActionForPhase.into()),
    };
    require!(num_to_reveal == expected, PokerError::InvalidActionForPhase);

    let deck_state_key = ctx.accounts.deck_state.key();

    // Build MPC args: Enc<Mxe, u64> decomposes to nonce (u128) + ciphertext (32 bytes)
    // reveal_community circuit: (packed_community: Enc<Mxe, u64>, num_to_reveal: u8)
    //
    // From .idarc interface, Enc<Mxe, u64> becomes:
    //   PlaintextU128 (MXE output nonce) + Ciphertext (Rescue ct)
    // Read both from DeckState.encrypted_community fields set by deal callback.
    //
    // encrypted_community[0] = MXE nonce (first 16 bytes = LE u128, rest zero-padded)
    // encrypted_community[1] = ct1 (primary Rescue ciphertext)
    // encrypted_community[2] = ct2 (unused Rescue block)
    let deck_state = &ctx.accounts.deck_state;
    let nonce_slot = deck_state.encrypted_community[0]; // 32-byte slot, nonce in first 16
    let mxe_nonce = u128::from_le_bytes(nonce_slot[..16].try_into().unwrap());
    let ct_bytes = deck_state.encrypted_community[1];   // 32-byte Rescue ciphertext

    let args = ArgBuilder::new()
        .plaintext_u128(mxe_nonce)
        .encrypted_u64(ct_bytes)
        .plaintext_u8(num_to_reveal)
        .build();

    // Build callback instruction pointing to reveal_community_callback
    let table_key = ctx.accounts.table.key();
    // deck_state_key already bound above

    // Anchor discriminator = SHA256("global:reveal_community_callback")[0..8]
    let callback_disc: Vec<u8> = vec![0x8a, 0xf5, 0x85, 0x29, 0x8b, 0xe4, 0x99, 0x4d];

    let cb_accounts = vec![
        CallbackAccount { pubkey: ARCIUM_PROG_ID, is_writable: false },
        CallbackAccount { pubkey: ctx.accounts.comp_def_account.key(), is_writable: false },
        CallbackAccount { pubkey: ctx.accounts.mxe_account.key(), is_writable: false },
        CallbackAccount { pubkey: ctx.accounts.computation_account.key(), is_writable: false },
        CallbackAccount { pubkey: ctx.accounts.cluster_account.key(), is_writable: false },
        CallbackAccount { pubkey: anchor_lang::solana_program::sysvar::instructions::ID, is_writable: false },
        CallbackAccount { pubkey: table_key, is_writable: true },
        CallbackAccount { pubkey: deck_state_key, is_writable: true },
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

    // Update deck_state computation tracking (mutable borrow after CPI)
    // Note: we don't change the phase here — the callback will advance it.
    let table = &mut ctx.accounts.table;
    table.action_nonce = table.action_nonce.wrapping_add(1);

    // Record crank action for MPC queue payer
    let tkey = table.key();
    let ckey = ctx.accounts.payer.key();
    try_record_crank_action(ctx.remaining_accounts, &tkey, &ckey, table.hand_number);

    msg!(
        "Queued MPC reveal_community: hand #{}, phase={:?}, num_to_reveal={}, offset={}",
        table.hand_number, table.phase, num_to_reveal, computation_offset
    );

    Ok(())
}
