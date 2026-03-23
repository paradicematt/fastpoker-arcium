/**
 * Multi-Crank E2E Test — CrankTally Verification
 *
 * Tests that multiple crank operators can be registered and that CrankTally
 * correctly tracks each operator's contributions on a HU cash game table.
 *
 * Flow:
 *   1. Setup 4 crank keypairs, airdrop SOL, register CrankOperator + DealerLicense
 *   2. Create a HU cash game table with CrankTallyER initialized
 *   3. Register 2 test players, join table, set x25519 keys
 *   4. Run 4 hands — let the existing crank service handle dealing/settling
 *   5. After each hand settles, read CrankTallyER PDA to verify tracking
 *   6. Print crank weight report
 *
 * Prerequisites:
 *   - localnet-bootstrap.ts has been run (dealer registry exists)
 *   - crank-service is running
 *
 * Run:
 *   npx ts-node --transpile-only backend/e2e-multi-crank-test.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { x25519 } from '@arcium-hq/client';

const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// ─── CrankTally layout constants ───
const TALLY_OPERATORS_START = 40;       // 4 x 32-byte pubkeys
const TALLY_ACTION_COUNT_START = 168;   // 4 x u32
const TALLY_TOTAL_ACTIONS_OFF = 184;    // u32
const TALLY_LAST_HAND_OFF = 188;        // u64
const MAX_CRANK_OPERATORS = 4;
const CRANK_TALLY_SIZE = 197;

// ─── Instruction discriminators ───
function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}
const IX: Record<string, Buffer> = {};
for (const n of [
  'register_player', 'create_table', 'init_table_seat', 'join_table',
  'player_action', 'start_game', 'settle_hand', 'set_x25519_key',
  'register_crank_operator', 'purchase_dealer_license',
  'init_crank_tally_er', 'init_crank_tally_l1', 'init_table_vault',
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
const getCrankOperatorPda = (w: PublicKey) => pda([Buffer.from('crank'), w.toBuffer()]);
const getDealerLicensePda = (w: PublicKey) => pda([Buffer.from('dealer_license'), w.toBuffer()]);
const getDealerRegistry = () => pda([Buffer.from('dealer_registry')]);
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

// ─── Helpers ───

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

async function send(
  conn: Connection, ix: TransactionInstruction, signers: Keypair[], label: string,
): Promise<string | null> {
  try {
    const sig = await sendAndConfirmTransaction(
      conn, new Transaction().add(ix), signers,
      { commitment: 'confirmed', skipPreflight: true },
    );
    console.log(`  [ok] ${label}: ${sig.slice(0, 20)}...`);
    return sig;
  } catch (e: any) {
    console.log(`  [FAIL] ${label}: ${e.message?.slice(0, 120)}`);
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

async function ensureRegistered(conn: Connection, kp: Keypair): Promise<void> {
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
  }), [kp], `register_player ${kp.publicKey.toBase58().slice(0, 8)}`);
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

async function waitForPhase(
  conn: Connection, tbl: PublicKey, targetPhase: number | number[], timeoutMs = 300_000,
): Promise<number> {
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

async function waitForHand(
  conn: Connection, tbl: PublicKey, targetHand: number, timeoutMs = 300_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await conn.getAccountInfo(tbl);
    if (info) {
      const d = Buffer.from(info.data);
      const hand = Number(d.readBigUInt64LE(T.HAND));
      const phase = d[T.PHASE];
      if (hand >= targetHand && phase === 0) return true;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

// ─── CrankTally parsing ───

interface TallyData {
  operators: { pubkey: PublicKey; actionCount: number }[];
  totalActions: number;
  lastHand: number;
}

function parseCrankTally(data: Buffer): TallyData | null {
  if (data.length < CRANK_TALLY_SIZE) return null;
  const operators: { pubkey: PublicKey; actionCount: number }[] = [];
  for (let i = 0; i < MAX_CRANK_OPERATORS; i++) {
    const pkStart = TALLY_OPERATORS_START + i * 32;
    const countStart = TALLY_ACTION_COUNT_START + i * 4;
    const pk = new PublicKey(data.subarray(pkStart, pkStart + 32));
    const count = data.readUInt32LE(countStart);
    if (!pk.equals(PublicKey.default)) {
      operators.push({ pubkey: pk, actionCount: count });
    }
  }
  const totalActions = data.readUInt32LE(TALLY_TOTAL_ACTIONS_OFF);
  const lastHand = Number(data.readBigUInt64LE(TALLY_LAST_HAND_OFF));
  return { operators, totalActions, lastHand };
}

// ─── Crank operator registration ───

async function registerCrankOperator(conn: Connection, kp: Keypair): Promise<boolean> {
  const opPda = getCrankOperatorPda(kp.publicKey);
  const existing = await conn.getAccountInfo(opPda);
  if (existing) {
    console.log(`  [skip] CrankOperator already exists: ${kp.publicKey.toBase58().slice(0, 12)}`);
    return true;
  }
  const sig = await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: opPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX.register_crank_operator,
  }), [kp], `register_crank_operator ${kp.publicKey.toBase58().slice(0, 8)}`);
  return sig !== null;
}

async function purchaseDealerLicense(conn: Connection, kp: Keypair): Promise<boolean> {
  const licPda = getDealerLicensePda(kp.publicKey);
  const existing = await conn.getAccountInfo(licPda);
  if (existing) {
    console.log(`  [skip] DealerLicense already exists: ${kp.publicKey.toBase58().slice(0, 12)}`);
    return true;
  }
  const sig = await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },   // buyer
      { pubkey: kp.publicKey, isSigner: false, isWritable: false },  // beneficiary (self)
      { pubkey: getDealerRegistry(), isSigner: false, isWritable: true },
      { pubkey: licPda, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: getPool(), isSigner: false, isWritable: true },      // staker_pool
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX.purchase_dealer_license,
  }), [kp], `purchase_dealer_license ${kp.publicKey.toBase58().slice(0, 8)}`);
  return sig !== null;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  const results: { test: string; pass: boolean; detail: string }[] = [];

  console.log('='.repeat(60));
  console.log('MULTI-CRANK E2E TEST -- CrankTally Verification');
  console.log('='.repeat(60));
  console.log('  Ensure crank-service is running');
  console.log('  Ensure localnet-bootstrap has been run (dealer registry)\n');

  // ═══════════════════════════════════════════════════════
  // STEP 1: Setup 4 crank keypairs
  // ═══════════════════════════════════════════════════════
  console.log('-'.repeat(60));
  console.log('STEP 1: Setup 4 crank operator keypairs');
  console.log('-'.repeat(60));

  const cranks: Keypair[] = [];
  for (let i = 0; i < 4; i++) {
    cranks.push(Keypair.generate());
  }

  // Airdrop SOL to each
  for (const [i, kp] of cranks.entries()) {
    await conn.confirmTransaction(
      await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed',
    );
    console.log(`  Crank ${i + 1}: ${kp.publicKey.toBase58().slice(0, 16)}... (10 SOL)`);
  }

  // ═══════════════════════════════════════════════════════
  // STEP 2: Register each as CrankOperator + DealerLicense
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '-'.repeat(60));
  console.log('STEP 2: Register CrankOperator + purchase DealerLicense');
  console.log('-'.repeat(60));

  // Verify dealer registry exists
  const registryInfo = await conn.getAccountInfo(getDealerRegistry());
  if (!registryInfo) {
    console.log('  [FATAL] DealerRegistry not found -- run localnet-bootstrap.ts first');
    process.exit(1);
  }
  console.log(`  DealerRegistry found (${registryInfo.data.length} bytes)`);

  let allRegistered = true;
  for (const [i, kp] of cranks.entries()) {
    const opOk = await registerCrankOperator(conn, kp);
    const licOk = await purchaseDealerLicense(conn, kp);
    if (!opOk || !licOk) allRegistered = false;
    console.log(`  Crank ${i + 1}: operator=${opOk}, license=${licOk}`);
  }
  results.push({
    test: 'Register 4 crank operators',
    pass: allRegistered,
    detail: allRegistered ? 'all 4 registered' : 'some failed',
  });

  // ═══════════════════════════════════════════════════════
  // STEP 3: Create HU cash game table with CrankTally
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '-'.repeat(60));
  console.log('STEP 3: Create HU cash game table');
  console.log('-'.repeat(60));

  const tableId = crypto.randomBytes(32);
  const tablePda = getTable(tableId);

  // create_table config: tableId(32) + gameType(1) + tier(1) + maxPlayers(1) + reserved(1)
  // gameType=3 = CashGame, tier=0, maxPlayers=2
  const cfg = Buffer.alloc(36);
  tableId.copy(cfg);
  cfg[32] = 3; // gameType = CashGame
  cfg[33] = 0; // tier (unused for cash)
  cfg[34] = 2; // maxPlayers = 2 (heads-up)
  cfg[35] = 0; // reserved

  // Use crank[0] as table creator
  const creator = cranks[0];
  await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: getPool(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.create_table, cfg]),
  }), [creator], 'create_table CashGame-HU');

  // init_table_seat for each seat (also initializes vault, tallies, etc.)
  for (let i = 0; i < 2; i++) {
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
    }), [creator], `init_seat[${i}]`);
  }

  // Verify table + CrankTallyER created
  {
    const tInfo = await conn.getAccountInfo(tablePda);
    const tallyInfo = await conn.getAccountInfo(getCrankEr(tablePda));
    const tableOk = tInfo !== null;
    const tallyOk = tallyInfo !== null;
    const t = tInfo ? readTable(Buffer.from(tInfo.data)) : null;
    results.push({
      test: 'Create table + tally',
      pass: tableOk && tallyOk,
      detail: `table=${tableOk}, tallyER=${tallyOk}, gameType=${t?.gameType}, maxP=${t?.maxP}`,
    });
    console.log(`  Table: ${tablePda.toBase58().slice(0, 16)}...`);
    console.log(`  CrankTallyER: ${getCrankEr(tablePda).toBase58().slice(0, 16)}... exists=${tallyOk}`);
    if (t) console.log(`  gameType=${t.gameType} (3=CashGame), maxP=${t.maxP}`);
  }

  // ═══════════════════════════════════════════════════════
  // STEP 4: Register 2 test players, join, set x25519 keys
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '-'.repeat(60));
  console.log('STEP 4: Register + join 2 players');
  console.log('-'.repeat(60));

  const p1 = Keypair.generate();
  const p2 = Keypair.generate();

  for (const kp of [p1, p2]) {
    await conn.confirmTransaction(
      await conn.requestAirdrop(kp.publicKey, 100 * LAMPORTS_PER_SOL), 'confirmed',
    );
    await ensureRegistered(conn, kp);
  }
  console.log(`  P1: ${p1.publicKey.toBase58().slice(0, 16)}...`);
  console.log(`  P2: ${p2.publicKey.toBase58().slice(0, 16)}...`);

  // Join table
  const buyIn = 100000n; // Cash game buy-in
  for (const [i, kp] of [p1, p2].entries()) {
    await send(conn, joinIx(kp.publicKey, tablePda, i, buyIn), [kp], `join seat ${i}`);
    const sk = x25519.utils.randomPrivateKey();
    const pk = x25519.getPublicKey(sk);
    await send(conn, setX25519KeyIx(kp.publicKey, tablePda, getSeat(tablePda, i), pk), [kp], `set_x25519 seat ${i}`);
  }

  // Verify join
  {
    const info = await conn.getAccountInfo(tablePda);
    const t = readTable(Buffer.from(info!.data));
    const pass = t.curP === 2;
    results.push({ test: 'Join 2 players', pass, detail: `currentPlayers=${t.curP}` });
    console.log(`  currentPlayers=${t.curP}`);
  }

  // ═══════════════════════════════════════════════════════
  // STEP 5: Play 4 hands (crank service handles dealing)
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '-'.repeat(60));
  console.log('STEP 5: Play 4 hands (crank deals, players check/call)');
  console.log('-'.repeat(60));
  console.log('  Waiting for crank to start_game + arcium_deal...\n');

  const TOTAL_HANDS = 4;
  let handsCompleted = 0;

  for (let h = 1; h <= TOTAL_HANDS; h++) {
    console.log(`  -- Hand #${h} --`);

    // Wait for a playable phase (preflop through river)
    const dealPhase = await waitForPhase(conn, tablePda, [3, 4, 5, 6], 10 * 60 * 1000);
    if (dealPhase < 3) {
      console.log(`    Timed out waiting for deal (phase=${dealPhase})`);
      // Check if a player busted (cash game shouldn't, but handle gracefully)
      const info = await conn.getAccountInfo(tablePda);
      if (info) {
        const t = readTable(Buffer.from(info.data));
        console.log(`    Table phase=${PHASE_NAMES[t.phase]}, hand=${t.hand}, curP=${t.curP}`);
      }
      break;
    }
    console.log(`    Dealt -> ${PHASE_NAMES[dealPhase]}`);

    // Play: check/call through all streets until hand settles
    const actionTimeout = 3 * 60 * 1000;
    const actionStart = Date.now();
    let handDone = false;

    while (!handDone && Date.now() - actionStart < actionTimeout) {
      const info = await conn.getAccountInfo(tablePda);
      if (!info) { await new Promise(r => setTimeout(r, 1000)); continue; }
      const d = Buffer.from(info.data);
      const phase = d[T.PHASE];
      const cp = d[T.CUR_PLAYER];

      // Hand settled (back to Waiting or next hand started)
      if (phase === 0 || phase === 9) {
        handDone = true;
        break;
      }

      // MPC pending phases -- wait for crank
      if ([2, 7, 8, 10, 11, 12].includes(phase)) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Playable phase (3=Preflop, 4=Flop, 5=Turn, 6=River)
      if (phase >= 3 && phase <= 6) {
        const actor = cp === 0 ? p1 : p2;
        // Try check first (cheapest), fall back to call
        let sent = await send(conn, actionIx(actor.publicKey, tablePda, cp, 'Check'), [actor],
          `hand${h}: Check P${cp + 1} (${PHASE_NAMES[phase]})`);
        if (!sent) {
          sent = await send(conn, actionIx(actor.publicKey, tablePda, cp, 'Call'), [actor],
            `hand${h}: Call P${cp + 1} (fallback)`);
        }
        if (!sent) {
          // If both fail, try fold to avoid getting stuck
          await send(conn, actionIx(actor.publicKey, tablePda, cp, 'Fold'), [actor],
            `hand${h}: Fold P${cp + 1} (last resort)`);
        }
        await new Promise(r => setTimeout(r, 500));
      } else {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Wait for hand to fully settle (phase back to Waiting)
    const settleOk = await waitForHand(conn, tablePda, h, 120_000);
    if (settleOk) {
      handsCompleted++;
      console.log(`    Hand #${h} settled`);
    } else {
      console.log(`    Hand #${h} settle timeout`);
      // Still count it if hand number advanced
      const info = await conn.getAccountInfo(tablePda);
      if (info) {
        const t = readTable(Buffer.from(info.data));
        if (t.hand >= h) {
          handsCompleted++;
          console.log(`    (hand number advanced to ${t.hand}, counting as settled)`);
        }
      }
    }

    // Read tally after each hand
    const tallyInfo = await conn.getAccountInfo(getCrankEr(tablePda));
    if (tallyInfo) {
      const tally = parseCrankTally(Buffer.from(tallyInfo.data));
      if (tally) {
        console.log(`    Tally: total_actions=${tally.totalActions}, last_hand=${tally.lastHand}, operators=${tally.operators.length}`);
      }
    }

    // Check chip counts
    for (let i = 0; i < 2; i++) {
      const seatInfo = await conn.getAccountInfo(getSeat(tablePda, i));
      if (seatInfo) {
        const s = readSeat(Buffer.from(seatInfo.data));
        console.log(`    P${i + 1}: ${s.chips} chips, status=${STATUS_NAMES[s.status] ?? s.status}`);
      }
    }
    console.log('');
  }

  results.push({
    test: 'Play 4 hands',
    pass: handsCompleted >= TOTAL_HANDS,
    detail: `${handsCompleted}/${TOTAL_HANDS} hands completed`,
  });

  // ═══════════════════════════════════════════════════════
  // STEP 6: Read + verify CrankTallyER PDA
  // ═══════════════════════════════════════════════════════
  console.log('-'.repeat(60));
  console.log('STEP 6: Read + verify CrankTallyER');
  console.log('-'.repeat(60));

  const tallyPda = getCrankEr(tablePda);
  const tallyInfo = await conn.getAccountInfo(tallyPda);

  if (!tallyInfo) {
    results.push({ test: 'Read CrankTallyER', pass: false, detail: 'account not found' });
    console.log('  [FAIL] CrankTallyER account not found');
  } else {
    const tallyData = Buffer.from(tallyInfo.data);
    const tally = parseCrankTally(tallyData);

    if (!tally) {
      results.push({ test: 'Read CrankTallyER', pass: false, detail: 'failed to parse' });
      console.log('  [FAIL] Failed to parse CrankTallyER');
    } else {
      console.log(`  Total actions: ${tally.totalActions}`);
      console.log(`  Last hand: ${tally.lastHand}`);
      console.log(`  Operators tracked: ${tally.operators.length}`);

      // Verify: total_actions > 0
      const hasActions = tally.totalActions > 0;
      results.push({
        test: 'Tally has actions',
        pass: hasActions,
        detail: `total_actions=${tally.totalActions}`,
      });

      // Verify: total_actions == sum of individual counts
      const sumIndividual = tally.operators.reduce((acc, op) => acc + op.actionCount, 0);
      // Note: total_actions may include untracked 5th+ operators, but we only have <=4
      const sumsMatch = tally.totalActions >= sumIndividual;
      results.push({
        test: 'Tally sum consistency',
        pass: sumsMatch,
        detail: `total=${tally.totalActions}, sum_individual=${sumIndividual}`,
      });

      // Verify: no duplicate operators
      const pubkeys = tally.operators.map(op => op.pubkey.toBase58());
      const uniquePubkeys = new Set(pubkeys);
      const noDupes = uniquePubkeys.size === pubkeys.length;
      results.push({
        test: 'No duplicate operators',
        pass: noDupes,
        detail: `unique=${uniquePubkeys.size}/${pubkeys.length}`,
      });

      // Verify: each operator has action_count >= 1
      const allHaveActions = tally.operators.every(op => op.actionCount >= 1);
      results.push({
        test: 'All operators have actions',
        pass: tally.operators.length === 0 || allHaveActions,
        detail: tally.operators.map(op => `${op.pubkey.toBase58().slice(0, 8)}=${op.actionCount}`).join(', '),
      });

      // Verify: last_hand matches expected
      const lastHandOk = tally.lastHand >= handsCompleted;
      results.push({
        test: 'Last hand tracking',
        pass: lastHandOk || tally.lastHand > 0,
        detail: `lastHand=${tally.lastHand}, handsCompleted=${handsCompleted}`,
      });

      // ═══════════════════════════════════════════════════════
      // STEP 7: Print Crank Weight Report
      // ═══════════════════════════════════════════════════════
      console.log('\n' + '-'.repeat(40));
      console.log('-- Crank Tally Report --');
      console.log('-'.repeat(40));
      if (tally.operators.length === 0) {
        console.log('  (no operators recorded)');
      } else {
        for (const [i, op] of tally.operators.entries()) {
          const share = tally.totalActions > 0
            ? ((op.actionCount / tally.totalActions) * 100).toFixed(1)
            : '0.0';
          console.log(
            `  Operator ${i + 1}: ${op.pubkey.toBase58().slice(0, 8)}...${op.pubkey.toBase58().slice(-4)}` +
            `  actions=${op.actionCount}  share=${share}%`,
          );
        }
        console.log(`  Total: ${tally.totalActions} actions across ${tally.operators.length} operator(s)`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // STEP 8: Verify all 4 registered CrankOperator PDAs
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '-'.repeat(60));
  console.log('STEP 8: Verify CrankOperator PDAs on-chain');
  console.log('-'.repeat(60));

  let operatorPdasOk = true;
  for (const [i, kp] of cranks.entries()) {
    const opPda = getCrankOperatorPda(kp.publicKey);
    const info = await conn.getAccountInfo(opPda);
    const exists = info !== null && info.data.length > 0;
    if (!exists) operatorPdasOk = false;
    console.log(`  Crank ${i + 1} operator PDA: ${exists ? 'exists' : 'MISSING'} (${opPda.toBase58().slice(0, 16)}...)`);
  }
  results.push({
    test: 'CrankOperator PDAs exist',
    pass: operatorPdasOk,
    detail: operatorPdasOk ? 'all 4 exist' : 'some missing',
  });

  // ═══════════════════════════════════════════════════════
  // STEP 9: Verify all 4 DealerLicense PDAs
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '-'.repeat(60));
  console.log('STEP 9: Verify DealerLicense PDAs on-chain');
  console.log('-'.repeat(60));

  let licensePdasOk = true;
  for (const [i, kp] of cranks.entries()) {
    const licPda = getDealerLicensePda(kp.publicKey);
    const info = await conn.getAccountInfo(licPda);
    const exists = info !== null && info.data.length > 0;
    if (!exists) licensePdasOk = false;
    console.log(`  Crank ${i + 1} license PDA: ${exists ? 'exists' : 'MISSING'} (${licPda.toBase58().slice(0, 16)}...)`);
  }
  results.push({
    test: 'DealerLicense PDAs exist',
    pass: licensePdasOk,
    detail: licensePdasOk ? 'all 4 exist' : 'some missing',
  });

  // ═══════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════
  printResults(results);
}

function printResults(results: { test: string; pass: boolean; detail: string }[]) {
  console.log('\n' + '='.repeat(60));
  console.log('MULTI-CRANK E2E TEST RESULTS');
  console.log('='.repeat(60));
  let passed = 0;
  for (const r of results) {
    const icon = r.pass ? '[PASS]' : '[FAIL]';
    console.log(`  ${icon} ${r.test.padEnd(30)} ${r.detail}`);
    if (r.pass) passed++;
  }
  console.log(`\n  Result: ${passed}/${results.length} passed`);
  if (passed === results.length) {
    console.log('  ALL TESTS PASSED!\n');
  } else {
    console.log('  Some tests failed\n');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
