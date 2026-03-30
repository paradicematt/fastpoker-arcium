/**
 * Fast Poker — Dealer Service (Crank)
 *
 * Permissionless crank that watches Table accounts and advances game phases.
 * Card encryption via Arcium MPC (shuffle_and_deal, reveal_community, reveal_showdown).
 * All game logic runs on Solana L1. Anyone can run a Dealer Service and earn rake.
 *
 * Phase → Action mapping (GamePhase enum values):
 *   Showdown       (7)  → settle_hand
 *   Waiting        (0)  → start_game  (if current_players >= 2)
 *   Starting       (1)  → arcium_deal (MPC encrypted shuffle+deal)
 *   AwaitingDeal   (2)  → (monitor Arcium MPC callback)
 *   AwaitingShowdown(8) → (monitor Arcium MPC callback)
 *   FlopRevealPending  (10) → arcium_reveal (MPC community card reveal)
 *   TurnRevealPending  (11) → arcium_reveal
 *   RiverRevealPending (12) → arcium_reveal
 *   Complete       (9)  → settle + cleanup
 *
 * Frontend sends ONLY player_action (needs wallet / session key).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import bs58 from 'bs58';
import { L1Stream, L1AccountUpdate } from './l1-stream';
import {
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getClusterAccAddress,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumEnv,
  getMXEPublicKey,
  x25519,
} from '@arcium-hq/client';
import {
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
  permissionPdaFromAccount,
  createCommitAndUndelegateInstruction,
} from '@magicblock-labs/ephemeral-rollups-sdk';
/** Build a CommitState instruction via CPI through our contract.
 *  Direct calls to Magic program fail with InvalidInstructionData.
 *  Our commit_state handler does CPI to Magic program which works. */
const COMMIT_STATE_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:commit_state').digest().slice(0, 8),
);
function buildCommitInstruction(payer: PublicKey, accounts: PublicKey[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: COMMIT_STATE_DISC,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      // remaining_accounts: PDAs to commit
      ...accounts.map(a => ({ pubkey: a, isSigner: false, isWritable: true })),
    ],
  });
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const PROGRAM_ID = new PublicKey(process.env.FASTPOKER_PROGRAM_ID || 'BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const VRF_PROGRAM_ID = new PublicKey('Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz');
const VRF_EPHEMERAL_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');

// ─── Arcium MPC Constants ───
const ARCIUM_PROGRAM_ID = getArciumProgramId();
const ARCIUM_SIGN_PDA_SEED = Buffer.from('ArciumSignerAccount');
const ARCIUM_CLOCK_SEED = getArciumAccountBaseSeed('ClockAccount');
const ARCIUM_FEE_POOL_SEED = getArciumAccountBaseSeed('FeePool');

function getArciumSignPda(): PublicKey {
  return PublicKey.findProgramAddressSync([ARCIUM_SIGN_PDA_SEED], PROGRAM_ID)[0];
}
function getArciumClockPda(): PublicKey {
  return PublicKey.findProgramAddressSync([ARCIUM_CLOCK_SEED], ARCIUM_PROGRAM_ID)[0];
}
function getArciumFeePoolPda(): PublicKey {
  return PublicKey.findProgramAddressSync([ARCIUM_FEE_POOL_SEED], ARCIUM_PROGRAM_ID)[0];
}
/** Compute comp_def_offset: SHA256(circuit_name)[0..4] as u32 LE */
function computeCompDefOffset(circuitName: string): number {
  return Buffer.from(getCompDefAccOffset(circuitName)).readUInt32LE(0);
}

// ─── Steel Tokenomics Program (SNG: mint_unrefined, Cash: record_poker_rake) ───
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
const EXPECTED_POOL_AUTHORITY = new PublicKey('2snSN5GJdVjVqJUjVZQKKKjyLnrukdJZnsCpbHKghweV');
// NOTE: No SUPER_ADMIN here — crank operates with ZERO admin privileges.
const MINT_UNREFINED_DISC = 4; // Steel instruction discriminator
const RECORD_POKER_RAKE_DISC = 26; // Steel instruction discriminator
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// ─── Cash Game Rake Distribution ───
// Anchor discriminators
const PROCESS_RAKE_DIST_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:process_rake_distribution').digest().slice(0, 8),
);
const PROCESS_SPL_RAKE_DIST_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:process_spl_rake_distribution').digest().slice(0, 8),
);
const RESIZE_VAULT_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:resize_vault').digest().slice(0, 8),
);
const DISTRIBUTE_CRANK_REWARDS_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:distribute_crank_rewards').digest().slice(0, 8),
);
const INIT_TABLE_VAULT_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:init_table_vault').digest().slice(0, 8),
);
const INIT_CRANK_TALLY_ER_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:init_crank_tally_er').digest().slice(0, 8),
);
const INIT_CRANK_TALLY_L1_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:init_crank_tally_l1').digest().slice(0, 8),
);
// CrankTally layout constants (197 bytes)
const TALLY_OPERATORS_START = 40;   // 4 × 32-byte pubkeys
const TALLY_ACTION_COUNT_START = 168; // 4 × u32
const MAX_CRANK_OPERATORS = 4;
const CRANK_TALLY_SIZE = 197;

// Sweep interval: check ER for cash game tables with accumulated rake
const RAKE_SWEEP_INTERVAL_MS = 60_000; // 60 seconds
// Sweep interval: check ER for cash game seats that should be removed
const REMOVAL_SWEEP_INTERVAL_MS = 30_000; // 30 seconds

// ─── Validator Registry ───
// Maps validator pubkeys → RPC endpoints. Add new validators here OR via crank-config.json.
// Crank maintains authenticated connections to all known validators.
// Config file validators (crank-config.json `validators` array) override these defaults.
interface ValidatorEntry {
  name: string;
  pubkey: PublicKey;
  rpcUrl: string;
  wsUrl: string;
  isDefault?: boolean;
}
// Default validators — overridden by crank-config.json `validators[]` if non-empty
let VALIDATORS: ValidatorEntry[] = [
  {
    name: 'devnet-tee',
    pubkey: new PublicKey('MDTrz4PDEcNCKMRLbpPwwwV8bcpCExWXxrmXqVuWpU9'),
    rpcUrl: 'https://devnet-tee.magicblock.app',
    wsUrl: 'wss://devnet-tee.magicblock.app',
    isDefault: true,
  },
  {
    name: 'tee',
    pubkey: new PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA'),
    rpcUrl: 'https://tee.magicblock.app',
    wsUrl: 'wss://tee.magicblock.app',
  },
];
let VALIDATOR_BY_PUBKEY = new Map<string, ValidatorEntry>(
  VALIDATORS.map(v => [v.pubkey.toBase58(), v]),
);
function getDefaultValidator(): ValidatorEntry {
  return VALIDATORS.find(v => v.isDefault) || VALIDATORS[0];
}
function getValidatorByPubkey(pk: PublicKey | string): ValidatorEntry | undefined {
  return VALIDATOR_BY_PUBKEY.get(typeof pk === 'string' ? pk : pk.toBase58());
}
/** Reload VALIDATORS from crank-config.json if `validators` array is non-empty.
 *  Called on startup after config is loaded. Rebuilds lookup maps. */
function reloadValidatorsFromConfig(): void {
  if (!crankConfig.validators || crankConfig.validators.length === 0) return;
  try {
    VALIDATORS = crankConfig.validators.map(v => ({
      name: v.name,
      pubkey: new PublicKey(v.pubkey),
      rpcUrl: v.rpcUrl,
      wsUrl: v.wsUrl,
      isDefault: v.isDefault,
    }));
    VALIDATOR_BY_PUBKEY = new Map(VALIDATORS.map(v => [v.pubkey.toBase58(), v]));
    console.log(`  📋 Loaded ${VALIDATORS.length} validator(s) from config`);
  } catch (e: any) {
    console.warn(`  ⚠️  Failed to load validators from config: ${e?.message?.slice(0, 60)}`);
  }
}
/** Read delegation record from L1 to detect target validator.
 *  Delegation record PDA: seeds=["delegation", account], program=DELEGATION_PROGRAM_ID.
 *  Data[8..40] = validator pubkey. */
async function detectValidator(l1Conn: Connection, account: PublicKey): Promise<ValidatorEntry | null> {
  const [recordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('delegation'), account.toBuffer()],
    DELEGATION_PROGRAM_ID,
  );
  const info = await l1Conn.getAccountInfo(recordPda, 'confirmed');
  if (!info || info.data.length < 40) return null;
  const validatorPk = new PublicKey(info.data.subarray(8, 40));
  return getValidatorByPubkey(validatorPk) || null;
}

// ─── Local Mode ───
// When LOCAL_MODE=true, the crank runs against a plain Solana validator (localhost).
// No auth, no delegation, no CommitState, no LaserStream.
// Tables are discovered directly from PROGRAM_ID.
const LOCAL_MODE = process.env.LOCAL_MODE === 'true' || process.env.LOCAL_MODE === '1';

// Deal mode is always Arcium MPC. devnet_bypass_deal has been removed (security hole).

// ─── Solana RPC ───
// Primary RPC for reading table state and sending crank transactions.
const LOCAL_RPC = 'http://127.0.0.1:8899';
const L1_RPC = LOCAL_MODE ? LOCAL_RPC : (process.env.L1_RPC || 'https://api.devnet.solana.com');
const RPC_BASE = LOCAL_MODE ? LOCAL_RPC : (process.env.RPC_URL || process.env.ER_RPC || L1_RPC);
let ACTIVE_RPC = RPC_BASE;
// SNG start_game supports both layouts:
//   2N   [seats..., seat_cards...]                               (default)
//   3N+1 [seats..., seat_cards..., permissions..., perm_program]
// 3N+1 is disabled — Permission Program not used in Arcium architecture.
const START_GAME_USE_3N = false;
// Module-level L1 connection for blockhash
const l1ForBlockhash = new Connection(L1_RPC, 'confirmed');

/** Extract Helius API key from RPC URL like https://devnet.helius-rpc.com/?api-key=XXXX */
function extractHeliusApiKey(rpcUrl: string): string | null {
  try {
    const u = new URL(rpcUrl);
    return u.searchParams.get('api-key') || u.searchParams.get('api_key') || null;
  } catch { return null; }
}
// Track ALL TEE connections — sendTx uses TEE blockhash and skips simulation for these
let teeConnectionRef: Connection | null = null;
const teeConnections = new Set<Connection>();

// Auto-fold timeout: how many ms to wait before sending handle_timeout
const TIMEOUT_MS = 20_000; // 20 seconds wall-clock

// ─── Anchor 8-byte discriminators ───
const TABLE_DISCRIMINATOR = crypto
  .createHash('sha256')
  .update('account:Table')
  .digest()
  .slice(0, 8);

const DISC = {
  startGame: Buffer.from([249, 47, 252, 172, 184, 162, 245, 14]),
  settleHand: Buffer.from(
    crypto.createHash('sha256').update('global:settle_hand').digest().slice(0, 8),
  ),
  misdeal: Buffer.from(
    crypto.createHash('sha256').update('global:misdeal').digest().slice(0, 8),
  ),
  commitAndUndelegateTable: Buffer.from(
    crypto
      .createHash('sha256')
      .update('global:commit_and_undelegate_table')
      .digest()
      .slice(0, 8),
  ),
  handleTimeout: Buffer.from(
    crypto.createHash('sha256').update('global:handle_timeout').digest().slice(0, 8),
  ),
  distributePrizes: Buffer.from(
    crypto.createHash('sha256').update('global:distribute_prizes').digest().slice(0, 8),
  ),
  adminCloseTable: Buffer.from(
    crypto.createHash('sha256').update('global:admin_close_table').digest().slice(0, 8),
  ),
  closeTable: Buffer.from(
    crypto.createHash('sha256').update('global:close_table').digest().slice(0, 8),
  ),
  resetSngTable: Buffer.from(
    crypto.createHash('sha256').update('global:reset_sng_table').digest().slice(0, 8),
  ),
  crankRemovePlayer: Buffer.from(
    crypto.createHash('sha256').update('global:crank_remove_player').digest().slice(0, 8),
  ),
  crankKickInactive: Buffer.from(
    crypto.createHash('sha256').update('global:crank_kick_inactive').digest().slice(0, 8),
  ),
  resolveAuction: Buffer.from(
    crypto.createHash('sha256').update('global:resolve_auction').digest().slice(0, 8),
  ),
  processCashout: Buffer.from(
    crypto.createHash('sha256').update('global:process_cashout').digest().slice(0, 8),
  ),
  claimUnclaimedSol: Buffer.from(
    crypto.createHash('sha256').update('global:claim_unclaimed_sol').digest().slice(0, 8),
  ),
  delegateTable: Buffer.from(
    crypto.createHash('sha256').update('global:delegate_table').digest().slice(0, 8),
  ),
  delegateSeat: Buffer.from(
    crypto.createHash('sha256').update('global:delegate_seat').digest().slice(0, 8),
  ),
  delegateSeatCards: Buffer.from(
    crypto.createHash('sha256').update('global:delegate_seat_cards').digest().slice(0, 8),
  ),
  processCashoutV2: Buffer.from(
    crypto.createHash('sha256').update('global:process_cashout_v2').digest().slice(0, 8),
  ),
  processCashoutV3: Buffer.from(
    crypto.createHash('sha256').update('global:process_cashout_v3').digest().slice(0, 8),
  ),
  clearLeavingSeat: Buffer.from(
    crypto.createHash('sha256').update('global:clear_leaving_seat').digest().slice(0, 8),
  ),
  delegateDeckState: Buffer.from(
    crypto.createHash('sha256').update('global:delegate_deck_state').digest().slice(0, 8),
  ),
  delegatePermission: Buffer.from(
    crypto.createHash('sha256').update('global:delegate_permission').digest().slice(0, 8),
  ),
  cleanupDepositProof: Buffer.from(
    crypto.createHash('sha256').update('global:cleanup_deposit_proof').digest().slice(0, 8),
  ),
  resetSeatPermission: Buffer.from(
    crypto.createHash('sha256').update('global:reset_seat_permission').digest().slice(0, 8),
  ),
  delegateCrankTally: Buffer.from(
    crypto.createHash('sha256').update('global:delegate_crank_tally').digest().slice(0, 8),
  ),
  arciumDeal: Buffer.from(
    crypto.createHash('sha256').update('global:arcium_deal').digest().slice(0, 8),
  ),
  arciumRevealQueue: Buffer.from(
    crypto.createHash('sha256').update('global:arcium_reveal_queue').digest().slice(0, 8),
  ),
  arciumShowdownQueue: Buffer.from(
    crypto.createHash('sha256').update('global:arcium_showdown_queue').digest().slice(0, 8),
  ),
  arciumClaimCardsQueue: Buffer.from(
    crypto.createHash('sha256').update('global:arcium_claim_cards_queue').digest().slice(0, 8),
  ),
};

// ─── Permission creation + delegation discriminators (for L1→TEE SNG promotion) ───
const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const PERM_DISC = {
  createTablePerm: Buffer.from([194, 38, 119, 36, 146, 11, 104, 110]),
  createDeckStatePerm: Buffer.from([217, 32, 126, 22, 180, 97, 105, 157]),
  createSeatPerm: Buffer.from([161, 4, 4, 164, 13, 227, 248, 60]),
  delegateTablePerm: Buffer.from([149, 71, 189, 246, 84, 211, 143, 207]),
  delegateDeckStatePerm: Buffer.from([118, 187, 69, 88, 192, 76, 153, 111]),
  delegateSeatPerm: Buffer.from([110, 176, 51, 3, 248, 220, 36, 196]),
};

// ─── Auction constants ───
const AUCTION_EPOCH_SECS = 604_800;
const AUCTION_SEED = Buffer.from('auction');
const AUCTION_CONFIG_SEED = Buffer.from('auction_config');
const TOKEN_BID_SEED = Buffer.from('token_bid');
const LISTED_TOKEN_SEED = Buffer.from('listed_token');
const TIER_CONFIG_SEED = Buffer.from('tier_config');
const GLOBAL_CONTRIB_SEED = Buffer.from('global_contrib');
const AUCTION_SWEEP_INTERVAL_MS = 60_000; // check once per minute

// ─── Table account byte offsets (Borsh / Anchor serialisation) ───
// Verified against programs/fastpoker/src/state/table.rs::SIZE
// and cross-checked with working test parsers.
const OFF = {
  TABLE_ID:         8,    // [u8; 32]  — 8..40
  AUTHORITY:       40,    // Pubkey    — 40..72
  GAME_TYPE:      104,    // u8 enum
  MAX_PLAYERS:    121,    // u8
  CURRENT_PLAYERS:122,    // u8
  HAND_NUMBER:    123,    // u64 LE
  POT:            131,    // u64 LE
  SMALL_BLIND:    105,    // u64 LE
  BIG_BLIND:      113,    // u64 LE
  MIN_BET:        139,    // u64 LE (currentBet)
  RAKE_ACCUMULATED: 147,  // u64 LE
  COMMUNITY_CARDS:155,    // [u8; 5]
  PHASE:          160,    // u8 enum
  CURRENT_PLAYER: 161,    // u8
  DEALER_BUTTON:  163,    // u8
  SMALL_BLIND_SEAT:164,   // u8
  BIG_BLIND_SEAT: 165,    // u8
  LAST_ACTION_SLOT: 166,  // u64 LE
  IS_DELEGATED:   174,    // bool
  REVEALED_HANDS: 175,    // [u8; 18] (9 seats × 2 cards)
  BLIND_LEVEL:    241,    // u8
  TOURNAMENT_START_SLOT: 242, // u64 LE
  SEATS_OCCUPIED: 250,    // u16 LE
  SEATS_FOLDED:   254,    // u16 LE
  TOKEN_ESCROW: 258,       // Pubkey
  CREATOR: 290,            // Pubkey
  IS_USER_CREATED: 322,    // bool
  CREATOR_RAKE_TOTAL: 323, // u64 LE
  LAST_RAKE_EPOCH: 331,    // u64 LE
  PRIZES_DISTRIBUTED: 339, // bool
  BUMP: 341,               // u8
  ELIMINATED_SEATS: 342,   // [u8; 9]
  ELIMINATED_COUNT: 351,   // u8
  ENTRY_FEES_ESCROWED: 352, // u64 LE
  // Tiered SNG fields (new)
  TIER: 360,                  // u8 (SnGTier enum)
  ENTRY_AMOUNT: 361,          // u64 LE (lamports → prize pool per player)
  FEE_AMOUNT: 369,            // u64 LE (lamports → Steel per player)
  PRIZE_POOL: 377,            // u64 LE (running total of entry SOL)
  TOKEN_MINT: 385,            // Pubkey (denomination: default=SOL, else SPL mint)
  BUY_IN_TYPE: 417,           // u8 (0=Normal 20-100BB, 1=Deep 50-250BB)
  // Protocol Economics Phase 1+2+8
  RAKE_CAP: 418,              // u64 LE
  IS_PRIVATE: 426,            // bool
  CRANK_POOL_ACCUMULATED: 427, // u64 LE
  ACTION_NONCE: 435,          // u16 LE — monotonic nonce for timeout race protection
} as const;

// ─── Seat account byte offsets ───
const SEAT_WALLET_OFFSET = 8; // Pubkey right after 8-byte discriminator
// disc(8)+wallet(32)+session(32)+table(32)+chips(8)+bet(8)+total(8)+encrypted(64)+commit(32)+hole(2)+seat_num(1)=227
const SEAT_STATUS_OFFSET = 227;        // u8 enum: 0=Empty,1=Active,2=Folded,3=AllIn,4=SittingOut,5=Busted
const SEAT_SIT_OUT_COUNT_OFFSET = 240; // sit_out_button_count (u8) — 3+ = removable
const SEAT_HANDS_SINCE_BUST = 241;     // hands_since_bust (u8) — 3+ with 0 chips = removable
const SEAT_CHIPS_OFFSET = 104;         // chips (u64 LE) at disc(8)+wallet(32)+session(32)+table(32)
const SEAT_CASHOUT_CHIPS_OFFSET = 246; // cashout_chips (u64 LE) — snapshot of chips+reserve at leave
const SEAT_CASHOUT_NONCE_OFFSET = 254; // cashout_nonce (u64 LE) — incremented each leave
const SEAT_VAULT_RESERVE_OFFSET = 262; // vault_reserve (u64 LE) — pre-funded reserve
const SEAT_SIT_OUT_TIMESTAMP_OFFSET = 270; // sit_out_timestamp (i64 LE) — unix timestamp when sat out

// Unclaimed balance PDA seed
const UNCLAIMED_SEED = Buffer.from('unclaimed');

// TEE validator for new delegations (from registry default)
const TEE_VALIDATOR = getDefaultValidator().pubkey;

// Player-table marker PDA seed
const PLAYER_TABLE_SEED = Buffer.from('player_table');

// Player account PDA seed (for claimable_sol)
const PLAYER_SEED = Buffer.from('player');

function getPlayerPda(wallet: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [PLAYER_SEED, wallet.toBuffer()],
    PROGRAM_ID,
  );
  return pda;
}

// ─── Payout structures (basis points, mirrors tournament.rs) ───
const PAYOUTS: Record<number, number[]> = {
  // GameType enum: 0=SitAndGoHeadsUp, 1=SitAndGo6Max, 2=SitAndGo9Max
  0: [10000],             // HU: winner takes all
  1: [6500, 3500],        // 6-max: 65% / 35%
  2: [5000, 3000, 2000],  // 9-max: 50% / 30% / 20%
};

// Buy-in per player: 100 POKER (internal accounting units, 6 decimals)
// NOTE: Unrefined system uses 6-decimal convention independently of POKER mint (9 dec).
// The refine/claim path must apply the 1000x conversion when minting actual tokens.
const BUY_IN_AMOUNT = 100_000_000;

// ─── GamePhase enum (mirrors Rust — programs/fastpoker/src/state/table.rs) ───
// CRITICAL: Must match Rust enum variant order exactly.
const Phase = {
  Waiting:            0,
  Starting:           1,
  AwaitingDeal:       2,  // MPC shuffle_and_deal queued, waiting for callback
  Preflop:            3,
  Flop:               4,
  Turn:               5,
  River:              6,
  Showdown:           7,
  AwaitingShowdown:   8,  // MPC reveal_showdown queued, waiting for callback
  Complete:           9,
  FlopRevealPending:  10,
  TurnRevealPending:  11,
  RiverRevealPending: 12,
} as const;
const PHASE_NAMES = [
  'Waiting',           // 0
  'Starting',          // 1
  'AwaitingDeal',      // 2
  'Preflop',           // 3
  'Flop',              // 4
  'Turn',              // 5
  'River',             // 6
  'Showdown',          // 7
  'AwaitingShowdown',  // 8
  'Complete',          // 9
  'FlopRevealPending', // 10
  'TurnRevealPending', // 11
  'RiverRevealPending',// 12
];

// ═══════════════════════════════════════════════════════════════════
// PDA HELPERS
// ═══════════════════════════════════════════════════════════════════

function getSeatPda(table: PublicKey, idx: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat'), table.toBuffer(), Buffer.from([idx])],
    PROGRAM_ID,
  )[0];
}

function getSeatCardsPda(table: PublicKey, idx: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat_cards'), table.toBuffer(), Buffer.from([idx])],
    PROGRAM_ID,
  )[0];
}

function getPermissionPda(permissionedAccount: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('permission:'), permissionedAccount.toBuffer()],
    PERMISSION_PROGRAM_ID,
  )[0];
}

function getIdentityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('identity')],
    PROGRAM_ID,
  )[0];
}

function getDeckStatePda(table: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('deck_state'), table.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function getUnrefinedPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('unrefined'), owner.toBuffer()],
    STEEL_PROGRAM_ID,
  )[0];
}

function getMintAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('mint_authority')],
    STEEL_PROGRAM_ID,
  )[0];
}

function getPrizeAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('prize_authority')],
    PROGRAM_ID,
  )[0];
}

