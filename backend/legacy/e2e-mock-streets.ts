/**
 * E2E Mock Street Test — Full game flow through all streets + all-in preflop.
 *
 * Uses devnet_bypass_deal (plaintext mock deal) + devnet_bypass_reveal + player_action
 * to test the complete poker game flow: Preflop → Flop → Turn → River → Showdown.
 *
 * Test 1: Normal street progression (call preflop, check through all streets)
 * Test 2: All-in preflop (both players all-in, auto-reveal all community)
 *
 * Run:   npx ts-node --transpile-only backend/e2e-mock-streets.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL, SYSVAR_SLOT_HASHES_PUBKEY,
} from '@solana/web3.js';
import * as crypto from 'crypto';

const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const RPC_URL = 'http://127.0.0.1:8899';
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// Discriminators
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
};

// PDA helpers
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

// Card display
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
function cardName(idx: number): string {
  if (idx === 255) return '??';
  if (idx < 0 || idx > 51) return `INV(${idx})`;
  return RANKS[idx % 13] + SUITS[Math.floor(idx / 13)];
}

// Table offsets (from memory)
const T = {
  PHASE: 160, CUR_PLAYER: 161, POT: 131, MIN_BET: 139,
  COMMUNITY: 155, OCC: 250, ALLIN: 252, FOLDED: 254,
  SB_SEAT: 164, BB_SEAT: 165, BUTTON: 163,
  SB_AMT: 105, BB_AMT: 113,
  PRE_COMMUNITY: 174, // pre_community offset
};

const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop',
  4: 'Flop', 5: 'Turn', 6: 'River', 7: 'Showdown', 8: 'AwaitingShowdown', 9: 'Complete',
  10: 'FlopRevealPending', 11: 'TurnRevealPending', 12: 'RiverRevealPending',
};

// PokerAction serialization (Anchor enum)
function serializeAction(action: string, amount?: bigint): Buffer {
  switch (action) {
    case 'Fold': return Buffer.from([0]);
    case 'Check': return Buffer.from([1]);
    case 'Call': return Buffer.from([2]);
    case 'Bet': { const b = Buffer.alloc(9); b[0] = 3; b.writeBigUInt64LE(amount || 0n, 1); return b; }
    case 'Raise': { const b = Buffer.alloc(9); b[0] = 4; b.writeBigUInt64LE(amount || 0n, 1); return b; }
    case 'AllIn': return Buffer.from([5]);
    default: throw new Error(`Unknown action: ${action}`);
  }
}

async function airdrop(conn: Connection, pk: PublicKey, amount: number) {
  const sig = await conn.requestAirdrop(pk, amount);
  await conn.confirmTransaction(sig, 'confirmed');
}

async function send(conn: Connection, ix: TransactionInstruction, signers: Keypair[], label: string): Promise<boolean> {
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), signers, { commitment: 'confirmed', skipPreflight: true });
    console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
    return true;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0, 200)}`);
    if (e.logs) e.logs.slice(-10).forEach((l: string) => console.log(`     ${l}`));
    return false;
  }
}

function readTable(data: Buffer) {
  return {
    phase: data[T.PHASE],
    curPlayer: data[T.CUR_PLAYER],
    pot: data.readBigUInt64LE(T.POT),
    community: Array.from(data.slice(T.COMMUNITY, T.COMMUNITY + 5)),
    preCommunity: Array.from(data.slice(T.PRE_COMMUNITY, T.PRE_COMMUNITY + 5)),
    occ: data.readUInt16LE(T.OCC),
    allin: data.readUInt16LE(T.ALLIN),
    folded: data.readUInt16LE(T.FOLDED),
    sbSeat: data[T.SB_SEAT],
    bbSeat: data[T.BB_SEAT],
    button: data[T.BUTTON],
  };
}

function showTableView(label: string, community: number[], pACards: string, pBCards: string, phase: string, pot: bigint) {
  const comm = community.map(c => c === 255 ? '🔒' : cardName(c)).join(' ');
  console.log('');
  console.log(`  ┌──────────────────────────────────────────┐`);
  console.log(`  │  ${label.padEnd(40)}│`);
  console.log(`  ├──────────────────────────────────────────┤`);
  console.log(`  │  Board: ${comm.padEnd(32)}│`);
  console.log(`  ├──────────────────────────────────────────┤`);
  console.log(`  │  Player A (seat 0): [ ${pACards} ]${' '.repeat(17 - pACards.length)}│`);
  console.log(`  │  Player B (seat 1): [ ${pBCards} ]${' '.repeat(17 - pBCards.length)}│`);
  console.log(`  ├──────────────────────────────────────────┤`);
  console.log(`  │  Phase: ${phase.padEnd(20)} Pot: ${String(pot).padEnd(8)}│`);
  console.log(`  └──────────────────────────────────────────┘`);
  console.log('');
}

// ════════════════════════════════════════════════════════════════
// SETUP: Create HU table with 2 players
// ════════════════════════════════════════════════════════════════
async function setupGame(conn: Connection): Promise<{ pA: Keypair; pB: Keypair; tbl: PublicKey; tableId: Buffer }> {
  const [pA, pB] = [Keypair.generate(), Keypair.generate()];
  await airdrop(conn, pA.publicKey, 10 * LAMPORTS_PER_SOL);
  await airdrop(conn, pB.publicKey, 10 * LAMPORTS_PER_SOL);
  const pool = getPool();

  for (const p of [pA, pB]) await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID, keys: [
      { pubkey: p.publicKey, isSigner: true, isWritable: true },
      { pubkey: getPlayer(p.publicKey), isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: getUnrefined(p.publicKey), isSigner: false, isWritable: true },
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data: IX.register_player,
  }), [p], 'Register');

  const tableId = crypto.randomBytes(32);
  const tbl = getTable(tableId);
  const cfg = Buffer.alloc(36); tableId.copy(cfg); cfg[32] = 3; cfg[34] = 2; // CashGame, HU
  await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID, keys: [
      { pubkey: pA.publicKey, isSigner: true, isWritable: true },
      { pubkey: tbl, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data: Buffer.concat([IX.create_table, cfg]),
  }), [pA], 'CreateTable');

  for (let i = 0; i < 2; i++) await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID, keys: [
      { pubkey: pA.publicKey, isSigner: true, isWritable: true },
      { pubkey: tbl, isSigner: false, isWritable: false },
      { pubkey: getSeat(tbl, i), isSigner: false, isWritable: true },
      { pubkey: getSeatCards(tbl, i), isSigner: false, isWritable: true },
      { pubkey: getDeckState(tbl), isSigner: false, isWritable: true },
      { pubkey: getReceipt(tbl, i), isSigner: false, isWritable: true },
      { pubkey: getVault(tbl), isSigner: false, isWritable: true },
      { pubkey: getCrankEr(tbl), isSigner: false, isWritable: true },
      { pubkey: getCrankL1(tbl), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data: Buffer.concat([IX.init_table_seat, Buffer.from([i])]),
  }), [pA], `InitSeat${i}`);

  for (const [p, i] of [[pA, 0], [pB, 1]] as [Keypair, number][]) {
    const d = Buffer.alloc(25); IX.join_table.copy(d); d.writeBigUInt64LE(100000n, 8); d[16] = i;
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: p.publicKey, isSigner: true, isWritable: true },
        { pubkey: getPlayer(p.publicKey), isSigner: false, isWritable: true },
        { pubkey: tbl, isSigner: false, isWritable: true },
        { pubkey: getSeat(tbl, i), isSigner: false, isWritable: true },
        { pubkey: getMarker(p.publicKey, tbl), isSigner: false, isWritable: true },
        { pubkey: getVault(tbl), isSigner: false, isWritable: true },
        { pubkey: getReceipt(tbl, i), isSigner: false, isWritable: true },
        ...Array(6).fill({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false }),
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: d,
    }), [p], `Join${i}`);
  }

  await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID, keys: [
      { pubkey: pA.publicKey, isSigner: false, isWritable: false },
      { pubkey: tbl, isSigner: false, isWritable: true },
      { pubkey: getDeckState(tbl), isSigner: false, isWritable: true },
      { pubkey: getSeat(tbl, 0), isSigner: false, isWritable: true },
      { pubkey: getSeat(tbl, 1), isSigner: false, isWritable: true },
    ], data: IX.start_game,
  }), [pA], 'StartGame');

  return { pA, pB, tbl, tableId };
}

// ════════════════════════════════════════════════════════════════
// MOCK DEAL
// ════════════════════════════════════════════════════════════════
async function mockDeal(conn: Connection, caller: Keypair, tbl: PublicKey): Promise<boolean> {
  // remaining_accounts: [seat_0, seat_1, seat_cards_0, seat_cards_1]
  return send(conn, new TransactionInstruction({
    programId: PROGRAM_ID, keys: [
      { pubkey: caller.publicKey, isSigner: true, isWritable: false },
      { pubkey: tbl, isSigner: false, isWritable: true },
      { pubkey: getDeckState(tbl), isSigner: false, isWritable: true },
      { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
      // remaining: seats then seat_cards
      { pubkey: getSeat(tbl, 0), isSigner: false, isWritable: true },
      { pubkey: getSeat(tbl, 1), isSigner: false, isWritable: true },
      { pubkey: getSeatCards(tbl, 0), isSigner: false, isWritable: true },
      { pubkey: getSeatCards(tbl, 1), isSigner: false, isWritable: true },
    ], data: IX.devnet_bypass_deal,
  }), [caller], 'MockDeal');
}

// ════════════════════════════════════════════════════════════════
// MOCK REVEAL
// ════════════════════════════════════════════════════════════════
async function mockReveal(conn: Connection, caller: Keypair, tbl: PublicKey): Promise<boolean> {
  return send(conn, new TransactionInstruction({
    programId: PROGRAM_ID, keys: [
      { pubkey: caller.publicKey, isSigner: true, isWritable: false },
      { pubkey: tbl, isSigner: false, isWritable: true },
    ], data: IX.devnet_bypass_reveal,
  }), [caller], 'MockReveal');
}

// ════════════════════════════════════════════════════════════════
// PLAYER ACTION
// ════════════════════════════════════════════════════════════════
async function playerAction(conn: Connection, player: Keypair, tbl: PublicKey, seatIdx: number, action: string, amount?: bigint): Promise<boolean> {
  return send(conn, new TransactionInstruction({
    programId: PROGRAM_ID, keys: [
      { pubkey: player.publicKey, isSigner: true, isWritable: false },
      { pubkey: tbl, isSigner: false, isWritable: true },
      { pubkey: getSeat(tbl, seatIdx), isSigner: false, isWritable: true },
      // Option<Account> sentinel: pass program ID for None
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
    ], data: Buffer.concat([IX.player_action, serializeAction(action, amount)]),
  }), [player], `${action}(seat${seatIdx})`);
}

// ════════════════════════════════════════════════════════════════
// Read hole cards from SeatCards (plaintext in mock mode)
// ════════════════════════════════════════════════════════════════
async function readHoleCards(conn: Connection, tbl: PublicKey, seatIdx: number): Promise<string> {
  const sc = await conn.getAccountInfo(getSeatCards(tbl, seatIdx));
  if (!sc) return '?? ??';
  // SeatCards: disc(8) + table(32) + seat_index(1) + player(32) + card1(1) + card2(1)
  const c1 = sc.data[73];
  const c2 = sc.data[74];
  return `${cardName(c1)} ${cardName(c2)}`;
}

// ════════════════════════════════════════════════════════════════
// TEST 1: Normal street progression
// ════════════════════════════════════════════════════════════════
async function test1_normalStreets(conn: Connection) {
  console.log('\n' + '═'.repeat(70));
  console.log('  TEST 1: Normal Street Progression (Call → Check through all streets)');
  console.log('═'.repeat(70));

  const { pA, pB, tbl } = await setupGame(conn);
  if (!await mockDeal(conn, pA, tbl)) { console.log('  ❌ Deal failed'); return false; }

  const pACards = await readHoleCards(conn, tbl, 0);
  const pBCards = await readHoleCards(conn, tbl, 1);

  let tInfo = await conn.getAccountInfo(tbl);
  if (!tInfo) return false;
  let t = readTable(tInfo.data);
  console.log(`  Phase: ${PHASE_NAMES[t.phase]}, curPlayer: ${t.curPlayer}, pot: ${t.pot}`);

  // ── PREFLOP ──
  console.log('\n  --- PREFLOP ---');
  showTableView('PREFLOP', t.community, pACards, pBCards, PHASE_NAMES[t.phase], t.pot);

  // HU: SB (dealer=seat 0) acts first preflop → Call, then BB (seat 1) → Check
  if (!await playerAction(conn, pA, tbl, 0, 'Call')) return false;
  if (!await playerAction(conn, pB, tbl, 1, 'Check')) return false;

  tInfo = await conn.getAccountInfo(tbl);
  if (!tInfo) return false;
  t = readTable(tInfo.data);
  console.log(`  Phase after preflop: ${PHASE_NAMES[t.phase]} (expected: FlopRevealPending)`);
  if (t.phase !== 10) { console.log('  ❌ Wrong phase'); return false; }

  // ── FLOP REVEAL ──
  if (!await mockReveal(conn, pA, tbl)) return false;
  tInfo = await conn.getAccountInfo(tbl);
  if (!tInfo) return false;
  t = readTable(tInfo.data);
  console.log(`\n  --- FLOP ---`);
  showTableView('FLOP', t.community, pACards, pBCards, PHASE_NAMES[t.phase], t.pot);

  // Post-flop: BB acts first (seat 1 for HU). Check-Check.
  if (!await playerAction(conn, pB, tbl, 1, 'Check')) return false;
  if (!await playerAction(conn, pA, tbl, 0, 'Check')) return false;

  tInfo = await conn.getAccountInfo(tbl);
  if (!tInfo) return false;
  t = readTable(tInfo.data);
  console.log(`  Phase after flop: ${PHASE_NAMES[t.phase]} (expected: TurnRevealPending)`);
  if (t.phase !== 11) { console.log('  ❌ Wrong phase'); return false; }

  // ── TURN REVEAL ──
  if (!await mockReveal(conn, pA, tbl)) return false;
  tInfo = await conn.getAccountInfo(tbl);
  if (!tInfo) return false;
  t = readTable(tInfo.data);
  console.log(`\n  --- TURN ---`);
  showTableView('TURN', t.community, pACards, pBCards, PHASE_NAMES[t.phase], t.pot);

  // Check-Check
  if (!await playerAction(conn, pB, tbl, 1, 'Check')) return false;
  if (!await playerAction(conn, pA, tbl, 0, 'Check')) return false;

  tInfo = await conn.getAccountInfo(tbl);
  if (!tInfo) return false;
  t = readTable(tInfo.data);
  console.log(`  Phase after turn: ${PHASE_NAMES[t.phase]} (expected: RiverRevealPending)`);
  if (t.phase !== 12) { console.log('  ❌ Wrong phase'); return false; }

  // ── RIVER REVEAL ──
  if (!await mockReveal(conn, pA, tbl)) return false;
  tInfo = await conn.getAccountInfo(tbl);
  if (!tInfo) return false;
  t = readTable(tInfo.data);
  console.log(`\n  --- RIVER ---`);
  showTableView('RIVER', t.community, pACards, pBCards, PHASE_NAMES[t.phase], t.pot);

  // Check-Check → Showdown
  if (!await playerAction(conn, pB, tbl, 1, 'Check')) return false;
  if (!await playerAction(conn, pA, tbl, 0, 'Check')) return false;

  tInfo = await conn.getAccountInfo(tbl);
  if (!tInfo) return false;
  t = readTable(tInfo.data);
  console.log(`\n  --- SHOWDOWN ---`);
  console.log(`  Phase: ${PHASE_NAMES[t.phase]}`);
  showTableView('SHOWDOWN', t.community, pACards, pBCards, PHASE_NAMES[t.phase], t.pot);

  // Verify all 5 community cards revealed
  const allRevealed = t.community.every(c => c !== 255 && c >= 0 && c <= 51);
  console.log(`  All 5 community cards revealed: ${allRevealed ? '✅' : '❌'}`);
  console.log(`  Community: ${t.community.map(cardName).join(' ')}`);

  return allRevealed && t.phase === 7;
}

// ════════════════════════════════════════════════════════════════
// TEST 2: All-in preflop
// ════════════════════════════════════════════════════════════════
async function test2_allinPreflop(conn: Connection) {
  console.log('\n' + '═'.repeat(70));
  console.log('  TEST 2: All-In Preflop (both players all-in, auto-reveal board)');
  console.log('═'.repeat(70));

  const { pA, pB, tbl } = await setupGame(conn);
  if (!await mockDeal(conn, pA, tbl)) { console.log('  ❌ Deal failed'); return false; }

  const pACards = await readHoleCards(conn, tbl, 0);
  const pBCards = await readHoleCards(conn, tbl, 1);

  let tInfo = await conn.getAccountInfo(tbl);
  if (!tInfo) return false;
  let t = readTable(tInfo.data);
  console.log(`  Preflop: curPlayer=${t.curPlayer}, pot=${t.pot}`);
  showTableView('PREFLOP (before all-in)', t.community, pACards, pBCards, PHASE_NAMES[t.phase], t.pot);

  // SB goes all-in, BB calls all-in
  if (!await playerAction(conn, pA, tbl, 0, 'AllIn')) return false;
  if (!await playerAction(conn, pB, tbl, 1, 'AllIn')) return false;

  tInfo = await conn.getAccountInfo(tbl);
  if (!tInfo) return false;
  t = readTable(tInfo.data);
  console.log(`  Phase after all-in: ${PHASE_NAMES[t.phase]}`);

  // Auto-reveal: FlopRevealPending → reveal → Flop → auto-advance to TurnRevealPending → etc
  let reveals = 0;
  while (t.phase >= 10 && t.phase <= 12 && reveals < 5) {
    console.log(`  Revealing... (${PHASE_NAMES[t.phase]})`);
    if (!await mockReveal(conn, pA, tbl)) break;
    tInfo = await conn.getAccountInfo(tbl);
    if (!tInfo) break;
    t = readTable(tInfo.data);
    reveals++;
    console.log(`  → ${PHASE_NAMES[t.phase]} (community: ${t.community.map(cardName).join(' ')})`);
  }

  showTableView('ALL-IN SHOWDOWN', t.community, pACards, pBCards, PHASE_NAMES[t.phase], t.pot);

  const allRevealed = t.community.every(c => c !== 255 && c >= 0 && c <= 51);
  console.log(`  All 5 community cards revealed: ${allRevealed ? '✅' : '❌'}`);
  console.log(`  Phase: ${PHASE_NAMES[t.phase]} ${t.phase === 7 ? '✅' : '❌'}`);
  console.log(`  Pot: ${t.pot}`);
  console.log(`  Both all-in: occ=${t.occ.toString(2)}, allin=${t.allin.toString(2)}`);

  return allRevealed && t.phase === 7;
}

// ════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════
async function main() {
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║  E2E Mock Street Test — Full Game Flow + All-In Preflop            ║');
  console.log('╚' + '═'.repeat(68) + '╝');

  const conn = new Connection(RPC_URL, 'confirmed');

  const r1 = await test1_normalStreets(conn);
  const r2 = await test2_allinPreflop(conn);

  console.log('\n' + '═'.repeat(70));
  console.log('  RESULTS');
  console.log('═'.repeat(70));
  console.log(`  ${r1 ? '✅' : '❌'} Test 1: Normal street progression`);
  console.log(`  ${r2 ? '✅' : '❌'} Test 2: All-in preflop`);
  console.log('');
  if (r1 && r2) {
    console.log('  🎉 ALL TESTS PASSED');
  } else {
    console.log('  ⚠️  SOME TESTS FAILED');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
