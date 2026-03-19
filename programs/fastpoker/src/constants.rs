use anchor_lang::prelude::*;

// PDA Seeds
pub const TABLE_SEED: &[u8] = b"table";
pub const SEAT_SEED: &[u8] = b"seat";
pub const SESSION_SEED: &[u8] = b"session";
pub const TABLE_AUTHORITY_SEED: &[u8] = b"table_authority";

// Program deployer / super-admin key: GkfdM1vqRYrU2LJ4ipwCJ3vsr2PGYLpdtdKK121ZkQZg
pub const SUPER_ADMIN: [u8; 32] = [
    0xea, 0x0e, 0xf4, 0x37, 0x22, 0x4d, 0x04, 0xe8,
    0x81, 0xdd, 0x10, 0xfd, 0x84, 0xb2, 0x4e, 0xa7,
    0x2b, 0x88, 0xa5, 0x0d, 0x17, 0x8b, 0xfe, 0x62,
    0xd4, 0x1b, 0x2d, 0xd7, 0xf5, 0x0a, 0xd0, 0x9b,
];


// Seat Cards PDA seed
pub const SEAT_CARDS_SEED: &[u8] = b"seat_cards";
pub const GAME_STATE_SEED: &[u8] = b"game_state";

// Steel Tokenomics Program: 9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6
pub const STEEL_PROGRAM_BYTES: [u8; 32] = [
    131, 59, 174, 107, 204, 5, 73, 207, 19, 245, 160, 124, 23, 228, 155, 1,
    161, 180, 152, 68, 12, 254, 111, 19, 76, 139, 249, 200, 5, 89, 136, 43
];

/// Steel Tokenomics Program ID (const for use in account constraints)
pub const STEEL_PROGRAM_ID: Pubkey = Pubkey::new_from_array(STEEL_PROGRAM_BYTES);

// POKER Token Mint: DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX
pub const POKER_MINT_BYTES: [u8; 32] = [
    188, 224, 126, 82, 182, 60, 14, 88, 251, 52, 180, 99, 190, 228, 208, 91,
    1, 229, 160, 137, 97, 226, 223, 199, 202, 128, 237, 62, 233, 48, 198, 128
];
pub const POKER_MINT: Pubkey = Pubkey::new_from_array(POKER_MINT_BYTES);

/// Check if a token mint is a "premium" token (no auction required)
/// Premium tokens: SOL (Pubkey::default), POKER, USDC
/// Future: auction-listed tokens will be checked against TokenBid PDA
pub fn is_premium_token(mint: &Pubkey) -> bool {
    *mint == Pubkey::default() // SOL
        || *mint == POKER_MINT
        // USDC can be added here later
}

/// Get the Steel Tokenomics Program ID
pub fn steel_program_id() -> Pubkey {
    Pubkey::new_from_array(STEEL_PROGRAM_BYTES)
}


// Game Constants
pub const MAX_PLAYERS: u8 = 9;
pub const TIMEOUT_SLOTS: u64 = 37; // ~15 seconds at 400ms/slot (was 75 for 30s)
pub const TIMEOUT_SLOTS_TESTING: u64 = 10; // ~4 seconds for testing
pub const TIMEOUT_SECONDS: u64 = 15; // On-chain minimum delay for handle_timeout (unix_timestamp)

// Time Bank (Phase 3)
/// Maximum time bank in seconds (starts full on first sit-down)
pub const TIME_BANK_MAX_SECONDS: u16 = 60;
/// Time bank chunk size in seconds (each use_time_bank call adds this much)
pub const TIME_BANK_CHUNK_SECONDS: u16 = 15;
/// Time bank regen per hand played (5 seconds per hand, capped at max)
pub const TIME_BANK_REGEN_SECONDS: u16 = 5;

pub const RAKE_BPS: u64 = 500; // 5% rake

// Cash Game Removal Thresholds
pub const MISSED_BB_REMOVAL_COUNT: u8 = 3; // Remove player after missing 3 BBs
pub const AUTO_FOLD_SIT_OUT_COUNT: u8 = 3; // Sit out after 3 auto-folds

