use anchor_lang::prelude::*;

pub const CRANK_OPERATOR_SEED: &[u8] = b"crank";

/// Crank mode — controls what types of rewards the operator accepts.
/// Stored on CrankOperator PDA. Crank-service reads this to filter tables.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum CrankMode {
    /// Accept all rewards (rake + tips)
    #[default]
    AcceptAll,
    /// Only accept SOL-denominated tables
    SolOnly,
    /// Only accept tips (no rake cut)
    TipsOnly,
    /// Only accept rake cut (no tips)
    RakeOnly,
    /// Accept only tables with listed (auction-won) tokens
    AcceptListed,
    /// Run for free (community service, no rewards)
    Free,
}

/// Crank operator registration PDA.
/// Lives on L1 only (never delegated). Stores operator identity,
/// CrankMode config, and lifetime stats for the Dealer Dashboard.
///
/// Seeds: ["crank", authority]
#[account]
pub struct CrankOperator {
    /// Operator's wallet address
    pub authority: Pubkey,
    /// Operating mode (controls reward acceptance)
    pub mode: CrankMode,
    /// How often to call process_rake_distribution (in hands, 0 = manual only)
    pub rake_dist_interval: u64,
    /// Lifetime total actions performed
    pub lifetime_actions: u64,
    /// Lifetime SOL earned (tips + rake, in lamports)
    pub lifetime_sol_earned: u64,
    /// Lifetime token rake earned (across all tokens, in base units)
    pub lifetime_token_earned: u64,
    /// Unix timestamp when registered
    pub registered_at: i64,
    /// PDA bump
    pub bump: u8,
}

impl CrankOperator {
    pub const SIZE: usize = 8 +  // discriminator
        32 +                      // authority
        1 +                       // mode (enum, 1 byte)
        8 +                       // rake_dist_interval
        8 +                       // lifetime_actions
        8 +                       // lifetime_sol_earned
        8 +                       // lifetime_token_earned
        8 +                       // registered_at
        1;                        // bump
    // = 8 + 32 + 1 + 8 + 8 + 8 + 8 + 8 + 1 = 82 bytes
}
