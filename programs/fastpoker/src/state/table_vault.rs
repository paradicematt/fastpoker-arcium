use anchor_lang::prelude::*;

/// Vault PDA that holds all player SOL/tokens for a cash game table.
/// NEVER delegated — stays on L1 permanently.
/// Seeds: ["vault", table_pda.as_ref()]
#[account]
pub struct TableVault {
    /// The table this vault belongs to
    pub table: Pubkey,
    /// Cumulative SOL/tokens deposited (buy-ins + reserves, for reconciliation)
    pub total_deposited: u64,
    /// Cumulative SOL/tokens withdrawn (cashouts)
    pub total_withdrawn: u64,
    /// PDA bump
    pub bump: u8,
    /// Monotonically increasing nonce — prevents double rake distribution.
    /// Caller must pass current nonce; instruction bumps it after success.
    /// Appended AFTER bump for backward compat (old 57-byte vaults keep bump at same offset).
    pub rake_nonce: u64,
    /// Cumulative rake distributed on L1 (contract-level check).
    /// Instruction computes delta = er_cumulative_rake - total_rake_distributed.
    /// Prevents over-distribution even if ER clear step fails or is delayed.
    pub total_rake_distributed: u64,
    /// Token mint for this table's denomination.
    /// Pubkey::default() = SOL table, otherwise SPL token mint.
    /// Source of truth on L1 — the table PDA is delegation-owned and unreadable.
    pub token_mint: Pubkey,
    /// Cumulative crank pool distributed on L1.
    /// Delta = table.crank_pool_accumulated (from commit_state) - total_crank_distributed.
    /// Prevents double-claim of crank rewards across ER/L1 boundary.
    pub total_crank_distributed: u64,
}

impl TableVault {
    pub const SIZE: usize = 8 + // discriminator
        32 + // table
        8 +  // total_deposited
        8 +  // total_withdrawn
        1 +  // bump
        8 +  // rake_nonce
        8 +  // total_rake_distributed
        32 + // token_mint
        8;   // total_crank_distributed
    // = 113 bytes
}

// VAULT_SEED is defined in constants.rs