// Blinds Configuration (in lamports/tokens)
pub const MICRO_STAKES_SB: u64 = 1_000;
pub const MICRO_STAKES_BB: u64 = 2_000;
pub const LOW_STAKES_SB: u64 = 5_000;
pub const LOW_STAKES_BB: u64 = 10_000;
pub const MID_STAKES_SB: u64 = 25_000;
pub const MID_STAKES_BB: u64 = 50_000;
pub const HIGH_STAKES_SB: u64 = 100_000;
pub const HIGH_STAKES_BB: u64 = 200_000;

// Sit & Go Entry Fees (SOL lamports) — LEGACY, use SnGTier instead
pub const SNG_HEADS_UP_ENTRY: u64 = 10_000_000; // 0.01 SOL
pub const SNG_6MAX_ENTRY: u64 = 10_000_000; // 0.01 SOL
pub const SNG_9MAX_ENTRY: u64 = 10_000_000; // 0.01 SOL

// ============================================================
// TIERED SIT & GO BUY-INS
// ============================================================
// Devnet: divide all amounts by TIER_SCALE (10x cheaper for testing)
// Mainnet: set TIER_SCALE = 1
pub const TIER_SCALE: u64 = 10;

/// Sit & Go tier — determines buy-in amount and prize pool
/// 25% of total buy-in is fee (→ Steel for treasury/staker split)
/// 75% of total buy-in is entry (→ prize pool for winners)
/// Micro is special: 100% fee, zero prize pool, POKER-only rewards
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default,
)]
pub enum SnGTier {
    #[default]
    Micro,     // 0.10 SOL mainnet / 0.01 SOL devnet — POKER only, no SOL prizes
    Bronze,    // 0.25 SOL mainnet / 0.025 SOL devnet
    Silver,    // 0.50 SOL mainnet / 0.05 SOL devnet
    Gold,      // 1.00 SOL mainnet / 0.10 SOL devnet
    Platinum,  // 2.00 SOL mainnet / 0.20 SOL devnet
    Diamond,   // 5.00 SOL mainnet / 0.50 SOL devnet
}

impl SnGTier {
    /// Entry amount in lamports (goes to prize pool)
    pub fn entry_amount(&self) -> u64 {
        match self {
            SnGTier::Micro    => 0,
            SnGTier::Bronze   => 187_500_000 / TIER_SCALE,  // 0.1875 SOL
            SnGTier::Silver   => 375_000_000 / TIER_SCALE,  // 0.375 SOL
            SnGTier::Gold     => 750_000_000 / TIER_SCALE,  // 0.75 SOL
            SnGTier::Platinum => 1_500_000_000 / TIER_SCALE, // 1.50 SOL
            SnGTier::Diamond  => 3_750_000_000 / TIER_SCALE, // 3.75 SOL
        }
    }

    /// Fee amount in lamports (goes to treasury/stakers via Steel)
    pub fn fee_amount(&self) -> u64 {
        match self {
            SnGTier::Micro    => 100_000_000 / TIER_SCALE,   // 0.10 SOL (entire buy-in is fee)
            SnGTier::Bronze   => 62_500_000 / TIER_SCALE,    // 0.0625 SOL
            SnGTier::Silver   => 125_000_000 / TIER_SCALE,   // 0.125 SOL
            SnGTier::Gold     => 250_000_000 / TIER_SCALE,   // 0.25 SOL
            SnGTier::Platinum => 500_000_000 / TIER_SCALE,   // 0.50 SOL
            SnGTier::Diamond  => 1_250_000_000 / TIER_SCALE, // 1.25 SOL
        }
    }

    /// Total buy-in (entry + fee)
    pub fn total_buy_in(&self) -> u64 {
        self.entry_amount() + self.fee_amount()
    }
}

// Registration
pub const REGISTRATION_COST: u64 = 0; // Free registration (rent-only)
pub const FREE_ENTRIES_ON_REGISTER: u8 = 0; // Decoupled — admin grants free entries separately

