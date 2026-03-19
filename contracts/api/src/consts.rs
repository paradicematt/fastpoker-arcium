/// Seed for the staking pool PDA
pub const POOL: &[u8] = b"pool";

/// Seed for stake account PDA
pub const STAKE: &[u8] = b"stake";

/// Seed for rewards account PDA  
pub const REWARDS: &[u8] = b"rewards";

/// Seed for unrefined rewards PDA
pub const UNREFINED: &[u8] = b"unrefined";

/// Seed for epoch account PDA
pub const EPOCH: &[u8] = b"epoch";

/// Seed for player account PDA
pub const PLAYER: &[u8] = b"player";

/// Registration cost in lamports (free — rent-only PDA creation)
pub const REGISTRATION_COST: u64 = 0;

/// Free entries granted on registration (decoupled — admin grants separately)
pub const FREE_ENTRIES_ON_REGISTER: u8 = 0;

/// Claim tax rate (10% = 1000 basis points)
pub const CLAIM_TAX_BPS: u64 = 1000;

/// Basis points denominator
pub const BPS_DENOMINATOR: u64 = 10000;

/// Scale factor from unrefined (6 decimals) to SPL token (9 decimals)
pub const UNREFINED_TO_SPL_SCALE: u64 = 1_000;

/// Stakers revenue share (50% = 5000 basis points)
pub const STAKER_SHARE_BPS: u64 = 5000;

/// Seconds per day for epoch calculations
pub const SECONDS_PER_DAY: i64 = 86400;

/// Authorized FastPoker program ID (can CPI credit_unrefined_from_program)
/// BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N (Poker-Arc deployment)
pub const FASTPOKER_PROGRAM_ID: [u8; 32] = [
    152, 172, 72, 46, 138, 149, 36, 78, 78, 142, 164, 12, 204, 142, 1, 225,
    171, 106, 62, 146, 181, 222, 19, 20, 179, 96, 97, 133, 73, 213, 7, 141
];

/// Seed for prize authority PDA (derived from FASTPOKER_PROGRAM_ID)
pub const PRIZE_AUTHORITY_SEED: &[u8] = b"prize_authority";