function getPlayerTableMarkerPda(player: PublicKey, table: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('player_table'), player.toBuffer(), table.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function getUnclaimedBalancePda(table: PublicKey, wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [UNCLAIMED_SEED, table.toBuffer(), wallet.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function getVaultPda(table: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), table.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function getCrankTallyErPda(table: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('crank_tally_er'), table.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function getCrankTallyL1Pda(table: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('crank_tally_l1'), table.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function getCrankOperatorPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('crank'), wallet.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function getDealerLicensePda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dealer_license'), wallet.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/** Parse operator pubkeys and action counts from a CrankTally account */
function parseTallyOperators(data: Buffer, weightMul: number): { pubkey: PublicKey; weight: number }[] {
  const result: { pubkey: PublicKey; weight: number }[] = [];
  if (data.length < CRANK_TALLY_SIZE) return result;
  for (let i = 0; i < MAX_CRANK_OPERATORS; i++) {
    const pkStart = TALLY_OPERATORS_START + i * 32;
    const countStart = TALLY_ACTION_COUNT_START + i * 4;
    const pk = new PublicKey(data.subarray(pkStart, pkStart + 32));
    if (pk.equals(PublicKey.default)) continue;
    const count = data.readUInt32LE(countStart);
    if (count === 0) continue;
    result.push({ pubkey: pk, weight: count * weightMul });
  }
  return result;
}

function getDepositProofPda(table: PublicKey, seatIndex: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('deposit_proof'), table.toBuffer(), Buffer.from([seatIndex])],
    PROGRAM_ID,
  )[0];
}

function getReceiptPda(table: PublicKey, seatIndex: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('receipt'), table.toBuffer(), Buffer.from([seatIndex])],
    PROGRAM_ID,
  )[0];
}

// ═══════════════════════════════════════════════════════════════════
// TABLE STATE PARSER
// ═══════════════════════════════════════════════════════════════════

interface TableState {
  tableId:        Buffer;
  authority:      PublicKey;
  gameType:       number;
  phase:          number;
  currentPlayer:  number;
  maxPlayers:     number;
  currentPlayers: number;
  handNumber:     number;
  pot:            number;
  lastActionSlot: number;
  seatsOccupied:  number;
  seatsFolded:    number;
  isDelegated:    boolean;
  tokenMint:      PublicKey;
  actionNonce:    number;
  revealedHands:  number[];
}

function parseTable(data: Buffer): TableState {
  return {
    tableId:        Buffer.from(data.slice(OFF.TABLE_ID, OFF.TABLE_ID + 32)),
    authority:      new PublicKey(data.slice(OFF.AUTHORITY, OFF.AUTHORITY + 32)),
    gameType:       data[OFF.GAME_TYPE],
    phase:          data[OFF.PHASE],
    currentPlayer:  data[OFF.CURRENT_PLAYER],
    maxPlayers:     data[OFF.MAX_PLAYERS],
    currentPlayers: data[OFF.CURRENT_PLAYERS],
    handNumber:     Number(data.readBigUInt64LE(OFF.HAND_NUMBER)),
    pot:            Number(data.readBigUInt64LE(OFF.POT)),
    lastActionSlot: Number(data.readBigUInt64LE(OFF.LAST_ACTION_SLOT)),
    seatsOccupied:  data.readUInt16LE(OFF.SEATS_OCCUPIED),
    seatsFolded:    data.readUInt16LE(OFF.SEATS_FOLDED),
    isDelegated:    data[OFF.IS_DELEGATED] !== 0,
    tokenMint:      data.length >= OFF.TOKEN_MINT + 32
                      ? new PublicKey(data.subarray(OFF.TOKEN_MINT, OFF.TOKEN_MINT + 32))
                      : PublicKey.default,
    actionNonce:    data.length >= OFF.ACTION_NONCE + 2
                      ? data.readUInt16LE(OFF.ACTION_NONCE)
                      : 0,
    revealedHands:  Array.from(data.slice(OFF.REVEALED_HANDS, OFF.REVEALED_HANDS + 18)),
  };
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 2A: JSON CACHE TYPES & PARSERS
// ═══════════════════════════════════════════════════════════════════

interface CachedTableState {
  pubkey: string;
  gameType: number;
  phase: number;
  phaseName: string;
  currentPlayer: number;
  maxPlayers: number;
  currentPlayers: number;
  handNumber: number;
  pot: number;
  smallBlind: number;
  bigBlind: number;
  minBet: number;
  communityCards: number[];
  dealerButton: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  lastActionSlot: number;
  seatsOccupied: number;
  seatsFolded: number;
  isDelegated: boolean;
  tokenMint: string;
  actionNonce: number;
  authority: string;
  creator: string;
  isUserCreated: boolean;
  rakeAccumulated: number;
  rakeCap: number;
  isPrivate: boolean;
  tier: number;
  entryAmount: number;
  feeAmount: number;
  prizePool: number;
  blindLevel: number;
  revealedHands: number[];
}

interface CachedSeatState {
  player: string;
  seatIndex: number;
  status: number;
  chips: number;
  betThisRound: number;
  totalBetThisHand: number;
  sitOutButtonCount: number;
  handsSinceBust: number;
  sitOutTimestamp: number;
  timeBankSeconds: number;
  timeBankActive: boolean;
}

interface StateCacheEntry {
  table: CachedTableState;
  seats: CachedSeatState[];
  updatedAt: number;
}

interface StateCache {
  crank_timestamp: number;
  tables: Record<string, StateCacheEntry>;
}

function parseTableForCache(pubkey: string, data: Buffer): CachedTableState {
  return {
    pubkey,
    gameType:       data[OFF.GAME_TYPE],
    phase:          data[OFF.PHASE],
    phaseName:      PHASE_NAMES[data[OFF.PHASE]] ?? `Unknown(${data[OFF.PHASE]})`,
    currentPlayer:  data[OFF.CURRENT_PLAYER],
    maxPlayers:     data[OFF.MAX_PLAYERS],
    currentPlayers: data[OFF.CURRENT_PLAYERS],
    handNumber:     Number(data.readBigUInt64LE(OFF.HAND_NUMBER)),
    pot:            Number(data.readBigUInt64LE(OFF.POT)),
    smallBlind:     Number(data.readBigUInt64LE(OFF.SMALL_BLIND)),
    bigBlind:       Number(data.readBigUInt64LE(OFF.BIG_BLIND)),
    minBet:         Number(data.readBigUInt64LE(OFF.MIN_BET)),
    communityCards: Array.from(data.slice(OFF.COMMUNITY_CARDS, OFF.COMMUNITY_CARDS + 5)),
    dealerButton:   data[OFF.DEALER_BUTTON],
    smallBlindSeat: data[OFF.SMALL_BLIND_SEAT],
    bigBlindSeat:   data[OFF.BIG_BLIND_SEAT],
    lastActionSlot: Number(data.readBigUInt64LE(OFF.LAST_ACTION_SLOT)),
    seatsOccupied:  data.readUInt16LE(OFF.SEATS_OCCUPIED),
    seatsFolded:    data.readUInt16LE(OFF.SEATS_FOLDED),
    isDelegated:    data[OFF.IS_DELEGATED] !== 0,
    tokenMint:      data.length >= OFF.TOKEN_MINT + 32
                      ? new PublicKey(data.subarray(OFF.TOKEN_MINT, OFF.TOKEN_MINT + 32)).toBase58()
                      : PublicKey.default.toBase58(),
    actionNonce:    data.length >= OFF.ACTION_NONCE + 2
                      ? data.readUInt16LE(OFF.ACTION_NONCE)
                      : 0,
    authority:      new PublicKey(data.slice(OFF.AUTHORITY, OFF.AUTHORITY + 32)).toBase58(),
    creator:        data.length >= OFF.CREATOR + 32
                      ? new PublicKey(data.slice(OFF.CREATOR, OFF.CREATOR + 32)).toBase58()
                      : '',
    isUserCreated:  data.length > OFF.IS_USER_CREATED ? data[OFF.IS_USER_CREATED] === 1 : false,
    rakeAccumulated: data.length >= OFF.RAKE_ACCUMULATED + 8
                      ? Number(data.readBigUInt64LE(OFF.RAKE_ACCUMULATED)) : 0,
    rakeCap:        data.length >= OFF.RAKE_CAP + 8
                      ? Number(data.readBigUInt64LE(OFF.RAKE_CAP)) : 0,
    isPrivate:      data.length > OFF.IS_PRIVATE ? data[OFF.IS_PRIVATE] === 1 : false,
    tier:           data.length > OFF.TIER ? data[OFF.TIER] : 0,
    entryAmount:    data.length >= OFF.ENTRY_AMOUNT + 8
                      ? Number(data.readBigUInt64LE(OFF.ENTRY_AMOUNT)) : 0,
    feeAmount:      data.length >= OFF.FEE_AMOUNT + 8
                      ? Number(data.readBigUInt64LE(OFF.FEE_AMOUNT)) : 0,
    prizePool:      data.length >= OFF.PRIZE_POOL + 8
                      ? Number(data.readBigUInt64LE(OFF.PRIZE_POOL)) : 0,
    blindLevel:     data.length > OFF.BLIND_LEVEL ? data[OFF.BLIND_LEVEL] : 0,
    revealedHands:  Array.from(data.slice(OFF.REVEALED_HANDS, OFF.REVEALED_HANDS + 18)),
  };
}

function parseSeatForCache(data: Buffer): CachedSeatState | null {
  if (data.length < 245) return null;
  try {
    const player = new PublicKey(data.slice(SEAT_WALLET_OFFSET, SEAT_WALLET_OFFSET + 32));
    if (player.equals(PublicKey.default)) return null;
    const status = data[SEAT_STATUS_OFFSET];
    if (status === 0) return null; // SeatStatus::Empty
    return {
      player:           player.toBase58(),
      seatIndex:        data[226], // seat_number byte
      status,
      chips:            Number(data.readBigUInt64LE(SEAT_CHIPS_OFFSET)),
      betThisRound:     Number(data.readBigUInt64LE(112)),
      totalBetThisHand: Number(data.readBigUInt64LE(120)),
      sitOutButtonCount: data.length > SEAT_SIT_OUT_COUNT_OFFSET ? data[SEAT_SIT_OUT_COUNT_OFFSET] : 0,
      handsSinceBust:   data.length > SEAT_HANDS_SINCE_BUST ? data[SEAT_HANDS_SINCE_BUST] : 0,
      sitOutTimestamp:  data.length >= SEAT_SIT_OUT_TIMESTAMP_OFFSET + 8
                          ? Number(data.readBigInt64LE(SEAT_SIT_OUT_TIMESTAMP_OFFSET)) : 0,
      timeBankSeconds:  data.length >= 280 ? data.readUInt16LE(278) : 0,
      timeBankActive:   data.length > 280 ? data[280] === 1 : false,
    };
  } catch {
    return null;
  }
}

// ─── Phase 2A: Module-level state cache ───
const _stateCache: StateCache = { crank_timestamp: 0, tables: {} };
const _tableCacheNonces = new Map<string, string>();

function writeStateCache(now: number): void {
  try {
    _stateCache.crank_timestamp = now;
    fs.writeFileSync(crankConfig.state_cache_path, JSON.stringify(_stateCache), 'utf-8');
  } catch (e: any) {
    console.warn(`  ⚠️  Failed to write state cache: ${e?.message?.slice(0, 80)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// TX BUILDERS
// ═══════════════════════════════════════════════════════════════════

/**
 * settle_hand — called at Showdown (phase 6)
 * Accounts: settler, table, deck_state, ...seats, ...seat_cards
 * Only pass OCCUPIED seats — non-existent PDAs as writable fail on ER.
 */
function buildSettleIx(
  payer: PublicKey,
  table: PublicKey,
  maxPlayers: number,
  seatsOccupied: number,
  includeCrankTally: boolean = false,
): TransactionInstruction {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: false },
    { pubkey: table, isSigner: false, isWritable: true },
    { pubkey: getDeckStatePda(table), isSigner: false, isWritable: true },
  ];
  // First pass: occupied seat PDAs
  for (let i = 0; i < maxPlayers; i++) {
    if (seatsOccupied & (1 << i)) {
      keys.push({ pubkey: getSeatPda(table, i), isSigner: false, isWritable: true });
    }
  }
  // Second pass: occupied seat_cards PDAs (same order)
  for (let i = 0; i < maxPlayers; i++) {
    if (seatsOccupied & (1 << i)) {
      keys.push({ pubkey: getSeatCardsPda(table, i), isSigner: false, isWritable: true });
    }
  }
  // Optional CrankTallyER appended after seats+seat_cards (makes remaining_accounts odd)
  if (includeCrankTally) {
    keys.push({ pubkey: getCrankTallyErPda(table), isSigner: false, isWritable: true });
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: DISC.settleHand });
}

/**
 * start_game — called when phase == Waiting and enough players
 * Accounts: initiator, table, deck_state, ...seats
 * remaining_accounts: [seats...] — occupied seats only.
 * seatCards not needed here (start_game doesn't touch cards).
 */
function buildStartGameIx(
  payer: PublicKey,
  table: PublicKey,
  maxPlayers: number,
  seatsOccupied: number,
  gameType: number = 3, // default to cash game for backward compat
  includeCrankTally: boolean = false, // only include if CrankTallyER exists on TEE
): TransactionInstruction {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: false },
    { pubkey: table, isSigner: false, isWritable: true },
    { pubkey: getDeckStatePda(table), isSigner: false, isWritable: true },
  ];
  // remaining_accounts: [seats...] — occupied seats only, ascending order.
  // seatCards NOT included — they have private TEE permissions and the crank
  // must not reference them. See docs/TEE_ATOMIC_PERMISSION_FIX.md
  for (let i = 0; i < maxPlayers; i++) {
    if (seatsOccupied & (1 << i)) {
      keys.push({ pubkey: getSeatPda(table, i), isSigner: false, isWritable: true });
    }
  }

  // Append CrankTallyER so start_game records dealer actions.
  // Only include if the account exists on TEE — SNG tables may not have it initialized.
  // On-chain code validates by PDA seeds — silently skips if account doesn't exist.
  if (includeCrankTally) {
    const [crankTallyEr] = PublicKey.findProgramAddressSync(
      [Buffer.from('crank_tally_er'), table.toBuffer()],
      PROGRAM_ID,
    );
    keys.push({ pubkey: crankTallyEr, isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: DISC.startGame });
}


/**
 * delegate_table (L1) — permissionless delegation to ER.
 * data = discriminator(8) + table_id(32)
 *
 * remaining_accounts layout:
 *   Cash games: [TEE_VALIDATOR]
 *   SNG:        [TEE_VALIDATOR, deckState, seatCards0..N]
 *
 * For SNG, the contract verifies deckState + seatCards are already delegated
 * (owner == Delegation Program) before allowing table delegation.
 */
function buildDelegateTableIx(
  payer: PublicKey,
  table: PublicKey,
  tableId: Buffer,
  gameType: number = 3, // default to cash game
  maxPlayers: number = 2,
): TransactionInstruction {
  const tableRecord = delegationRecordPdaFromDelegatedAccount(table);
  const tableBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(table, PROGRAM_ID);
  const tableMetadata = delegationMetadataPdaFromDelegatedAccount(table);
  const data = Buffer.alloc(40);
  DISC.delegateTable.copy(data, 0);
  tableId.copy(data, 8);

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: tableBuffer, isSigner: false, isWritable: true },
    { pubkey: tableRecord, isSigner: false, isWritable: true },
    { pubkey: tableMetadata, isSigner: false, isWritable: true },
    { pubkey: table, isSigner: false, isWritable: true },
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // remaining_accounts[0] = TEE_VALIDATOR (always)
    { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
  ];

  // SNG delegation guard: add deckState + seatCards for verification
  const isSng = gameType >= 0 && gameType <= 2;
  if (isSng) {
    keys.push({ pubkey: getDeckStatePda(table), isSigner: false, isWritable: false });
    for (let i = 0; i < maxPlayers; i++) {
      keys.push({ pubkey: getSeatCardsPda(table, i), isSigner: false, isWritable: false });
    }
  }

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

/**
 * delegate_seat (L1) — permissionless delegation of a seat PDA.
 */
function buildDelegateSeatIx(
  payer: PublicKey,
  table: PublicKey,
  seatIndex: number,
): TransactionInstruction {
  const seat = getSeatPda(table, seatIndex);
  const seatRecord = delegationRecordPdaFromDelegatedAccount(seat);
  const seatBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(seat, PROGRAM_ID);
  const seatMetadata = delegationMetadataPdaFromDelegatedAccount(seat);
  const data = Buffer.alloc(9);
  DISC.delegateSeat.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: seatBuffer, isSigner: false, isWritable: true },
      { pubkey: seatRecord, isSigner: false, isWritable: true },
      { pubkey: seatMetadata, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * delegate_seat_cards (L1) — permissionless delegation of a seat_cards PDA.
 */
function buildDelegateSeatCardsIx(
  payer: PublicKey,
  table: PublicKey,
  seatIndex: number,
): TransactionInstruction {
  const seatCards = getSeatCardsPda(table, seatIndex);
  const seatCardsRecord = delegationRecordPdaFromDelegatedAccount(seatCards);
  const seatCardsBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(seatCards, PROGRAM_ID);
  const seatCardsMetadata = delegationMetadataPdaFromDelegatedAccount(seatCards);
  const data = Buffer.alloc(9);
  DISC.delegateSeatCards.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: seatCardsBuffer, isSigner: false, isWritable: true },
      { pubkey: seatCardsRecord, isSigner: false, isWritable: true },
      { pubkey: seatCardsMetadata, isSigner: false, isWritable: true },
      { pubkey: seatCards, isSigner: false, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * delegate_deck_state (L1) — delegates DeckState PDA to ER.
 */
function buildDelegateDeckStateIx(
  payer: PublicKey,
  table: PublicKey,
): TransactionInstruction {
  const deckState = getDeckStatePda(table);
  const deckRecord = delegationRecordPdaFromDelegatedAccount(deckState);
  const deckBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(deckState, PROGRAM_ID);
  const deckMetadata = delegationMetadataPdaFromDelegatedAccount(deckState);
  const data = Buffer.alloc(8);
  DISC.delegateDeckState.copy(data, 0);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: deckBuffer, isSigner: false, isWritable: true },
      { pubkey: deckRecord, isSigner: false, isWritable: true },
      { pubkey: deckMetadata, isSigner: false, isWritable: true },
      { pubkey: deckState, isSigner: false, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * delegate_permission (L1) — delegates Permission PDA for a SeatCards account to ER.
 * Our contract CPIs the Permission Program's delegatePermission, signing as seat_cards PDA.
 */
function buildDelegatePermissionIx(
  payer: PublicKey,
  table: PublicKey,
  seatIndex: number,
): TransactionInstruction {
  const seatCards = getSeatCardsPda(table, seatIndex);
  const permPda = getPermissionPda(seatCards);
  const permRecord = delegationRecordPdaFromDelegatedAccount(permPda);
  const permBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID);
  const permMetadata = delegationMetadataPdaFromDelegatedAccount(permPda);
  const data = Buffer.alloc(9);
  DISC.delegatePermission.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: false },
      { pubkey: seatCards, isSigner: false, isWritable: true },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: permBuffer, isSigner: false, isWritable: true },
      { pubkey: permRecord, isSigner: false, isWritable: true },
      { pubkey: permMetadata, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ═══ SNG economics PDA initialization (vault + crank tallies) ═══

function buildInitTableVaultIx(payer: PublicKey, table: PublicKey): TransactionInstruction {
  const vaultPda = getVaultPda(table);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: INIT_TABLE_VAULT_DISC,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

function buildInitCrankTallyErIx(payer: PublicKey, table: PublicKey): TransactionInstruction {
  const tallyPda = getCrankTallyErPda(table);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: INIT_CRANK_TALLY_ER_DISC,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: false },
      { pubkey: tallyPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

function buildInitCrankTallyL1Ix(payer: PublicKey, table: PublicKey): TransactionInstruction {
  const tallyPda = getCrankTallyL1Pda(table);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: INIT_CRANK_TALLY_L1_DISC,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: false },
      { pubkey: tallyPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

function buildDelegateCrankTallyIx(payer: PublicKey, table: PublicKey): TransactionInstruction {
  const tallyPda = getCrankTallyErPda(table);
  const tallyRecord = delegationRecordPdaFromDelegatedAccount(tallyPda);
  const tallyBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(tallyPda, PROGRAM_ID);
  const tallyMetadata = delegationMetadataPdaFromDelegatedAccount(tallyPda);
  const data = Buffer.alloc(40);
  DISC.delegateCrankTally.copy(data, 0);
  table.toBuffer().copy(data, 8); // table_key arg
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tallyBuffer, isSigner: false, isWritable: true },
      { pubkey: tallyRecord, isSigner: false, isWritable: true },
      { pubkey: tallyMetadata, isSigner: false, isWritable: true },
      { pubkey: tallyPda, isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ═══ Permission creation builders (L1→TEE SNG promotion) ═══

function buildCreateTablePermIx(payer: PublicKey, table: PublicKey): TransactionInstruction {
  const [permPda] = PublicKey.findProgramAddressSync([Buffer.from('permission:'), table.toBuffer()], PERMISSION_PROGRAM_ID);
  return new TransactionInstruction({
    programId: PROGRAM_ID, data: PERM_DISC.createTablePerm,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: false },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

function buildCreateDeckStatePermIx(payer: PublicKey, table: PublicKey): TransactionInstruction {
  const deckState = getDeckStatePda(table);
  const [permPda] = PublicKey.findProgramAddressSync([Buffer.from('permission:'), deckState.toBuffer()], PERMISSION_PROGRAM_ID);
  return new TransactionInstruction({
    programId: PROGRAM_ID, data: PERM_DISC.createDeckStatePerm,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: false },
      { pubkey: deckState, isSigner: false, isWritable: false },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

function buildCreateSeatPermIx(payer: PublicKey, table: PublicKey, seatIndex: number): TransactionInstruction {
  const seat = getSeatPda(table, seatIndex);
  const [permPda] = PublicKey.findProgramAddressSync([Buffer.from('permission:'), seat.toBuffer()], PERMISSION_PROGRAM_ID);
  const data = Buffer.alloc(9);
  PERM_DISC.createSeatPerm.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  return new TransactionInstruction({
    programId: PROGRAM_ID, data,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: false },
      { pubkey: seat, isSigner: false, isWritable: false },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

// ═══ Permission delegation builders (L1→TEE SNG promotion) ═══

function buildDelegateTablePermIx(payer: PublicKey, table: PublicKey): TransactionInstruction {
  const [permPda] = PublicKey.findProgramAddressSync([Buffer.from('permission:'), table.toBuffer()], PERMISSION_PROGRAM_ID);
  const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID);
  const rec = delegationRecordPdaFromDelegatedAccount(permPda);
  const meta = delegationMetadataPdaFromDelegatedAccount(permPda);
  return new TransactionInstruction({
    programId: PROGRAM_ID, data: PERM_DISC.delegateTablePerm,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: buf, isSigner: false, isWritable: true },
      { pubkey: rec, isSigner: false, isWritable: true },
      { pubkey: meta, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

function buildDelegateDeckStatePermIx(payer: PublicKey, table: PublicKey): TransactionInstruction {
  const deckState = getDeckStatePda(table);
  const [permPda] = PublicKey.findProgramAddressSync([Buffer.from('permission:'), deckState.toBuffer()], PERMISSION_PROGRAM_ID);
  const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID);
  const rec = delegationRecordPdaFromDelegatedAccount(permPda);
  const meta = delegationMetadataPdaFromDelegatedAccount(permPda);
  return new TransactionInstruction({
    programId: PROGRAM_ID, data: PERM_DISC.delegateDeckStatePerm,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: false },
      { pubkey: deckState, isSigner: false, isWritable: true },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: buf, isSigner: false, isWritable: true },
      { pubkey: rec, isSigner: false, isWritable: true },
      { pubkey: meta, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

function buildDelegateSeatPermIx(payer: PublicKey, table: PublicKey, seatIndex: number): TransactionInstruction {
  const seat = getSeatPda(table, seatIndex);
  const [permPda] = PublicKey.findProgramAddressSync([Buffer.from('permission:'), seat.toBuffer()], PERMISSION_PROGRAM_ID);
  const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID);
  const rec = delegationRecordPdaFromDelegatedAccount(permPda);
  const meta = delegationMetadataPdaFromDelegatedAccount(permPda);
  const data = Buffer.alloc(9);
  PERM_DISC.delegateSeatPerm.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  return new TransactionInstruction({
    programId: PROGRAM_ID, data,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: false },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: permPda, isSigner: false, isWritable: true },
      { pubkey: buf, isSigner: false, isWritable: true },
      { pubkey: rec, isSigner: false, isWritable: true },
      { pubkey: meta, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

/**
 * reset_sng_table — called after distribute_prizes on L1.
 * Zeros all seats + marker PDAs, resets table to Waiting phase for reuse.
 * Accounts: caller(signer), table, ...seat_pdas, ...marker_pdas (remaining)
 * 
 * seatWallets: wallet pubkeys read from each seat BEFORE reset (needed for marker PDA derivation).
 * For empty seats (wallet = default), pass the seat PDA itself as a dummy marker.
 */
function buildResetSngTableIx(
  payer: PublicKey,
  table: PublicKey,
  maxPlayers: number,
  seatWallets: PublicKey[],
): TransactionInstruction {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: table, isSigner: false, isWritable: true },
    { pubkey: getVaultPda(table), isSigner: false, isWritable: false },
  ];
  // First N: seat PDAs
  for (let i = 0; i < maxPlayers; i++) {
    keys.push({ pubkey: getSeatPda(table, i), isSigner: false, isWritable: true });
  }
  // Next N: marker PDAs (derived from seat wallets)
  for (let i = 0; i < maxPlayers; i++) {
    const wallet = seatWallets[i] || PublicKey.default;
    if (wallet.equals(PublicKey.default)) {
      // Empty seat — pass seat PDA as dummy (won't be validated since wallet=default)
      keys.push({ pubkey: getSeatPda(table, i), isSigner: false, isWritable: true });
    } else {
      const [markerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('player_table'), wallet.toBuffer(), table.toBuffer()],
        PROGRAM_ID,
      );
      keys.push({ pubkey: markerPda, isSigner: false, isWritable: true });
    }
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: DISC.resetSngTable });
}

/**
 * commit_and_undelegate_table — called at Complete (phase 7)
 * Accounts: payer(signer), table, magic_program, magic_context, ...seat_pdas (remaining)
 *
 * The on-chain handler makes INDIVIDUAL CPI calls to MagicBlock for each account:
 *   CPI 1: commit+undelegate table
 *   CPI 2..N: commit+undelegate each seat PDA
 * This avoids the multi-account CPI issue that broke MagicBlock before.
 *
 * Permissionless when phase == Complete.
 * Authority can force-undelegate at any phase (emergency escape hatch).
 */
function buildCommitAndUndelegateIx(
  payer: PublicKey,
  table: PublicKey,
  seatPdas: PublicKey[] = [],
): TransactionInstruction {
  const keys = [
    { pubkey: payer,                isSigner: true,  isWritable: true  },
    { pubkey: table,                isSigner: false, isWritable: true  },
    { pubkey: MAGIC_PROGRAM_ID,     isSigner: false, isWritable: false },
    { pubkey: MAGIC_CONTEXT_ID,     isSigner: false, isWritable: true  },
  ];
  // Seat PDAs as remaining_accounts (each gets individual CPI on-chain)
  for (const seat of seatPdas) {
    keys.push({ pubkey: seat, isSigner: false, isWritable: true });
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: DISC.commitAndUndelegateTable });
}

/**
 * process_cashout — permissionless L1 instruction to return SOL to a sitting-out player
 * Accounts: caller(signer,mut), table(mut), seat(mut), player_wallet(mut), marker_pda(mut), system_program
 */
function buildProcessCashoutIx(
  payer: PublicKey,
  table: PublicKey,
  seatIndex: number,
  playerWallet: PublicKey,
): TransactionInstruction {
  const seatPda = getSeatPda(table, seatIndex);
  const [markerPda] = PublicKey.findProgramAddressSync(
    [PLAYER_TABLE_SEED, playerWallet.toBuffer(), table.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(40);
  DISC.processCashout.copy(data, 0);
  playerWallet.toBuffer().copy(data, 8);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer,                    isSigner: true,  isWritable: true  },
      { pubkey: table,                    isSigner: false, isWritable: true  },
      { pubkey: seatPda,                  isSigner: false, isWritable: true  },
      { pubkey: playerWallet,             isSigner: false, isWritable: true  },
      { pubkey: markerPda,                isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * process_cashout_v2 — vault-based L1 instruction.
 * Contract reads cashout_chips/nonce/wallet from committed seat data — NO caller params.
 * Requires CommitState before calling to sync ER seat → L1.
 * Accounts: payer(signer,mut), table, seat, vault(mut), receipt(mut), player_wallet(mut), marker(mut), system_program
 */
function buildProcessCashoutV2Ix(
  payer: PublicKey,
  table: PublicKey,
  seatIndex: number,
  playerWallet: PublicKey,
  tokenMint?: PublicKey,         // SPL token mint (omit for SOL tables)
  playerTokenAccount?: PublicKey, // player's ATA for SPL tables
  tableTokenAccount?: PublicKey,  // table's escrow ATA for SPL tables
): TransactionInstruction {
  const seatPda = getSeatPda(table, seatIndex);
  const vaultPda = getVaultPda(table);
  const receiptPda = getReceiptPda(table, seatIndex);
  const markerPda = getPlayerTableMarkerPda(playerWallet, table);
  const isSpl = tokenMint && !tokenMint.equals(PublicKey.default);
  // discriminator(8) + seat_index(1) = 9 bytes
  const data = Buffer.alloc(9);
  DISC.processCashoutV2.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer,                    isSigner: true,  isWritable: true  },
      { pubkey: table,                    isSigner: false, isWritable: false },
      { pubkey: seatPda,                  isSigner: false, isWritable: false },
      { pubkey: vaultPda,                 isSigner: false, isWritable: true  },
      { pubkey: receiptPda,              isSigner: false, isWritable: true  },
      { pubkey: playerWallet,             isSigner: false, isWritable: true  },
      { pubkey: markerPda,                isSigner: false, isWritable: true  },
      // Optional SPL accounts
      { pubkey: isSpl ? playerTokenAccount! : PROGRAM_ID, isSigner: false, isWritable: !!isSpl },
      { pubkey: isSpl ? tableTokenAccount! : PROGRAM_ID,  isSigner: false, isWritable: !!isSpl },
      { pubkey: isSpl ? TOKEN_PROGRAM_ID : PROGRAM_ID,    isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * process_cashout_v3 — unified L1 cashout: transfers funds from vault AND clears seat in one TX.
 * No CommitState needed, no separate clear_leaving_seat. Replaces v2 flow entirely.
 * Accounts: payer(signer,mut), table(mut), seat(mut), vault(mut), receipt(mut), player_wallet(mut),
 *           marker(Option), player_token(Option), table_token(Option), token_program(Option), system_program
 */
function buildProcessCashoutV3Ix(
  payer: PublicKey,
  table: PublicKey,
  seatIndex: number,
  playerWallet: PublicKey,
  tokenMint?: PublicKey,
  playerTokenAccount?: PublicKey,
  tableTokenAccount?: PublicKey,
): TransactionInstruction {
  const seatPda = getSeatPda(table, seatIndex);
  const vaultPda = getVaultPda(table);
  const receiptPda = getReceiptPda(table, seatIndex);
  const markerPda = getPlayerTableMarkerPda(playerWallet, table);
  const isSpl = tokenMint && !tokenMint.equals(PublicKey.default);
  const data = Buffer.alloc(9);
  DISC.processCashoutV3.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer,                    isSigner: true,  isWritable: true  },
      { pubkey: table,                    isSigner: false, isWritable: true  },
      { pubkey: seatPda,                  isSigner: false, isWritable: true  },
      { pubkey: vaultPda,                 isSigner: false, isWritable: true  },
      { pubkey: receiptPda,               isSigner: false, isWritable: true  },
      { pubkey: playerWallet,             isSigner: false, isWritable: true  },
      { pubkey: markerPda,                isSigner: false, isWritable: true  },
      // Optional SPL accounts — use PROGRAM_ID sentinel for None
      { pubkey: isSpl ? playerTokenAccount! : PROGRAM_ID, isSigner: false, isWritable: !!isSpl },
      { pubkey: isSpl ? tableTokenAccount! : PROGRAM_ID,  isSigner: false, isWritable: !!isSpl },
      { pubkey: isSpl ? TOKEN_PROGRAM_ID : PROGRAM_ID,    isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * cleanup_deposit_proof — permissionless ER instruction to undelegate+close consumed DepositProof.
 * Prevents stale delegation-owned PDAs from blocking future deposit_for_join.
 */
function buildCleanupDepositProofIx(
  payer: PublicKey,
  table: PublicKey,
  seatIndex: number,
  /** Pass seat PDA for unconsumed proof recovery (seat must be Empty on TEE) */
  seatPdaForRecovery?: PublicKey,
): TransactionInstruction {
  const depositProofPda = getDepositProofPda(table, seatIndex);
  const data = Buffer.alloc(9);
  DISC.cleanupDepositProof.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  const keys = [
    { pubkey: payer,                    isSigner: true,  isWritable: true  },
    { pubkey: table,                    isSigner: false, isWritable: false },
    { pubkey: depositProofPda,          isSigner: false, isWritable: true  },
    { pubkey: MAGIC_PROGRAM_ID,         isSigner: false, isWritable: false },
    { pubkey: MAGIC_CONTEXT_ID,         isSigner: false, isWritable: true  },
  ];
  // For unconsumed proof recovery: pass seat PDA as remaining_account
  // Contract checks seat status == Empty before allowing cleanup
  if (seatPdaForRecovery) {
    keys.push({ pubkey: seatPdaForRecovery, isSigner: false, isWritable: false });
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

/**
 * reset_seat_permission — L1 instruction to lock seat_cards permission back to
 * PDA self-member (no external readers).
 * Permissionless — intended to run after seats are cleared/reset.
 * Must be called on L1 (permission PDA stays on L1, not delegated to TEE).
 */
function buildResetSeatPermissionIx(
  payer: PublicKey,
  table: PublicKey,
  seatIndex: number,
): TransactionInstruction {
  const seatCardsPda = getSeatCardsPda(table, seatIndex);
  const permPda = getPermissionPda(seatCardsPda);
  const data = Buffer.alloc(9);
  DISC.resetSeatPermission.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer,                    isSigner: true,  isWritable: false },
      { pubkey: table,                    isSigner: false, isWritable: false },
      { pubkey: seatCardsPda,             isSigner: false, isWritable: false },
      { pubkey: permPda,                  isSigner: false, isWritable: true  },
      { pubkey: PERMISSION_PROGRAM_ID,    isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * clear_leaving_seat — ER instruction to zero a Leaving seat after L1 cashout.
 * Accounts: payer(signer), table(mut), seat(mut), receipt(read — L1, never delegated)
 * Contract verifies receipt.last_processed_nonce >= seat.cashout_nonce (proves cashout happened).
 */
function buildClearLeavingSeatIx(
  payer: PublicKey,
  table: PublicKey,
  seatIndex: number,
): TransactionInstruction {
  const seatPda = getSeatPda(table, seatIndex);
  // TEE-safe: only delegated accounts (table + seat). No receipt, no permission accounts.
  // Receipt/permission checks removed from on-chain instruction — crank verifies off-chain.
  const data = Buffer.alloc(8);
  DISC.clearLeavingSeat.copy(data, 0);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer,                    isSigner: true,  isWritable: false },
      { pubkey: table,                    isSigner: false, isWritable: true  },
      { pubkey: seatPda,                  isSigner: false, isWritable: true  },
    ],
    data,
  });
}

/**
 * claim_unclaimed_sol — permissionless L1 instruction to return unclaimed SOL to a player
 * Accounts: caller(signer,mut), table(mut), unclaimed(mut), player_wallet(mut), system_program
 */
function buildClaimUnclaimedSolIx(
  payer: PublicKey,
  table: PublicKey,
  playerWallet: PublicKey,
): TransactionInstruction {
  const [unclaimedPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('unclaimed'), table.toBuffer(), playerWallet.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(40);
  DISC.claimUnclaimedSol.copy(data, 0);
  playerWallet.toBuffer().copy(data, 8);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer,                    isSigner: true,  isWritable: true  },
      { pubkey: table,                    isSigner: false, isWritable: true  },
      { pubkey: unclaimedPda,             isSigner: false, isWritable: true  },
      { pubkey: playerWallet,             isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * handle_timeout — called when current player has been idle too long
 * Accounts: caller, table, current_seat
 */
function buildHandleTimeoutIx(
  payer: PublicKey,
  table: PublicKey,
  currentPlayer: number,
  expectedNonce: number,
  includeCrankTally: boolean = false,
): TransactionInstruction {
  // Instruction data: 8-byte discriminator + 2-byte u16 LE expected_nonce
  const data = Buffer.alloc(10);
  DISC.handleTimeout.copy(data, 0);
  data.writeUInt16LE(expectedNonce & 0xFFFF, 8);
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: false },
    { pubkey: table, isSigner: false, isWritable: true },
    { pubkey: getSeatPda(table, currentPlayer), isSigner: false, isWritable: true },
  ];
  if (includeCrankTally) {
    keys.push({ pubkey: getCrankTallyErPda(table), isSigner: false, isWritable: true });
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

/**
 * misdeal — last-resort hand reset when settle cannot complete (e.g. missing seat_cards)
 * Accounts: caller(signer), table(mut), ...seats(mut)
 */
function buildMisdealIx(
  payer: PublicKey,
  table: PublicKey,
  maxPlayers: number,
): TransactionInstruction {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: false },
    { pubkey: table, isSigner: false, isWritable: true },
    { pubkey: getDeckStatePda(table), isSigner: false, isWritable: true },
  ];
  for (let i = 0; i < maxPlayers; i++) {
    keys.push({ pubkey: getSeatPda(table, i), isSigner: false, isWritable: true });
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: DISC.misdeal });
}

/**
 * distribute_prizes — called on L1 after undelegation (phase == Complete)
 * Accounts: caller(signer,mut), table(mut), steel_program, prize_authority,
 *           steel_pool(mut), treasury(mut), system_program,
 *           ...seats (remaining), ...itmPlayerPdas (remaining, mut),
 *           ...itmUnrefinedPdas (remaining, mut)
 * Permissionless + atomic: both SOL and POKER prizes distributed in one TX.
 */
function buildDistributePrizesIx(
  payer: PublicKey,
  table: PublicKey,
  maxPlayers: number,
  itmPlayerPdas: PublicKey[] = [],
  itmUnrefinedPdas: PublicKey[] = [],
): TransactionInstruction {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: table, isSigner: false, isWritable: true },
    { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: getPrizeAuthorityPda(), isSigner: false, isWritable: true },
    { pubkey: POOL_PDA, isSigner: false, isWritable: true },
    { pubkey: TREASURY, isSigner: false, isWritable: true },
    { pubkey: getVaultPda(table), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  // Seat PDAs (remaining_accounts — validated by on-chain PDA checks)
  for (let i = 0; i < maxPlayers; i++) {
    keys.push({ pubkey: getSeatPda(table, i), isSigner: false, isWritable: false });
  }
  // ITM Player PDAs (remaining_accounts, writable — receive SOL + claimable_sol update + stats)
  for (const pda of itmPlayerPdas) {
    keys.push({ pubkey: pda, isSigner: false, isWritable: true });
  }
  // ITM unrefined PDAs (remaining_accounts, writable — mandatory for atomic POKER credits)
  for (const pda of itmUnrefinedPdas) {
    keys.push({ pubkey: pda, isSigner: false, isWritable: true });
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: DISC.distributePrizes });
}

/**
 * crank_remove_player — remove inactive cash game player
 * Accounts: cranker(signer,mut), table(mut), seat(mut), unclaimed_balance(mut), system_program
 */
function buildCrankRemovePlayerIx(
  cranker: PublicKey,
  table: PublicKey,
  seat: PublicKey,
  unclaimedBalance: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: cranker, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: unclaimedBalance, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISC.crankRemovePlayer,
  });
}

/**
 * crank_kick_inactive — TEE-compatible kick for inactive cash game players.
 * Only modifies table + seat (both delegated). No new PDAs created.
 * Marks seat as Leaving + snapshots cashout. Existing cashout flow handles L1 payout.
 * Accounts: cranker(signer,mut), table(mut), seat(mut)
 */
function buildCrankKickInactiveIx(
  cranker: PublicKey,
  table: PublicKey,
  seat: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      // cranker NOT writable — non-delegated accounts can't be writable on TEE
      { pubkey: cranker, isSigner: true, isWritable: false },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
    ],
    data: DISC.crankKickInactive,
  });
}

/**
 * mint_unrefined — Steel program instruction to mint POKER tokens to a winner
 * Accounts: authority(signer,mut), unrefined(mut), pool(mut), mint,
 *           mint_authority, token_program, winner, system_program
 * Data: disc(1=4) + amount(u64 LE, 8) + tournament_id([u8;32])
 */
function buildMintUnrefinedIx(
  authority: PublicKey,
  winner: PublicKey,
  amount: bigint,
  tableId: Buffer,
): TransactionInstruction {
  const unrefinedPda = getUnrefinedPda(winner);
  const mintAuthPda = getMintAuthorityPda();

  // Data: 1 byte disc + 8 bytes amount + 32 bytes tournament_id = 41 bytes
  const data = Buffer.alloc(41);
  data.writeUInt8(MINT_UNREFINED_DISC, 0);
  data.writeBigUInt64LE(amount, 1);
  tableId.copy(data, 9, 0, 32); // Use table_id as tournament_id

  return new TransactionInstruction({
    programId: STEEL_PROGRAM_ID,
    keys: [
      { pubkey: authority,       isSigner: true,  isWritable: true  },
      { pubkey: unrefinedPda,    isSigner: false, isWritable: true  },
      { pubkey: POOL_PDA,        isSigner: false, isWritable: true  },
      { pubkey: POKER_MINT,      isSigner: false, isWritable: false },
      { pubkey: mintAuthPda,     isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,isSigner: false, isWritable: false },
      { pubkey: winner,          isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * record_poker_rake — Steel instruction for accounting (with token balance proof)
 * Updates pool's poker_rewards_available so stakers can claim POKER rake share.
 * Called after process_rake_distribution moves the 50% staker share to pool's POKER ATA.
 * SECURITY: Steel contract verifies pool's POKER ATA balance >= poker_rewards_available + amount.
 * Accounts: authority(signer), pool(mut), pool_poker_ata (balance proof)
 * Data: disc(1=26) + amount(u64 LE, 8)
 */
function buildRecordPokerRakeIx(
  authority: PublicKey,
  stakerShare: bigint,
  poolPokerAta: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(RECORD_POKER_RAKE_DISC, 0);
  data.writeBigUInt64LE(stakerShare, 1);

  return new TransactionInstruction({
    programId: STEEL_PROGRAM_ID,
    keys: [
      { pubkey: authority,    isSigner: true,  isWritable: true  },
      { pubkey: POOL_PDA,     isSigner: false, isWritable: true  },
      { pubkey: poolPokerAta, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ═══════════════════════════════════════════════════════════════════
// SEND + RETRY
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_TX_CU_LIMIT = 1_300_000;
const DEFAULT_TX_CU_PRICE_MICROLAMPORTS = 1;
const BACKEND_DIR = path.resolve(__dirname);
const CRANK_METRICS_PATH = process.env.CRANK_METRICS_PATH || path.join(BACKEND_DIR, 'crank-metrics.json');
const CRANK_HEARTBEAT_PATH = process.env.CRANK_HEARTBEAT_PATH || path.join(BACKEND_DIR, 'crank-heartbeat.json');
const CRANK_CONTROL_PATH = process.env.CRANK_CONTROL_PATH || path.join(BACKEND_DIR, 'crank-control.json');
const CRANK_CONFIG_PATH = process.env.CRANK_CONFIG_PATH || path.join(BACKEND_DIR, 'crank-config.json');

// ─── Crank Config (hot-reloadable) ───
interface CrankConfig {
  // Feature toggles
  process_cashouts: boolean;     // Process Leaving seats → vault cashout (default: true)
  auto_kick: boolean;            // Kick inactive SittingOut players (default: true)
  rake_sweep: boolean;           // Auto rake distribution sweep (default: false — admin-initiated)
  auction_sweep: boolean;        // Auto auction resolve sweep (default: true)
  timeout_enabled: boolean;      // Auto-fold on timeout (default: true)
  crank_sng: boolean;            // Crank SNG/tournament tables (default: true)
  crank_cash: boolean;           // Crank cash game tables (default: true)
  // Intervals (ms)
  removal_sweep_interval: number; // How often to sweep for inactive players (default: 30000)
  rake_sweep_interval: number;    // How often to sweep for rake (default: 60000)
  timeout_ms: number;             // Time before auto-fold (default: 20000)
  // RPC
  tee_rpc: string;               // Primary Solana RPC URL (legacy field name)
  l1_rpc: string;                 // L1 RPC URL
  // Table filtering
  table_filter_mode: 'none' | 'whitelist' | 'blacklist'; // none=crank all, whitelist=only listed, blacklist=skip listed
  table_whitelist: string[];  // Table pubkeys to exclusively crank (when mode=whitelist)
  table_blacklist: string[];  // Table pubkeys to skip (when mode=blacklist)
  // Keypairs (paths)
  crank_keypair_path: string;
  l1_payer_keypair_path: string;
  pool_authority_keypair_path: string;
  // Phase 2A: JSON file relay (for frontends that read from crank cache)
  state_cache_enabled: boolean;       // Write table-state-cache.json (default: false)
  state_cache_path: string;           // Path to write cache file
  state_cache_include_seats: boolean; // Include seat data in cache (default: true)
  // Phase 3: LaserStream L1 streaming (optional, requires Helius Professional)
  laserstream_enabled: boolean;       // Use LaserStream instead of L1 polling (default: false)
  laserstream_api_key: string;        // Helius API key for LaserStream (auto-extracted from l1_rpc if empty)
  laserstream_endpoint: string;       // LaserStream gRPC endpoint
  // Multi-validator config (overrides inline VALIDATORS when non-empty)
  validators: { name: string; pubkey: string; rpcUrl: string; wsUrl: string; isDefault?: boolean; note?: string }[];
  // Priority fee (microlamports per CU) for L1 transactions. 0 = no priority fee.
  // Higher values = faster inclusion but higher cost. Typical devnet: 1000-5000.
  priority_fee_microlamports: number;
  // Compute unit limit for arcium_deal CPI (expensive ~400K CU). 0 = use default.
  arcium_compute_units: number;
}

const DEFAULT_CRANK_CONFIG: CrankConfig = {
  process_cashouts: true,
  auto_kick: true,
  rake_sweep: false,
  auction_sweep: true,
  timeout_enabled: true,
  crank_sng: true,
  crank_cash: true,
  removal_sweep_interval: REMOVAL_SWEEP_INTERVAL_MS,
  rake_sweep_interval: RAKE_SWEEP_INTERVAL_MS,
  timeout_ms: TIMEOUT_MS,
  tee_rpc: RPC_BASE,
  l1_rpc: L1_RPC,
  table_filter_mode: 'none',
  table_whitelist: [],
  table_blacklist: [],
  crank_keypair_path: '',
  l1_payer_keypair_path: '',
  pool_authority_keypair_path: '',
  state_cache_enabled: true,
  state_cache_path: path.join(BACKEND_DIR, 'table-state-cache.json'),
  state_cache_include_seats: true,
  laserstream_enabled: false,
  laserstream_api_key: '',
  laserstream_endpoint: 'https://laserstream-devnet-ewr.helius-rpc.com',
  priority_fee_microlamports: Number(process.env.PRIORITY_FEE_MICROLAMPORTS || '0'),
  arcium_compute_units: Number(process.env.ARCIUM_COMPUTE_UNITS || '500000'),
  validators: [], // empty = use inline VALIDATORS
};

// Live config — hot-reloaded every heartbeat cycle (5s)
let crankConfig: CrankConfig = { ...DEFAULT_CRANK_CONFIG };

function loadCrankConfig(): CrankConfig {
  try {
    if (fs.existsSync(CRANK_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CRANK_CONFIG_PATH, 'utf-8'));
      return { ...DEFAULT_CRANK_CONFIG, ...raw };
    }
  } catch (e: any) {
    console.warn(`  ⚠️  Failed to load crank config: ${e.message?.slice(0, 80)}`);
  }
  return { ...DEFAULT_CRANK_CONFIG };
}

function saveCrankConfig(config: CrankConfig): void {
  try {
    fs.writeFileSync(CRANK_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch {}
}

// Initialize config on module load — write defaults if no config exists
crankConfig = loadCrankConfig();
if (!fs.existsSync(CRANK_CONFIG_PATH)) {
  saveCrankConfig(crankConfig);
}

interface DealerStats {
  operatorPubkey: string;
  lifetimeActions: number;
  lifetimeSolEarned: number;   // lamports
  lifetimeTokenEarned: number; // base units
  registeredAt: number;        // unix timestamp
  lastRefreshed: number;       // when we last read on-chain
}

interface CrankHeartbeat {
  pid: number;
  startedAt: number;
  heartbeat: number;
  status: 'running' | 'stopped';
  tablesTracked: number;
  tablesProcessing: number;
  recentErrors: string[];
  uptime: string;
  dealerStats?: DealerStats;
  dealMode: string;
}

let crankStartedAt = 0;
const recentCrankErrors: string[] = [];
const MAX_RECENT_ERRORS = 20;
let cachedDealerStats: DealerStats | null = null;
let dealerStatsLastRefresh = 0;
const DEALER_STATS_REFRESH_MS = 60_000; // read on-chain every 60s

function addCrankError(msg: string): void {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  recentCrankErrors.push(`[${ts}] ${msg.slice(0, 200)}`);
  if (recentCrankErrors.length > MAX_RECENT_ERRORS) recentCrankErrors.shift();
}

function checkControlFile(): 'stop' | 'restart' | null {
  try {
    if (!fs.existsSync(CRANK_CONTROL_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(CRANK_CONTROL_PATH, 'utf-8'));
    if (raw.action && raw.timestamp && Date.now() - raw.timestamp < 30_000) {
      // Consume the command by deleting the file
      fs.unlinkSync(CRANK_CONTROL_PATH);
      return raw.action as 'stop' | 'restart';
    }
    // Stale command (>30s old) — ignore and clean up
    if (raw.timestamp && Date.now() - raw.timestamp >= 30_000) {
      fs.unlinkSync(CRANK_CONTROL_PATH);
    }
    return null;
  } catch { return null; }
}

function writeCrankHeartbeat(trackedCount: number, processingCount: number, status: 'running' | 'stopped' = 'running'): void {
  try {
    const uptimeMs = Date.now() - crankStartedAt;
    const h = Math.floor(uptimeMs / 3600000);
    const m = Math.floor((uptimeMs % 3600000) / 60000);
    const hb: CrankHeartbeat & { config?: CrankConfig } = {
      pid: process.pid,
      startedAt: crankStartedAt,
      heartbeat: Date.now(),
      status,
      tablesTracked: trackedCount,
      tablesProcessing: processingCount,
      recentErrors: [...recentCrankErrors],
      uptime: `${h}h ${m}m`,
      dealerStats: cachedDealerStats ?? undefined,
      dealMode: 'arcium',
      config: { ...crankConfig },
    };
    fs.writeFileSync(CRANK_HEARTBEAT_PATH, JSON.stringify(hb, null, 2), 'utf-8');
  } catch {}
}

type CrankChain = 'ER' | 'L1';

interface CrankMetricsLabel {
  chain: CrankChain;
  count: number;
  costLamports: number;
  successCount?: number;
  failCount?: number;
}

interface CrankMetricsFile {
  updatedAt: number;
  totals: {
    erCranks: number;
    l1Cranks: number;
    totalCranks: number;
    erCostLamports: number;
    l1CostLamports: number;
    totalCostLamports: number;
    totalSuccess: number;
    totalFailed: number;
    simSaved: number; // TXs skipped by simulation (SOL saved)
  };
  byLabel: Record<string, CrankMetricsLabel>;
}

let crankMetricsFlushTimer: ReturnType<typeof setTimeout> | null = null;

function createEmptyCrankMetrics(): CrankMetricsFile {
  return {
    updatedAt: 0,
    totals: {
      erCranks: 0,
      l1Cranks: 0,
      totalCranks: 0,
      erCostLamports: 0,
      l1CostLamports: 0,
      totalCostLamports: 0,
      totalSuccess: 0,
      totalFailed: 0,
      simSaved: 0,
    },
    byLabel: {},
  };
}

function loadCrankMetrics(): CrankMetricsFile {
  try {
    if (!fs.existsSync(CRANK_METRICS_PATH)) return createEmptyCrankMetrics();
    const raw = JSON.parse(fs.readFileSync(CRANK_METRICS_PATH, 'utf-8'));
    const empty = createEmptyCrankMetrics();
    return {
      updatedAt: Number(raw?.updatedAt || 0),
      totals: {
        erCranks: Number(raw?.totals?.erCranks || 0),
        l1Cranks: Number(raw?.totals?.l1Cranks || 0),
        totalCranks: Number(raw?.totals?.totalCranks || 0),
        erCostLamports: Number(raw?.totals?.erCostLamports || 0),
        l1CostLamports: Number(raw?.totals?.l1CostLamports || 0),
        totalCostLamports: Number(raw?.totals?.totalCostLamports || 0),
        totalSuccess: Number(raw?.totals?.totalSuccess || 0),
        totalFailed: Number(raw?.totals?.totalFailed || 0),
        simSaved: Number(raw?.totals?.simSaved || 0),
      },
      byLabel: (raw?.byLabel && typeof raw.byLabel === 'object') ? raw.byLabel : empty.byLabel,
    };
  } catch {
    return createEmptyCrankMetrics();
  }
}

let crankMetrics: CrankMetricsFile = loadCrankMetrics();

function classifyCrankChain(conn: Connection): CrankChain {
  // Arcium architecture: all TXs are on Solana L1 (no ER/TEE distinction)
  return 'L1';
}

function flushCrankMetricsNow(): void {
  try {
    crankMetrics.updatedAt = Date.now();
    fs.writeFileSync(CRANK_METRICS_PATH, JSON.stringify(crankMetrics, null, 2), 'utf-8');
  } catch (e: any) {
    console.warn(`  ⚠️  Failed to persist crank metrics: ${e?.message?.slice(0, 80)}`);
  }
}

function scheduleCrankMetricsFlush(): void {
  if (crankMetricsFlushTimer) return;
  crankMetricsFlushTimer = setTimeout(() => {
    crankMetricsFlushTimer = null;
    flushCrankMetricsNow();
  }, 500);
}

function applyCrankMetric(chain: CrankChain, label: string, feeLamports: number): void {
  if (chain === 'ER') {
    crankMetrics.totals.erCranks += 1;
    crankMetrics.totals.erCostLamports += feeLamports;
  } else {
    crankMetrics.totals.l1Cranks += 1;
    crankMetrics.totals.l1CostLamports += feeLamports;
  }
  crankMetrics.totals.totalCranks += 1;
  crankMetrics.totals.totalCostLamports += feeLamports;
  crankMetrics.totals.totalSuccess += 1;

  const existing = crankMetrics.byLabel[label] || { chain, count: 0, costLamports: 0, successCount: 0, failCount: 0 };
  existing.chain = chain;
  existing.count += 1;
  existing.costLamports += feeLamports;
  existing.successCount = (existing.successCount || 0) + 1;
  crankMetrics.byLabel[label] = existing;

  scheduleCrankMetricsFlush();
}

function applyCrankFailure(conn: Connection, label: string): void {
  const chain = classifyCrankChain(conn);
  crankMetrics.totals.totalFailed += 1;
  const existing = crankMetrics.byLabel[label] || { chain, count: 0, costLamports: 0, successCount: 0, failCount: 0 };
  existing.chain = chain;
  existing.failCount = (existing.failCount || 0) + 1;
  crankMetrics.byLabel[label] = existing;
  scheduleCrankMetricsFlush();
}

function applyCrankSimSaved(): void {
  crankMetrics.totals.simSaved += 1;
  scheduleCrankMetricsFlush();
}

async function recordCrankTxMetrics(conn: Connection, label: string, sig: string): Promise<void> {
  const chain = classifyCrankChain(conn);
  try {
    const tx = await conn.getTransaction(sig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const feeLamports = Number(tx?.meta?.fee || 0);
    applyCrankMetric(chain, label, feeLamports);
  } catch {
    // Count tx even when fee lookup is unavailable.
    applyCrankMetric(chain, label, 0);
  }
}

function addComputeBudgetIxs(tx: Transaction, cuLimit?: number): void {
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit || DEFAULT_TX_CU_LIMIT }));
  const fee = crankConfig.priority_fee_microlamports || DEFAULT_TX_CU_PRICE_MICROLAMPORTS;
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }));
}

async function sendTx(
  conn: Connection,
  ix: TransactionInstruction,
  signer: Keypair,
  skipComputeBudget = false,
): Promise<string> {
  const tx = new Transaction();
  // TEE now supports ComputeBudget (verified 2025-02). Always include CU limit.
  const isTee = teeConnections.has(conn);
  addComputeBudgetIxs(tx);
  tx.add(ix);
  tx.feePayer = signer.publicKey;
  // TEE uses its own blockhash; L1 blockhashes cause "Blockhash not found"
  tx.recentBlockhash = isTee
    ? (await conn.getLatestBlockhash()).blockhash
    : (await l1ForBlockhash.getLatestBlockhash()).blockhash;
  tx.sign(signer);

  // Simulate L1 TXs before sending to avoid wasting SOL on known-failing TXs
  // TEE TXs are free — skip simulation for speed
  if (!isTee) {
    try {
      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) {
        applyCrankSimSaved();
        const errStr = JSON.stringify(sim.value.err);
        throw new Error(`Simulation failed: ${errStr}`);
      }
    } catch (simErr: any) {
      if (simErr.message?.startsWith('Simulation failed:')) throw simErr;
      // Non-simulation errors (network etc) — proceed anyway
    }
  }

  return conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
}

async function sendTxMultiIx(
  conn: Connection,
  ixs: TransactionInstruction[],
  signer: Keypair,
): Promise<string> {
  const tx = new Transaction();
  const isTee = teeConnections.has(conn);
  addComputeBudgetIxs(tx);
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = isTee
    ? (await conn.getLatestBlockhash()).blockhash
    : (await l1ForBlockhash.getLatestBlockhash()).blockhash;
  tx.sign(signer);
  if (!isTee) {
    try {
      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
    } catch (e: any) { if (e.message?.startsWith('Simulation failed:')) throw e; }
  }
  return conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
}

async function sendTxMultiSign(
  conn: Connection,
  ix: TransactionInstruction,
  feePayer: Keypair,
  signers: Keypair[],
): Promise<string> {
  const tx = new Transaction();
  const isTee = teeConnections.has(conn);
  addComputeBudgetIxs(tx);
  tx.add(ix);
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = isTee
    ? (await conn.getLatestBlockhash()).blockhash
    : (await l1ForBlockhash.getLatestBlockhash()).blockhash;
  tx.sign(feePayer, ...signers);
  if (!isTee) {
    try {
      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
    } catch (e: any) { if (e.message?.startsWith('Simulation failed:')) throw e; }
  }
  return conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
}

let lastSendError = ''; // Tracks last error from sendWithRetry for auto-blocklist detection

async function pollConfirmation(conn: Connection, sig: string, maxPollMs = 15000): Promise<{ confirmed: boolean; err: any }> {
  const start = Date.now();
  while (Date.now() - start < maxPollMs) {
    await sleep(300);
    try {
      const statuses = await conn.getSignatureStatuses([sig]);
      const s = statuses?.value?.[0];
      if (s?.err) return { confirmed: false, err: s.err };
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return { confirmed: true, err: null };
    } catch {}
  }
  return { confirmed: false, err: 'timeout' };
}

async function sendWithRetry(
  conn: Connection,
  ix: TransactionInstruction,
  signer: Keypair,
  label: string,
  maxAttempts = 3,
  skipComputeBudget = false,
  quietErrorCodes: number[] = [],
): Promise<boolean> {
  lastSendError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const sig = await sendTx(conn, ix, signer, skipComputeBudget);
      // Poll for confirmation via getSignatureStatuses (works on TEE, no WS needed)
      const { confirmed, err } = await pollConfirmation(conn, sig);
      if (err && err !== 'timeout') {
        lastSendError = JSON.stringify(err);
        // Check if this is a known-harmless "already done" error
        if (quietErrorCodes.length > 0) {
          const errStr = JSON.stringify(err);
          const isQuiet = quietErrorCodes.some(code => errStr.includes(`"Custom":${code}`));
          if (isQuiet) {
            console.log(`  ℹ️  ${label}: already handled (code in ${quietErrorCodes})`);
            return false;
          }
        }
        console.log(`  ❌ ${label} on-chain error (attempt ${attempt}): ${lastSendError}`);
        if (attempt < maxAttempts) { await sleep(1000); continue; }
        return false;
      }
      if (!confirmed) {
        console.log(`  ⚠️  ${label} confirm timeout (attempt ${attempt}), assuming sent: ${sig.slice(0, 20)}...`);
        void recordCrankTxMetrics(conn, `${label} (timeout)`, sig);
        return true;
      }
      await recordCrankTxMetrics(conn, label, sig);
      console.log(`  ✅ ${label} confirmed (attempt ${attempt}): ${sig.slice(0, 20)}...`);
      return true;
    } catch (e: any) {
      const msg = e?.message?.slice(0, 100) || String(e);
      // Check if simulation hit a known-harmless error code
      if (quietErrorCodes.length > 0 && quietErrorCodes.some(code => msg.includes(`"Custom":${code}`))) {
        console.log(`  ℹ️  ${label}: already handled (simulation matched quiet code)`);
        return false;
      }
      console.log(`  ❌ ${label} attempt ${attempt}/${maxAttempts}: ${msg}`);
      if (attempt < maxAttempts) {
        await sleep(1000);
      }
    }
  }
  const errDetail = lastSendError ? ` — ${lastSendError.slice(0, 100)}` : '';
  console.log(`  ⚠️  ${label} FAILED after ${maxAttempts} attempts${errDetail}`);
  applyCrankFailure(conn, label);
  addCrankError(`${label} FAILED after ${maxAttempts} attempts${errDetail}`);
  return false;
}

async function sendWithRetryMultiIx(
  conn: Connection,
  ixs: TransactionInstruction[],
  signer: Keypair,
  label: string,
  maxAttempts = 3,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const sig = await sendTxMultiIx(conn, ixs, signer);
      const { confirmed, err } = await pollConfirmation(conn, sig);
      if (err && err !== 'timeout') {
        console.log(`  ❌ ${label} on-chain error (attempt ${attempt}): ${JSON.stringify(err)}`);
        if (attempt < maxAttempts) { await sleep(1000); continue; }
        return false;
      }
      if (!confirmed) {
        console.log(`  ⚠️  ${label} confirm timeout (attempt ${attempt}): ${sig.slice(0, 20)}...`);
        if (attempt < maxAttempts) { await sleep(2000); continue; }
        return false;
      }
      await recordCrankTxMetrics(conn, label, sig);
      console.log(`  ✅ ${label} confirmed (attempt ${attempt}): ${sig.slice(0, 20)}...`);
      return true;
    } catch (e: any) {
      const msg = e?.message?.slice(0, 100) || String(e);
      console.log(`  ❌ ${label} attempt ${attempt}/${maxAttempts}: ${msg}`);
      if (attempt < maxAttempts) { await sleep(1000); }
    }
  }
  console.log(`  ⚠️  ${label} FAILED after ${maxAttempts} attempts`);
  applyCrankFailure(conn, label);
  addCrankError(`${label} FAILED (multi-ix) after ${maxAttempts} attempts`);
  return false;
}

async function sendWithRetryMultiSign(
  conn: Connection,
  ix: TransactionInstruction,
  feePayer: Keypair,
  signers: Keypair[],
  label: string,
  maxAttempts = 3,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const sig = await sendTxMultiSign(conn, ix, feePayer, signers);
      const { confirmed, err } = await pollConfirmation(conn, sig);
      if (err && err !== 'timeout') {
        console.log(`  ❌ ${label} on-chain error (attempt ${attempt}): ${JSON.stringify(err)}`);
        if (attempt < maxAttempts) { await sleep(1000); continue; }
        return false;
      }
      if (!confirmed) {
        console.log(`  ⚠️  ${label} confirm timeout (attempt ${attempt}), assuming sent: ${sig.slice(0, 20)}...`);
        void recordCrankTxMetrics(conn, `${label} (timeout)`, sig);
        return true;
      }
      await recordCrankTxMetrics(conn, label, sig);
      console.log(`  ✅ ${label} confirmed (attempt ${attempt}): ${sig.slice(0, 20)}...`);
      return true;
    } catch (e: any) {
      const msg = e?.message?.slice(0, 100) || String(e);
      console.log(`  ❌ ${label} attempt ${attempt}/${maxAttempts}: ${msg}`);
      if (attempt < maxAttempts) {
        await sleep(1000);
      }
    }
  }
  console.log(`  ⚠️  ${label} FAILED after ${maxAttempts} attempts`);
  applyCrankFailure(conn, label);
  addCrankError(`${label} FAILED after ${maxAttempts} attempts: ${lastSendError}`);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


// CRANK SERVICE
// ═══════════════════════════════════════════════════════════════════

class CrankService {
  private conn: Connection;   // Primary Solana RPC connection
  private l1: Connection;     // L1 connection (for distribute_prizes, cashouts)
  private payer: Keypair;     // Crank tx signer (must be funded for tx fees)
  private teePayer: Keypair;  // Alias for payer (legacy compat — always same as payer)
  private l1Payer: Keypair | null = null; // L1 payer (defaults to payer when available)
  private poolAuthority: Keypair | null = null; // Steel pool authority (mint_unrefined + record_poker_rake)
  private subId: number | null = null;

  /** Get the RPC connection for a specific table. */
  private getConnForTable(_tableKey: string): Connection {
    return this.conn;
  }

  // Track per-table state to detect phase changes + adaptive poll timing
  private tablePhases = new Map<string, { phase: number; handNumber: number; currentPlayers: number; lastPollAt: number }>();

  // Adaptive poll intervals by phase/player count (Phase 1A RPC optimization)
  private getAdaptivePollInterval(phase: number, currentPlayers: number): number {
    switch (phase) {
      case Phase.Waiting:
        return currentPlayers === 0 ? 10_000 : 3_000; // idle=10s, between hands=3s
      case Phase.Complete:
        return 5_000; // completed tables poll slowly
      case Phase.Preflop:
      case Phase.Flop:
      case Phase.Turn:
      case Phase.River:
      case Phase.Showdown:
      case Phase.Starting:
      case Phase.AwaitingDeal:
      case Phase.AwaitingShowdown:
      case Phase.FlopRevealPending:
      case Phase.TurnRevealPending:
      case Phase.RiverRevealPending:
        return CrankService.POLL_INTERVAL_MS; // active = 1.5s
      default:
        return CrankService.POLL_INTERVAL_MS;
    }
  }

  // Track when each table's current player turn started (wall-clock ms)
  // Key: table base58, Value: { currentPlayer, turnStartMs, tablePda, maxPlayers }
  private turnTimers = new Map<string, {
    currentPlayer: number;
    turnStartMs: number;
    tablePda: PublicKey;
    maxPlayers: number;
  }>();
  private timeoutIntervalId: ReturnType<typeof setInterval> | null = null;

  private sweepIntervalId: ReturnType<typeof setInterval> | null = null;
  private rakeSweepIntervalId: ReturnType<typeof setInterval> | null = null;
  private removalSweepIntervalId: ReturnType<typeof setInterval> | null = null;
  private auctionSweepIntervalId: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;

  // Phase 3: LaserStream L1 gRPC subscription (replaces L1 polling when enabled)
  private l1Stream: L1Stream | null = null;
  // Cache of L1 account data received via LaserStream (keyed by pubkey base58)
  private l1TableCache = new Map<string, { data: Buffer; slot: number; owner: string; updatedAt: number }>();

  // Cooldown: skip start_game for tables with < 2 players (prevents spam logs)
  // Key: table base58, Value: unix ms when cooldown expires
  private startGameCooldown = new Map<string, number>();

  // Prevent concurrent cranking of the same table
  private processing = new Set<string>();

  // Debounce duplicate VRF requests for the same table/hand/phase.
  // This avoids duplicate request_deal_vrf races while callbacks are still propagating.
  private lastVrfRequest = new Map<string, { hand: number; phase: number; atMs: number }>();

  // Track transient crank failures and apply retry backoff
  private failCount = new Map<string, number>();
  private failBackoffUntil = new Map<string, number>(); // key -> unix ms
  // Tables permanently blocked (e.g. delegated to wrong ER validator)
  private blockedTables = new Set<string>();
  // Cache: whether CrankTallyER is delegated to TEE (checked once per table)
  private crankTallyDelegated = new Map<string, boolean>();

  /** Check if CrankTallyER is delegated to TEE for this table (cached).
   *  Only caches TRUE — false results are re-checked each time because
   *  delegation may happen after the crank first discovers the table. */
  private async hasCrankTallyOnTee(tablePda: PublicKey): Promise<boolean> {
    // LOCAL_MODE: no delegation — check if tally PDA exists at all
    if (LOCAL_MODE) {
      const key = tablePda.toBase58();
      if (this.crankTallyDelegated.get(key) === true) return true;
      try {
        const tallyPda = getCrankTallyErPda(tablePda);
        const info = await this.l1.getAccountInfo(tallyPda);
        const exists = !!info && info.data.length > 0;
        if (exists) this.crankTallyDelegated.set(key, true);
        return exists;
      } catch { return false; }
    }
    const key = tablePda.toBase58();
    if (this.crankTallyDelegated.get(key) === true) return true;
    try {
      const tallyPda = getCrankTallyErPda(tablePda);
      const tallyL1Info = await this.l1.getAccountInfo(tallyPda);
      const delegated = !!tallyL1Info && tallyL1Info.owner.equals(DELEGATION_PROGRAM_ID);
      if (delegated) this.crankTallyDelegated.set(key, true);
      return delegated;
    } catch {
      return false;
    }
  }

  /** Check if a table is filtered out by config blacklist/whitelist. Returns true if table should be SKIPPED. */
  private isTableFiltered(key: string): boolean {
    if (crankConfig.table_filter_mode === 'whitelist' && crankConfig.table_whitelist.length > 0) {
      return !crankConfig.table_whitelist.includes(key);
    }
    if (crankConfig.table_filter_mode === 'blacklist' && crankConfig.table_blacklist.length > 0) {
      return crankConfig.table_blacklist.includes(key);
    }
    return false;
  }
  private static readonly BASE_BACKOFF_MS = 5_000;
  private static readonly MAX_BACKOFF_MS = 120_000;
  private static readonly WRONG_ER_BLOCK_THRESHOLD = 5;

  // Reconnect bookkeeping
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private alive = true;
  private healthFailCount = 0;
  private static readonly HEALTH_FAIL_THRESHOLD = 3; // consecutive failures before reconnect
  private lastReconnectAt = 0;
  private static readonly MIN_RECONNECT_INTERVAL_MS = 60_000; // at most once per 60s

  constructor() {
    // Primary Solana RPC connection for reading table state and sending crank TXs.
    this.conn = new Connection(RPC_BASE, 'confirmed');
    teeConnectionRef = this.conn;
    teeConnections.add(this.conn);
    this.l1 = new Connection(L1_RPC, 'confirmed');

    const resolveKeypairPath = (preferred: string | undefined, fallbacks: string[]): string | null => {
      if (preferred && fs.existsSync(preferred)) return preferred;
      for (const p of fallbacks) {
        if (fs.existsSync(p)) return p;
      }
      return null;
    };

    // IMPORTANT: Never use deployer/super-admin key here. Crank has ZERO admin privileges.
    const keypairFallbacks = [
      // Poker-Arc localnet paths (LOCAL_MODE) — use __dirname for WSL compat
      path.join(BACKEND_DIR, '.localnet-keypair.json'),
      path.join(BACKEND_DIR, 'crank-keypair.json'),
      // Legacy Poker paths (cross-project, kept for backwards compat)
      '/mnt/j/Poker/contracts/auth/deployers/crank-keypair.json',
      '/mnt/j/Poker/backend/crank-keypair.json',
      '/mnt/j/Poker/tests/authority-keypair.json',
    ];

    const payerPath = resolveKeypairPath(
      process.env.CRANK_KEYPAIR || process.env.PAYER_KEYPAIR,
      keypairFallbacks,
    );
    if (payerPath) {
      const keyData = JSON.parse(fs.readFileSync(payerPath, 'utf-8'));
      this.payer = Keypair.fromSecretKey(new Uint8Array(keyData));
      console.log(`  Payer   : ${this.payer.publicKey.toBase58()} (${payerPath})`);
    } else {
      this.payer = Keypair.generate();
      console.warn('  ⚠️  No crank payer keypair found — generated ephemeral signer (likely unfunded)');
    }

    // Arcium MPC architecture: single persistent signer for all crank TXs.
    // CrankTally records this pubkey for distribute_crank_rewards.
    // (teePayer kept as alias for backward compat — always same as payer)
    this.teePayer = this.payer;
    console.log(`  Dealer  : ${this.payer.publicKey.toBase58()} (crank operator signer)`);

    // L1 payer for distribute_prizes/close_table/cashouts.
    // Prefer explicit L1 key, then shared crank payer path.
    const l1Path = resolveKeypairPath(
      process.env.L1_PAYER_KEYPAIR,
      [
        ...(payerPath ? [payerPath] : []),
        ...keypairFallbacks,
      ],
    );
    if (l1Path) {
      const keyData = JSON.parse(fs.readFileSync(l1Path, 'utf-8'));
      this.l1Payer = Keypair.fromSecretKey(new Uint8Array(keyData));
      console.log(`  L1 Payer: ${this.l1Payer.publicKey.toBase58()} (${l1Path})`);
    } else if (payerPath) {
      this.l1Payer = this.payer;
      console.log('  L1 Payer: using crank payer fallback');
    } else {
      console.warn('  ⚠️  No L1 payer keypair found — L1 prize/cashout/rake operations will be skipped');
    }

    // Pool authority for Steel program (SNG: mint_unrefined, Cash: record_poker_rake)
    // Try multiple known locations for player1.json
    try {
      const poolKeyPath = process.env.POOL_AUTHORITY_KEYPAIR
        || ['j:/Poker/tests/keys/player1.json', 'j:/Poker/tests/keypairs/player1.json', 'j:/Poker/tests/player1-keypair.json']
            .find((p: string) => fs.existsSync(p));
      if (poolKeyPath) {
        const keyData = JSON.parse(fs.readFileSync(poolKeyPath, 'utf-8'));
        const kp = Keypair.fromSecretKey(new Uint8Array(keyData));
        if (kp.publicKey.equals(EXPECTED_POOL_AUTHORITY)) {
          this.poolAuthority = kp;
          console.log(`  Pool Auth: ${kp.publicKey.toBase58()} ✅`);
        } else {
          console.warn(`  ⚠️  Loaded keypair ${kp.publicKey.toBase58()} but expected ${EXPECTED_POOL_AUTHORITY.toBase58()}`);
          // Use it anyway — might be a different pool setup
          this.poolAuthority = kp;
        }
      }
    } catch (e: any) {
      console.warn(`  ⚠️  No pool authority keypair found — Steel instructions will be skipped`);
    }
  }

  private isInBackoff(key: string): boolean {
    const until = this.failBackoffUntil.get(key) ?? 0;
    return until > Date.now();
  }

  private noteFailure(key: string, context: string, errorMsg?: string): void {
    const fails = (this.failCount.get(key) || 0) + 1;
    this.failCount.set(key, fails);

    // Auto-block tables permanently stuck on wrong ER validator
    if (errorMsg?.includes('InvalidWritableAccount') && fails >= CrankService.WRONG_ER_BLOCK_THRESHOLD) {
      this.blockedTables.add(key);
      console.log(
        `  🚫 ${key.slice(0, 12)}... BLOCKED — ${fails}x InvalidWritableAccount (delegated to wrong ER validator)`,
      );
      return;
    }

    const backoffMs = Math.min(
      CrankService.MAX_BACKOFF_MS,
      CrankService.BASE_BACKOFF_MS * Math.max(1, fails),
    );
    this.failBackoffUntil.set(key, Date.now() + backoffMs);

    console.log(
      `  ⏱️  ${key.slice(0, 12)}... ${context} failed (#${fails}) — retry in ${Math.ceil(backoffMs / 1000)}s`,
    );
  }

  private clearFailure(key: string): void {
    this.failCount.delete(key);
    this.failBackoffUntil.delete(key);
  }

  /**
   * Self-heal path for ER writable failures:
   * permissionlessly re-delegate table + seat + seat_cards on L1.
   */
  private async tryRedelegateForEr(tablePda: PublicKey, maxPlayers: number): Promise<boolean> {
    const tag = tablePda.toBase58().slice(0, 8);
    if (!this.l1Payer) {
      console.log(`  ⚠️  [${tag}] Cannot re-delegate: no L1 payer configured`);
      return false;
    }

    const tableL1 = await this.l1.getAccountInfo(tablePda);
    if (!tableL1 || tableL1.data.length < OFF.TABLE_ID + 32) {
      console.log(`  ⚠️  [${tag}] Cannot re-delegate: table missing on L1`);
      return false;
    }

    const tableId = Buffer.from(tableL1.data.slice(OFF.TABLE_ID, OFF.TABLE_ID + 32));
    const resolvedMaxPlayers = tableL1.data.length > OFF.MAX_PLAYERS
      ? tableL1.data[OFF.MAX_PLAYERS]
      : maxPlayers;

    const gameType = tableL1.data.length > OFF.GAME_TYPE ? tableL1.data[OFF.GAME_TYPE] : 3;
    console.log(`  🛠️  [${tag}] Re-delegating table + accounts on L1 (${Math.max(maxPlayers, resolvedMaxPlayers)} seats, gameType=${gameType})...`);
    // Skip if table already delegated (owner = Delegation Program)
    if (tableL1.owner.equals(DELEGATION_PROGRAM_ID)) {
      console.log(`  ⏭️  [${tag}] table already delegated — skipping`);
    } else {
      const tableIx = buildDelegateTableIx(this.l1Payer.publicKey, tablePda, tableId, gameType, resolvedMaxPlayers);
      await sendWithRetry(this.l1, tableIx, this.l1Payer, `[${tag}] delegate_table`);
    }

    const seatCount = Math.max(maxPlayers, resolvedMaxPlayers);
    for (let i = 0; i < seatCount; i++) {
      const seatPda = getSeatPda(tablePda, i);
      const seatCardsPda = getSeatCardsPda(tablePda, i);

      try {
        const seatInfo = await this.l1.getAccountInfo(seatPda);
        if (seatInfo) {
          // Skip if already delegated (owner = Delegation Program) — prevents ExternalAccountDataModified
          if (seatInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
            console.log(`  ⏭️  [${tag}] seat[${i}] already delegated — skipping`);
          } else {
            const seatIx = buildDelegateSeatIx(this.l1Payer.publicKey, tablePda, i);
            await sendWithRetry(this.l1, seatIx, this.l1Payer, `[${tag}] delegate_seat[${i}]`);
          }
        }
      } catch {}

      try {
        const seatCardsInfo = await this.l1.getAccountInfo(seatCardsPda);
        if (seatCardsInfo) {
          // Skip if already delegated
          if (seatCardsInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
            console.log(`  ⏭️  [${tag}] seat_cards[${i}] already delegated — skipping`);
          } else {
            const seatCardsIx = buildDelegateSeatCardsIx(this.l1Payer.publicKey, tablePda, i);
            await sendWithRetry(this.l1, seatCardsIx, this.l1Payer, `[${tag}] delegate_seat_cards[${i}]`);
          }
        }
      } catch {}

      // SeatCards permission PDAs must NOT be delegated to TEE.
      // They stay on L1 so deposit_for_join can update them atomically.
      // TEE reads undelegated permissions from L1 for access control.
      // See docs/TEE_ATOMIC_PERMISSION_FIX.md
    }

    // Delegate DeckState PDA — owner check
    try {
      const deckState = getDeckStatePda(tablePda);
      const deckStateInfo = await this.l1.getAccountInfo(deckState);
      if (deckStateInfo && deckStateInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
        console.log(`  ⏭️  [${tag}] deckState already delegated — skipping`);
      } else if (deckStateInfo) {
        const deckIx = buildDelegateDeckStateIx(this.l1Payer.publicKey, tablePda);
        await sendWithRetry(this.l1, deckIx, this.l1Payer, `[${tag}] delegate_deck_state`);
      }
    } catch {}

    // Give ER time to reflect delegation records.
    await sleep(4000);
    return true;
  }

  // ─────────────────────────── Lifecycle ───────────────────────────

  async start(): Promise<void> {
    console.log('═'.repeat(60));
    console.log(`🃏 FAST POKER — DEALER CRANK SERVICE (Arcium MPC)`);
    console.log('═'.repeat(60));

    if (LOCAL_MODE) {
      console.log('🏠 LOCAL MODE — skipping delegation, LaserStream');
    }
    console.log(`  DEAL_MODE: arcium (MPC encrypted)`);
    console.log(`  RPC    : ${RPC_BASE}`);
    console.log(`  L1 RPC : ${L1_RPC}`);
    console.log(`  Payer  : ${this.payer.publicKey.toBase58()}`);
    console.log(`  L1Pay  : ${this.l1Payer?.publicKey.toBase58() || 'NONE'}`);
    console.log(`  PoolAuth: ${this.poolAuthority?.publicKey.toBase58() || 'NONE'}`);
    console.log(`  Steel  : ${STEEL_PROGRAM_ID.toBase58()}`);
    console.log(`  Program: ${PROGRAM_ID.toBase58()}`);  
    console.log(`  Timeout: ${TIMEOUT_MS / 1000}s auto-fold`);
    console.log(`  Table discriminator: ${bs58.encode(TABLE_DISCRIMINATOR)}`);
    console.log('');

    // 0. Auto-register CrankOperator PDA if not already registered
    await this.ensureCrankOperatorRegistered();

    // 1. Initial scan — pick up any tables already needing cranks
    await this.initialScan();

    // 2. Subscribe to live updates
    this.subscribe();

    // 3. Health-check loop (detects WS disconnect)
    this.healthLoop();

    // 4. Start periodic timeout checker
    this.startTimeoutChecker();

    // 5. Start periodic sweep for stuck tables (safety net)
    this.startSweep();

    // 6. Rake distribution sweep (gated by config flag, default: off)
    if (crankConfig.rake_sweep) this.startRakeSweep();

    // 7. Start periodic cash game inactive player removal sweep
    this.startRemovalSweep();

    // 8. Start periodic auction resolve sweep (permissionless)
    this.startAuctionSweep();

    // 9. Phase 3: Start LaserStream L1 gRPC subscription (replaces L1 polling when enabled)
    //    API key auto-extracted from existing Helius L1 RPC URL if not explicitly set
    if (crankConfig.laserstream_enabled) {
      const apiKey = crankConfig.laserstream_api_key || extractHeliusApiKey(crankConfig.l1_rpc || L1_RPC);
      if (apiKey) {
        crankConfig.laserstream_api_key = apiKey;
        this.startL1Stream();
      } else {
        console.log('⚠️  LaserStream enabled but no Helius API key found in l1_rpc — falling back to L1 polling');
      }
    }

    // 10. Start heartbeat writer + control file polling + config hot-reload (every 5s)
    crankStartedAt = Date.now();
    console.log(`📋 Config: cashouts=${crankConfig.process_cashouts}, kick=${crankConfig.auto_kick}, rake=${crankConfig.rake_sweep}, timeout=${crankConfig.timeout_enabled}`);
    writeCrankHeartbeat(this.tablePhases.size, this.processing.size);
    this.heartbeatIntervalId = setInterval(() => {
      writeCrankHeartbeat(this.tablePhases.size, this.processing.size);
      // Refresh on-chain dealer stats (throttled to every 60s internally)
      this.refreshDealerStats().catch(() => {});
      // Hot-reload config
      crankConfig = loadCrankConfig();
      // Poll for admin control commands
      const cmd = checkControlFile();
      if (cmd === 'stop') {
        console.log('\n🛑 STOP command received from admin — shutting down...');
        this.stop();
        process.exit(0);
      } else if (cmd === 'restart') {
        console.log('\n🔄 RESTART command received from admin — shutting down for restart...');
        this.stop();
        process.exit(75); // Exit code 75 = restart requested
      }
    }, 5_000);

    console.log('\n🟢 Service running. Ctrl+C to stop.\n');
  }

  stop(): void {
    this.alive = false;
    if (this.heartbeatIntervalId) clearInterval(this.heartbeatIntervalId);
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.timeoutIntervalId) {
      clearInterval(this.timeoutIntervalId);
    }
    if (this.sweepIntervalId) {
      clearInterval(this.sweepIntervalId);
    }
    if (this.rakeSweepIntervalId) {
      clearInterval(this.rakeSweepIntervalId);
    }
    if (this.removalSweepIntervalId) {
      clearInterval(this.removalSweepIntervalId);
    }
    if (this.auctionSweepIntervalId) {
      clearInterval(this.auctionSweepIntervalId);
    }
    if (this.l1Stream) {
      this.l1Stream.stop();
      this.l1Stream = null;
    }
    writeCrankHeartbeat(0, 0, 'stopped');
    flushCrankMetricsNow();
    console.log('🔴 Service stopped.');
  }

  // ───────────────────── Phase 3: LaserStream L1 gRPC ─────────────────────────

  private startL1Stream(): void {
    const streamConfig = {
      apiKey: crankConfig.laserstream_api_key,
      endpoint: crankConfig.laserstream_endpoint,
      programId: PROGRAM_ID.toBase58(),
      delegationProgramId: DELEGATION_PROGRAM_ID.toBase58(),
      tableDiscriminatorB58: bs58.encode(TABLE_DISCRIMINATOR),
      tableSize: 437,
      treasuryPubkey: TREASURY.toBase58(),
      poolPubkey: POOL_PDA.toBase58(),
    };

    this.l1Stream = new L1Stream(streamConfig);

    // ── Event handlers ──

    // Table account changed on L1 (program-owned or delegated)
    this.l1Stream.on('table-update', (update: L1AccountUpdate) => {
      this.l1TableCache.set(update.pubkey, {
        data: update.data,
        slot: update.slot,
        owner: update.owner,
        updatedAt: Date.now(),
      });

      // Auto-discover: if this table isn't tracked yet, register it
      if (!this.tablePhases.has(update.pubkey) && update.data.length >= 256) {
        try {
          const state = parseTable(update.data);
          this.tablePhases.set(update.pubkey, {
            phase: state.phase,
            handNumber: state.handNumber,
            currentPlayers: state.currentPlayers,
            lastPollAt: Date.now(),
          });
          const phaseName = PHASE_NAMES[state.phase] ?? state.phase;
          console.log(`[LaserStream] 🆕 Auto-discovered table: ${update.pubkey.slice(0, 12)}... phase=${phaseName} players=${state.currentPlayers}`);

          // Phase 3D: Dynamically subscribe to this table's vault
          const vaultPda = getVaultPda(new PublicKey(update.pubkey));
          this.l1Stream?.addVaultSubscription(vaultPda.toBase58());
        } catch {}
      }
    });

    // Treasury balance changed
    this.l1Stream.on('treasury-update', (update: L1AccountUpdate) => {
      this.l1TableCache.set(update.pubkey, {
        data: update.data,
        slot: update.slot,
        owner: update.owner,
        updatedAt: Date.now(),
      });
    });

    // Pool balance changed
    this.l1Stream.on('pool-update', (update: L1AccountUpdate) => {
      this.l1TableCache.set(update.pubkey, {
        data: update.data,
        slot: update.slot,
        owner: update.owner,
        updatedAt: Date.now(),
      });
    });

    // Vault balance changed (Phase 3D)
    this.l1Stream.on('vault-update', (update: L1AccountUpdate) => {
      this.l1TableCache.set(update.pubkey, {
        data: update.data,
        slot: update.slot,
        owner: update.owner,
        updatedAt: Date.now(),
      });
    });

    // Phase 3C: Program transaction events — event-driven L1 awareness
    this.l1Stream.on('program-tx', (update: { signature: string; slot: number; label: string }) => {
      // Log for observability; future: parse Anchor event logs for
      // RakeDistributed, PrizesDistributed, PlayerJoined/Left, etc.
      // to drive immediate state reactions instead of periodic sweeps.
      if (crankConfig.laserstream_enabled) {
        console.log(`[LaserStream] 📝 L1 TX: ${update.signature.slice(0, 20)}... slot=${update.slot}`);
      }
    });

    this.l1Stream.on('connected', () => {
      console.log('[LaserStream] ✅ Stream connected — L1 polling will use cache');
    });

    this.l1Stream.on('error', (err: Error) => {
      console.warn(`[LaserStream] ❌ Error: ${err.message?.slice(0, 100)}`);
    });

    this.l1Stream.on('reconnecting', () => {
      console.log('[LaserStream] 🔄 Reconnecting...');
    });

    this.l1Stream.start().catch((e: any) => {
      console.error(`[LaserStream] Failed to start: ${e?.message?.slice(0, 100)}`);
    });

    console.log('🌊 LaserStream L1 gRPC subscription started');
  }

  /**
   * Get L1 table accounts from LaserStream cache instead of getProgramAccounts.
   * Returns null if LaserStream is not connected (caller should fall back to RPC).
   */
  private getL1TablesFromCache(opts?: {
    ownerFilter?: string;       // Filter by owner pubkey
    phaseFilter?: number;       // Filter by phase byte at OFF.PHASE
    gameTypeFilter?: number;    // Filter by game_type byte at OFF.GAME_TYPE
  }): { pubkey: string; data: Buffer; owner: string }[] | null {
    if (!this.l1Stream?.isConnected()) return null;
    if (this.l1TableCache.size === 0) return null;

    const results: { pubkey: string; data: Buffer; owner: string }[] = [];
    const now = Date.now();
    const STALE_MS = 120_000; // Consider cache stale after 2 minutes without updates

    for (const [pubkey, entry] of this.l1TableCache) {
      // Skip stale entries
      if (now - entry.updatedAt > STALE_MS) continue;

      // Skip non-table accounts (treasury, pool, vaults)
      if (entry.data.length < 256) continue;

      // Check discriminator
      if (!entry.data.subarray(0, 8).equals(TABLE_DISCRIMINATOR)) continue;

      // Apply owner filter
      if (opts?.ownerFilter && entry.owner !== opts.ownerFilter) continue;

      // Apply phase filter
      if (opts?.phaseFilter !== undefined && entry.data[OFF.PHASE] !== opts.phaseFilter) continue;

      // Apply game type filter
      if (opts?.gameTypeFilter !== undefined && entry.data[OFF.GAME_TYPE] !== opts.gameTypeFilter) continue;

      results.push({ pubkey, data: entry.data, owner: entry.owner });
    }

    return results;
  }

  // ───────────────────── Auto-register CrankOperator ─────────────────────────

  private async ensureCrankOperatorRegistered(): Promise<void> {
    if (!this.l1Payer) {
      console.log('⚠️  No L1 payer — skipping CrankOperator auto-registration');
      return;
    }
    const disc = Buffer.from(
      require('crypto').createHash('sha256').update('global:register_crank_operator').digest().subarray(0, 8),
    );

    // Register CrankOperator for the dealer payer (persistent key = consistent tally tracking).
    // distribute_crank_rewards needs a CrankOperator PDA for each operator in the tally.
    for (const { wallet, label } of [
      { wallet: this.payer.publicKey, label: 'dealer payer' },
    ]) {
      try {
        const pda = getCrankOperatorPda(wallet);
        const existing = await this.l1.getAccountInfo(pda);
        if (existing) {
          const d = Buffer.from(existing.data);
          const actions = Number(d.readBigUInt64LE(49));
          const earned = Number(d.readBigUInt64LE(57));
          console.log(`✅ CrankOperator [${label}]: ${pda.toBase58().slice(0, 12)}... (actions=${actions}, earned=${earned} lamports)`);
          continue;
        }
        console.log(`📝 Registering CrankOperator [${label}] on L1...`);
        const ix = new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: wallet, isSigner: true, isWritable: true },
            { pubkey: pda, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: disc,
        });
        const tx = new Transaction().add(ix);
        tx.feePayer = wallet;
        tx.recentBlockhash = (await this.l1.getLatestBlockhash()).blockhash;
        tx.sign(this.payer);
        const sig = await this.l1.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        await this.l1.confirmTransaction(sig, 'confirmed');
        console.log(`✅ CrankOperator [${label}] registered: ${pda.toBase58().slice(0, 12)}...`);
      } catch (e: any) {
        console.warn(`⚠️  CrankOperator [${label}] registration failed: ${e.message?.slice(0, 100)}`);
      }
    }
  }

  // ───────────────────── Dealer Stats (on-chain) ─────────────────────
  /** Read CrankOperator PDA on-chain and cache stats for heartbeat/dashboard */
  private async refreshDealerStats(): Promise<void> {
    if (Date.now() - dealerStatsLastRefresh < DEALER_STATS_REFRESH_MS) return;
    dealerStatsLastRefresh = Date.now();
    try {
      const conn = this.l1 || this.conn;
      const pda = getCrankOperatorPda(this.payer.publicKey);
      const info = await conn.getAccountInfo(pda);
      if (!info || info.data.length < 82) return;
      const d = Buffer.from(info.data);
      // CrankOperator layout: 8 disc + 32 authority + 1 mode + 8 rake_dist_interval
      //   + 8 lifetime_actions(49) + 8 lifetime_sol_earned(57) + 8 lifetime_token_earned(65) + 8 registered_at(73) + 1 bump
      cachedDealerStats = {
        operatorPubkey: this.payer.publicKey.toBase58(),
        lifetimeActions: Number(d.readBigUInt64LE(49)),
        lifetimeSolEarned: Number(d.readBigUInt64LE(57)),
        lifetimeTokenEarned: Number(d.readBigUInt64LE(65)),
        registeredAt: Number(d.readBigInt64LE(73)),
        lastRefreshed: Date.now(),
      };
    } catch (e: any) {
      // Non-critical — dashboard will show stale or no data
    }
  }

  // ───────────────────── Initial full scan ─────────────────────────

  private async initialScan(): Promise<void> {
    // ── LOCAL_MODE: discover tables directly from PROGRAM_ID (no delegation) ──
    if (LOCAL_MODE) {
      console.log('📡 LOCAL MODE — Discovering tables from program accounts...');
      try {
        const TABLE_SIZE = 437;
        const accounts = await this.l1.getProgramAccounts(PROGRAM_ID, {
          filters: [
            { memcmp: { offset: 0, bytes: bs58.encode(TABLE_DISCRIMINATOR) } },
            { dataSize: TABLE_SIZE },
          ],
        });
        console.log(`   Found ${accounts.length} table(s) on localhost`);

        const needsCrankList: { pubkey: PublicKey; state: TableState }[] = [];
        for (const { pubkey, account } of accounts) {
          const data = Buffer.from(account.data);
          const state = parseTable(data);
          const key = pubkey.toBase58();
          this.tablePhases.set(key, {
            phase: state.phase,
            handNumber: state.handNumber,
            currentPlayers: state.currentPlayers,
            lastPollAt: Date.now(),
          });
          const phaseName = PHASE_NAMES[state.phase] ?? state.phase;
          console.log(
            `   ${key.slice(0, 12)}... phase=${phaseName}` +
            ` players=${state.currentPlayers}/${state.maxPlayers}` +
            ` hand=#${state.handNumber} pot=${state.pot}`,
          );
          this.updateTurnTimer(pubkey, state);
          if (this.needsCrank(state.phase, state.currentPlayers, state.handNumber, state.gameType, state.maxPlayers, true)) {
            needsCrankList.push({ pubkey, state });
          }
        }
        if (needsCrankList.length > 0) {
          console.log(`   🚀 Firing ${needsCrankList.length} cranks...`);
          await Promise.allSettled(
            needsCrankList.map(({ pubkey, state }) => this.enqueueCrank(pubkey, state))
          );
        }
        console.log(`   ${needsCrankList.length} table(s) cranked`);
      } catch (e: any) {
        console.warn(`   ⚠️  Local scan failed: ${e?.message?.slice(0, 80)}`);
      }
      return;
    }

    console.log('📡 Discovering tables from L1 (delegation program)...');
    try {
      // Phase 3: Try LaserStream cache first (eliminates L1 getProgramAccounts RPC)
      const cached = this.getL1TablesFromCache({ ownerFilter: DELEGATION_PROGRAM_ID.toBase58() });
      let delegatedPubkeys: PublicKey[];

      if (cached) {
        delegatedPubkeys = cached.map(e => new PublicKey(e.pubkey));
        console.log(`   Found ${delegatedPubkeys.length} delegated table(s) via LaserStream cache`);
      } else {
        // Fallback: L1 RPC scan
        const TABLE_SIZE = 437;
        const delegatedAccounts = await this.l1.getProgramAccounts(DELEGATION_PROGRAM_ID, {
          filters: [
            { memcmp: { offset: 0, bytes: bs58.encode(TABLE_DISCRIMINATOR) } },
            { dataSize: TABLE_SIZE },
          ],
        });
        // Filter: only include tables whose PDA derives from OUR program ID
        delegatedPubkeys = delegatedAccounts
          .filter(({ pubkey, account }) => {
            const data = Buffer.from(account.data);
            const tableId = data.slice(8, 40);
            const [expectedPda] = PublicKey.findProgramAddressSync(
              [Buffer.from('table'), tableId],
              PROGRAM_ID,
            );
            return expectedPda.equals(pubkey);
          })
          .map(({ pubkey }) => pubkey);
        console.log(`   Found ${delegatedPubkeys.length} delegated table(s) on L1 (filtered to our program)`);
      }

      // Read all tables from Solana RPC in parallel
      const teeReads = await Promise.allSettled(
        delegatedPubkeys.map(pubkey => {
          const conn = this.getConnForTable(pubkey.toBase58());
          return conn.getAccountInfo(pubkey)
            .then(info => ({ pubkey, info, ok: true as const }))
            .catch(() => ({ pubkey, info: null, ok: false as const }));
        })
      );

      // Phase 2: Parse and register all tables
      const needsCrankList: { pubkey: PublicKey; state: TableState }[] = [];
      const startupTeeNull: PublicKey[] = []; // Tables TEE couldn't serve at startup
      for (const result of teeReads) {
        if (result.status !== 'fulfilled') continue;
        const { pubkey, info: teeInfo, ok } = result.value;
        if (!ok || !teeInfo || teeInfo.data.length < 256) {
          startupTeeNull.push(pubkey);
          continue;
        }

        const data = Buffer.from(teeInfo.data);
        const state = parseTable(data);
        const key = pubkey.toBase58();

        this.tablePhases.set(key, {
          phase: state.phase,
          handNumber: state.handNumber,
          currentPlayers: state.currentPlayers,
          lastPollAt: Date.now(),
        });

        // Phase 3D: Dynamically subscribe to this table's vault
        if (this.l1Stream) {
          const vaultPda = getVaultPda(pubkey);
          this.l1Stream.addVaultSubscription(vaultPda.toBase58());
        }

        const phaseName = PHASE_NAMES[state.phase] ?? state.phase;
        console.log(
          `   ${key.slice(0, 12)}... phase=${phaseName}` +
          ` players=${state.currentPlayers}/${state.maxPlayers}` +
          ` hand=#${state.handNumber} pot=${state.pot}`,
        );

        this.updateTurnTimer(pubkey, state);

        if (this.isTableFiltered(key)) {
          console.log(`   🚫 ${key.slice(0, 12)}... FILTERED (${crankConfig.table_filter_mode})`);
          continue;
        }

        if (this.needsCrank(state.phase, state.currentPlayers, state.handNumber, state.gameType, state.maxPlayers, state.isDelegated)) {
          console.log(`   ⚡ ${key.slice(0, 12)}... needs crank (${phaseName})`);
          needsCrankList.push({ pubkey, state });
        }
      }

      // L1 fallback: for tables TEE couldn't serve, parse L1 shadow data.
      // Cash games with current_players > 0 may have Leaving seats needing cashout clearing.
      if (startupTeeNull.length > 0) {
        console.log(`   📡 L1 fallback: ${startupTeeNull.length} tables TEE couldn't serve — checking L1 shadow data`);
        const l1Reads = await Promise.allSettled(
          startupTeeNull.map(pubkey =>
            this.l1.getAccountInfo(pubkey).then(info => ({ pubkey, info }))
          )
        );
        let l1Count = 0;
        for (const r of l1Reads) {
          if (r.status !== 'fulfilled' || !r.value.info || r.value.info.data.length < 256) continue;
          const { pubkey, info } = r.value;
          const data = Buffer.from(info.data);
          const state = parseTable(data);
          const key = pubkey.toBase58();
          // Track cash games with players (may need cashout clearing)
          if (state.gameType === 3 && state.currentPlayers > 0) {
            this.tablePhases.set(key, { phase: state.phase, handNumber: state.handNumber, currentPlayers: state.currentPlayers, lastPollAt: Date.now() });
            const phaseName = PHASE_NAMES[state.phase] ?? state.phase;
            console.log(`   🆕 L1 fallback: ${key.slice(0, 12)}... phase=${phaseName} players=${state.currentPlayers}/${state.maxPlayers} (TEE null)`);
            if (this.needsCrank(state.phase, state.currentPlayers, state.handNumber, state.gameType, state.maxPlayers, state.isDelegated)) {
              needsCrankList.push({ pubkey, state });
            }
            l1Count++;
          }
        }
        if (l1Count > 0) console.log(`   📡 L1 fallback discovered ${l1Count} cash game table(s) with players`);
      }

      // Phase 3: Fire all cranks in parallel (no sequential waiting)
      if (needsCrankList.length > 0) {
        console.log(`   🚀 Firing ${needsCrankList.length} cranks in parallel...`);
        await Promise.allSettled(
          needsCrankList.map(({ pubkey, state }) => this.enqueueCrank(pubkey, state))
        );
      }

      console.log(`   ${needsCrankList.length} table(s) cranked`);
    } catch (e: any) {
      console.warn(`   ⚠️  Initial scan failed: ${e?.message?.slice(0, 80)}`);
    }
  }

  // ───────────────────── WebSocket subscribe ───────────────────────

  // Polling interval ID for TEE table state monitoring
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private static readonly POLL_INTERVAL_MS = 1500; // 1.5s poll interval

  private subscribe(): void {
    // TEE does NOT support onProgramAccountChange (WebSocket subscription).
    // Use polling loop instead: periodically read each known table from TEE.
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
    }

    console.log(`📡 Starting TEE polling loop (${CrankService.POLL_INTERVAL_MS}ms interval)...`);
    this.pollIntervalId = setInterval(() => this.pollTables(), CrankService.POLL_INTERVAL_MS);
  }

  private pollFailCount = 0;
  private tableNullCount = new Map<string, number>(); // consecutive null polls per table
  private static readonly PRUNE_AFTER_NULLS = 5; // remove after 5 consecutive nulls (~15s)

  private async pollTables(): Promise<void> {
    let anySuccess = false;
    // Phase 1A: Adaptive polling — only read tables whose interval has elapsed
    const now = Date.now();
    const entries = Array.from(this.tablePhases.entries()).filter(([key, meta]) => {
      if (this.blockedTables.has(key) || this.isTableFiltered(key)) return false;
      const interval = this.getAdaptivePollInterval(meta.phase, meta.currentPlayers);
      return (now - meta.lastPollAt) >= interval;
    });
    const results = await Promise.allSettled(
      entries.map(([key]) => {
        const conn = this.getConnForTable(key);
        return conn.getAccountInfo(new PublicKey(key))
          .then(info => ({ key, info }));
      })
    );
    const nullKeys: string[] = [];
    const cacheableReads: { key: string; data: Buffer }[] = []; // Phase 2A
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { key, info } = result.value;
      if (!info || info.data.length < 256) {
        // Track consecutive nulls for pruning
        const count = (this.tableNullCount.get(key) || 0) + 1;
        this.tableNullCount.set(key, count);
        if (count >= CrankService.PRUNE_AFTER_NULLS) nullKeys.push(key);
        continue;
      }
      this.tableNullCount.delete(key); // reset on success
      anySuccess = true;
      if (crankConfig.state_cache_enabled) cacheableReads.push({ key, data: Buffer.from(info.data) });
      // Update lastPollAt + currentPlayers for adaptive polling
      const meta = this.tablePhases.get(key);
      if (meta) {
        meta.lastPollAt = now;
        // currentPlayers updated inside onAccountChange via parseTable
      }
      this.onAccountChange(
        { accountId: new PublicKey(key), accountInfo: { data: Buffer.from(info.data) } },
        { slot: 0 },
      );
    }
    // ── Phase 2A: Update state cache with polled table+seat data ──
    if (crankConfig.state_cache_enabled && cacheableReads.length > 0) {
      const seatReadQueue: { key: string; occ: number; max: number }[] = [];
      for (const { key, data } of cacheableReads) {
        const cached = parseTableForCache(key, data);
        const nonce = `${cached.actionNonce}:${cached.phase}:${cached.handNumber}`;
        const prevNonce = _tableCacheNonces.get(key);
        const changed = nonce !== prevNonce;
        if (!_stateCache.tables[key]) {
          _stateCache.tables[key] = { table: cached, seats: [], updatedAt: now };
        } else {
          _stateCache.tables[key].table = cached;
          _stateCache.tables[key].updatedAt = now;
        }
        if (changed) {
          _tableCacheNonces.set(key, nonce);
          if (crankConfig.state_cache_include_seats && cached.seatsOccupied > 0) {
            seatReadQueue.push({ key, occ: cached.seatsOccupied, max: cached.maxPlayers });
          } else {
            _stateCache.tables[key].seats = [];
          }
        }
      }
      // Read seats for tables with changed nonces (parallel per table)
      for (const { key, occ, max } of seatReadQueue) {
        const indices: number[] = [];
        for (let i = 0; i < max; i++) if (occ & (1 << i)) indices.push(i);
        const tPk = new PublicKey(key);
        const seatResults = await Promise.allSettled(
          indices.map(i => this.getConnForTable(key).getAccountInfo(getSeatPda(tPk, i)).then(a => ({ i, a })))
        );
        const seats: CachedSeatState[] = [];
        for (const sr of seatResults) {
          if (sr.status !== 'fulfilled' || !sr.value.a) continue;
          const parsed = parseSeatForCache(Buffer.from(sr.value.a.data));
          if (parsed) seats.push(parsed);
        }
        _stateCache.tables[key].seats = seats;
      }
    }
    // Prune tables gone from TEE (closed/undelegated) — verify on L1 first
    for (const key of nullKeys) {
      try {
        const l1Info = await this.l1.getAccountInfo(new PublicKey(key)).catch(() => null);
        if (!l1Info || l1Info.data.length < 256) {
          this.tablePhases.delete(key);
          this.tableNullCount.delete(key);
          this.blockedTables.delete(key);
          delete _stateCache.tables[key]; _tableCacheNonces.delete(key);
          console.log(`  🗑️  Pruned closed table ${key.slice(0, 12)}...`);
        } else {
          // Still on L1 but not on TEE — might be undelegated, keep tracking
          this.tableNullCount.set(key, 0);
        }
      } catch {
        this.tableNullCount.set(key, 0); // reset on error, try again later
      }
    }
    // Detect stale TEE token: if ALL reads failed, check if validators are actually unreachable
    // vs tables being orphaned (delegated but data lost from TEE's SVM).
    if (this.tablePhases.size > 0 && !anySuccess) {
      // Probe RPC with getSlot() to distinguish unreachable vs orphaned
      let anyValidatorReachable = false;
      try { await this.conn.getSlot(); anyValidatorReachable = true; } catch {}
      if (!anyValidatorReachable) {
        this.pollFailCount++;
        if (this.pollFailCount === 3) {
          console.warn('\n⚠️  3 consecutive poll failures (RPC unreachable) — will reconnect');
        }
      } else {
        // RPC reachable but all tables returned null — orphaned tables
        if (this.pollFailCount > 0) {
          console.log('  ℹ️  RPC reachable — null tables are likely orphaned');
        }
        this.pollFailCount = 0;
      }
    } else {
      this.pollFailCount = 0;
    }
    // Phase 2A: Flush state cache to disk at end of poll cycle
    if (crankConfig.state_cache_enabled) writeStateCache(now);
  }

  private onAccountChange(
    info: { accountId: PublicKey; accountInfo: { data: Buffer } },
    _ctx: { slot: number },
  ): void {
    const pubkey = info.accountId;
    const data = Buffer.from(info.accountInfo.data);
    if (data.length < 256) return;

    const state = parseTable(data);
    const key = pubkey.toBase58();

    const prev = this.tablePhases.get(key);
    const phaseChanged = !prev || prev.phase !== state.phase || prev.handNumber !== state.handNumber;

    // Always update turn timer on ANY account change (currentPlayer may have changed)
    this.updateTurnTimer(pubkey, state);

    if (!phaseChanged) {
      // Update currentPlayers for adaptive polling even without phase change
      if (prev && prev.currentPlayers !== state.currentPlayers) {
        prev.currentPlayers = state.currentPlayers;
      }
      // Even without a phase change, check if a Waiting table just became full
      // (player joined → currentPlayers changed but phase stays Waiting)
      if (
        state.phase === Phase.Waiting
        && this.needsCrank(state.phase, state.currentPlayers, state.handNumber, state.gameType, state.maxPlayers, state.isDelegated)
        && !this.processing.has(key)
        && !this.isInBackoff(key)
      ) {
        if (state.currentPlayers >= 2) {
          // Cooldown: suppress spam for tables waiting to start (cash game warmup or SNG retry)
          const cooldownUntil = this.startGameCooldown.get(key) || 0;
          if (state.gameType === 3) {
            // Cash games: 30s warmup before first start after reaching 2+ players
            if (cooldownUntil === 0) {
              this.startGameCooldown.set(key, Date.now() + 30_000);
              console.log(`\n\uD83D\uDD14 ${key.slice(0, 12)}... ${state.currentPlayers} players joined — game starts in 30s`);
              return;
            }
            if (Date.now() < cooldownUntil) return;
          } else {
            // SNG: skip logging if in cooldown (set after failed start_game)
            if (cooldownUntil > 0 && Date.now() < cooldownUntil) return;
          }
          console.log(`\n\uD83D\uDD14 ${key.slice(0, 12)}... ${state.currentPlayers} players — starting game`);
        } else {
          // <2 players — still need crank for cashout sweep, but don't log "starting"
        }
        this.enqueueCrank(pubkey, state);
      }
      return; // timer updated above, nothing else to do
    }

    const prevPhase = prev ? PHASE_NAMES[prev.phase] ?? prev.phase : '?';
    console.log(
      `\n🔔 ${key.slice(0, 12)}... ` +
      `${prevPhase} → ${PHASE_NAMES[state.phase] ?? state.phase}` +
      `  hand=#${state.handNumber} players=${state.currentPlayers} pot=${state.pot}`,
    );

    this.tablePhases.set(key, { phase: state.phase, handNumber: state.handNumber, currentPlayers: state.currentPlayers, lastPollAt: Date.now() });

    // Phase changed — clear transient failure/backoff state from prior phase.
    // This prevents stale failures from delaying cranks in the new phase.
    this.clearFailure(key);

    if (this.needsCrank(state.phase, state.currentPlayers, state.handNumber, state.gameType, state.maxPlayers, state.isDelegated)) {
      this.enqueueCrank(pubkey, state);
    }
  }

  // ───────────────────── Health / reconnect ───────────────────────

  private healthLoop(): void {
    const CHECK_INTERVAL_MS = 30_000;
    let l1SweepCounter = 0;

    const tick = async () => {
      if (!this.alive) return;

      try {
        // Liveness check — probe RPC with getSlot() (lightweight)
        let anyReachable = false;
        for (const conn of [this.conn]) {
          try {
            await conn.getSlot();
            anyReachable = true;
          } catch {}
        }
        // Fallback: try default connection
        if (!anyReachable) {
          try { await this.conn.getSlot(); anyReachable = true; } catch {}
        }
        if (anyReachable) {
          this.healthFailCount = 0;
        } else {
          throw new Error('no validators reachable');
        }
      } catch {
        this.healthFailCount++;
        if (this.healthFailCount >= CrankService.HEALTH_FAIL_THRESHOLD) {
          const sinceLast = Date.now() - this.lastReconnectAt;
          if (sinceLast >= CrankService.MIN_RECONNECT_INTERVAL_MS) {
            console.warn(`\n⚠️  TEE connection lost (${this.healthFailCount} failures) — reconnecting...`);
            this.healthFailCount = 0;
            this.reconnect();
          } else {
            console.warn(`  ⚠️  TEE health fail #${this.healthFailCount} — waiting for reconnect cooldown`);
          }
        } else {
          console.warn(`  ⚠️  TEE health fail #${this.healthFailCount}/${CrankService.HEALTH_FAIL_THRESHOLD}`);
        }
      }

      // Discover newly delegated tables every tick (30s) for fast pickup
      this.discoverNewTables().catch((e: any) =>
        console.warn(`  ⚠️  Table discovery error: ${e?.message?.slice(0, 80)}`),
      );

      // L1 safety sweep every ~60s (2 ticks × 30s), also runs on first tick
      l1SweepCounter++;
      if (l1SweepCounter >= 2) {
        l1SweepCounter = 0;
        this.l1PrizeSweep().catch((e: any) =>
          console.warn(`  ⚠️  L1 prize sweep error: ${e?.message?.slice(0, 80)}`),
        );
      }

      this.reconnectTimer = setTimeout(tick, CHECK_INTERVAL_MS);
    };
    this.reconnectTimer = setTimeout(tick, CHECK_INTERVAL_MS);
  }

  /**
   * Discover newly delegated tables that were created after crank startup.
   * Scans L1 delegation program for table-sized accounts not yet in tablePhases.
   */
  private async discoverNewTables(): Promise<void> {
    try {
      let newTablePubkeys: PublicKey[];

      // LOCAL_MODE: scan PROGRAM_ID directly
      if (LOCAL_MODE) {
        const TABLE_SIZE = 437;
        const accounts = await this.l1.getProgramAccounts(PROGRAM_ID, {
          filters: [
            { memcmp: { offset: 0, bytes: bs58.encode(TABLE_DISCRIMINATOR) } },
            { dataSize: TABLE_SIZE },
          ],
        });
        newTablePubkeys = accounts
          .filter(({ pubkey }) => !this.tablePhases.has(pubkey.toBase58()))
          .map(({ pubkey }) => pubkey);
      } else {
      // Phase 3: Try LaserStream cache first (eliminates L1 getProgramAccounts RPC)
      const cached = this.getL1TablesFromCache({ ownerFilter: DELEGATION_PROGRAM_ID.toBase58() });

      if (cached) {
        newTablePubkeys = cached
          .filter(e => !this.tablePhases.has(e.pubkey))
          .map(e => new PublicKey(e.pubkey));
      } else {
        // Fallback: L1 RPC scan
        const TABLE_SIZE = 437;
        const delegatedAccounts = await this.l1.getProgramAccounts(DELEGATION_PROGRAM_ID, {
          filters: [
            { memcmp: { offset: 0, bytes: bs58.encode(TABLE_DISCRIMINATOR) } },
            { dataSize: TABLE_SIZE },
          ],
        });
        newTablePubkeys = delegatedAccounts
          .filter(({ pubkey, account }) => {
            if (this.tablePhases.has(pubkey.toBase58())) return false;
            // Verify table belongs to our program by re-deriving PDA
            const data = Buffer.from(account.data);
            const tableId = data.slice(8, 40);
            const [expectedPda] = PublicKey.findProgramAddressSync(
              [Buffer.from('table'), tableId],
              PROGRAM_ID,
            );
            return expectedPda.equals(pubkey);
          })
          .map(({ pubkey }) => pubkey);
      }
      } // end else (non-LOCAL_MODE)

      if (newTablePubkeys.length === 0) return;

      // Read all new tables from Solana RPC in parallel
      const reads = await Promise.allSettled(
        newTablePubkeys.map(pubkey =>
          this.getConnForTable(pubkey.toBase58()).getAccountInfo(pubkey)
            .then(info => ({ pubkey, info, ok: true as const }))
            .catch(() => ({ pubkey, info: null, ok: false as const }))
        )
      );

      let newCount = 0;
      const needsCrankList: { pubkey: PublicKey; state: TableState }[] = [];
      const teeNullPubkeys: PublicKey[] = []; // Tables TEE couldn't serve (null or error)
      for (const result of reads) {
        if (result.status !== 'fulfilled') continue;
        const { pubkey, info: teeInfo, ok } = result.value;
        if (!ok || !teeInfo || teeInfo.data.length < 256) {
          teeNullPubkeys.push(pubkey);
          continue;
        }

        const data = Buffer.from(teeInfo.data);
        const state = parseTable(data);
        const key = pubkey.toBase58();

        this.tablePhases.set(key, { phase: state.phase, handNumber: state.handNumber, currentPlayers: state.currentPlayers, lastPollAt: Date.now() });

        // Phase 3D: Dynamically subscribe to this table's vault
        if (this.l1Stream) {
          const vaultPda = getVaultPda(pubkey);
          this.l1Stream.addVaultSubscription(vaultPda.toBase58());
        }

        const phaseName = PHASE_NAMES[state.phase] ?? state.phase;
        console.log(
          `\n🆕 Discovered new table: ${key.slice(0, 12)}... phase=${phaseName}` +
          ` players=${state.currentPlayers}/${state.maxPlayers} hand=#=${state.handNumber}`,
        );

        this.updateTurnTimer(pubkey, state);

        if (this.isTableFiltered(key)) {
          console.log(`   🚫 ${key.slice(0, 12)}... FILTERED (${crankConfig.table_filter_mode})`);
          continue;
        }

        if (this.needsCrank(state.phase, state.currentPlayers, state.handNumber, state.gameType, state.maxPlayers, state.isDelegated)) {
          console.log(`   ⚡ Needs crank (${phaseName})`);
          needsCrankList.push({ pubkey, state });
        }
        newCount++;
      }

      // L1 fallback: for tables TEE couldn't serve, parse L1 shadow data.
      // Cash games with current_players > 0 may have Leaving seats needing cashout clearing.
      if (teeNullPubkeys.length > 0) {
        console.log(`  📡 L1 fallback: ${teeNullPubkeys.length} tables TEE couldn't serve — checking L1 shadow data`);
        const l1Reads = await Promise.allSettled(
          teeNullPubkeys.map(pubkey =>
            this.l1.getAccountInfo(pubkey).then(info => ({ pubkey, info }))
          )
        );
        for (const r of l1Reads) {
          if (r.status !== 'fulfilled' || !r.value.info || r.value.info.data.length < 256) continue;
          const { pubkey, info } = r.value;
          const data = Buffer.from(info.data);
          const state = parseTable(data);
          const key = pubkey.toBase58();
          // Only track cash games with players (may need cashout clearing)
          if (state.gameType === 3 && state.currentPlayers > 0) {
            this.tablePhases.set(key, { phase: state.phase, handNumber: state.handNumber, currentPlayers: state.currentPlayers, lastPollAt: Date.now() });
            console.log(`\n🆕 Discovered table via L1 fallback: ${key.slice(0, 12)}... phase=${PHASE_NAMES[state.phase]} players=${state.currentPlayers}/${state.maxPlayers} (TEE null)`);
            if (this.needsCrank(state.phase, state.currentPlayers, state.handNumber, state.gameType, state.maxPlayers, state.isDelegated)) {
              needsCrankList.push({ pubkey, state });
            }
            newCount++;
          }
        }
      }

      // Fire cranks in parallel
      if (needsCrankList.length > 0) {
        await Promise.allSettled(
          needsCrankList.map(({ pubkey, state }) => this.enqueueCrank(pubkey, state))
        );
      }

      if (newCount > 0) {
        console.log(`   📡 Discovered ${newCount} new table(s)`);
      }
    } catch (e: any) {
      if (!e?.message?.includes('429')) {
        throw e;
      }
    }
  }

  /**
   * Safety sweep: scan L1 for SNG tables in Complete phase.
   * - prizes_distributed=false → distribute prizes + close
   * - prizes_distributed=true but table still exists → close (fallback for failed close)
   */
  private async l1PrizeSweep(): Promise<void> {
    if (!this.l1Payer) return; // no L1 payer → can't distribute

    try {
      // Phase 3: Try LaserStream cache first (eliminates L1 getProgramAccounts RPC)
      const cached = this.getL1TablesFromCache({ phaseFilter: Phase.Complete });
      let accounts: { pubkey: PublicKey; data: Buffer; owner: string }[];

      if (cached) {
        accounts = cached.map(e => ({ pubkey: new PublicKey(e.pubkey), data: e.data, owner: e.owner }));
      } else {
        // Fallback: L1 RPC scan
        const rpcAccounts = await this.l1.getProgramAccounts(PROGRAM_ID, {
          filters: [
            { memcmp: { offset: 0, bytes: bs58.encode(TABLE_DISCRIMINATOR) } },
            { memcmp: { offset: OFF.PHASE, bytes: bs58.encode(Buffer.from([Phase.Complete])) } },
          ],
        });
        accounts = rpcAccounts.map(a => ({
          pubkey: a.pubkey,
          data: Buffer.from(a.account.data),
          owner: a.account.owner.toBase58(),
        }));
      }

      if (accounts.length > 0) {
        console.log(`\n🔍 L1 prize sweep: found ${accounts.length} Complete table(s)${cached ? ' (LaserStream)' : ' on L1'}`);
      }

      for (const { pubkey, data, owner } of accounts) {
        if (data.length < 385) continue;

        // Skip if not owned by our program (still delegated)
        if (owner !== PROGRAM_ID.toBase58()) {
          console.log(`  ⏭️  ${pubkey.toBase58().slice(0, 12)}... still delegated (owner=${owner.slice(0, 8)})`);
          continue;
        }

        const key = pubkey.toBase58();
        const lockKey = `l1sweep-${key}`;
        if (this.processing.has(lockKey)) continue;
        this.processing.add(lockKey);

        try {
          if (data[OFF.PRIZES_DISTRIBUTED] !== 0) {
            // Prizes already distributed but table still exists — reset for reuse
            const mp = data[OFF.MAX_PLAYERS];
            const gt = data[OFF.GAME_TYPE];
            const isSng = gt >= 0 && gt <= 2;
            if (isSng) {
              console.log(`\n🔍 L1 sweep: SNG table ${key.slice(0, 12)}... prizes done — resetting for reuse`);
              await this.resetSngTableForReuse(pubkey, mp);
            } else {
              console.log(`\n🔍 L1 sweep: table ${key.slice(0, 12)}... prizes done but not closed — closing now`);
              await this.closeTableAndAccounts(pubkey, mp);
            }
          } else {
            console.log(`\n🔍 L1 sweep: found undistributed table ${key.slice(0, 12)}...`);
            const state = parseTable(data);
            await this.distributePrizesOnL1(pubkey, state);
          }
        } catch (e: any) {
          console.warn(`  ⚠️  L1 sweep failed for ${key.slice(0, 12)}...: ${e?.message?.slice(0, 80)}`);
        } finally {
          this.processing.delete(lockKey);
        }
      }
    } catch (e: any) {
      // getProgramAccounts can fail transiently — not critical
      if (!e?.message?.includes('429')) {
        console.warn(`  ⚠️  L1 prize sweep scan failed: ${e?.message?.slice(0, 80)}`);
      }
    }
  }

  private async reconnect(): Promise<void> {
    this.lastReconnectAt = Date.now();
    // Re-establish connection (no auth needed in Arcium architecture)
    this.conn = new Connection(RPC_BASE, 'confirmed');
    teeConnectionRef = this.conn;
    teeConnections.clear();
    teeConnections.add(this.conn);
    this.subId = null;
    this.subscribe();

    // Lightweight re-discovery (avoids heavy L1 getProgramAccounts that can 502)
    this.discoverNewTables().catch(() => {});
  }

  // ───────────────────── Crank dispatch ───────────────────────────

  private needsCrank(
    phase: number,
    currentPlayers: number,
    handNumber: number,
    gameType: number = 0,
    maxPlayers: number = 0,
    isDelegated: boolean = true,
  ): boolean {
    // Config-based game type filtering
    if (gameType === 3 && !crankConfig.crank_cash) return false;
    if (gameType !== 3 && !crankConfig.crank_sng) return false;

    // Keep non-delegated SNG tables eligible so enqueueCrank can
    // re-delegate them before firing ER crank instructions.

    switch (phase) {
      case Phase.Showdown: return true;
      case Phase.Waiting:
        // Sit & Go first hand must start full (start_game enforces this on-chain).
        // Avoid repeated failing start_game attempts while lobby is still filling.
        if (gameType !== 3 && handNumber === 0) {
          return maxPlayers > 0 && currentPlayers === maxPlayers;
        }
        if (currentPlayers >= 2) return true;
        // Cash games: may need cashout even with 0 "active" players.
        // leave_cash_game in Waiting decrements current_players and clears occupied mask,
        // but the seat stays Leaving until crank processes vault cashout.
        // The handler will scan actual seat accounts to find Leaving seats.
        if (gameType === 3) return true;
        return false;
      case Phase.Starting: return true;
      case Phase.AwaitingDeal: return false;  // MPC callback is MXE nodes' job — crank can't help
      case Phase.AwaitingShowdown: return false; // MPC callback is MXE nodes' job — crank can't help
      case Phase.FlopRevealPending: return true;
      case Phase.TurnRevealPending: return true;
      case Phase.RiverRevealPending: return true;
      case Phase.Complete: return true;
      default:             return false;
    }
  }

  private async prepareErCrankState(tablePda: PublicKey, state: TableState): Promise<TableState | null> {
    // IMPORTANT:
    // table.is_delegated is not a reliable signal on ER account snapshots.
    // Proactive redelegation based on this bit caused repeated false-positive
    // re-delegate attempts and noisy ExternalAccountDataModified failures.
    // ER-first flow should crank directly; targeted self-heal is handled on
    // concrete TX failure paths (e.g. request_deal_vrf retry logic).
    return state;
  }

  private async enqueueCrank(tablePda: PublicKey, state: TableState): Promise<void> {
    const key = tablePda.toBase58();
    if (this.blockedTables.has(key)) return;
    if (this.isTableFiltered(key)) return;
    if (this.processing.has(key)) return;

    // Backoff after transient failures
    if (this.isInBackoff(key)) return;

    this.processing.add(key);
    try {
      const prepared = await this.prepareErCrankState(tablePda, state);
      if (!prepared) {
        this.noteFailure(key, 'redelegate');
        return;
      }

      const success = await this.doCrank(tablePda, prepared);

      if (!success) {
        // 6022 = InvalidActionForPhase — another crank (or timeout checker) already advanced the phase.
        // Re-read and route to the correct action instead of backing off.
        if (lastSendError.includes('"Custom":6022')) {
          console.log(`  🔄 ${key.slice(0, 12)}... phase raced — re-reading for current state`);
          try {
            const rereadInfo = await this.getConnForTable(key).getAccountInfo(tablePda);
            if (rereadInfo && rereadInfo.data.length >= 256) {
              const rereadState = parseTable(Buffer.from(rereadInfo.data));
              this.tablePhases.set(key, { phase: rereadState.phase, handNumber: rereadState.handNumber, currentPlayers: rereadState.currentPlayers, lastPollAt: Date.now() });
              this.updateTurnTimer(tablePda, rereadState);
              if (this.needsCrank(rereadState.phase, rereadState.currentPlayers, rereadState.handNumber, rereadState.gameType, rereadState.maxPlayers, rereadState.isDelegated)) {
                await this.doCrank(tablePda, rereadState);
              }
            }
          } catch {}
          return;
        }
        this.noteFailure(key, 'crank', lastSendError);
        return;
      }

      // Success — reset fail counter
      this.clearFailure(key);

      // Chain loop: keep re-reading and cranking until no more work needed.
      let lastPhase = prepared.phase;
      let lastHand = prepared.handNumber;
      for (let chain = 0; chain < 10; chain++) {
        await sleep(300);
        try {
          const info = await this.getConnForTable(key).getAccountInfo(tablePda);
          if (!info || info.data.length < 256) break;
          const fresh = parseTable(Buffer.from(info.data));
          if (fresh.phase === lastPhase && fresh.handNumber === lastHand) break;
          this.tablePhases.set(key, { phase: fresh.phase, handNumber: fresh.handNumber, currentPlayers: fresh.currentPlayers, lastPollAt: Date.now() });
          this.updateTurnTimer(tablePda, fresh);
          if (!this.needsCrank(fresh.phase, fresh.currentPlayers, fresh.handNumber, fresh.gameType, fresh.maxPlayers, fresh.isDelegated)) break;
          console.log(
            `  🔄 Post-crank chain: ${PHASE_NAMES[lastPhase]} → ${PHASE_NAMES[fresh.phase]}` +
            `  hand=#${fresh.handNumber} players=${fresh.currentPlayers}`,
          );
          const preparedFresh = await this.prepareErCrankState(tablePda, fresh);
          if (!preparedFresh) {
            this.noteFailure(key, 'redelegate');
            break;
          }
          lastPhase = preparedFresh.phase;
          lastHand = preparedFresh.handNumber;
          const chainSuccess = await this.doCrank(tablePda, preparedFresh);
          if (!chainSuccess) break;
        } catch { break; }
      }
    } finally {
      this.processing.delete(key);
    }
  }

  private async doCrank(tablePda: PublicKey, state: TableState): Promise<boolean> {
    const tag = tablePda.toBase58().slice(0, 8);
    const teeConn = this.getConnForTable(tablePda.toBase58());
    switch (state.phase) {
      // ─── SHOWDOWN → arcium_showdown_queue (MPC) or settle_hand ───
      case Phase.Showdown: {
        // Reveal hole cards via MPC before settling.
        // Skip MPC reveal for fold-wins (only 1 active player — no cards to compare).
        const activeMask = state.seatsOccupied & ~state.seatsFolded & 0x1FF;
        const activeCount = activeMask.toString(2).split('').filter(c => c === '1').length;

        // Check if cards are already revealed (callback already ran).
        // revealedHands[0] === 255 means not yet revealed (CARD_NOT_DEALT).
        if (activeCount >= 2 && state.revealedHands && state.revealedHands[0] === 255) {
          return this.crankArciumShowdown(tablePda, state);
        }
        let occ = state.seatsOccupied;
        // Cash games: sit_out may have cleared bitmask but seat still exists.
        // Read actual seat accounts to build a reliable occupied mask.
        if (state.gameType === 3) {
          let realOcc = 0;
          const seatReads = await Promise.allSettled(
            Array.from({ length: state.maxPlayers }, (_, i) =>
              teeConn.getAccountInfo(getSeatPda(tablePda, i)).then(info => ({ i, info }))
            )
          );
          for (const r of seatReads) {
            if (r.status !== 'fulfilled' || !r.value.info) continue;
            const { i, info } = r.value;
            if (info.data.length > SEAT_STATUS_OFFSET && info.data[SEAT_STATUS_OFFSET] !== 0) {
              realOcc |= (1 << i);
            }
          }
          if (realOcc !== occ) {
            console.log(`  ⚠️  seatsOccupied mismatch: bitmask=${occ} actual=${realOcc} — using actual`);
            occ = realOcc;
          }
        }
        const occList = [];
        for (let i = 0; i < state.maxPlayers; i++) { if (occ & (1 << i)) occList.push(i); }
        const hasTally = await this.hasCrankTallyOnTee(tablePda);
        console.log(`  🎯 [${tag}] Cranking settle_hand (${state.maxPlayers}-max, pot=${state.pot}, seats=[${occList}], tally=${hasTally})`);
        const ix = buildSettleIx(this.teePayer.publicKey, tablePda, state.maxPlayers, occ, hasTally);
        const settled = await sendWithRetry(teeConn, ix, this.teePayer, `[${tag}] settle_hand`);
        if (settled) return true;

        // Crank has zero admin powers — misdeal (super-admin only) is NOT available here.
        // Stuck showdown tables must be resolved via admin scripts, not the crank.
        if (state.gameType !== 3) {
          console.log('  ⏭️  settle_hand failed — stuck showdown requires admin intervention (misdeal script)');
        }

        return false;
      }

      // ─── WAITING → (cashout leaving?) → start_game (+ request_deal_vrf after) ───
      case Phase.Waiting: {
        // Cash games: detect players that need cashout BEFORE checking player count.
        // Primary: Leaving (6) — normal leave flow.
        // Recovery: SittingOut (4) with cashout_chips > 0 & nonce > 0 — caused by
        //   sit_out.rs bug overwriting Leaving → SittingOut after leave_cash_game.
        //   Contract's nonce check prevents abuse (normal SittingOut has nonce=0).
        if (state.gameType === 3) {
          const leavingSeats: { seatIndex: number; wallet: PublicKey }[] = [];
          const occupiedSeats: { seatIndex: number; wallet: PublicKey }[] = [];
          // Read seats: try TEE first, fall back to L1 per-seat for any that fail.
          const seatReads = await Promise.allSettled(
            Array.from({ length: state.maxPlayers }, (_, i) =>
              teeConn.getAccountInfo(getSeatPda(tablePda, i))
                .then(info => ({ i, info, src: 'tee' as const }))
                .catch(() => ({ i, info: null, src: 'tee' as const }))
            )
          );
          const seatResults: { i: number; info: any }[] = [];
          const missingSeatIndices: number[] = [];
          for (const r of seatReads) {
            if (r.status === 'fulfilled' && r.value.info && r.value.info.data.length > SEAT_STATUS_OFFSET) {
              seatResults.push({ i: r.value.i, info: r.value.info });
            } else if (r.status === 'fulfilled') {
              missingSeatIndices.push(r.value.i);
            }
          }
          // L1 fallback: for seats TEE couldn't serve, try L1 shadow data
          if (missingSeatIndices.length > 0 && state.currentPlayers > 0) {
            const l1Reads = await Promise.allSettled(
              missingSeatIndices.map(i =>
                this.l1.getAccountInfo(getSeatPda(tablePda, i)).then(info => ({ i, info }))
              )
            );
            let l1Count = 0;
            for (const r of l1Reads) {
              if (r.status === 'fulfilled' && r.value.info && r.value.info.data.length > SEAT_STATUS_OFFSET) {
                seatResults.push(r.value);
                l1Count++;
              }
            }
            if (l1Count > 0) console.log(`  📡 ${l1Count} seat(s) loaded from L1 shadow (TEE null)`);
          }
          for (const { i, info } of seatResults) {
            if (info.data.length <= SEAT_STATUS_OFFSET) continue;
            const sd = Buffer.from(info.data);
            const status = sd[SEAT_STATUS_OFFSET];
            if (status === 0) continue; // Empty
            const wallet = new PublicKey(sd.subarray(SEAT_WALLET_OFFSET, SEAT_WALLET_OFFSET + 32));
            if (wallet.equals(PublicKey.default)) continue;
            occupiedSeats.push({ seatIndex: i, wallet });
            if (status === 6) { // Leaving — wants cashout
              leavingSeats.push({ seatIndex: i, wallet });
            } else if (status === 4 && sd.length > SEAT_CASHOUT_NONCE_OFFSET + 8) {
              // SittingOut with pending cashout snapshot (bug recovery)
              const cashoutChips = sd.readBigUInt64LE(SEAT_CASHOUT_CHIPS_OFFSET);
              const cashoutNonce = sd.readBigUInt64LE(SEAT_CASHOUT_NONCE_OFFSET);
              if (cashoutChips > 0n && cashoutNonce > 0n) {
                console.log(`  🔧 Seat ${i}: SittingOut with pending cashout (chips=${cashoutChips}, nonce=${cashoutNonce}) — recovering`);
                leavingSeats.push({ seatIndex: i, wallet });
              }
            }
          }

          if (leavingSeats.length > 0 && !crankConfig.process_cashouts) {
            console.log(`  ⏸  Found ${leavingSeats.length} leaving player(s) — cashout processing DISABLED in config`);
          }
          if (leavingSeats.length > 0 && crankConfig.process_cashouts) {
            console.log(`  🔍 Found ${leavingSeats.length} leaving player(s) — processing vault cashouts`);
            const cashoutOk = await this.processCashGameCashouts(tablePda, state, leavingSeats, occupiedSeats);
            if (!cashoutOk) {
              console.log('  ⚠️  Vault cashout failed — will retry next crank');
              return false;
            }
            // Re-read ER state after clear_leaving_seat (no re-delegation needed)
            await sleep(400);
            const freshInfo = await teeConn.getAccountInfo(tablePda);
            if (!freshInfo || freshInfo.data.length < 256) {
              console.log('  ⚠️  Table not found on ER after cashout');
              return false;
            }
            const fresh = parseTable(Buffer.from(freshInfo.data));
            const key = tablePda.toBase58();
            this.tablePhases.set(key, { phase: fresh.phase, handNumber: fresh.handNumber, currentPlayers: fresh.currentPlayers, lastPollAt: Date.now() });
            if (fresh.currentPlayers < 2) {
              this.startGameCooldown.set(key, Date.now() + 30_000);
              console.log('  ⏸  After cashout: not enough players, cooldown 30s');
              return true;
            }
            state = fresh;
          }

          // Receipt-based detection: if no Leaving seats found but L1 table says
          // current_players > 0, check if V3 already cleared them.
          // V3 is unified (transfer + clear) so processed receipts mean seats are already Empty.
          // V2 fallback: would need clear_leaving_seat, but V2 is no longer in the binary.
          if (leavingSeats.length === 0 && state.currentPlayers > 0 && crankConfig.process_cashouts) {
            // current_players may be stale — re-read table to get fresh count
            try {
              const freshInfo = await teeConn.getAccountInfo(tablePda);
              if (freshInfo && freshInfo.data.length >= 256) {
                const fresh = parseTable(Buffer.from(freshInfo.data));
                if (fresh.currentPlayers === 0) {
                  console.log(`  ℹ️  Table ${tag} current_players now 0 after V3 cashout (stale read)`);
                }
              }
            } catch {}
          }

          // Cash game tables stay delegated on ER forever — no undelegation.
          // If < 2 active players, just stay in Waiting. New players join on ER.
          // Cashouts happen via CommitState (not undelegate). Only SnG tables undelegate.
        }

        if (state.currentPlayers < 2) {
          const key = tablePda.toBase58();
          const cooldownUntil = this.startGameCooldown.get(key) || 0;
          if (Date.now() < cooldownUntil) {
            return true; // silently skip — already logged once
          }
          console.log('  ⏸  Waiting — not enough players, cooldown 30s');
          this.startGameCooldown.set(key, Date.now() + 30_000);
          return true;
        } else {
          // 2+ players — attempt start (pre-flight below checks if enough are actually active)
          const key = tablePda.toBase58();
          this.startGameCooldown.delete(key);
          console.log(`  ▶️  [${tag}] ${state.currentPlayers} players — pre-flight check`);
        }

        // ── Pre-flight: read seat statuses to find ACTUALLY playable players ──
        // currentPlayers includes SittingOut/Busted/Leaving — they can't play.
        // Use crank_kick_inactive (TEE-compatible) to mark eligible inactive
        // players as Leaving. The existing cashout flow handles L1 payout.
        if (state.gameType === 3) { // Cash game pre-flight
          let activeCount = 0;
          const kickable: { idx: number; sitOutSecs: number }[] = [];
          const nowUnix = Math.floor(Date.now() / 1000);

          for (let i = 0; i < state.maxPlayers; i++) {
            if (!(state.seatsOccupied & (1 << i))) continue;
            try {
              const seatPda = getSeatPda(tablePda, i);
              const seatInfo = await teeConn.getAccountInfo(seatPda);
              if (!seatInfo || seatInfo.data.length < 245) continue;
              const sd = Buffer.from(seatInfo.data);
              const status = sd[SEAT_STATUS_OFFSET];
              if (status === 1 || status === 3) { // Active or AllIn
                activeCount++;
              } else if (status === 4) { // SittingOut — check kick eligibility
                let sitOutSecs = 0;
                if (sd.length >= SEAT_SIT_OUT_TIMESTAMP_OFFSET + 8) {
                  const ts = Number(sd.readBigInt64LE(SEAT_SIT_OUT_TIMESTAMP_OFFSET));
                  if (ts > 0) sitOutSecs = nowUnix - ts;
                }
                const sitOutCount = sd[SEAT_SIT_OUT_COUNT_OFFSET];
                const chips = Number(sd.readBigUInt64LE(SEAT_CHIPS_OFFSET));
                const handsSinceBust = sd[SEAT_HANDS_SINCE_BUST];
                const eligible = sitOutSecs >= 300 || (sitOutCount >= 3 && sitOutSecs === 0) || (chips === 0 && handsSinceBust >= 3);
                if (eligible) kickable.push({ idx: i, sitOutSecs });
              }
              // Leaving (6) players are already being processed by cashout flow
            } catch {}
          }

          // Kick eligible inactive players using crank_kick_inactive (TEE-compatible)
          if (kickable.length > 0 && activeCount < 2 && crankConfig.auto_kick) {
            console.log(`  🧹 Pre-start: kicking ${kickable.length} inactive player(s) via crank_kick_inactive`);
            for (const s of kickable) {
              try {
                const seatPda = getSeatPda(tablePda, s.idx);
                const ix = buildCrankKickInactiveIx(this.teePayer.publicKey, tablePda, seatPda);
                const ok = await sendWithRetry(teeConn, ix, this.teePayer, 'crank_kick_inactive');
                if (ok) console.log(`  ✅ Kicked seat ${s.idx} (sitOut=${s.sitOutSecs}s) → Leaving`);
              } catch (e: any) {
                addCrankError(`kick seat ${s.idx}: ${e?.message?.slice(0, 80)}`);
              }
            }
            // Re-read table state after kicks
            await sleep(1000);
            const freshInfo = await teeConn.getAccountInfo(tablePda);
            if (freshInfo && freshInfo.data.length >= 256) {
              state = parseTable(Buffer.from(freshInfo.data));
              this.tablePhases.set(tablePda.toBase58(), { phase: state.phase, handNumber: state.handNumber, currentPlayers: state.currentPlayers, lastPollAt: Date.now() });
            }
            if (state.phase !== Phase.Waiting || state.currentPlayers < 2) {
              this.startGameCooldown.set(tablePda.toBase58(), Date.now() + 30_000);
              console.log(`  ⏸  After kick sweep: ${state.currentPlayers} players left, cooldown 30s`);
              return true;
            }
          } else if (activeCount < 2 && kickable.length === 0) {
            // Inactive players exist but not yet eligible for kick (need 300s sit-out).
            // 30s cooldown — short enough to respond quickly if a new player joins.
            const key = tablePda.toBase58();
            const cooldownUntil = this.startGameCooldown.get(key) || 0;
            if (Date.now() < cooldownUntil) return true;
            console.log(`  ⏸  ${activeCount} active, waiting for sit-out kick eligibility — cooldown 30s`);
            this.startGameCooldown.set(key, Date.now() + 30_000);
            return true;
          }
        }

        // Delay before next hand so players can see results (skip for first hand)
        if (state.handNumber > 0) {
          console.log('  ⏳ 5s delay before next hand (showing results)...');
          await sleep(5000);
        } else {
          // First hand: short delay to let delegation propagate on ER
          console.log('  ⏳ 2s delay for first hand (delegation sync)...');
          await sleep(2000);
        }

        // NOTE: Zombie guard removed. DeckState has PRIVATE permission (members=[])
        // so getAccountInfo on TEE always returns null even when absorbed. CG-CT3 guard
        // prevents delegation without all permissions — delegated tables are always valid.

        // Re-read immediately before start_game to avoid stale-phase races
        // (e.g. scheduler/test already moved Waiting -> Starting).
        const latestInfo = await teeConn.getAccountInfo(tablePda);
        if (!latestInfo || latestInfo.data.length < 256) {
          console.log('  ⚠️  Table missing before start_game');
          return false;
        }
        const latest = parseTable(Buffer.from(latestInfo.data));
        if (latest.phase !== Phase.Waiting) {
          console.log(`  ⏸  start_game skipped — phase already ${PHASE_NAMES[latest.phase] || latest.phase}`);
          return true;
        }
        if (latest.currentPlayers < 2) {
          this.startGameCooldown.set(tablePda.toBase58(), Date.now() + 30_000);
          return true;
        }

        const occS = latest.seatsOccupied;
        const occListS = [];
        for (let i = 0; i < latest.maxPlayers; i++) { if (occS & (1 << i)) occListS.push(i); }
        const startGameMode = START_GAME_USE_3N && latest.gameType <= 2 ? '3N' : '2N';

        const hasCrankTally = await this.hasCrankTallyOnTee(tablePda);

        console.log(`  🎯 [${tag}] Cranking start_game (${latest.currentPlayers} players, seats=[${occListS}], gameType=${latest.gameType}, mode=${startGameMode}, tally=${hasCrankTally})`);
        console.log(`  🔍 RPC: ${teeConn.rpcEndpoint.slice(0, 60)}... dealer=${this.payer.publicKey.toBase58().slice(0, 12)}`);
        const startIx = buildStartGameIx(this.teePayer.publicKey, tablePda, latest.maxPlayers, occS, latest.gameType, hasCrankTally);
        const started = await sendWithRetry(teeConn, startIx, this.teePayer, `[${tag}] start_game`);

        if (started) {
          // request_deal_vrf is handled by the phase-driven crank loop when table enters Starting.
          // Avoid firing VRF here to prevent duplicate request_deal_vrf races.
          return true;
        }

        // If start_game lost a race, treat it as success when phase has already moved.
        try {
          const postInfo = await teeConn.getAccountInfo(tablePda);
          if (postInfo && postInfo.data.length >= 256) {
            const post = parseTable(Buffer.from(postInfo.data));
            if (post.phase !== Phase.Waiting) {
              console.log(`  ℹ️  start_game likely raced with another crank; phase is now ${PHASE_NAMES[post.phase] || post.phase}`);
              return true;
            }
          }
        } catch {}

        // Self-heal: InvalidWritableAccount means seats/seatCards not delegated to TEE.
        // Re-delegate all accounts and retry start_game once.
        if (lastSendError.includes('InvalidWritableAccount')) {
          console.log('  🛠️  InvalidWritableAccount → re-delegating all accounts...');
          const healed = await this.tryRedelegateForEr(tablePda, latest.maxPlayers);
          if (healed) {
            await sleep(4000); // Wait for TEE propagation
            const retryIx = buildStartGameIx(this.teePayer.publicKey, tablePda, latest.maxPlayers, occS, latest.gameType, hasCrankTally);
            const retried = await sendWithRetry(teeConn, retryIx, this.teePayer, `[${tag}] start_game (post-redelegate)`);
            if (retried) return true;
          }
        }

        // Set cooldown to suppress poll-driven retries while in backoff
        this.startGameCooldown.set(tablePda.toBase58(), Date.now() + 30_000);
        return false;
      }

      // ─── STARTING → deal (Arcium MPC) ───
      case Phase.Starting: {
        return this.crankArciumDeal(tablePda, state);
      }

      // ─── AWAITING_DEAL → MPC callback pending, monitor for timeout ───
      case Phase.AwaitingDeal: {
        console.log(`  ⏳ AwaitingDeal — MPC shuffle_and_deal callback pending`);
        return true; // No action needed — MPC callback will advance phase
      }

      // ─── PREFLOP → claim_hole_cards for P2+ (fire-and-forget) ───
      case Phase.Preflop: {
        // B1 fix: After deal callback, P0+P1 have encrypted cards.
        // P2+ need a separate MPC call (claim_hole_cards) to re-encrypt from MXE Pack.
        // Fire-and-forget — don't block gameplay. Claims run in parallel.
        this.crankClaimHoleCards(tablePda, state).catch((e: any) =>
          console.warn(`  ⚠️  claim_hole_cards background error: ${e.message?.slice(0, 80)}`)
        );
        return true; // Normal Preflop — timeout system handles the rest
      }

      // ─── AWAITING_SHOWDOWN → MPC callback pending, monitor for timeout ───
      case Phase.AwaitingShowdown: {
        console.log(`  ⏳ AwaitingShowdown — MPC reveal_showdown callback pending`);
        return true; // No action — MPC callback will advance to Showdown
      }

      // ─── REVEAL PENDING → arcium_reveal_queue (MPC) ───
      case Phase.FlopRevealPending:
      case Phase.TurnRevealPending:
      case Phase.RiverRevealPending: {
        return this.crankArciumReveal(tablePda, state);
      }

      // ─── COMPLETE → CommitState → commit_and_undelegate → distribute_prizes (L1) ───
      case Phase.Complete: {
        const isCashGame = state.gameType === 3;
        if (isCashGame) {
          console.log('  ⚠️  Cash game in Complete phase — skipping (should settle to Waiting)');
          return true;
        }

        // LOCAL_MODE: no delegation — go directly to prize distribution
        if (LOCAL_MODE) {
          console.log(`  🏠 [${tablePda.toBase58().slice(0, 8)}] LOCAL_MODE Complete — distributing prizes directly`);
          await this.distributePrizesOnL1(tablePda, state);
          return true;
        }

        // Another actor (or previous retry) may have already undelegated this table.
        try {
          const l1Info = await this.l1.getAccountInfo(tablePda);
          if (l1Info && l1Info.owner.equals(PROGRAM_ID) && l1Info.data.length > OFF.PHASE) {
            const l1Phase = l1Info.data[OFF.PHASE];
            if (l1Phase === Phase.Complete) {
              console.log('  ✅ Table already on L1 (Complete) — proceeding with prizes + close');
              await this.distributePrizesOnL1(tablePda, state);
              return true;
            }
          }
        } catch {}

        // ─── STEP 1: CommitState all accounts to L1 BEFORE undelegation ───
        const tag = tablePda.toBase58().slice(0, 8);
        console.log(`  📤 [${tag}] Step 1: CommitState all accounts to L1...`);

        // 1a: Commit table + CrankTallyER
        {
          const commitPdas: PublicKey[] = [tablePda];
          try {
            const tallyPda = getCrankTallyErPda(tablePda);
            const tallyL1 = await this.l1.getAccountInfo(tallyPda).catch(() => null);
            if (tallyL1 && tallyL1.owner.equals(DELEGATION_PROGRAM_ID)) {
              const tallyOnTee = await teeConn.getAccountInfo(tallyPda).catch(() => null);
              if (tallyOnTee) commitPdas.push(tallyPda);
            }
          } catch {}
          try {
            const cIx = buildCommitInstruction(this.teePayer.publicKey, commitPdas);
            const cSig = await sendTx(teeConn, cIx, this.teePayer);
            const { confirmed } = await pollConfirmation(teeConn, cSig, 15000);
            console.log(`  ${confirmed ? '✅' : '⚠️ '} CommitState table${commitPdas.length > 1 ? '+tally' : ''} → L1 | ${cSig.slice(0, 20)}...`);
          } catch (e: any) {
            console.warn(`  ⚠️  CommitState table failed: ${e.message?.slice(0, 80)}`);
          }
        }

        // 1b: Commit seats in batch
        {
          const seatPdas: PublicKey[] = [];
          for (let i = 0; i < state.maxPlayers; i++) seatPdas.push(getSeatPda(tablePda, i));
          try {
            const cIx = buildCommitInstruction(this.teePayer.publicKey, seatPdas);
            const cSig = await sendTx(teeConn, cIx, this.teePayer);
            const { confirmed } = await pollConfirmation(teeConn, cSig, 15000);
            console.log(`  ${confirmed ? '✅' : '⚠️ '} CommitState ${seatPdas.length} seats → L1 | ${cSig.slice(0, 20)}...`);
          } catch (e: any) {
            console.warn(`  ⚠️  CommitState seats failed: ${e.message?.slice(0, 80)}`);
          }
        }

        // Wait for L1 propagation
        console.log(`  ⏳ Waiting 5s for L1 propagation...`);
        await sleep(5000);

        // ─── STEP 2: commit_and_undelegate (table + seats + deckState + seatCards) ───
        const allPdas: PublicKey[] = [];
        for (let i = 0; i < state.maxPlayers; i++) allPdas.push(getSeatPda(tablePda, i));
        allPdas.push(getDeckStatePda(tablePda));
        for (let i = 0; i < state.maxPlayers; i++) allPdas.push(getSeatCardsPda(tablePda, i));
        // NOTE: CrankTallyER NOT in allPdas — contract rejects non-seat/deckState/seatCards extras.
        console.log(`  🎯 [${tag}] Step 2: commit_and_undelegate_table (${allPdas.length} accounts)`);

        const undelegateSigner = this.teePayer;
        const ix = buildCommitAndUndelegateIx(undelegateSigner.publicKey, tablePda, allPdas);
        // DEFAULT_TX_CU_LIMIT (1.3M) is sufficient for 9-max (19 accounts).
        // Contract uses O(N) pre-computed validation — no CU issue.
        const undelegated = await sendWithRetry(teeConn, ix, undelegateSigner, `commit_and_undelegate (${allPdas.length} accounts)`);

        if (undelegated) {
          console.log(`  ✅ [${tag}] Undelegation confirmed — distributing prizes on L1`);
          await this.distributePrizesOnL1(tablePda, state);
        } else {
          // commit_and_undelegate failed — check if table already on L1 (timeout = may have landed)
          console.log('  🔍 Checking if table is already on L1...');
          await sleep(5000);
          try {
            const l1Info = await this.l1.getAccountInfo(tablePda);
            if (l1Info && l1Info.owner.equals(PROGRAM_ID)) {
              const l1Phase = l1Info.data[OFF.PHASE];
              if (l1Phase === Phase.Complete) {
                console.log('  ✅ Table on L1 (Complete) — undelegation may have landed despite timeout');
                await this.distributePrizesOnL1(tablePda, state);
                return true;
              }
            }
          } catch (e: any) {
            console.log(`  ⚠️  L1 check failed: ${e.message?.slice(0, 60)}`);
          }
        }
        return undelegated;
      }

      default: {
        // Unknown/corrupted phase (e.g. 255) — for cash games, still check for pending cashouts
        if (state.gameType === 3) {
          const leavingSeats: { seatIndex: number; wallet: PublicKey }[] = [];
          const occupiedSeats: { seatIndex: number; wallet: PublicKey }[] = [];
          for (let i = 0; i < state.maxPlayers; i++) {
            try {
              const seatPda = getSeatPda(tablePda, i);
              const seatInfo = await teeConn.getAccountInfo(seatPda);
              if (!seatInfo || seatInfo.data.length <= SEAT_STATUS_OFFSET) continue;
              const sd = Buffer.from(seatInfo.data);
              const status = sd[SEAT_STATUS_OFFSET];
              if (status === 0) continue;
              const wallet = new PublicKey(sd.subarray(SEAT_WALLET_OFFSET, SEAT_WALLET_OFFSET + 32));
              if (wallet.equals(PublicKey.default)) continue;
              occupiedSeats.push({ seatIndex: i, wallet });
              if (status === 6) {
                leavingSeats.push({ seatIndex: i, wallet });
              } else if (status === 4 && sd.length > SEAT_CASHOUT_NONCE_OFFSET + 8) {
                const cashoutChips = sd.readBigUInt64LE(SEAT_CASHOUT_CHIPS_OFFSET);
                const cashoutNonce = sd.readBigUInt64LE(SEAT_CASHOUT_NONCE_OFFSET);
                if (cashoutChips > 0n && cashoutNonce > 0n) {
                  console.log(`  🔧 Seat ${i}: SittingOut with pending cashout (phase=${state.phase}) — recovering`);
                  leavingSeats.push({ seatIndex: i, wallet });
                }
              }
            } catch {}
          }
          if (leavingSeats.length > 0) {
            console.log(`  🔍 Phase ${state.phase} recovery: ${leavingSeats.length} pending cashout(s)`);
            await this.processCashGameCashouts(tablePda, state, leavingSeats, occupiedSeats);
          }
        }
        return true;
      }
    }
  }

  // ───────────────── L1 Prize Distribution + Steel Minting ──────

  /**
   * Vault-based cashout: process_cashout_v2 on L1 + clear_leaving_seat on ER.
   * NO undelegation needed — vault is on L1, seat data is readable via delegation shadow.
   * Called when Waiting phase has Leaving players that need cashout.
   */
  private async processCashGameCashouts(
    tablePda: PublicKey,
    state: TableState,
    leavingSeats: { seatIndex: number; wallet: PublicKey }[],
    _occupiedSeats: { seatIndex: number; wallet: PublicKey }[],
  ): Promise<boolean> {
    if (!this.l1Payer) {
      console.log('  ⚠️  No L1 payer — cannot process cashouts');
      return false;
    }
    const tableKey = tablePda.toBase58().slice(0, 12);
    const teeConn = this.getConnForTable(tablePda.toBase58());
    console.log(`  💰 Vault cashout: ${leavingSeats.length} leaving player(s) at ${tableKey}...`);

    // Pre-check: read L1 receipts to find seats where cashout is already processed.
    // These only need clear_leaving_seat — skip CommitState + process_cashout_v2 entirely.
    const alreadyProcessed: number[] = [];
    const needsCashout: { seatIndex: number; wallet: PublicKey }[] = [];
    for (const { seatIndex, wallet } of leavingSeats) {
      try {
        const seatPda = getSeatPda(tablePda, seatIndex);
        const [seatInfo, receiptInfo] = await Promise.all([
          this.l1.getAccountInfo(seatPda).catch(() => null),
          this.l1.getAccountInfo(getReceiptPda(tablePda, seatIndex)).catch(() => null),
        ]);
        if (seatInfo && receiptInfo && seatInfo.data.length > SEAT_CASHOUT_NONCE_OFFSET + 8 && receiptInfo.data.length >= 49) {
          const sd = Buffer.from(seatInfo.data);
          const seatNonce = Number(sd.readBigUInt64LE(SEAT_CASHOUT_NONCE_OFFSET));
          const receiptNonce = Number(Buffer.from(receiptInfo.data).readBigUInt64LE(41));
          if (seatNonce > 0 && receiptNonce >= seatNonce) {
            console.log(`  ℹ️  Seat ${seatIndex} cashout already on L1 (nonce=${seatNonce}, receipt=${receiptNonce}) — skip to clear`);
            alreadyProcessed.push(seatIndex);
            continue;
          }
        }
      } catch {}
      needsCashout.push({ seatIndex, wallet });
    }

    // Fast path: already-processed seats — V3 already cleared them, nothing to do.
    // (V2 era needed a separate clear_leaving_seat, but V3 is unified.)
    if (alreadyProcessed.length > 0) {
      console.log(`  ✅ ${alreadyProcessed.length} seat(s) already cashed out + cleared by V3 (fast path)`);
    }

    // If all seats were already processed, we're done
    if (needsCashout.length === 0) {
      console.log(`  ✅ All ${alreadyProcessed.length} seat(s) already cashed out — cleared`);
      return true;
    }

    // Step 1: CommitState on ER — push seat data (+ table for SPL) to L1 so contract can read it
    // LOCAL_MODE: skip CommitState — data already on L1 (no delegation)
    const isSplTable = !state.tokenMint.equals(PublicKey.default);
    if (!LOCAL_MODE) {
      const seatPdasToCommit = needsCashout.map(s => getSeatPda(tablePda, s.seatIndex));
      // For SPL tables, also commit the table PDA so process_cashout_v2 can read table_id for PDA signing
      const pdasToCommit = isSplTable ? [tablePda, ...seatPdasToCommit] : seatPdasToCommit;
      try {
        const commitIx = buildCommitInstruction(this.teePayer.publicKey, pdasToCommit);
        const commitTx = new Transaction().add(commitIx);
        commitTx.feePayer = this.teePayer.publicKey;
        commitTx.recentBlockhash = (await teeConn.getLatestBlockhash()).blockhash;
        commitTx.sign(this.teePayer);
        const commitSig = await teeConn.sendRawTransaction(commitTx.serialize(), { skipPreflight: true });
        const { confirmed: commitOk } = await pollConfirmation(teeConn, commitSig);
        if (!commitOk) throw new Error('CommitState confirmation timeout');
        await recordCrankTxMetrics(teeConn, 'commit_state (cashout seats)', commitSig);
        console.log(`  ✅ CommitState ${isSplTable ? 'table+' : ''}seats → L1 | sig: ${commitSig.slice(0, 20)}...`);
      } catch (e: any) {
        console.log(`  ⚠️  CommitState failed — seats not synced to L1: ${e.message?.slice(0, 100)}`);
        return alreadyProcessed.length > 0; // partial success if some seats were cleared
      }

      // Wait for CommitState to propagate to L1 (ER confirms commit but L1 update is async)
      await sleep(5000);
    }

    // Step 2: process_cashout on L1
    // V3 (preferred): unified TX that transfers funds AND clears seat. No separate clear_leaving_seat.
    // V2 (fallback): only transfers funds, needs separate clear_leaving_seat on ER after.
    const useV3 = true; // V3 is in current deployed binary
    const tableTokenAta = isSplTable
      ? await getAssociatedTokenAddress(state.tokenMint, tablePda, true)
      : undefined;

    let cashoutCount = 0;
    const succeededSeats: number[] = [];
    for (const { seatIndex, wallet } of needsCashout) {
      try {
        const vaultPda = getVaultPda(tablePda);
        const receiptPda = getReceiptPda(tablePda, seatIndex);
        const markerPda = getPlayerTableMarkerPda(wallet, tablePda);
        const [vaultInfo, receiptInfo, markerInfo, payerBal] = await Promise.all([
          this.l1.getAccountInfo(vaultPda).catch(() => null),
          this.l1.getAccountInfo(receiptPda).catch(() => null),
          this.l1.getAccountInfo(markerPda).catch(() => null),
          this.l1.getBalance(this.l1Payer.publicKey).catch(() => 0),
        ]);
        console.log(`  🔍 Cashout diag seat ${seatIndex}: payer=${payerBal} vault=${vaultInfo?.lamports ?? 'NONE'}(${vaultInfo?.data.length ?? 0}b) receipt=${receiptInfo?.lamports ?? 'NONE'}(${receiptInfo?.data.length ?? 0}b) marker=${markerInfo?.lamports ?? 'NONE'}(${markerInfo?.data.length ?? 0}b)`);

        const playerTokenAta = isSplTable
          ? await getAssociatedTokenAddress(state.tokenMint, wallet, false)
          : undefined;

        const ix = useV3
          ? buildProcessCashoutV3Ix(
              this.l1Payer.publicKey, tablePda, seatIndex, wallet,
              isSplTable ? state.tokenMint : undefined,
              playerTokenAta, tableTokenAta,
            )
          : buildProcessCashoutV2Ix(
              this.l1Payer.publicKey, tablePda, seatIndex, wallet,
              isSplTable ? state.tokenMint : undefined,
              playerTokenAta, tableTokenAta,
            );
        const tx = new Transaction().add(ix);
        tx.feePayer = this.l1Payer.publicKey;
        tx.recentBlockhash = (await this.l1.getLatestBlockhash('confirmed')).blockhash;
        const sig = await sendAndConfirmTransaction(this.l1, tx, [this.l1Payer], { commitment: 'confirmed' });
        await recordCrankTxMetrics(this.l1, useV3 ? 'process_cashout_v3' : 'process_cashout_v2', sig);
        console.log(`  ✅ Cashout seat ${seatIndex} → ${wallet.toBase58().slice(0, 8)}... (${sig.slice(0, 20)})`);
        cashoutCount++;
        succeededSeats.push(seatIndex);
      } catch (e: any) {
        const errMsg = e.message || '';
        // NonceAlreadyProcessed (0x17cf / 6095) = cashout already succeeded on L1 but
        // clear_leaving_seat never ran. Safe to proceed to clear the seat.
        if (errMsg.includes('0x17cf') || errMsg.includes('custom program error: 0x17cf')) {
          console.log(`  ℹ️  Cashout seat ${seatIndex} already processed (nonce match) — will clear seat`);
          succeededSeats.push(seatIndex);
        } else {
          console.log(`  ⚠️  Cashout seat ${seatIndex} failed: ${errMsg.slice(0, 120)}`);
        }
      }
    }

    // Step 3: Clear ONLY seats where cashout succeeded on L1
    // V3 already clears the seat — skip clear_leaving_seat for V3.
    // V2 fallback: NEVER clear a seat where cashout failed — player's SOL would be stuck in vault forever
    for (const seatIndex of succeededSeats) {
      if (!useV3) {
        try {
          const ix = buildClearLeavingSeatIx(this.teePayer.publicKey, tablePda, seatIndex);
          const ok = await sendWithRetry(teeConn, ix, this.teePayer, `clear_leaving_seat(${seatIndex})`);
          if (ok) {
            console.log(`  ✅ Seat ${seatIndex} cleared on ER`);
          }
        } catch (e: any) {
          console.log(`  ⚠️  Clear seat ${seatIndex} failed: ${e.message?.slice(0, 80)}`);
        }
      }

      // Step 3b: Cleanup stale DepositProof PDA (undelegate + close on ER)
      // Prevents delegation-owned PDAs from blocking future deposit_for_join
      try {
        // First check if proof exists on L1 to diagnose the flow
        const proofPda = getDepositProofPda(tablePda, seatIndex);
        const proofL1 = await this.l1.getAccountInfo(proofPda).catch(() => null);
        const proofTee = await teeConn.getAccountInfo(proofPda).catch(() => null);
        const l1Owner = proofL1 ? proofL1.owner.toBase58().slice(0, 12) : 'NONE';
        const teeExists = proofTee ? 'yes' : 'no';
        const l1Consumed = proofL1 && proofL1.data.length > 89 ? proofL1.data[89] : -1;
        const teeConsumed = proofTee && proofTee.data.length > 89 ? Buffer.from(proofTee.data)[89] : -1;
        console.log(`  🔍 DepositProof[${seatIndex}] L1=${l1Owner} TEE=${teeExists} L1consumed=${l1Consumed} TEEconsumed=${teeConsumed}`);

        // Skip cleanup if proof doesn't exist on TEE or L1 owner is already our program (already undelegated)
        if (!proofTee) {
          console.log(`  ✅ DepositProof[${seatIndex}] not on TEE — nothing to clean up`);
        } else if (proofL1 && proofL1.owner.toBase58() !== DELEGATION_PROGRAM_ID.toBase58()) {
          console.log(`  ✅ DepositProof[${seatIndex}] already undelegated on L1 — skipping cleanup`);
        } else {
          // If proof is unconsumed, pass seat PDA as remaining_account for stale proof recovery
          // Contract allows cleanup of unconsumed proofs when the corresponding seat is Empty
          const seatPda = teeConsumed !== 1 ? getSeatPda(tablePda, seatIndex) : undefined;
          const cleanupIx = buildCleanupDepositProofIx(this.teePayer.publicKey, tablePda, seatIndex, seatPda);
          const sig = await sendTx(teeConn, cleanupIx, this.teePayer);
          const { confirmed, err } = await pollConfirmation(teeConn, sig);
          if (confirmed) {
            console.log(`  ✅ DepositProof[${seatIndex}] cleaned up on TEE`);
          } else {
            console.log(`  ⚠️  DepositProof[${seatIndex}] cleanup FAILED — err=${JSON.stringify(err)} sig=${sig.slice(0, 20)}`);
          }
        }
      } catch (e: any) {
        const errMsg = e?.message?.slice(0, 120) || 'unknown';
        const code = errMsg.match(/custom program error: 0x(\w+)/)?.[1];
        console.log(`  ⚠️  DepositProof[${seatIndex}] cleanup failed: ${code ? `code=0x${code}` : errMsg}`);
      }
    }
    if (succeededSeats.length < leavingSeats.length) {
      console.log(`  ⚠️  ${leavingSeats.length - succeededSeats.length} seat(s) NOT cleared (cashout failed — will retry next sweep)`);
    }

    console.log(`  ✅ Vault cashout complete — ${cashoutCount}/${leavingSeats.length} processed`);
    return true;
  }

  /**
   * After commit_and_undelegate moves the table back to L1:
   * 1. Poll L1 until table appears with Complete phase
   * 2. Call distribute_prizes (marks prizes_distributed, emits event)
   * 3. Read elimination order + seat wallets from L1
   * POKER credits are now atomic via CPI — no separate mint_unrefined needed.
   */
  private async distributePrizesOnL1(tablePda: PublicKey, state: TableState): Promise<void> {
    if (!this.l1Payer) {
      console.log('  ⚠️  No L1 payer — skipping distribute_prizes');
      return;
    }

    console.log('  🏆 Waiting for table to appear on L1 for prize distribution...');

    // Poll L1 until table data is available (undelegation can take a few seconds)
    let l1Data: Buffer | null = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(3000);
      try {
        const info = await this.l1.getAccountInfo(tablePda);
        if (info && info.data.length > OFF.PHASE) {
          if (!info.owner.equals(PROGRAM_ID)) {
            if (attempt === 0 || attempt === 4 || attempt === 8) {
              console.log('  ⏳ L1 table still owned by delegation program, waiting for undelegate finalize...');
            }
            continue;
          }
          const phase = info.data[OFF.PHASE];
          if (phase === Phase.Complete) {
            l1Data = info.data as Buffer;
            break;
          }
          console.log(`  ⏳ L1 table phase=${PHASE_NAMES[phase] || phase}, waiting...`);
        }
      } catch {}
    }

    if (!l1Data) {
      console.log('  ⚠️  Table not found on L1 after 30s — skipping distribute_prizes');
      return;
    }

    // Guard: verify ALL seats are program-owned on L1 before attempting distribute_prizes.
    // If any seat is still delegation-owned, the contract will reject with InvalidAccountData.
    // This happens when seat undelegation partially failed (old batching bug — now fixed).
    const mp = l1Data[OFF.MAX_PLAYERS];
    for (let i = 0; i < mp; i++) {
      try {
        const sInfo = await this.l1.getAccountInfo(getSeatPda(tablePda, i));
        if (sInfo && !sInfo.owner.equals(PROGRAM_ID)) {
          const key = tablePda.toBase58();
          this.blockedTables.add(key);
          console.log(`  🚫 Seat ${i} still delegation-owned on L1 — blocking table ${key.slice(0, 12)}...`);
          console.log(`     Orphaned seats need MagicBlock UndelegateConfinedAccount (disc=18).`);
          return;
        }
      } catch {}
    }

    // Ensure prizes are distributed (by us or by another caller)
    let prizesConfirmed = l1Data[OFF.PRIZES_DISTRIBUTED] !== 0;

    if (!prizesConfirmed) {
      // Step 1: Read tiered SNG fields + determine ITM Player PDAs
      const escrowed = l1Data.length > OFF.ENTRY_FEES_ESCROWED + 8
        ? l1Data.readBigUInt64LE(OFF.ENTRY_FEES_ESCROWED)
        : 0n;
      const prizePool = l1Data.length > OFF.PRIZE_POOL + 8
        ? l1Data.readBigUInt64LE(OFF.PRIZE_POOL)
        : 0n;
      const feeTotal = escrowed - prizePool; // fees = total escrowed - prize portion

      // Determine ITM Player PDAs (needed if prize_pool > 0)
      const gameType = l1Data[OFF.GAME_TYPE];
      const maxPlayers = l1Data[OFF.MAX_PLAYERS];
      const elimCount = l1Data[OFF.ELIMINATED_COUNT];
      const payoutBps = PAYOUTS[gameType];
      const numItm = payoutBps ? payoutBps.length : 1;

      // Read seat wallets + build finish order to derive Player PDAs
      const seatWalletsForPda: PublicKey[] = [];
      for (let i = 0; i < maxPlayers; i++) {
        try {
          const seatInfo = await this.l1.getAccountInfo(getSeatPda(tablePda, i));
          if (seatInfo && seatInfo.data.length >= SEAT_WALLET_OFFSET + 32) {
            seatWalletsForPda.push(new PublicKey(seatInfo.data.slice(SEAT_WALLET_OFFSET, SEAT_WALLET_OFFSET + 32)));
          } else {
            seatWalletsForPda.push(PublicKey.default);
          }
        } catch {
          seatWalletsForPda.push(PublicKey.default);
        }
      }

      // Build finish order for ITM Player PDA derivation
      const eliminatedSeatsForPda: number[] = [];
      for (let i = 0; i < elimCount; i++) {
        eliminatedSeatsForPda.push(l1Data[OFF.ELIMINATED_SEATS + i]);
      }
      const winnerSeatForPda = Array.from({ length: maxPlayers }, (_, i) => i)
        .find(s => !eliminatedSeatsForPda.includes(s) && !seatWalletsForPda[s].equals(PublicKey.default));

      // Build ordered finish: 1st=winner, 2nd=last eliminated, ...
      const itmPlayerPdas: PublicKey[] = [];
      const itmUnrefinedPdas: PublicKey[] = [];
      if (winnerSeatForPda !== undefined) {
        const finishWalletsForPda: PublicKey[] = [seatWalletsForPda[winnerSeatForPda]];
        for (let i = eliminatedSeatsForPda.length - 1; i >= 0; i--) {
          finishWalletsForPda.push(seatWalletsForPda[eliminatedSeatsForPda[i]]);
        }
        // Always derive Player + Unrefined PDAs for ITM positions
        for (let pos = 0; pos < numItm && pos < finishWalletsForPda.length; pos++) {
          const winnerWallet = finishWalletsForPda[pos];
          itmPlayerPdas.push(getPlayerPda(winnerWallet));
          itmUnrefinedPdas.push(getUnrefinedPda(winnerWallet));
        }
        console.log(`  💰 Prize pool: ${prizePool} lamports, ITM Player PDAs=${itmPlayerPdas.length}, Unrefined PDAs=${itmUnrefinedPdas.length}`);
      }

      // Step 2: Call distribute_prizes on L1 (atomic SOL + POKER + fee routing)
      const dpIx = buildDistributePrizesIx(
        this.l1Payer.publicKey,
        tablePda,
        maxPlayers,
        itmPlayerPdas,
        itmUnrefinedPdas,
      );

      console.log(`  🎯 Sending atomic distribute_prizes on L1 (fees=${feeTotal}, prizes=${prizePool})`);
      // 6062 = PrizesAlreadyDistributed — harmless race when test script or another caller distributes first
      const dpSent = await sendWithRetry(this.l1, dpIx, this.l1Payer, 'distribute_prizes (L1)', 3, false, [6062]);
      if (!dpSent) {
        // Re-check: someone else may have distributed prizes in parallel
        try {
          const recheck = await this.l1.getAccountInfo(tablePda);
          if (recheck && recheck.data.length > OFF.PRIZES_DISTRIBUTED && recheck.data[OFF.PRIZES_DISTRIBUTED] !== 0) {
            prizesConfirmed = true;
            console.log('  ℹ️  Prizes already distributed by another caller');
          }
        } catch {}
        if (!prizesConfirmed) {
          console.log('  ⚠️  distribute_prizes failed');
          return;
        }
      }

      // sendWithRetry can return true after a confirm-timeout assumption.
      // Verify the authoritative on-chain flag before declaring success.
      if (!prizesConfirmed) {
        try {
          const postInfo = await this.l1.getAccountInfo(tablePda);
          if (!postInfo || postInfo.data.length <= OFF.PRIZES_DISTRIBUTED || postInfo.data[OFF.PRIZES_DISTRIBUTED] === 0) {
            console.log('  ⚠️  distribute_prizes sent but prizes_distributed is still false — will retry');
            return;
          }
          prizesConfirmed = true;
        } catch (e: any) {
          console.log(`  ⚠️  distribute_prizes post-check failed: ${e?.message?.slice(0, 80)}`);
          return;
        }
      }

      console.log('  ✅ distribute_prizes succeeded (atomic SOL + POKER + fees)');
    } else {
      console.log('  ℹ️  Prizes already distributed');
    }

    // === Post-distribution: crank rewards + table reset (always runs after prizes confirmed) ===
    await this.distributeCrankRewards(tablePda, tablePda.toBase58());
    console.log('  🏆 Tournament prizes + crank rewards distributed on L1!');
    await this.resetSngTableForReuse(tablePda, mp);
  }

  /**
   * Reset SNG table for reuse after prizes are distributed.
   * Zeros all seats, resets table to Waiting phase.
   * Table stays on L1 ready for new players to join.
   */
  private async resetSngTableForReuse(tablePda: PublicKey, maxPlayers: number): Promise<void> {
    if (!this.l1Payer) {
      console.log('  ⚠️  No L1 payer — skipping reset_sng_table');
      return;
    }
    const key = tablePda.toBase58().slice(0, 12);
    console.log(`  🔄 Resetting SNG table ${key}... for reuse (${maxPlayers} seats)`);

    // Read seat wallets BEFORE reset (needed for marker PDA derivation)
    const seatWallets: PublicKey[] = [];
    for (let i = 0; i < maxPlayers; i++) {
      try {
        const seatPda = getSeatPda(tablePda, i);
        const seatInfo = await this.l1.getAccountInfo(seatPda);
        if (seatInfo && seatInfo.data.length > 40) {
          const wallet = new PublicKey(seatInfo.data.subarray(8, 40));
          seatWallets.push(wallet);
        } else {
          seatWallets.push(PublicKey.default);
        }
      } catch {
        seatWallets.push(PublicKey.default);
      }
    }

    const ix = buildResetSngTableIx(this.l1Payer.publicKey, tablePda, maxPlayers, seatWallets);
    const ok = await sendWithRetry(this.l1, ix, this.l1Payer, 'reset_sng_table');
    if (ok) {
      console.log(`  ✅ Table ${key}... reset to Waiting — ready for reuse`);

      // Defense-in-depth for 2N mode: lock all seatCards permissions on L1 after reset
      // so the next join must explicitly set viewer access for new occupants.
      // Best-effort: if a permission PDA is missing or still delegation-owned, skip it.
      for (let i = 0; i < maxPlayers; i++) {
        try {
          const seatCardsPda = getSeatCardsPda(tablePda, i);
          const permPda = getPermissionPda(seatCardsPda);
          const permInfo = await this.l1.getAccountInfo(permPda);
          if (!permInfo) {
            console.log(`  ℹ️  [${key}] reset_seat_permission[${i}] skipped: permission PDA missing`);
            continue;
          }
          if (!permInfo.owner.equals(PERMISSION_PROGRAM_ID)) {
            console.log(`  ℹ️  [${key}] reset_seat_permission[${i}] skipped: permission owner=${permInfo.owner.toBase58().slice(0, 8)}...`);
            continue;
          }

          const resetIx = buildResetSeatPermissionIx(this.l1Payer.publicKey, tablePda, i);
          const resetOk = await sendWithRetry(this.l1, resetIx, this.l1Payer, `reset_seat_permission[${i}]`, 2);
          if (!resetOk) {
            console.log(`  ⚠️  [${key}] reset_seat_permission[${i}] failed (continuing)`);
          }
        } catch (e: any) {
          console.log(`  ⚠️  [${key}] reset_seat_permission[${i}] error: ${e?.message?.slice(0, 80) || e}`);
        }
      }
    } else {
      console.log(`  ⚠️  reset_sng_table failed — table may need manual close`);
    }
  }

  /**
   * Close table + seat + seat_cards + marker PDAs on L1 to recover rent SOL.
   * Called after distribute_prizes completes (SOL + POKER atomic).
   *
   * remaining_accounts layout per seat (groups of 4):
   *   [player_wallet, seat_pda, seat_cards_pda, marker_pda]
   *
   * Rent routing:
   *   - PlayerSeat rent → player wallet
   *   - SeatCards rent → creator (who paid for table creation)
   *   - PlayerTableMarker rent → player wallet
   *   - Table rent → creator (via Anchor close = creator)
   */
  private async closeTableAndAccounts(tablePda: PublicKey, maxPlayers: number): Promise<void> {
    const key = tablePda.toBase58().slice(0, 12);

    // Safety check: verify prizes_distributed is set before closing + read creator
    let tableCreator: PublicKey = this.l1Payer!.publicKey; // fallback to crank payer
    try {
      const info = await this.l1.getAccountInfo(tablePda);
      if (info && info.data.length > OFF.PRIZES_DISTRIBUTED) {
        if (info.data[OFF.PRIZES_DISTRIBUTED] === 0) {
          console.log(`  🚫 Table ${key}... NOT closing — prizes_distributed is false! Escrowed SOL would be lost.`);
          return;
        }
        // Read creator pubkey so rent goes back to whoever created the table
        if (info.data.length >= OFF.CREATOR + 32) {
          tableCreator = new PublicKey(info.data.slice(OFF.CREATOR, OFF.CREATOR + 32));
        }
      }
    } catch {}

    console.log(`  🧹 Closing table + ${maxPlayers} seat accounts on L1 to recover rent...`);

    // Build remaining_accounts seat groups: [player_wallet, seat, seat_cards, marker]
    const seatGroups: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[][] = [];
    let seatGroupCount = 0;

    for (let i = 0; i < maxPlayers; i++) {
      const seatPda = getSeatPda(tablePda, i);
      const seatCardsPda = getSeatCardsPda(tablePda, i);

      // Read player wallet from seat data on L1
      let playerWallet: PublicKey | null = null;
      try {
        const seatInfo = await this.l1.getAccountInfo(seatPda);
        if (seatInfo && seatInfo.data.length >= SEAT_WALLET_OFFSET + 32 && seatInfo.owner.equals(PROGRAM_ID)) {
          playerWallet = new PublicKey(seatInfo.data.slice(SEAT_WALLET_OFFSET, SEAT_WALLET_OFFSET + 32));
        }
      } catch {}

      if (!playerWallet || playerWallet.equals(PublicKey.default)) {
        // Seat is empty or unreadable — skip this seat group
        continue;
      }

      const markerPda = getPlayerTableMarkerPda(playerWallet, tablePda);

      const seatGroup = [
        { pubkey: playerWallet,  isSigner: false, isWritable: true },
        { pubkey: seatPda,       isSigner: false, isWritable: true },
        { pubkey: seatCardsPda,  isSigner: false, isWritable: true },
        { pubkey: markerPda,     isSigner: false, isWritable: true },
      ];
      seatGroups.push(seatGroup);
      seatGroupCount += 1;
    }

    // Append vault + receipt PDAs for cash game tables (closed after seat chunks)
    const extraKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    const vaultPda = getVaultPda(tablePda);
    try {
      const vaultInfo = await this.l1.getAccountInfo(vaultPda);
      if (vaultInfo && vaultInfo.owner.equals(PROGRAM_ID)) {
        extraKeys.push({ pubkey: vaultPda, isSigner: false, isWritable: true });
        // Also add receipt PDAs for each seat
        for (let i = 0; i < maxPlayers; i++) {
          const receiptPda = getReceiptPda(tablePda, i);
          try {
            const rInfo = await this.l1.getAccountInfo(receiptPda);
            if (rInfo && rInfo.owner.equals(PROGRAM_ID)) {
              extraKeys.push({ pubkey: receiptPda, isSigner: false, isWritable: true });
            }
          } catch {}
        }
      }
    } catch {}

    // Build close_table instruction with remaining_accounts
    // Account layout: payer(signer), table, creator(receives rent), system_program, ...seats, ...vault/receipts
    const baseKeys = [
      { pubkey: this.l1Payer!.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: tableCreator, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    // Keep close_table under packet size limits by pre-selecting the largest
    // seat-group subset that fits in one tx.
    const MAX_TX_BYTES = 1232;
    const TX_SIZE_BUFFER = 8;
    const txByteBudget = MAX_TX_BYTES - TX_SIZE_BUFFER;

    const buildCloseIx = (
      seatGroupsToInclude: number,
      includeExtraKeys: boolean,
    ): TransactionInstruction => {
      const seatKeys = seatGroups.slice(0, seatGroupsToInclude).flat();
      return new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [...baseKeys, ...seatKeys, ...(includeExtraKeys ? extraKeys : [])],
        data: DISC.closeTable,
      });
    };

    const estimateCloseTxBytes = (seatGroupsToInclude: number, includeExtraKeys: boolean): number => {
      try {
        const tx = new Transaction();
        addComputeBudgetIxs(tx);
        tx.add(buildCloseIx(seatGroupsToInclude, includeExtraKeys));
        tx.feePayer = this.l1Payer!.publicKey;
        tx.recentBlockhash = '11111111111111111111111111111111';
        return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
      } catch {
        return Number.MAX_SAFE_INTEGER;
      }
    };

    let groupsToClose = seatGroupCount;
    let includeExtras = extraKeys.length > 0;

    while (groupsToClose > 0 && estimateCloseTxBytes(groupsToClose, includeExtras) > txByteBudget) {
      groupsToClose--;
    }

    if (includeExtras && estimateCloseTxBytes(groupsToClose, includeExtras) > txByteBudget) {
      includeExtras = false;
    }

    if (groupsToClose < seatGroupCount) {
      console.log(`  ⚠️  close_table tx-size budget allows ${groupsToClose}/${seatGroupCount} seat groups`);
    }
    if (!includeExtras && extraKeys.length > 0) {
      console.log(`  ⚠️  Skipping ${extraKeys.length} extra close accounts (vault/receipts) due tx-size budget`);
    }
    const estimatedBytes = estimateCloseTxBytes(groupsToClose, includeExtras);
    if (estimatedBytes !== Number.MAX_SAFE_INTEGER) {
      console.log(
        `  📦 close_table tx estimate: ${estimatedBytes} bytes ` +
        `(budget ${txByteBudget}, seats ${groupsToClose}/${seatGroupCount}, extras ${includeExtras ? 'yes' : 'no'})`
      );
    }

    let closeIx = buildCloseIx(groupsToClose, includeExtras);
    const closeLabel = `close_table (+ ${groupsToClose} seats${includeExtras ? ' + extras' : ''})`;
    let closed = await sendWithRetry(this.l1, closeIx, this.l1Payer!, closeLabel);

    if (!closed) {
      console.log('  ⚠️  close_table with seat cleanup failed — retrying table-only fallback');
      const fallbackIx = buildCloseIx(0, false);
      closed = await sendWithRetry(this.l1, fallbackIx, this.l1Payer!, 'close_table (table-only fallback)');
      if (closed && groupsToClose > 0) {
        console.log(`  ⚠️  Table ${key}... closed without seat cleanup (fallback after ${groupsToClose}-seat attempt)`);
      }
    } else if (groupsToClose < seatGroupCount) {
      console.log(`  ⚠️  Table ${key}... closed with partial seat cleanup (${groupsToClose}/${seatGroupCount})`);
    }

    if (closed) {
      console.log(`  ✅ Table ${key}... closed`);
    } else {
      console.log(`  ⚠️  Failed to close table ${key}...`);
    }
  }

  // ───────────────── Timeout scheduling ──────────────────────────

  /**
   * Update the turn timer when a phase/player change is detected.
   * Only tracks active betting phases (Preflop, Flop, Turn, River).
   */
  private updateTurnTimer(tablePda: PublicKey, state: TableState): void {
    const key = tablePda.toBase58();
    const isBettingPhase =
      state.phase === Phase.Preflop ||
      state.phase === Phase.Flop ||
      state.phase === Phase.Turn ||
      state.phase === Phase.River;

    if (!isBettingPhase) {
      this.turnTimers.delete(key);
      return;
    }

    const existing = this.turnTimers.get(key);
    // Only reset timer if current_player changed or it's a new entry
    if (!existing || existing.currentPlayer !== state.currentPlayer) {
      this.turnTimers.set(key, {
        currentPlayer: state.currentPlayer,
        turnStartMs: Date.now(),
        tablePda,
        maxPlayers: state.maxPlayers,
      });
    }
  }

  /**
   * Periodic checker: every 2 seconds, scan all tracked turns and
   * fire handle_timeout for any player idle longer than TIMEOUT_MS.
   */
  private startTimeoutChecker(): void {
    this.timeoutIntervalId = setInterval(() => this.checkTimeouts(), 2_000);
    console.log(`⏰ Timeout checker started (${TIMEOUT_MS / 1000}s threshold, 2s poll)`);
  }

  private async checkTimeouts(): Promise<void> {
    if (!crankConfig.timeout_enabled) return;
    const now = Date.now();
    const timeoutThreshold = crankConfig.timeout_ms || TIMEOUT_MS;
    for (const [key, info] of this.turnTimers.entries()) {
      const elapsed = now - info.turnStartMs;
      if (elapsed < timeoutThreshold) continue;

      // Don't timeout while we're already processing or in failure backoff
      if (this.processing.has(key)) continue;
      if (this.isInBackoff(key)) continue;

      // Re-read table to confirm still in betting phase + same current_player
      try {
        const acctInfo = await this.getConnForTable(key).getAccountInfo(info.tablePda);
        if (!acctInfo || acctInfo.data.length < 256) {
          this.turnTimers.delete(key);
          continue;
        }
        let fresh = parseTable(Buffer.from(acctInfo.data));
        const preparedFresh = await this.prepareErCrankState(info.tablePda, fresh);
        if (!preparedFresh) {
          this.noteFailure(key, 'redelegate');
          continue;
        }
        fresh = preparedFresh;
        const isBetting =
          fresh.phase === Phase.Preflop ||
          fresh.phase === Phase.Flop ||
          fresh.phase === Phase.Turn ||
          fresh.phase === Phase.River;

        if (!isBetting || fresh.currentPlayer !== info.currentPlayer) {
          this.updateTurnTimer(info.tablePda, fresh);
          continue;
        }

        // Fire handle_timeout
        console.log(
          `\n⏰ TIMEOUT: ${key.slice(0, 12)}... seat ${info.currentPlayer}` +
          ` idle ${(elapsed / 1000).toFixed(1)}s → auto-fold`,
        );
        const hasTally = await this.hasCrankTallyOnTee(info.tablePda);
        const ix = buildHandleTimeoutIx(
          this.teePayer.publicKey,
          info.tablePda,
          fresh.currentPlayer,
          fresh.actionNonce,
          hasTally,
        );
        this.processing.add(key);
        try {
          const success = await sendWithRetry(this.getConnForTable(key), ix, this.teePayer, `[${key.slice(0, 8)}] handle_timeout`, 3, false, [6022]);
          if (!success) {
            // 6022 = InvalidActionForPhase — phase changed (race with main loop or another crank).
            // Re-read table and route to correct action instead of backing off.
            if (lastSendError.includes('"Custom":6022')) {
              console.log(`  🔄 handle_timeout raced — re-reading table for current phase`);
              const rereadInfo = await this.getConnForTable(key).getAccountInfo(info.tablePda);
              if (rereadInfo && rereadInfo.data.length >= 256) {
                const rereadState = parseTable(Buffer.from(rereadInfo.data));
                this.tablePhases.set(key, { phase: rereadState.phase, handNumber: rereadState.handNumber, currentPlayers: rereadState.currentPlayers, lastPollAt: Date.now() });
                this.updateTurnTimer(info.tablePda, rereadState);
                if (this.needsCrank(rereadState.phase, rereadState.currentPlayers, rereadState.handNumber, rereadState.gameType, rereadState.maxPlayers, rereadState.isDelegated)) {
                  await this.doCrank(info.tablePda, rereadState);
                }
              }
              this.turnTimers.delete(key);
              continue;
            }
            this.noteFailure(key, 'timeout');
            continue;
          }
          this.clearFailure(key);

          // Chain loop: handle_timeout may advance phase multiple steps
          // (e.g. → Showdown → settle → Waiting → start_game → Starting → VRF)
          let lastPhase = fresh.phase;
          let lastHand = fresh.handNumber;
          for (let chain = 0; chain < 6; chain++) {
            await sleep(400);
            const postInfo = await this.getConnForTable(key).getAccountInfo(info.tablePda);
            if (!postInfo || postInfo.data.length < 256) break;
            const postState = parseTable(Buffer.from(postInfo.data));
            if (postState.phase === lastPhase && postState.handNumber === lastHand) break;
            this.tablePhases.set(key, { phase: postState.phase, handNumber: postState.handNumber, currentPlayers: postState.currentPlayers, lastPollAt: Date.now() });
            this.updateTurnTimer(info.tablePda, postState);
            if (!this.needsCrank(postState.phase, postState.currentPlayers, postState.handNumber, postState.gameType, postState.maxPlayers, postState.isDelegated)) break;
            console.log(
              `  🔄 Post-timeout chain: → ${PHASE_NAMES[postState.phase]}` +
              `  hand=#${postState.handNumber} players=${postState.currentPlayers}`,
            );
            const preparedPost = await this.prepareErCrankState(info.tablePda, postState);
            if (!preparedPost) {
              this.noteFailure(key, 'redelegate');
              break;
            }
            lastPhase = preparedPost.phase;
            lastHand = preparedPost.handNumber;
            await this.doCrank(info.tablePda, preparedPost);
          }
        } finally {
          this.processing.delete(key);
        }
        // Remove timer — onAccountChange will re-add if new turn starts
        this.turnTimers.delete(key);
      } catch (e: any) {
        console.warn(`  ⚠️  timeout check error for ${key.slice(0, 12)}: ${e?.message?.slice(0, 60)}`);
      }
    }
  }

  // ───────────────── Periodic sweep (safety net) ─────────────────

  /**
   * Every 30 seconds, re-read all tracked tables and crank any stuck ones.
   * This catches anything the WS subscription might have missed.
   */
  private startSweep(): void {
    this.sweepIntervalId = setInterval(() => {
      this.sweepStuckTables().catch((e) =>
        console.warn(`  ⚠️  ER sweep error: ${e?.message?.slice(0, 80)}`),
      );
      this.sweepL1Tables().catch((e) =>
        console.warn(`  ⚠️  L1 SNG sweep error: ${e?.message?.slice(0, 80)}`),
      );
    }, 30_000);
    console.log('🔄 Periodic sweep started (30s interval, ER safety sweep + L1 SNG promotion)');
  }

  /**
   * L1 SNG table promotion sweep.
   * Discovers full undelegated SNG tables on L1 (phase=Waiting, current_players==max_players, hand#=0).
   * These are tables created via frontend where players joined but delegation never happened
   * (e.g. /api/sitngos/ready wasn't called or failed).
   * Flow: create permissions → delegate permissions → delegate accounts → add to tracking → crank starts game.
   */
  private async sweepL1Tables(): Promise<void> {
    if (!this.l1Payer) return;
    if (!crankConfig.crank_sng) return;

    try {
      // Phase 3: Try LaserStream cache first (eliminates L1 getProgramAccounts RPC)
      let tableEntries: { pubkey: PublicKey; data: Buffer }[];
      const cached = this.getL1TablesFromCache({
        ownerFilter: PROGRAM_ID.toBase58(),
        phaseFilter: Phase.Waiting,
      });
      if (cached) {
        tableEntries = cached.map(e => ({ pubkey: new PublicKey(e.pubkey), data: e.data }));
      } else {
        // Fallback: L1 RPC scan
        const accounts = await this.l1.getProgramAccounts(PROGRAM_ID, {
          filters: [
            { memcmp: { offset: 0, bytes: bs58.encode(TABLE_DISCRIMINATOR) } },
            { memcmp: { offset: OFF.PHASE, bytes: bs58.encode(Buffer.from([Phase.Waiting])) } },
          ],
        });
        tableEntries = accounts.map(({ pubkey, account }) => ({ pubkey, data: Buffer.from(account.data) }));
      }

      for (const { pubkey: tablePda, data } of tableEntries) {
        if (data.length < 385) continue;

        const gameType = data[OFF.GAME_TYPE];
        const maxP = data[OFF.MAX_PLAYERS];
        const curP = data[OFF.CURRENT_PLAYERS];
        const handNum = Number(data.readBigUInt64LE(OFF.HAND_NUMBER));

        // SNG: only promote full tables that haven't started yet
        // Cash: promote any table with 2+ players
        const isCash = gameType === 3;
        if (isCash) {
          if (curP < 2) continue;
        } else {
          if (curP < maxP || handNum > 0) continue;
        }

        const key = tablePda.toBase58();
        // Skip if already tracked, processing, blocked, or filtered
        if (this.tablePhases.has(key)) continue;
        if (this.processing.has(key)) continue;
        if (this.blockedTables.has(key)) continue;
        if (this.isTableFiltered(key)) continue;

        // Arcium architecture: all tables stay on L1, no TEE delegation needed.
        // Just add to tracking — the crank loop handles start_game + arcium_deal.
        console.log(
          `\n🚀 L1 table discovered: ${key.slice(0, 12)}... (${curP}/${maxP} players, type=${isCash ? 'cash' : 'SNG'}, hand#=${handNum})`,
        );

        const state = parseTable(data);
        this.tablePhases.set(key, {
          phase: state.phase,
          handNumber: state.handNumber,
          currentPlayers: state.currentPlayers,
          lastPollAt: Date.now(),
        });
        console.log(`  ✅ Table ${key.slice(0, 12)}... added to Arcium crank tracking`);
        void this.enqueueCrank(tablePda, state);
      }
    } catch (e: any) {
      if (!e?.message?.includes('429')) {
        throw e;
      }
    }
  }

  /**
   * Full L1→TEE promotion for an SNG table.
   * Steps (matches TEE rules Table Setup Order):
   * 1. Create public permissions (table, deckState, seats) — idempotent
   * 2. Delegate public permissions to TEE
   * 3. Delegate table + deckState
   * 4. Delegate per-seat: seatCards permission + seat + seatCards
   * 5. Wait for TEE propagation
   * 6. Add to tracking map (normal crank loop handles start_game → tee_deal)
   */
  private async promoteSngTableToTee(tablePda: PublicKey, maxPlayers: number, tableData: Buffer): Promise<boolean> {
    if (!this.l1Payer) return false;
    const payer = this.l1Payer;
    const key = tablePda.toBase58();
    const tag = key.slice(0, 8); // Short table ID for log prefixing
    const tableId = Buffer.from(tableData.slice(OFF.TABLE_ID, OFF.TABLE_ID + 32));
    const gameType = tableData.length > OFF.GAME_TYPE ? tableData[OFF.GAME_TYPE] : 0;

    // Pre-flight: verify all seat accounts exist on L1 before attempting delegation
    const missingSeatAccounts: number[] = [];
    for (let i = 0; i < maxPlayers; i++) {
      const seatPda = getSeatPda(tablePda, i);
      const seatInfo = await this.l1.getAccountInfo(seatPda).catch(() => null);
      if (!seatInfo) missingSeatAccounts.push(i);
    }
    if (missingSeatAccounts.length > 0) {
      console.warn(`  ⚠️  [${tag}] Missing seat account(s) on L1: [${missingSeatAccounts}] — cannot promote`);
      this.blockedTables.add(key); // Don't retry — table is broken
      return false;
    }

    // Step 1: Create public permissions (idempotent — skip if already exist)
    console.log(`  📋 [${tag}] Step 1: Creating public permissions...`);
    const [tablePermPda] = PublicKey.findProgramAddressSync([Buffer.from('permission:'), tablePda.toBuffer()], PERMISSION_PROGRAM_ID);
    if (!(await this.l1.getAccountInfo(tablePermPda).catch(() => null))) {
      try {
        const ixs = [buildCreateTablePermIx(payer.publicKey, tablePda), buildCreateDeckStatePermIx(payer.publicKey, tablePda)];
        for (let i = 0; i < Math.min(4, maxPlayers); i++) ixs.push(buildCreateSeatPermIx(payer.publicKey, tablePda, i));
        await sendWithRetryMultiIx(this.l1, ixs, payer, `[${tag}] create_permissions (batch 1)`);
        if (maxPlayers > 4) {
          const ixs2: TransactionInstruction[] = [];
          for (let i = 4; i < maxPlayers; i++) ixs2.push(buildCreateSeatPermIx(payer.publicKey, tablePda, i));
          await sendWithRetryMultiIx(this.l1, ixs2, payer, `[${tag}] create_permissions (batch 2)`);
        }
      } catch (e: any) {
        console.warn(`  ⚠️  [${tag}] Permission creation failed: ${e?.message?.slice(0, 80)}`);
      }
    } else {
      console.log(`  ✅ [${tag}] Public permissions already exist`);
    }

    // Step 1.5: Initialize SNG economics PDAs (vault + crank tallies) — idempotent
    // TableVault: stays on L1, holds crank_cut from distribute_prizes
    // CrankTallyER: delegated to TEE for tracking crank actions during game
    // CrankTallyL1: stays on L1 for distribute_crank_rewards after undelegation
    console.log(`  📋 [${tag}] Step 1.5: Initializing vault + crank tallies...`);
    try {
      const vaultPda = getVaultPda(tablePda);
      const vaultInfo = await this.l1.getAccountInfo(vaultPda).catch(() => null);
      if (vaultInfo) {
        console.log(`  ✅ [${tag}] TableVault already exists`);
      } else {
        await sendWithRetryMultiIx(this.l1, [
          buildInitTableVaultIx(payer.publicKey, tablePda),
          buildInitCrankTallyErIx(payer.publicKey, tablePda),
          buildInitCrankTallyL1Ix(payer.publicKey, tablePda),
        ], payer, `[${tag}] init_vault+tallies`);
        console.log(`  ✅ [${tag}] TableVault + CrankTallyER + CrankTallyL1 initialized`);
      }
    } catch (e: any) {
      console.warn(`  ⚠️  [${tag}] Vault/tally init failed: ${e?.message?.slice(0, 80)}`);
      // Try individually in case some already exist
      try { await sendWithRetry(this.l1, buildInitTableVaultIx(payer.publicKey, tablePda), payer, `[${tag}] init_vault`); } catch {}
      try { await sendWithRetry(this.l1, buildInitCrankTallyErIx(payer.publicKey, tablePda), payer, `[${tag}] init_crank_tally_er`); } catch {}
      try { await sendWithRetry(this.l1, buildInitCrankTallyL1Ix(payer.publicKey, tablePda), payer, `[${tag}] init_crank_tally_l1`); } catch {}
    }

    // Step 2: Delegate public permissions to TEE — owner check
    console.log(`  📋 [${tag}] Step 2: Delegating permissions to TEE...`);
    try {
      const tablePermInfo = await this.l1.getAccountInfo(tablePermPda).catch(() => null);
      if (tablePermInfo && tablePermInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
        console.log(`  ✅ [${tag}] Table+DS permissions already delegated (owner check)`);
      } else {
        await sendWithRetryMultiIx(this.l1, [
          buildDelegateTablePermIx(payer.publicKey, tablePda),
          buildDelegateDeckStatePermIx(payer.publicKey, tablePda),
        ], payer, `[${tag}] delegate_table+ds_permissions`);
      }
      for (let i = 0; i < maxPlayers; i++) {
        const seatPda = getSeatPda(tablePda, i);
        const [seatPermPda] = PublicKey.findProgramAddressSync([Buffer.from('permission:'), seatPda.toBuffer()], PERMISSION_PROGRAM_ID);
        const seatPermInfo = await this.l1.getAccountInfo(seatPermPda).catch(() => null);
        if (seatPermInfo && seatPermInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
          console.log(`  ✅ [${tag}] seat_perm[${i}] already delegated (owner check)`);
        } else {
          await sendWithRetry(this.l1, buildDelegateSeatPermIx(payer.publicKey, tablePda, i), payer, `[${tag}] delegate_seat_perm[${i}]`);
        }
      }
    } catch (e: any) {
      console.warn(`  ⚠️  [${tag}] Permission delegation failed: ${e?.message?.slice(0, 80)}`);
    }

    // Step 3: Delegate table + DeckState (idempotent — owner check)
    console.log(`  📋 [${tag}] Step 3: Delegating table + DeckState...`);
    const tableInfo = await this.l1.getAccountInfo(tablePda).catch(() => null);
    if (tableInfo && tableInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
      console.log(`  ✅ [${tag}] Table already delegated (owner check)`);
    } else {
      const tableIx = buildDelegateTableIx(payer.publicKey, tablePda, tableId, gameType, maxPlayers);
      await sendWithRetry(this.l1, tableIx, payer, `[${tag}] delegate_table`);
    }
    const deckStatePda = getDeckStatePda(tablePda);
    const deckInfo = await this.l1.getAccountInfo(deckStatePda).catch(() => null);
    if (deckInfo && deckInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
      console.log(`  ✅ [${tag}] DeckState already delegated (owner check)`);
    } else {
      const deckStateIx = buildDelegateDeckStateIx(payer.publicKey, tablePda);
      await sendWithRetry(this.l1, deckStateIx, payer, `[${tag}] delegate_deck_state`);
    }
    // CrankTallyER delegation — needs to be on TEE for crank action tracking
    const crankTallyErPda = getCrankTallyErPda(tablePda);
    const crankTallyErInfo = await this.l1.getAccountInfo(crankTallyErPda).catch(() => null);
    if (crankTallyErInfo && crankTallyErInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
      console.log(`  ✅ [${tag}] CrankTallyER already delegated (owner check)`);
    } else if (crankTallyErInfo) {
      try {
        await sendWithRetry(this.l1, buildDelegateCrankTallyIx(payer.publicKey, tablePda), payer, `[${tag}] delegate_crank_tally_er`);
      } catch (e: any) {
        console.warn(`  ⚠️  [${tag}] CrankTallyER delegation failed: ${e?.message?.slice(0, 80)}`);
      }
    } else {
      console.warn(`  ⚠️  [${tag}] CrankTallyER not found on L1 — init may have failed`);
    }

    // Step 4: Delegate per-seat — seat + seatCards (1 delegation per TX)
    // NOTE: SeatCards permission PDAs are NOT delegated — they stay on L1
    // so deposit_for_join can update them atomically with the deposit.
    // TEE reads undelegated permissions from L1 for access control.
    // See docs/TEE_ATOMIC_PERMISSION_FIX.md
    //
    // IMPORTANT: Use account OWNER check (not delegation record PDA) as the
    // source of truth. Delegation records can be stale/missing, but if
    // owner === DELEGATION_PROGRAM_ID the account is definitively delegated.
    // Sending a delegate TX for an already-delegated account causes
    // ExternalAccountDataModified because the #[delegate] macro's CPI
    // tries to modify an account owned by the Delegation Program.
    console.log(`  📋 [${tag}] Step 4: Delegating seats...`);
    let seatFailures = 0;
    for (let i = 0; i < maxPlayers; i++) {
      const seatCardsPda = getSeatCardsPda(tablePda, i);

      // Seat delegation — check actual owner, not delegation record
      const seatPda = getSeatPda(tablePda, i);
      const seatInfo = await this.l1.getAccountInfo(seatPda).catch(() => null);
      if (seatInfo && seatInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
        console.log(`  ✅ [${tag}] Seat[${i}] already delegated (owner check)`);
      } else if (seatInfo) {
        try {
          const seatIx = buildDelegateSeatIx(payer.publicKey, tablePda, i);
          const ok = await sendWithRetry(this.l1, seatIx, payer, `[${tag}] delegate_seat[${i}]`);
          if (!ok) seatFailures++;
        } catch { seatFailures++; }
      } else {
        console.warn(`  ⚠️  [${tag}] Seat[${i}] not found on L1`);
        seatFailures++;
      }

      // SeatCards delegation — check actual owner, not delegation record
      const scInfo = await this.l1.getAccountInfo(seatCardsPda).catch(() => null);
      if (scInfo && scInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
        console.log(`  ✅ [${tag}] SeatCards[${i}] already delegated (owner check)`);
      } else if (scInfo) {
        try {
          const scIx = buildDelegateSeatCardsIx(payer.publicKey, tablePda, i);
          const ok = await sendWithRetry(this.l1, scIx, payer, `[${tag}] delegate_seat_cards[${i}]`);
          if (!ok) seatFailures++;
        } catch { seatFailures++; }
      } else {
        console.warn(`  ⚠️  [${tag}] SeatCards[${i}] not found on L1`);
        seatFailures++;
      }
    }

    if (seatFailures > 0) {
      console.warn(`  ⚠️  [${tag}] ${seatFailures} seat delegation(s) failed — start_game may fail`);
    }

    // Step 5: Verify delegation — PUBLIC accounts via TEE getAccountInfo,
    // PRIVATE accounts (deckState, seatCards) via L1 delegation records.
    // Private PDA self-member accounts return null from getAccountInfo even when absorbed.
    console.log(`  ⏳ [${tag}] Verifying TEE propagation...`);

    // Verify private accounts via L1 delegation records (owner = Delegation Program)
    const DELEG_PROG = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
    const privatePdas = [
      { name: 'DeckState', pda: getDeckStatePda(tablePda) },
    ];
    for (let i = 0; i < maxPlayers; i++) {
      privatePdas.push({ name: `SeatCards[${i}]`, pda: getSeatCardsPda(tablePda, i) });
    }
    for (const { name, pda } of privatePdas) {
      const info = await this.l1.getAccountInfo(pda).catch(() => null);
      if (!info || !info.owner.equals(DELEG_PROG)) {
        console.warn(`  ❌ [${tag}] ${name} not delegated on L1`);
        return false;
      }
    }
    console.log(`  ✅ [${tag}] ${privatePdas.length} private accounts verified delegated (L1 records)`);

    // Verify public accounts via TEE getAccountInfo
    const publicPdas = [
      { name: 'Table', pda: tablePda },
    ];
    for (let i = 0; i < maxPlayers; i++) {
      publicPdas.push({ name: `Seat[${i}]`, pda: getSeatPda(tablePda, i) });
    }

    const TEE_VERIFY_TIMEOUT = 20_000;
    const TEE_VERIFY_POLL = 3_000;
    const verifyStart = Date.now();
    let missing: string[] = [];
    while (Date.now() - verifyStart < TEE_VERIFY_TIMEOUT) {
      missing = [];
      for (const { name, pda } of publicPdas) {
        try {
          const info = await this.getConnForTable(key).getAccountInfo(pda);
          if (!info) missing.push(name);
        } catch { missing.push(name); }
      }
      if (missing.length === 0) break;
      console.log(`  ⏳ [${tag}] TEE missing: ${missing.join(', ')} — retrying in ${TEE_VERIFY_POLL / 1000}s`);
      await sleep(TEE_VERIFY_POLL);
    }

    if (missing.length > 0) {
      console.warn(`  ❌ [${tag}] TEE propagation FAILED after ${TEE_VERIFY_TIMEOUT / 1000}s — missing: ${missing.join(', ')}`);
      return false;
    }

    console.log(`  ✅ [${tag}] All ${publicPdas.length + privatePdas.length} accounts verified (${Date.now() - verifyStart}ms)`);

    // Step 6: Add to tracking map — normal crank loop will start the game
    this.tablePhases.set(key, { phase: Phase.Waiting, handNumber: 0, currentPlayers: 0, lastPollAt: Date.now() });

    try {
      const teeInfo = await this.getConnForTable(key).getAccountInfo(tablePda);
      if (teeInfo) {
        const state = parseTable(Buffer.from(teeInfo.data));
        this.tablePhases.set(key, { phase: state.phase, handNumber: state.handNumber, currentPlayers: state.currentPlayers, lastPollAt: Date.now() });
        this.updateTurnTimer(tablePda, state);
        if (this.needsCrank(state.phase, state.currentPlayers, state.handNumber, state.gameType, state.maxPlayers, state.isDelegated)) {
          console.log(`  ⚡ [${tag}] Table ready — firing crank immediately`);
          void this.enqueueCrank(tablePda, state);
        }
        return true;
      }
    } catch {}
    return true;
  }

  private async sweepStuckTables(): Promise<void> {
    const eligible = Array.from(this.tablePhases.entries())
      .filter(([key]) => !this.blockedTables.has(key) && !this.isTableFiltered(key) && !this.processing.has(key) && !this.isInBackoff(key)
        && !((this.startGameCooldown.get(key) || 0) > Date.now())); // Skip tables in start-game cooldown (e.g. waiting for sit-out kick eligibility)

    if (eligible.length === 0) return;

    // Phase 1: Read all eligible tables from TEE in parallel
    const reads = await Promise.allSettled(
      eligible.map(([key]) =>
        this.getConnForTable(key).getAccountInfo(new PublicKey(key)).then(info => ({ key, info }))
      )
    );

    // Phase 2: Parse and collect tables needing cranks
    const needsCrank: { tablePda: PublicKey; state: TableState }[] = [];
    for (const result of reads) {
      if (result.status !== 'fulfilled') continue;
      const { key, info } = result.value;
      if (!info || info.data.length < 256) {
        // Don't evict on single null — TEE reads are flaky. Use tableNullCount
        // threshold (same as pollTables) to avoid losing tables with pending cashouts.
        const count = (this.tableNullCount.get(key) || 0) + 1;
        this.tableNullCount.set(key, count);
        continue;
      }
      this.tableNullCount.delete(key); // reset on successful read

      const tablePda = new PublicKey(key);
      const state = parseTable(Buffer.from(info.data));
      this.tablePhases.set(key, { phase: state.phase, handNumber: state.handNumber, currentPlayers: state.currentPlayers, lastPollAt: Date.now() });
      this.updateTurnTimer(tablePda, state);

      if (this.needsCrank(state.phase, state.currentPlayers, state.handNumber, state.gameType, state.maxPlayers, state.isDelegated)) {
        console.log(
          `\n🔄 Sweep: ${key.slice(0, 12)}... stuck in ${PHASE_NAMES[state.phase]}` +
          ` (players=${state.currentPlayers}, pot=${state.pot}) — cranking`,
        );
        needsCrank.push({ tablePda, state });
      }
    }

    // Phase 3: Fire all cranks in parallel
    if (needsCrank.length > 0) {
      await Promise.allSettled(
        needsCrank.map(({ tablePda, state }) => this.enqueueCrank(tablePda, state))
      );
    }
  }

  // ───────── Cash Game Rake Distribution Sweep (L1) ─────────────

  /**
   * After process_rake_distribution, call distribute_crank_rewards to pay operators
   * their weighted share of the crank pool (5% of rake).
   * Safe to call even if crank_pool_accumulated is 0 — will just log and skip.
   */
  private async distributeCrankRewards(tablePda: PublicKey, tableKey: string): Promise<void> {
    try {
      const vaultPda = getVaultPda(tablePda);
      const erTallyPda = getCrankTallyErPda(tablePda);
      const l1TallyPda = getCrankTallyL1Pda(tablePda);

      // Read tallies from L1 (ER tally should have been committed with the table)
      const [erTallyInfo, l1TallyInfo] = await Promise.all([
        this.l1.getAccountInfo(erTallyPda),
        this.l1.getAccountInfo(l1TallyPda),
      ]);

      const erOps = erTallyInfo ? parseTallyOperators(Buffer.from(erTallyInfo.data), 1) : [];
      const l1Ops = l1TallyInfo ? parseTallyOperators(Buffer.from(l1TallyInfo.data), 2) : [];

      // Merge operators (combine weights for same pubkey)
      const merged = new Map<string, { pubkey: PublicKey; weight: number }>();
      for (const op of [...erOps, ...l1Ops]) {
        const key = op.pubkey.toBase58();
        const existing = merged.get(key);
        if (existing) existing.weight += op.weight;
        else merged.set(key, { ...op });
      }

      const operators = Array.from(merged.values());
      if (operators.length === 0) {
        console.log(`  ⏭️  No operators in tallies — skipping crank rewards for ${tableKey.slice(0, 12)}`);
        return;
      }

      // Build remaining_accounts: triplets of [operator_wallet (mut), crank_operator_pda (mut), dealer_license_pda (read)]
      const remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
      for (const op of operators) {
        remainingAccounts.push({ pubkey: op.pubkey, isSigner: false, isWritable: true });
        remainingAccounts.push({ pubkey: getCrankOperatorPda(op.pubkey), isSigner: false, isWritable: true });
        remainingAccounts.push({ pubkey: getDealerLicensePda(op.pubkey), isSigner: false, isWritable: false });
      }

      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: this.l1Payer!.publicKey, isSigner: true,  isWritable: true  },
          { pubkey: tablePda,                isSigner: false, isWritable: false },
          { pubkey: vaultPda,                isSigner: false, isWritable: true  },
          { pubkey: erTallyPda,              isSigner: false, isWritable: false },
          { pubkey: l1TallyPda,              isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ...remainingAccounts,
        ],
        data: DISTRIBUTE_CRANK_REWARDS_DISC,
      });

      const tx = new Transaction().add(ix);
      tx.feePayer = this.l1Payer!.publicKey;
      tx.recentBlockhash = (await this.l1.getLatestBlockhash()).blockhash;
      tx.sign(this.l1Payer!);
      const sig = await this.l1.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await this.l1.confirmTransaction(sig, 'confirmed');
      await recordCrankTxMetrics(this.l1, 'distribute_crank_rewards', sig);
      console.log(`  ✅ Crank rewards distributed (${operators.length} ops) | sig: ${sig.slice(0, 20)}...`);
    } catch (e: any) {
      const msg = e?.message || '';
      // InsufficientFunds = delta is 0 (no crank pool to distribute) — normal for micro-stakes
      if (msg.includes('InsufficientFunds') || msg.includes('0x1')) {
        console.log(`  ⏭️  No crank pool to distribute for ${tableKey.slice(0, 12)} (micro-stakes rounding)`);
      } else {
        console.warn(`  ⚠️  distribute_crank_rewards failed for ${tableKey.slice(0, 12)}: ${msg.slice(0, 100)}`);
      }
    }
  }

  /**
   * Periodically scan L1 for cash game tables with accumulated rake.
   * When found, call process_rake_distribution (Anchor) + record_poker_rake (Steel)
   * to distribute accumulated rake on L1.
   */
  private startRakeSweep(): void {
    if (!this.l1Payer) {
      console.log('⚠️  Rake sweep DISABLED — no L1_PAYER configured');
      return;
    }
    if (!this.poolAuthority) {
      console.log('⚠️  Rake sweep DISABLED — no POOL_AUTHORITY configured');
      return;
    }
    this.rakeSweepIntervalId = setInterval(
      () => this.sweepCashGameRake().catch((e) =>
        console.warn(`  ⚠️  Rake sweep error: ${e?.message?.slice(0, 80)}`),
      ),
      RAKE_SWEEP_INTERVAL_MS,
    );
    console.log(`💰 Cash game rake sweep started (${RAKE_SWEEP_INTERVAL_MS / 1000}s interval)`);
  }

  private async sweepCashGameRake(): Promise<void> {
    // TEE does NOT support getProgramAccounts — use crank's tracked tables instead.
    // Read each table individually from TEE to check rake_accumulated.
    const CASH_GAME_TYPE = 3;

    // Collect candidate tables from crank's internal table cache
    const candidates: PublicKey[] = [];
    for (const key of this.tablePhases.keys()) {
      candidates.push(new PublicKey(key));
    }
    if (candidates.length === 0) return;

    // Read each table from TEE individually (route per-table)
    const reads = await Promise.allSettled(
      candidates.map(pubkey =>
        this.getConnForTable(pubkey.toBase58()).getAccountInfo(pubkey).then(info => ({ pubkey, info }))
      )
    );

    let distributed = 0;
    for (const result of reads) {
      if (result.status !== 'fulfilled' || !result.value.info) continue;
      const { pubkey: tablePda, info: account } = result.value;
      const data = Buffer.from(account.data);
      if (data.length < OFF.TOKEN_MINT + 32) continue;

      // Filter to cash game tables only
      const gameType = data.readUInt8(OFF.GAME_TYPE);
      if (gameType !== CASH_GAME_TYPE) continue;

      const rakeAccum = data.readBigUInt64LE(OFF.RAKE_ACCUMULATED);
      if (rakeAccum === 0n) continue;

      const key = tablePda.toBase58();
      if (this.isInBackoff(key)) continue;

      const tokenMintBytes = data.subarray(OFF.TOKEN_MINT, OFF.TOKEN_MINT + 32);
      const tokenMint = new PublicKey(tokenMintBytes);
      const isSolTable = tokenMint.equals(PublicKey.default);
      const isUserCreated = data.readUInt8(OFF.IS_USER_CREATED) === 1;
      const creatorBytes = data.subarray(OFF.CREATOR, OFF.CREATOR + 32);
      const creator = new PublicKey(creatorBytes);
      const mintLabel = isSolTable ? 'SOL' : tokenMint.equals(POKER_MINT) ? 'POKER' : tokenMint.toBase58().slice(0, 8);

      console.log(
        `\n💰 Rake sweep: ${key.slice(0, 12)}... rake=${rakeAccum} mint=${mintLabel}` +
        ` user_created=${isUserCreated} creator=${creator.toBase58().slice(0, 8)}...`,
      );

      try {
        if (isSolTable) {
          // ─── SOL tables: CommitState → L1 distribution ───
          // Step 1: CommitState table on ER (push rake_accumulated to L1)
          // Step 2: Read committed L1 data to compute delta for Steel
          // Step 3: process_rake_distribution on L1 (parameterless — reads table bytes)
          // NO ER clear — counter stays monotonic for L1 delta to work correctly.
          const vaultPda = getVaultPda(tablePda);
          const creatorAccount = isUserCreated ? creator : TREASURY;

          // 1) CommitState on ER — push table + CrankTallyER data to L1
          // Resilient: on timeout, fall through to L1 read — CommitState may have
          // landed even if ER confirmation polling didn't detect it.
          {
            const erTallyPda = getCrankTallyErPda(tablePda);
            let pdasToCommit = [tablePda, erTallyPda];
            // Check L1 delegation record (NOT TEE getAccountInfo) to confirm CrankTallyER is actually delegated.
            // TEE proxies reads for non-delegated accounts to L1, so getAccountInfo on TEE would return
            // L1 data even if CrankTallyER was never delegated → including it in commit would crash TEE.
            const tallyDelegationRecord = delegationRecordPdaFromDelegatedAccount(erTallyPda);
            const tallyDelegated = await this.l1.getAccountInfo(tallyDelegationRecord).catch(() => null);
            if (!tallyDelegated) pdasToCommit = [tablePda];

            let commitOk = false;
            for (let attempt = 0; attempt < 2 && !commitOk; attempt++) {
              try {
                const commitIx = buildCommitInstruction(this.teePayer.publicKey, pdasToCommit);
                const commitTx = new Transaction().add(commitIx);
                commitTx.feePayer = this.teePayer.publicKey;
                const teeC = this.getConnForTable(key);
                commitTx.recentBlockhash = (await teeC.getLatestBlockhash()).blockhash;
                commitTx.sign(this.teePayer);
                const commitSig = await teeC.sendRawTransaction(commitTx.serialize(), { skipPreflight: true });
                const { confirmed: cOk } = await pollConfirmation(teeC, commitSig, 30000);
                if (cOk) {
                  await recordCrankTxMetrics(teeC, 'commit_state (rake sweep SOL)', commitSig);
                  console.log(`  ✅ CommitState ${pdasToCommit.length === 2 ? 'table+tally' : 'table'} → L1 | sig: ${commitSig.slice(0, 20)}...`);
                  commitOk = true;
                } else if (attempt === 0) {
                  console.warn(`  ⚠️  CommitState poll timeout (attempt 1) — retrying...`);
                }
              } catch (e2: any) {
                if (attempt === 0) console.warn(`  ⚠️  CommitState error (attempt 1): ${e2?.message?.slice(0, 60)} — retrying...`);
              }
            }
            if (!commitOk) {
              // Don't skip — fall through to L1 read. CommitState may have landed
              // despite polling failure. The delta check will naturally skip if stale.
              console.warn(`  ⚠️  CommitState unconfirmed after 2 attempts — checking L1 data as fallback...`);
              await sleep(3000);
            }
          }

          // 2) Read committed L1 table + vault to compute delta for Steel instruction
          let vaultInfo = await this.l1.getAccountInfo(vaultPda);
          if (!vaultInfo) {
            // Init vault + tallies for old tables that pre-date init_table_seat fix
            console.log(`  🔧 Vault missing for ${key.slice(0, 12)} — initializing...`);
            try {
              const erTallyPda = getCrankTallyErPda(tablePda);
              const l1TallyPda = getCrankTallyL1Pda(tablePda);
              const [erTallyExists, l1TallyExists] = await Promise.all([
                this.l1.getAccountInfo(erTallyPda).catch(() => null),
                this.l1.getAccountInfo(l1TallyPda).catch(() => null),
              ]);
              const initIxs: TransactionInstruction[] = [
                buildInitTableVaultIx(this.l1Payer!.publicKey, tablePda),
              ];
              if (!erTallyExists) initIxs.push(buildInitCrankTallyErIx(this.l1Payer!.publicKey, tablePda));
              if (!l1TallyExists) initIxs.push(buildInitCrankTallyL1Ix(this.l1Payer!.publicKey, tablePda));
              await sendWithRetryMultiIx(this.l1, initIxs, this.l1Payer!, `[rake-sweep] init_vault+tallies`);
              console.log(`  ✅ Vault + tallies initialized for ${key.slice(0, 12)}`);
              vaultInfo = await this.l1.getAccountInfo(vaultPda);
            } catch (initErr: any) {
              console.warn(`  ⚠️  Vault init failed for ${key.slice(0, 12)}: ${initErr?.message?.slice(0, 80)}`);
            }
            if (!vaultInfo) {
              console.warn(`  ⚠️  Vault still not found after init for ${key.slice(0, 12)}`);
              continue;
            }
          }
          const vaultData = Buffer.from(vaultInfo.data);
          const totalRakeDistributed = vaultData.length >= 73 ? Number(vaultData.readBigUInt64LE(65)) : 0;

          // Read committed table data from L1 to get rake_accumulated
          const l1TableInfo = await this.l1.getAccountInfo(tablePda);
          if (!l1TableInfo || l1TableInfo.data.length < 155) {
            console.warn(`  ⚠️  Table not readable on L1 for ${key.slice(0, 12)}`);
            continue;
          }
          const l1RakeAccum = Number(Buffer.from(l1TableInfo.data).readBigUInt64LE(147));
          const rakeDelta = Math.max(0, l1RakeAccum - totalRakeDistributed);
          if (rakeDelta === 0) {
            console.log(`  ⏭️  No new rake (L1_committed=${l1RakeAccum}, distributed=${totalRakeDistributed})`);
            continue;
          }
          console.log(`  📊 Delta: ${rakeDelta} (L1_committed=${l1RakeAccum}, distributed=${totalRakeDistributed})`);

          // 3) L1: process_rake_distribution (parameterless — reads from committed table)
          const ixData = Buffer.alloc(8);
          PROCESS_RAKE_DIST_DISC.copy(ixData, 0);

          const l1TallyPda = getCrankTallyL1Pda(tablePda);
          const distIx = new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: this.l1Payer!.publicKey, isSigner: true,  isWritable: true  },
              { pubkey: tablePda,                isSigner: false, isWritable: false },
              { pubkey: vaultPda,                isSigner: false, isWritable: true  },
              { pubkey: POOL_PDA,                isSigner: false, isWritable: true  },
              { pubkey: TREASURY,                isSigner: false, isWritable: true  },
              { pubkey: creatorAccount,          isSigner: false, isWritable: true  },
              { pubkey: STEEL_PROGRAM_ID,        isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              // remaining: CrankTallyL1 for L1 action credit (2× weight)
              { pubkey: l1TallyPda,              isSigner: false, isWritable: true  },
            ],
            data: ixData,
          });

          const resizeIx = new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: this.l1Payer!.publicKey, isSigner: true,  isWritable: true  },
              { pubkey: tablePda,                isSigner: false, isWritable: false },
              { pubkey: vaultPda,                isSigner: false, isWritable: true  },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: RESIZE_VAULT_DISC,
          });

          const tx = new Transaction().add(resizeIx).add(distIx);
          tx.feePayer = this.l1Payer!.publicKey;
          tx.recentBlockhash = (await this.l1.getLatestBlockhash()).blockhash;
          tx.sign(this.l1Payer!);
          const sig = await this.l1.sendRawTransaction(tx.serialize(), { skipPreflight: false });
          await this.l1.confirmTransaction(sig, 'confirmed');
          await recordCrankTxMetrics(this.l1, 'process_rake_distribution', sig);
          console.log(`  ✅ L1 rake distributed: ${rakeDelta} lamports | sig: ${sig.slice(0, 20)}...`);

          // 4) Distribute crank rewards (5% of rake → operators)
          await this.distributeCrankRewards(tablePda, key);

          distributed++;
        } else {
          // ─── SPL tables: CommitState → L1 delta distribution ───
          const vaultPda = getVaultPda(tablePda);

          // 1) CommitState on ER — push table data to L1
          // Resilient: on timeout, fall through to L1 read (same pattern as SOL).
          {
            const splErTallyPda = getCrankTallyErPda(tablePda);
            let splPdasToCommit = [tablePda, splErTallyPda];
            // Check L1 delegation record (NOT TEE getAccountInfo) — same fix as SOL path above.
            const splTallyDelegationRecord = delegationRecordPdaFromDelegatedAccount(splErTallyPda);
            const splTallyDelegated = await this.l1.getAccountInfo(splTallyDelegationRecord).catch(() => null);
            if (!splTallyDelegated) splPdasToCommit = [tablePda];

            let splCommitOk = false;
            for (let attempt = 0; attempt < 2 && !splCommitOk; attempt++) {
              try {
                const commitIx = buildCommitInstruction(this.teePayer.publicKey, splPdasToCommit);
                const commitTx = new Transaction().add(commitIx);
                commitTx.feePayer = this.teePayer.publicKey;
                const teeC2 = this.getConnForTable(key);
                commitTx.recentBlockhash = (await teeC2.getLatestBlockhash()).blockhash;
                commitTx.sign(this.teePayer);
                const commitSig = await teeC2.sendRawTransaction(commitTx.serialize(), { skipPreflight: true });
                const { confirmed: cOk } = await pollConfirmation(teeC2, commitSig, 30000);
                if (cOk) {
                  await recordCrankTxMetrics(teeC2, 'commit_state (rake sweep SPL)', commitSig);
                  console.log(`  ✅ CommitState ${splPdasToCommit.length === 2 ? 'table+tally' : 'table'} → L1 (SPL) | sig: ${commitSig.slice(0, 20)}...`);
                  splCommitOk = true;
                } else if (attempt === 0) {
                  console.warn(`  ⚠️  CommitState SPL poll timeout (attempt 1) — retrying...`);
                }
              } catch (e2: any) {
                if (attempt === 0) console.warn(`  ⚠️  CommitState SPL error (attempt 1): ${e2?.message?.slice(0, 60)} — retrying...`);
              }
            }
            if (!splCommitOk) {
              console.warn(`  ⚠️  CommitState SPL unconfirmed after 2 attempts — checking L1 data as fallback...`);
              await sleep(3000);
            }
          }

          // 2) Read committed L1 table + vault to compute delta
          const l1TableInfo = await this.l1.getAccountInfo(tablePda);
          if (!l1TableInfo || l1TableInfo.data.length < OFF.TOKEN_MINT + 32) {
            console.warn(`  ⚠️  Table not readable on L1 for SPL table ${key.slice(0, 12)}`);
            continue;
          }
          const l1Data = Buffer.from(l1TableInfo.data);
          const l1RakeAccum = l1Data.readBigUInt64LE(OFF.RAKE_ACCUMULATED);
          const l1IsUserCreated = l1Data.readUInt8(OFF.IS_USER_CREATED) === 1;
          const l1Creator = new PublicKey(l1Data.subarray(OFF.CREATOR, OFF.CREATOR + 32));
          const l1TokenMint = new PublicKey(l1Data.subarray(OFF.TOKEN_MINT, OFF.TOKEN_MINT + 32));
          const configuredEscrow = new PublicKey(l1Data.subarray(OFF.TOKEN_ESCROW, OFF.TOKEN_ESCROW + 32));

          const splVaultInfo = await this.l1.getAccountInfo(vaultPda);
          if (!splVaultInfo) {
            console.warn(`  ⚠️  Vault not found on L1 for SPL table ${key.slice(0, 12)}`);
            continue;
          }
          const splVaultData = Buffer.from(splVaultInfo.data);
          const totalRakeDistributed = splVaultData.length >= 73 ? splVaultData.readBigUInt64LE(65) : 0n;
          const rakeDelta = l1RakeAccum > totalRakeDistributed ? l1RakeAccum - totalRakeDistributed : 0n;

          if (rakeDelta === 0n) {
            console.log(`  ⏭️  No new SPL rake (L1_committed=${l1RakeAccum}, distributed=${totalRakeDistributed})`);
            continue;
          }
          console.log(`  📊 SPL delta: ${rakeDelta} (L1_committed=${l1RakeAccum}, distributed=${totalRakeDistributed})`);

          // 3) L1: process_spl_rake_distribution (parameterless)
          const tableTokenAccount = configuredEscrow.equals(PublicKey.default)
            ? await getAssociatedTokenAddress(l1TokenMint, tablePda, true)
            : configuredEscrow;
          const poolTokenAccount = await getAssociatedTokenAddress(l1TokenMint, POOL_PDA, true);
          const treasuryTokenAccount = await getAssociatedTokenAddress(l1TokenMint, TREASURY, true);
          const creatorTokenAccount = l1IsUserCreated
            ? await getAssociatedTokenAddress(l1TokenMint, l1Creator, true)
            : treasuryTokenAccount;

          const splL1TallyPda = getCrankTallyL1Pda(tablePda);
          const splDistIx = new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: this.l1Payer!.publicKey, isSigner: true,  isWritable: true  },
              { pubkey: tablePda,                isSigner: false, isWritable: false },
              { pubkey: vaultPda,                isSigner: false, isWritable: true  },
              { pubkey: tableTokenAccount,       isSigner: false, isWritable: true  },
              { pubkey: poolTokenAccount,        isSigner: false, isWritable: true  },
              { pubkey: treasuryTokenAccount,    isSigner: false, isWritable: true  },
              { pubkey: creatorTokenAccount,     isSigner: false, isWritable: true  },
              { pubkey: SPL_TOKEN_PROGRAM_ID,    isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              // remaining: CrankTallyL1 for L1 action credit (2× weight)
              { pubkey: splL1TallyPda,           isSigner: false, isWritable: true  },
            ],
            data: PROCESS_SPL_RAKE_DIST_DISC,
          });

          const splResizeIx = new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: this.l1Payer!.publicKey, isSigner: true,  isWritable: true  },
              { pubkey: tablePda,                isSigner: false, isWritable: false },
              { pubkey: vaultPda,                isSigner: false, isWritable: true  },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: RESIZE_VAULT_DISC,
          });

          const splTx = new Transaction().add(splResizeIx).add(splDistIx);
          const signers: any[] = [this.l1Payer!];

          if (l1TokenMint.equals(POKER_MINT) && this.poolAuthority) {
            const stakerShare = rakeDelta * 50n / 100n;
            const recordIx = buildRecordPokerRakeIx(this.poolAuthority.publicKey, stakerShare, poolTokenAccount);
            splTx.add(recordIx);
            signers.push(this.poolAuthority);
          }

          splTx.feePayer = this.l1Payer!.publicKey;
          splTx.recentBlockhash = (await this.l1.getLatestBlockhash()).blockhash;
          splTx.sign(...signers);
          const splSig = await this.l1.sendRawTransaction(splTx.serialize(), { skipPreflight: false });
          await this.l1.confirmTransaction(splSig, 'confirmed');
          await recordCrankTxMetrics(this.l1, 'process_spl_rake_distribution', splSig);
          console.log(`  ✅ SPL rake distributed: ${rakeDelta.toString()} ${mintLabel} | sig: ${splSig.slice(0, 20)}...`);

          // 4) Distribute crank rewards (5% of rake → operators)
          await this.distributeCrankRewards(tablePda, key);

          distributed++;
        }
      } catch (e: any) {
        console.warn(`  ❌ Rake distribute failed for ${key.slice(0, 12)}: ${e?.message?.slice(0, 100)}`);
      }
    }

    if (distributed > 0) {
      console.log(`💰 Rake sweep complete: ${distributed} table(s) distributed`);
    }
  }

  // ───────────────── Cash game inactive player removal ──────────────

  private startRemovalSweep(): void {
    this.removalSweepIntervalId = setInterval(
      () => {
        this.sweepCashGameRemovals().catch((e) =>
          console.warn(`  ⚠️  Removal sweep error: ${e?.message?.slice(0, 80)}`),
        );
        this.sweepL1StuckCashGames().catch((e) =>
          console.warn(`  ⚠️  L1 stuck sweep error: ${e?.message?.slice(0, 80)}`),
        );
      },
      REMOVAL_SWEEP_INTERVAL_MS,
    );
    console.log(`🧹 Cash game removal sweep started (${REMOVAL_SWEEP_INTERVAL_MS / 1000}s interval)`);
  }

  /**
   * Scan for cash game tables in Waiting phase.
   * Uses L1 for table discovery (getProgramAccounts — NOT supported on TEE),
   * then reads individual seats from TEE (getAccountInfo — supported).
   * For seats that are SittingOut: check sit_out_timestamp.
   * If sitting out > 5 minutes, mark as Leaving and process cashout.
   * Also handles bust players (0 chips for >= 3 hands).
   */
  private async sweepCashGameRemovals(): Promise<void> {
    const CASH_GAME_TYPE = 3;
    const SITTING_OUT = 4; // SeatStatus::SittingOut
    const BUSTED = 5;
    const LEAVING = 6;
    const SIT_OUT_TIMEOUT_SECS = 5 * 60; // 5 minutes

    // ── Discovery: Use BOTH tracked tables (from WS) AND L1 scan ──
    // Delegated tables are owned by delegation program on L1, so L1
    // getProgramAccounts(PROGRAM_ID) misses them! Use our internal map too.
    const tableKeys = new Set<string>();
    // Phase 3: Cache data map — avoids per-table getAccountInfo when LaserStream has fresh data
    const cachedDataMap = new Map<string, { data: Buffer; owner: string }>();

    // 1. From crank's tracked tables (catches delegated ones)
    for (const key of this.tablePhases.keys()) {
      tableKeys.add(key);
    }

    // 2. From L1 scan (catches undelegated ones the crank may not be tracking)
    // Phase 3: Try LaserStream cache first (eliminates L1 getProgramAccounts RPC)
    const cachedCashTables = this.getL1TablesFromCache({ gameTypeFilter: CASH_GAME_TYPE });
    if (cachedCashTables) {
      for (const e of cachedCashTables) {
        tableKeys.add(e.pubkey);
        cachedDataMap.set(e.pubkey, { data: e.data, owner: e.owner });
      }
    } else {
      try {
        const l1Tables = await this.l1.getProgramAccounts(PROGRAM_ID, {
          filters: [
            { memcmp: { offset: 0, bytes: bs58.encode(TABLE_DISCRIMINATOR) } },
            { memcmp: { offset: OFF.GAME_TYPE, bytes: bs58.encode(Buffer.from([CASH_GAME_TYPE])) } },
          ],
        });
        for (const { pubkey } of l1Tables) tableKeys.add(pubkey.toBase58());
      } catch {}
    }

    let removed = 0;
    let scanned = 0;
    let sittingOutFound = 0;
    const nowUnix = Math.floor(Date.now() / 1000);

    for (const tableKeyStr of tableKeys) {
      const tablePda = new PublicKey(tableKeyStr);

      // Check if table is on L1 (undelegated) — crank_remove_player needs L1
      // because init_if_needed for unclaimed PDA can't work on TEE.
      let isOnL1 = false;
      let tableData: Buffer | null = null;

      // Phase 3: Use LaserStream cached data first (avoids per-table getAccountInfo RPC)
      const cached = cachedDataMap.get(tableKeyStr);
      if (cached && cached.data.length >= 256) {
        tableData = cached.data;
        isOnL1 = cached.owner === PROGRAM_ID.toBase58();
      } else {
        try {
          const l1Info = await this.l1.getAccountInfo(tablePda);
          if (l1Info && l1Info.data.length >= 256 && l1Info.owner.equals(PROGRAM_ID)) {
            tableData = Buffer.from(l1Info.data);
            isOnL1 = true;
          }
        } catch {}
        // For delegated tables, read from TEE for diagnostics
        if (!tableData) {
          try {
            const teeInfo = await this.getConnForTable(tableKeyStr).getAccountInfo(tablePda);
            if (teeInfo && teeInfo.data.length >= 256) tableData = Buffer.from(teeInfo.data);
          } catch {}
        }
      }
      if (!tableData) continue;

      const state = parseTable(tableData);
      if (state.gameType !== CASH_GAME_TYPE) continue;
      if (state.phase !== Phase.Waiting) continue;
      if (state.currentPlayers === 0) continue;
      scanned++;

      for (let i = 0; i < state.maxPlayers; i++) {
        const seatPda = getSeatPda(tablePda, i);
        let seatInfo;
        // Read seats from L1 if table is on L1, otherwise TEE
        const seatConn = isOnL1 ? this.l1 : this.getConnForTable(tableKeyStr);
        try {
          seatInfo = await seatConn.getAccountInfo(seatPda);
        } catch {
          try { seatInfo = await this.l1.getAccountInfo(seatPda); } catch { continue; }
        }
        if (!seatInfo || seatInfo.data.length < 245) continue;

        const seatData = Buffer.from(seatInfo.data);
        const status = seatData[SEAT_STATUS_OFFSET];
        if (status !== SITTING_OUT && status !== BUSTED && status !== LEAVING) continue;

        const chips = Number(seatData.readBigUInt64LE(SEAT_CHIPS_OFFSET));
        const handsSinceBust = seatData[SEAT_HANDS_SINCE_BUST];
        sittingOutFound++;

        let sitOutSecs = 0;
        if (seatData.length >= SEAT_SIT_OUT_TIMESTAMP_OFFSET + 8) {
          const ts = Number(seatData.readBigInt64LE(SEAT_SIT_OUT_TIMESTAMP_OFFSET));
          if (ts > 0) sitOutSecs = nowUnix - ts;
        }

        const sitOutCount = seatData[SEAT_SIT_OUT_COUNT_OFFSET];
        const timeExpired = sitOutSecs >= SIT_OUT_TIMEOUT_SECS;
        const bustExpired = chips === 0 && handsSinceBust >= 3;
        const legacyExpired = sitOutCount >= 3 && sitOutSecs === 0;
        const statusForceRemove = status === BUSTED || status === LEAVING;

        if (!timeExpired && !bustExpired && !legacyExpired && !statusForceRemove) continue;

        const wallet = new PublicKey(seatData.slice(SEAT_WALLET_OFFSET, SEAT_WALLET_OFFSET + 32));
        if (wallet.equals(PublicKey.default)) continue;

        const reason = statusForceRemove
          ? `status=${status === BUSTED ? 'Busted' : 'Leaving'}`
          : timeExpired
            ? `sitOut ${Math.floor(sitOutSecs / 60)}m${sitOutSecs % 60}s > 5min`
            : bustExpired ? `bust ${handsSinceBust} hands` : `legacy sitOut=${sitOutCount}`;

        if (!isOnL1) {
          // Delegated table → use crank_kick_inactive on TEE (marks as Leaving)
          // Only SittingOut status is supported by the on-chain instruction
          if (status !== SITTING_OUT) continue;
          console.log(
            `\n🧹 Kicking seat ${i} from ${tablePda.toBase58().slice(0, 12)}... on TEE` +
            ` (${reason}, chips=${chips})`,
          );
          try {
            const ix = buildCrankKickInactiveIx(this.teePayer.publicKey, tablePda, seatPda);
            const ok = await sendWithRetry(this.getConnForTable(tableKeyStr), ix, this.teePayer, 'crank_kick_inactive');
            if (ok) {
              console.log(`  ✅ Kicked seat ${i} → Leaving (cashout flow will handle payout)`);
              removed++;
            }
          } catch (e: any) {
            console.warn(`  ❌ Kick failed seat ${i}: ${e?.message?.slice(0, 120)}`);
            addCrankError(`crank_kick_inactive seat ${i} at ${tableKeyStr.slice(0, 8)}: ${e?.message?.slice(0, 80)}`);
          }
        } else {
          // L1 table — route by status:
          //   Leaving → process_cashout_v3 (transfers funds + clears seat)
          //   SittingOut/Busted → crank_remove_player (creates unclaimed PDA)
          const signer = this.l1Payer || this.payer;
          console.log(
            `\n🧹 Removing seat ${i} from ${tablePda.toBase58().slice(0, 12)}... on L1` +
            ` (${reason}, chips=${chips})`,
          );
          try {
            if (status === LEAVING) {
              // Leaving → process_cashout_v3 (unified: transfer + clear)
              const ix = buildProcessCashoutV3Ix(
                signer.publicKey, tablePda, i, wallet,
              );
              const ok = await sendWithRetry(this.l1, ix, signer, `process_cashout_v3 (L1 sweep seat ${i})`, 3, false, [6095]);
              if (ok) {
                console.log(`  ✅ Cashout v3 seat ${i} on L1`);
                removed++;
              }
            } else {
              // SittingOut/Busted → crank_remove_player (creates unclaimed PDA)
              const unclaimedPda = getUnclaimedBalancePda(tablePda, wallet);
              const ix = buildCrankRemovePlayerIx(
                signer.publicKey, tablePda, seatPda, unclaimedPda,
              );
              const ok = await sendWithRetry(this.l1, ix, signer, 'crank_remove_player (L1)');
              if (ok) {
                console.log(`  ✅ Player removed from seat ${i} on L1`);
                removed++;
              }
            }
          } catch (e: any) {
            console.warn(`  ❌ Remove failed seat ${i}: ${e?.message?.slice(0, 120)}`);
            addCrankError(`remove seat ${i} at ${tableKeyStr.slice(0, 8)}: ${e?.message?.slice(0, 80)}`);
          }
        }
      }
    }

    if (scanned > 0 || sittingOutFound > 0 || removed > 0) {
      console.log(`🧹 Removal sweep: ${tableKeys.size} tables checked, ${scanned} cash/waiting, ${sittingOutFound} sitting-out found, ${removed} removed`);
    }
  }

  /**
   * Scan L1 for undelegated cash game tables stuck in Waiting phase.
   * When a table is undelegated (stuck: not enough active players), the ER sweep
   * can't see it. This sweep finds those tables on L1 and calls process_cashout
   * for every occupied seat (SittingOut/Leaving/Busted) to return SOL to players.
   */
  private async sweepL1StuckCashGames(): Promise<void> {
    if (!this.l1Payer) return; // Need L1 payer for gas

    const CASH_GAME_TYPE = 3;
    const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');

    // Phase 3: Try LaserStream cache first (eliminates L1 getProgramAccounts RPC)
    let tableEntries: { pubkey: PublicKey; data: Buffer; owner: string }[];
    const cachedCash = this.getL1TablesFromCache({ gameTypeFilter: CASH_GAME_TYPE });
    if (cachedCash) {
      tableEntries = cachedCash
        .filter(e => e.owner === PROGRAM_ID.toBase58()) // Skip delegated
        .map(e => ({ pubkey: new PublicKey(e.pubkey), data: e.data, owner: e.owner }));
    } else {
      // Fallback: L1 RPC scan
      let tables;
      try {
        tables = await this.l1.getProgramAccounts(PROGRAM_ID, {
          filters: [
            { memcmp: { offset: 0, bytes: bs58.encode(TABLE_DISCRIMINATOR) } },
            { memcmp: { offset: OFF.GAME_TYPE, bytes: bs58.encode(Buffer.from([CASH_GAME_TYPE])) } },
          ],
        });
      } catch {
        return; // L1 RPC may be unavailable
      }
      tableEntries = tables
        .filter(({ account }) => !account.owner.equals(DELEGATION_PROGRAM))
        .map(({ pubkey, account }) => ({ pubkey, data: Buffer.from(account.data), owner: account.owner.toBase58() }));
    }

    let processed = 0;
    for (const { pubkey: tablePda, data: tableData } of tableEntries) {
      if (tableData.length < 256) continue;

      const state = parseTable(tableData);
      if (state.phase !== Phase.Waiting) continue;

      // Count active players — if >= 2, this table can still start hands normally
      // Only process stuck tables (< 2 active)
      let activeCount = 0;
      const cashoutCandidates: { seatIndex: number; wallet: PublicKey; status: number; chips: bigint }[] = [];

      for (let i = 0; i < state.maxPlayers; i++) {
        const seatPda = getSeatPda(tablePda, i);
        let seatInfo;
        try {
          seatInfo = await this.l1.getAccountInfo(seatPda);
        } catch { continue; }
        if (!seatInfo || seatInfo.data.length < 245) continue;
        // Skip if seat is delegated (owned by Delegation Program)
        if (seatInfo.owner.equals(DELEGATION_PROGRAM)) continue;

        const seatData = Buffer.from(seatInfo.data);
        const status = seatData[SEAT_STATUS_OFFSET];
        if (status === 0) continue; // Empty

        const wallet = new PublicKey(seatData.slice(SEAT_WALLET_OFFSET, SEAT_WALLET_OFFSET + 32));
        if (wallet.equals(PublicKey.default)) continue;

        const chips = seatData.readBigUInt64LE(SEAT_CHIPS_OFFSET);

        if (status === 1 || status === 3) { // Active or AllIn
          activeCount++;
        } else {
          // SittingOut(4), Busted(5), Leaving(6) — candidates for cashout
          cashoutCandidates.push({ seatIndex: i, wallet, status, chips });
        }
      }

      // Only process truly stuck tables (not enough active players to start a hand)
      if (activeCount >= 2 || cashoutCandidates.length === 0) continue;

      console.log(
        `\n🔧 L1 stuck cash table ${tablePda.toBase58().slice(0, 12)}...` +
        ` (active=${activeCount}, cashout=${cashoutCandidates.length})`
      );

      for (const { seatIndex, wallet, status, chips } of cashoutCandidates) {
        // process_cashout_v3 requires Leaving status — skip others
        if (status !== 6) { // 6=Leaving
          if (status === 5) {
            console.log(`  ℹ️  Seat ${seatIndex} is Busted (0 chips) — skipping`);
          } else if (status === 4) {
            console.log(`  ℹ️  Seat ${seatIndex} is SittingOut — needs crank_kick_inactive first`);
          }
          continue;
        }

        try {
          const ix = buildProcessCashoutV3Ix(this.l1Payer!.publicKey, tablePda, seatIndex, wallet);
          const tx = new Transaction().add(ix);
          tx.feePayer = this.l1Payer!.publicKey;
          tx.recentBlockhash = (await this.l1.getLatestBlockhash('confirmed')).blockhash;
          const sig = await sendAndConfirmTransaction(this.l1, tx, [this.l1Payer!], { commitment: 'confirmed' });
          await recordCrankTxMetrics(this.l1, 'process_cashout_v3 (L1 stuck sweep)', sig);
          console.log(
            `  ✅ L1 cashout seat ${seatIndex} (${wallet.toBase58().slice(0, 8)}...)` +
            ` ${Number(chips) / 1e9} SOL: ${sig.slice(0, 20)}`
          );
          processed++;
        } catch (e: any) {
          console.log(`  ⚠️  L1 cashout seat ${seatIndex} failed: ${e.message?.slice(0, 80)}`);
        }
      }
    }

    if (processed > 0) {
      console.log(`🔧 L1 stuck sweep complete: ${processed} seat(s) processed`);
    }
  }

  // ───────────────── Auction resolve sweep ──────────────────────

  private startAuctionSweep(): void {
    if (!this.l1Payer) {
      console.log('⚠️  Auction sweep DISABLED — no L1 payer');
      return;
    }
    this.auctionSweepIntervalId = setInterval(
      () => this.sweepAuctionResolve().catch((e) =>
        console.warn(`  ⚠️  Auction sweep error: ${e?.message?.slice(0, 80)}`),
      ),
      AUCTION_SWEEP_INTERVAL_MS,
    );
    console.log(`🏷  Auction resolve sweep started (${AUCTION_SWEEP_INTERVAL_MS / 1000}s interval)`);
  }

  /**
   * Read AuctionConfig to find the current epoch. If it has ended and has bids,
   * resolve it. The contract advances config to the next epoch automatically.
   * Falls back to legacy wall-clock scan for old epochs without config.
   */
  private async sweepAuctionResolve(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // ── Try config-based resolution first ──
    const [configPda] = PublicKey.findProgramAddressSync(
      [AUCTION_CONFIG_SEED],
      PROGRAM_ID,
    );

    let configEpoch: number | null = null;
    let configEnd: number | null = null;

    try {
      const configInfo = await this.l1.getAccountInfo(configPda);
      if (configInfo && configInfo.data.length >= 41) {
        const data = Buffer.from(configInfo.data);
        configEpoch = Number(data.readBigUInt64LE(8));   // current_epoch
        const start = Number(data.readBigInt64LE(16));    // current_epoch_start
        const duration = Number(data.readBigInt64LE(24)); // current_epoch_duration
        configEnd = start + duration;
      }
    } catch (e: any) {
      console.warn(`  ⚠️  Config PDA read failed: ${e?.message?.slice(0, 60)}`);
    }

    // If config exists and current epoch has ended, try to resolve it
    if (configEpoch !== null && configEnd !== null && now >= configEnd) {
      const lockKey = `auction-cfg-${configEpoch}`;
      if (!this.processing.has(lockKey)) {
        this.processing.add(lockKey);
        try {
          await this.resolveEpoch(configEpoch, configPda);
        } finally {
          this.processing.delete(lockKey);
        }
      }
    }

    // ── Legacy fallback: scan old wall-clock epochs (pre-config) ──
    const wallClockEpoch = Math.floor(now / AUCTION_EPOCH_SECS);
    for (let i = 1; i <= 8; i++) {
      const epoch = wallClockEpoch - i;
      if (epoch < 0) break;
      if (configEpoch !== null && epoch === configEpoch) continue; // already handled above

      const lockKey = `auction-${epoch}`;
      if (this.processing.has(lockKey)) continue;

      const epochBuf = Buffer.alloc(8);
      epochBuf.writeBigUInt64LE(BigInt(epoch));
      const [auctionPda] = PublicKey.findProgramAddressSync(
        [AUCTION_SEED, epochBuf],
        PROGRAM_ID,
      );

      try {
        const info = await this.l1.getAccountInfo(auctionPda);
        if (!info || info.data.length < 76) continue;
        const status = info.data[32];
        if (status !== 0) continue; // not Active

        this.processing.add(lockKey);
        // Legacy resolve (no config PDA — will fail if contract requires it post-upgrade)
        await this.resolveEpoch(epoch, configPda);
      } catch (e: any) {
        console.warn(`  ⚠️  Legacy auction sweep epoch ${epoch}: ${e?.message?.slice(0, 80)}`);
      } finally {
        this.processing.delete(lockKey);
      }
    }
  }

  /** Resolve a single auction epoch: find highest GlobalTokenBid, call resolve_auction */
  private async resolveEpoch(epoch: number, configPda: PublicKey): Promise<void> {
    const epochBuf = Buffer.alloc(8);
    epochBuf.writeBigUInt64LE(BigInt(epoch));
    const [auctionPda] = PublicKey.findProgramAddressSync(
      [AUCTION_SEED, epochBuf],
      PROGRAM_ID,
    );

    // Verify auction is Active
    const info = await this.l1.getAccountInfo(auctionPda);
    if (!info || info.data.length < 76) return;
    const status = info.data[32];
    if (status !== 0) return; // already resolved

    // Scan ALL GlobalTokenBid accounts (53 bytes) — persistent leaderboard
    const globalBidAccounts = await this.l1.getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: 53 }],
    });

    if (globalBidAccounts.length === 0) {
      console.log(`  🏷  Epoch ${epoch}: no global bids — skipping`);
      return;
    }

    // Find highest global bid
    let highestAmount = BigInt(0);
    let winningPda: PublicKey | null = null;
    let winningMint = '';

    for (const { pubkey, account } of globalBidAccounts) {
      const data = Buffer.from(account.data);
      if (data.length < 53) continue;
      // GlobalTokenBid layout: 8 disc + 32 mint + 8 total_amount + 4 bidder_count + 1 bump
      const totalAmount = data.readBigUInt64LE(40);
      if (totalAmount > highestAmount) {
        highestAmount = totalAmount;
        winningPda = pubkey;
        winningMint = new PublicKey(data.subarray(8, 40)).toBase58();
      }
    }

    if (!winningPda || highestAmount === BigInt(0)) return;

    console.log(`\n🏷  Resolving epoch ${epoch}: #1 on leaderboard = ${winningMint.slice(0, 8)}... (${Number(highestAmount) / 1e9} SOL)`);

    const winningMintPk = new PublicKey(winningMint);
    const [listedTokenPda] = PublicKey.findProgramAddressSync(
      [LISTED_TOKEN_SEED, winningMintPk.toBuffer()],
      PROGRAM_ID,
    );
    const [tierConfigPda] = PublicKey.findProgramAddressSync(
      [TIER_CONFIG_SEED, winningMintPk.toBuffer()],
      PROGRAM_ID,
    );

    // Compute SOL-weighted median from GlobalBidContribution accounts (90 bytes)
    let computedAnchor = BigInt(0);
    try {
      const contribAccounts = await this.l1.getProgramAccounts(PROGRAM_ID, {
        filters: [{ dataSize: 90 }],
      });
      // Filter for contributions matching the winning mint that have an anchor vote
      const votes: { amount: bigint; vote: bigint }[] = [];
      for (const { account } of contribAccounts) {
        const data = Buffer.from(account.data);
        if (data.length < 90) continue;
        // GlobalBidContribution layout: 8 disc + 32 mint + 32 bidder + 8 amount + 1 option_tag + 8 vote + 1 bump
        const mint = new PublicKey(data.subarray(8, 40)).toBase58();
        if (mint !== winningMint) continue;
        const amount = data.readBigUInt64LE(72);
        const optionTag = data[80];
        if (optionTag !== 1 || amount === BigInt(0)) continue;
        const vote = data.readBigUInt64LE(81);
        if (vote > BigInt(0)) {
          votes.push({ amount, vote });
        }
      }
      if (votes.length > 0) {
        // SOL-weighted median: sort by vote, find the median by cumulative weight
        votes.sort((a, b) => (a.vote < b.vote ? -1 : a.vote > b.vote ? 1 : 0));
        const totalWeight = votes.reduce((s, v) => s + v.amount, BigInt(0));
        const halfWeight = totalWeight / BigInt(2);
        let cumWeight = BigInt(0);
        for (const v of votes) {
          cumWeight += v.amount;
          if (cumWeight >= halfWeight) {
            computedAnchor = v.vote;
            break;
          }
        }
        console.log(`  🗳  Anchor vote: ${votes.length} voters, weighted median = ${computedAnchor}`);
      } else {
        console.log(`  🗳  No anchor votes found — tier config will use defaults`);
      }
    } catch (e: any) {
      console.log(`  ⚠  Failed to compute anchor vote: ${e.message?.slice(0, 80)}`);
    }

    // Build instruction data: discriminator (8) + computed_anchor (u64, 8)
    const ixData = Buffer.alloc(16);
    DISC.resolveAuction.copy(ixData, 0);
    ixData.writeBigUInt64LE(computedAnchor, 8);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: this.l1Payer!.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: auctionPda, isSigner: false, isWritable: true },
        { pubkey: winningPda, isSigner: false, isWritable: true },
        { pubkey: listedTokenPda, isSigner: false, isWritable: true },
        { pubkey: tierConfigPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: ixData,
    });

    const ok = await sendWithRetry(this.l1, ix, this.l1Payer!, `resolve_auction (epoch ${epoch}, anchor=${computedAnchor})`);
    if (ok) {
      console.log(`  ✅ Epoch ${epoch} resolved! Winner listed & removed from leaderboard.`);
    }
  }

  /**
   * Arcium Deal — called at Starting phase in Arcium MPC mode.
   *
   * Two-step process:
   *   1. Call arcium_deal on FastPoker program (Starting → AwaitingDeal)
   *   2. Call queue_computation on Arcium program (queues shuffle_and_deal MPC)
   *
   * Requires: @arcium-hq/client SDK, Docker MXE running, circuits deployed.
   * The MXE will fire a callback TX when computation completes, which triggers
   * arcium_reveal (AwaitingDeal → Preflop) on-chain.
   */
  private async crankArciumDeal(tablePda: PublicKey, fallbackState: TableState): Promise<boolean> {
    const tag = tablePda.toBase58().slice(0, 8);
    const conn = this.getConnForTable(tablePda.toBase58());

    // Re-read table for fresh state
    let seatsOccupied = fallbackState.seatsOccupied;
    let maxPlayers = fallbackState.maxPlayers;
    let handNumber = fallbackState.handNumber;
    try {
      const info = await conn.getAccountInfo(tablePda);
      if (info && info.data.length >= 256) {
        const fresh = parseTable(Buffer.from(info.data));
        if (fresh.phase !== Phase.Starting) {
          console.log(`  ⏸  [${tag}] arcium_deal skipped — phase already ${PHASE_NAMES[fresh.phase]}`);
          return true;
        }
        seatsOccupied = fresh.seatsOccupied;
        maxPlayers = fresh.maxPlayers;
        handNumber = fresh.handNumber;
      }
    } catch {}

    // Count occupied seats (popcount of seatsOccupied byte)
    let numPlayers = 0;
    for (let b = seatsOccupied; b; b &= b - 1) numPlayers++;
    if (numPlayers < 2) {
      console.log(`  ⏸  [${tag}] arcium_deal skipped — only ${numPlayers} player(s)`);
      return false;
    }

    console.log(`  🔐 [${tag}] Cranking arcium_deal (hand #${handNumber}, ${numPlayers} players)`);

    try {
      // Get Arcium environment (cluster offset from env vars)
      const arciumEnv = getArciumEnv();
      const clusterOffset = arciumEnv.arciumClusterOffset;

      // Computation offset: unique per hand — use hand_number + random nonce
      const computationOffset = BigInt(handNumber) * BigInt(1_000_000) + BigInt(Date.now() % 1_000_000);
      const compDefOffset = computeCompDefOffset('shuffle_and_deal');

      // Build player pubkeys and nonces (9 slots, dummies for empty seats)
      // Active seats: read x25519 pubkey from PlayerSeat.hole_cards_commitment (offset 192, 32 bytes).
      // The player sets this via set_x25519_key after joining. If not set (all zeros),
      // fall back to generating a random key (player won't be able to decrypt — their problem).
      // Empty seats: use valid dummy x25519 key (Arcium rejects all-zero pubkeys).
      const SEAT_X25519_OFFSET = 192; // hole_cards_commitment repurposed as x25519_pubkey
      const playerPubkeys: Buffer[] = [];
      const playerNonces: Buffer[] = [];
      for (let i = 0; i < 9; i++) {
        if (i < maxPlayers && (seatsOccupied & (1 << i))) {
          // Try to read player's x25519 pubkey from their PlayerSeat account
          let pubKey: Buffer | null = null;
          try {
            const [seatPda] = PublicKey.findProgramAddressSync(
              [Buffer.from('seat'), tablePda.toBuffer(), Buffer.from([i])],
              PROGRAM_ID,
            );
            const seatInfo = await conn.getAccountInfo(seatPda);
            if (seatInfo && seatInfo.data.length >= SEAT_X25519_OFFSET + 32) {
              const key = seatInfo.data.slice(SEAT_X25519_OFFSET, SEAT_X25519_OFFSET + 32);
              // Check non-zero
              if (!key.every((b: number) => b === 0)) {
                pubKey = Buffer.from(key);
              }
            }
          } catch (e: any) {
            console.warn(`  ⚠️  Failed to read x25519 from seat ${i}: ${e.message?.slice(0, 60)}`);
          }
          if (!pubKey) {
            // Fallback: generate ephemeral key (player can't decrypt — warning)
            console.warn(`  ⚠️  Seat ${i}: no x25519 key set, generating ephemeral (player can't decrypt!)`);
            const privKey = x25519.utils.randomSecretKey();
            pubKey = Buffer.from(x25519.getPublicKey(privKey));
          }
          playerPubkeys.push(pubKey);
          // Random 16-byte nonce per deal (unique per hand)
          const nonce = crypto.randomBytes(16);
          playerNonces.push(nonce);
        } else {
          // Empty seat — use valid dummy x25519 key (Arcium rejects all-zero pubkeys)
          const dummyPriv = x25519.utils.randomSecretKey();
          playerPubkeys.push(Buffer.from(x25519.getPublicKey(dummyPriv)));
          playerNonces.push(crypto.randomBytes(16));
        }
      }

      // Derive all required Arcium account addresses
      const mxeAccount = getMXEAccAddress(PROGRAM_ID);
      const mempoolAccount = getMempoolAccAddress(clusterOffset);
      const executingPool = getExecutingPoolAccAddress(clusterOffset);
      const computationBN = { toArray: () => [Number(computationOffset & 0xFFFFFFFFn), Number(computationOffset >> 32n)] };
      // Use BN-compatible offset for PDA derivation
      const compOffsetBuf = Buffer.alloc(8);
      compOffsetBuf.writeBigUInt64LE(computationOffset);
      const computationAccount = getComputationAccAddress(clusterOffset, { toArrayLike: (B: any, _e: string, l: number) => { const b = Buffer.alloc(l); compOffsetBuf.copy(b); return b; } } as any);
      const compDefAccount = getCompDefAccAddress(PROGRAM_ID, compDefOffset);
      const clusterAccount = getClusterAccAddress(clusterOffset);
      const signPda = getArciumSignPda();
      const feePool = getArciumFeePoolPda();
      const clockPda = getArciumClockPda();

      // Build arcium_deal instruction data:
      // disc(8) + computation_offset(u64) + player_data(Vec<u8>: u32 len + 9×48) + num_players(u8)
      const playerDataLen = 9 * 48;
      const dataLen = 8 + 8 + 4 + playerDataLen + 1;
      const data = Buffer.alloc(dataLen);
      let offset = 0;
      DISC.arciumDeal.copy(data, offset); offset += 8;
      data.writeBigUInt64LE(computationOffset, offset); offset += 8;
      data.writeUInt32LE(playerDataLen, offset); offset += 4; // Vec<u8> length prefix
      for (let i = 0; i < 9; i++) {
        playerPubkeys[i].copy(data, offset); offset += 32;
        playerNonces[i].copy(data, offset); offset += 16;
      }
      data.writeUInt8(numPlayers, offset);

      // Build account list matching ArciumDeal struct order
      const keys = [
        { pubkey: this.teePayer.publicKey, isSigner: true,  isWritable: true  }, // payer
        { pubkey: signPda,                 isSigner: false, isWritable: true  }, // sign_pda_account
        { pubkey: mxeAccount,              isSigner: false, isWritable: false }, // mxe_account
        { pubkey: mempoolAccount,          isSigner: false, isWritable: true  }, // mempool_account
        { pubkey: executingPool,           isSigner: false, isWritable: true  }, // executing_pool
        { pubkey: computationAccount,      isSigner: false, isWritable: true  }, // computation_account
        { pubkey: compDefAccount,          isSigner: false, isWritable: false }, // comp_def_account
        { pubkey: clusterAccount,          isSigner: false, isWritable: true  }, // cluster_account
        { pubkey: feePool,                 isSigner: false, isWritable: true  }, // pool_account
        { pubkey: clockPda,                isSigner: false, isWritable: true  }, // clock_account
        { pubkey: ARCIUM_PROGRAM_ID,       isSigner: false, isWritable: false }, // arcium_program
        { pubkey: tablePda,                isSigner: false, isWritable: true  }, // table
        { pubkey: getDeckStatePda(tablePda), isSigner: false, isWritable: true }, // deck_state
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        // remaining_accounts: CrankTallyER for recording dealer action
        { pubkey: getCrankTallyErPda(tablePda), isSigner: false, isWritable: true },
      ];

      const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
      const ok = await sendWithRetry(conn, ix, this.teePayer, `[${tag}] arcium_deal`, 3, false, []);
      if (ok) {
        console.log(`  ✅ [${tag}] arcium_deal queued MPC shuffle_and_deal (offset=${computationOffset})`);
        // Suppress sweep retries while MPC is processing (up to 5 min for first deal)
        this.startGameCooldown.set(tablePda.toBase58(), Date.now() + 300_000);
      }
      return ok;
    } catch (e: any) {
      console.error(`  ❌ [${tag}] arcium_deal failed: ${e.message?.slice(0, 120)}`);
      return false;
    }
  }

  /**
   * Arcium Reveal — called at *RevealPending phases in Arcium MPC mode.
   *
   * Calls arcium_reveal_queue on FastPoker program which:
   *   1. Reads encrypted community cards from DeckState
   *   2. Queues reveal_community MPC computation via Arcium CPI
   *   3. MPC callback fires reveal_community_callback → writes plaintext → advances phase
   */
  private async crankArciumReveal(tablePda: PublicKey, fallbackState: TableState): Promise<boolean> {
    const tag = tablePda.toBase58().slice(0, 8);
    const conn = this.getConnForTable(tablePda.toBase58());

    // Determine num_to_reveal from phase
    let numToReveal: number;
    switch (fallbackState.phase) {
      case Phase.FlopRevealPending:  numToReveal = 3; break;
      case Phase.TurnRevealPending:  numToReveal = 4; break;
      case Phase.RiverRevealPending: numToReveal = 5; break;
      default:
        console.log(`  ⏸  [${tag}] arcium_reveal skipped — unexpected phase ${PHASE_NAMES[fallbackState.phase]}`);
        return true;
    }

    const phaseName = PHASE_NAMES[fallbackState.phase];
    console.log(`  🔓 [${tag}] Cranking arcium_reveal_queue (phase=${phaseName}, reveal=${numToReveal})`);

    try {
      const arciumEnv = getArciumEnv();
      const clusterOffset = arciumEnv.arciumClusterOffset;

      // Unique computation offset per reveal call
      const computationOffset = BigInt(fallbackState.handNumber) * BigInt(1_000_000)
        + BigInt(numToReveal) * BigInt(100_000)
        + BigInt(Date.now() % 100_000);
      const compDefOffset = computeCompDefOffset('reveal_community');

      // Derive Arcium account addresses
      const mxeAccount = getMXEAccAddress(PROGRAM_ID);
      const mempoolAccount = getMempoolAccAddress(clusterOffset);
      const executingPool = getExecutingPoolAccAddress(clusterOffset);
      const compOffsetBuf = Buffer.alloc(8);
      compOffsetBuf.writeBigUInt64LE(computationOffset);
      const computationAccount = getComputationAccAddress(clusterOffset, { toArrayLike: (B: any, _e: string, l: number) => { const b = Buffer.alloc(l); compOffsetBuf.copy(b); return b; } } as any);
      const compDefAccount = getCompDefAccAddress(PROGRAM_ID, compDefOffset);
      const clusterAccount = getClusterAccAddress(clusterOffset);
      const signPda = getArciumSignPda();
      const feePool = getArciumFeePoolPda();
      const clockPda = getArciumClockPda();
      const deckState = getDeckStatePda(tablePda);

      // Build arcium_reveal_queue instruction data:
      // disc(8) + computation_offset(u64:8) + num_to_reveal(u8:1) = 17 bytes
      const data = Buffer.alloc(17);
      let offset = 0;
      DISC.arciumRevealQueue.copy(data, offset); offset += 8;
      data.writeBigUInt64LE(computationOffset, offset); offset += 8;
      data.writeUInt8(numToReveal, offset);

      // Build account list matching ArciumRevealQueue struct order
      const keys = [
        { pubkey: this.teePayer.publicKey, isSigner: true,  isWritable: true  }, // payer
        { pubkey: signPda,                 isSigner: false, isWritable: true  }, // sign_pda_account
        { pubkey: mxeAccount,              isSigner: false, isWritable: false }, // mxe_account
        { pubkey: mempoolAccount,          isSigner: false, isWritable: true  }, // mempool_account
        { pubkey: executingPool,           isSigner: false, isWritable: true  }, // executing_pool
        { pubkey: computationAccount,      isSigner: false, isWritable: true  }, // computation_account
        { pubkey: compDefAccount,          isSigner: false, isWritable: false }, // comp_def_account
        { pubkey: clusterAccount,          isSigner: false, isWritable: true  }, // cluster_account
        { pubkey: feePool,                 isSigner: false, isWritable: true  }, // pool_account
        { pubkey: clockPda,                isSigner: false, isWritable: true  }, // clock_account
        { pubkey: ARCIUM_PROGRAM_ID,       isSigner: false, isWritable: false }, // arcium_program
        { pubkey: tablePda,                isSigner: false, isWritable: true  }, // table
        { pubkey: deckState,               isSigner: false, isWritable: false }, // deck_state (read-only)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        // remaining_accounts: CrankTallyER for recording dealer action
        { pubkey: getCrankTallyErPda(tablePda), isSigner: false, isWritable: true },
      ];

      const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
      const ok = await sendWithRetry(conn, ix, this.teePayer, `[${tag}] arcium_reveal_queue`, 3, false, []);
      if (ok) {
        console.log(`  ✅ [${tag}] arcium_reveal_queue queued MPC reveal_community (reveal=${numToReveal}, offset=${computationOffset})`);
      }
      return ok;
    } catch (e: any) {
      console.error(`  ❌ [${tag}] arcium_reveal_queue failed: ${e.message?.slice(0, 120)}`);
      return false;
    }
  }

  /**
   * Arcium Showdown — called at Showdown phase in Arcium MPC mode (before settle).
   *
   * Calls arcium_showdown_queue on FastPoker program which:
   *   1. Reads MXE-packed hole cards from DeckState (stored during shuffle_and_deal callback)
   *   2. Computes active_mask from table state (seats_occupied & ~seats_folded)
   *   3. Queues reveal_all_showdown MPC computation via Arcium CPI (single call for ALL players)
   *   4. Transitions Showdown → AwaitingShowdown
   *   5. MPC callback fires → writes all 9 players' plaintext → transitions back to Showdown
   *   6. Crank sees Showdown again with revealed cards → calls settle_hand
   */
  private async crankArciumShowdown(tablePda: PublicKey, fallbackState: TableState): Promise<boolean> {
    const tag = tablePda.toBase58().slice(0, 8);
    const conn = this.getConnForTable(tablePda.toBase58());

    // Compute active_mask: players who haven't folded (seatsOccupied & ~seatsFolded)
    const activeMask = fallbackState.seatsOccupied & ~fallbackState.seatsFolded & 0x1FF;
    console.log(`  🔓 [${tag}] Cranking arcium_showdown_queue (active_mask=${activeMask.toString(2).padStart(9, '0')})`);

    try {
      const arciumEnv = getArciumEnv();
      const clusterOffset = arciumEnv.arciumClusterOffset;

      const computationOffset = BigInt(fallbackState.handNumber) * BigInt(1_000_000)
        + BigInt(999) * BigInt(1_000)
        + BigInt(Date.now() % 1_000);
      const compDefOffset = computeCompDefOffset('reveal_all_showdown');

      // Derive Arcium account addresses
      const mxeAccount = getMXEAccAddress(PROGRAM_ID);
      const mempoolAccount = getMempoolAccAddress(clusterOffset);
      const executingPool = getExecutingPoolAccAddress(clusterOffset);
      const compOffsetBuf = Buffer.alloc(8);
      compOffsetBuf.writeBigUInt64LE(computationOffset);
      const computationAccount = getComputationAccAddress(clusterOffset, { toArrayLike: (B: any, _e: string, l: number) => { const b = Buffer.alloc(l); compOffsetBuf.copy(b); return b; } } as any);
      const compDefAccount = getCompDefAccAddress(PROGRAM_ID, compDefOffset);
      const clusterAccount = getClusterAccAddress(clusterOffset);
      const signPda = getArciumSignPda();
      const feePool = getArciumFeePoolPda();
      const clockPda = getArciumClockPda();
      const deckState = getDeckStatePda(tablePda);

      // Build arcium_showdown_queue instruction data:
      // disc(8) + computation_offset(u64:8) = 16 bytes
      // (active_mask is computed on-chain from table state)
      const data = Buffer.alloc(16);
      let offset = 0;
      DISC.arciumShowdownQueue.copy(data, offset); offset += 8;
      data.writeBigUInt64LE(computationOffset, offset);

      // Build account list matching ArciumShowdownQueue struct order
      const keys = [
        { pubkey: this.teePayer.publicKey, isSigner: true,  isWritable: true  }, // payer
        { pubkey: signPda,                 isSigner: false, isWritable: true  }, // sign_pda_account
        { pubkey: mxeAccount,              isSigner: false, isWritable: false }, // mxe_account
        { pubkey: mempoolAccount,          isSigner: false, isWritable: true  }, // mempool_account
        { pubkey: executingPool,           isSigner: false, isWritable: true  }, // executing_pool
        { pubkey: computationAccount,      isSigner: false, isWritable: true  }, // computation_account
        { pubkey: compDefAccount,          isSigner: false, isWritable: false }, // comp_def_account
        { pubkey: clusterAccount,          isSigner: false, isWritable: true  }, // cluster_account
        { pubkey: feePool,                 isSigner: false, isWritable: true  }, // pool_account
        { pubkey: clockPda,                isSigner: false, isWritable: true  }, // clock_account
        { pubkey: ARCIUM_PROGRAM_ID,       isSigner: false, isWritable: false }, // arcium_program
        { pubkey: tablePda,                isSigner: false, isWritable: true  }, // table
        { pubkey: deckState,               isSigner: false, isWritable: true  }, // deck_state
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        // remaining_accounts: CrankTallyER for recording dealer action
        { pubkey: getCrankTallyErPda(tablePda), isSigner: false, isWritable: true },
      ];

      const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
      const ok = await sendWithRetry(conn, ix, this.teePayer, `[${tag}] arcium_showdown_queue`, 3, false, []);
      if (ok) {
        console.log(`  ✅ [${tag}] arcium_showdown_queue queued MPC reveal_all_showdown (mask=${activeMask}, offset=${computationOffset})`);
      }
      return ok;
    } catch (e: any) {
      console.error(`  ❌ [${tag}] arcium_showdown_queue failed: ${e.message?.slice(0, 120)}`);
      return false;
    }
  }

  /**
   * B1 fix: Queue claim_hole_cards MPC for P2+ seats that need encrypted cards.
   *
   * After shuffle_and_deal callback, only P0+P1 have encrypted cards in SeatCards
   * (SIZE=320 truncates stride-3 output). P2+ get their cards via this separate
   * small MPC call that re-encrypts from the MXE Pack<[u8;23]>.
   *
   * Fire-and-forget — called from Preflop case in doCrank. Runs in parallel
   * for all P2+ seats. Idempotent (re-queuing produces same result).
   */
  private async crankClaimHoleCards(tablePda: PublicKey, fallbackState: TableState): Promise<void> {
    const tag = tablePda.toBase58().slice(0, 8);
    const conn = this.getConnForTable(tablePda.toBase58());

    // Deduplicate: only run once per hand
    const claimKey = `${tablePda.toBase58()}-h${fallbackState.handNumber}-claim`;
    if (this.startGameCooldown.has(claimKey)) return;
    this.startGameCooldown.set(claimKey, Date.now() + 60_000);

    const seatsOccupied = fallbackState.seatsOccupied;
    const maxPlayers = fallbackState.maxPlayers;

    // Find P2+ seats that need encrypted cards
    const seatsNeedingClaim: number[] = [];
    for (let i = 2; i < maxPlayers; i++) {
      if (!(seatsOccupied & (1 << i))) continue;
      // Check if SeatCards already has encrypted data (non-zero enc_card1)
      try {
        const [scPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('seat_cards'), tablePda.toBuffer(), Buffer.from([i])],
          PROGRAM_ID,
        );
        const scInfo = await conn.getAccountInfo(scPda);
        if (scInfo && scInfo.data.length >= 108) {
          // enc_card1 at offset 76 (32 bytes). If all zeros → needs claim.
          const enc1 = scInfo.data.slice(76, 108);
          if (!enc1.every((b: number) => b === 0)) continue; // Already has encrypted cards
        }
      } catch {}
      seatsNeedingClaim.push(i);
    }

    if (seatsNeedingClaim.length === 0) {
      // Either ≤2 players or all seats already claimed
      return;
    }

    console.log(`  🔑 [${tag}] Claiming hole cards for P${seatsNeedingClaim.join(',P')} (${seatsNeedingClaim.length} seat(s))`);

    try {
      const arciumEnv = getArciumEnv();
      const clusterOffset = arciumEnv.arciumClusterOffset;
      const compDefOffset = computeCompDefOffset('claim_hole_cards');
      const mxeAccount = getMXEAccAddress(PROGRAM_ID);
      const mempoolAccount = getMempoolAccAddress(clusterOffset);
      const executingPool = getExecutingPoolAccAddress(clusterOffset);
      const clusterAccount = getClusterAccAddress(clusterOffset);
      const signPda = getArciumSignPda();
      const feePool = getArciumFeePoolPda();
      const clockPda = getArciumClockPda();
      const deckState = getDeckStatePda(tablePda);

      // Queue each seat in parallel
      const promises = seatsNeedingClaim.map(async (seatIdx) => {
        try {
          // Unique computation offset per seat
          const computationOffset = BigInt(fallbackState.handNumber) * BigInt(1_000_000)
            + BigInt(500 + seatIdx) * BigInt(1_000)
            + BigInt(Date.now() % 1_000);
          const compOffsetBuf = Buffer.alloc(8);
          compOffsetBuf.writeBigUInt64LE(computationOffset);
          const computationAccount = getComputationAccAddress(clusterOffset, {
            toArrayLike: (B: any, _e: string, l: number) => { const b = Buffer.alloc(l); compOffsetBuf.copy(b); return b; }
          } as any);
          const compDefAccount = getCompDefAccAddress(PROGRAM_ID, compDefOffset);

          // IX data: disc(8) + computation_offset(u64:8) + seat_index(u8:1) = 17 bytes
          const data = Buffer.alloc(17);
          let offset = 0;
          DISC.arciumClaimCardsQueue.copy(data, offset); offset += 8;
          data.writeBigUInt64LE(computationOffset, offset); offset += 8;
          data.writeUInt8(seatIdx, offset);

          // Account list matching ArciumClaimCardsQueue struct order
          const keys = [
            { pubkey: this.teePayer.publicKey, isSigner: true,  isWritable: true  }, // payer
            { pubkey: signPda,                 isSigner: false, isWritable: true  }, // sign_pda_account
            { pubkey: mxeAccount,              isSigner: false, isWritable: false }, // mxe_account
            { pubkey: mempoolAccount,          isSigner: false, isWritable: true  }, // mempool_account
            { pubkey: executingPool,           isSigner: false, isWritable: true  }, // executing_pool
            { pubkey: computationAccount,      isSigner: false, isWritable: true  }, // computation_account
            { pubkey: compDefAccount,          isSigner: false, isWritable: false }, // comp_def_account
            { pubkey: clusterAccount,          isSigner: false, isWritable: true  }, // cluster_account
            { pubkey: feePool,                 isSigner: false, isWritable: true  }, // pool_account
            { pubkey: clockPda,                isSigner: false, isWritable: true  }, // clock_account
            { pubkey: ARCIUM_PROGRAM_ID,       isSigner: false, isWritable: false }, // arcium_program
            { pubkey: tablePda,                isSigner: false, isWritable: false }, // table (read-only)
            { pubkey: deckState,               isSigner: false, isWritable: false }, // deck_state (read-only)
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
          ];

          const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
          const ok = await sendWithRetry(conn, ix, this.teePayer, `[${tag}] claim_hole_cards(seat=${seatIdx})`, 2, false, []);
          if (ok) {
            console.log(`  ✅ [${tag}] claim_hole_cards queued for seat ${seatIdx} (offset=${computationOffset})`);
          }
          return ok;
        } catch (e: any) {
          console.warn(`  ⚠️  [${tag}] claim_hole_cards seat ${seatIdx} failed: ${e.message?.slice(0, 80)}`);
          return false;
        }
      });

      await Promise.allSettled(promises);
    } catch (e: any) {
      console.error(`  ❌ [${tag}] crankClaimHoleCards failed: ${e.message?.slice(0, 120)}`);
    }
  }

}

// ═══════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

const service = new CrankService();
service.start().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  service.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  service.stop();
  process.exit(0);
});
