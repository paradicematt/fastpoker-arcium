use anchor_lang::prelude::*;
use arcium_anchor::{
    init_comp_def, LUT_PROGRAM_ID,
    COMP_DEF_PDA_SEED, MXE_PDA_SEED,
    traits::InitCompDefAccs,
};
use arcium_client::idl::arcium::{
    accounts::MXEAccount,
    program::Arcium,
    types::{Output, Parameter},
    ID_CONST as ARCIUM_PROG_ID,
};

use crate::ID as PROGRAM_ID;

/// Initialize Arcium computation definitions for poker circuits.
///
/// Must be called once after program deploy to register each circuit
/// with the Arcium MXE. After init, call uploadCircuit() from TS SDK
/// to upload the raw circuit bytecode, then finalize.
///
/// Manual InitCompDefAccs implementation since #[arcium_program] macro
/// conflicts with session-keys.

// ── Computation definition offsets (SHA256 of circuit name → u32 LE) ──

pub const COMP_DEF_OFFSET_SHUFFLE:  u32 = arcium_anchor::comp_def_offset("shuffle_and_deal");
pub const COMP_DEF_OFFSET_REVEAL:   u32 = arcium_anchor::comp_def_offset("reveal_community");
pub const COMP_DEF_OFFSET_SHOWDOWN: u32 = arcium_anchor::comp_def_offset("reveal_all_showdown");

// ── Circuit compiled sizes (from `wc -c build/*.arcis`) ──
pub const CIRCUIT_LEN_SHUFFLE:  u32 = 12_752_912;
pub const CIRCUIT_LEN_REVEAL:   u32 = 142_940;
pub const CIRCUIT_LEN_SHOWDOWN: u32 = 683_916;

// ── Circuit weights (from build/*.weight → "weight" field) ──
pub const WEIGHT_SHUFFLE:  u64 = 3_375_930_140;
pub const WEIGHT_REVEAL:   u64 = 160_781_192;
pub const WEIGHT_SHOWDOWN: u64 = 432_875_216;

// ─────────────────────────────────────────────────────────────
// InitShuffleCompDef — registers shuffle_and_deal circuit
// ─────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitShuffleCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        address = arcium_client::pda::mxe_acc(&PROGRAM_ID),
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    /// CHECK: comp_def_account — not initialized yet, validated by Arcium CPI
    #[account(mut)]
    pub comp_def_account: UncheckedAccount<'info>,

    /// CHECK: address_lookup_table — validated by Arcium CPI
    #[account(mut)]
    pub address_lookup_table: UncheckedAccount<'info>,

    /// CHECK: LUT program
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,

    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

impl<'info> InitCompDefAccs<'info> for InitShuffleCompDef<'info> {
    fn arcium_program(&self) -> AccountInfo<'info> { self.arcium_program.to_account_info() }
    fn mxe_program(&self) -> Pubkey { PROGRAM_ID }
    fn signer(&self) -> AccountInfo<'info> { self.payer.to_account_info() }
    fn mxe_acc(&self) -> AccountInfo<'info> { self.mxe_account.to_account_info() }
    fn comp_def_acc(&self) -> AccountInfo<'info> { self.comp_def_account.to_account_info() }
    fn address_lookup_table(&self) -> AccountInfo<'info> { self.address_lookup_table.to_account_info() }
    fn lut_program(&self) -> AccountInfo<'info> { self.lut_program.to_account_info() }
    fn system_program(&self) -> AccountInfo<'info> { self.system_program.to_account_info() }
    fn params(&self) -> Vec<Parameter> {
        // shuffle_and_deal(mxe: Mxe, p0..p8: Shared, num_players: u8)
        // Mxe = struct{u128} (single nonce). Each Shared = struct{x25519_pubkey, u128}.
        vec![
            Parameter::PlaintextU128,       // mxe nonce
            Parameter::ArcisX25519Pubkey,   // p0 pubkey
            Parameter::PlaintextU128,       // p0 nonce
            Parameter::ArcisX25519Pubkey,   // p1 pubkey
            Parameter::PlaintextU128,       // p1 nonce
            Parameter::ArcisX25519Pubkey,   // p2 pubkey
            Parameter::PlaintextU128,       // p2 nonce
            Parameter::ArcisX25519Pubkey,   // p3 pubkey
            Parameter::PlaintextU128,       // p3 nonce
            Parameter::ArcisX25519Pubkey,   // p4 pubkey
            Parameter::PlaintextU128,       // p4 nonce
            Parameter::ArcisX25519Pubkey,   // p5 pubkey
            Parameter::PlaintextU128,       // p5 nonce
            Parameter::ArcisX25519Pubkey,   // p6 pubkey
            Parameter::PlaintextU128,       // p6 nonce
            Parameter::ArcisX25519Pubkey,   // p7 pubkey
            Parameter::PlaintextU128,       // p7 nonce
            Parameter::ArcisX25519Pubkey,   // p8 pubkey
            Parameter::PlaintextU128,       // p8 nonce
            Parameter::PlaintextU8,         // num_players
        ]
    }
    fn outputs(&self) -> Vec<Output> {
        // 11 encrypted values: 1 Enc<Mxe,u64> community + 1 Enc<Mxe,u128> packed holes + 9 Enc<Shared,u16>.
        // MPC sends 11 × 32 = 352 bytes. Stride-3 layout:
        //   Mxe community (slots 0-2) + Mxe packed_holes (slots 3-5) + P0 Shared (slots 6-8)
        //   + P1 nonce+ct1 (slots 9-10). All 9 players' cards in MXE pack for showdown.
        vec![Output::Ciphertext; 11]
    }
    fn comp_def_offset(&self) -> u32 { COMP_DEF_OFFSET_SHUFFLE }
    fn compiled_circuit_len(&self) -> u32 { CIRCUIT_LEN_SHUFFLE }
    fn weight(&self) -> u64 { WEIGHT_SHUFFLE }
}

