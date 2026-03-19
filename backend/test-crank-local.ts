/**
 * Comprehensive E2E Crank + Table Test Suite (LOCAL_MODE)
 *
 * Tests the full poker game lifecycle against a local Solana validator
 * with mock deals. Covers every phase transition, edge cases, and
 * potential stall conditions.
 *
 * Prerequisites:
 *   1. Local validator running with programs deployed
 *   2. Steel pool initialized (run localnet-bootstrap.ts first)
 *
 * Usage:
 *   npx ts-node --transpile-only test-crank-local.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
  SystemProgram, LAMPORTS_PER_SOL, SYSVAR_SLOT_HASHES_PUBKEY,
} from '@solana/web3.js';
import * as crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const PROGRAM_ID = new PublicKey(process.env.FASTPOKER_PROGRAM_ID || 'BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

const IX = {
  register_player: disc('register_player'),
  create_table: disc('create_table'),
  init_table_seat: disc('init_table_seat'),
  join_table: disc('join_table'),
  start_game: disc('start_game'),
  devnet_bypass_deal: disc('devnet_bypass_deal'),
  devnet_bypass_reveal: disc('devnet_bypass_reveal'),
  player_action: disc('player_action'),
  settle_hand: disc('settle_hand'),
  handle_timeout: disc('handle_timeout'),
};

// PDA helpers
function pda(seeds: Buffer[], prog = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, prog)[0];
}
const getTable = (id: Buffer) => pda([Buffer.from('table'), id]);
const getSeat = (t: PublicKey, i: number) => pda([Buffer.from('seat'), t.toBuffer(), Buffer.from([i])]);
const getSeatCards = (t: PublicKey, i: number) => pda([Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])]);
const getDeckState = (t: PublicKey) => pda([Buffer.from('deck_state'), t.toBuffer()]);
const getVault = (t: PublicKey) => pda([Buffer.from('vault'), t.toBuffer()]);
const getReceipt = (t: PublicKey, i: number) => pda([Buffer.from('receipt'), t.toBuffer(), Buffer.from([i])]);
const getCrankEr = (t: PublicKey) => pda([Buffer.from('crank_tally_er'), t.toBuffer()]);
const getCrankL1 = (t: PublicKey) => pda([Buffer.from('crank_tally_l1'), t.toBuffer()]);
const getPlayer = (w: PublicKey) => pda([Buffer.from('player'), w.toBuffer()]);
const getMarker = (w: PublicKey, t: PublicKey) => pda([Buffer.from('player_table'), w.toBuffer(), t.toBuffer()]);
const getPool = () => pda([Buffer.from('pool')], STEEL_PROGRAM_ID);
const getUnrefined = (w: PublicKey) => pda([Buffer.from('unrefined'), w.toBuffer()], STEEL_PROGRAM_ID);

// Table byte offsets (verified against e2e-mock-streets.ts + Rust struct)
const T = {
  PHASE: 160, CUR_PLAYER: 161, POT: 131, MIN_BET: 139,
  OCC: 250, ALLIN: 252, FOLDED: 254,
  SB_SEAT: 164, BB_SEAT: 165, BUTTON: 163,
  SB_AMT: 105, BB_AMT: 113, MAX_P: 121, CUR_P: 122,
  HAND: 123, GAME_TYPE: 104, ACTION_NONCE: 435,
};

// Phase enum (matches Rust GamePhase order)
const Phase = {
  Waiting: 0, Starting: 1, AwaitingDeal: 2, Preflop: 3, Flop: 4,
  Turn: 5, River: 6, Showdown: 7, AwaitingShowdown: 8, Complete: 9,
  FlopRevealPending: 10, TurnRevealPending: 11, RiverRevealPending: 12,
} as const;

const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop', 4: 'Flop',
  5: 'Turn', 6: 'River', 7: 'Showdown', 8: 'AwaitingShowdown', 9: 'Complete',
  10: 'FlopRevealPending', 11: 'TurnRevealPending', 12: 'RiverRevealPending',
};

// Seat byte offsets (disc=8, wallet=32, session=32, table=32, chips(8)@104, bet(8)@112, total(8)@120, ..., seat_num(1)@226, status(1)@227)
const S = { CHIPS: 104, STATUS: 227, SEAT_NUM: 226 };

// PokerAction serialization (Anchor enum)
function serializeAction(action: string, amount?: bigint): Buffer {
  switch (action) {
    case 'Fold': return Buffer.from([0]);
    case 'Check': return Buffer.from([1]);
    case 'Call': return Buffer.from([2]);
    case 'Bet': { const b = Buffer.alloc(9); b[0] = 3; b.writeBigUInt64LE(amount || 0n, 1); return b; }
    case 'Raise': { const b = Buffer.alloc(9); b[0] = 4; b.writeBigUInt64LE(amount || 0n, 1); return b; }
    case 'AllIn': return Buffer.from([5]);
    case 'SitOut': return Buffer.from([6]);
    case 'ReturnToPlay': return Buffer.from([7]);
    case 'LeaveCashGame': return Buffer.from([8]);
    default: throw new Error(`Unknown action: ${action}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// TX HELPERS
// ═══════════════════════════════════════════════════════════════════

async function send(
  conn: Connection,
  ix: TransactionInstruction,
  signers: Keypair[],
  label: string,
): Promise<boolean> {
  try {
    const sig = await sendAndConfirmTransaction(
      conn, new Transaction().add(ix), signers,
      { commitment: 'confirmed', skipPreflight: true },
    );
    console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
    return true;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0, 200)}`);
    if (e.logs) e.logs.slice(-5).forEach((l: string) => console.log(`     ${l}`));
    return false;
  }
}

function readTable(data: Buffer | Uint8Array) {
  const d = Buffer.from(data);
  return {
    phase: d[T.PHASE],
    curPlayer: d[T.CUR_PLAYER],
    pot: Number(d.readBigUInt64LE(T.POT)),
    minBet: Number(d.readBigUInt64LE(T.MIN_BET)),
    occ: d.readUInt16LE(T.OCC),
    allin: d.readUInt16LE(T.ALLIN),
    folded: d.readUInt16LE(T.FOLDED),
    maxP: d[T.MAX_P],
    curP: d[T.CUR_P],
    hand: Number(d.readBigUInt64LE(T.HAND)),
    nonce: d.readUInt16LE(T.ACTION_NONCE),
    gameType: d[T.GAME_TYPE],
  };
}

async function tbl(conn: Connection, t: PublicKey) {
  const info = await conn.getAccountInfo(t);
  if (!info) throw new Error(`Table not found: ${t.toBase58()}`);
  return readTable(info.data);
}

async function seatChips(conn: Connection, t: PublicKey, i: number): Promise<number> {
  const info = await conn.getAccountInfo(getSeat(t, i));
  if (!info) return 0;
  return Number(Buffer.from(info.data).readBigUInt64LE(S.CHIPS));
}

async function seatStatus(conn: Connection, t: PublicKey, i: number): Promise<number> {
  const info = await conn.getAccountInfo(getSeat(t, i));
  if (!info) return 0;
  return Buffer.from(info.data)[S.STATUS];
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function airdrop(conn: Connection, pk: PublicKey, amount: number) {
  const sig = await conn.requestAirdrop(pk, amount);
  await conn.confirmTransaction(sig, 'confirmed');
}

// ═══════════════════════════════════════════════════════════════════
// INSTRUCTION HELPERS (matching e2e-mock-streets.ts proven patterns)
// ═══════════════════════════════════════════════════════════════════

function joinIx(player: PublicKey, tbl: PublicKey, seat: number, buyIn: bigint): TransactionInstruction {
  // data: disc(8) + buy_in(u64=8) + seat_number(u8=1) + reserve(u64=8) = 25 bytes
  const d = Buffer.alloc(25); IX.join_table.copy(d); d.writeBigUInt64LE(buyIn, 8); d[16] = seat;
  return new TransactionInstruction({
    programId: PROGRAM_ID, keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: getPlayer(player), isSigner: false, isWritable: true },
      { pubkey: tbl, isSigner: false, isWritable: true },
      { pubkey: getSeat(tbl, seat), isSigner: false, isWritable: true },
      { pubkey: getMarker(player, tbl), isSigner: false, isWritable: true },
      { pubkey: getVault(tbl), isSigner: false, isWritable: true },
      { pubkey: getReceipt(tbl, seat), isSigner: false, isWritable: true },
      // 6 optional accounts (treasury, pool, player_token, table_token, unclaimed, token_program) → sentinel
      ...Array(6).fill({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false }),
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data: d,
  });
}

function startIx(initiator: PublicKey, tbl: PublicKey, occ: number, maxP: number): TransactionInstruction {
  const keys = [
    { pubkey: initiator, isSigner: false, isWritable: false },
    { pubkey: tbl, isSigner: false, isWritable: true },
    { pubkey: getDeckState(tbl), isSigner: false, isWritable: true },
  ];
  for (let i = 0; i < maxP; i++) if (occ & (1 << i)) keys.push({ pubkey: getSeat(tbl, i), isSigner: false, isWritable: true });
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: IX.start_game });
}

function dealIx(caller: PublicKey, tbl: PublicKey, occ: number, maxP: number): TransactionInstruction {
  const keys = [
    { pubkey: caller, isSigner: true, isWritable: false },
    { pubkey: tbl, isSigner: false, isWritable: true },
    { pubkey: getDeckState(tbl), isSigner: false, isWritable: true },
    { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
  ];
  // remaining: [seats..., seat_cards...]
  for (let i = 0; i < maxP; i++) if (occ & (1 << i)) keys.push({ pubkey: getSeat(tbl, i), isSigner: false, isWritable: true });
  for (let i = 0; i < maxP; i++) if (occ & (1 << i)) keys.push({ pubkey: getSeatCards(tbl, i), isSigner: false, isWritable: true });
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: IX.devnet_bypass_deal });
}

function revealIx(caller: PublicKey, tbl: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID, keys: [
      { pubkey: caller, isSigner: true, isWritable: false },
      { pubkey: tbl, isSigner: false, isWritable: true },
    ], data: IX.devnet_bypass_reveal,
  });
}

function settleIx(settler: PublicKey, tbl: PublicKey, occ: number, maxP: number): TransactionInstruction {
  const keys = [
    { pubkey: settler, isSigner: false, isWritable: false },
    { pubkey: tbl, isSigner: false, isWritable: true },
    { pubkey: getDeckState(tbl), isSigner: false, isWritable: true },
  ];
  for (let i = 0; i < maxP; i++) if (occ & (1 << i)) keys.push({ pubkey: getSeat(tbl, i), isSigner: false, isWritable: true });
  for (let i = 0; i < maxP; i++) if (occ & (1 << i)) keys.push({ pubkey: getSeatCards(tbl, i), isSigner: false, isWritable: true });
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: IX.settle_hand });
}

function actionIx(player: PublicKey, tbl: PublicKey, seat: number, action: string, amount?: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID, keys: [
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: tbl, isSigner: false, isWritable: true },
      { pubkey: getSeat(tbl, seat), isSigner: false, isWritable: true },
      // Option<Account> sentinel for session_token
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
    ], data: Buffer.concat([IX.player_action, serializeAction(action, amount)]),
  });
}

// ═══════════════════════════════════════════════════════════════════
// TEST RUNNER
// ═══════════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(condition: boolean, msg: string) {
  if (!condition) { failed++; failures.push(msg); console.log(`  ✗ FAIL: ${msg}`); }
  else { passed++; console.log(`  ✓ ${msg}`); }
}

// ═══════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  console.log('═'.repeat(60));
  console.log('  CRANK LOCAL E2E TEST SUITE');
  console.log('═'.repeat(60));
  console.log(`  RPC: ${RPC_URL}`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);

  try { const slot = await conn.getSlot(); console.log(`  Slot: ${slot}`); }
  catch { console.error('Cannot connect to local validator.'); process.exit(1); }

  const pool = getPool();
  // Verify Steel pool exists
  const poolInfo = await conn.getAccountInfo(pool);
  if (!poolInfo) { console.error('Steel pool not initialized. Run localnet-bootstrap.ts first.'); process.exit(1); }
  console.log(`  Pool: ${pool.toBase58().slice(0, 12)}..`);

  // Fresh keypairs
  const admin = Keypair.generate();
  const p1 = Keypair.generate();
  const p2 = Keypair.generate();
  const p3 = Keypair.generate();
  const ck = Keypair.generate(); // crank caller

  console.log('\n  Funding wallets...');
  for (const kp of [admin, p1, p2, p3, ck]) await airdrop(conn, kp.publicKey, 10 * LAMPORTS_PER_SOL);
  try { await airdrop(conn, TREASURY, 1 * LAMPORTS_PER_SOL); } catch {}

  // Register players
  console.log('  Registering players...');
  for (const kp of [p1, p2, p3]) {
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: kp.publicKey, isSigner: true, isWritable: true },
        { pubkey: getPlayer(kp.publicKey), isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: getUnrefined(kp.publicKey), isSigner: false, isWritable: true },
        { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: IX.register_player,
    }), [kp], 'register');
  }

  // ─── Helper: create a fresh cash game table ───
  async function makeTable(label: string, maxP: number): Promise<PublicKey> {
    const tableId = crypto.randomBytes(32);
    const t = getTable(tableId);
    const cfg = Buffer.alloc(36); tableId.copy(cfg); cfg[32] = 3; cfg[34] = maxP; // CashGame
    if (!await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: Buffer.concat([IX.create_table, cfg]),
    }), [admin], `create(${label})`)) throw new Error('create failed');

    for (let i = 0; i < maxP; i++) await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: t, isSigner: false, isWritable: false },
        { pubkey: getSeat(t, i), isSigner: false, isWritable: true },
        { pubkey: getSeatCards(t, i), isSigner: false, isWritable: true },
        { pubkey: getDeckState(t), isSigner: false, isWritable: true },
        { pubkey: getReceipt(t, i), isSigner: false, isWritable: true },
        { pubkey: getVault(t), isSigner: false, isWritable: true },
        { pubkey: getCrankEr(t), isSigner: false, isWritable: true },
        { pubkey: getCrankL1(t), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: Buffer.concat([IX.init_table_seat, Buffer.from([i])]),
    }), [admin], `seat${i}`);
    return t;
  }

  // Helper: start + deal
  async function startAndDeal(t: PublicKey) {
    let s = await tbl(conn, t);
    await send(conn, startIx(ck.publicKey, t, s.occ, s.maxP), [ck], 'start');
    s = await tbl(conn, t);
    await send(conn, dealIx(ck.publicKey, t, s.occ, s.maxP), [ck], 'deal');
  }

  // Helper: reveal + settle loop
  async function finishHand(t: PublicKey) {
    let s = await tbl(conn, t);
    let guard = 0;
    while (s.phase >= Phase.FlopRevealPending && s.phase <= Phase.RiverRevealPending && guard++ < 5) {
      await send(conn, revealIx(ck.publicKey, t), [ck], `reveal(${PHASE_NAMES[s.phase]})`);
      s = await tbl(conn, t);
    }
    if (s.phase === Phase.Showdown) {
      await send(conn, settleIx(ck.publicKey, t, s.occ, s.maxP), [ck], 'settle');
    }
  }

  // player lookup by seat
  function playerBySeat(seat: number): Keypair {
    if (seat === 0) return p1;
    if (seat === 1 || seat === 2) return p2;
    return p3;
  }

  // ══════════════════════════════════════════════════════════════════
  // TEST 1: Full HU hand — fold preflop
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 1: Full HU hand — fold preflop');
  console.log('━'.repeat(60));
  {
    const t = await makeTable('HU-fold', 2);
    const buyIn = 100000n;
    ok(await send(conn, joinIx(p1.publicKey, t, 0, buyIn), [p1], 'join0'), 'P1 joined');
    ok(await send(conn, joinIx(p2.publicKey, t, 1, buyIn), [p2], 'join1'), 'P2 joined');

    let s = await tbl(conn, t);
    ok(s.phase === Phase.Waiting, `Phase=Waiting (got ${PHASE_NAMES[s.phase]})`);
    ok(s.curP === 2, `curP=2 (got ${s.curP})`);

    await startAndDeal(t);
    s = await tbl(conn, t);
    ok(s.phase === Phase.Preflop, `Phase=Preflop (got ${PHASE_NAMES[s.phase]})`);
    ok(s.pot > 0, `pot>0 (got ${s.pot})`);

    // Current player folds
    const cp = s.curPlayer;
    const folder = cp === 0 ? p1 : p2;
    ok(await send(conn, actionIx(folder.publicKey, t, cp, 'Fold'), [folder], `fold(${cp})`), 'fold ok');

    s = await tbl(conn, t);
    ok(s.phase === Phase.Showdown, `Phase=Showdown (got ${PHASE_NAMES[s.phase]})`);

    await send(conn, settleIx(ck.publicKey, t, s.occ, s.maxP), [ck], 'settle');
    s = await tbl(conn, t);
    ok(s.phase === Phase.Waiting, `Phase=Waiting after settle (got ${PHASE_NAMES[s.phase]})`);
    ok(s.hand === 1, `hand=1 (got ${s.hand})`);

    const c0 = await seatChips(conn, t, 0);
    const c1 = await seatChips(conn, t, 1);
    // Rake takes up to 5% so chips may be less than 2*buyIn
    ok(c0 + c1 > 0 && c0 + c1 <= Number(buyIn) * 2, `Chip conservation: ${c0 + c1} <= ${Number(buyIn) * 2}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // TEST 2: Full hand to river with reveals
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 2: Full hand to river — call/check all streets');
  console.log('━'.repeat(60));
  {
    const t = await makeTable('HU-river', 2);
    const buyIn = 100000n;
    await send(conn, joinIx(p1.publicKey, t, 0, buyIn), [p1], 'join0');
    await send(conn, joinIx(p2.publicKey, t, 1, buyIn), [p2], 'join1');
    await startAndDeal(t);

    // HU preflop: SB (seat 0) calls, BB (seat 1) checks
    let s = await tbl(conn, t);
    // SB acts first in HU preflop
    const sbSeat = s.curPlayer;
    const sbActor = sbSeat === 0 ? p1 : p2;
    await send(conn, actionIx(sbActor.publicKey, t, sbSeat, 'Call'), [sbActor], 'Preflop:Call(SB)');
    s = await tbl(conn, t);
    if (s.phase !== Phase.Showdown && s.phase < Phase.FlopRevealPending) {
      const bbSeat = s.curPlayer;
      const bbActor = bbSeat === 0 ? p1 : p2;
      await send(conn, actionIx(bbActor.publicKey, t, bbSeat, 'Check'), [bbActor], 'Preflop:Check(BB)');
    }

    // Flop reveal + check-check
    s = await tbl(conn, t);
    if (s.phase >= Phase.FlopRevealPending && s.phase <= Phase.RiverRevealPending) {
      await send(conn, revealIx(ck.publicKey, t), [ck], `reveal(${PHASE_NAMES[s.phase]})`);
    }
    for (let r = 0; r < 2; r++) {
      s = await tbl(conn, t);
      if (s.phase === Phase.Showdown || s.phase >= Phase.FlopRevealPending) break;
      const cp = s.curPlayer; if (cp === 255) break;
      await send(conn, actionIx((cp === 0 ? p1 : p2).publicKey, t, cp, 'Check'), [cp === 0 ? p1 : p2], `Flop:Check(${cp})`);
    }

    // Turn reveal + check-check
    s = await tbl(conn, t);
    if (s.phase >= Phase.FlopRevealPending && s.phase <= Phase.RiverRevealPending) {
      await send(conn, revealIx(ck.publicKey, t), [ck], `reveal(${PHASE_NAMES[s.phase]})`);
    }
    for (let r = 0; r < 2; r++) {
      s = await tbl(conn, t);
      if (s.phase === Phase.Showdown || s.phase >= Phase.FlopRevealPending) break;
      const cp = s.curPlayer; if (cp === 255) break;
      await send(conn, actionIx((cp === 0 ? p1 : p2).publicKey, t, cp, 'Check'), [cp === 0 ? p1 : p2], `Turn:Check(${cp})`);
    }

    // River reveal + check-check
    s = await tbl(conn, t);
    if (s.phase >= Phase.FlopRevealPending && s.phase <= Phase.RiverRevealPending) {
      await send(conn, revealIx(ck.publicKey, t), [ck], `reveal(${PHASE_NAMES[s.phase]})`);
    }
    for (let r = 0; r < 2; r++) {
      s = await tbl(conn, t);
      if (s.phase === Phase.Showdown || s.phase >= Phase.FlopRevealPending) break;
      const cp = s.curPlayer; if (cp === 255) break;
      await send(conn, actionIx((cp === 0 ? p1 : p2).publicKey, t, cp, 'Check'), [cp === 0 ? p1 : p2], `River:Check(${cp})`);
    }

    await finishHand(t);
    s = await tbl(conn, t);
    ok(s.phase === Phase.Waiting, `Phase=Waiting (got ${PHASE_NAMES[s.phase]})`);
    ok(s.hand >= 1, `hand>=1 (got ${s.hand})`);
    const c0 = await seatChips(conn, t, 0);
    const c1 = await seatChips(conn, t, 1);
    // Rake may reduce total chips
    ok(c0 + c1 > 0 && c0 + c1 <= Number(buyIn) * 2, `Chip conservation: ${c0 + c1}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // TEST 3: Leave cash game during Waiting
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 3: Leave cash game during Waiting phase');
  console.log('━'.repeat(60));
  {
    const t = await makeTable('HU-leave-wait', 2);
    await send(conn, joinIx(p1.publicKey, t, 0, 100000n), [p1], 'join0');
    await send(conn, joinIx(p2.publicKey, t, 1, 100000n), [p2], 'join1');

    ok(await send(conn, actionIx(p2.publicKey, t, 1, 'LeaveCashGame'), [p2], 'leave'), 'Leave ok');

    const s = await tbl(conn, t);
    ok(s.curP === 1, `curP=1 (got ${s.curP})`);
    const st = await seatStatus(conn, t, 1);
    ok(st === 6, `seat1 status=Leaving(6) (got ${st})`);
  }

  // ══════════════════════════════════════════════════════════════════
  // TEST 4: Leave cash game mid-hand (non-current player)
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 4: Leave mid-hand (non-current player)');
  console.log('━'.repeat(60));
  {
    const t = await makeTable('HU-leave-mid', 2);
    await send(conn, joinIx(p1.publicKey, t, 0, 100000n), [p1], 'join0');
    await send(conn, joinIx(p2.publicKey, t, 1, 100000n), [p2], 'join1');
    await startAndDeal(t);

    let s = await tbl(conn, t);
    ok(s.phase === Phase.Preflop, `Phase=Preflop`);

    const nc = s.curPlayer === 0 ? 1 : 0;
    const leaver = nc === 0 ? p1 : p2;
    ok(await send(conn, actionIx(leaver.publicKey, t, nc, 'LeaveCashGame'), [leaver], `leave(${nc})`), 'Leave ok');

    s = await tbl(conn, t);
    ok((s.folded & (1 << nc)) !== 0, `seat${nc} folded in bitmask`);
    // LeaveCashGame folds the non-current player. On-chain advance_action detects
    // only 1 active player and should transition to Showdown automatically.
    // If still in a playable phase, the remaining player acts to trigger advance.
    if (s.phase !== Phase.Showdown && s.phase < Phase.FlopRevealPending) {
      const cp2 = s.curPlayer;
      const actor2 = cp2 === 0 ? p1 : p2;
      // Try Call first (SB may still owe to match BB), then Fold as fallback
      const callOk = await send(conn, actionIx(actor2.publicKey, t, cp2, 'Call'), [actor2], `call(${cp2})`);
      if (!callOk) {
        await send(conn, actionIx(actor2.publicKey, t, cp2, 'Fold'), [actor2], `fold(${cp2})`);
      }
      s = await tbl(conn, t);
    }
    // After the remaining player acts, hand should end
    await finishHand(t);
    s = await tbl(conn, t);
    ok(s.phase === Phase.Showdown || s.phase === Phase.Waiting, `Phase=Showdown|Waiting (got ${PHASE_NAMES[s.phase]})`);
  }

  // ══════════════════════════════════════════════════════════════════
  // TEST 5: SitOut + ReturnToPlay during Waiting
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 5: SitOut + ReturnToPlay during Waiting');
  console.log('━'.repeat(60));
  {
    const t = await makeTable('HU-sitout', 2);
    await send(conn, joinIx(p1.publicKey, t, 0, 100000n), [p1], 'join0');
    await send(conn, joinIx(p2.publicKey, t, 1, 100000n), [p2], 'join1');

    ok(await send(conn, actionIx(p2.publicKey, t, 1, 'SitOut'), [p2], 'sitout'), 'SitOut ok');
    let st1 = await seatStatus(conn, t, 1);
    ok(st1 === 4, `seat1=SittingOut(4) (got ${st1})`);

    ok(await send(conn, actionIx(p2.publicKey, t, 1, 'ReturnToPlay'), [p2], 'return'), 'Return ok');
    st1 = await seatStatus(conn, t, 1);
    ok(st1 === 1, `seat1=Active(1) (got ${st1})`);
  }

  // ══════════════════════════════════════════════════════════════════
  // TEST 6: All-in hand (both players)
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 6: All-in preflop');
  console.log('━'.repeat(60));
  {
    const t = await makeTable('HU-allin', 2);
    const buyIn = 100000n;
    await send(conn, joinIx(p1.publicKey, t, 0, buyIn), [p1], 'join0');
    await send(conn, joinIx(p2.publicKey, t, 1, buyIn), [p2], 'join1');
    await startAndDeal(t);

    let s = await tbl(conn, t);
    ok(s.phase === Phase.Preflop, 'Phase=Preflop');

    // First player all-in
    const cp1 = s.curPlayer;
    ok(await send(conn, actionIx((cp1 === 0 ? p1 : p2).publicKey, t, cp1, 'AllIn'), [cp1 === 0 ? p1 : p2], `allin(${cp1})`), 'AllIn ok');

    s = await tbl(conn, t);
    if (s.phase !== Phase.Showdown) {
      const cp2 = s.curPlayer;
      ok(await send(conn, actionIx((cp2 === 0 ? p1 : p2).publicKey, t, cp2, 'Call'), [cp2 === 0 ? p1 : p2], `call(${cp2})`), 'Call ok');
    }

    console.log(`  Phase after all-in: ${PHASE_NAMES[(await tbl(conn, t)).phase]}`);
    await finishHand(t);

    s = await tbl(conn, t);
    ok(s.phase === Phase.Waiting, `Phase=Waiting (got ${PHASE_NAMES[s.phase]})`);

    const c0 = await seatChips(conn, t, 0);
    const c1 = await seatChips(conn, t, 1);
    ok(c0 + c1 <= Number(buyIn) * 2, `chips<=2*buyIn (${c0 + c1})`);
    ok(c0 + c1 > 0, `chips>0 (${c0 + c1})`);
    console.log(`  seat0=${c0} seat1=${c1} total=${c0 + c1}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // TEST 7: Multiple consecutive hands
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 7: 3 consecutive hands');
  console.log('━'.repeat(60));
  {
    const t = await makeTable('HU-multi', 2);
    // Max buy-in = 100 BB = 100,000 with default blinds (SB=500, BB=1000)
    await send(conn, joinIx(p1.publicKey, t, 0, 100000n), [p1], 'join0');
    await send(conn, joinIx(p2.publicKey, t, 1, 100000n), [p2], 'join1');

    for (let h = 0; h < 3; h++) {
      let s = await tbl(conn, t);
      ok(s.phase === Phase.Waiting, `h${h}: Waiting`);
      ok(s.hand === h, `h${h}: hand=${h} (got ${s.hand})`);

      await startAndDeal(t);
      s = await tbl(conn, t);
      const cp = s.curPlayer;
      await send(conn, actionIx((cp === 0 ? p1 : p2).publicKey, t, cp, 'Fold'), [cp === 0 ? p1 : p2], `h${h}:fold(${cp})`);
      await finishHand(t);
    }

    const s = await tbl(conn, t);
    ok(s.hand === 3, `hand=3 (got ${s.hand})`);
    ok(s.phase === Phase.Waiting, 'Final=Waiting');
  }

  // ══════════════════════════════════════════════════════════════════
  // TEST 8: 6-max table (3 players)
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 8: 6-max table — 3 players, fold through');
  console.log('━'.repeat(60));
  {
    const t = await makeTable('6max', 6);
    await send(conn, joinIx(p1.publicKey, t, 0, 100000n), [p1], 'join0');
    await send(conn, joinIx(p2.publicKey, t, 2, 100000n), [p2], 'join2');
    await send(conn, joinIx(p3.publicKey, t, 4, 100000n), [p3], 'join4');

    let s = await tbl(conn, t);
    ok(s.curP === 3, `curP=3 (got ${s.curP})`);

    await startAndDeal(t);
    s = await tbl(conn, t);
    ok(s.phase === Phase.Preflop, 'Phase=Preflop');
    ok(s.pot > 0, `pot>0 (${s.pot})`);

    // Fold 2 players
    for (let f = 0; f < 2; f++) {
      s = await tbl(conn, t);
      if (s.phase === Phase.Showdown) break;
      const cp = s.curPlayer;
      const actor = cp === 0 ? p1 : cp === 2 ? p2 : p3;
      await send(conn, actionIx(actor.publicKey, t, cp, 'Fold'), [actor], `fold(${cp})`);
    }

    await finishHand(t);
    s = await tbl(conn, t);
    ok(s.phase === Phase.Waiting, `Phase=Waiting (got ${PHASE_NAMES[s.phase]})`);
  }

  // ══════════════════════════════════════════════════════════════════
  // RESULTS
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailed:');
    failures.forEach(f => console.log(`  ✗ ${f}`));
  }
  console.log('═'.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