// Treasury: 4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3
pub const TREASURY_BYTES: [u8; 32] = [
    48, 144, 161, 150, 179, 147, 117, 152, 218, 107, 10, 6, 4, 13, 102, 215,
    104, 43, 81, 62, 169, 142, 160, 208, 195, 174, 13, 161, 43, 19, 11, 242
];

/// Get the Treasury Pubkey
pub const TREASURY: Pubkey = Pubkey::new_from_array(TREASURY_BYTES);

// Card constants
pub const CARD_NOT_DEALT: u8 = 255;
pub const DECK_SIZE: usize = 52;

// Rake Configuration (Cash Games)
/// Rake percentage (5% = 500 basis points)
pub const RAKE_PERCENT_BPS: u64 = 500; // 5%
/// Rake cap in tokens (0 = no cap)
pub const RAKE_CAP: u64 = 0; // No cap for now
/// Minimum pot for rake (no rake on tiny pots)
pub const RAKE_MIN_POT: u64 = 0;

// ============================================================
// RAKE DISTRIBUTION (Cash Games)
// ============================================================
// System tables: 5% treasury, 50% stakers, 45% dealers
pub const RAKE_STAKERS_BPS: u64 = 5000; // 50%
pub const RAKE_TREASURY_BPS: u64 = 500;  // 5%
pub const RAKE_DEALER_SYSTEM_BPS: u64 = 4500; // 45%

// User-created tables: 50% creator, 5% treasury, 25% stakers, 25% dealers
pub const RAKE_CREATOR_BPS: u64 = 5000;              // 50%
pub const RAKE_TREASURY_USER_TABLE_BPS: u64 = 500;   // 5%
pub const RAKE_STAKERS_USER_TABLE_BPS: u64 = 2500;   // 25%
pub const RAKE_DEALER_BPS: u64 = 2500;               // 25%

// ============================================================
// SNG FEE DISTRIBUTION
// ============================================================
// 10% treasury, 45% stakers, 45% dealers
pub const SNG_TREASURY_BPS: u64 = 1000;  // 10%
pub const SNG_STAKERS_BPS: u64 = 4500;   // 45%
pub const SNG_DEALER_BPS: u64 = 4500;    // 45%

// Auto-fold sit-out threshold
pub const AUTO_FOLD_SIT_OUT_THRESHOLD: u8 = 3;

// Sit & Go Blind Structure (5 minute levels)
// Using unix_timestamp (seconds) instead of slots — ER slots don't map to wall-clock time
pub const SNG_BLIND_INTERVAL_SECONDS: u64 = 300; // 5 minutes
pub const SNG_STARTING_CHIPS: u64 = 1500;

// Sit & Go Blind Levels (SB/BB pairs)
pub const SNG_BLIND_LEVELS: [(u64, u64); 20] = [
    (10, 20),      // Level 1
    (15, 30),      // Level 2
    (25, 50),      // Level 3
    (50, 100),     // Level 4
    (75, 150),     // Level 5
    (100, 200),    // Level 6
    (150, 300),    // Level 7
    (200, 400),    // Level 8
    (300, 600),    // Level 9
    (500, 1000),   // Level 10
    (750, 1500),   // Level 11 — BB = entire starting stack
    (1000, 2000),  // Level 12
    (1250, 2500),  // Level 13
    (1500, 3000),  // Level 14
    (2000, 4000),  // Level 15
    (2500, 5000),  // Level 16
    (3000, 6000),  // Level 17
    (4000, 8000),  // Level 18
    (5000, 10000), // Level 19
    (7000, 14000), // Level 20 — hard cap to force finish
];

// ============================================================
// CASH GAME CONSTANTS ($POKER token blinds)
// ============================================================
// POKER token has 9 decimals, so 1 POKER = 1_000_000_000
pub const POKER_DECIMALS: u64 = 1_000_000_000;