pub fn init_shuffle_handler(ctx: Context<InitShuffleCompDef>) -> Result<()> {
    init_comp_def(ctx.accounts, None, None)?;
    msg!("Initialized shuffle_and_deal comp def (offset={})", COMP_DEF_OFFSET_SHUFFLE);
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// InitRevealCompDef — registers reveal_community circuit
// ─────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitRevealCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        address = arcium_client::pda::mxe_acc(&PROGRAM_ID),
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    /// CHECK: comp_def_account
    #[account(mut)]
    pub comp_def_account: UncheckedAccount<'info>,

    /// CHECK: address_lookup_table
    #[account(mut)]
    pub address_lookup_table: UncheckedAccount<'info>,

    /// CHECK: LUT program
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,

    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

impl<'info> InitCompDefAccs<'info> for InitRevealCompDef<'info> {
    fn arcium_program(&self) -> AccountInfo<'info> { self.arcium_program.to_account_info() }
    fn mxe_program(&self) -> Pubkey { PROGRAM_ID }
    fn signer(&self) -> AccountInfo<'info> { self.payer.to_account_info() }
    fn mxe_acc(&self) -> AccountInfo<'info> { self.mxe_account.to_account_info() }
    fn comp_def_acc(&self) -> AccountInfo<'info> { self.comp_def_account.to_account_info() }
    fn address_lookup_table(&self) -> AccountInfo<'info> { self.address_lookup_table.to_account_info() }
    fn lut_program(&self) -> AccountInfo<'info> { self.lut_program.to_account_info() }
    fn system_program(&self) -> AccountInfo<'info> { self.system_program.to_account_info() }
    fn params(&self) -> Vec<Parameter> {
        // reveal_community(packed_community: Enc<Mxe,u64>, num_to_reveal: u8)
        // Enc<Mxe, u64> decomposes to: nonce (u128) + ciphertext (from .idarc interface)
        vec![
            Parameter::PlaintextU128, // packed_community nonce (MXE output nonce)
            Parameter::Ciphertext,    // packed_community ciphertext (Rescue ct)
            Parameter::PlaintextU8,   // num_to_reveal
        ]
    }
    fn outputs(&self) -> Vec<Output> {
        // 5 plaintext u8 card values
        vec![Output::PlaintextU8; 5]
    }
    fn comp_def_offset(&self) -> u32 { COMP_DEF_OFFSET_REVEAL }
    fn compiled_circuit_len(&self) -> u32 { CIRCUIT_LEN_REVEAL }
    fn weight(&self) -> u64 { WEIGHT_REVEAL }
}

pub fn init_reveal_handler(ctx: Context<InitRevealCompDef>) -> Result<()> {
    init_comp_def(ctx.accounts, None, None)?;
    msg!("Initialized reveal_community comp def (offset={})", COMP_DEF_OFFSET_REVEAL);
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// InitShowdownCompDef — registers reveal_showdown circuit
// ─────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitShowdownCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        address = arcium_client::pda::mxe_acc(&PROGRAM_ID),
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    /// CHECK: comp_def_account
    #[account(mut)]
    pub comp_def_account: UncheckedAccount<'info>,

    /// CHECK: address_lookup_table
    #[account(mut)]
    pub address_lookup_table: UncheckedAccount<'info>,

    /// CHECK: LUT program
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,

    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

impl<'info> InitCompDefAccs<'info> for InitShowdownCompDef<'info> {
    fn arcium_program(&self) -> AccountInfo<'info> { self.arcium_program.to_account_info() }
    fn mxe_program(&self) -> Pubkey { PROGRAM_ID }
    fn signer(&self) -> AccountInfo<'info> { self.payer.to_account_info() }
    fn mxe_acc(&self) -> AccountInfo<'info> { self.mxe_account.to_account_info() }
    fn comp_def_acc(&self) -> AccountInfo<'info> { self.comp_def_account.to_account_info() }
    fn address_lookup_table(&self) -> AccountInfo<'info> { self.address_lookup_table.to_account_info() }
    fn lut_program(&self) -> AccountInfo<'info> { self.lut_program.to_account_info() }
    fn system_program(&self) -> AccountInfo<'info> { self.system_program.to_account_info() }
    fn params(&self) -> Vec<Parameter> {
        // reveal_all_showdown(packed_holes: Enc<Mxe, u128>, active_mask: u16)
        // Enc<Mxe, u128> decomposes to: PlaintextU128 (nonce) + Ciphertext (ct)
        vec![
            Parameter::PlaintextU128, // MXE nonce for packed_holes
            Parameter::Ciphertext,    // packed_holes ciphertext (Rescue ct)
            Parameter::PlaintextU16,  // active_mask bitmask
        ]
    }
    fn outputs(&self) -> Vec<Output> {
        // 9 plaintext u16 packed card values (card1*256+card2 per player)
        vec![Output::PlaintextU16; 9]
    }
    fn comp_def_offset(&self) -> u32 { COMP_DEF_OFFSET_SHOWDOWN }
    fn compiled_circuit_len(&self) -> u32 { CIRCUIT_LEN_SHOWDOWN }
    fn weight(&self) -> u64 { WEIGHT_SHOWDOWN }
}

pub fn init_showdown_handler(ctx: Context<InitShowdownCompDef>) -> Result<()> {
    init_comp_def(ctx.accounts, None, None)?;
    msg!("Initialized reveal_showdown comp def (offset={})", COMP_DEF_OFFSET_SHOWDOWN);
    Ok(())
}
