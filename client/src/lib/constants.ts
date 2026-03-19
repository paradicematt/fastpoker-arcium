import { PublicKey } from '@solana/web3.js';

// RPC Endpoints — Arcium L1 only (no TEE/ER)
export const L1_RPC = process.env.NEXT_PUBLIC_RPC_URL || 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
export const L1_RPC_DIRECT = L1_RPC;

// Program IDs — Arcium architecture
export const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
export const ANCHOR_PROGRAM_ID = PROGRAM_ID; // alias for backward compat
export const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');

// Crank service pubkey — included in seatCards permissions so crank can reference
// seatCards in TEE transactions (start_game, tee_deal, settle) without 403.
export const CRANK_PUBKEY = new PublicKey('EgNQUJgmhCzzm5pB9J8osKBXsdK86MjzLmyNKzsNteLz');

// Token & Pool
export const POKER_MINT = new PublicKey(process.env.NEXT_PUBLIC_POKER_MINT || 'DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
export const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
export const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// PDA Seeds
export const TABLE_SEED = 'table';
export const SEAT_SEED = 'seat';
export const SEAT_CARDS_SEED = 'seat_cards';
export const PLAYER_SEED = 'player';
export const SESSION_SEED = 'session';
export const STAKE_SEED = 'stake';
export const VAULT_SEED = 'vault';
export const RECEIPT_SEED = 'receipt';
export const DEPOSIT_PROOF_SEED = 'deposit_proof';
export const DECK_STATE_SEED = 'deck_state';
export const CRANK_TALLY_ER_SEED = 'crank_tally_er';
export const CRANK_TALLY_L1_SEED = 'crank_tally_l1';

// Dealer License System
export const DEALER_REGISTRY_SEED = 'dealer_registry';
export const DEALER_LICENSE_SEED = 'dealer_license';
export const DEALER_LICENSE_BASE_PRICE = 1_000_000;       // 0.001 SOL
export const DEALER_LICENSE_INCREMENT = 1_000_000;        // 0.001 SOL per license
export const DEALER_LICENSE_MAX_PRICE = 9_901_000_000;    // ~9.9 SOL cap (at license #9900)

// Data Offsets for reading SeatCards accounts
// Layout: disc(8) + table(32) + seat_index(1) + player(32) + card1(1) + card2(1) + bump(1)
//         + enc_card1(32) + enc_card2(32) + nonce(16)
// Total = 156 bytes (8 disc + 148 data)
export const SEAT_CARDS_OFFSETS = {
  DISCRIMINATOR: 0,
  TABLE: 8,
  SEAT_INDEX: 40,
  PLAYER: 41,
  CARD1: 73,            // plaintext card1 (written at showdown reveal, 255 during play)
  CARD2: 74,            // plaintext card2 (written at showdown reveal, 255 during play)
  BUMP: 75,
  ENC_CARD1: 76,        // 32 bytes — Rescue ciphertext (packed u16: card1*256+card2)
  ENC_CARD2: 108,       // 32 bytes — raw nonce slot (diagnostic, not used for decryption)
  NONCE: 140,           // 16 bytes — decryption nonce (output_nonce from MPC)
};

// Data Offsets for reading PlayerSeat accounts (relevant for x25519)
// Layout: disc(8) + wallet(32) + session_key(32) + table(32) + chips(8) + bet_this_round(8)
//         + total_bet_this_hand(8) + hole_cards_encrypted(64) + hole_cards_commitment(32) + ...
export const PLAYER_SEAT_OFFSETS = {
  WALLET: 8,
  SESSION_KEY: 40,
  TABLE: 72,
  CHIPS: 104,
  X25519_PUBKEY: 192,   // 32 bytes — repurposed hole_cards_commitment field
};

// Card constants
export const CARD_NOT_DEALT = 255;

// Table account data offsets (matches Table::SIZE = 437)
export const TABLE_OFFSETS = {
  DISCRIMINATOR: 0,        // 8 bytes
  TABLE_ID: 8,             // 32 bytes
  AUTHORITY: 40,           // 32 bytes (PDA)
  POOL: 72,                // 32 bytes
  GAME_TYPE: 104,          // 1 byte (0=SitAndGoHU, 1=SitAndGo6Max, 2=SitAndGo9Max, 3=CashGame)
  SMALL_BLIND: 105,        // 8 bytes (u64 LE)
  BIG_BLIND: 113,          // 8 bytes (u64 LE)
  MAX_PLAYERS: 121,        // 1 byte
  CURRENT_PLAYERS: 122,    // 1 byte
  HAND_NUMBER: 123,        // 8 bytes (u64 LE)
  POT: 131,                // 8 bytes (u64 LE)
  MIN_BET: 139,            // 8 bytes (u64 LE)
  RAKE_ACCUMULATED: 147,   // 8 bytes (u64 LE)
  COMMUNITY_CARDS: 155,    // 5 bytes
  PHASE: 160,              // 1 byte
  CURRENT_PLAYER: 161,     // 1 byte
  // IS_DELEGATED removed in Arcium (no ER delegation)
  SEATS_OCCUPIED: 250,     // 2 bytes (u16 LE)
  CREATOR: 290,            // 32 bytes (Pubkey)
  IS_USER_CREATED: 322,    // 1 byte (bool)
  CREATOR_RAKE_TOTAL: 323, // 8 bytes (u64 LE)
  LAST_RAKE_EPOCH: 331,    // 8 bytes (u64 LE)
  PRIZES_DISTRIBUTED: 339, // 1 byte (bool)
  BUMP: 341,               // 1 byte
  TOKEN_MINT: 385,           // 32 bytes (Pubkey) — after prize_pool(377+8=385)
  BUY_IN_TYPE: 417,          // 1 byte (0=Normal 20-100BB, 1=Deep 50-250BB)
  RAKE_CAP: 418,             // 8 bytes (u64 LE) — rake cap in token units (0=no cap)
  IS_PRIVATE: 426,           // 1 byte (bool) — private table (whitelist-only)
  CRANK_POOL_ACCUMULATED: 427, // 8 bytes (u64 LE) — monotonic crank pool (always active)
};
export const TABLE_ACCOUNT_SIZE = 437;

// ─── SNG Tier System ───
// Mirrors programs/cq-poker/src/constants.rs SnGTier enum
// Devnet: all amounts divided by TIER_SCALE=10
export const TIER_SCALE = 10;

export enum SnGTier {
  Micro = 0,
  Bronze = 1,
  Silver = 2,
  Gold = 3,
  Platinum = 4,
  Diamond = 5,
}

export interface TierInfo {
  id: SnGTier;
  name: string;
  /** Total buy-in in lamports (entry + fee) */
  totalBuyIn: number;
  /** Entry amount in lamports (goes to prize pool) */
  entryAmount: number;
  /** Fee amount in lamports (goes to Steel treasury/stakers) */
  feeAmount: number;
  /** Display color class */
  color: string;
  /** Accent border/bg color */
  accent: string;
  /** Short description */
  desc: string;
}

export const TIERS: TierInfo[] = [
  {
    id: SnGTier.Micro, name: 'Micro',
    totalBuyIn: 100_000_000 / TIER_SCALE,    // 0.01 SOL devnet
    entryAmount: 0,
    feeAmount: 100_000_000 / TIER_SCALE,
    color: 'text-gray-400', accent: 'border-gray-500/20 bg-gray-500/5',
    desc: 'POKER only — no SOL prizes',
  },
  {
    id: SnGTier.Bronze, name: 'Bronze',
    totalBuyIn: 250_000_000 / TIER_SCALE,    // 0.025 SOL devnet
    entryAmount: 187_500_000 / TIER_SCALE,
    feeAmount: 62_500_000 / TIER_SCALE,
    color: 'text-amber-600', accent: 'border-amber-600/20 bg-amber-600/5',
    desc: '0.025 SOL buy-in',
  },
  {
    id: SnGTier.Silver, name: 'Silver',
    totalBuyIn: 500_000_000 / TIER_SCALE,    // 0.05 SOL devnet
    entryAmount: 375_000_000 / TIER_SCALE,
    feeAmount: 125_000_000 / TIER_SCALE,
    color: 'text-slate-300', accent: 'border-slate-300/20 bg-slate-300/5',
    desc: '0.05 SOL buy-in',
  },
  {
    id: SnGTier.Gold, name: 'Gold',
    totalBuyIn: 1_000_000_000 / TIER_SCALE,  // 0.1 SOL devnet
    entryAmount: 750_000_000 / TIER_SCALE,
    feeAmount: 250_000_000 / TIER_SCALE,
    color: 'text-yellow-400', accent: 'border-yellow-400/20 bg-yellow-400/5',
    desc: '0.1 SOL buy-in',
  },
  {
    id: SnGTier.Platinum, name: 'Platinum',
    totalBuyIn: 2_000_000_000 / TIER_SCALE,  // 0.2 SOL devnet
    entryAmount: 1_500_000_000 / TIER_SCALE,
    feeAmount: 500_000_000 / TIER_SCALE,
    color: 'text-cyan-300', accent: 'border-cyan-300/20 bg-cyan-300/5',
    desc: '0.2 SOL buy-in',
  },
  {
    id: SnGTier.Diamond, name: 'Diamond',
    totalBuyIn: 5_000_000_000 / TIER_SCALE,  // 0.5 SOL devnet
    entryAmount: 3_750_000_000 / TIER_SCALE,
    feeAmount: 1_250_000_000 / TIER_SCALE,
    color: 'text-rose-400', accent: 'border-rose-400/20 bg-rose-400/5',
    desc: '0.5 SOL buy-in',
  },
];

export function getTierInfo(tier: SnGTier): TierInfo {
  return TIERS[tier] || TIERS[0];
}

/** Format lamports as SOL string */
export function lamportsToSol(lamports: number): string {
  return (lamports / 1e9).toFixed(lamports >= 1e9 ? 2 : lamports >= 1e8 ? 3 : 4);
}

// PlayerAccount data offsets
export const PLAYER_ACCOUNT_OFFSETS = {
  WALLET: 8,              // 32 bytes
  IS_REGISTERED: 40,      // 1 byte
  FREE_ENTRIES: 41,       // 1 byte
  HANDS_PLAYED: 42,       // 8 bytes (u64)
  HANDS_WON: 50,          // 8 bytes (u64)
  TOTAL_WINNINGS: 58,     // 8 bytes (u64)
  TOTAL_LOSSES: 66,       // 8 bytes (u64)
  TOURNAMENTS_PLAYED: 74, // 4 bytes (u32)
  TOURNAMENTS_WON: 78,    // 4 bytes (u32)
  REGISTERED_AT: 82,      // 8 bytes (i64)
  BUMP: 90,               // 1 byte
  CLAIMABLE_SOL: 91,      // 8 bytes (u64)
  XP: 99,                 // 8 bytes (u64)
  HAND_STREAK: 107,       // 2 bytes (u16)
};
export const PLAYER_CLAIMABLE_SOL_OFFSET = 91; // backwards compat

/** Calculate player level from XP (mirrors on-chain level_from_xp) */
export function levelFromXp(xp: number): number {
  if (xp < 100) return 1;
  if (xp < 300) return 2;
  if (xp < 600) return 3;
  if (xp < 1100) return 4;
  if (xp < 2000) return 5;
  if (xp < 3500) return 6;
  if (xp < 6000) return 7;
  if (xp < 10000) return 8;
  if (xp < 20000) return 9;
  if (xp < 40000) return 10;
  if (xp < 80000) return 11;
  if (xp < 150000) return 12;
  return 13;
}

/** XP needed for next level */
export function xpForNextLevel(xp: number): { current: number; next: number; progress: number } {
  const thresholds = [0, 100, 300, 600, 1100, 2000, 3500, 6000, 10000, 20000, 40000, 80000, 150000];
  const level = levelFromXp(xp);
  const current = thresholds[level - 1] || 0;
  const next = thresholds[level] || thresholds[thresholds.length - 1];
  const progress = next > current ? ((xp - current) / (next - current)) * 100 : 100;
  return { current, next, progress };
}

// Game types
export enum GameType {
  SitAndGoHeadsUp = 'sitAndGoHeadsUp',
  SitAndGo6Max = 'sitAndGo6Max',
  SitAndGo9Max = 'sitAndGo9Max',
  CashGame = 'cashGame',
}

// Rake Cap Tiers (matches on-chain TokenTierConfig SOL_TIER_BOUNDARIES)
export const RAKE_CAP_TIERS = [
  { name: 'Micro',    color: 'text-gray-400',    bg: 'bg-gray-400/8',    border: 'border-gray-400/15',    maxBB: 10_000_000 },
  { name: 'Low',      color: 'text-blue-400',    bg: 'bg-blue-400/8',    border: 'border-blue-400/15',    maxBB: 25_000_000 },
  { name: 'Mid-Low',  color: 'text-teal-400',    bg: 'bg-teal-400/8',    border: 'border-teal-400/15',    maxBB: 50_000_000 },
  { name: 'Mid',      color: 'text-emerald-400', bg: 'bg-emerald-400/8', border: 'border-emerald-400/15', maxBB: 100_000_000 },
  { name: 'Mid-High', color: 'text-amber-400',   bg: 'bg-amber-400/8',  border: 'border-amber-400/15',   maxBB: 500_000_000 },
  { name: 'High',     color: 'text-orange-400',  bg: 'bg-orange-400/8',  border: 'border-orange-400/15',  maxBB: 1_000_000_000 },
  { name: 'Whale',    color: 'text-red-400',     bg: 'bg-red-400/8',     border: 'border-red-400/15',     maxBB: Infinity },
] as const;

export function getRakeCapTier(bigBlindLamports: number) {
  const idx = RAKE_CAP_TIERS.findIndex(t => bigBlindLamports <= t.maxBB);
  return RAKE_CAP_TIERS[idx >= 0 ? idx : RAKE_CAP_TIERS.length - 1];
}

// Stakes
export enum Stakes {
  Micro = 'micro',   // 1/2
  Low = 'low',       // 5/10
  Mid = 'mid',       // 25/50
  High = 'high',     // 100/200
}

// Game phases
export enum GamePhase {
  Waiting = 'waiting',
  Preflop = 'preflop',
  Flop = 'flop',
  Turn = 'turn',
  River = 'river',
  Showdown = 'showdown',
}

// Player actions
export enum PlayerAction {
  Fold = 'fold',
  Check = 'check',
  Call = 'call',
  Bet = 'bet',
  Raise = 'raise',
  AllIn = 'allIn',
}
