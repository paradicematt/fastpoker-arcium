/**
 * Crank Stress Test — Ported to Arcium MPC (requires x25519 keys)
 *
 * Creates multiple tables with various scenarios for the crank to handle.
 * The crank uses arcium_deal (MPC) for dealing — first deal on fresh localnet
 * may take 5-15+ minutes for preprocessing.
 *
 * Scenarios:
 *   1. HU cash — players join, start, both idle (crank timeouts + settles)
 *   2. HU cash — players join, start, fold preflop (crank settles)
 *   3. HU cash — player leaves between hands (crank cashout in Waiting)
 *   4. Multiple HU tables simultaneously (parallel crank processing)
 *   5. 6-max with sit-out player (crank kick test)
 *
 * Run while crank is running:
 *   ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only backend/stress-test-crank.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { x25519 } from '@arcium-hq/client';

const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}
const IX: Record<string, Buffer> = {};
for (const n of [
  'register_player','create_table','init_table_seat','join_table',
  'player_action','start_game','settle_hand','set_x25519_key',
]) IX[n] = disc(n);

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

const T = {
  PHASE: 160, CUR_PLAYER: 161, POT: 131, MIN_BET: 139,
  OCC: 250, ALLIN: 252, FOLDED: 254, CUR_PLAYERS: 122, MAX_P: 121,
  HAND: 123, SB_SEAT: 164, BB_SEAT: 165, BUTTON: 163,
};
const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop',
  4: 'Flop', 5: 'Turn', 6: 'River', 7: 'Showdown', 8: 'AwaitingShowdown', 9: 'Complete',
  10: 'FlopRevealPending', 11: 'TurnRevealPending', 12: 'RiverRevealPending',
};

function serializeAction(action: string, amount?: bigint): Buffer {
  switch (action) {
    case 'Fold': return Buffer.from([0]);
    case 'Check': return Buffer.from([1]);
    case 'Call': return Buffer.from([2]);
    case 'Bet': { const b = Buffer.alloc(9); b[0] = 3; b.writeBigUInt64LE(amount || 0n, 1); return b; }
    case 'AllIn': return Buffer.from([5]);
    case 'LeaveCashGame': return Buffer.from([8]);
    case 'SitOut': return Buffer.from([6]);
    default: throw new Error(`Unknown action: ${action}`);
  }
}

async function send(conn: Connection, ix: TransactionInstruction, signers: Keypair[], label: string): Promise<boolean> {
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), signers, { commitment: 'confirmed', skipPreflight: true });
    console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
    return true;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0, 100)}`);
    return false;
  }
}

function readTable(data: Buffer) {
  return {
    phase: data[T.PHASE],
    curPlayer: data[T.CUR_PLAYER],
    pot: Number(data.readBigUInt64LE(T.POT)),
    occ: data.readUInt16LE(T.OCC),
    curP: data[T.CUR_PLAYERS],
    maxP: data[T.MAX_P],
    hand: Number(data.readBigUInt64LE(T.HAND)),
    sbSeat: data[T.SB_SEAT],
    bbSeat: data[T.BB_SEAT],
  };
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
  }), [kp], `register ${kp.publicKey.toBase58().slice(0, 8)}`);
}

async function createTable(conn: Connection, creator: Keypair, label: string, maxPlayers: number, gameType: number = 3): Promise<PublicKey> {
  const tableId = crypto.randomBytes(32);
  const tablePda = getTable(tableId);

  const cfg = Buffer.alloc(36);
  tableId.copy(cfg);
  cfg[32] = gameType;
  cfg[33] = 0;
  cfg[34] = maxPlayers;
  cfg[35] = 0;

  await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: getPool(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.create_table, cfg]),
  }), [creator], `create_table ${label}`);

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
    }), [creator], `init_seat[${i}] ${label}`);
  }

  console.log(`  📋 Table ${label}: ${tablePda.toBase58().slice(0, 12)}... (${maxPlayers}-max)`);
  return tablePda;
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

async function waitForPhase(conn: Connection, tbl: PublicKey, targetPhase: number, timeoutMs = 300_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await conn.getAccountInfo(tbl);
    if (info) {
      const phase = Buffer.from(info.data)[T.PHASE];
      if (phase === targetPhase) return true;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

/** Join a player to a table seat AND set their x25519 key (required for Arcium deal). */
async function joinAndSetKey(
  conn: Connection, player: Keypair, tbl: PublicKey, seat: number, buyIn: bigint,
): Promise<Uint8Array> {
  await send(conn, joinIx(player.publicKey, tbl, seat, buyIn), [player], `join seat ${seat}`);
  const sk = x25519.utils.randomPrivateKey();
  const pk = x25519.getPublicKey(sk);
  await send(conn, setX25519KeyIx(player.publicKey, tbl, getSeat(tbl, seat), pk), [player], `set_x25519 seat ${seat}`);
  return sk;
}

