/**
 * E2E Test: All Table Types — Cash Games (HU/6max/9max) + SNG (Micro/Bronze/Silver/Gold/Platinum/Diamond)
 *
 * For each table type:
 *   1. Register players, create table, init seats, join, start game
 *   2. Queue arcium_deal (MPC shuffle_and_deal)
 *   3. Poll for callback (phase → Preflop)
 *   4. Verify encrypted cards written to SeatCards + DeckState
 *
 * Run from backend/: ARCIUM_CLUSTER_OFFSET=0 npx ts-node e2e-all-tables.ts
 * Requires: arcium localnet + circuits initialized
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
const RPC_URL = process.env.SOLANA_RPC_URL || 'http://127.0.0.1:8899';
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// PDA Seeds
const TABLE_SEED = Buffer.from('table');
const SEAT_SEED = Buffer.from('seat');
const SEAT_CARDS_SEED = Buffer.from('seat_cards');
const DECK_STATE_SEED = Buffer.from('deck_state');
const VAULT_SEED = Buffer.from('vault');
const RECEIPT_SEED = Buffer.from('receipt');
const DEPOSIT_PROOF_SEED = Buffer.from('deposit_proof');
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
};

// PDA helpers
function pda(seeds: Buffer[], programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}
const getTable = (id: Buffer) => pda([TABLE_SEED, id]);
const getSeat = (table: PublicKey, i: number) => pda([SEAT_SEED, table.toBuffer(), Buffer.from([i])]);
const getSeatCards = (table: PublicKey, i: number) => pda([SEAT_CARDS_SEED, table.toBuffer(), Buffer.from([i])]);
const getDeckState = (table: PublicKey) => pda([DECK_STATE_SEED, table.toBuffer()]);
const getVault = (table: PublicKey) => pda([VAULT_SEED, table.toBuffer()]);
const getReceipt = (table: PublicKey, i: number) => pda([RECEIPT_SEED, table.toBuffer(), Buffer.from([i])]);
const getDepositProof = (table: PublicKey, i: number) => pda([DEPOSIT_PROOF_SEED, table.toBuffer(), Buffer.from([i])]);
const getPlayer = (wallet: PublicKey) => pda([PLAYER_SEED, wallet.toBuffer()]);
const getMarker = (wallet: PublicKey, table: PublicKey) => pda([PLAYER_TABLE_SEED, wallet.toBuffer(), table.toBuffer()]);
const getCrankTallyEr = (table: PublicKey) => pda([CRANK_TALLY_ER_SEED, table.toBuffer()]);
const getCrankTallyL1 = (table: PublicKey) => pda([CRANK_TALLY_L1_SEED, table.toBuffer()]);
const getPool = () => pda([Buffer.from('pool')], STEEL_PROGRAM_ID);
const getUnrefined = (wallet: PublicKey) => pda([UNREFINED_SEED, wallet.toBuffer()], STEEL_PROGRAM_ID);
const getSignPda = () => pda([SIGN_PDA_SEED]);
function getArciumClockPda(): PublicKey {
  return PublicKey.findProgramAddressSync([getArciumAccountBaseSeed('ClockAccount')], ARCIUM_PROG_ID)[0];
}
function getArciumFeePoolPda(): PublicKey {
  return PublicKey.findProgramAddressSync([getArciumAccountBaseSeed('FeePool')], ARCIUM_PROG_ID)[0];
}

// Phase reader
const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop',
  4: 'Flop', 5: 'Turn', 6: 'River', 7: 'Showdown',
  8: 'AwaitingShowdown', 9: 'Complete',
  10: 'FlopRevealPending', 11: 'TurnRevealPending', 12: 'RiverRevealPending',
};
function readPhase(data: Buffer): number { return data.readUInt8(160); }

// ── Table Type Definitions ──
// GameType enum: SitAndGoHeadsUp=0, SitAndGo6Max=1, SitAndGo9Max=2, CashGame=3
// Stakes enum: Micro=0, Low=1, Mid=2, High=3
// SnGTier enum: Micro=0, Bronze=1, Silver=2, Gold=3, Platinum=4, Diamond=5

interface TableTest {
  name: string;
  gameType: number;      // GameType enum value
  stakes: number;        // Stakes enum value
  maxPlayers: number;    // 2, 6, or 9
  tier: number;          // SnGTier enum value
  numPlayers: number;    // actual players to seat
  buyIn: bigint;         // lamports per player (cash) or 0 (SNG auto)
  isSng: boolean;
}

const CASH_TESTS: TableTest[] = [
  { name: 'HU Cash Micro',   gameType: 3, stakes: 0, maxPlayers: 2, tier: 0, numPlayers: 2, buyIn: 100_000n, isSng: false },
  { name: '6max Cash Low',   gameType: 3, stakes: 1, maxPlayers: 6, tier: 0, numPlayers: 6, buyIn: 500_000n, isSng: false },
  { name: '9max Cash Mid',   gameType: 3, stakes: 2, maxPlayers: 9, tier: 0, numPlayers: 9, buyIn: 2_500_000n, isSng: false },
];

// shuffle_and_deal circuit supports up to 9 player slots (p0..p8).
// All table types (HU, 6max, 9max) can use MPC deal.
const MAX_MPC_PLAYERS = 9;

const SNG_TESTS: TableTest[] = [
  // SNG HU — all tiers
  { name: 'SNG HU Micro',    gameType: 0, stakes: 0, maxPlayers: 2, tier: 0, numPlayers: 2, buyIn: 0n, isSng: true },
  { name: 'SNG HU Bronze',   gameType: 0, stakes: 0, maxPlayers: 2, tier: 1, numPlayers: 2, buyIn: 0n, isSng: true },
  { name: 'SNG HU Silver',   gameType: 0, stakes: 0, maxPlayers: 2, tier: 2, numPlayers: 2, buyIn: 0n, isSng: true },
  { name: 'SNG HU Gold',     gameType: 0, stakes: 0, maxPlayers: 2, tier: 3, numPlayers: 2, buyIn: 0n, isSng: true },
  { name: 'SNG HU Platinum', gameType: 0, stakes: 0, maxPlayers: 2, tier: 4, numPlayers: 2, buyIn: 0n, isSng: true },
  { name: 'SNG HU Diamond',  gameType: 0, stakes: 0, maxPlayers: 2, tier: 5, numPlayers: 2, buyIn: 0n, isSng: true },
  // SNG 6max — key tiers
  { name: 'SNG 6max Micro',  gameType: 1, stakes: 0, maxPlayers: 6, tier: 0, numPlayers: 6, buyIn: 0n, isSng: true },
  { name: 'SNG 6max Bronze', gameType: 1, stakes: 0, maxPlayers: 6, tier: 1, numPlayers: 6, buyIn: 0n, isSng: true },
  // SNG 9max — key tiers
  { name: 'SNG 9max Micro',  gameType: 2, stakes: 0, maxPlayers: 9, tier: 0, numPlayers: 9, buyIn: 0n, isSng: true },
  { name: 'SNG 9max Silver', gameType: 2, stakes: 0, maxPlayers: 9, tier: 2, numPlayers: 9, buyIn: 0n, isSng: true },
];

// SNG tier buy-in amounts (devnet, TIER_SCALE=10)
const SNG_TOTAL_BUYIN: Record<number, bigint> = {
  0: 10_000_000n,    // Micro: 0.01 SOL (fee only)
  1: 25_000_000n,    // Bronze: 0.025 SOL
  2: 50_000_000n,    // Silver: 0.05 SOL
  3: 100_000_000n,   // Gold: 0.10 SOL
  4: 200_000_000n,   // Platinum: 0.20 SOL
  5: 500_000_000n,   // Diamond: 0.50 SOL
};

// ── Helpers ──
async function airdrop(conn: Connection, pk: PublicKey, amount: number) {
  const sig = await conn.requestAirdrop(pk, amount);
  await conn.confirmTransaction(sig, 'confirmed');
}

async function send(conn: Connection, ix: TransactionInstruction, signers: Keypair[], label: string): Promise<boolean> {
  try {
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed', skipPreflight: true });
    return true;
  } catch (e: any) {
    console.log(`    ❌ ${label}: ${e.message?.slice(0, 200)}`);
    if (e.logs) e.logs.slice(-5).forEach((l: string) => console.log(`       ${l}`));
    return false;
  }
}

function serializeTableConfig(tableId: Buffer, gameType: number, stakes: number, maxPlayers: number, tier: number): Buffer {
  const buf = Buffer.alloc(36);
  tableId.copy(buf, 0, 0, 32);
  buf.writeUInt8(gameType, 32);
  buf.writeUInt8(stakes, 33);
  buf.writeUInt8(maxPlayers, 34);
  buf.writeUInt8(tier, 35);
  return buf;
}

interface TableState {
  test: TableTest;
  tableId: Buffer;
  tablePDA: PublicKey;
  players: Keypair[];
  computationOffset?: bigint;
  dealQueued: boolean;
  callbackReceived: boolean;
}

// ── Core Test Functions ──

async function registerPlayer(conn: Connection, player: Keypair): Promise<boolean> {
  return send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player.publicKey, isSigner: true, isWritable: true },
      { pubkey: getPlayer(player.publicKey), isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: getPool(), isSigner: false, isWritable: true },
      { pubkey: getUnrefined(player.publicKey), isSigner: false, isWritable: true },
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX.register_player,
  }), [player], 'register');
}

async function createTable(conn: Connection, payer: Keypair, state: TableState): Promise<boolean> {
  const t = state.test;
  return send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: state.tablePDA, isSigner: false, isWritable: true },
      { pubkey: getPool(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.create_table, serializeTableConfig(state.tableId, t.gameType, t.stakes, t.maxPlayers, t.tier)]),
  }), [payer], 'create_table');
}

async function initSeats(conn: Connection, payer: Keypair, state: TableState): Promise<boolean> {
  for (let i = 0; i < state.test.maxPlayers; i++) {
    const ok = await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: state.tablePDA, isSigner: false, isWritable: false },
        { pubkey: getSeat(state.tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getSeatCards(state.tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getDeckState(state.tablePDA), isSigner: false, isWritable: true },
        { pubkey: getReceipt(state.tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getDepositProof(state.tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getVault(state.tablePDA), isSigner: false, isWritable: true },
        { pubkey: getCrankTallyEr(state.tablePDA), isSigner: false, isWritable: true },
        { pubkey: getCrankTallyL1(state.tablePDA), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([IX.init_table_seat, Buffer.from([i])]),
    }), [payer], `init_seat_${i}`);
    if (!ok) return false;
  }
  return true;
}

async function joinTable(conn: Connection, player: Keypair, state: TableState, seatIdx: number): Promise<boolean> {
  const t = state.test;
  // Cash game: use buyIn; SNG: buy-in is handled by contract from tier
  const buyIn = t.isSng ? SNG_TOTAL_BUYIN[t.tier] || 0n : t.buyIn;
  const reserve = 0n;

  const joinData = Buffer.alloc(25);
  IX.join_table.copy(joinData, 0);
  joinData.writeBigUInt64LE(buyIn, 8);
  joinData.writeUInt8(seatIdx, 16);
  joinData.writeBigUInt64LE(reserve, 17);

  return send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player.publicKey, isSigner: true, isWritable: true },
      { pubkey: getPlayer(player.publicKey), isSigner: false, isWritable: true },
      { pubkey: state.tablePDA, isSigner: false, isWritable: true },
      { pubkey: getSeat(state.tablePDA, seatIdx), isSigner: false, isWritable: true },
      { pubkey: getMarker(player.publicKey, state.tablePDA), isSigner: false, isWritable: true },
      { pubkey: getVault(state.tablePDA), isSigner: false, isWritable: true },
      { pubkey: getReceipt(state.tablePDA, seatIdx), isSigner: false, isWritable: true },
      // Optional SPL token accounts (not used for SOL tables — pass program ID as placeholder)
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      // Optional unclaimed balance
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: joinData,
  }), [player], `join_seat_${seatIdx}`);
}

async function startGame(conn: Connection, caller: Keypair, state: TableState): Promise<boolean> {
  // start_game needs: caller + table + deck_state + all seat accounts
  const keys: any[] = [
    { pubkey: caller.publicKey, isSigner: false, isWritable: false },
    { pubkey: state.tablePDA, isSigner: false, isWritable: true },
    { pubkey: getDeckState(state.tablePDA), isSigner: false, isWritable: true },
  ];
  for (let i = 0; i < state.test.maxPlayers; i++) {
    keys.push({ pubkey: getSeat(state.tablePDA, i), isSigner: false, isWritable: true });
  }

  return send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data: IX.start_game,
  }), [caller], 'start_game');
}

async function queueArciumDeal(conn: Connection, payer: Keypair, state: TableState): Promise<boolean> {
  try {
    const arciumEnv = getArciumEnv();
    const clusterOffset = arciumEnv.arciumClusterOffset;
    const computationOffset = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
    state.computationOffset = computationOffset;

    const compDefOffset = Buffer.from(getCompDefAccOffset('shuffle_and_deal')).readUInt32LE(0);

    // Generate x25519 keypairs for ALL 9 slots
    const dummyPrivKey = x25519.utils.randomSecretKey();
    const dummyPubKey = x25519.getPublicKey(dummyPrivKey);
    const playerPubkeys: Buffer[] = [];
    const playerNonces: Buffer[] = [];
    for (let i = 0; i < 9; i++) {
      if (i < state.test.numPlayers) {
        const privKey = x25519.utils.randomSecretKey();
        const pubKey = x25519.getPublicKey(privKey);
        playerPubkeys.push(Buffer.from(pubKey));
        playerNonces.push(crypto.randomBytes(16));
      } else {
        playerPubkeys.push(Buffer.from(dummyPubKey));
        playerNonces.push(crypto.randomBytes(16));
      }
    }

    // Derive Arcium account addresses
    const mxeAccount = getMXEAccAddress(PROGRAM_ID);
    const mempoolAccount = getMempoolAccAddress(clusterOffset);
    const executingPool = getExecutingPoolAccAddress(clusterOffset);
    const compOffsetBuf = Buffer.alloc(8);
    compOffsetBuf.writeBigUInt64LE(computationOffset);
    const computationAccount = getComputationAccAddress(
      clusterOffset,
      { toArrayLike: (_B: any, _e: string, l: number) => { const b = Buffer.alloc(l); compOffsetBuf.copy(b); return b; } } as any,
    );
    const compDefAccount = getCompDefAccAddress(PROGRAM_ID, compDefOffset);
    const clusterAccount = getClusterAccAddress(clusterOffset);

    // Build instruction data: disc(8) + computation_offset(u64) + player_data(Vec<u8>: u32 len + 9×48) + num_players(u8)
    // player_data layout per slot: pubkey(32) + nonce(16) = 48 bytes × 9 = 432 bytes
    const playerDataLen = 9 * 48;
    const dataLen = 8 + 8 + 4 + playerDataLen + 1;
    const data = Buffer.alloc(dataLen);
    let off = 0;
    IX.arcium_deal.copy(data, off); off += 8;
    data.writeBigUInt64LE(computationOffset, off); off += 8;
    data.writeUInt32LE(playerDataLen, off); off += 4; // Vec<u8> length prefix
    for (let i = 0; i < 9; i++) {
      playerPubkeys[i].copy(data, off); off += 32;
      playerNonces[i].copy(data, off); off += 16;
    }
    data.writeUInt8(state.test.numPlayers, off);

    const ok = await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey,                isSigner: true,  isWritable: true  },
        { pubkey: getSignPda(),                   isSigner: false, isWritable: true  },
        { pubkey: mxeAccount,                     isSigner: false, isWritable: false },
        { pubkey: mempoolAccount,                 isSigner: false, isWritable: true  },
        { pubkey: executingPool,                  isSigner: false, isWritable: true  },
        { pubkey: computationAccount,             isSigner: false, isWritable: true  },
        { pubkey: compDefAccount,                 isSigner: false, isWritable: false },
        { pubkey: clusterAccount,                 isSigner: false, isWritable: true  },
        { pubkey: getArciumFeePoolPda(),          isSigner: false, isWritable: true  },
        { pubkey: getArciumClockPda(),            isSigner: false, isWritable: true  },
        { pubkey: ARCIUM_PROG_ID,                 isSigner: false, isWritable: false },
        { pubkey: state.tablePDA,                 isSigner: false, isWritable: true  },
        { pubkey: getDeckState(state.tablePDA),   isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId,        isSigner: false, isWritable: false },
      ],
      data,
    }), [payer], 'arcium_deal');

    if (ok) state.dealQueued = true;
    return ok;
  } catch (e: any) {
    console.log(`    ❌ arcium_deal error: ${e.message?.slice(0, 200)}`);
    return false;
  }
}

// ── Main ──
async function main() {
  console.log('═'.repeat(70));
  console.log('  E2E Test: All Table Types — Cash + SNG + Arcium MPC');
  console.log('═'.repeat(70));

  const conn = new Connection(RPC_URL, 'confirmed');
  const allTests = [...CASH_TESTS, ...SNG_TESTS];
  const results: { name: string; setup: boolean; deal: boolean; callback: boolean; skippedDeal: boolean }[] = [];

  // Generate a pool of unique players (max 9 per table)
  const maxPlayersNeeded = Math.max(...allTests.map(t => t.numPlayers));
  const playerPool: Keypair[] = [];
  for (let i = 0; i < maxPlayersNeeded; i++) {
    playerPool.push(Keypair.generate());
  }

  // Airdrop to all players
  console.log(`\n  Airdropping to ${playerPool.length} players...`);
  for (const p of playerPool) {
    await airdrop(conn, p.publicKey, 5 * LAMPORTS_PER_SOL);
  }

  // Register all players
  console.log('  Registering players...');
  const registeredSet = new Set<string>();
  for (const p of playerPool) {
    const key = p.publicKey.toBase58();
    if (!registeredSet.has(key)) {
      await registerPlayer(conn, p);
      registeredSet.add(key);
    }
  }

  // ── Phase 1: Create all tables and set up games ──
  console.log(`\n${'━'.repeat(70)}`);
  console.log('  PHASE 1: Create Tables, Seat Players, Start Games');
  console.log('━'.repeat(70));

  const states: TableState[] = [];

  for (const test of allTests) {
    console.log(`\n  ── ${test.name} (${test.numPlayers}p) ──`);

    const tableId = crypto.randomBytes(32);
    const tablePDA = getTable(tableId);
    const players = playerPool.slice(0, test.numPlayers);

    const state: TableState = {
      test,
      tableId,
      tablePDA,
      players,
      dealQueued: false,
      callbackReceived: false,
    };

    // Create table
    const created = await createTable(conn, players[0], state);
    if (!created) {
      console.log(`    ⚠️  Failed to create table — skipping`);
      results.push({ name: test.name, setup: false, deal: false, callback: false, skippedDeal: false });
      continue;
    }

    // Init seats
    const seatsOk = await initSeats(conn, players[0], state);
    if (!seatsOk) {
      console.log(`    ⚠️  Failed to init seats — skipping`);
      results.push({ name: test.name, setup: false, deal: false, callback: false, skippedDeal: false });
      continue;
    }

    // Join all players
    let joinOk = true;
    for (let i = 0; i < test.numPlayers; i++) {
      const ok = await joinTable(conn, players[i], state, i);
      if (!ok) { joinOk = false; break; }
    }
    if (!joinOk) {
      console.log(`    ⚠️  Failed to join players — skipping`);
      results.push({ name: test.name, setup: false, deal: false, callback: false, skippedDeal: false });
      continue;
    }

    // Start game
    const started = await startGame(conn, players[0], state);
    if (!started) {
      console.log(`    ⚠️  Failed to start game — skipping`);
      results.push({ name: test.name, setup: false, deal: false, callback: false, skippedDeal: false });
      continue;
    }

    // Verify phase = Starting(1)
    const info = await conn.getAccountInfo(tablePDA);
    if (info) {
      const phase = readPhase(info.data);
      if (phase === 1) {
        console.log(`    ✅ Setup complete — Phase: Starting`);
      } else {
        console.log(`    ⚠️  Expected Starting(1), got ${PHASE_NAMES[phase]}(${phase})`);
      }
    }

    states.push(state);
  }

  // ── Phase 2: Queue MPC deals for all tables ──
  console.log(`\n${'━'.repeat(70)}`);
  console.log('  PHASE 2: Queue Arcium MPC Deals');
  console.log('━'.repeat(70));

  for (const state of states) {
    if (state.test.numPlayers > MAX_MPC_PLAYERS) {
      console.log(`\n  ── ${state.test.name}: SKIPPED (${state.test.numPlayers} players > ${MAX_MPC_PLAYERS} circuit max)`);
      continue;
    }
    console.log(`\n  ── ${state.test.name}: arcium_deal ──`);
    const ok = await queueArciumDeal(conn, state.players[0], state);
    if (ok) {
      console.log(`    ✅ MPC computation queued (offset: ${state.computationOffset})`);
    }
  }

  const dealedStates = states.filter(s => s.dealQueued);
  console.log(`\n  📊 ${dealedStates.length}/${states.length} tables queued for MPC deal`);

  // ── Phase 3: Poll for callbacks ──
  console.log(`\n${'━'.repeat(70)}`);
  console.log('  PHASE 3: Waiting for MPC Callbacks (polling every 15s, max 20 min)');
  console.log('━'.repeat(70));

  const pollInterval = 15_000; // 15 seconds
  const maxWait = 20 * 60 * 1000; // 20 minutes
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    const pending = dealedStates.filter(s => !s.callbackReceived);
    if (pending.length === 0) break;

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r  ⏳ ${elapsed}s elapsed — ${pending.length} tables waiting for callback...   `);

    for (const state of pending) {
      const info = await conn.getAccountInfo(state.tablePDA);
      if (info) {
        const phase = readPhase(info.data);
        if (phase === 3) { // Preflop = callback received
          state.callbackReceived = true;
          console.log(`\n    ✅ ${state.test.name}: Callback received! Phase → Preflop`);
        }
      }
    }

    if (dealedStates.some(s => !s.callbackReceived)) {
      await new Promise(r => setTimeout(r, pollInterval));
    }
  }

  // ── Phase 4: Verify results ──
  console.log(`\n\n${'━'.repeat(70)}`);
  console.log('  PHASE 4: Verification & Privacy Checks');
  console.log('━'.repeat(70));

  for (const state of states) {
    const t = state.test;
    const setupOk = true;
    const dealOk = state.dealQueued;
    const cbOk = state.callbackReceived;

    if (cbOk) {
      // Verify encrypted cards written to SeatCards
      let cardsOk = true;
      for (let i = 0; i < t.numPlayers; i++) {
        const scInfo = await conn.getAccountInfo(getSeatCards(state.tablePDA, i));
        if (scInfo) {
          // SeatCards: disc(8) + table(32) + seat_index(1) + bump(1) + ct1(32) + ct2(32)
          const ct1 = scInfo.data.slice(42, 74);
          const ct2 = scInfo.data.slice(74, 106);
          const isNonZero1 = ct1.some((b: number) => b !== 0);
          const isNonZero2 = ct2.some((b: number) => b !== 0);
          if (!isNonZero1 || !isNonZero2) {
            console.log(`    ⚠️  ${t.name} seat ${i}: encrypted cards are zero!`);
            cardsOk = false;
          }
        }
      }

      // Verify DeckState encrypted community cards
      const deckInfo = await conn.getAccountInfo(getDeckState(state.tablePDA));
      if (deckInfo) {
        const deckData = deckInfo.data;
        // DeckState: disc(8) + table(32) + bump(1) + shuffle_complete(1) + ...
        const shuffleComplete = deckData[41]; // offset 8+32+1 = 41
        if (shuffleComplete !== 1) {
          console.log(`    ⚠️  ${t.name}: shuffle_complete = ${shuffleComplete} (expected 1)`);
          cardsOk = false;
        }
      }

      // ── SNEAK PRIVACY TEST ──
      // Verify that encrypted hole cards are NOT valid plaintext card values (0-51).
      // If any SeatCards ciphertext byte pattern decodes as two values both in [0,51],
      // that would indicate a privacy failure (cards stored as plaintext).
      let sneakOk = true;
      for (let i = 0; i < t.numPlayers; i++) {
        const scInfo = await conn.getAccountInfo(getSeatCards(state.tablePDA, i));
        if (scInfo) {
          const ct1 = scInfo.data.slice(42, 74);  // 32-byte ciphertext
          const ct2 = scInfo.data.slice(74, 106); // 32-byte ciphertext

          // A plaintext card would be a single byte 0-51. In a 32-byte field,
          // a plaintext card would be [cardValue, 0, 0, ..., 0] (LE) or similar.
          // Real ciphertext should have high entropy across all 32 bytes.
          const entropyCheck = (ct: Buffer) => {
            let nonZero = 0;
            for (let b = 0; b < 32; b++) if (ct[b] !== 0) nonZero++;
            return nonZero;
          };
          const nz1 = entropyCheck(ct1);
          const nz2 = entropyCheck(ct2);

          // Real Rescue ciphertext should have many non-zero bytes (high entropy).
          // A plaintext card value would have at most 1 non-zero byte in 32.
          if (nz1 < 8 || nz2 < 8) {
            console.log(`    🚨 SNEAK FAIL: ${t.name} seat ${i}: low entropy (nz1=${nz1}, nz2=${nz2}) — possible plaintext leak!`);
            sneakOk = false;
          }

          // Cross-player check: verify different players have different ciphertexts
          // (same card encrypted to different keys should produce different ciphertext)
          if (i > 0) {
            const prevSc = await conn.getAccountInfo(getSeatCards(state.tablePDA, i - 1));
            if (prevSc) {
              const prevCt1 = prevSc.data.slice(42, 74);
              if (ct1.equals(prevCt1)) {
                console.log(`    🚨 SNEAK FAIL: ${t.name} seat ${i} has SAME ciphertext as seat ${i-1} — encryption may be broken!`);
                sneakOk = false;
              }
            }
          }
        }
      }

      // Check community cards are encrypted (not plaintext 0-51)
      const deckInfo2 = await conn.getAccountInfo(getDeckState(state.tablePDA));
      if (deckInfo2) {
        // DeckState: encrypted_community starts after disc(8)+table(32)+bump(1)+shuffle_complete(1)+...
        // Check first community card ciphertext has high entropy
        // Layout: disc(8) + table(32) + bump(1) + shuffle_complete(1) + hand_number(u64=8) + computation_offset(u64=8) + encrypted_community(5×32=160)
        const commStart = 8 + 32 + 1 + 1 + 8 + 8; // = 58
        for (let c = 0; c < 5; c++) {
          const commCt = deckInfo2.data.slice(commStart + c * 32, commStart + c * 32 + 32);
          let nonZero = 0;
          for (let b = 0; b < 32; b++) if (commCt[b] !== 0) nonZero++;
          if (nonZero < 8) {
            console.log(`    🚨 SNEAK FAIL: ${t.name} community card ${c}: low entropy (nz=${nonZero}) — possible plaintext!`);
            sneakOk = false;
          }
        }
      }

      if (sneakOk) {
        console.log(`    🔒 ${t.name}: SNEAK TEST PASSED — all cards are encrypted ciphertext`);
      }

      if (cardsOk && sneakOk) {
        console.log(`    ✅ ${t.name}: All checks passed (cards + privacy)`);
      }
    }

    const skippedDeal = t.numPlayers > MAX_MPC_PLAYERS;
    results.push({ name: t.name, setup: setupOk, deal: dealOk, callback: cbOk, skippedDeal });
  }

  // For tables that didn't go through full state setup
  const stateNames = new Set(states.map(s => s.test.name));
  for (const t of allTests) {
    if (!stateNames.has(t.name) && !results.some(r => r.name === t.name)) {
      results.push({ name: t.name, setup: false, deal: false, callback: false, skippedDeal: false });
    }
  }

  // ── Summary ──
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  E2E RESULTS SUMMARY');
  console.log('═'.repeat(70));
  console.log(`${'  Name'.padEnd(30)} ${'Setup'.padEnd(8)} ${'Deal'.padEnd(8)} ${'Callback'.padEnd(10)}`);
  console.log('  ' + '─'.repeat(56));

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const s = r.setup ? '✅' : '❌';
    const d = r.deal ? '✅' : (r.skippedDeal ? '⏭️' : (r.setup ? '❌' : '⏭️'));
    const c = r.callback ? '✅' : (r.deal ? '⏳' : '⏭️');
    console.log(`  ${r.name.padEnd(28)} ${s.padEnd(8)} ${d.padEnd(8)} ${c.padEnd(10)}`);
    if (r.setup) passed++;
    else failed++;
  }

  console.log(`\n  Total: ${results.length} tests | ${passed} setup passed | ${results.filter(r => r.callback).length} callbacks received`);
  console.log('═'.repeat(70));
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
