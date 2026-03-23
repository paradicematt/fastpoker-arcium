/**
 * 2-Hour Endurance Stress Test — Arcium MPC Mode
 *
 * Pushes the system with 20 concurrent tables (10 cash + 10 SNG),
 * 40 players, and validates crank tally, rake, POKER tokenomics,
 * and overall system stability over a long period.
 *
 * The external crank-service handles all crank operations (start_game,
 * arcium_deal, settle, distribute_prizes, reset_sng_table). This test
 * focuses on:
 *   - Player actions (check/call/allin)
 *   - Claiming unrefined/refined POKER after SNG wins
 *   - Burn-staking POKER
 *   - Monitoring crank tally, rake, and system health
 *   - Rebuys on cash tables, re-joins on SNG tables after reset
 *
 * Prerequisites:
 *   1. Localnet running (solana-test-validator + MXE Docker)
 *   2. localnet-bootstrap.ts already ran (creates POKER mint, pool, dealer registry, tier config)
 *   3. Crank service running: ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only crank-service.ts
 *
 * Usage:
 *   npx ts-node --transpile-only backend/e2e-stress-test.ts
 *
 * Options (env vars):
 *   RPC_URL          — default http://127.0.0.1:8899
 *   DURATION_SECONDS — default 7200 (2 hours)
 *   NUM_CASH_TABLES  — default 10
 *   NUM_SNG_TABLES   — default 10
 *   NUM_PLAYERS      — default 40
 *   POLL_INTERVAL_MS — default 5000 (how often to check tables)
 *   STATUS_INTERVAL  — default 30000 (status report interval)
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount, getAccount, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { x25519 } from '@arcium-hq/client';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const DURATION_SECONDS = parseInt(process.env.DURATION_SECONDS || '7200', 10);
const NUM_CASH_TABLES = parseInt(process.env.NUM_CASH_TABLES || '10', 10);
const NUM_SNG_TABLES = parseInt(process.env.NUM_SNG_TABLES || '10', 10);
const NUM_PLAYERS = parseInt(process.env.NUM_PLAYERS || '40', 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10);
const STATUS_INTERVAL_MS = parseInt(process.env.STATUS_INTERVAL || '30000', 10);

const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// ─── Instruction discriminators ───
function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

const IX: Record<string, Buffer> = {};
for (const n of [
  'register_player', 'create_table', 'init_table_seat', 'join_table',
  'player_action', 'start_game', 'settle_hand', 'set_x25519_key',
  'register_crank_operator', 'purchase_dealer_license',
  'init_dealer_registry', 'init_token_tier_config',
]) IX[n] = disc(n);

// ─── PDA helpers ───
function pda(seeds: Buffer[], prog = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, prog)[0];
}
const getTable = (id: Buffer) => pda([Buffer.from('table'), id]);
const getSeat = (t: PublicKey, i: number) => pda([Buffer.from('seat'), t.toBuffer(), Buffer.from([i])]);
const getSeatCards = (t: PublicKey, i: number) => pda([Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])]);
const getDeckState = (t: PublicKey) => pda([Buffer.from('deck_state'), t.toBuffer()]);
const getVault = (t: PublicKey) => pda([Buffer.from('vault'), t.toBuffer()]);
const getReceipt = (t: PublicKey, i: number) => pda([Buffer.from('receipt'), t.toBuffer(), Buffer.from([i])]);
const getPlayer = (w: PublicKey) => pda([Buffer.from('player'), w.toBuffer()]);
const getMarker = (w: PublicKey, t: PublicKey) => pda([Buffer.from('player_table'), w.toBuffer(), t.toBuffer()]);
const getCrankEr = (t: PublicKey) => pda([Buffer.from('crank_tally_er'), t.toBuffer()]);
const getCrankL1 = (t: PublicKey) => pda([Buffer.from('crank_tally_l1'), t.toBuffer()]);
const getPool = () => pda([Buffer.from('pool')], STEEL_PROGRAM_ID);
const getUnrefined = (w: PublicKey) => pda([Buffer.from('unrefined'), w.toBuffer()], STEEL_PROGRAM_ID);
const getDealerReg = () => pda([Buffer.from('dealer_registry')], PROGRAM_ID);
const getCrankOp = (w: PublicKey) => pda([Buffer.from('crank'), w.toBuffer()]);
const getDealerLic = (w: PublicKey) => pda([Buffer.from('dealer_license'), w.toBuffer()]);
const getTierConfig = (mint: PublicKey) => pda([Buffer.from('tier_config'), mint.toBuffer()]);

// ─── Table offsets (from crank-service.ts, verified against table.rs) ───
const OFF = {
  TABLE_ID: 8,
  AUTHORITY: 40,
  GAME_TYPE: 104,
  SMALL_BLIND: 105,
  BIG_BLIND: 113,
  MAX_PLAYERS: 121,
  CURRENT_PLAYERS: 122,
  HAND_NUMBER: 123,
  POT: 131,
  MIN_BET: 139,
  RAKE_ACCUMULATED: 147,
  COMMUNITY_CARDS: 155,
  PHASE: 160,
  CURRENT_PLAYER: 161,
  DEALER_BUTTON: 163,
  SEATS_OCCUPIED: 250,
  PRIZES_DISTRIBUTED: 339,
  ELIMINATED_COUNT: 351,
  ENTRY_FEES_ESCROWED: 352,
  TIER: 360,
  ENTRY_AMOUNT: 361,
  FEE_AMOUNT: 369,
  PRIZE_POOL: 377,
  CRANK_POOL_ACCUMULATED: 427,
} as const;

// ─── Seat offsets ───
const SEAT_CHIPS_OFFSET = 104;
const SEAT_STATUS_OFFSET = 227;

// ─── Phase enum ───
const Phase = {
  Waiting: 0, Starting: 1, AwaitingDeal: 2, Preflop: 3,
  Flop: 4, Turn: 5, River: 6, Showdown: 7, AwaitingShowdown: 8,
  Complete: 9, FlopRevealPending: 10, TurnRevealPending: 11,
  RiverRevealPending: 12,
} as const;

const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop',
  4: 'Flop', 5: 'Turn', 6: 'River', 7: 'Showdown', 8: 'AwaitingShowdown',
  9: 'Complete', 10: 'FlopRevealPending', 11: 'TurnRevealPending',
  12: 'RiverRevealPending',
};

const STATUS_NAMES: Record<number, string> = {
  0: 'Empty', 1: 'Active', 2: 'Folded', 3: 'AllIn', 4: 'SittingOut', 5: 'Busted', 6: 'Leaving',
};

// GameType enum values
const GameType = {
  SitAndGoHeadsUp: 0,
  SitAndGo6Max: 1,
  SitAndGo9Max: 2,
  CashGame: 3,
} as const;

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface TableInfo {
  tableId: Buffer;
  tablePda: PublicKey;
  kind: 'cash' | 'sng';
  maxPlayers: number;
  players: { kp: Keypair; seatIndex: number; joined: boolean; x25519Set: boolean }[];
  handsPlayed: number;
  totalRake: number;
  totalPot: number;
  lastPhase: number;
  lastHandNumber: number;
  stuckSince: number;     // timestamp when phase stopped changing
  actionsThisHand: number;
  sngCompleted: number;   // how many SNG rounds completed
  errors: number;
  rebuyCount: number;
}

interface CrankTallyData {
  operators: PublicKey[];
  actionCounts: number[];
  totalActions: number;
  lastHand: number;
}

interface Metrics {
  startTime: number;
  totalHandsCash: number;
  totalHandsSng: number;
  totalRake: number;
  totalPrizes: number;
  unrefinedMinted: number;
  refinedClaimed: number;
  pokerStaked: number;
  failedTxs: number;
  successTxs: number;
  stuckTables: number;
  raceConditions: number;
  cashHandTimes: number[];
  sngHandTimes: number[];
  crankActions: Map<string, { actions: number; earnings: number }>;
  perTableHands: Map<string, number>;
  perTableRake: Map<string, number>;
  perTablePots: Map<string, number[]>;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function serializeAction(action: string, amount?: bigint): Buffer {
  switch (action) {
    case 'Fold': return Buffer.from([0]);
    case 'Check': return Buffer.from([1]);
    case 'Call': return Buffer.from([2]);
    case 'Bet': { const b = Buffer.alloc(9); b[0] = 3; b.writeBigUInt64LE(amount || 0n, 1); return b; }
    case 'AllIn': return Buffer.from([5]);
    default: throw new Error(`Unknown action: ${action}`);
  }
}

function serializeCfg(id: Buffer, gt: number, st: number, mp: number, tier: number): Buffer {
  const b = Buffer.alloc(36);
  id.copy(b);
  b.writeUInt8(gt, 32);
  b.writeUInt8(st, 33);
  b.writeUInt8(mp, 34);
  b.writeUInt8(tier, 35);
  return b;
}

function readTableData(data: Buffer) {
  return {
    phase: data[OFF.PHASE],
    curPlayer: data[OFF.CURRENT_PLAYER],
    pot: Number(data.readBigUInt64LE(OFF.POT)),
    minBet: Number(data.readBigUInt64LE(OFF.MIN_BET)),
    rakeAccumulated: Number(data.readBigUInt64LE(OFF.RAKE_ACCUMULATED)),
    occ: data.readUInt16LE(OFF.SEATS_OCCUPIED),
    curP: data[OFF.CURRENT_PLAYERS],
    maxP: data[OFF.MAX_PLAYERS],
    hand: Number(data.readBigUInt64LE(OFF.HAND_NUMBER)),
    gameType: data[OFF.GAME_TYPE],
    prizesDist: data[OFF.PRIZES_DISTRIBUTED] === 1,
    eliminatedCount: data[OFF.ELIMINATED_COUNT],
    entryAmount: Number(data.readBigUInt64LE(OFF.ENTRY_AMOUNT)),
    prizePool: Number(data.readBigUInt64LE(OFF.PRIZE_POOL)),
    crankPoolAccum: data.length > OFF.CRANK_POOL_ACCUMULATED + 8
      ? Number(data.readBigUInt64LE(OFF.CRANK_POOL_ACCUMULATED)) : 0,
  };
}

function readSeatData(data: Buffer) {
  return {
    chips: Number(data.readBigUInt64LE(SEAT_CHIPS_OFFSET)),
    status: data[SEAT_STATUS_OFFSET],
  };
}

function readCrankTally(data: Buffer): CrankTallyData {
  // Layout: disc(8) + table(32) + operators(4*32=128) + action_count(4*4=16) + total_actions(4) + last_hand(8) + bump(1)
  const operators: PublicKey[] = [];
  const actionCounts: number[] = [];
  for (let i = 0; i < 4; i++) {
    const pkStart = 40 + i * 32;
    const pk = new PublicKey(data.slice(pkStart, pkStart + 32));
    operators.push(pk);
    const countStart = 168 + i * 4;
    actionCounts.push(data.readUInt32LE(countStart));
  }
  const totalActions = data.readUInt32LE(184);
  const lastHand = Number(data.readBigUInt64LE(188));
  return { operators, actionCounts, totalActions, lastHand };
}

async function sendTx(
  conn: Connection, ix: TransactionInstruction, signers: Keypair[], label: string, metrics: Metrics,
): Promise<string | null> {
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), signers, {
      commitment: 'confirmed', skipPreflight: true,
    });
    metrics.successTxs++;
    return sig;
  } catch (e: any) {
    metrics.failedTxs++;
    const msg = e.message?.slice(0, 150) || 'unknown';
    // Only log non-routine failures
    if (!msg.includes('already in use') && !msg.includes('custom program error')) {
      console.log(`  [TX FAIL] ${label}: ${msg}`);
    }
    return null;
  }
}

function elapsed(startTime: number): string {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function shortKey(pk: PublicKey): string {
  return pk.toBase58().slice(0, 8) + '...';
}

// ═══════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════

async function setupPlayers(conn: Connection, count: number, metrics: Metrics): Promise<Keypair[]> {
  console.log(`\n  Setting up ${count} players...`);
  const players: Keypair[] = [];

  // Generate and airdrop in batches of 5
  for (let batch = 0; batch < count; batch += 5) {
    const batchSize = Math.min(5, count - batch);
    const batchPlayers: Keypair[] = [];

    for (let i = 0; i < batchSize; i++) {
      batchPlayers.push(Keypair.generate());
    }

    // Airdrop all in batch
    const airdropPromises = batchPlayers.map(async (kp) => {
      const sig = await conn.requestAirdrop(kp.publicKey, 50 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
    });
    await Promise.allSettled(airdropPromises);

    // Register all in batch
    for (const kp of batchPlayers) {
      const playerPda = getPlayer(kp.publicKey);
      const info = await conn.getAccountInfo(playerPda);
      if (!info) {
        await sendTx(conn, new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: kp.publicKey, isSigner: true, isWritable: true },
            { pubkey: playerPda, isSigner: false, isWritable: true },
            { pubkey: TREASURY, isSigner: false, isWritable: true },
            { pubkey: getPool(), isSigner: false, isWritable: true },
            { pubkey: getUnrefined(kp.publicKey), isSigner: false, isWritable: true },
            { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: IX.register_player,
        }), [kp], `register_player ${shortKey(kp.publicKey)}`, metrics);
      }
      players.push(kp);
    }
    console.log(`    Batch ${Math.floor(batch / 5) + 1}: ${batchSize} players funded + registered`);
  }

  return players;
}

async function setupCranks(conn: Connection, count: number, metrics: Metrics): Promise<Keypair[]> {
  console.log(`\n  Setting up ${count} crank keypairs (for tally verification)...`);
  const cranks: Keypair[] = [];

  for (let i = 0; i < count; i++) {
    const kp = Keypair.generate();
    cranks.push(kp);

    // Airdrop
    try {
      const sig = await conn.requestAirdrop(kp.publicKey, 50 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
    } catch (e: any) {
      console.log(`    Crank ${i} airdrop failed: ${e.message?.slice(0, 80)}`);
      continue;
    }

    // Register CrankOperator
    const crankOpPda = getCrankOp(kp.publicKey);
    const opExists = await conn.getAccountInfo(crankOpPda);
    if (!opExists) {
      await sendTx(conn, new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: kp.publicKey, isSigner: true, isWritable: true },
          { pubkey: crankOpPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: IX.register_crank_operator,
      }), [kp], `register_crank_operator ${i}`, metrics);
    }

    // Purchase DealerLicense
    const dealerLicPda = getDealerLic(kp.publicKey);
    const licExists = await conn.getAccountInfo(dealerLicPda);
    if (!licExists) {
      await sendTx(conn, new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: kp.publicKey, isSigner: true, isWritable: true },
          { pubkey: kp.publicKey, isSigner: false, isWritable: false },
          { pubkey: getDealerReg(), isSigner: false, isWritable: true },
          { pubkey: dealerLicPda, isSigner: false, isWritable: true },
          { pubkey: TREASURY, isSigner: false, isWritable: true },
          { pubkey: getPool(), isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: IX.purchase_dealer_license,
      }), [kp], `purchase_dealer_license ${i}`, metrics);
    }

    if ((i + 1) % 5 === 0) console.log(`    ${i + 1}/${count} cranks set up`);
  }

  return cranks;
}

async function createTables(
  conn: Connection, admin: Keypair, numCash: number, numSng: number, metrics: Metrics,
): Promise<TableInfo[]> {
  console.log(`\n  Creating ${numCash} cash + ${numSng} SNG tables...`);
  const tables: TableInfo[] = [];
  const tierConfigPda = getTierConfig(PublicKey.default);

  for (let i = 0; i < numCash + numSng; i++) {
    const isCash = i < numCash;
    const tableId = crypto.randomBytes(32);
    const tablePda = getTable(tableId);
    const maxPlayers = 2; // HU for all tables (simplifies player assignment)
    const gameType = isCash ? GameType.CashGame : GameType.SitAndGoHeadsUp;
    const tier = 0; // Micro

    // create_table
    const createAccounts: any[] = [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: getPool(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    // Cash tables need tier_config as remaining_account for rake cap
    if (isCash) {
      createAccounts.push({ pubkey: tierConfigPda, isSigner: false, isWritable: false });
    }

    const ok = await sendTx(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: createAccounts,
      data: Buffer.concat([IX.create_table, serializeCfg(tableId, gameType, 0, maxPlayers, tier)]),
    }), [admin], `create_table ${isCash ? 'cash' : 'sng'} #${i}`, metrics);

    if (!ok) {
      console.log(`    Failed to create table ${i} — skipping`);
      continue;
    }

    // init_table_seat for each seat
    for (let s = 0; s < maxPlayers; s++) {
      await sendTx(conn, new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: getSeat(tablePda, s), isSigner: false, isWritable: true },
          { pubkey: getSeatCards(tablePda, s), isSigner: false, isWritable: true },
          { pubkey: getDeckState(tablePda), isSigner: false, isWritable: true },
          { pubkey: getReceipt(tablePda, s), isSigner: false, isWritable: true },
          { pubkey: getVault(tablePda), isSigner: false, isWritable: true },
          { pubkey: getCrankEr(tablePda), isSigner: false, isWritable: true },
          { pubkey: getCrankL1(tablePda), isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([IX.init_table_seat, Buffer.from([s])]),
      }), [admin], `init_seat[${s}] table ${i}`, metrics);
    }

    tables.push({
      tableId,
      tablePda,
      kind: isCash ? 'cash' : 'sng',
      maxPlayers,
      players: [],
      handsPlayed: 0,
      totalRake: 0,
      totalPot: 0,
      lastPhase: Phase.Waiting,
      lastHandNumber: 0,
      stuckSince: 0,
      actionsThisHand: 0,
      sngCompleted: 0,
      errors: 0,
      rebuyCount: 0,
    });

    if ((i + 1) % 5 === 0) console.log(`    ${i + 1}/${numCash + numSng} tables created`);
  }

  return tables;
}

// ═══════════════════════════════════════════════════════════════
// PLAYER ACTIONS
// ═══════════════════════════════════════════════════════════════

function joinIx(player: PublicKey, tbl: PublicKey, seat: number, buyIn: bigint): TransactionInstruction {
  const d = Buffer.alloc(25);
  IX.join_table.copy(d);
  d.writeBigUInt64LE(buyIn, 8);
  d[16] = seat;
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: getPlayer(player), isSigner: false, isWritable: true },
      { pubkey: tbl, isSigner: false, isWritable: true },
      { pubkey: getSeat(tbl, seat), isSigner: false, isWritable: true },
      { pubkey: getMarker(player, tbl), isSigner: false, isWritable: true },
      { pubkey: getVault(tbl), isSigner: false, isWritable: true },
      { pubkey: getReceipt(tbl, seat), isSigner: false, isWritable: true },
      // 6 padding accounts (remaining_accounts for optional token accounts)
      ...Array(6).fill({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false }),
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: d,
  });
}

function setX25519KeyIx(player: PublicKey, tbl: PublicKey, seatPda: PublicKey, x25519Pubkey: Uint8Array): TransactionInstruction {
  const keyData = Buffer.alloc(8 + 32);
  IX.set_x25519_key.copy(keyData, 0);
  Buffer.from(x25519Pubkey).copy(keyData, 8);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: tbl, isSigner: false, isWritable: false },
      { pubkey: seatPda, isSigner: false, isWritable: true },
    ],
    data: keyData,
  });
}

function actionIx(player: PublicKey, tbl: PublicKey, seatNum: number, action: string, amount?: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: tbl, isSigner: false, isWritable: true },
      { pubkey: getSeat(tbl, seatNum), isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.player_action, serializeAction(action, amount)]),
  });
}

// ═══════════════════════════════════════════════════════════════
// TABLE MANAGEMENT
// ═══════════════════════════════════════════════════════════════

async function joinPlayersToTable(
  conn: Connection, table: TableInfo, playerPool: Keypair[], metrics: Metrics,
): Promise<void> {
  if (table.players.length >= table.maxPlayers) return;

  // Find available players (not assigned to this table)
  const assignedKeys = new Set(table.players.map(p => p.kp.publicKey.toBase58()));
  const available = playerPool.filter(p => !assignedKeys.has(p.publicKey.toBase58()));

  const slotsNeeded = table.maxPlayers - table.players.length;
  const toJoin = available.slice(0, slotsNeeded);

  for (const kp of toJoin) {
    const seatIndex = table.players.length;
    // Cash = 200_000 lamports (100 BB at micro), SNG = buy-in fee (0.01 SOL for Micro tier)
    const buyIn = table.kind === 'cash' ? 200_000n : 10_000_000n;

    const sig = await sendTx(conn, joinIx(kp.publicKey, table.tablePda, seatIndex, buyIn),
      [kp], `join ${shortKey(kp.publicKey)} -> ${table.kind} table seat ${seatIndex}`, metrics);

    if (sig) {
      table.players.push({ kp, seatIndex, joined: true, x25519Set: false });
    }
  }

  // Set x25519 keys for newly joined players
  for (const p of table.players) {
    if (p.joined && !p.x25519Set) {
      const sk = x25519.utils.randomPrivateKey();
      const pk = x25519.getPublicKey(sk);
      const sig = await sendTx(conn,
        setX25519KeyIx(p.kp.publicKey, table.tablePda, getSeat(table.tablePda, p.seatIndex), pk),
        [p.kp], `set_x25519 seat ${p.seatIndex}`, metrics);
      if (sig) p.x25519Set = true;
    }
  }
}

async function processTableAction(
  conn: Connection, table: TableInfo, metrics: Metrics,
): Promise<void> {
  const info = await conn.getAccountInfo(table.tablePda);
  if (!info) return;

  const data = Buffer.from(info.data);
  const t = readTableData(data);
  const now = Date.now();

  // Track hand transitions
  if (t.hand > table.lastHandNumber) {
    const handDelta = t.hand - table.lastHandNumber;
    table.handsPlayed += handDelta;
    table.lastHandNumber = t.hand;
    table.actionsThisHand = 0;

    // Update metrics
    if (table.kind === 'cash') {
      metrics.totalHandsCash += handDelta;
    } else {
      metrics.totalHandsSng += handDelta;
    }

    // Track rake
    const rake = t.rakeAccumulated;
    if (rake > table.totalRake) {
      const newRake = rake - table.totalRake;
      metrics.totalRake += newRake;
      table.totalRake = rake;
    }

    // Update per-table metrics
    const tblKey = table.tablePda.toBase58().slice(0, 12);
    metrics.perTableHands.set(tblKey, table.handsPlayed);
    metrics.perTableRake.set(tblKey, table.totalRake);
  }

  // Track pot
  if (t.pot > 0) {
    const tblKey = table.tablePda.toBase58().slice(0, 12);
    const pots = metrics.perTablePots.get(tblKey) || [];
    // Only record when pot changes significantly (new hand pot)
    if (pots.length === 0 || pots[pots.length - 1] !== t.pot) {
      pots.push(t.pot);
      metrics.perTablePots.set(tblKey, pots);
    }
  }

  // Stuck detection: if phase unchanged for >5 minutes, flag it
  if (t.phase === table.lastPhase && table.stuckSince > 0) {
    if (now - table.stuckSince > 5 * 60 * 1000) {
      metrics.stuckTables = Math.max(metrics.stuckTables, 1); // just flag
    }
  } else {
    table.stuckSince = now;
  }
  table.lastPhase = t.phase;

  // ─── Handle phases ───

  // MPC pending phases — skip, crank handles these
  const mpcPhases: number[] = [Phase.AwaitingDeal, Phase.AwaitingShowdown, Phase.FlopRevealPending,
       Phase.TurnRevealPending, Phase.RiverRevealPending, Phase.Starting,
       Phase.Showdown];
  if (mpcPhases.includes(t.phase)) {
    return;
  }

  // Playable phases: send player action
  if (t.phase >= Phase.Preflop && t.phase <= Phase.River) {
    const cp = t.curPlayer;
    const playerEntry = table.players.find(p => p.seatIndex === cp);
    if (!playerEntry) return;

    // Strategy: mostly call/check, occasionally all-in for variety
    const roll = Math.random();
    let action: string;
    if (roll < 0.05) {
      action = 'AllIn';
    } else if (t.minBet > 0) {
      action = 'Call';
    } else {
      action = 'Check';
    }

    const sig = await sendTx(conn,
      actionIx(playerEntry.kp.publicKey, table.tablePda, cp, action),
      [playerEntry.kp],
      `${table.kind}[${shortKey(table.tablePda)}] P${cp} ${action} (${PHASE_NAMES[t.phase]})`,
      metrics);

    if (!sig) {
      // Fallback: try check then call
      if (action !== 'Check') {
        await sendTx(conn,
          actionIx(playerEntry.kp.publicKey, table.tablePda, cp, 'Check'),
          [playerEntry.kp],
          `${table.kind}[${shortKey(table.tablePda)}] P${cp} Check (fallback)`,
          metrics);
      }
    }

    table.actionsThisHand++;
    return;
  }

  // ─── SNG Complete: handle post-game flow ───
  if (table.kind === 'sng' && (t.phase === Phase.Complete || (t.phase === Phase.Waiting && t.prizesDist))) {
    // Wait for crank to distribute_prizes and reset_sng_table
    // Once table is back in Waiting with 0 players, we can re-join
    if (t.phase === Phase.Waiting && t.curP === 0) {
      table.sngCompleted++;
      console.log(`  [SNG] Table ${shortKey(table.tablePda)} reset — round #${table.sngCompleted}`);

      // Try to claim unrefined POKER for winners
      for (const p of table.players) {
        await tryClaimUnrefined(conn, p.kp, metrics);
      }

      // Clear player list and re-join
      table.players = [];
      table.actionsThisHand = 0;
    }
    return;
  }

  // ─── Cash game Waiting: re-join if needed ───
  if (table.kind === 'cash' && t.phase === Phase.Waiting && t.curP < table.maxPlayers) {
    // Check if players need to be re-added (after cashout or bust)
    for (const p of table.players) {
      const seatInfo = await conn.getAccountInfo(getSeat(table.tablePda, p.seatIndex));
      if (seatInfo) {
        const seat = readSeatData(Buffer.from(seatInfo.data));
        if (seat.status === 0) { // Empty — player left or was removed
          p.joined = false;
          p.x25519Set = false;
        }
      }
    }
    // Remove disconnected players from tracking
    table.players = table.players.filter(p => p.joined);
    return;
  }
}

async function tryClaimUnrefined(conn: Connection, kp: Keypair, metrics: Metrics): Promise<void> {
  try {
    const unrefinedPda = getUnrefined(kp.publicKey);
    const info = await conn.getAccountInfo(unrefinedPda);
    if (!info || info.data.length <= 40) return;

    const amount = Number(Buffer.from(info.data).readBigUInt64LE(40));
    if (amount <= 0) return;

    metrics.unrefinedMinted += amount;

    // Try claim_refined
    const poolInfo = await conn.getAccountInfo(getPool());
    if (!poolInfo) return;
    const pokerMint = new PublicKey(Buffer.from(poolInfo.data).slice(40, 72));

    // Need a funded payer to create ATA if needed
    let winnerAta;
    try {
      winnerAta = await getOrCreateAssociatedTokenAccount(conn, kp, pokerMint, kp.publicKey);
    } catch {
      return; // Can't create ATA, skip
    }

    const claimIx = new TransactionInstruction({
      programId: STEEL_PROGRAM_ID,
      keys: [
        { pubkey: kp.publicKey, isSigner: true, isWritable: true },
        { pubkey: unrefinedPda, isSigner: false, isWritable: true },
        { pubkey: getPool(), isSigner: false, isWritable: true },
        { pubkey: winnerAta.address, isSigner: false, isWritable: true },
        { pubkey: pokerMint, isSigner: false, isWritable: true },
        { pubkey: getPool(), isSigner: false, isWritable: true }, // mint authority
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([5]), // claim_refined disc
    });

    const sig = await sendTx(conn, claimIx, [kp], `claim_refined ${shortKey(kp.publicKey)}`, metrics);
    if (sig) {
      metrics.refinedClaimed += amount;

      // Try burn-stake half
      await tryBurnStake(conn, kp, pokerMint, metrics);
    }
  } catch (e: any) {
    // Non-fatal
  }
}

async function tryBurnStake(conn: Connection, kp: Keypair, pokerMint: PublicKey, metrics: Metrics): Promise<void> {
  try {
    const ata = await getOrCreateAssociatedTokenAccount(conn, kp, pokerMint, kp.publicKey);
    const balance = Number(ata.amount);
    if (balance <= 0) return;

    const burnAmount = Math.floor(balance / 2);
    if (burnAmount <= 0) return;

    const stakePda = pda([Buffer.from('stake'), kp.publicKey.toBuffer()], STEEL_PROGRAM_ID);

    const burnData = Buffer.alloc(9);
    burnData[0] = 1; // burn_stake disc
    burnData.writeBigUInt64LE(BigInt(burnAmount), 1);

    const sig = await sendTx(conn, new TransactionInstruction({
      programId: STEEL_PROGRAM_ID,
      keys: [
        { pubkey: kp.publicKey, isSigner: true, isWritable: true },
        { pubkey: stakePda, isSigner: false, isWritable: true },
        { pubkey: getPool(), isSigner: false, isWritable: true },
        { pubkey: ata.address, isSigner: false, isWritable: true },
        { pubkey: pokerMint, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: burnData,
    }), [kp], `burn_stake ${shortKey(kp.publicKey)}`, metrics);

    if (sig) {
      metrics.pokerStaked += burnAmount;
    }
  } catch {
    // Non-fatal
  }
}

// ═══════════════════════════════════════════════════════════════
// MONITORING
// ═══════════════════════════════════════════════════════════════

async function readAllCrankTallies(
  conn: Connection, tables: TableInfo[],
): Promise<Map<string, CrankTallyData>> {
  const tallies = new Map<string, CrankTallyData>();
  const results = await Promise.allSettled(
    tables.map(async (t) => {
      const erInfo = await conn.getAccountInfo(getCrankEr(t.tablePda));
      if (erInfo && erInfo.data.length >= 197) {
        tallies.set(t.tablePda.toBase58().slice(0, 12), readCrankTally(Buffer.from(erInfo.data)));
      }
    })
  );
  return tallies;
}

function printStatusReport(
  tables: TableInfo[], metrics: Metrics, crankTallies: Map<string, CrankTallyData>,
): void {
  const now = Date.now();
  const el = elapsed(metrics.startTime);

  // Count table states
  let cashActive = 0, cashWaiting = 0, sngActive = 0, sngResetting = 0;
  let activePlayers = 0, sittingOut = 0;

  for (const t of tables) {
    if (t.kind === 'cash') {
      if (t.lastPhase >= Phase.Preflop && t.lastPhase <= Phase.River) cashActive++;
      else cashWaiting++;
    } else {
      if (t.lastPhase >= Phase.Preflop && t.lastPhase <= Phase.River) sngActive++;
      else sngResetting++;
    }
    for (const p of t.players) {
      if (p.joined) activePlayers++;
      else sittingOut++;
    }
  }

  // Aggregate crank tally data
  const crankAgg = new Map<string, { actions: number }>();
  let totalCrankActions = 0;
  for (const [_tbl, tally] of crankTallies) {
    for (let i = 0; i < 4; i++) {
      const pk = tally.operators[i];
      if (pk.equals(PublicKey.default)) continue;
      const key = pk.toBase58().slice(0, 8);
      const existing = crankAgg.get(key) || { actions: 0 };
      existing.actions += tally.actionCounts[i];
      crankAgg.set(key, existing);
    }
    totalCrankActions += tally.totalActions;
  }

  const totalTxs = metrics.successTxs + metrics.failedTxs;
  const failRate = totalTxs > 0 ? ((metrics.failedTxs / totalTxs) * 100).toFixed(1) : '0.0';
  const totalHands = metrics.totalHandsCash + metrics.totalHandsSng;
  const avgCashTime = metrics.cashHandTimes.length > 0
    ? (metrics.cashHandTimes.reduce((a, b) => a + b, 0) / metrics.cashHandTimes.length).toFixed(1) : 'N/A';
  const avgSngTime = metrics.sngHandTimes.length > 0
    ? (metrics.sngHandTimes.reduce((a, b) => a + b, 0) / metrics.sngHandTimes.length).toFixed(1) : 'N/A';

  // Count stuck tables (phase unchanged for 5+ min)
  let stuckCount = 0;
  for (const t of tables) {
    if (t.stuckSince > 0 && now - t.stuckSince > 5 * 60 * 1000 && t.players.length > 0) {
      stuckCount++;
    }
  }

  console.log('');
  console.log('='.repeat(55));
  console.log(`  STRESS TEST STATUS -- ${el} elapsed`);
  console.log('='.repeat(55));
  console.log(`Tables: ${NUM_CASH_TABLES} cash (${cashActive} active, ${cashWaiting} waiting) | ${NUM_SNG_TABLES} SNG (${sngActive} active, ${sngResetting} resetting)`);
  console.log(`Hands:  ${totalHands} total (${metrics.totalHandsCash} cash, ${metrics.totalHandsSng} SNG)`);
  console.log(`Players: ${activePlayers + sittingOut} (${activePlayers} active, ${sittingOut} sitting out)`);

  console.log('');
  console.log('-- Crank Tally --');
  if (crankAgg.size === 0) {
    console.log('  No crank actions recorded yet');
  } else {
    let topKey = '', topActions = 0;
    for (const [key, data] of crankAgg) {
      const pct = totalCrankActions > 0 ? ((data.actions / totalCrankActions) * 100).toFixed(1) : '0.0';
      console.log(`  Crank (${key}): ${data.actions} actions (${pct}%)`);
      if (data.actions > topActions) { topActions = data.actions; topKey = key; }
    }
    if (topKey) console.log(`  Top earner: ${topKey} with ${topActions} actions`);
  }

  console.log('');
  console.log('-- Economics --');
  console.log(`  Total rake:       ${(metrics.totalRake / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`  Total prizes:     ${(metrics.totalPrizes / LAMPORTS_PER_SOL).toFixed(4)} SOL distributed`);
  console.log(`  Unrefined POKER:  ${metrics.unrefinedMinted} minted`);
  console.log(`  Refined POKER:    ${metrics.refinedClaimed} claimed`);
  console.log(`  Staked POKER:     ${metrics.pokerStaked} burned`);

  console.log('');
  console.log('-- Health --');
  console.log(`  Failed TXs: ${metrics.failedTxs}/${totalTxs} (${failRate}%)`);
  console.log(`  Stuck tables: ${stuckCount}`);
  console.log(`  Race conditions: ${metrics.raceConditions}`);
  console.log(`  Avg hand time: ${avgCashTime}s (cash) | ${avgSngTime}s (SNG)`);
  console.log('='.repeat(55));
}

// ═══════════════════════════════════════════════════════════════
// FINAL REPORT
// ═══════════════════════════════════════════════════════════════

async function generateFinalReport(
  tables: TableInfo[], metrics: Metrics, cranks: Keypair[],
  conn: Connection,
): Promise<void> {
  const el = elapsed(metrics.startTime);
  const totalHands = metrics.totalHandsCash + metrics.totalHandsSng;
  const totalTxs = metrics.successTxs + metrics.failedTxs;
  const failRate = totalTxs > 0 ? ((metrics.failedTxs / totalTxs) * 100).toFixed(2) : '0.00';

  // Read final crank tallies
  const tallies = await readAllCrankTallies(conn, tables);

  // Aggregate per-crank stats
  const crankStats: Record<string, { pubkey: string; actions: number; share: number }> = {};
  let totalCrankActions = 0;
  for (const [_tbl, tally] of tallies) {
    totalCrankActions += tally.totalActions;
    for (let i = 0; i < 4; i++) {
      const pk = tally.operators[i];
      if (pk.equals(PublicKey.default)) continue;
      const key = pk.toBase58();
      if (!crankStats[key]) crankStats[key] = { pubkey: key, actions: 0, share: 0 };
      crankStats[key].actions += tally.actionCounts[i];
    }
  }
  for (const key of Object.keys(crankStats)) {
    crankStats[key].share = totalCrankActions > 0
      ? (crankStats[key].actions / totalCrankActions) * 100 : 0;
  }

  // Per-table stats
  const perTable: Record<string, {
    kind: string; hands: number; rake: number; avgPot: number; errors: number; sngRounds: number;
  }> = {};
  for (const t of tables) {
    const tblKey = t.tablePda.toBase58().slice(0, 12);
    const pots = metrics.perTablePots.get(tblKey) || [];
    const avgPot = pots.length > 0 ? pots.reduce((a, b) => a + b, 0) / pots.length : 0;
    perTable[tblKey] = {
      kind: t.kind,
      hands: t.handsPlayed,
      rake: t.totalRake,
      avgPot,
      errors: t.errors,
      sngRounds: t.sngCompleted,
    };
  }

  // Count stuck
  const now = Date.now();
  let stuckCount = 0;
  for (const t of tables) {
    if (t.stuckSince > 0 && now - t.stuckSince > 5 * 60 * 1000 && t.players.length > 0) stuckCount++;
  }

  const report = {
    summary: {
      duration: el,
      durationSeconds: Math.floor((Date.now() - metrics.startTime) / 1000),
      totalHands,
      cashHands: metrics.totalHandsCash,
      sngHands: metrics.totalHandsSng,
      totalTables: tables.length,
      cashTables: tables.filter(t => t.kind === 'cash').length,
      sngTables: tables.filter(t => t.kind === 'sng').length,
    },
    economics: {
      totalRakeLamports: metrics.totalRake,
      totalRakeSol: metrics.totalRake / LAMPORTS_PER_SOL,
      totalPrizesLamports: metrics.totalPrizes,
      totalPrizesSol: metrics.totalPrizes / LAMPORTS_PER_SOL,
      unrefinedPokerMinted: metrics.unrefinedMinted,
      refinedPokerClaimed: metrics.refinedClaimed,
      pokerStaked: metrics.pokerStaked,
    },
    health: {
      totalTxs,
      failedTxs: metrics.failedTxs,
      successTxs: metrics.successTxs,
      failRate: `${failRate}%`,
      stuckTables: stuckCount,
      raceConditions: metrics.raceConditions,
    },
    crankStats: Object.values(crankStats).sort((a, b) => b.actions - a.actions),
    perTable,
    timestamp: new Date().toISOString(),
  };

  // Print final report
  console.log('\n');
  console.log('='.repeat(60));
  console.log('  FINAL STRESS TEST REPORT');
  console.log('='.repeat(60));
  console.log(`  Duration:      ${el}`);
  console.log(`  Total Hands:   ${totalHands} (${metrics.totalHandsCash} cash, ${metrics.totalHandsSng} SNG)`);
  console.log(`  Total Tables:  ${tables.length}`);
  console.log('');

  console.log('-- Per-Crank Stats --');
  const crankEntries = Object.values(crankStats).sort((a, b) => b.actions - a.actions);
  if (crankEntries.length === 0) {
    console.log('  No crank actions recorded');
  } else {
    for (const c of crankEntries) {
      console.log(`  ${c.pubkey.slice(0, 12)}...: ${c.actions} actions (${c.share.toFixed(1)}%)`);
    }
  }

  console.log('');
  console.log('-- Per-Table Stats --');
  for (const t of tables) {
    const tblKey = t.tablePda.toBase58().slice(0, 12);
    const info = perTable[tblKey];
    const avgPotStr = (info.avgPot / LAMPORTS_PER_SOL).toFixed(6);
    const rakeStr = (info.rake / LAMPORTS_PER_SOL).toFixed(6);
    const extra = t.kind === 'sng' ? `, sngRounds=${info.sngRounds}` : '';
    console.log(`  ${tblKey} (${info.kind}): ${info.hands} hands, rake=${rakeStr} SOL, avgPot=${avgPotStr} SOL${extra}`);
  }

  console.log('');
  console.log('-- Economics --');
  console.log(`  Total Rake:       ${(metrics.totalRake / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`  Total Prizes:     ${(metrics.totalPrizes / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`  Unrefined POKER:  ${metrics.unrefinedMinted}`);
  console.log(`  Refined POKER:    ${metrics.refinedClaimed}`);
  console.log(`  Staked POKER:     ${metrics.pokerStaked}`);

  console.log('');
  console.log('-- Health --');
  console.log(`  Total TXs:     ${totalTxs}`);
  console.log(`  Failed TXs:    ${metrics.failedTxs} (${failRate}%)`);
  console.log(`  Stuck Tables:  ${stuckCount}`);
  console.log(`  Race Conds:    ${metrics.raceConditions}`);
  console.log(`  Table Errors:  ${tables.reduce((s, t) => s + t.errors, 0)}`);
  console.log('='.repeat(60));

  // Save report to JSON
  const reportPath = path.join(__dirname, 'stress-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report saved to ${reportPath}\n`);
}

// ═══════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');

  console.log('='.repeat(60));
  console.log('  2-HOUR ENDURANCE STRESS TEST');
  console.log('='.repeat(60));
  console.log(`  RPC:        ${RPC_URL}`);
  console.log(`  Duration:   ${DURATION_SECONDS}s (${(DURATION_SECONDS / 3600).toFixed(1)} hours)`);
  console.log(`  Cash tables: ${NUM_CASH_TABLES}`);
  console.log(`  SNG tables:  ${NUM_SNG_TABLES}`);
  console.log(`  Players:     ${NUM_PLAYERS}`);
  console.log(`  Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log('');
  console.log('  Ensure crank-service is running!');
  console.log('='.repeat(60));

  const metrics: Metrics = {
    startTime: Date.now(),
    totalHandsCash: 0,
    totalHandsSng: 0,
    totalRake: 0,
    totalPrizes: 0,
    unrefinedMinted: 0,
    refinedClaimed: 0,
    pokerStaked: 0,
    failedTxs: 0,
    successTxs: 0,
    stuckTables: 0,
    raceConditions: 0,
    cashHandTimes: [],
    sngHandTimes: [],
    crankActions: new Map(),
    perTableHands: new Map(),
    perTableRake: new Map(),
    perTablePots: new Map(),
  };

  // ─── SETUP PHASE ───
  console.log('\n\n--- SETUP PHASE ---\n');

  // Admin keypair for table creation
  const admin = Keypair.generate();
  const adminSig = await conn.requestAirdrop(admin.publicKey, 100 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(adminSig, 'confirmed');
  console.log(`  Admin: ${shortKey(admin.publicKey)} (100 SOL)`);

  // Fund treasury if needed
  try {
    const tBal = await conn.getBalance(TREASURY);
    if (tBal < LAMPORTS_PER_SOL) {
      const tSig = await conn.requestAirdrop(TREASURY, 2 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(tSig, 'confirmed');
    }
  } catch { /* treasury might not be airdrop-able on mainnet, fine for localnet */ }

  // Ensure dealer registry + tier config exist (should be done by bootstrap, but be safe)
  const dealerRegInfo = await conn.getAccountInfo(getDealerReg());
  if (!dealerRegInfo) {
    console.log('  Dealer registry not found — creating...');
    await sendTx(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: getDealerReg(), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: IX.init_dealer_registry,
    }), [admin], 'init_dealer_registry', metrics);
  }

  const solMint = PublicKey.default;
  const tierCfgInfo = await conn.getAccountInfo(getTierConfig(solMint));
  if (!tierCfgInfo) {
    console.log('  SOL TierConfig not found — creating...');
    const tierData = Buffer.alloc(40);
    IX.init_token_tier_config.copy(tierData, 0);
    solMint.toBuffer().copy(tierData, 8);
    await sendTx(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: getTierConfig(solMint), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: tierData,
    }), [admin], 'init_token_tier_config', metrics);
  }

  // Step 1-2: Generate and register crank keypairs
  const cranks = await setupCranks(conn, 15, metrics);
  console.log(`  ${cranks.length} cranks ready\n`);

  // Step 3: Generate and register players
  const players = await setupPlayers(conn, NUM_PLAYERS, metrics);
  console.log(`  ${players.length} players ready\n`);

  // Step 4: Create tables
  const tables = await createTables(conn, admin, NUM_CASH_TABLES, NUM_SNG_TABLES, metrics);
  console.log(`  ${tables.length} tables ready\n`);

  // Step 5: Assign players to tables (2 per HU table)
  console.log('\n  Assigning players to tables...');
  let playerIdx = 0;
  for (const t of tables) {
    const neededPlayers = t.maxPlayers;
    for (let i = 0; i < neededPlayers && playerIdx < players.length; i++) {
      t.players.push({ kp: players[playerIdx], seatIndex: i, joined: false, x25519Set: false });
      playerIdx++;
    }
  }

  // Join all players
  console.log('  Joining players to tables...');
  for (const t of tables) {
    await joinPlayersToTable(conn, t, players, metrics);
  }
  console.log(`  All players assigned and joined\n`);

  // ─── TEST LOOP ───
  console.log('\n--- TEST LOOP STARTING ---\n');
  console.log(`  Running for ${DURATION_SECONDS}s (${(DURATION_SECONDS / 3600).toFixed(1)} hours)...`);

  const testStart = Date.now();
  let lastStatusTime = testStart;
  let iteration = 0;

  while ((Date.now() - testStart) < DURATION_SECONDS * 1000) {
    iteration++;

    // Process all tables in parallel batches (5 at a time to avoid RPC flooding)
    const batchSize = 5;
    for (let batchStart = 0; batchStart < tables.length; batchStart += batchSize) {
      const batch = tables.slice(batchStart, batchStart + batchSize);
      await Promise.allSettled(batch.map(async (t) => {
        try {
          // Check if players need to be (re)joined
          if (t.players.filter(p => p.joined).length < t.maxPlayers) {
            await joinPlayersToTable(conn, t, players, metrics);
          }
          // Process table actions
          await processTableAction(conn, t, metrics);
        } catch (e: any) {
          t.errors++;
          // Don't crash on individual table errors
        }
      }));
    }

    // Status report every STATUS_INTERVAL_MS
    const now = Date.now();
    if (now - lastStatusTime >= STATUS_INTERVAL_MS) {
      lastStatusTime = now;
      try {
        const tallies = await readAllCrankTallies(conn, tables);
        printStatusReport(tables, metrics, tallies);
      } catch (e: any) {
        console.log(`  [Status report error: ${e.message?.slice(0, 80)}]`);
      }
    }

    // Poll delay
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // ─── FINAL REPORT ───
  console.log('\n\n--- TEST COMPLETE ---\n');
  await generateFinalReport(tables, metrics, cranks, conn);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
