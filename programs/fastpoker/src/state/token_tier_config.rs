use anchor_lang::prelude::*;

pub const TIER_CONFIG_SEED: &[u8] = b"tier_config";

/// Number of rake cap tiers (Micro, Low, Mid-Low, Mid, Mid-High, High, Nosebleed)
pub const NUM_TIERS: usize = 7;
/// Number of table types for cap lookup (HU=0, 6-Max=1, 9-Max=2)
pub const NUM_TABLE_TYPES: usize = 3;

/// Per-token tier configuration for rake caps.
/// One PDA per token mint. SOL config is initialized by admin with hardcoded boundaries.
/// Community token configs are created by `resolve_auction` using anchor vote.
///
/// Seeds: ["tier_config", token_mint]
///
/// Tier boundaries are upper bounds (inclusive) for big blind values:
///   boundary[0] = Micro ceiling (BB <= this = Micro)
///   boundary[1] = Low ceiling
///   ...
///   boundary[6] = u64::MAX (everything above = Nosebleed)
///
/// Cap BPS values are in basis points of the big blind (10000 = 1 BB):
///   cap_bps[tier][table_type] where table_type: 0=HU, 1=6-Max, 2=9-Max
///   cap_bps = 0 means NO CAP (used for Micro tier)
#[account]
pub struct TokenTierConfig {
    /// The token mint this config applies to (Pubkey::default() = SOL)
    pub token_mint: Pubkey,
    /// Upper bounds for each tier (7 values, last = u64::MAX)
    pub tier_boundaries: [u64; NUM_TIERS],
    /// Rake cap in basis points of BB, per tier × table type
    /// Layout: [tier_0_hu, tier_0_6max, tier_0_9max, tier_1_hu, ...]
    /// Total: 7 tiers × 3 types = 21 entries
    /// u32 needed: max value 80000 BPS (8 BB) exceeds u16 range
    pub cap_bps: [u32; NUM_TIERS * NUM_TABLE_TYPES],
    /// Minimum big blind allowed for tables using this token
    pub min_bb: u64,
    /// Whether this config is community-governed (from auction anchor vote)
    pub community_governed: bool,
    /// Unix timestamp when created/last updated
    pub updated_at: i64,
    /// Authority who can update (admin for SOL, auction resolver for community tokens)
    pub authority: Pubkey,
    /// PDA bump
    pub bump: u8,
}

impl TokenTierConfig {
    pub const SIZE: usize = 8 +  // discriminator
        32 +                      // token_mint
        (8 * NUM_TIERS) +        // tier_boundaries: 7 × 8 = 56
        (4 * NUM_TIERS * NUM_TABLE_TYPES) + // cap_bps: 21 × 4 = 84
        8 +                       // min_bb
        1 +                       // community_governed
        8 +                       // updated_at
        32 +                      // authority
        1;                        // bump
    // = 8 + 32 + 56 + 84 + 8 + 1 + 8 + 32 + 1 = 230 bytes

    /// Look up the tier index for a given big blind value.
    /// Returns 0..6 (Micro..Nosebleed).
    pub fn tier_for_bb(&self, big_blind: u64) -> usize {
        for i in 0..NUM_TIERS {
            if big_blind <= self.tier_boundaries[i] {
                return i;
            }
        }
        // Should never reach here if boundaries[6] = u64::MAX
        NUM_TIERS - 1
    }

    /// Compute the rake cap in token units for a given big blind and table type.
    /// table_type: 0=HU (2 players), 1=6-Max, 2=9-Max
    /// Returns 0 if no cap (Micro tier or cap_bps == 0).
    pub fn compute_rake_cap(&self, big_blind: u64, table_type: usize) -> u64 {
        let tier = self.tier_for_bb(big_blind);
        let idx = tier * NUM_TABLE_TYPES + table_type.min(NUM_TABLE_TYPES - 1);
        let bps = self.cap_bps[idx] as u64;
        if bps == 0 {
            return 0; // No cap
        }
        // cap = big_blind * bps / 10000
        big_blind.checked_mul(bps)
            .and_then(|v| v.checked_div(10000))
            .unwrap_or(0)
    }

    /// Convert max_players to table_type index (0=HU, 1=6-Max, 2=9-Max)
    pub fn table_type_from_max_players(max_players: u8) -> usize {
        match max_players {
            2 => 0,     // Heads-up
            3..=6 => 1, // 6-Max (and smaller multi-way)
            _ => 2,     // 9-Max (and larger)
        }
    }
}

/// Default SOL tier boundaries (in lamports).
/// These match the plan's tier structure.
pub const SOL_TIER_BOUNDARIES: [u64; NUM_TIERS] = [
    10_000_000,           // Micro: BB ≤ 0.01 SOL
    25_000_000,           // Low: BB ≤ 0.025 SOL
    50_000_000,           // Mid-Low: BB ≤ 0.05 SOL
    100_000_000,          // Mid: BB ≤ 0.1 SOL
    500_000_000,          // Mid-High: BB ≤ 0.5 SOL
    1_000_000_000,        // High: BB ≤ 1 SOL
    u64::MAX,             // Whale: everything above
];

/// Default SOL rake cap BPS table.
/// Layout: [tier][table_type] flattened to [tier*3 + type]
/// Values in basis points of BB (10000 = 1 BB, 0 = no cap).
pub const SOL_CAP_BPS: [u32; NUM_TIERS * NUM_TABLE_TYPES] = [
    // Micro: no cap
    0, 0, 0,
    // Low: 3 BB HU, 5 BB 6max, 8 BB 9max
    30000, 50000, 80000,
    // Mid-Low: 2 BB HU, 4 BB 6max, 6 BB 9max
    20000, 40000, 60000,
    // Mid: 1 BB HU, 2.5 BB 6max, 4 BB 9max
    10000, 25000, 40000,
    // Mid-High: 0.5 BB HU, 1 BB 6max, 1.5 BB 9max
    5000, 10000, 15000,
    // High: 0.25 BB HU, 0.5 BB 6max, 0.75 BB 9max
    2500, 5000, 7500,
    // Nosebleed: 0.09 BB HU, 0.15 BB 6max, 0.20 BB 9max
    900, 1500, 2000,
];