// Cash Game Blind Levels (in POKER token base units, 9 decimals)
// Format: (SB, BB, creation_fee_lamports)
pub const CASH_BLIND_LEVELS: [(u64, u64, u64); 8] = [
    (500_000_000, 1_000_000_000, 100_000_000),          // 0.5/1 POKER  - 0.1 SOL to create
    (1_000_000_000, 2_000_000_000, 150_000_000),        // 1/2 POKER    - 0.15 SOL
    (2_500_000_000, 5_000_000_000, 200_000_000),        // 2.5/5 POKER  - 0.2 SOL
    (5_000_000_000, 10_000_000_000, 300_000_000),       // 5/10 POKER   - 0.3 SOL
    (10_000_000_000, 20_000_000_000, 500_000_000),      // 10/20 POKER  - 0.5 SOL
    (25_000_000_000, 50_000_000_000, 750_000_000),      // 25/50 POKER  - 0.75 SOL
    (50_000_000_000, 100_000_000_000, 1_000_000_000),   // 50/100 POKER - 1 SOL
    (100_000_000_000, 200_000_000_000, 2_000_000_000),  // 100/200 POKER - 2 SOL
];

// Minimum creation fee (for custom blinds not in preset list)
pub const MIN_TABLE_CREATION_FEE: u64 = 100_000_000; // 0.1 SOL

// Cash game buy-in limits (multiplier of BB)
pub const CASH_MIN_BUY_IN_BB: u64 = 20;   // 20 big blinds minimum
pub const CASH_MAX_BUY_IN_BB: u64 = 100;  // 100 big blinds maximum

// Unclaimed balance grace period (hands before seat can be force-released)
pub const UNCLAIMED_GRACE_HANDS: u64 = 50;

// Unclaimed balance PDA seed
pub const UNCLAIMED_SEED: &[u8] = b"unclaimed";

// Vault-based cash game PDA seeds
pub const VAULT_SEED: &[u8] = b"vault";
pub const RECEIPT_SEED: &[u8] = b"receipt";
pub const DECK_STATE_SEED: &[u8] = b"deck_state";

// ============================================================
// DEALER LICENSE BONDING CURVE
// ============================================================
// price = BASE_PRICE + total_sold * INCREMENT, capped at MAX_PRICE
pub const DEALER_LICENSE_BASE_PRICE: u64 = 1_000_000;     // 0.001 SOL
pub const DEALER_LICENSE_INCREMENT: u64 = 1_000_000;       // 0.001 SOL per license sold
pub const DEALER_LICENSE_MAX_PRICE: u64 = 9_900_000_000;   // 9.9 SOL cap
// Purchase split: 50% treasury, 50% staker pool
pub const DEALER_LICENSE_TREASURY_BPS: u64 = 5000; // 50%
pub const DEALER_LICENSE_STAKER_BPS: u64 = 5000;   // 50%

/// Calculate table creation fee based on big blind amount
/// Higher stakes = higher creation fee
pub fn calculate_creation_fee(big_blind: u64) -> u64 {
    // Check preset levels first
    for (_, bb, fee) in CASH_BLIND_LEVELS.iter() {
        if big_blind == *bb {
            return *fee;
        }
    }
    
    // Custom blinds: fee = 0.1 SOL + (BB / 1_000_000) * 0.01 SOL
    // This scales with stake level
    let base_fee = MIN_TABLE_CREATION_FEE;
    let scaled_fee = (big_blind / POKER_DECIMALS) * 10_000_000; // 0.01 SOL per POKER BB
    base_fee.saturating_add(scaled_fee)
}

/// Prize payout structure (percentages in basis points, 10000 = 100%)
/// Moved from tournament.rs during dead code cleanup.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PayoutStructure {
    pub payouts: Vec<u16>,
}

impl PayoutStructure {
    /// Heads-up: Winner takes all
    pub fn heads_up() -> Self {
        Self { payouts: vec![10000] }
    }
    /// 6-max: Top 2 paid (65% / 35%)
    pub fn six_max() -> Self {
        Self { payouts: vec![6500, 3500] }
    }
    /// 9-max: Top 3 paid (50% / 30% / 20%)
    pub fn nine_max() -> Self {
        Self { payouts: vec![5000, 3000, 2000] }
    }
    /// Calculate payout for a finishing position
    pub fn get_payout(&self, position: usize, prize_pool: u64) -> u64 {
        if position >= self.payouts.len() { return 0; }
        (prize_pool * self.payouts[position] as u64) / 10000
    }
}
