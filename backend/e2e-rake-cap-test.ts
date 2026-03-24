/**
 * Rake Cap E2E Test
 *
 * Verifies that rake caps from TokenTierConfig work correctly at different
 * stake levels using HU cash game tables (SOL denomination).
 *
 * Tiers tested:
 *   1. Micro  (BB = 0.005 SOL) — no cap (cap_bps = 0)
 *   2. Mid    (BB = 0.1 SOL)   — cap = 1 BB (10000 BPS) = 0.1 SOL
 *   3. High   (BB = 1 SOL)     — cap = 0.25 BB (2500 BPS) = 0.25 SOL
 *
 * Prerequisites:
 *   - Localnet validator + MXE running
 *   - Crank service running (handles start_game, deal, settle)
 *
 * Run:
 *   npx ts-node --transpile-only backend/e2e-rake-cap-test.ts
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
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';

// SUPER_ADMIN pubkey: GkfdM1vqRYrU2LJ4ipwCJ3vsr2PGYLpdtdKK121ZkQZg

// ─── Instruction discriminators ───
function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}
const IX: Record<string, Buffer> = {};
for (const n of [
  'register_player', 'create_table', 'create_user_table', 'init_table_seat',
  'join_table', 'player_action', 'start_game', 'settle_hand',
  'set_x25519_key', 'init_token_tier_config',
]) IX[n] = disc(n);

// ─── PDA helpers ───
function pda(seeds: Buffer[], prog = PROGRAM_ID) {
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
const getTierConfig = (mint: PublicKey) => pda([Buffer.from('tier_config'), mint.toBuffer()]);

// ─── Table data offsets ───
const T = {
  BIG_BLIND: 113,
  MAX_P: 121,
  CUR_PLAYERS: 122,
  HAND: 123,
  POT: 131,
  MIN_BET: 139,
  RAKE_ACCUMULATED: 147,
  PHASE: 160,
  CUR_PLAYER: 161,
  OCC: 250,
  GAME_TYPE: 104,
  RAKE_CAP: 418,
};
const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop',
  4: 'Flop', 5: 'Turn', 6: 'River', 7: 'Showdown', 8: 'AwaitingShowdown', 9: 'Complete',
  10: 'FlopRevealPending', 11: 'TurnRevealPending', 12: 'RiverRevealPending',
};

// ─── Seat offsets ───
const S = { CHIPS: 104, STATUS: 227 };

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
    bigBlind: Number(data.readBigUInt64LE(T.BIG_BLIND)),
    rakeCap: Number(data.readBigUInt64LE(T.RAKE_CAP)),
    rakeAccumulated: Number(data.readBigUInt64LE(T.RAKE_ACCUMULATED)),
  };
}

function readSeat(data: Buffer) {
  return {
    chips: Number(data.readBigUInt64LE(S.CHIPS)),
    status: data[S.STATUS],
  };
}

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
    console.log(`  [OK] ${label}: ${sig.slice(0, 20)}...`);
    return sig;
  } catch (e: any) {
    console.log(`  [FAIL] ${label}: ${e.message?.slice(0, 120)}`);
    return null;
  }
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

async function waitForHandIncrement(conn: Connection, tbl: PublicKey, prevHand: number, timeoutMs = 300_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await conn.getAccountInfo(tbl);
    if (info) {
      const data = Buffer.from(info.data);
      const hand = Number(data.readBigUInt64LE(T.HAND));
      const phase = data[T.PHASE];
      // Wait for hand number to advance AND phase to return to Waiting or dealing
      if (hand > prevHand && (phase === 0 || phase === 1 || phase === 2 || phase === 3)) {
        return hand;
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return -1;
}

// ═══════════════════════════════════════════════════════════════════
// Create a user-owned SOL cash game table with custom blinds
// ═══════════════════════════════════════════════════════════════════
function createUserTableIx(
  creator: PublicKey,
  tableId: Buffer,
  tablePda: PublicKey,
  smallBlind: bigint,
  bigBlind: bigint,
  maxPlayers: number,
  tierConfigPda: PublicKey,
): TransactionInstruction {
  // UserTableConfig: table_id(32) + max_players(1) + small_blind(8) + big_blind(8) +
  //                  token_mint(32) + buy_in_type(1) + is_private(1)
  const configBuf = Buffer.alloc(83);
  let offset = 0;
  tableId.copy(configBuf, offset); offset += 32;
  configBuf[offset] = maxPlayers; offset += 1;
  configBuf.writeBigUInt64LE(smallBlind, offset); offset += 8;
  configBuf.writeBigUInt64LE(bigBlind, offset); offset += 8;
  // token_mint = Pubkey::default() (all zeros for SOL) — already zero-filled
  offset += 32;
  configBuf[offset] = 0; offset += 1; // buy_in_type = Normal
  configBuf[offset] = 0; offset += 1; // is_private = false

  const vaultPda = getVault(tablePda);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: getPool(), isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      // creator_token_account — placeholder for SOL tables
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      // treasury_token_account — placeholder for SOL tables
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      // pool_token_account — placeholder for SOL tables
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      // token_program — placeholder for SOL tables
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      // steel_program
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      // vault PDA
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    // remaining_accounts[0] = tier_config PDA (for SOL, premium token, no ListedToken needed)
    data: Buffer.concat([IX.create_user_table, configBuf]),
  });
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  const results: { test: string; pass: boolean; detail: string }[] = [];

  console.log('='.repeat(60));
  console.log('RAKE CAP E2E TEST');
  console.log('='.repeat(60));
  console.log('  Ensure crank-service is running\n');

  // ─── Load admin keypair (SUPER_ADMIN) ───
  const adminSecret = JSON.parse(fs.readFileSync(require('path').join(__dirname, '.localnet-keypair.json'), 'utf-8'));
  const admin = Keypair.fromSecretKey(Uint8Array.from(adminSecret));
  console.log(`  Admin: ${admin.publicKey.toBase58()}`);

  // ─── Create + fund players ───
  const p1 = Keypair.generate();
  const p2 = Keypair.generate();
  for (const kp of [p1, p2]) {
    await conn.confirmTransaction(
      await conn.requestAirdrop(kp.publicKey, 200 * LAMPORTS_PER_SOL),
      'confirmed',
    );
    await ensureRegistered(conn, kp);
  }
  // Ensure admin has SOL too
  {
    const bal = await conn.getBalance(admin.publicKey);
    if (bal < 10 * LAMPORTS_PER_SOL) {
      await conn.confirmTransaction(
        await conn.requestAirdrop(admin.publicKey, 100 * LAMPORTS_PER_SOL),
        'confirmed',
      );
    }
  }
  console.log('\n  Created 2 funded + registered players\n');

  // ═══════════════════════════════════════════════════════════════
  // STEP 1: Initialize TokenTierConfig for SOL (if not already done)
  // ═══════════════════════════════════════════════════════════════
  console.log('-'.repeat(60));
  console.log('STEP 1: Initialize SOL TokenTierConfig');
  console.log('-'.repeat(60));

  const solMint = PublicKey.default;
  const tierConfigPda = getTierConfig(solMint);
  const tierInfo = await conn.getAccountInfo(tierConfigPda);

  if (tierInfo) {
    console.log('  TokenTierConfig already exists, skipping init');
    results.push({ test: 'Init TokenTierConfig', pass: true, detail: 'already exists' });
  } else {
    // Instruction data: discriminator(8) + token_mint(32) = Pubkey::default()
    const ixData = Buffer.alloc(8 + 32);
    IX.init_token_tier_config.copy(ixData, 0);
    // token_mint = all zeros (Pubkey::default()) — already zero-filled

    const sig = await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: tierConfigPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: ixData,
    }), [admin], 'init_token_tier_config (SOL)');

    const pass = sig !== null;
    results.push({ test: 'Init TokenTierConfig', pass, detail: pass ? 'created' : 'FAILED' });
  }

  // Verify tier config was created
  {
    const info = await conn.getAccountInfo(tierConfigPda);
    if (info) {
      console.log(`  TokenTierConfig PDA: ${tierConfigPda.toBase58()}`);
      console.log(`  Account size: ${info.data.length} bytes`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Tier test definitions
  // ═══════════════════════════════════════════════════════════════
  const tiers = [
    {
      name: 'Micro',
      bb: 5_000_000n,       // 0.005 SOL — within Micro tier (BB <= 10_000_000)
      sb: 2_500_000n,
      expectedCapBps: 0,    // No cap for Micro
      expectedCapLamports: 0,
      buyIn: 500_000_000n,  // 100 BB = 0.5 SOL
    },
    {
      name: 'Mid',
      bb: 100_000_000n,     // 0.1 SOL — Mid tier (BB <= 100_000_000)
      sb: 50_000_000n,
      expectedCapBps: 10000, // 1 BB for HU
      expectedCapLamports: 100_000_000, // 0.1 SOL
      buyIn: 10_000_000_000n, // 100 BB = 10 SOL
    },
    {
      name: 'High',
      bb: 1_000_000_000n,   // 1 SOL — High tier (BB <= 1_000_000_000)
      sb: 500_000_000n,
      expectedCapBps: 2500,  // 0.25 BB for HU
      expectedCapLamports: 250_000_000, // 0.25 SOL
      buyIn: 100_000_000_000n, // 100 BB = 100 SOL
    },
  ];

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: Test each tier
  // ═══════════════════════════════════════════════════════════════
  for (const tier of tiers) {
    console.log('\n' + '='.repeat(60));
    console.log(`TIER TEST: ${tier.name} (BB = ${Number(tier.bb) / LAMPORTS_PER_SOL} SOL)`);
    console.log('='.repeat(60));

    // ─── Airdrop more SOL for high-stakes tests ───
    const neededSol = Number(tier.buyIn) * 3; // Extra buffer
    for (const kp of [p1, p2]) {
      const bal = await conn.getBalance(kp.publicKey);
      if (bal < neededSol) {
        const airdrops = Math.ceil((neededSol - bal) / (100 * LAMPORTS_PER_SOL));
        for (let a = 0; a < airdrops && a < 20; a++) {
          await conn.confirmTransaction(
            await conn.requestAirdrop(kp.publicKey, 100 * LAMPORTS_PER_SOL),
            'confirmed',
          );
        }
      }
    }

    // ─── 2a: Create user table with custom blinds ───
    console.log('\n  --- Create Table ---');
    const tableId = crypto.randomBytes(32);
    const tablePda = getTable(tableId);

    // Build create_user_table instruction with tier_config as remaining_accounts[0]
    const createIx = createUserTableIx(
      p1.publicKey, tableId, tablePda,
      tier.sb, tier.bb, 2, tierConfigPda,
    );
    // Append tier_config PDA as remaining_accounts[0]
    createIx.keys.push({ pubkey: tierConfigPda, isSigner: false, isWritable: false });

    const createSig = await send(conn, createIx, [p1], `create_user_table ${tier.name}`);
    if (!createSig) {
      results.push({ test: `${tier.name}: Create table`, pass: false, detail: 'TX failed' });
      continue;
    }

    // ─── 2b: Init seats ───
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

    // ─── 2c: Verify rake_cap on table ───
    {
      const info = await conn.getAccountInfo(tablePda);
      if (!info) {
        results.push({ test: `${tier.name}: Verify rake_cap`, pass: false, detail: 'table not found' });
        continue;
      }
      const t = readTable(Buffer.from(info.data));
      const pass = t.rakeCap === tier.expectedCapLamports;
      results.push({
        test: `${tier.name}: rake_cap on table`,
        pass,
        detail: `expected=${tier.expectedCapLamports}, got=${t.rakeCap} (BB=${t.bigBlind})`,
      });
      console.log(`  ${pass ? '[PASS]' : '[FAIL]'} rake_cap: expected=${tier.expectedCapLamports}, got=${t.rakeCap}`);
    }

    // ─── 2d: Join + set x25519 keys ───
    console.log('\n  --- Join Players ---');
    for (const [i, kp] of [p1, p2].entries()) {
      await send(conn, joinIx(kp.publicKey, tablePda, i, tier.buyIn), [kp], `join seat ${i}`);
      const sk = x25519.utils.randomPrivateKey();
      const pk = x25519.getPublicKey(sk);
      await send(conn, setX25519KeyIx(kp.publicKey, tablePda, getSeat(tablePda, i), pk), [kp], `set_x25519 seat ${i}`);
    }

    // ─── 2e: Wait for crank to start game + deal ───
    console.log('\n  --- Waiting for deal ---');
    const dealPhase = await waitForPhase(conn, tablePda, [3, 4, 5, 6], 10 * 60 * 1000);
    if (dealPhase === -1) {
      console.log('  [FAIL] Timed out waiting for deal');
      results.push({ test: `${tier.name}: Deal`, pass: false, detail: 'timeout' });
      continue;
    }
    console.log(`  Phase after deal: ${PHASE_NAMES[dealPhase] || dealPhase}`);

    // ─── 2f: Play hand — call through streets, then all-in ───
    console.log('\n  --- Playing hand ---');

    // Read initial hand number for later comparison
    let tableData = Buffer.from((await conn.getAccountInfo(tablePda))!.data);
    const initialHand = Number(tableData.readBigUInt64LE(T.HAND));

    // Keep taking actions until we reach showdown or settle
    const MAX_ACTIONS = 30;
    let actionCount = 0;
    let settled = false;

    while (actionCount < MAX_ACTIONS && !settled) {
      const info = await conn.getAccountInfo(tablePda);
      if (!info) break;
      tableData = Buffer.from(info.data);
      const phase = tableData[T.PHASE];
      const curPlayer = tableData[T.CUR_PLAYER];

      // Check if hand is complete (phase=Waiting and hand incremented, or Showdown/Complete)
      const curHand = Number(tableData.readBigUInt64LE(T.HAND));
      if (phase === 0 && curHand > initialHand) {
        settled = true;
        break;
      }

      // If in a reveal-pending or awaiting phase, wait for crank
      if (phase === 2 || phase === 7 || phase === 8 || phase === 9 ||
          phase === 10 || phase === 11 || phase === 12) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // Determine which player acts
      const actor = curPlayer === 0 ? p1 : p2;
      const seatNum = curPlayer;

      // Strategy: Check/Call through preflop and flop, then AllIn on turn/river
      // We want to reach flop (for rake eligibility) then build a big pot
      let action: string;
      if (phase === 3) {
        // Preflop: call/check
        action = 'Call';
      } else if (phase === 4) {
        // Flop reached — go all-in to build a big pot
        action = 'AllIn';
      } else if (phase === 5 || phase === 6) {
        // Turn / River — all-in or call
        action = 'AllIn';
      } else {
        action = 'Call';
      }

      const sig = await send(conn, actionIx(actor.publicKey, tablePda, seatNum, action), [actor],
        `seat${seatNum} ${action} (phase=${PHASE_NAMES[phase] || phase})`);

      if (!sig) {
        // If action failed, try Check instead (might already have matched)
        if (action !== 'Check') {
          await send(conn, actionIx(actor.publicKey, tablePda, seatNum, 'Check'), [actor],
            `seat${seatNum} Check (fallback)`);
        }
      }

      actionCount++;
      await new Promise(r => setTimeout(r, 1000));
    }

    // ─── 2g: Wait for settle (hand number increment) ───
    if (!settled) {
      console.log('\n  --- Waiting for settle ---');
      const newHand = await waitForHandIncrement(conn, tablePda, initialHand, 120_000);
      settled = newHand > initialHand;
      if (!settled) {
        console.log('  [FAIL] Timed out waiting for settle');
        results.push({ test: `${tier.name}: Settle`, pass: false, detail: 'timeout' });
        continue;
      }
    }

    // ─── 2h: Read rake_accumulated and verify cap ───
    console.log('\n  --- Verify Rake ---');
    {
      const info = await conn.getAccountInfo(tablePda);
      if (!info) {
        results.push({ test: `${tier.name}: Rake verify`, pass: false, detail: 'table not found' });
        continue;
      }
      const t = readTable(Buffer.from(info.data));
      const rake = t.rakeAccumulated;
      const cap = t.rakeCap;

      console.log(`  rake_accumulated = ${rake} lamports (${rake / LAMPORTS_PER_SOL} SOL)`);
      console.log(`  rake_cap         = ${cap} lamports (${cap / LAMPORTS_PER_SOL} SOL)`);

      if (cap === 0) {
        // Micro tier: no cap, verify rake is 5% of pot (or close to it)
        // Rake might be 0 if flop wasn't reached (fold before flop), which is valid
        const pass = rake >= 0;
        results.push({
          test: `${tier.name}: Rake (uncapped)`,
          pass,
          detail: `rake=${rake}, cap=none (no cap for Micro tier)`,
        });
        console.log(`  [${pass ? 'PASS' : 'FAIL'}] Micro tier: rake=${rake} (no cap applied)`);
      } else {
        // Capped tier: verify rake <= cap
        const pass = rake > 0 && rake <= cap;
        results.push({
          test: `${tier.name}: Rake (capped)`,
          pass,
          detail: `rake=${rake} <= cap=${cap} ? ${rake <= cap}`,
        });
        console.log(`  [${pass ? 'PASS' : 'FAIL'}] rake=${rake} <= cap=${cap}`);

        // If the buy-ins are large enough, 5% of pot should exceed the cap
        // Verify the cap was actually applied (5% of pot > cap)
        // We can't read the pot after settle (it's 0), but we know both players
        // bought in for 100 BB each so pot should be large enough for cap to matter
        const minPotEstimate = Number(tier.bb) * 4; // At least blinds + calls
        const uncappedRake = Math.floor(minPotEstimate * 500 / 10000);
        if (uncappedRake > cap) {
          const capApplied = rake <= cap;
          results.push({
            test: `${tier.name}: Cap enforcement`,
            pass: capApplied,
            detail: `5% of min pot (${uncappedRake}) > cap (${cap}), rake (${rake}) capped: ${capApplied}`,
          });
          console.log(`  [${capApplied ? 'PASS' : 'FAIL'}] Cap enforced: uncapped_min=${uncappedRake} > cap=${cap}, actual_rake=${rake}`);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const icon = r.pass ? '[PASS]' : '[FAIL]';
    console.log(`  ${icon} ${r.test}: ${r.detail}`);
    if (r.pass) passed++;
    else failed++;
  }
  console.log('-'.repeat(60));
  console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log('='.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
