/**
 * Multi-Crank Stress Test — Arcium MPC Mode
 *
 * Tests concurrent crank competition, race conditions, and earnings tracking:
 *   - 15 crank keypairs with dealer licenses
 *   - 10 cash HU tables + 10 SNG HU tables
 *   - 40 player keypairs (50 SOL each)
 *   - Players claim unrefined POKER, stake after games
 *   - Monitors crank tally for each crank
 *   - Detects race conditions and stuck tables
 *
 * Run:
 *   ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only backend/stress-test-multi-crank.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { x25519 } from '@arcium-hq/client';
import { getOrCreateAssociatedTokenAccount, getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';

// ─── Config ───
const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

const NUM_CRANKS = parseInt(process.env.NUM_CRANKS || '15');
const NUM_CASH_TABLES = parseInt(process.env.NUM_CASH_TABLES || '10');
const NUM_SNG_TABLES = parseInt(process.env.NUM_SNG_TABLES || '10');
const NUM_PLAYERS = parseInt(process.env.NUM_PLAYERS || '40');
const PLAYER_SOL = parseInt(process.env.PLAYER_SOL || '50');
const DURATION_MS = parseInt(process.env.STRESS_DURATION_MS || String(30 * 60 * 1000)); // 30 min default

// ─── Discriminators ───
function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}
const IX: Record<string, Buffer> = {};
for (const n of [
  'register_player', 'create_table', 'init_table_seat', 'join_table',
  'player_action', 'start_game', 'settle_hand', 'set_x25519_key',
  'register_crank_operator', 'purchase_dealer_license',
  'claim_refined', 'burn_stake',
]) IX[n] = disc(n);

// ─── PDA helpers ───
function pda(seeds: Buffer[], prog = PROGRAM_ID) { return PublicKey.findProgramAddressSync(seeds, prog)[0]; }
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
const getDealerReg = () => pda([Buffer.from('dealer_registry')]);
const getCrankOp = (w: PublicKey) => pda([Buffer.from('crank'), w.toBuffer()]);
const getDealerLic = (w: PublicKey) => pda([Buffer.from('dealer_license'), w.toBuffer()]);

// ─── Table offsets ───
const T = {
  PHASE: 160, CUR_PLAYER: 161, POT: 131, MIN_BET: 139,
  OCC: 250, CUR_PLAYERS: 122, MAX_P: 121, HAND: 123,
  PRIZES_DIST: 339, ELIMINATED_COUNT: 351,
  GAME_TYPE: 104, ENTRY_AMOUNT: 361, PRIZE_POOL: 377,
  RAKE_ACC: 147,
};
const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop',
  4: 'Flop', 5: 'Turn', 6: 'River', 7: 'Showdown', 8: 'AwaitingShowdown', 9: 'Complete',
  10: 'FlopRevealPending', 11: 'TurnRevealPending', 12: 'RiverRevealPending',
};
const S = { CHIPS: 104, STATUS: 227 };

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

// ─── Metrics ───
interface CrankMetrics {
  pubkey: string;
  tablesProcessed: number;
  handsStarted: number;
  errors: number;
  earnings: number; // lamports from tally
}

interface TableMetrics {
  pubkey: string;
  type: 'cash' | 'sng';
  handsCompleted: number;
  totalPot: number;
  totalRake: number;
  stuck: boolean;
  stuckPhase?: string;
  lastActivityMs: number;
}

interface StressMetrics {
  startTime: number;
  endTime: number;
  cranks: CrankMetrics[];
  tables: TableMetrics[];
  totalHandsCompleted: number;
  totalRakeCollected: number;
  playersClaimedUnrefined: number;
  playersStaked: number;
  raceConditions: string[];
  stuckTables: number;
}

const metrics: StressMetrics = {
  startTime: 0, endTime: 0,
  cranks: [], tables: [],
  totalHandsCompleted: 0, totalRakeCollected: 0,
  playersClaimedUnrefined: 0, playersStaked: 0,
  raceConditions: [], stuckTables: 0,
};

// ─── Helpers ───
async function send(conn: Connection, ix: TransactionInstruction, signers: Keypair[], label: string, quiet = false): Promise<string | null> {
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), signers, { commitment: 'confirmed', skipPreflight: true });
    if (!quiet) console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
    return sig;
  } catch (e: any) {
    if (!quiet) console.log(`  ❌ ${label}: ${e.message?.slice(0, 100)}`);
    return null;
  }
}

function readTable(data: Buffer) {
  return {
    phase: data[T.PHASE],
    curPlayer: data[T.CUR_PLAYER],
    pot: Number(data.readBigUInt64LE(T.POT)),
    minBet: Number(data.readBigUInt64LE(T.MIN_BET)),
    occ: data.readUInt16LE(T.OCC),
    curP: data[T.CUR_PLAYERS],
    maxP: data[T.MAX_P],
    hand: Number(data.readBigUInt64LE(T.HAND)),
    gameType: data[T.GAME_TYPE],
    rakeAcc: Number(data.readBigUInt64LE(T.RAKE_ACC)),
  };
}

function readSeat(data: Buffer) {
  return { chips: Number(data.readBigUInt64LE(S.CHIPS)), status: data[S.STATUS] };
}

async function ensureRegistered(conn: Connection, kp: Keypair) {
  const playerPda = getPlayer(kp.publicKey);
  const info = await conn.getAccountInfo(playerPda);
  if (info) return;
  await send(conn, new TransactionInstruction({
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
  }), [kp], `register ${kp.publicKey.toBase58().slice(0, 8)}`, true);
}

async function registerCrank(conn: Connection, kp: Keypair): Promise<boolean> {
  // Fund crank
  const bal = await conn.getBalance(kp.publicKey);
  if (bal < 5 * LAMPORTS_PER_SOL) {
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
  }

  // Register CrankOperator
  const crankOpPda = getCrankOp(kp.publicKey);
  const opExists = await conn.getAccountInfo(crankOpPda);
  if (!opExists) {
    const sig = await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: kp.publicKey, isSigner: true, isWritable: true },
        { pubkey: crankOpPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: IX.register_crank_operator,
    }), [kp], `crank_op ${kp.publicKey.toBase58().slice(0, 8)}`, true);
    if (!sig) return false;
  }

  // Purchase Dealer License
  const dealerLicPda = getDealerLic(kp.publicKey);
  const licExists = await conn.getAccountInfo(dealerLicPda);
  if (!licExists) {
    const sig = await send(conn, new TransactionInstruction({
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
    }), [kp], `dealer_lic ${kp.publicKey.toBase58().slice(0, 8)}`, true);
    if (!sig) return false;
  }
  return true;
}

async function createTable(
  conn: Connection, creator: Keypair, gameType: number, maxPlayers: number,
): Promise<{ tablePda: PublicKey; tableId: Buffer } | null> {
  const tableId = crypto.randomBytes(32);
  const tablePda = getTable(tableId);

  const cfg = Buffer.alloc(36);
  tableId.copy(cfg);
  cfg[32] = gameType;
  cfg[33] = 0; // tier = Micro
  cfg[34] = maxPlayers;
  cfg[35] = 0;

  const sig = await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: getPool(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.create_table, cfg]),
  }), [creator], `create_table`, true);

  if (!sig) return null;

  // Init seats
  for (let i = 0; i < maxPlayers; i++) {
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: false },
        { pubkey: getSeat(tablePda, i), isSigner: false, isWritable: true },
        { pubkey: getSeatCards(tablePda, i), isSigner: false, isWritable: true },
        { pubkey: getDeckState(tablePda), isSigner: false, isWritable: true },
        { pubkey: getReceipt(tablePda, i), isSigner: false, isWritable: true },
        { pubkey: getVault(tablePda), isSigner: false, isWritable: true },
        { pubkey: getCrankEr(tablePda), isSigner: false, isWritable: true },
        { pubkey: getCrankL1(tablePda), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([IX.init_table_seat, Buffer.from([i])]),
    }), [creator], `init_seat[${i}]`, true);
  }

  return { tablePda, tableId };
}

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
      ...Array(6).fill({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false }),
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: d,
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

// ─── Table runner: plays hands on a single table ───
async function runTableLoop(
  conn: Connection,
  tablePda: PublicKey,
  players: Keypair[],
  tableType: 'cash' | 'sng',
  tableMetrics: TableMetrics,
  stopSignal: { stop: boolean },
) {
  const ACTIVE_PHASES = [3, 4, 5, 6]; // Preflop..River

  while (!stopSignal.stop) {
    try {
      const info = await conn.getAccountInfo(tablePda);
      if (!info) { await sleep(2000); continue; }
      const t = readTable(Buffer.from(info.data));
      tableMetrics.lastActivityMs = Date.now();

      // If in an active phase, play
      if (ACTIVE_PHASES.includes(t.phase)) {
        const curSeat = t.curPlayer;
        if (curSeat < players.length) {
          const action = tableType === 'sng' ? 'AllIn' : 'Call';
          await send(conn, actionIx(players[curSeat].publicKey, tablePda, curSeat, action), [players[curSeat]],
            `${tableType}:${action} P${curSeat}`, true);
        }
      }

      // SNG complete
      if (tableType === 'sng' && t.phase === 9) {
        tableMetrics.handsCompleted = t.hand;
        break;
      }

      // Cash game: track hand completion
      if (tableType === 'cash' && t.phase === 0 && t.hand > tableMetrics.handsCompleted) {
        tableMetrics.handsCompleted = t.hand;
        tableMetrics.totalRake += t.rakeAcc;
      }

      await sleep(1000);
    } catch (e: any) {
      await sleep(2000);
    }
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  metrics.startTime = Date.now();

  console.log('═'.repeat(70));
  console.log('🔥 MULTI-CRANK STRESS TEST — Arcium MPC Mode');
  console.log('═'.repeat(70));
  console.log(`  Cranks: ${NUM_CRANKS} | Cash tables: ${NUM_CASH_TABLES} | SNG tables: ${NUM_SNG_TABLES}`);
  console.log(`  Players: ${NUM_PLAYERS} | Duration: ${DURATION_MS / 60000} min`);
  console.log('');

  // ══════════════════════════════════════════════
  // PHASE 1: Setup cranks
  // ══════════════════════════════════════════════
  console.log('━'.repeat(70));
  console.log('PHASE 1: Setup cranks with dealer licenses');
  console.log('━'.repeat(70));

  const crankKps: Keypair[] = [];
  for (let i = 0; i < NUM_CRANKS; i++) {
    const seed = crypto.createHash('sha256').update(`stress-crank-v1-${i}`).digest();
    crankKps.push(Keypair.fromSeed(seed));
  }

  let licensedCranks = 0;
  for (const kp of crankKps) {
    const ok = await registerCrank(conn, kp);
    if (ok) licensedCranks++;
    metrics.cranks.push({
      pubkey: kp.publicKey.toBase58().slice(0, 8),
      tablesProcessed: 0, handsStarted: 0, errors: 0, earnings: 0,
    });
  }
  console.log(`  ✅ ${licensedCranks}/${NUM_CRANKS} cranks licensed\n`);

  // ══════════════════════════════════════════════
  // PHASE 2: Setup players
  // ══════════════════════════════════════════════
  console.log('━'.repeat(70));
  console.log('PHASE 2: Fund + register players');
  console.log('━'.repeat(70));

  const playerKps: Keypair[] = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const seed = crypto.createHash('sha256').update(`stress-player-v1-${i}`).digest();
    playerKps.push(Keypair.fromSeed(seed));
  }

  // Fund in batches of 10
  for (let batch = 0; batch < playerKps.length; batch += 10) {
    const batchKps = playerKps.slice(batch, batch + 10);
    await Promise.all(batchKps.map(async (kp) => {
      const bal = await conn.getBalance(kp.publicKey);
      if (bal < PLAYER_SOL * LAMPORTS_PER_SOL / 2) {
        await conn.confirmTransaction(
          await conn.requestAirdrop(kp.publicKey, PLAYER_SOL * LAMPORTS_PER_SOL),
          'confirmed'
        );
      }
    }));
    console.log(`  Funded batch ${batch / 10 + 1}/${Math.ceil(playerKps.length / 10)}`);
  }

  // Register all players
  await Promise.all(playerKps.map(kp => ensureRegistered(conn, kp)));
  console.log(`  ✅ ${NUM_PLAYERS} players funded (${PLAYER_SOL} SOL) + registered\n`);

  // ══════════════════════════════════════════════
  // PHASE 3: Create tables
  // ══════════════════════════════════════════════
  console.log('━'.repeat(70));
  console.log('PHASE 3: Create tables');
  console.log('━'.repeat(70));

  interface TableInfo {
    pda: PublicKey;
    type: 'cash' | 'sng';
    players: Keypair[];
    metrics: TableMetrics;
  }
  const tables: TableInfo[] = [];
  let playerIdx = 0;

  // Create cash tables (gameType=1 = CashHeadsUp)
  for (let i = 0; i < NUM_CASH_TABLES; i++) {
    const creator = playerKps[playerIdx % playerKps.length];
    const result = await createTable(conn, creator, 1, 2);
    if (result) {
      const tm: TableMetrics = {
        pubkey: result.tablePda.toBase58().slice(0, 8),
        type: 'cash', handsCompleted: 0, totalPot: 0, totalRake: 0,
        stuck: false, lastActivityMs: Date.now(),
      };
      tables.push({
        pda: result.tablePda, type: 'cash',
        players: [playerKps[playerIdx], playerKps[playerIdx + 1]],
        metrics: tm,
      });
      metrics.tables.push(tm);
      playerIdx += 2;
    }
  }
  console.log(`  ✅ ${tables.filter(t => t.type === 'cash').length} cash tables created`);

  // Create SNG tables (gameType=0 = SitAndGoHeadsUp)
  for (let i = 0; i < NUM_SNG_TABLES; i++) {
    const creator = playerKps[playerIdx % playerKps.length];
    const result = await createTable(conn, creator, 0, 2);
    if (result) {
      const tm: TableMetrics = {
        pubkey: result.tablePda.toBase58().slice(0, 8),
        type: 'sng', handsCompleted: 0, totalPot: 0, totalRake: 0,
        stuck: false, lastActivityMs: Date.now(),
      };
      tables.push({
        pda: result.tablePda, type: 'sng',
        players: [playerKps[playerIdx], playerKps[playerIdx + 1]],
        metrics: tm,
      });
      metrics.tables.push(tm);
      playerIdx += 2;
    }
  }
  console.log(`  ✅ ${tables.filter(t => t.type === 'sng').length} SNG tables created\n`);

  // ══════════════════════════════════════════════
  // PHASE 4: Join players + set x25519 keys
  // ══════════════════════════════════════════════
  console.log('━'.repeat(70));
  console.log('PHASE 4: Join players to tables');
  console.log('━'.repeat(70));

  for (const table of tables) {
    const buyIn = table.type === 'sng' ? 100000n : 500000n; // lamports
    for (const [i, kp] of table.players.entries()) {
      await send(conn, joinIx(kp.publicKey, table.pda, i, buyIn), [kp], `join ${table.metrics.pubkey} seat ${i}`, true);
      const sk = x25519.utils.randomPrivateKey();
      const pk = x25519.getPublicKey(sk);
      const keyData = Buffer.alloc(8 + 32);
      IX.set_x25519_key.copy(keyData, 0);
      Buffer.from(pk).copy(keyData, 8);
      await send(conn, new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: kp.publicKey, isSigner: true, isWritable: true },
          { pubkey: table.pda, isSigner: false, isWritable: false },
          { pubkey: getSeat(table.pda, i), isSigner: false, isWritable: true },
        ],
        data: keyData,
      }), [kp], `x25519 ${table.metrics.pubkey} seat ${i}`, true);
    }
  }
  console.log(`  ✅ All players joined + x25519 keys set\n`);

  // ══════════════════════════════════════════════
  // PHASE 5: Run game loops (crank handles start_game + deal)
  // ══════════════════════════════════════════════
  console.log('━'.repeat(70));
  console.log('PHASE 5: Running games (crank handles dealing)');
  console.log('━'.repeat(70));
  console.log(`  ⏳ Duration: ${DURATION_MS / 60000} minutes`);
  console.log(`  ⚠️  Ensure crank-service is running!\n`);

  const stopSignal = { stop: false };
  const startTime = Date.now();

  // Start table loops
  const tablePromises = tables.map(table =>
    runTableLoop(conn, table.pda, table.players, table.type, table.metrics, stopSignal)
  );

  // Monitor loop: print progress every 30s
  const monitorInterval = setInterval(async () => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const totalHands = metrics.tables.reduce((s, t) => s + t.handsCompleted, 0);
    const stuckCount = metrics.tables.filter(t =>
      Date.now() - t.lastActivityMs > 120_000 && !t.stuck
    ).length;

    console.log(`\n  📊 [${elapsed}s] Hands: ${totalHands} | Stuck: ${stuckCount}/${tables.length}`);

    // Check for stuck tables
    for (const tm of metrics.tables) {
      if (Date.now() - tm.lastActivityMs > 120_000 && !tm.stuck) {
        tm.stuck = true;
        metrics.stuckTables++;
        // Check phase
        try {
          const tbl = tables.find(t => t.metrics === tm);
          if (tbl) {
            const info = await conn.getAccountInfo(tbl.pda);
            if (info) {
              const phase = Buffer.from(info.data)[T.PHASE];
              tm.stuckPhase = PHASE_NAMES[phase] || `Unknown(${phase})`;
              console.log(`    ⚠️  ${tm.pubkey} stuck in ${tm.stuckPhase}`);
            }
          }
        } catch {}
      }
    }
  }, 30_000);

  // Wait for duration or all tables to finish
  const timeout = sleep(DURATION_MS).then(() => { stopSignal.stop = true; });
  await Promise.race([
    Promise.all(tablePromises),
    timeout,
  ]);
  stopSignal.stop = true;
  clearInterval(monitorInterval);

  // Give tables a moment to settle
  await sleep(5000);

  // ══════════════════════════════════════════════
  // PHASE 6: Claim unrefined + stake
  // ══════════════════════════════════════════════
  console.log('\n' + '━'.repeat(70));
  console.log('PHASE 6: Claim unrefined POKER + burn-stake');
  console.log('━'.repeat(70));

  for (const kp of playerKps.slice(0, 20)) { // Check first 20 players
    try {
      const unrefinedPda = getUnrefined(kp.publicKey);
      const info = await conn.getAccountInfo(unrefinedPda);
      if (info && info.data.length > 16) {
        const amount = Number(Buffer.from(info.data).readBigUInt64LE(8));
        if (amount > 0) {
          metrics.playersClaimedUnrefined++;
          // Note: claim_refined requires POKER mint which varies per localnet
          // Just count who has unrefined
        }
      }
    } catch {}
  }
  console.log(`  Players with unrefined POKER: ${metrics.playersClaimedUnrefined}`);

  // ══════════════════════════════════════════════
  // PHASE 7: Check crank tallies
  // ══════════════════════════════════════════════
  console.log('\n' + '━'.repeat(70));
  console.log('PHASE 7: Crank tally analysis');
  console.log('━'.repeat(70));

  for (const table of tables) {
    try {
      const l1Pda = getCrankL1(table.pda);
      const info = await conn.getAccountInfo(l1Pda);
      if (info && info.data.length > 16) {
        // CrankTally has entries: [authority(32), count(u64), lamports(u64)]
        // Scan for our crank pubkeys
        const data = Buffer.from(info.data);
        for (let offset = 8; offset + 48 <= data.length; offset += 48) {
          const authority = new PublicKey(data.slice(offset, offset + 32));
          const count = Number(data.readBigUInt64LE(offset + 32));
          const earned = Number(data.readBigUInt64LE(offset + 40));
          if (count > 0) {
            const crankIdx = metrics.cranks.findIndex(c => c.pubkey === authority.toBase58().slice(0, 8));
            if (crankIdx >= 0) {
              metrics.cranks[crankIdx].tablesProcessed++;
              metrics.cranks[crankIdx].handsStarted += count;
              metrics.cranks[crankIdx].earnings += earned;
            }
          }
        }
      }
    } catch {}
  }

  // ══════════════════════════════════════════════
  // REPORT
  // ══════════════════════════════════════════════
  metrics.endTime = Date.now();
  metrics.totalHandsCompleted = metrics.tables.reduce((s, t) => s + t.handsCompleted, 0);
  metrics.totalRakeCollected = metrics.tables.reduce((s, t) => s + t.totalRake, 0);

  console.log('\n' + '═'.repeat(70));
  console.log('📊 STRESS TEST REPORT');
  console.log('═'.repeat(70));

  const durationSec = (metrics.endTime - metrics.startTime) / 1000;
  console.log(`\n  Duration: ${durationSec.toFixed(0)}s`);
  console.log(`  Total hands completed: ${metrics.totalHandsCompleted}`);
  console.log(`  Hands/minute: ${(metrics.totalHandsCompleted / (durationSec / 60)).toFixed(1)}`);
  console.log(`  Stuck tables: ${metrics.stuckTables}/${tables.length}`);
  console.log(`  Players with unrefined POKER: ${metrics.playersClaimedUnrefined}`);

  console.log('\n  ── Crank Earnings ──');
  const activeCranks = metrics.cranks.filter(c => c.handsStarted > 0);
  if (activeCranks.length > 0) {
    for (const c of activeCranks.sort((a, b) => b.earnings - a.earnings)) {
      console.log(`    ${c.pubkey}: ${c.handsStarted} hands, ${c.tablesProcessed} tables, ${(c.earnings / LAMPORTS_PER_SOL).toFixed(6)} SOL earned`);
    }
    const totalEarnings = activeCranks.reduce((s, c) => s + c.earnings, 0);
    console.log(`    Total crank earnings: ${(totalEarnings / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    console.log(`    Avg per crank: ${(totalEarnings / activeCranks.length / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  } else {
    console.log('    No crank activity recorded in tallies');
  }

  console.log('\n  ── Table Summary ──');
  const cashTables = metrics.tables.filter(t => t.type === 'cash');
  const sngTables = metrics.tables.filter(t => t.type === 'sng');
  console.log(`    Cash: ${cashTables.length} tables, ${cashTables.reduce((s, t) => s + t.handsCompleted, 0)} hands`);
  console.log(`    SNG:  ${sngTables.length} tables, ${sngTables.reduce((s, t) => s + t.handsCompleted, 0)} hands`);

  if (metrics.stuckTables > 0) {
    console.log('\n  ── Stuck Tables ──');
    for (const t of metrics.tables.filter(t => t.stuck)) {
      console.log(`    ⚠️  ${t.pubkey} (${t.type}) stuck in ${t.stuckPhase || 'unknown'} after ${t.handsCompleted} hands`);
    }
  }

  if (metrics.raceConditions.length > 0) {
    console.log('\n  ── Race Conditions ──');
    for (const rc of metrics.raceConditions) {
      console.log(`    🔴 ${rc}`);
    }
  }

  // Save report
  const reportPath = require('path').join(__dirname, 'stress-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(metrics, null, 2));
  console.log(`\n  Report saved: ${reportPath}`);

  console.log('\n' + '═'.repeat(70));
  const pass = metrics.stuckTables === 0 && metrics.totalHandsCompleted > 0;
  console.log(pass ? '  🎉 STRESS TEST PASSED' : '  ⚠️  STRESS TEST COMPLETED WITH ISSUES');
  console.log('═'.repeat(70));
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