// ═══════════════════════════════════════════════════════════════════
// PERFORMANCE TRACKING
// ═══════════════════════════════════════════════════════════════════

interface TxRecord {
  sig: string;
  label: string;
  feeLamports: number;
  cuConsumed: number;
  timestampMs: number;
}

interface HandCostEntry {
  handNumber: number;
  wallClockMs: number;
  mpcLatencyMs: number;       // AwaitingDeal → Preflop
  txCount: number;
  totalFeeLamports: number;
  totalCU: number;
  txBreakdown: { label: string; fee: number; cu: number }[];
}

interface PerformanceReport {
  timestamp: string;
  rpcUrl: string;
  handsPlayed: number;
  hands: HandCostEntry[];
  summary: {
    avgCostLamports: number;
    avgCostSOL: number;
    avgCostUSD: number;      // estimate at ~$150/SOL
    avgMpcLatencyMs: number;
    avgTxCount: number;
    avgCU: number;
    maxCostLamports: number;
    minCostLamports: number;
    erThresholdExceeded: boolean;  // avg > $0.10
  };
}

class PerformanceTracker {
  private conn: Connection;
  private txRecords: TxRecord[] = [];
  private handEntries: HandCostEntry[] = [];
  private currentHandStart = 0;
  private currentMpcStart = 0;
  private currentMpcEnd = 0;
  private currentHandTxs: TxRecord[] = [];
  private currentHandNum = 0;

  constructor(conn: Connection) { this.conn = conn; }

  /** Record a TX signature with label. Returns the signature. */
  async recordTx(sig: string, label: string): Promise<void> {
    this.txRecords.push({ sig, label, feeLamports: 0, cuConsumed: 0, timestampMs: Date.now() });
    this.currentHandTxs.push(this.txRecords[this.txRecords.length - 1]);
  }

  /** Send + confirm + record in one call */
  async sendTracked(
    ix: TransactionInstruction, signers: Keypair[], label: string,
  ): Promise<string | null> {
    try {
      const sig = await sendAndConfirmTransaction(
        this.conn, new Transaction().add(ix), signers,
        { commitment: 'confirmed', skipPreflight: true },
      );
      console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
      await this.recordTx(sig, label);
      return sig;
    } catch (e: any) {
      console.log(`  ❌ ${label}: ${e.message?.slice(0, 100)}`);
      return null;
    }
  }

  startHand(handNum: number) {
    this.currentHandNum = handNum;
    this.currentHandStart = Date.now();
    this.currentMpcStart = 0;
    this.currentMpcEnd = 0;
    this.currentHandTxs = [];
  }

  markMpcStart() { this.currentMpcStart = Date.now(); }
  markMpcEnd() { this.currentMpcEnd = Date.now(); }

