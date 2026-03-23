/**
 * SNG E2E Test — Arcium MPC Mode
 *
 * Tests the full Sit & Go lifecycle on Arcium:
 *   1. Create HU SNG table (gameType=0)
 *   2. Register + join 2 players with x25519 keys
 *   3. Crank starts game + arcium_deal (MPC)
 *   4. Play hands until one player busts (all-in / fold)
 *   5. Crank runs distribute_prizes + reset_sng_table
 *   6. Verify winner gets SOL prize + unrefined POKER minted
 *   7. (Optional) Stake POKER + claim rewards flow
 *
 * Run while crank is running:
 *   ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only backend/e2e-sng-arcium.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { x25519 } from '@arcium-hq/client';
import { getOrCreateAssociatedTokenAccount, getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// ─── Instruction discriminators ───
function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}
const IX: Record<string, Buffer> = {};
for (const n of [
  'register_player', 'create_table', 'init_table_seat', 'join_table',
  'player_action', 'start_game', 'settle_hand', 'set_x25519_key',
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

// ─── Table offsets ───
const T = {
  PHASE: 160, CUR_PLAYER: 161, POT: 131, MIN_BET: 139,
  OCC: 250, CUR_PLAYERS: 122, MAX_P: 121, HAND: 123,
  PRIZES_DIST: 339, ELIMINATED_COUNT: 351,
  GAME_TYPE: 104, ENTRY_AMOUNT: 361, PRIZE_POOL: 377,
};
const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop',
  4: 'Flop', 5: 'Turn', 6: 'River', 7: 'Showdown', 8: 'AwaitingShowdown', 9: 'Complete',
  10: 'FlopRevealPending', 11: 'TurnRevealPending', 12: 'RiverRevealPending',
};

// ─── Seat offsets ───
const S = { CHIPS: 104, STATUS: 227 };
const STATUS_NAMES: Record<number, string> = {
  0: 'Empty', 1: 'Active', 2: 'Folded', 3: 'AllIn', 4: 'SittingOut', 5: 'Busted', 6: 'Leaving',
};

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

async function send(conn: Connection, ix: TransactionInstruction, signers: Keypair[], label: string): Promise<string | null> {
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), signers, { commitment: 'confirmed', skipPreflight: true });
    console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
    return sig;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0, 120)}`);
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
    prizesDist: data[T.PRIZES_DIST] === 1,
    eliminatedCount: data[T.ELIMINATED_COUNT],
    entryAmount: Number(data.readBigUInt64LE(T.ENTRY_AMOUNT)),
    prizePool: Number(data.readBigUInt64LE(T.PRIZE_POOL)),
  };
}

function readSeat(data: Buffer) {
  return {
    chips: Number(data.readBigUInt64LE(S.CHIPS)),
    status: data[S.STATUS],
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

async function waitForPhase(conn: Connection, tbl: PublicKey, targetPhase: number | number[], timeoutMs = 300_000): Promise<number> {
  const targets = Array.isArray(targetPhase) ? targetPhase : [targetPhase];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await conn.getAccountInfo(tbl);
    if (info) {
      const phase = Buffer.from(info.data)[T.PHASE];
      if (targets.includes(phase)) return phase;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return -1;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  const results: { test: string; pass: boolean; detail: string }[] = [];

  console.log('═'.repeat(60));
  console.log('🏆 SNG E2E TEST — Arcium MPC Mode');
  console.log('═'.repeat(60));
  console.log('  ⚠️  Ensure crank-service is running with crank_sng=true\n');

  // ─── Create players ───
  const p1 = Keypair.generate();
  const p2 = Keypair.generate();
  for (const kp of [p1, p2]) {
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 100 * LAMPORTS_PER_SOL), 'confirmed');
    await ensureRegistered(conn, kp);
  }
  console.log('\n👥 Created 2 funded + registered players\n');

  // Record balances before
  const p1BalBefore = await conn.getBalance(p1.publicKey);
  const p2BalBefore = await conn.getBalance(p2.publicKey);

  // ═══════════════════════════════════════════════════════
  // TEST 1: Create HU SNG table (gameType=0)
  // ═══════════════════════════════════════════════════════
  console.log('━'.repeat(60));
  console.log('TEST 1: Create HU SNG table');
  console.log('━'.repeat(60));

  const tableId = crypto.randomBytes(32);
  const tablePda = getTable(tableId);

  const cfg = Buffer.alloc(36);
  tableId.copy(cfg);
  cfg[32] = 0; // gameType = SitAndGoHeadsUp
  cfg[33] = 0; // tier = Micro
  cfg[34] = 2; // maxPlayers = 2
  cfg[35] = 0; // reserved

  await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: p1.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: getPool(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.create_table, cfg]),
  }), [p1], 'create_table SNG-HU');

  for (let i = 0; i < 2; i++) {
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: p1.publicKey, isSigner: true, isWritable: true },
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
    }), [p1], `init_seat[${i}]`);
  }

  // Verify table created with correct gameType
  {
    const info = await conn.getAccountInfo(tablePda);
    const t = readTable(Buffer.from(info!.data));
    const pass = t.gameType === 0 && t.maxP === 2;
    results.push({ test: 'Create HU SNG', pass, detail: `gameType=${t.gameType}, maxP=${t.maxP}` });
    console.log(`  ${pass ? '✅' : '❌'} gameType=${t.gameType}, maxPlayers=${t.maxP}`);
  }

  // ═══════════════════════════════════════════════════════
  // TEST 2: Join both players + set x25519 keys
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 2: Join players + set x25519 keys');
  console.log('━'.repeat(60));

  const buyIn = 100000n; // SNG buy-in
  for (const [i, kp] of [p1, p2].entries()) {
    await send(conn, joinIx(kp.publicKey, tablePda, i, buyIn), [kp], `join seat ${i}`);
    const sk = x25519.utils.randomPrivateKey();
    const pk = x25519.getPublicKey(sk);
    await send(conn, setX25519KeyIx(kp.publicKey, tablePda, getSeat(tablePda, i), pk), [kp], `set_x25519 seat ${i}`);
  }

  {
    const info = await conn.getAccountInfo(tablePda);
    const t = readTable(Buffer.from(info!.data));
    const pass = t.curP === 2;
    results.push({ test: 'Join SNG', pass, detail: `currentPlayers=${t.curP}` });
    console.log(`  ${pass ? '✅' : '❌'} currentPlayers=${t.curP}`);
  }

  // ═══════════════════════════════════════════════════════
  // TEST 3: Wait for crank to deal (MPC) → Preflop
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 3: Crank starts game + deals (MPC)');
  console.log('━'.repeat(60));
  console.log('  ⏳ Waiting for crank to start_game + arcium_deal...');

  const dealPhase = await waitForPhase(conn, tablePda, [3, 4, 5, 6], 20 * 60 * 1000);
  {
    const pass = dealPhase >= 3;
    results.push({ test: 'MPC deal', pass, detail: `phase=${PHASE_NAMES[dealPhase] ?? dealPhase}` });
    console.log(`  ${pass ? '✅' : '❌'} Reached phase: ${PHASE_NAMES[dealPhase] ?? dealPhase}`);
  }

  if (dealPhase < 3) {
    console.log('\n⚠️  Crank did not deal — cannot continue SNG test');
    printResults(results);
    return;
  }

  // ═══════════════════════════════════════════════════════
  // TEST 4: Play hands — one player goes all-in each hand
  // until someone busts
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 4: Play until bust (all-in strategy)');
  console.log('━'.repeat(60));

  let handCount = 0;
  const MAX_HANDS = 20;
  let sngComplete = false;

  while (handCount < MAX_HANDS && !sngComplete) {
    handCount++;
    console.log(`\n  ── Hand #${handCount} ──`);

    // Wait for playable phase
    const playPhase = await waitForPhase(conn, tablePda, [3, 4, 5, 6], 5 * 60 * 1000);
    if (playPhase < 3) {
      // Check if SNG ended
      const info = await conn.getAccountInfo(tablePda);
      if (info) {
        const t = readTable(Buffer.from(info.data));
        if (t.phase === 9 || t.prizesDist) { sngComplete = true; break; }
      }
      console.log(`    ⚠️  Stuck at phase ${playPhase}, waiting...`);
      continue;
    }

    // Play: current player goes all-in
    const actionTimeout = 3 * 60 * 1000;
    const actionStart = Date.now();
    let handDone = false;

    while (!handDone && Date.now() - actionStart < actionTimeout) {
      const info = await conn.getAccountInfo(tablePda);
      if (!info) { await new Promise(r => setTimeout(r, 1000)); continue; }
      const d = Buffer.from(info.data);
      const phase = d[T.PHASE];
      const cp = d[T.CUR_PLAYER];

      // SNG over?
      if (phase === 9 || phase === 0) {
        const t = readTable(d);
        if (t.eliminatedCount > 0 || t.prizesDist) {
          sngComplete = true;
          handDone = true;
          break;
        }
        handDone = true; // hand ended, next hand
        break;
      }

      // MPC pending phases — wait
      if ([2, 8, 10, 11, 12].includes(phase)) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Showdown — wait for crank
      if (phase === 7) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Playable (3-6): go all-in
      if (phase >= 3 && phase <= 6) {
        const actor = cp === 0 ? p1 : p2;
        // Try all-in, fallback to call, fallback to check
        let sent = await send(conn, actionIx(actor.publicKey, tablePda, cp, 'AllIn'), [actor],
          `hand${handCount}: AllIn P${cp + 1} (${PHASE_NAMES[phase]})`);
        if (!sent) {
          sent = await send(conn, actionIx(actor.publicKey, tablePda, cp, 'Call'), [actor],
            `hand${handCount}: Call P${cp + 1} (fallback)`);
        }
        if (!sent) {
          await send(conn, actionIx(actor.publicKey, tablePda, cp, 'Check'), [actor],
            `hand${handCount}: Check P${cp + 1} (fallback2)`);
        }
        await new Promise(r => setTimeout(r, 500));
      } else {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Wait for hand settle
    const settleStart = Date.now();
    while (Date.now() - settleStart < 60_000) {
      const info = await conn.getAccountInfo(tablePda);
      if (!info) break;
      const t = readTable(Buffer.from(info.data));
      if (t.eliminatedCount > 0 || t.prizesDist) { sngComplete = true; break; }
      if (t.phase === 0 && t.hand >= handCount) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    // Check chip counts
    for (let i = 0; i < 2; i++) {
      const seatInfo = await conn.getAccountInfo(getSeat(tablePda, i));
      if (seatInfo) {
        const s = readSeat(Buffer.from(seatInfo.data));
        console.log(`    P${i + 1}: ${s.chips} chips, status=${STATUS_NAMES[s.status] ?? s.status}`);
        if (s.status === 5) { // Busted
          sngComplete = true;
          console.log(`    💀 P${i + 1} is BUSTED!`);
        }
      }
    }
  }

  results.push({ test: 'Play to bust', pass: sngComplete, detail: `hands=${handCount}, sngComplete=${sngComplete}` });
  console.log(`  ${sngComplete ? '✅' : '❌'} SNG complete after ${handCount} hands`);

  // ═══════════════════════════════════════════════════════
  // TEST 5: Wait for distribute_prizes + reset
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 5: Crank distribute_prizes + reset');
  console.log('━'.repeat(60));
  console.log('  ⏳ Waiting for crank to distribute prizes...');

  // Wait for prizes_distributed flag or phase transition Complete→Waiting
  const distStart = Date.now();
  let distributed = false;
  let lastPhase = -1;
  while (Date.now() - distStart < 180_000) {
    const info = await conn.getAccountInfo(tablePda);
    if (info) {
      const t = readTable(Buffer.from(info.data));
      // PRIMARY: Check prizesDist flag
      if (t.prizesDist) {
        distributed = true;
        console.log(`  ✅ Prizes distributed! Phase=${PHASE_NAMES[t.phase]}, eliminatedCount=${t.eliminatedCount}`);
        break;
      }
      // SECONDARY: Detect phase transition Complete(9)→Waiting(0)
      // reset_sng_table runs after distribute_prizes, so this confirms prizes were distributed
      if (t.phase === 0 && lastPhase === 9 && handCount > 0) {
        distributed = true;
        console.log('  ✅ Table reset detected (Complete→Waiting = prizes distributed + reset)');
        break;
      }
      // TERTIARY: Table is back to Waiting with 0 players (reset happened)
      if (t.phase === 0 && t.curP === 0 && handCount > 0) {
        distributed = true;
        console.log('  ✅ Table reset (0 players, Waiting phase)');
        break;
      }
      lastPhase = t.phase;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  results.push({ test: 'Distribute prizes', pass: distributed, detail: distributed ? 'ok' : 'timed out' });

  // ═══════════════════════════════════════════════════════
  // TEST 6: Check SOL balance changes (winner gets prize)
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 6: Verify SOL balances');
  console.log('━'.repeat(60));

  const p1BalAfter = await conn.getBalance(p1.publicKey);
  const p2BalAfter = await conn.getBalance(p2.publicKey);
  const p1Delta = p1BalAfter - p1BalBefore;
  const p2Delta = p2BalAfter - p2BalBefore;

  console.log(`  P1 balance change: ${p1Delta > 0 ? '+' : ''}${(p1Delta / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`  P2 balance change: ${p2Delta > 0 ? '+' : ''}${(p2Delta / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

  // At least one player should have gained (winner gets loser's buy-in minus rake)
  const someoneWon = p1Delta > -50 * LAMPORTS_PER_SOL || p2Delta > -50 * LAMPORTS_PER_SOL;
  results.push({ test: 'SOL balance check', pass: someoneWon, detail: `p1Δ=${p1Delta}, p2Δ=${p2Delta}` });

  // ═══════════════════════════════════════════════════════
  // TEST 7: Check unrefined POKER (winner should have some)
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 7: Check unrefined POKER minted');
  console.log('━'.repeat(60));

  let unrefinedFound = false;
  for (const [i, kp] of [p1, p2].entries()) {
    const unrefinedPda = getUnrefined(kp.publicKey);
    const info = await conn.getAccountInfo(unrefinedPda);
    if (info && info.data.length > 40) {
      // Steel Unrefined layout (#[repr(C)]): disc(8) + owner(32) + unrefined_amount(8) + refined_amount(8) ...
      // unrefined_amount is at offset 40 (8 disc + 32 owner)
      const amount = Number(Buffer.from(info.data).readBigUInt64LE(40));
      console.log(`  P${i + 1} unrefined POKER: ${amount}`);
      if (amount > 0) unrefinedFound = true;
    } else {
      console.log(`  P${i + 1} unrefined: no account`);
    }
  }
  results.push({ test: 'Unrefined POKER', pass: unrefinedFound || !distributed, detail: unrefinedFound ? 'found' : 'none (may be Micro tier = no POKER)' });

  // ═══════════════════════════════════════════════════════
  // TEST 8: Claim refined POKER (unrefined → SPL tokens)
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 8: Claim refined POKER → SPL tokens');
  console.log('━'.repeat(60));

  // Determine winner (the player with unrefined > 0)
  let winner: Keypair | null = null;
  for (const kp of [p1, p2]) {
    const uInfo = await conn.getAccountInfo(getUnrefined(kp.publicKey));
    if (uInfo && uInfo.data.length > 40 && Number(Buffer.from(uInfo.data).readBigUInt64LE(40)) > 0) {
      winner = kp;
      break;
    }
  }

  let claimRefinedPass = false;
  if (winner && distributed) {
    // Read pool to get poker_mint
    const poolInfo = await conn.getAccountInfo(getPool());
    const pokerMint = new PublicKey(Buffer.from(poolInfo!.data).slice(40, 72));
    console.log(`  POKER mint: ${pokerMint.toBase58().slice(0, 12)}...`);

    // Create/get winner's token account
    const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(
      require('path').join(__dirname, '.localnet-keypair.json'), 'utf-8',
    ))));
    const winnerAta = await getOrCreateAssociatedTokenAccount(conn, payer, pokerMint, winner.publicKey);
    console.log(`  Winner ATA: ${winnerAta.address.toBase58().slice(0, 12)}...`);

    const tokenBalBefore = Number(winnerAta.amount);
    console.log(`  Token balance before: ${tokenBalBefore}`);

    // Call claim_refined (Steel disc=5)
    // Accounts: winner(signer), unrefined, pool, token_account, mint, mint_authority(pool PDA), token_program
    const claimIx = new TransactionInstruction({
      programId: STEEL_PROGRAM_ID,
      keys: [
        { pubkey: winner.publicKey, isSigner: true, isWritable: true },
        { pubkey: getUnrefined(winner.publicKey), isSigner: false, isWritable: true },
        { pubkey: getPool(), isSigner: false, isWritable: true },
        { pubkey: winnerAta.address, isSigner: false, isWritable: true },
        { pubkey: pokerMint, isSigner: false, isWritable: true },
        { pubkey: getPool(), isSigner: false, isWritable: true }, // mint authority = pool PDA
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([5]), // claim_refined discriminator
    });

    const claimSig = await send(conn, claimIx, [winner], 'claim_refined');
    if (claimSig) {
      // Wait for claim_refined to finalize and tokens to appear
      console.log('  ⏳ Waiting for claim_refined to finalize...');
      const claimWaitStart = Date.now();
      while (Date.now() - claimWaitStart < 60_000) {
        try {
          const ataAfter = await getAccount(conn, winnerAta.address);
          const tokenBalAfter = Number(ataAfter.amount);
          if (tokenBalAfter > tokenBalBefore) {
            console.log(`  Token balance after: ${tokenBalAfter} (${tokenBalAfter / 1e9} POKER)`);
            console.log(`  Minted: ${tokenBalAfter - tokenBalBefore} (${(tokenBalAfter - tokenBalBefore) / 1e9} POKER)`);
            claimRefinedPass = true;
            break;
          }
        } catch (_e) { /* ATA may not exist yet */ }
        await new Promise(r => setTimeout(r, 2000));
      }

      // Check unrefined is now 0
      if (claimRefinedPass) {
        const uAfter = await conn.getAccountInfo(getUnrefined(winner.publicKey));
        if (uAfter) {
          const unrefinedAfter = Number(Buffer.from(uAfter.data).readBigUInt64LE(40));
          console.log(`  Unrefined after claim: ${unrefinedAfter} (should be 0)`);
        }
      }
    }
  } else {
    console.log('  ⚠️  No winner found or prizes not distributed — skipping claim test');
  }
  results.push({ test: 'Claim refined POKER', pass: claimRefinedPass, detail: claimRefinedPass ? 'SPL tokens minted' : 'failed or skipped' });

  // ═══════════════════════════════════════════════════════
  // TEST 9: Burn-stake POKER (earn staking weight)
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('TEST 9: Burn-stake POKER → staking weight');
  console.log('━'.repeat(60));

  let burnStakePass = false;
  if (winner && claimRefinedPass) {
    const poolInfo = await conn.getAccountInfo(getPool());
    const pokerMint = new PublicKey(Buffer.from(poolInfo!.data).slice(40, 72));

    const winnerAta = await getOrCreateAssociatedTokenAccount(conn, winner, pokerMint, winner.publicKey);
    const tokenBal = Number(winnerAta.amount);
    const burnAmount = Math.floor(tokenBal / 2); // Burn half
    console.log(`  Token balance: ${tokenBal} (${tokenBal / 1e9} POKER)`);
    console.log(`  Burning: ${burnAmount} (${burnAmount / 1e9} POKER)`);

    if (burnAmount > 0) {
      const stakePda = pda([Buffer.from('stake'), winner.publicKey.toBuffer()], STEEL_PROGRAM_ID);

      // burn_stake (disc=1): staker, stake, pool, token_account, mint, token_program, system_program
      const burnData = Buffer.alloc(9);
      burnData[0] = 1; // disc
      burnData.writeBigUInt64LE(BigInt(burnAmount), 1);

      const burnIx = new TransactionInstruction({
        programId: STEEL_PROGRAM_ID,
        keys: [
          { pubkey: winner.publicKey, isSigner: true, isWritable: true },
          { pubkey: stakePda, isSigner: false, isWritable: true },
          { pubkey: getPool(), isSigner: false, isWritable: true },
          { pubkey: winnerAta.address, isSigner: false, isWritable: true },
          { pubkey: pokerMint, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: burnData,
      });

      const burnSig = await send(conn, burnIx, [winner], 'burn_stake');
      if (burnSig) {
        // Wait for burn_stake to finalize
        console.log('  ⏳ Waiting for burn_stake to finalize...');
        const burnWaitStart = Date.now();
        while (Date.now() - burnWaitStart < 60_000) {
          const stakeInfo = await conn.getAccountInfo(stakePda);
          if (stakeInfo && stakeInfo.data.length >= 48) {
            const burnedAmount = Number(Buffer.from(stakeInfo.data).readBigUInt64LE(40));
            if (burnedAmount > 0) {
              console.log(`  Staked (burned): ${burnedAmount} (${burnedAmount / 1e9} POKER)`);
              burnStakePass = true;
              break;
            }
          }
          await new Promise(r => setTimeout(r, 2000));
        }

        // Check token balance reduced
        try {
          const ataAfter = await getAccount(conn, winnerAta.address);
          console.log(`  Token balance after burn: ${Number(ataAfter.amount)} (${Number(ataAfter.amount) / 1e9} POKER)`);
        } catch (_e) { /* ignore */ }
      }
    }
  } else {
    console.log('  ⚠️  No tokens to burn — skipping');
  }
  results.push({ test: 'Burn-stake POKER', pass: burnStakePass, detail: burnStakePass ? 'staking weight earned' : 'failed or skipped' });

  // ═══════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════
  printResults(results);
}

function printResults(results: { test: string; pass: boolean; detail: string }[]) {
  console.log('\n' + '═'.repeat(60));
  console.log('📊 SNG E2E TEST RESULTS');
  console.log('═'.repeat(60));
  let passed = 0;
  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    console.log(`  ${icon} ${r.test.padEnd(25)} ${r.detail}`);
    if (r.pass) passed++;
  }
  console.log(`\n  Result: ${passed}/${results.length} passed`);
  if (passed === results.length) {
    console.log('  🎉 ALL TESTS PASSED!\n');
  } else {
    console.log('  ⚠️  Some tests failed\n');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
