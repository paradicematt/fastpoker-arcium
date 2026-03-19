use anchor_lang::prelude::*;

/// Per-token rake vault that accumulates distributed rake for staker claims.
/// One vault per token mint. Stakers claim their share based on stake weight.
#[account]
pub struct RakeVault {
    /// Token mint this vault holds rake for
    pub token_mint: Pubkey,
    /// Total rake deposited into this vault (lifetime)
    pub total_deposited: u64,
    /// Total rake claimed by stakers (lifetime)
    pub total_claimed: u64,
    /// Current epoch (incremented each distribution cycle)
    pub current_epoch: u64,
    /// Timestamp of last deposit
    pub last_deposit_time: i64,
    /// Token account holding the vault's tokens
    pub vault_token_account: Pubkey,
    /// PDA bump
    pub bump: u8,
}

impl RakeVault {
    pub const SIZE: usize = 8 + // discriminator
        32 + // token_mint
        8 +  // total_deposited
        8 +  // total_claimed
        8 +  // current_epoch
        8 +  // last_deposit_time
        32 + // vault_token_account
        1;   // bump
}

pub const RAKE_VAULT_SEED: &[u8] = b"rake_vault";

/// Tracks a staker's claim progress within a RakeVault.
/// Prevents double-claiming by recording last claimed epoch.
#[account]
pub struct StakerClaim {
    /// The rake vault this claim is for
    pub rake_vault: Pubkey,
    /// Staker's wallet
    pub staker: Pubkey,
    /// Last epoch the staker claimed through
    pub last_claimed_epoch: u64,
    /// Total amount claimed (lifetime)
    pub total_claimed: u64,
    /// PDA bump
    pub bump: u8,
}

impl StakerClaim {
    pub const SIZE: usize = 8 + // discriminator
        32 + // rake_vault
        32 + // staker
        8 +  // last_claimed_epoch
        8 +  // total_claimed
        1;   // bump
}

pub const STAKER_CLAIM_SEED: &[u8] = b"staker_claim";
