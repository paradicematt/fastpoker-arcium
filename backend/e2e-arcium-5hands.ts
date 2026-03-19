/**
 * 5-Hand Arcium MPC Timing Test
 *
 * Measures MPC computation times across 5 consecutive hands:
 *   Hand 1: Full street flow (deal → flop → turn → river → showdown → settle)
 *   Hands 2-5: Quick fold (deal → fold → settle)
 *
 * This reveals:
 *   - First-time preprocessing overhead vs cached execution
 *   - Per-circuit timing: shuffle_and_deal, reveal_community, reveal_player_cards
 *   - Whether preprocessing is stored between hands
 *
 * Requires: arcium localnet running + circuits initialized
 * Run: ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only e2e-arcium-5hands.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as crypto from 'crypto';
import {
  getMXEAccAddress, getMempoolAccAddress, getExecutingPoolAccAddress,
  getCompDefAccAddress, getCompDefAccOffset, getComputationAccAddress,
  getClusterAccAddress, getArciumProgramId, getArciumEnv,
  getArciumAccountBaseSeed, x25519,
} from '@arcium-hq/client';

// ── Constants ──
const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const ARCIUM_PROG_ID = getArciumProgramId();
const RPC_URL = 'http://127.0.0.1:8899';
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// PDA Seeds
const TABLE_SEED = Buffer.from('table');
const SEAT_SEED = Buffer.from('seat');
const SEAT_CARDS_SEED = Buffer.from('seat_cards');
const DECK_STATE_SEED = Buffer.from('deck_state');
const VAULT_SEED = Buffer.from('vault');
const RECEIPT_SEED = Buffer.from('receipt');
const PLAYER_SEED = Buffer.from('player');
const PLAYER_TABLE_SEED = Buffer.from('player_table');
const CRANK_TALLY_ER_SEED = Buffer.from('crank_tally_er');
const CRANK_TALLY_L1_SEED = Buffer.from('crank_tally_l1');
const UNREFINED_SEED = Buffer.from('unrefined');
const SIGN_PDA_SEED = Buffer.from('ArciumSignerAccount');

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
  arcium_deal: disc('arcium_deal'),
  player_action: disc('player_action'),
  arcium_reveal_queue: disc('arcium_reveal_queue'),
  arcium_showdown_queue: disc('arcium_showdown_queue'),
  settle_hand: disc('settle_hand'),
};

// PDA helpers
function findPda(seeds: Buffer[], programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}
const getTable = (id: Buffer) => findPda([TABLE_SEED, id]);
const getSeat = (table: PublicKey, i: number) => findPda([SEAT_SEED, table.toBuffer(), Buffer.from([i])]);
const getSeatCards = (table: PublicKey, i: number) => findPda([SEAT_CARDS_SEED, table.toBuffer(), Buffer.from([i])]);
const getDeckState = (table: PublicKey) => findPda([DECK_STATE_SEED, table.toBuffer()]);
const getVault = (table: PublicKey) => findPda([VAULT_SEED, table.toBuffer()]);
const getReceipt = (table: PublicKey, i: number) => findPda([RECEIPT_SEED, table.toBuffer(), Buffer.from([i])]);
const getPlayer = (wallet: PublicKey) => findPda([PLAYER_SEED, wallet.toBuffer()]);
const getMarker = (wallet: PublicKey, table: PublicKey) => findPda([PLAYER_TABLE_SEED, wallet.toBuffer(), table.toBuffer()]);
const getCrankEr = (table: PublicKey) => findPda([CRANK_TALLY_ER_SEED, table.toBuffer()]);
const getCrankL1 = (table: PublicKey) => findPda([CRANK_TALLY_L1_SEED, table.toBuffer()]);
const getPool = () => findPda([Buffer.from('pool')], STEEL_PROGRAM_ID);
const getUnrefined = (wallet: PublicKey) => findPda([UNREFINED_SEED, wallet.toBuffer()], STEEL_PROGRAM_ID);
const getSignPda = () => findPda([SIGN_PDA_SEED]);

function getArciumClockPda(): PublicKey {
  return PublicKey.findProgramAddressSync([getArciumAccountBaseSeed('ClockAccount')], ARCIUM_PROG_ID)[0];
}
function getArciumFeePoolPda(): PublicKey {
  return PublicKey.findProgramAddressSync([getArciumAccountBaseSeed('FeePool')], ARCIUM_PROG_ID)[0];
}

// Card display
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
function cardName(idx: number): string {
  if (idx === 255) return '??';
  if (idx < 0 || idx > 51) return `INVALID(${idx})`;
  return RANKS[idx % 13] + SUITS[Math.floor(idx / 13)];
}

const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop',
  4: 'Flop', 5: 'Turn', 6: 'River', 7: 'Showdown',
  8: 'AwaitingShowdown', 9: 'Complete',
  10: 'FlopRevealPending', 11: 'TurnRevealPending', 12: 'RiverRevealPending',
};

// Table offsets
const T_PHASE = 160;
const T_CUR_PLAYER = 161;
const T_COMM = 155; // community_cards[5]
const T_MAX_P = 121;
const T_OCC = 250;
const T_HAND = 123;
const T_REVEALED_HANDS = 175; // revealed_hands[18]

function readPhase(data: Buffer): number { return data.readUInt8(T_PHASE); }

// PokerAction serialization
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

// ── Timing tracker ──
interface TimingEntry { hand: number; operation: string; durationMs: number; }
const timings: TimingEntry[] = [];

function recordTiming(hand: number, operation: string, startMs: number) {
  const dur = Date.now() - startMs;
  timings.push({ hand, operation, durationMs: dur });
  console.log(`  ⏱  ${operation}: ${(dur / 1000).toFixed(1)}s`);
}

// ── TX helpers ──
async function send(conn: Connection, ix: TransactionInstruction, signers: Keypair[], label: string): Promise<boolean> {
  try {
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed', skipPreflight: true });
    console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
    return true;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0, 200)}`);
    if (e.logs) e.logs.slice(-5).forEach((l: string) => console.log(`     ${l}`));
    return false;
  }
}

async function airdrop(conn: Connection, pk: PublicKey, amount: number) {
  const sig = await conn.requestAirdrop(pk, amount);
  await conn.confirmTransaction(sig, 'confirmed');
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  const testStart = Date.now();

  console.log('═'.repeat(70));
  console.log('  ARCIUM MPC 5-HAND TIMING TEST');
  console.log('═'.repeat(70));
  console.log(`  RPC: ${RPC_URL}`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);

  // Verify connectivity
  try { const slot = await conn.getSlot(); console.log(`  Slot: ${slot}`); }
  catch { console.error('Cannot connect to validator.'); process.exit(1); }

  // Arcium setup
  const arciumEnv = getArciumEnv();
  const clusterOffset = arciumEnv.arciumClusterOffset;
  const clusterAccount = getClusterAccAddress(clusterOffset);
  const mxeAccount = getMXEAccAddress(PROGRAM_ID);

  // Fresh keypairs
  const admin = Keypair.generate();
  const playerA = Keypair.generate();
  const playerB = Keypair.generate();
  const crank = Keypair.generate();

  // x25519 keys for MPC encryption
  const playerKeys = [0, 1].map(() => {
    const sk = x25519.utils.randomPrivateKey();
    return { secretKey: sk, publicKey: x25519.getPublicKey(sk) };
  });

  console.log('\n  Funding wallets...');
  for (const kp of [admin, playerA, playerB, crank]) await airdrop(conn, kp.publicKey, 20 * LAMPORTS_PER_SOL);
  try { await airdrop(conn, TREASURY, 1 * LAMPORTS_PER_SOL); } catch {}

  // Register players
  for (const kp of [playerA, playerB]) {
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: kp.publicKey, isSigner: true, isWritable: true },
        { pubkey: getPlayer(kp.publicKey), isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: getPool(), isSigner: false, isWritable: true },
        { pubkey: getUnrefined(kp.publicKey), isSigner: false, isWritable: true },
        { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: IX.register_player,
    }), [kp], 'register');
  }

  // Create table
  const tableId = crypto.randomBytes(32);
  const tablePDA = getTable(tableId);
  const maxP = 2;
  {
    const cfg = Buffer.alloc(36); tableId.copy(cfg); cfg[32] = 3; cfg[34] = maxP;
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePDA, isSigner: false, isWritable: true },
        { pubkey: getPool(), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: Buffer.concat([IX.create_table, cfg]),
    }), [admin], 'create_table');

    for (let i = 0; i < maxP; i++) await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePDA, isSigner: false, isWritable: false },
        { pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getSeatCards(tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getDeckState(tablePDA), isSigner: false, isWritable: true },
        { pubkey: getReceipt(tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getVault(tablePDA), isSigner: false, isWritable: true },
        { pubkey: getCrankEr(tablePDA), isSigner: false, isWritable: true },
        { pubkey: getCrankL1(tablePDA), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: Buffer.concat([IX.init_table_seat, Buffer.from([i])]),
    }), [admin], `init_seat_${i}`);
  }

  // Join players with x25519 keys
  for (let i = 0; i < 2; i++) {
    const player = i === 0 ? playerA : playerB;
    const d = Buffer.alloc(25); IX.join_table.copy(d); d.writeBigUInt64LE(100000n, 8); d[16] = i;
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: getPlayer(player.publicKey), isSigner: false, isWritable: true },
        { pubkey: tablePDA, isSigner: false, isWritable: true },
        { pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getMarker(player.publicKey, tablePDA), isSigner: false, isWritable: true },
        { pubkey: getVault(tablePDA), isSigner: false, isWritable: true },
        { pubkey: getReceipt(tablePDA, i), isSigner: false, isWritable: true },
        ...Array(6).fill({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false }),
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: d,
    }), [player], `join_seat_${i}`);

    // Set x25519 key — takes [u8;32]
    const keyData = Buffer.alloc(8 + 32);
    disc('set_x25519_key').copy(keyData, 0);
    Buffer.from(playerKeys[i].publicKey).copy(keyData, 8);
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: false },
        { pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true },
      ], data: keyData,
    }), [player], `set_x25519_key_${i}`);
  }

  // ── Helper functions ──

  function readTableData(data: Buffer) {
    return {
      phase: data[T_PHASE],
      curPlayer: data[T_CUR_PLAYER],
      maxP: data[T_MAX_P],
      occ: data.readUInt16LE(T_OCC),
      hand: Number(data.readBigUInt64LE(T_HAND)),
      community: Array.from(data.slice(T_COMM, T_COMM + 5)),
    };
  }

  async function getTableState() {
    const info = await conn.getAccountInfo(tablePDA);
    if (!info) throw new Error('Table not found');
    return readTableData(Buffer.from(info.data));
  }

  async function playerAction(player: Keypair, seat: number, action: string, amount?: bigint): Promise<boolean> {
    return send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: false },
        { pubkey: tablePDA, isSigner: false, isWritable: true },
        { pubkey: getSeat(tablePDA, seat), isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      ], data: Buffer.concat([IX.player_action, serializeAction(action, amount)]),
    }), [player], `${action}(seat${seat})`);
  }

  /** Queue arcium_deal and wait for MPC callback. Returns time in ms. */
  async function arciumDealAndWait(handNum: number): Promise<number> {
    const compOffset = BigInt(Date.now()) * BigInt(1000) + BigInt(handNum);
    const compDefOffset = Buffer.from(getCompDefAccOffset('shuffle_and_deal')).readUInt32LE(0);
    const compOffsetBuf = Buffer.alloc(8);
    compOffsetBuf.writeBigUInt64LE(compOffset);
    const computationAccount = getComputationAccAddress(
      clusterOffset,
      { toArrayLike: (_B: any, _e: string, l: number) => { const b = Buffer.alloc(l); compOffsetBuf.copy(b); return b; } } as any,
    );
    const compDefAccount = getCompDefAccAddress(PROGRAM_ID, compDefOffset);

    // Build player_data: Vec<u8> = [pubkey(32) + nonce_le(16)] × 9 seats
    const playerDataParts: Buffer[] = [];
    for (let s = 0; s < 9; s++) {
      if (s < 2) {
        const pubkeyBuf = Buffer.from(playerKeys[s].publicKey);
        const nonceBuf = Buffer.alloc(16); nonceBuf.writeBigUInt64LE(BigInt(handNum * 10 + s + 1), 0);
        playerDataParts.push(Buffer.concat([pubkeyBuf, nonceBuf]));
      } else {
        // Dummy non-zero x25519 key for empty seats
        const dummySk = x25519.utils.randomPrivateKey();
        const dummyPk = x25519.getPublicKey(dummySk);
        const nonceBuf = Buffer.alloc(16); nonceBuf.writeBigUInt64LE(BigInt(1), 0);
        playerDataParts.push(Buffer.concat([Buffer.from(dummyPk), nonceBuf]));
      }
    }
    const playerDataVec = Buffer.concat(playerDataParts); // 9 × 48 = 432

    // IX data: disc(8) + comp_offset(8) + player_data_len(4) + player_data(432) + num_players(1) = 453
    const dealData = Buffer.alloc(8 + 8 + 4 + 432 + 1);
    IX.arcium_deal.copy(dealData, 0);
    dealData.writeBigUInt64LE(compOffset, 8);
    dealData.writeUInt32LE(432, 16); // Vec length prefix
    playerDataVec.copy(dealData, 20);
    dealData[452] = 2; // num_players

    const ok = await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: playerA.publicKey,          isSigner: true,  isWritable: true },
        { pubkey: getSignPda(),               isSigner: false, isWritable: true },
        { pubkey: mxeAccount,                 isSigner: false, isWritable: false },
        { pubkey: getMempoolAccAddress(clusterOffset), isSigner: false, isWritable: true },
        { pubkey: getExecutingPoolAccAddress(clusterOffset), isSigner: false, isWritable: true },
        { pubkey: computationAccount,         isSigner: false, isWritable: true },
        { pubkey: compDefAccount,             isSigner: false, isWritable: false },
        { pubkey: clusterAccount,             isSigner: false, isWritable: true },
        { pubkey: getArciumFeePoolPda(),      isSigner: false, isWritable: true },
        { pubkey: getArciumClockPda(),        isSigner: false, isWritable: true },
        { pubkey: ARCIUM_PROG_ID,             isSigner: false, isWritable: false },
        { pubkey: tablePDA,                   isSigner: false, isWritable: true },
        { pubkey: getDeckState(tablePDA),     isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
      ],
      data: dealData,
    }), [playerA], `arcium_deal(h${handNum})`);
    if (!ok) return -1;

    // Wait for callback
    const start = Date.now();
    while (Date.now() - start < 20 * 60 * 1000) {
      const tInfo = await conn.getAccountInfo(tablePDA);
      if (tInfo) {
        const phase = readPhase(Buffer.from(tInfo.data));
        if (phase !== 2) { // No longer AwaitingDeal
          if (phase === 3) return Date.now() - start; // Preflop = success
          console.log(`  ❌ Deal callback failed. Phase: ${PHASE_NAMES[phase] || phase}`);
          return -1;
        }
      }
      const elapsed = Math.round((Date.now() - start) / 1000);
      process.stdout.write(`\r  Polling deal... ${elapsed}s   `);
      await new Promise(r => setTimeout(r, 2000));
    }
    return -1;
  }

  /** Queue reveal and wait. Returns time in ms. */
  async function queueRevealAndWait(numToReveal: number, pendingPhase: number, expectedPhase: number, label: string): Promise<number> {
    const compOffset = BigInt(Date.now()) * BigInt(1000) + BigInt(numToReveal);
    const revealCompDefOffset = Buffer.from(getCompDefAccOffset('reveal_community')).readUInt32LE(0);
    const compOffsetBuf = Buffer.alloc(8);
    compOffsetBuf.writeBigUInt64LE(compOffset);
    const computationAccount = getComputationAccAddress(
      clusterOffset,
      { toArrayLike: (_B: any, _e: string, l: number) => { const b = Buffer.alloc(l); compOffsetBuf.copy(b); return b; } } as any,
    );
    const compDefAccount = getCompDefAccAddress(PROGRAM_ID, revealCompDefOffset);

    const revealData = Buffer.alloc(17);
    IX.arcium_reveal_queue.copy(revealData, 0);
    revealData.writeBigUInt64LE(compOffset, 8);
    revealData.writeUInt8(numToReveal, 16);

    const ok = await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: playerA.publicKey,          isSigner: true,  isWritable: true },
        { pubkey: getSignPda(),               isSigner: false, isWritable: true },
        { pubkey: mxeAccount,                 isSigner: false, isWritable: false },
        { pubkey: getMempoolAccAddress(clusterOffset), isSigner: false, isWritable: true },
        { pubkey: getExecutingPoolAccAddress(clusterOffset), isSigner: false, isWritable: true },
        { pubkey: computationAccount,         isSigner: false, isWritable: true },
        { pubkey: compDefAccount,             isSigner: false, isWritable: false },
        { pubkey: clusterAccount,             isSigner: false, isWritable: true },
        { pubkey: getArciumFeePoolPda(),      isSigner: false, isWritable: true },
        { pubkey: getArciumClockPda(),        isSigner: false, isWritable: true },
        { pubkey: ARCIUM_PROG_ID,             isSigner: false, isWritable: false },
        { pubkey: tablePDA,                   isSigner: false, isWritable: true },
        { pubkey: getDeckState(tablePDA),     isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
      ],
      data: revealData,
    }), [playerA], label);
    if (!ok) return -1;

    const start = Date.now();
    while (Date.now() - start < 10 * 60 * 1000) {
      const tInfo = await conn.getAccountInfo(tablePDA);
      if (tInfo) {
        const p = readPhase(Buffer.from(tInfo.data));
        if (p !== pendingPhase) {
          if (p === expectedPhase) return Date.now() - start;
          console.log(`  ❌ ${label} failed. Phase: ${PHASE_NAMES[p] || p}`);
          return -1;
        }
      }
      const elapsed = Math.round((Date.now() - start) / 1000);
      process.stdout.write(`\r  Polling ${label}... ${elapsed}s   `);
      await new Promise(r => setTimeout(r, 2000));
    }
    return -1;
  }

  /** Queue showdown reveals for both players and wait. Returns time in ms. */
  async function queueShowdownAndWait(): Promise<number> {
    const showCompDefOffset = Buffer.from(getCompDefAccOffset('reveal_player_cards')).readUInt32LE(0);
    const showCompDefAccount = getCompDefAccAddress(PROGRAM_ID, showCompDefOffset);

    for (const seatIdx of [0, 1]) {
      const showCompOffset = BigInt(Date.now()) * BigInt(1000) + BigInt(seatIdx);
      const showCompOffsetBuf = Buffer.alloc(8);
      showCompOffsetBuf.writeBigUInt64LE(showCompOffset);
      const showComputationAccount = getComputationAccAddress(
        clusterOffset,
        { toArrayLike: (_B: any, _e: string, l: number) => { const b = Buffer.alloc(l); showCompOffsetBuf.copy(b); return b; } } as any,
      );

      const showData = Buffer.alloc(17);
      IX.arcium_showdown_queue.copy(showData, 0);
      showData.writeBigUInt64LE(showCompOffset, 8);
      showData.writeUInt8(seatIdx, 16);

      const seatCardsPda = findPda([SEAT_CARDS_SEED, tablePDA.toBuffer(), Buffer.from([seatIdx])]);

      const ok = await send(conn, new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: playerA.publicKey,          isSigner: true,  isWritable: true },
          { pubkey: getSignPda(),               isSigner: false, isWritable: true },
          { pubkey: mxeAccount,                 isSigner: false, isWritable: false },
          { pubkey: getMempoolAccAddress(clusterOffset), isSigner: false, isWritable: true },
          { pubkey: getExecutingPoolAccAddress(clusterOffset), isSigner: false, isWritable: true },
          { pubkey: showComputationAccount,     isSigner: false, isWritable: true },
          { pubkey: showCompDefAccount,         isSigner: false, isWritable: false },
          { pubkey: clusterAccount,             isSigner: false, isWritable: true },
          { pubkey: getArciumFeePoolPda(),      isSigner: false, isWritable: true },
          { pubkey: getArciumClockPda(),        isSigner: false, isWritable: true },
          { pubkey: ARCIUM_PROG_ID,             isSigner: false, isWritable: false },
          { pubkey: tablePDA,                   isSigner: false, isWritable: true },
          { pubkey: getDeckState(tablePDA),     isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
          { pubkey: seatCardsPda,               isSigner: false, isWritable: false },
        ],
        data: showData,
      }), [playerA], `showdown_queue(seat${seatIdx})`);
      if (!ok) return -1;
      await new Promise(r => setTimeout(r, 500));
    }

    const start = Date.now();
    while (Date.now() - start < 20 * 60 * 1000) {
      const tInfo = await conn.getAccountInfo(tablePDA);
      if (tInfo) {
        const p = readPhase(Buffer.from(tInfo.data));
        if (p !== 8) { // No longer AwaitingShowdown
          if (p === 7) return Date.now() - start;
          console.log(`  ❌ Showdown failed. Phase: ${PHASE_NAMES[p] || p}`);
          return -1;
        }
      }
      const elapsed = Math.round((Date.now() - start) / 1000);
      process.stdout.write(`\r  Polling showdown... ${elapsed}s   `);
      await new Promise(r => setTimeout(r, 2000));
    }
    return -1;
  }

  async function settleHand(): Promise<boolean> {
    const s = await getTableState();
    const keys = [
      { pubkey: crank.publicKey, isSigner: false, isWritable: false },
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: getDeckState(tablePDA), isSigner: false, isWritable: true },
    ];
    for (let i = 0; i < s.maxP; i++) if (s.occ & (1 << i)) keys.push({ pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true });
    for (let i = 0; i < s.maxP; i++) if (s.occ & (1 << i)) keys.push({ pubkey: getSeatCards(tablePDA, i), isSigner: false, isWritable: true });
    return send(conn, new TransactionInstruction({ programId: PROGRAM_ID, keys, data: IX.settle_hand }), [crank], 'settle_hand');
  }

  async function startGame(): Promise<boolean> {
    const s = await getTableState();
    const keys = [
      { pubkey: crank.publicKey, isSigner: false, isWritable: false },
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: getDeckState(tablePDA), isSigner: false, isWritable: true },
    ];
    for (let i = 0; i < s.maxP; i++) if (s.occ & (1 << i)) keys.push({ pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true });
    return send(conn, new TransactionInstruction({ programId: PROGRAM_ID, keys, data: IX.start_game }), [crank], 'start_game');
  }

  /** Betting round: check/check through to next phase. */
  async function bettingRound(streetName: string): Promise<boolean> {
    const s = await getTableState();
    const curP = s.curPlayer;
    const sbSeat = (await conn.getAccountInfo(tablePDA))!.data[164];
    const bbSeat = (await conn.getAccountInfo(tablePDA))!.data[165];
    const bbPlayer = bbSeat === 0 ? playerA : playerB;
    const sbPlayer = sbSeat === 0 ? playerA : playerB;
    // Post-flop HU: BB (non-dealer) acts first
    if (!await playerAction(bbPlayer, bbSeat, 'Check')) return false;
    if (!await playerAction(sbPlayer, sbSeat, 'Check')) return false;
    const afterPhase = (await getTableState()).phase;
    console.log(`  Phase after ${streetName}: ${PHASE_NAMES[afterPhase]} (${afterPhase})`);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // HAND LOOP
  // ═══════════════════════════════════════════════════════════════════

  const NUM_HANDS = 5;

  for (let h = 0; h < NUM_HANDS; h++) {
    const handStart = Date.now();
    console.log(`\n${'━'.repeat(70)}`);
    console.log(`  HAND ${h + 1} of ${NUM_HANDS}${h === 0 ? ' (FULL STREET — all MPC ops)' : ' (QUICK FOLD)'}`);
    console.log(`${'━'.repeat(70)}`);

    // ── Start game ──
    const s = await getTableState();
    if (s.phase !== 0) {
      console.log(`  ❌ Expected Waiting (0), got ${PHASE_NAMES[s.phase]} (${s.phase})`);
      break;
    }
    console.log(`  Hand #${s.hand}, phase=Waiting`);
    if (!await startGame()) { console.log('  ❌ start_game failed'); break; }

    // ── Arcium MPC Deal ──
    const dealStart = Date.now();
    const dealMs = await arciumDealAndWait(h);
    if (dealMs < 0) { console.log('\n  ❌ Deal failed'); break; }
    console.log('');
    recordTiming(h + 1, 'shuffle_and_deal', dealStart);

    if (h === 0) {
      // ═══════════ HAND 1: Full streets ═══════════

      // Preflop: fold to FlopRevealPending
      const preS = await getTableState();
      const curP = preS.curPlayer;
      const sbSeat = (await conn.getAccountInfo(tablePDA))!.data[164];
      const bbSeat = (await conn.getAccountInfo(tablePDA))!.data[165];
      console.log(`  Preflop: curPlayer=${curP}, sb=${sbSeat}, bb=${bbSeat}`);

      // SB calls, BB checks → FlopRevealPending
      const sbPlayer = sbSeat === 0 ? playerA : playerB;
      const bbPlayer = bbSeat === 0 ? playerA : playerB;
      await playerAction(sbPlayer, sbSeat, 'Call');
      await playerAction(bbPlayer, bbSeat, 'Check');

      let afterPreflop = (await getTableState()).phase;
      console.log(`  Phase after preflop: ${PHASE_NAMES[afterPreflop]} (${afterPreflop})`);

      // ── Flop Reveal ──
      if (afterPreflop === 10) { // FlopRevealPending
        const flopStart = Date.now();
        const flopMs = await queueRevealAndWait(3, 10, 4, 'flop_reveal');
        if (flopMs > 0) {
          console.log('');
          recordTiming(h + 1, 'reveal_community (flop)', flopStart);
          const comm = (await getTableState()).community;
          console.log(`  Board: ${comm.slice(0, 3).map(c => cardName(c)).join(' ')}`);

          // Flop betting → TurnRevealPending
          await bettingRound('Flop');

          // ── Turn Reveal ──
          const turnStart = Date.now();
          const turnMs = await queueRevealAndWait(4, 11, 5, 'turn_reveal');
          if (turnMs > 0) {
            console.log('');
            recordTiming(h + 1, 'reveal_community (turn)', turnStart);
            const comm2 = (await getTableState()).community;
            console.log(`  Board: ${comm2.slice(0, 4).map(c => cardName(c)).join(' ')}`);

            // Turn betting → RiverRevealPending
            await bettingRound('Turn');

            // ── River Reveal ──
            const riverStart = Date.now();
            const riverMs = await queueRevealAndWait(5, 12, 6, 'river_reveal');
            if (riverMs > 0) {
              console.log('');
              recordTiming(h + 1, 'reveal_community (river)', riverStart);
              const comm3 = (await getTableState()).community;
              console.log(`  Board: ${comm3.map(c => cardName(c)).join(' ')}`);

              // River betting → Showdown
              await bettingRound('River');

              // ── Showdown Reveal ──
              const showStart = Date.now();
              const showMs = await queueShowdownAndWait();
              if (showMs > 0) {
                console.log('');
                recordTiming(h + 1, 'reveal_player_cards (showdown)', showStart);

                // Read revealed hands
                const tblData = (await conn.getAccountInfo(tablePDA))!.data;
                const rh = Array.from(tblData.slice(T_REVEALED_HANDS, T_REVEALED_HANDS + 4));
                console.log(`  Player A: ${cardName(rh[0])} ${cardName(rh[1])}`);
                console.log(`  Player B: ${cardName(rh[2])} ${cardName(rh[3])}`);
              }
            }
          }
        }
      }

      // Settle
      const settlePhase = (await getTableState()).phase;
      console.log(`  Pre-settle phase: ${PHASE_NAMES[settlePhase]} (${settlePhase})`);
      if (settlePhase === 7) {
        await settleHand();
      } else {
        console.log(`  ⚠️  Unexpected phase for settle — trying anyway`);
        await settleHand();
      }
    } else {
      // ═══════════ HANDS 2-5: Quick fold ═══════════
      const preS = await getTableState();
      const curP = preS.curPlayer;
      const folder = curP === 0 ? playerA : playerB;
      console.log(`  Preflop fold: curPlayer=${curP}`);
      await playerAction(folder, curP, 'Fold');

      // Settle
      const settlePhase = (await getTableState()).phase;
      if (settlePhase === 7) {
        await settleHand();
      }
    }

    // Verify back to Waiting
    const endState = await getTableState();
    const handMs = Date.now() - handStart;
    recordTiming(h + 1, `TOTAL HAND`, handStart);
    console.log(`  End: phase=${PHASE_NAMES[endState.phase]}, hand=${endState.hand}`);

    if (endState.phase !== 0) {
      console.log(`  ❌ Expected Waiting after settle, got ${PHASE_NAMES[endState.phase]}`);
      break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // TIMING SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  const totalTime = Date.now() - testStart;
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  TIMING SUMMARY');
  console.log(`${'═'.repeat(70)}`);
  console.log('');
  console.log('  ┌──────┬─────────────────────────────────┬──────────┐');
  console.log('  │ Hand │ Operation                       │ Time     │');
  console.log('  ├──────┼─────────────────────────────────┼──────────┤');
  for (const t of timings) {
    const handStr = String(t.hand).padStart(4);
    const opStr = t.operation.padEnd(31);
    const timeStr = `${(t.durationMs / 1000).toFixed(1)}s`.padStart(8);
    console.log(`  │ ${handStr} │ ${opStr} │ ${timeStr} │`);
  }
  console.log('  └──────┴─────────────────────────────────┴──────────┘');
  console.log('');

  // Extract shuffle times for comparison
  const shuffleTimes = timings.filter(t => t.operation === 'shuffle_and_deal');
  if (shuffleTimes.length >= 2) {
    const first = shuffleTimes[0].durationMs;
    const rest = shuffleTimes.slice(1);
    const avgRest = rest.reduce((a, t) => a + t.durationMs, 0) / rest.length;
    console.log(`  📊 First shuffle: ${(first / 1000).toFixed(1)}s (includes preprocessing)`);
    console.log(`  📊 Avg subsequent: ${(avgRest / 1000).toFixed(1)}s (cached)`);
    console.log(`  📊 Speedup: ${(first / avgRest).toFixed(1)}x`);
    if (avgRest < first * 0.5) {
      console.log('  ✅ Preprocessing IS cached between hands!');
    } else {
      console.log('  ⚠️  Preprocessing may NOT be cached (similar times)');
    }
  }
  console.log('');
  console.log(`  Total test time: ${(totalTime / 1000).toFixed(0)}s`);
  console.log('');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
