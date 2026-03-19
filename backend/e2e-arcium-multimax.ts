/**
 * 6-Max / 9-Max Arcium MPC Test
 *
 * Tests multi-player MPC operations:
 *   Test 1: 3-player on 6-max table (full hand + showdown + settle)
 *   Test 2: 6-player on 6-max table (full hand + showdown + settle)
 *
 * Verifies that shuffle_and_deal SIZE=960 (30 raw slots) covers all players,
 * showdown reveals work for multiple seats, and settle evaluates correctly.
 *
 * Requires: arcium localnet running + circuits initialized
 * Run: ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only e2e-arcium-multimax.ts
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
const T_COMM = 155;
const T_MAX_P = 121;
const T_OCC = 250;
const T_HAND = 123;
const T_REVEALED_HANDS = 175;
const T_DEALER = 163;
const T_SB = 164;
const T_BB = 165;
const T_ALLIN = 252;  // seats_allin u16
const T_FOLDED = 254; // seats_folded u16

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
// Multi-player test runner
// ═══════════════════════════════════════════════════════════════════

interface TestConfig {
  label: string;
  maxPlayers: number;  // table capacity (e.g. 6 or 9)
  numPlayers: number;  // active players for this test
}

async function runMultiPlayerTest(conn: Connection, config: TestConfig) {
  const { label, maxPlayers, numPlayers } = config;
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  TEST: ${label}`);
  console.log(`  Table: ${maxPlayers}-max, ${numPlayers} players`);
  console.log(`${'═'.repeat(70)}`);

  // Arcium setup
  const arciumEnv = getArciumEnv();
  const clusterOffset = arciumEnv.arciumClusterOffset;
  const clusterAccount = getClusterAccAddress(clusterOffset);
  const mxeAccount = getMXEAccAddress(PROGRAM_ID);

  // Create players
  const admin = Keypair.generate();
  const crank = Keypair.generate();
  const players: Keypair[] = [];
  const playerX25519Keys: { secretKey: Uint8Array; publicKey: Uint8Array }[] = [];
  for (let i = 0; i < numPlayers; i++) {
    players.push(Keypair.generate());
    const sk = x25519.utils.randomPrivateKey();
    playerX25519Keys.push({ secretKey: sk, publicKey: x25519.getPublicKey(sk) });
  }

  console.log('\n  Funding wallets...');
  for (const kp of [admin, crank, ...players]) await airdrop(conn, kp.publicKey, 20 * LAMPORTS_PER_SOL);
  try { await airdrop(conn, TREASURY, 1 * LAMPORTS_PER_SOL); } catch {}

  // Register players
  for (const kp of players) {
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
  {
    const cfg = Buffer.alloc(36); tableId.copy(cfg); cfg[32] = 3; cfg[34] = maxPlayers;
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePDA, isSigner: false, isWritable: true },
        { pubkey: getPool(), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: Buffer.concat([IX.create_table, cfg]),
    }), [admin], 'create_table');

    for (let i = 0; i < maxPlayers; i++) await send(conn, new TransactionInstruction({
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

  // Join players + set x25519 keys
  for (let i = 0; i < numPlayers; i++) {
    const d = Buffer.alloc(25); IX.join_table.copy(d); d.writeBigUInt64LE(100000n, 8); d[16] = i;
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: players[i].publicKey, isSigner: true, isWritable: true },
        { pubkey: getPlayer(players[i].publicKey), isSigner: false, isWritable: true },
        { pubkey: tablePDA, isSigner: false, isWritable: true },
        { pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getMarker(players[i].publicKey, tablePDA), isSigner: false, isWritable: true },
        { pubkey: getVault(tablePDA), isSigner: false, isWritable: true },
        { pubkey: getReceipt(tablePDA, i), isSigner: false, isWritable: true },
        ...Array(6).fill({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false }),
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: d,
    }), [players[i]], `join_seat_${i}`);

    const keyData = Buffer.alloc(8 + 32);
    disc('set_x25519_key').copy(keyData, 0);
    Buffer.from(playerX25519Keys[i].publicKey).copy(keyData, 8);
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: players[i].publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePDA, isSigner: false, isWritable: false },
        { pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true },
      ], data: keyData,
    }), [players[i]], `set_x25519_key_${i}`);
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
      dealer: data[T_DEALER],
      sb: data[T_SB],
      bb: data[T_BB],
      folded: data.readUInt16LE(T_FOLDED),
    };
  }

  async function getTableState() {
    const info = await conn.getAccountInfo(tablePDA);
    if (!info) throw new Error('Table not found');
    return readTableData(Buffer.from(info.data));
  }

  async function playerAction(playerIdx: number, action: string, amount?: bigint): Promise<boolean> {
    return send(conn, new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: players[playerIdx].publicKey, isSigner: true, isWritable: false },
        { pubkey: tablePDA, isSigner: false, isWritable: true },
        { pubkey: getSeat(tablePDA, playerIdx), isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      ], data: Buffer.concat([IX.player_action, serializeAction(action, amount)]),
    }), [players[playerIdx]], `${action}(seat${playerIdx})`);
  }

  async function startGame(): Promise<boolean> {
    const s = await getTableState();
    const keys: any[] = [
      { pubkey: crank.publicKey, isSigner: false, isWritable: false },
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: getDeckState(tablePDA), isSigner: false, isWritable: true },
    ];
    for (let i = 0; i < s.maxP; i++) if (s.occ & (1 << i)) keys.push({ pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true });
    return send(conn, new TransactionInstruction({ programId: PROGRAM_ID, keys, data: IX.start_game }), [crank], 'start_game');
  }

  async function settleHand(): Promise<boolean> {
    const s = await getTableState();
    const keys: any[] = [
      { pubkey: crank.publicKey, isSigner: false, isWritable: false },
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: getDeckState(tablePDA), isSigner: false, isWritable: true },
    ];
    for (let i = 0; i < s.maxP; i++) if (s.occ & (1 << i)) keys.push({ pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true });
    for (let i = 0; i < s.maxP; i++) if (s.occ & (1 << i)) keys.push({ pubkey: getSeatCards(tablePDA, i), isSigner: false, isWritable: true });
    return send(conn, new TransactionInstruction({ programId: PROGRAM_ID, keys, data: IX.settle_hand }), [crank], 'settle_hand');
  }

  /** Queue arcium_deal and wait for callback → Preflop. */
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
      if (s < numPlayers) {
        const pubkeyBuf = Buffer.from(playerX25519Keys[s].publicKey);
        const nonceBuf = Buffer.alloc(16); nonceBuf.writeBigUInt64LE(BigInt(handNum * 10 + s + 1), 0);
        playerDataParts.push(Buffer.concat([pubkeyBuf, nonceBuf]));
      } else {
        const dummySk = x25519.utils.randomPrivateKey();
        const dummyPk = x25519.getPublicKey(dummySk);
        const nonceBuf = Buffer.alloc(16); nonceBuf.writeBigUInt64LE(BigInt(1), 0);
        playerDataParts.push(Buffer.concat([Buffer.from(dummyPk), nonceBuf]));
      }
    }
    const playerDataVec = Buffer.concat(playerDataParts);

    const dealData = Buffer.alloc(8 + 8 + 4 + 432 + 1);
    IX.arcium_deal.copy(dealData, 0);
    dealData.writeBigUInt64LE(compOffset, 8);
    dealData.writeUInt32LE(432, 16);
    playerDataVec.copy(dealData, 20);
    dealData[452] = numPlayers;

    const ok = await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: players[0].publicKey,           isSigner: true,  isWritable: true },
        { pubkey: getSignPda(),                   isSigner: false, isWritable: true },
        { pubkey: mxeAccount,                     isSigner: false, isWritable: false },
        { pubkey: getMempoolAccAddress(clusterOffset), isSigner: false, isWritable: true },
        { pubkey: getExecutingPoolAccAddress(clusterOffset), isSigner: false, isWritable: true },
        { pubkey: computationAccount,             isSigner: false, isWritable: true },
        { pubkey: compDefAccount,                 isSigner: false, isWritable: false },
        { pubkey: clusterAccount,                 isSigner: false, isWritable: true },
        { pubkey: getArciumFeePoolPda(),          isSigner: false, isWritable: true },
        { pubkey: getArciumClockPda(),            isSigner: false, isWritable: true },
        { pubkey: ARCIUM_PROG_ID,                 isSigner: false, isWritable: false },
        { pubkey: tablePDA,                       isSigner: false, isWritable: true },
        { pubkey: getDeckState(tablePDA),         isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId,        isSigner: false, isWritable: false },
      ],
      data: dealData,
    }), [players[0]], `arcium_deal`);
    if (!ok) return -1;

    const start = Date.now();
    while (Date.now() - start < 20 * 60 * 1000) {
      const tInfo = await conn.getAccountInfo(tablePDA);
      if (tInfo) {
        const phase = readPhase(Buffer.from(tInfo.data));
        if (phase !== 2) {
          if (phase === 3) return Date.now() - start;
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

  /** Queue reveal and wait for callback. */
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
        { pubkey: players[0].publicKey,           isSigner: true,  isWritable: true },
        { pubkey: getSignPda(),                   isSigner: false, isWritable: true },
        { pubkey: mxeAccount,                     isSigner: false, isWritable: false },
        { pubkey: getMempoolAccAddress(clusterOffset), isSigner: false, isWritable: true },
        { pubkey: getExecutingPoolAccAddress(clusterOffset), isSigner: false, isWritable: true },
        { pubkey: computationAccount,             isSigner: false, isWritable: true },
        { pubkey: compDefAccount,                 isSigner: false, isWritable: false },
        { pubkey: clusterAccount,                 isSigner: false, isWritable: true },
        { pubkey: getArciumFeePoolPda(),          isSigner: false, isWritable: true },
        { pubkey: getArciumClockPda(),            isSigner: false, isWritable: true },
        { pubkey: ARCIUM_PROG_ID,                 isSigner: false, isWritable: false },
        { pubkey: tablePDA,                       isSigner: false, isWritable: true },
        { pubkey: getDeckState(tablePDA),         isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId,        isSigner: false, isWritable: false },
      ],
      data: revealData,
    }), [players[0]], label);
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

  /** Queue reveal_all_showdown — single MPC call reveals ALL active players' hole cards. */
  async function queueShowdownAndWait(): Promise<number> {
    const showCompDefOffset = Buffer.from(getCompDefAccOffset('reveal_all_showdown')).readUInt32LE(0);
    const showCompDefAccount = getCompDefAccAddress(PROGRAM_ID, showCompDefOffset);

    const s = await getTableState();
    const activeMask = s.occ & ~s.folded;
    const activeSeats: number[] = [];
    for (let i = 0; i < maxPlayers; i++) if (activeMask & (1 << i)) activeSeats.push(i);
    console.log(`  Showdown: ${activeSeats.length} active seats: [${activeSeats.join(', ')}] (single MPC call)`);

    const showCompOffset = BigInt(Date.now()) * BigInt(1000) + BigInt(999);
    const showCompOffsetBuf = Buffer.alloc(8);
    showCompOffsetBuf.writeBigUInt64LE(showCompOffset);
    const showComputationAccount = getComputationAccAddress(
      clusterOffset,
      { toArrayLike: (_B: any, _e: string, l: number) => { const b = Buffer.alloc(l); showCompOffsetBuf.copy(b); return b; } } as any,
    );

    // IX data: disc(8) + computation_offset(8) = 16 bytes
    // active_mask is computed on-chain from table state
    const showData = Buffer.alloc(16);
    IX.arcium_showdown_queue.copy(showData, 0);
    showData.writeBigUInt64LE(showCompOffset, 8);

    const ok = await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: players[0].publicKey,           isSigner: true,  isWritable: true },
        { pubkey: getSignPda(),                   isSigner: false, isWritable: true },
        { pubkey: mxeAccount,                     isSigner: false, isWritable: false },
        { pubkey: getMempoolAccAddress(clusterOffset), isSigner: false, isWritable: true },
        { pubkey: getExecutingPoolAccAddress(clusterOffset), isSigner: false, isWritable: true },
        { pubkey: showComputationAccount,         isSigner: false, isWritable: true },
        { pubkey: showCompDefAccount,             isSigner: false, isWritable: false },
        { pubkey: clusterAccount,                 isSigner: false, isWritable: true },
        { pubkey: getArciumFeePoolPda(),          isSigner: false, isWritable: true },
        { pubkey: getArciumClockPda(),            isSigner: false, isWritable: true },
        { pubkey: ARCIUM_PROG_ID,                 isSigner: false, isWritable: false },
        { pubkey: tablePDA,                       isSigner: false, isWritable: true },
        { pubkey: getDeckState(tablePDA),         isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId,        isSigner: false, isWritable: false },
      ],
      data: showData,
    }), [players[0]], `showdown_queue(reveal_all)`);
    if (!ok) return -1;

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

  // ═══════════════════════════════════════════════════════════════════
  // HAND 1: ALL N players check through all streets → full showdown
  // Tests reveal_all_showdown: single MPC call reveals all players.
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  HAND 1: ${numPlayers}-player deal → ALL check → full showdown`);
  console.log(`${'─'.repeat(60)}`);

  // Start game
  const s0 = await getTableState();
  if (s0.phase !== 0) {
    console.log(`  ❌ Expected Waiting, got ${PHASE_NAMES[s0.phase]}`);
    return false;
  }
  if (!await startGame()) { console.log('  ❌ start_game failed'); return false; }

  // Deal
  const dealMs = await arciumDealAndWait(0);
  if (dealMs < 0) { console.log('\n  ❌ Deal failed'); return false; }
  console.log(`\n  ⏱  shuffle_and_deal (${numPlayers}p): ${(dealMs / 1000).toFixed(1)}s`);

  // Read SeatCards — P0+P1 should have Shared encrypted data for client decrypt
  console.log('\n  SeatCards encrypted data check:');
  for (let i = 0; i < numPlayers; i++) {
    const scInfo = await conn.getAccountInfo(getSeatCards(tablePDA, i));
    if (scInfo) {
      const scData = Buffer.from(scInfo.data);
      const enc1 = scData.slice(76, 76 + 32);
      const hasData = enc1.some((b: number) => b !== 0);
      const tag = i < 2 ? (hasData ? '✅ Shared ct' : '❌ EXPECTED NON-ZERO') : (hasData ? '✅ bonus' : '— no Shared ct (MXE showdown OK)');
      console.log(`    Seat ${i}: enc1=${hasData ? 'non-zero' : 'zero'}  ${tag}`);
      if (i < 2 && !hasData) {
        console.log(`  ❌ Seat ${i} MUST have encrypted data`);
        return false;
      }
    }
  }

  // Preflop: ALL players call/check (no folds — full showdown test)
  const preS = await getTableState();
  console.log(`\n  Preflop: curPlayer=${preS.curPlayer}, sb=${preS.sb}, bb=${preS.bb}, dealer=${preS.dealer}`);

  {
    let safety = 0;
    while (safety < 30) {
      safety++;
      const st = await getTableState();
      if (st.phase !== 3) break; // No longer Preflop
      const cp = st.curPlayer;
      if (cp >= numPlayers) { console.log(`  ❌ curPlayer=${cp} out of range`); return false; }

      if (cp === st.bb) {
        if (!await playerAction(cp, 'Check')) {
          if (!await playerAction(cp, 'Call')) return false;
        }
      } else {
        if (!await playerAction(cp, 'Call')) return false;
      }
    }
  }
  let afterPreflop = (await getTableState()).phase;
  console.log(`  Phase after preflop: ${PHASE_NAMES[afterPreflop]} (${afterPreflop})`);

  // Flop
  if (afterPreflop === 10) {
    const flopMs = await queueRevealAndWait(3, 10, 4, 'flop_reveal');
    if (flopMs < 0) { console.log('\n  ❌ Flop reveal failed'); return false; }
    console.log(`\n  ⏱  reveal_community (flop): ${(flopMs / 1000).toFixed(1)}s`);
    const comm = (await getTableState()).community;
    console.log(`  Board: ${comm.slice(0, 3).map(c => cardName(c)).join(' ')}`);

    {
      let safety = 0;
      while (safety < 20) {
        safety++;
        const st = await getTableState();
        if (st.phase !== 4) break;
        if (!await playerAction(st.curPlayer, 'Check')) return false;
      }
    }
    console.log(`  Phase after Flop: ${PHASE_NAMES[(await getTableState()).phase]}`);
  }

  // Turn
  if ((await getTableState()).phase === 11) {
    const turnMs = await queueRevealAndWait(4, 11, 5, 'turn_reveal');
    if (turnMs < 0) { console.log('\n  ❌ Turn reveal failed'); return false; }
    console.log(`\n  ⏱  reveal_community (turn): ${(turnMs / 1000).toFixed(1)}s`);
    const comm = (await getTableState()).community;
    console.log(`  Board: ${comm.slice(0, 4).map(c => cardName(c)).join(' ')}`);

    {
      let safety = 0;
      while (safety < 20) {
        safety++;
        const st = await getTableState();
        if (st.phase !== 5) break;
        if (!await playerAction(st.curPlayer, 'Check')) return false;
      }
    }
    console.log(`  Phase after Turn: ${PHASE_NAMES[(await getTableState()).phase]}`);
  }

  // River
  if ((await getTableState()).phase === 12) {
    const riverMs = await queueRevealAndWait(5, 12, 6, 'river_reveal');
    if (riverMs < 0) { console.log('\n  ❌ River reveal failed'); return false; }
    console.log(`\n  ⏱  reveal_community (river): ${(riverMs / 1000).toFixed(1)}s`);
    const comm = (await getTableState()).community;
    console.log(`  Board: ${comm.map(c => cardName(c)).join(' ')}`);

    {
      let safety = 0;
      while (safety < 20) {
        safety++;
        const st = await getTableState();
        if (st.phase !== 6) break;
        if (!await playerAction(st.curPlayer, 'Check')) return false;
      }
    }
    console.log(`  Phase after River: ${PHASE_NAMES[(await getTableState()).phase]}`);
  }

  // Showdown — ALL players active, reveal_all_showdown decrypts everyone
  const showPhase = (await getTableState()).phase;
  if (showPhase === 7) {
    const showMs = await queueShowdownAndWait();
    if (showMs < 0) { console.log('\n  ❌ Showdown reveal failed'); return false; }
    console.log(`\n  ⏱  reveal_all_showdown (${numPlayers}p): ${(showMs / 1000).toFixed(1)}s`);

    const tblData = (await conn.getAccountInfo(tablePDA))!.data;
    let allValid = true;
    for (let i = 0; i < numPlayers; i++) {
      const c1 = tblData[T_REVEALED_HANDS + i * 2];
      const c2 = tblData[T_REVEALED_HANDS + i * 2 + 1];
      const valid = c1 < 52 && c2 < 52;
      console.log(`  Seat ${i}: ${cardName(c1)} ${cardName(c2)}${valid ? '' : ' ❌ INVALID'}`);
      if (!valid) allValid = false;
    }
    if (!allValid) {
      console.log(`  ❌ Not all players have valid revealed cards!`);
      return false;
    }
    console.log(`  ✅ All ${numPlayers} players' cards revealed via single MPC call!`);
  }

  // Settle
  const settlePhase = (await getTableState()).phase;
  console.log(`  Pre-settle phase: ${PHASE_NAMES[settlePhase]} (${settlePhase})`);
  if (settlePhase === 7) {
    if (!await settleHand()) { console.log('  ❌ settle_hand failed'); return false; }
  } else {
    console.log(`  ⚠️  Unexpected phase ${settlePhase} — trying settle anyway`);
    if (!await settleHand()) { console.log('  ❌ settle_hand failed'); return false; }
  }

  const endState = await getTableState();
  console.log(`  End: phase=${PHASE_NAMES[endState.phase]}, hand=${endState.hand}`);
  if (endState.phase !== 0) {
    console.log(`  ❌ Expected Waiting after settle, got ${PHASE_NAMES[endState.phase]}`);
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════
  // HAND 2: Quick fold (verify state reset works for multi-player)
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  HAND 2: Quick fold (verify state reset)`);
  console.log(`${'─'.repeat(60)}`);

  if (!await startGame()) { console.log('  ❌ start_game failed'); return false; }

  const deal2Start = Date.now();
  const deal2Ms = await arciumDealAndWait(1);
  if (deal2Ms < 0) { console.log('\n  ❌ Deal 2 failed'); return false; }
  console.log(`\n  ⏱  shuffle_and_deal (hand 2): ${(deal2Ms / 1000).toFixed(1)}s`);

  // Fold first player to act
  const pre2 = await getTableState();
  if (!await playerAction(pre2.curPlayer, 'Fold')) return false;
  // If 3+ players, fold another until only 1 remains
  for (let folds = 1; folds < numPlayers - 1; folds++) {
    const st = await getTableState();
    if (st.phase === 7 || st.phase === 0) break; // Showdown or settled
    if (!await playerAction(st.curPlayer, 'Fold')) break;
  }

  const settle2Phase = (await getTableState()).phase;
  if (settle2Phase === 7) {
    if (!await settleHand()) { console.log('  ❌ settle 2 failed'); return false; }
  }

  const end2 = await getTableState();
  console.log(`  End: phase=${PHASE_NAMES[end2.phase]}, hand=${end2.hand}`);
  if (end2.phase !== 0) {
    console.log(`  ❌ Expected Waiting, got ${PHASE_NAMES[end2.phase]}`);
    return false;
  }

  console.log(`\n  ✅ ${label} PASSED!`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  const testStart = Date.now();

  console.log('═'.repeat(70));
  console.log('  ARCIUM MPC MULTI-PLAYER TEST (6-Max / 9-Max)');
  console.log('═'.repeat(70));
  console.log(`  RPC: ${RPC_URL}`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);

  try { const slot = await conn.getSlot(); console.log(`  Slot: ${slot}`); }
  catch { console.error('Cannot connect to validator.'); process.exit(1); }

  const tests: TestConfig[] = [
    { label: '3-player on 6-max table', maxPlayers: 6, numPlayers: 3 },
    { label: '6-player on 6-max table', maxPlayers: 6, numPlayers: 6 },
    { label: '9-player on 9-max table', maxPlayers: 9, numPlayers: 9 },
  ];

  let passed = 0;
  for (const test of tests) {
    const ok = await runMultiPlayerTest(conn, test);
    if (ok) passed++;
    else {
      console.log(`\n  ❌ STOPPING — ${test.label} failed.`);
      break;
    }
  }

  const totalTime = Date.now() - testStart;
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  RESULTS: ${passed}/${tests.length} tests passed`);
  console.log(`  Total time: ${(totalTime / 1000).toFixed(0)}s`);
  console.log(`${'═'.repeat(70)}\n`);

  if (passed < tests.length) process.exit(1);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