  async finishHand(): Promise<HandCostEntry> {
    const wallClockMs = Date.now() - this.currentHandStart;
    const mpcLatencyMs = this.currentMpcEnd > 0 && this.currentMpcStart > 0
      ? this.currentMpcEnd - this.currentMpcStart : 0;

    // Fetch TX details (fees + CU) from RPC
    const txBreakdown: { label: string; fee: number; cu: number }[] = [];
    let totalFee = 0;
    let totalCU = 0;

    for (const rec of this.currentHandTxs) {
      try {
        const tx = await this.conn.getTransaction(rec.sig, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (tx?.meta) {
          rec.feeLamports = tx.meta.fee;
          rec.cuConsumed = tx.meta.computeUnitsConsumed || 0;
        }
      } catch {}
      txBreakdown.push({ label: rec.label, fee: rec.feeLamports, cu: rec.cuConsumed });
      totalFee += rec.feeLamports;
      totalCU += rec.cuConsumed;
    }

    const entry: HandCostEntry = {
      handNumber: this.currentHandNum,
      wallClockMs,
      mpcLatencyMs,
      txCount: this.currentHandTxs.length,
      totalFeeLamports: totalFee,
      totalCU,
      txBreakdown,
    };
    this.handEntries.push(entry);
    return entry;
  }

  /** Also record TXs we didn't send (crank-initiated: start_game, arcium_deal, settle, callbacks) */
  async scanTableTxs(tablePda: PublicKey, label: string): Promise<TxRecord[]> {
    const found: TxRecord[] = [];
    try {
      const sigs = await this.conn.getSignaturesForAddress(tablePda, { limit: 50 }, 'confirmed');
      for (const s of sigs) {
        // Skip if already recorded
        if (this.txRecords.find(r => r.sig === s.signature)) continue;
        try {
          const tx = await this.conn.getTransaction(s.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
          if (tx?.meta) {
            const rec: TxRecord = {
              sig: s.signature,
              label: `${label}:crank`,
              feeLamports: tx.meta.fee,
              cuConsumed: tx.meta.computeUnitsConsumed || 0,
              timestampMs: (tx.blockTime || 0) * 1000,
            };
            found.push(rec);
            this.currentHandTxs.push(rec);
            this.txRecords.push(rec);
          }
        } catch {}
      }
    } catch {}
    return found;
  }

  generateReport(solPriceUsd = 150): PerformanceReport {
    const hands = this.handEntries;
    const n = hands.length || 1;
    const totalCost = hands.reduce((s, h) => s + h.totalFeeLamports, 0);
    const avgCost = Math.round(totalCost / n);
    const avgSOL = avgCost / LAMPORTS_PER_SOL;
    const avgUSD = avgSOL * solPriceUsd;
    const avgMpc = Math.round(hands.reduce((s, h) => s + h.mpcLatencyMs, 0) / n);
    const avgTx = Math.round(hands.reduce((s, h) => s + h.txCount, 0) / n);
    const avgCU = Math.round(hands.reduce((s, h) => s + h.totalCU, 0) / n);
    const costs = hands.map(h => h.totalFeeLamports);

    return {
      timestamp: new Date().toISOString(),
      rpcUrl: RPC_URL,
      handsPlayed: hands.length,
      hands,
      summary: {
        avgCostLamports: avgCost,
        avgCostSOL: avgSOL,
        avgCostUSD: avgUSD,
        avgMpcLatencyMs: avgMpc,
        avgTxCount: avgTx,
        avgCU,
        maxCostLamports: Math.max(...costs, 0),
        minCostLamports: Math.min(...costs, 0),
        erThresholdExceeded: avgUSD > 0.10,
      },
    };
  }

  printReport(solPriceUsd = 150) {
    const r = this.generateReport(solPriceUsd);
    console.log('\n' + '═'.repeat(60));
    console.log('📊 PERFORMANCE REPORT — HandCostLog');
    console.log('═'.repeat(60));
    console.log(`  Hands played: ${r.handsPlayed}`);
    console.log(`  SOL price:    $${solPriceUsd} (estimate)\n`);

    for (const h of r.hands) {
      console.log(`  ── Hand #${h.handNumber} ──`);
      console.log(`     Wall clock:    ${(h.wallClockMs / 1000).toFixed(1)}s`);
      console.log(`     MPC latency:   ${(h.mpcLatencyMs / 1000).toFixed(1)}s`);
      console.log(`     TX count:      ${h.txCount}`);
      console.log(`     Total fee:     ${h.totalFeeLamports} lamports (${(h.totalFeeLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
      console.log(`     Total CU:      ${h.totalCU.toLocaleString()}`);
      console.log(`     Cost (USD):    $${((h.totalFeeLamports / LAMPORTS_PER_SOL) * solPriceUsd).toFixed(4)}`);
      if (h.txBreakdown.length > 0) {
        console.log('     Breakdown:');
        for (const t of h.txBreakdown) {
          console.log(`       ${t.label.padEnd(30)} ${t.fee.toString().padStart(7)} lam  ${t.cu.toString().padStart(8)} CU`);
        }
      }
    }

    console.log('\n  ── Summary ──');
    console.log(`     Avg cost/hand:   ${r.summary.avgCostLamports} lamports = ${r.summary.avgCostSOL.toFixed(6)} SOL = $${r.summary.avgCostUSD.toFixed(4)}`);
    console.log(`     Min cost:        ${r.summary.minCostLamports} lamports`);
    console.log(`     Max cost:        ${r.summary.maxCostLamports} lamports`);
    console.log(`     Avg MPC latency: ${(r.summary.avgMpcLatencyMs / 1000).toFixed(1)}s`);
    console.log(`     Avg TX/hand:     ${r.summary.avgTxCount}`);
    console.log(`     Avg CU/hand:     ${r.summary.avgCU.toLocaleString()}`);
    console.log(`     ER threshold:    ${r.summary.erThresholdExceeded ? '⚠️  EXCEEDED ($0.10/hand)' : '✅ BELOW $0.10/hand'}`);

    // Write JSON report
    const reportPath = path.join(__dirname, 'perf-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(r, null, 2));
    console.log(`\n  📄 Report written to: ${reportPath}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  console.log('═'.repeat(60));
  console.log('🃏 CRANK STRESS TEST — Arcium MPC Mode');
  console.log('═'.repeat(60));
  console.log('  ⚠️  First MPC deal on fresh localnet may take 5-15+ minutes');
  console.log('  ⚠️  Ensure crank-service is running in Arcium mode\n');

  // Create funded + registered players
  const players: Keypair[] = [];
  for (let i = 0; i < 8; i++) {
    const kp = Keypair.generate();
    const sig = await conn.requestAirdrop(kp.publicKey, 100 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    await ensureRegistered(conn, kp);
    players.push(kp);
  }
  console.log(`\n👥 Created ${players.length} funded players\n`);

  const creator = players[0];
  const buyIn = 100000n;
  const results: { label: string; table: string; scenario: string }[] = [];

  // ═══════════════════════════════════════════════════════
  // SCENARIO 1: HU — both idle after deal → crank timeouts
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('SCENARIO 1: HU idle — crank should timeout both players');
  console.log('━'.repeat(60));
  {
    const t = await createTable(conn, creator, 'HU-idle', 2);
    await joinAndSetKey(conn, players[1], t, 0, buyIn);
    await joinAndSetKey(conn, players[2], t, 1, buyIn);
    results.push({ label: 'HU-idle', table: t.toBase58().slice(0, 12), scenario: 'Both idle → crank deal(MPC) + timeout + settle' });
  }

  // ═══════════════════════════════════════════════════════
  // SCENARIO 2: HU — one player folds → crank settles
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('SCENARIO 2: HU fold — crank should settle after fold');
  console.log('━'.repeat(60));
  {
    const t = await createTable(conn, creator, 'HU-fold', 2);
    await joinAndSetKey(conn, players[3], t, 0, buyIn);
    await joinAndSetKey(conn, players[4], t, 1, buyIn);
    // Wait for crank to start + arcium_deal + MPC callback → Preflop
    console.log('  ⏳ Waiting for crank to start & deal (MPC)...');
    const dealt = await waitForPhase(conn, t, 3, 20 * 60 * 1000);
    if (dealt) {
      const info = await conn.getAccountInfo(t);
      const s = readTable(Buffer.from(info!.data));
      const cp = s.curPlayer;
      const folder = cp === 0 ? players[3] : players[4];
      await send(conn, actionIx(folder.publicKey, t, cp, 'Fold'), [folder], `P${cp + 1} fold`);
      results.push({ label: 'HU-fold', table: t.toBase58().slice(0, 12), scenario: 'Fold → Showdown → crank settle' });
    } else {
      console.log('  ⚠️  Crank did not deal in time — leaving for crank to handle');
      results.push({ label: 'HU-fold', table: t.toBase58().slice(0, 12), scenario: 'Waiting for crank (MPC slow?)' });
    }
  }

  // ═══════════════════════════════════════════════════════
  // SCENARIO 3: HU — player leaves in Waiting (cashout)
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('SCENARIO 3: HU leave — crank should cashout leaving player');
  console.log('━'.repeat(60));
  {
    const t = await createTable(conn, creator, 'HU-leave', 2);
    await joinAndSetKey(conn, players[5], t, 0, buyIn);
    await joinAndSetKey(conn, players[6], t, 1, buyIn);
    // Wait for hand #1 to complete (Waiting with hand >= 1)
    console.log('  ⏳ Waiting for crank to handle first hand...');
    const start = Date.now();
    let settled = false;
    while (Date.now() - start < 25 * 60 * 1000) {
      const info = await conn.getAccountInfo(t);
      if (info) {
        const s = readTable(Buffer.from(info.data));
        if (s.hand >= 1 && s.phase === 0) { settled = true; break; }
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    if (settled) {
      await send(conn, actionIx(players[6].publicKey, t, 1, 'LeaveCashGame'), [players[6]], 'P2 leave');
      results.push({ label: 'HU-leave', table: t.toBase58().slice(0, 12), scenario: 'Leave in Waiting → crank cashout' });
    } else {
      console.log('  ⚠️  Hand not settled in time');
      results.push({ label: 'HU-leave', table: t.toBase58().slice(0, 12), scenario: 'Still in progress' });
    }
  }

  // ═══════════════════════════════════════════════════════
  // SCENARIO 4: 3 HU tables at once (parallel stress)
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('SCENARIO 4: 3 parallel HU idle tables — crank handles all');
  console.log('━'.repeat(60));
  {
    const tables: PublicKey[] = [];
    for (let i = 0; i < 3; i++) {
      const p1 = Keypair.generate();
      const p2 = Keypair.generate();
      await conn.confirmTransaction(await conn.requestAirdrop(p1.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
      await conn.confirmTransaction(await conn.requestAirdrop(p2.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
      await ensureRegistered(conn, p1);
      await ensureRegistered(conn, p2);

      const t = await createTable(conn, creator, `parallel-${i}`, 2);
      await joinAndSetKey(conn, p1, t, 0, buyIn);
      await joinAndSetKey(conn, p2, t, 1, buyIn);
      tables.push(t);
    }
    for (let i = 0; i < tables.length; i++) {
      results.push({ label: `parallel-${i}`, table: tables[i].toBase58().slice(0, 12), scenario: 'Idle → crank MPC deal + timeout + settle (parallel)' });
    }
  }

  // ═══════════════════════════════════════════════════════
  // SCENARIO 5: 6-max with sit-out player (kick test)
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('SCENARIO 5: 6-max with player sitting out → crank kicks');
  console.log('━'.repeat(60));
  {
    const sixPlayers: Keypair[] = [];
    for (let i = 0; i < 3; i++) {
      const kp = Keypair.generate();
      await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
      await ensureRegistered(conn, kp);
      sixPlayers.push(kp);
    }
    const t = await createTable(conn, creator, '6max-sitout', 6);
    for (let i = 0; i < 3; i++) {
      await joinAndSetKey(conn, sixPlayers[i], t, i, buyIn);
    }
    // Wait for crank to start + deal (MPC)
    console.log('  ⏳ Waiting for crank to deal (MPC)...');
    const dealt = await waitForPhase(conn, t, 3, 20 * 60 * 1000);
    if (dealt) {
      await send(conn, actionIx(sixPlayers[2].publicKey, t, 2, 'SitOut'), [sixPlayers[2]], 'P3 sit-out');
      results.push({ label: '6max-sitout', table: t.toBase58().slice(0, 12), scenario: 'SitOut → crank eventually kicks after orbits' });
    } else {
      results.push({ label: '6max-sitout', table: t.toBase58().slice(0, 12), scenario: 'Waiting for crank to start (MPC slow?)' });
    }
  }

  // ═══════════════════════════════════════════════════════
  // SCENARIO 6: Performance Benchmark (3 complete HU hands)
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('SCENARIO 6: Performance Benchmark — 3 complete HU hands');
  console.log('━'.repeat(60));
  const perf = new PerformanceTracker(conn);
  const PERF_HANDS = 3;
  {
    // Create dedicated perf table + players
    const perfP1 = Keypair.generate();
    const perfP2 = Keypair.generate();
    for (const kp of [perfP1, perfP2]) {
      await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 100 * LAMPORTS_PER_SOL), 'confirmed');
      await ensureRegistered(conn, kp);
    }
    const perfTable = await createTable(conn, creator, 'perf-bench', 2);

    // Join + set x25519 keys (tracked)
    const sk1 = x25519.utils.randomPrivateKey();
    const pk1 = x25519.getPublicKey(sk1);
    await perf.sendTracked(joinIx(perfP1.publicKey, perfTable, 0, buyIn), [perfP1], 'join P1');
    await perf.sendTracked(setX25519KeyIx(perfP1.publicKey, perfTable, getSeat(perfTable, 0), pk1), [perfP1], 'set_x25519 P1');

    const sk2 = x25519.utils.randomPrivateKey();
    const pk2 = x25519.getPublicKey(sk2);
    await perf.sendTracked(joinIx(perfP2.publicKey, perfTable, 1, buyIn), [perfP2], 'join P2');
    await perf.sendTracked(setX25519KeyIx(perfP2.publicKey, perfTable, getSeat(perfTable, 1), pk2), [perfP2], 'set_x25519 P2');

    results.push({ label: 'perf-bench', table: perfTable.toBase58().slice(0, 12), scenario: `${PERF_HANDS} hands, full cost tracking` });

    for (let hand = 1; hand <= PERF_HANDS; hand++) {
      console.log(`\n  ── Perf Hand #${hand} ──`);
      perf.startHand(hand);

      // Wait for crank to start_game + arcium_deal → Preflop
      console.log('    ⏳ Waiting for crank to deal (MPC)...');
      perf.markMpcStart();
      const dealTimeout = hand === 1 ? 20 * 60 * 1000 : 5 * 60 * 1000; // first hand may take longer
      const dealStart = Date.now();
      let dealt = false;
      while (Date.now() - dealStart < dealTimeout) {
        const info = await conn.getAccountInfo(perfTable);
        if (info) {
          const phase = Buffer.from(info.data)[T.PHASE];
          if (phase >= 3 && phase <= 12 && phase !== 9) { dealt = true; break; } // any playable phase
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      if (!dealt) {
        console.log('    ⚠️  Crank did not deal — skipping remaining hands');
        // Scan crank TXs we didn't send before finishing
        await perf.scanTableTxs(perfTable, `hand${hand}`);
        await perf.finishHand();
        break;
      }
      perf.markMpcEnd();
      const mpcSec = ((Date.now() - dealStart) / 1000).toFixed(1);
      console.log(`    ✅ Dealt in ${mpcSec}s`);

      // Play: check/call through all streets until Complete or Waiting
      let handDone = false;
      const actionTimeout = 5 * 60 * 1000;
      const actionStart = Date.now();
      while (!handDone && Date.now() - actionStart < actionTimeout) {
        const info = await conn.getAccountInfo(perfTable);
        if (!info) { await new Promise(r => setTimeout(r, 1000)); continue; }
        const d = Buffer.from(info.data);
        const phase = d[T.PHASE];
        const cp = d[T.CUR_PLAYER];

        if (phase === 9 || phase === 0) { // Complete or Waiting
          handDone = true;
          break;
        }

        // MPC reveal pending — wait for callback
        if (phase === 10 || phase === 11 || phase === 12 || phase === 2 || phase === 8) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        // Showdown — wait for crank settle
        if (phase === 7) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        // Playable phase (3=Preflop, 4=Flop, 5=Turn, 6=River)
        if (phase >= 3 && phase <= 6) {
          const actor = cp === 0 ? perfP1 : perfP2;
          // Check if we can check or must call
          const pot = Number(d.readBigUInt64LE(T.POT));
          const minBet = Number(d.readBigUInt64LE(T.MIN_BET));

          // Try check first, fallback to call
          let action = minBet > 0 ? 'Call' : 'Check';
          const sig = await perf.sendTracked(
            actionIx(actor.publicKey, perfTable, cp, action),
            [actor],
            `hand${hand}:${action} P${cp + 1} (${PHASE_NAMES[phase]})`,
          );
          if (!sig) {
            // If check failed, try call; if call failed, try fold
            const fallback = action === 'Check' ? 'Call' : 'Fold';
            await perf.sendTracked(
              actionIx(actor.publicKey, perfTable, cp, fallback),
              [actor],
              `hand${hand}:${fallback} P${cp + 1} (fallback)`,
            );
          }
          await new Promise(r => setTimeout(r, 500));
        } else {
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      // Wait for settle to complete (phase → Waiting or Complete)
      const settleStart = Date.now();
      while (Date.now() - settleStart < 30_000) {
        const info = await conn.getAccountInfo(perfTable);
        if (info) {
          const s = readTable(Buffer.from(info.data));
          if (s.phase === 0 && s.hand >= hand) break; // Waiting, hand advanced
          if (s.phase === 9) { await new Promise(r => setTimeout(r, 2000)); continue; } // Complete → wait for crank
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      // Scan ALL TXs on this table (captures crank-initiated: start_game, arcium_deal, callbacks, settle)
      await perf.scanTableTxs(perfTable, `hand${hand}`);

      const entry = await perf.finishHand();
      console.log(`    📊 Hand #${hand}: ${entry.txCount} TXs, ${entry.totalFeeLamports} lam, ${(entry.wallClockMs / 1000).toFixed(1)}s, MPC ${(entry.mpcLatencyMs / 1000).toFixed(1)}s`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // SUMMARY + MONITOR
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('📊 STRESS TEST SCENARIOS CREATED');
  console.log('═'.repeat(60));
  for (const r of results) {
    console.log(`  ${r.label.padEnd(15)} ${r.table}  ${r.scenario}`);
  }
  console.log(`\n  Total: ${results.length} tables — crank should process all autonomously`);
  console.log('  Monitor crank output for timeout/settle/cashout/kick actions\n');

  // Monitor for 120s (longer for MPC)
  console.log('⏳ Monitoring table states for 120 seconds...\n');
  const allTables = results.map(r => r.table);
  for (let tick = 0; tick < 24; tick++) {
    await new Promise(r => setTimeout(r, 5000));
    const accs = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 437 }] });
    let active = 0;
    let waiting = 0;
    for (const { pubkey, account } of accs) {
      const key = pubkey.toBase58().slice(0, 12);
      if (!allTables.includes(key)) continue;
      const d = Buffer.from(account.data);
      const s = readTable(d);
      const pName = PHASE_NAMES[s.phase] ?? s.phase;
      if (s.phase !== 0) active++;
      else waiting++;
    }
    console.log(`  [${tick * 5 + 5}s] Active: ${active}, Waiting: ${waiting}/${results.length}`);
    if (active === 0 && waiting === results.length) {
      console.log('  ✅ All tables returned to Waiting — crank handled everything!');
      break;
    }
  }

  // Print performance report
  perf.printReport();

  console.log('\n✅ Stress test complete');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
