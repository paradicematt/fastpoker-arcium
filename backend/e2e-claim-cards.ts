/**
 * E2E Claim Cards Test — Proves B1 fix: P2+ can decrypt hole cards via claim_hole_cards MPC.
 *
 * What this test PROVES:
 *   1. 3-player table: P0+P1 get encrypted cards from deal callback (existing)
 *   2. P2's SeatCards has NO encrypted cards after deal (the B1 bug)
 *   3. claim_hole_cards MPC queued for P2 → callback writes encrypted cards
 *   4. P2 CAN decrypt their hole cards using their x25519 secret key
 *   5. All 3 players have valid, unique cards
 *
 * Requires: arcium localnet running + circuits initialized (including claim_hole_cards)
 *   wsl bash /mnt/j/Poker-Arc/scripts/start-arcium-localnet.sh
 *   ARCIUM_CLUSTER_OFFSET=0 CIRCUIT_BUILD_DIR=build npx ts-node --transpile-only backend/arcium-init-circuits.ts
 *
 * Run:
 *   ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only backend/e2e-claim-cards.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as crypto from 'crypto';
import * as anchor from '@coral-xyz/anchor';
import {
  getMXEAccAddress, getMempoolAccAddress, getExecutingPoolAccAddress,
  getCompDefAccAddress, getCompDefAccOffset, getComputationAccAddress,
  getClusterAccAddress, getArciumProgramId, getArciumEnv,
  getArciumAccountBaseSeed, x25519, RescueCipher,
  getMXEPublicKey, getArciumProgram,
} from '@arcium-hq/client';

// ── Constants ──
const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const ARCIUM_PROG_ID = getArciumProgramId();
const RPC_URL = 'http://127.0.0.1:8899';
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');
const NUM_PLAYERS = 9;

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
  set_x25519_key: disc('set_x25519_key'),
  start_game: disc('start_game'),
  arcium_deal: disc('arcium_deal'),
  arcium_claim_cards_queue: disc('arcium_claim_cards_queue'),
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
const getCrankTallyEr = (table: PublicKey) => findPda([CRANK_TALLY_ER_SEED, table.toBuffer()]);
const getCrankTallyL1 = (table: PublicKey) => findPda([CRANK_TALLY_L1_SEED, table.toBuffer()]);
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
function readPhase(data: Buffer | Uint8Array): number { return (data as any).readUInt8 ? (data as Buffer).readUInt8(160) : data[160]; }

// Helpers
async function airdrop(conn: Connection, pk: PublicKey, amount: number) {
  const sig = await conn.requestAirdrop(pk, amount);
  await conn.confirmTransaction(sig, 'confirmed');
}
function step(name: string) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}
async function send(conn: Connection, ix: TransactionInstruction, signers: Keypair[], label: string): Promise<boolean> {
  try {
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed', skipPreflight: true });
    console.log(`  ✅ ${label}: ${sig.slice(0, 24)}...`);
    return true;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0, 250)}`);
    if (e.logs) e.logs.slice(-15).forEach((l: string) => console.log(`     ${l}`));
    return false;
  }
}

function serializeTableConfig(tableId: Buffer): Buffer {
  // TableConfig: table_id(32) + game_type(1) + stakes(1) + max_players(1) + tier(1)
  // max_players must be 2, 6, or 9. Use 6-max and seat only NUM_PLAYERS.
  const buf = Buffer.alloc(36);
  tableId.copy(buf, 0, 0, 32);
  buf.writeUInt8(3, 32);  // CashGame
  buf.writeUInt8(0, 33);  // Micro stakes
  buf.writeUInt8(NUM_PLAYERS <= 6 ? 6 : 9, 34);  // 6-max or 9-max depending on NUM_PLAYERS
  buf.writeUInt8(0, 35);  // Micro tier
  return buf;
}

// ── MAIN TEST ──
async function main() {
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║  E2E Claim Cards Test — B1 Fix: P2+ Hole Card Decryption          ║');
  console.log('╚' + '═'.repeat(68) + '╝');

  const conn = new Connection(RPC_URL, 'confirmed');
  const players = Array.from({ length: NUM_PLAYERS }, () => Keypair.generate());

  // ── SETUP ──
  step('STEP 0: Setup');
  for (let i = 0; i < NUM_PLAYERS; i++) {
    await airdrop(conn, players[i].publicKey, 10 * LAMPORTS_PER_SOL);
    console.log(`  Player ${i}: ${players[i].publicKey.toBase58().slice(0, 16)}...`);
  }

  // Get MXE public key
  const kpPath = process.env.KEYPAIR_PATH || require('path').join(__dirname, '.localnet-keypair.json');
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(require('fs').readFileSync(kpPath).toString())));
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const mxePubKey = await getMXEPublicKey(provider, PROGRAM_ID);
  if (!mxePubKey) {
    console.log('  ❌ Failed to get MXE public key — is Arcium localnet running?');
    return;
  }
  console.log(`  MXE x25519 pubkey: ${Buffer.from(mxePubKey).toString('hex').slice(0, 32)}...`);

  // ── REGISTER ──
  step('STEP 1: Register Players');
  for (let i = 0; i < NUM_PLAYERS; i++) {
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: players[i].publicKey, isSigner: true, isWritable: true },
        { pubkey: getPlayer(players[i].publicKey), isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: getPool(), isSigner: false, isWritable: true },
        { pubkey: getUnrefined(players[i].publicKey), isSigner: false, isWritable: true },
        { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: IX.register_player,
    }), [players[i]], `Register P${i}`);
  }

  // ── CREATE TABLE ──
  step(`STEP 2: Create Table (${NUM_PLAYERS}-player Cash)`);
  const tableId = crypto.randomBytes(32);
  const tablePDA = getTable(tableId);
  console.log(`  Table PDA: ${tablePDA.toBase58().slice(0, 16)}...`);
  await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: players[0].publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: getPool(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.create_table, serializeTableConfig(tableId)]),
  }), [players[0]], 'Create Table');

  // ── INIT SEATS ──
  step('STEP 3: Init Seats');
  const MAX_SEATS = NUM_PLAYERS <= 6 ? 6 : 9;
  for (let i = 0; i < MAX_SEATS; i++) {
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: players[0].publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePDA, isSigner: false, isWritable: false },
        { pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getSeatCards(tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getDeckState(tablePDA), isSigner: false, isWritable: true },
        { pubkey: getReceipt(tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getVault(tablePDA), isSigner: false, isWritable: true },
        { pubkey: getCrankTallyEr(tablePDA), isSigner: false, isWritable: true },
        { pubkey: getCrankTallyL1(tablePDA), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([IX.init_table_seat, Buffer.from([i])]),
    }), [players[0]], `Init Seat ${i}`);
  }

  // ── JOIN TABLE ──
  step('STEP 4: Join Table');
  const BUY_IN = 100_000n;
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const joinData = Buffer.alloc(25);
    IX.join_table.copy(joinData, 0);
    joinData.writeBigUInt64LE(BUY_IN, 8);
    joinData.writeUInt8(i, 16);
    joinData.writeBigUInt64LE(0n, 17);
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: players[i].publicKey, isSigner: true, isWritable: true },
        { pubkey: getPlayer(players[i].publicKey), isSigner: false, isWritable: true },
        { pubkey: tablePDA, isSigner: false, isWritable: true },
        { pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getMarker(players[i].publicKey, tablePDA), isSigner: false, isWritable: true },
        { pubkey: getVault(tablePDA), isSigner: false, isWritable: true },
        { pubkey: getReceipt(tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: joinData,
    }), [players[i]], `Join P${i} (seat ${i})`);
  }

  // ── SET X25519 KEYS ──
  step('STEP 4b: Set x25519 Keys');
  interface PlayerKeys { secretKey: Uint8Array; publicKey: Uint8Array; nonce: Buffer; }
  const playerKeys: PlayerKeys[] = [];

  for (let i = 0; i < NUM_PLAYERS; i++) {
    const sk = x25519.utils.randomSecretKey();
    const pk = new Uint8Array(x25519.getPublicKey(sk));
    const nonce = crypto.randomBytes(16);
    playerKeys.push({ secretKey: sk, publicKey: pk, nonce });

    const keyData = Buffer.alloc(40);
    IX.set_x25519_key.copy(keyData, 0);
    Buffer.from(pk).copy(keyData, 8);
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: players[i].publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePDA, isSigner: false, isWritable: false },
        { pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true },
      ],
      data: keyData,
    }), [players[i]], `Set x25519 key P${i}`);
    console.log(`  P${i} x25519: ${Buffer.from(pk).toString('hex').slice(0, 16)}...`);
  }

  // ── START GAME ──
  step('STEP 5: Start Game');
  const seatKeys = [];
  for (let i = 0; i < MAX_SEATS; i++) seatKeys.push({ pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true });
  const started = await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: players[0].publicKey, isSigner: false, isWritable: false },
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: getDeckState(tablePDA), isSigner: false, isWritable: true },
      ...seatKeys,
    ],
    data: IX.start_game,
  }), [players[0]], 'Start Game');
  if (!started) { console.log('  ⚠️  start_game failed — aborting'); return; }

  // ── ARCIUM DEAL ──
  step(`STEP 6: Arcium Deal (${NUM_PLAYERS} players)`);

  const allPubkeys: Buffer[] = [];
  const allNonces: Buffer[] = [];
  for (let i = 0; i < 9; i++) {
    if (i < NUM_PLAYERS) {
      allPubkeys.push(Buffer.from(playerKeys[i].publicKey));
      allNonces.push(playerKeys[i].nonce);
    } else {
      const dummySk = x25519.utils.randomSecretKey();
      allPubkeys.push(Buffer.from(x25519.getPublicKey(dummySk)));
      allNonces.push(crypto.randomBytes(16));
    }
  }

  const arciumEnv = getArciumEnv();
  const clusterOffset = arciumEnv.arciumClusterOffset;
  const computationOffset = BigInt(1) * BigInt(1_000_000) + BigInt(Date.now() % 1_000_000);
  const compDefOffset = Buffer.from(getCompDefAccOffset('shuffle_and_deal')).readUInt32LE(0);

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

  // Build arcium_deal IX
  const playerDataLen = 9 * 48;
  const dataLen = 8 + 8 + 4 + playerDataLen + 1;
  const dealData = Buffer.alloc(dataLen);
  let off = 0;
  IX.arcium_deal.copy(dealData, off); off += 8;
  dealData.writeBigUInt64LE(computationOffset, off); off += 8;
  dealData.writeUInt32LE(playerDataLen, off); off += 4;
  for (let i = 0; i < 9; i++) {
    allPubkeys[i].copy(dealData, off); off += 32;
    allNonces[i].copy(dealData, off); off += 16;
  }
  dealData.writeUInt8(NUM_PLAYERS, off);

  const dealOk = await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: players[0].publicKey,      isSigner: true,  isWritable: true  },
      { pubkey: getSignPda(),              isSigner: false, isWritable: true  },
      { pubkey: mxeAccount,                isSigner: false, isWritable: false },
      { pubkey: mempoolAccount,            isSigner: false, isWritable: true  },
      { pubkey: executingPool,             isSigner: false, isWritable: true  },
      { pubkey: computationAccount,        isSigner: false, isWritable: true  },
      { pubkey: compDefAccount,            isSigner: false, isWritable: false },
      { pubkey: clusterAccount,            isSigner: false, isWritable: true  },
      { pubkey: getArciumFeePoolPda(),     isSigner: false, isWritable: true  },
      { pubkey: getArciumClockPda(),       isSigner: false, isWritable: true  },
      { pubkey: ARCIUM_PROG_ID,            isSigner: false, isWritable: false },
      { pubkey: tablePDA,                  isSigner: false, isWritable: true  },
      { pubkey: getDeckState(tablePDA),    isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
    ],
    data: dealData,
  }), [players[0]], 'arcium_deal');
  if (!dealOk) { console.log('  ⚠️  arcium_deal failed — aborting'); return; }

  // ── WAIT FOR DEAL CALLBACK ──
  step('STEP 7: Waiting for MPC Deal Callback');
  const pollStart = Date.now();
  let finalPhase = -1;
  while (Date.now() - pollStart < 20 * 60 * 1000) {
    const tInfo = await conn.getAccountInfo(tablePDA);
    if (tInfo) {
      const phase = readPhase(Buffer.from(tInfo.data));
      if (phase !== 2) { finalPhase = phase; break; }
    }
    const elapsed = Math.round((Date.now() - pollStart) / 1000);
    process.stdout.write(`\r  Polling... ${elapsed}s (phase=AwaitingDeal)   `);
    await new Promise(r => setTimeout(r, 3000));
  }

  if (finalPhase !== 3) {
    console.log(`\n  ❌ Deal callback failed. Phase: ${PHASE_NAMES[finalPhase] || finalPhase}`);
    return;
  }
  console.log(`\n  ✅ Deal callback SUCCESS! Phase → ${PHASE_NAMES[finalPhase]}`);

  // ══════════════════════════════════════════════════════════
  // STEP 8: VERIFY P0+P1 HAVE CARDS, P2 DOES NOT (THE B1 BUG)
  // ══════════════════════════════════════════════════════════
  step('STEP 8: Verify SeatCards State After Deal');

  const ENC1_OFFSET = 76;
  const NONCE_OFFSET = 140;

  for (let i = 0; i < NUM_PLAYERS; i++) {
    const scAddr = getSeatCards(tablePDA, i);
    const scInfo = await conn.getAccountInfo(scAddr);
    if (!scInfo) { console.log(`  ❌ SeatCards[${i}] not found`); continue; }

    const ct = scInfo.data.slice(ENC1_OFFSET, ENC1_OFFSET + 32);
    const hasData = !ct.every((b: number) => b === 0);
    const nonce = scInfo.data.slice(NONCE_OFFSET, NONCE_OFFSET + 16);
    const hasNonce = !nonce.every((b: number) => b === 0);

    if (i < 2) {
      console.log(`  P${i} SeatCards: enc_card1=${hasData ? '✅ PRESENT' : '❌ MISSING'}  nonce=${hasNonce ? '✅' : '❌'}`);
    } else {
      // P2+ should NOT have encrypted cards from deal callback (this IS the B1 bug)
      console.log(`  P${i} SeatCards: enc_card1=${hasData ? '⚠️  ALREADY PRESENT (unexpected)' : '🔴 EMPTY (B1 bug confirmed)'}  nonce=${hasNonce ? '⚠️' : '🔴 empty'}`);
    }
  }

  // ══════════════════════════════════════════════════════════
  // STEP 9: QUEUE claim_hole_cards FOR P2+ (all seats beyond stride-3 window)
  // ══════════════════════════════════════════════════════════
  const claimSeats = Array.from({ length: NUM_PLAYERS - 2 }, (_, i) => i + 2);
  step(`STEP 9: Queue claim_hole_cards for P${claimSeats[0]}-P${claimSeats[claimSeats.length - 1]}`);

  const claimCompDefOffset = Buffer.from(getCompDefAccOffset('claim_hole_cards')).readUInt32LE(0);
  const claimCompDefAccount = getCompDefAccAddress(PROGRAM_ID, claimCompDefOffset);
  let allClaimsQueued = true;

  for (const seatIdx of claimSeats) {
    const claimCompOffset = BigInt(1) * BigInt(1_000_000) + BigInt(500 + seatIdx) * BigInt(1_000) + BigInt(Date.now() % 1_000);
    const claimCompOffsetBuf = Buffer.alloc(8);
    claimCompOffsetBuf.writeBigUInt64LE(claimCompOffset);
    const claimComputationAccount = getComputationAccAddress(
      clusterOffset,
      { toArrayLike: (_B: any, _e: string, l: number) => { const b = Buffer.alloc(l); claimCompOffsetBuf.copy(b); return b; } } as any,
    );

    const claimData = Buffer.alloc(17);
    IX.arcium_claim_cards_queue.copy(claimData, 0);
    claimData.writeBigUInt64LE(claimCompOffset, 8);
    claimData.writeUInt8(seatIdx, 16);

    const ok = await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: players[0].publicKey,       isSigner: true,  isWritable: true  },
        { pubkey: getSignPda(),               isSigner: false, isWritable: true  },
        { pubkey: mxeAccount,                 isSigner: false, isWritable: false },
        { pubkey: getMempoolAccAddress(clusterOffset), isSigner: false, isWritable: true  },
        { pubkey: getExecutingPoolAccAddress(clusterOffset), isSigner: false, isWritable: true  },
        { pubkey: claimComputationAccount,    isSigner: false, isWritable: true  },
        { pubkey: claimCompDefAccount,        isSigner: false, isWritable: false },
        { pubkey: clusterAccount,             isSigner: false, isWritable: true  },
        { pubkey: getArciumFeePoolPda(),      isSigner: false, isWritable: true  },
        { pubkey: getArciumClockPda(),        isSigner: false, isWritable: true  },
        { pubkey: ARCIUM_PROG_ID,             isSigner: false, isWritable: false },
        { pubkey: tablePDA,                   isSigner: false, isWritable: false },
        { pubkey: getDeckState(tablePDA),     isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
      ],
      data: claimData,
    }), [players[0]], `arcium_claim_cards_queue (seat ${seatIdx})`);

    if (!ok) { allClaimsQueued = false; break; }
    // Small delay between queues to avoid computation offset collisions
    await new Promise(r => setTimeout(r, 500));
  }

  if (!allClaimsQueued) {
    console.log('  ❌ claim_hole_cards queue failed — aborting');
  } else {
    // ══════════════════════════════════════════════════════════
    // STEP 10: WAIT FOR ALL CLAIM CALLBACKS
    // ══════════════════════════════════════════════════════════
    step(`STEP 10: Waiting for ${claimSeats.length} claim_hole_cards MPC Callbacks`);
    const claimStart = Date.now();
    const received = new Set<number>();
    while (Date.now() - claimStart < 15 * 60 * 1000 && received.size < claimSeats.length) {
      for (const seatIdx of claimSeats) {
        if (received.has(seatIdx)) continue;
        const scInfo = await conn.getAccountInfo(getSeatCards(tablePDA, seatIdx));
        if (scInfo) {
          const ct = scInfo.data.slice(ENC1_OFFSET, ENC1_OFFSET + 32);
          if (!ct.every((b: number) => b === 0)) {
            received.add(seatIdx);
            console.log(`\n  ✅ P${seatIdx} claim callback received!`);
          }
        }
      }
      if (received.size < claimSeats.length) {
        const pending = claimSeats.filter(s => !received.has(s)).join(',');
        const elapsed = Math.round((Date.now() - claimStart) / 1000);
        process.stdout.write(`\r  Polling... ${elapsed}s (${received.size}/${claimSeats.length} received, waiting: P${pending})   `);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    const missing = claimSeats.filter(s => !received.has(s));
    if (missing.length > 0) {
      console.log(`\n  ❌ Timed out waiting for: P${missing.join(', P')}`);
    } else {
      console.log(`  ✅ All ${claimSeats.length} claim callbacks received!`);
    }
  }

  // ══════════════════════════════════════════════════════════
  // STEP 11: DECRYPT ALL PLAYERS' CARDS
  // ══════════════════════════════════════════════════════════
  step('STEP 11: Decrypt All Players\' Hole Cards');

  let allValid = true;
  const dealtCards: number[] = [];

  for (let i = 0; i < NUM_PLAYERS; i++) {
    const pk = playerKeys[i];
    const scAddr = getSeatCards(tablePDA, i);
    const scInfo = await conn.getAccountInfo(scAddr);
    if (!scInfo) { console.log(`  ❌ SeatCards[${i}] not found`); allValid = false; continue; }

    const ciphertext = scInfo.data.slice(ENC1_OFFSET, ENC1_OFFSET + 32);
    const hasData = !ciphertext.every((b: number) => b === 0);
    const outputNonce = Buffer.from(scInfo.data.slice(NONCE_OFFSET, NONCE_OFFSET + 16));
    const hasNonce = !outputNonce.every((b: number) => b === 0);

    console.log(`  P${i}: enc_card1=${hasData ? 'YES' : 'NO'}  nonce=${hasNonce ? 'YES' : 'NO'}`);

    if (!hasData || !hasNonce) {
      console.log(`    ❌ P${i}: Missing encrypted data — cannot decrypt`);
      allValid = false;
      continue;
    }

    const enc2 = scInfo.data.slice(108, 140);

    // Derive shared secret once for diagnostics + decryption
    const sharedSecret = x25519.getSharedSecret(pk.secretKey, mxePubKey);

    // Diagnostic: dump raw bytes for ALL players (compare deal vs claim format)
    {
      console.log(`    raw ct:    ${Buffer.from(ciphertext).toString('hex')}`);
      console.log(`    raw nonce: ${Buffer.from(outputNonce).toString('hex')}`);
      // Also read enc_card2 at offset 108 (might have useful data)
      const enc2Hex = Buffer.from(enc2).toString('hex');
      console.log(`    raw enc2:  ${enc2Hex}`);
      if (i >= 2) {
        const enc2Nonce = Buffer.from(enc2.slice(0, 16));
        console.log(`    enc2 nonce slot: ${enc2Nonce.toString('hex')}`);
        console.log(`    enc2 nonce match: ${enc2Nonce.equals(outputNonce) ? '✅' : '❌'}`);
      }
      // Read input nonce from DeckState for comparison
      const dsInfo = await conn.getAccountInfo(getDeckState(tablePDA));
      if (dsInfo) {
        // hole_card_nonces starts after encrypted_hole_cards
        // DeckState layout: disc(8)+table(32)+bump(1)+shuffle(1)+revealed(1)+hand(8)+offset(8)+community(5×32)+hole_cards(12×32)+nonces(12×16)
        const NONCES_OFFSET = 8 + 32 + 1 + 1 + 1 + 8 + 8 + 5*32 + 12*32 + 5*16; // = 683
        const inputNonce = Buffer.from(dsInfo.data.slice(NONCES_OFFSET + i*16, NONCES_OFFSET + i*16 + 16));
        console.log(`    input nonce (DeckState): ${inputNonce.toString('hex')}`);
        // Compute expected output nonce = input + 1
        const inU128 = BigInt('0x' + Buffer.from(inputNonce).reverse().toString('hex'));
        const outU128 = inU128 + 1n;
        const expectedOut = Buffer.alloc(16);
        let tmp = outU128;
        for (let b = 0; b < 16; b++) { expectedOut[b] = Number(tmp & 0xFFn); tmp >>= 8n; }
        console.log(`    expected output nonce:   ${expectedOut.toString('hex')}`);
        const nonceMatch = outputNonce.equals(expectedOut);
        console.log(`    nonce match: ${nonceMatch ? '✅' : '❌ MISMATCH'}`);
      }
    }

    // Diagnostic: shared secret + cipher self-test
    if (i === 0 || i >= 2) {
      console.log(`    shared secret: ${Buffer.from(sharedSecret).toString('hex').slice(0,32)}...`);
      const testCipher = new RescueCipher(sharedSecret);
      const testNonce = new Uint8Array(16); testNonce[0] = 99;
      const testCt = testCipher.encrypt([12345n], testNonce);
      const testPt = testCipher.decrypt(testCt, testNonce);
      console.log(`    cipher self-test: encrypt(12345)→decrypt=${testPt[0]} ${testPt[0] === 12345n ? '✅' : '❌'}`);
      // Also verify the x25519 pubkey in DeckState matches what we sent
      const dsInfo2 = await conn.getAccountInfo(getDeckState(tablePDA));
      if (dsInfo2) {
        const HOLE_CARDS_OFFSET = 8 + 32 + 1 + 1 + 1 + 8 + 8 + 5*32; // = 219
        const storedPubkey = Buffer.from(dsInfo2.data.slice(HOLE_CARDS_OFFSET + i*32, HOLE_CARDS_OFFSET + i*32 + 32));
        const expectedPubkey = Buffer.from(pk.publicKey);
        const pubkeyMatch = storedPubkey.equals(expectedPubkey);
        console.log(`    x25519 pubkey match: ${pubkeyMatch ? '✅' : '❌ MISMATCH'}`);
        if (!pubkeyMatch) {
          console.log(`      stored:   ${storedPubkey.toString('hex')}`);
          console.log(`      expected: ${expectedPubkey.toString('hex')}`);
        }
      }
    }
    try {
      const cipher = new RescueCipher(sharedSecret);
      const ctArray = [Array.from(ciphertext)];

      // Try multiple decryption strategies
      const strategies: [string, Buffer][] = [
        ['outputNonce', outputNonce],
      ];
      // Also try with input nonce and input+1
      const inputNonce = playerKeys[i].nonce;
      const inU128 = BigInt('0x' + Buffer.from(inputNonce).reverse().toString('hex'));
      const computedOut = Buffer.alloc(16);
      let tmpVal = inU128 + 1n;
      for (let b = 0; b < 16; b++) { computedOut[b] = Number(tmpVal & 0xFFn); tmpVal >>= 8n; }
      strategies.push(['inputNonce', inputNonce]);
      strategies.push(['computedNonce(in+1)', computedOut]);

      let bestVal: bigint | null = null;
      for (const [label, nonce] of strategies) {
        try {
          const val = cipher.decrypt(ctArray, nonce)[0];
          const ok = val >= 0n && val <= 65535n;
          if (i >= 2) console.log(`    ${label}: ${ok ? `✅ ${val}` : `❌ ${val.toString().slice(0, 20)}...`}`);
          if (ok && bestVal === null) bestVal = val;
        } catch (e: any) {
          if (i >= 2) console.log(`    ${label}: ❌ error ${e.message?.slice(0, 60)}`);
        }
      }

      // For P2+: also try decrypting enc_card2 (slot 2) with all nonce strategies
      if (i >= 2 && bestVal === null) {
        const enc2Data = scInfo.data.slice(108, 140);
        const enc2HasData = !enc2Data.every((b: number) => b === 0);
        if (enc2HasData) {
          console.log(`    --- Trying enc_card2 (slot 2) as ciphertext ---`);
          console.log(`    slot2 hex: ${Buffer.from(enc2Data).toString('hex')}`);
          const ct2Array = [Array.from(enc2Data)];
          for (const [label, nonce] of strategies) {
            try {
              const val = cipher.decrypt(ct2Array, nonce)[0];
              const ok = val >= 0n && val <= 65535n;
              console.log(`    slot2+${label}: ${ok ? `✅ ${val}` : `❌ ${val.toString().slice(0, 20)}...`}`);
              if (ok && bestVal === null) bestVal = val;
            } catch (e: any) {
              console.log(`    slot2+${label}: ❌ error ${e.message?.slice(0, 60)}`);
            }
          }
        }
      }

      const plaintext = bestVal !== null ? [bestVal] : cipher.decrypt(ctArray, outputNonce);
      const packedBig = plaintext[0] as bigint;
      const card1 = Number((packedBig >> 8n) & 0xFFn);
      const card2 = Number(packedBig & 0xFFn);

      const valid1 = card1 >= 0 && card1 <= 51;
      const valid2 = card2 >= 0 && card2 <= 51;

      console.log(`    decrypted: ${packedBig} → ${cardName(card1)} ${cardName(card2)}  ${valid1 && valid2 ? '✅' : '❌'}`);

      if (!valid1 || !valid2) allValid = false;
      dealtCards.push(card1, card2);
    } catch (e: any) {
      console.log(`    ❌ Decryption failed: ${e.message?.slice(0, 120)}`);
      allValid = false;
    }
  }

  // Uniqueness check
  const uniqueCards = new Set(dealtCards);
  const noDuplicates = uniqueCards.size === dealtCards.length;
  console.log(`\n  Card uniqueness: ${dealtCards.length} cards, ${uniqueCards.size} unique ${noDuplicates ? '✅' : '❌ DUPLICATES!'}`);
  if (!noDuplicates) allValid = false;

  // ══════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ══════════════════════════════════════════════════════════
  step('FINAL SUMMARY');

  const pCards = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const c = dealtCards.length >= (i + 1) * 2
      ? `${cardName(dealtCards[i * 2])} ${cardName(dealtCards[i * 2 + 1])}`
      : '?? ??';
    pCards.push(c);
  }

  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │         POKER TABLE (3-max Preflop)           │');
  console.log('  ├──────────────────────────────────────────────┤');
  console.log('  │  Board: 🔒 🔒 🔒 🔒 🔒                      │');
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const src = i < 2 ? 'deal callback' : 'claim_hole_cards';
    console.log(`  │  P${i} (seat ${i}): [ ${pCards[i]} ] via ${src.padEnd(16)}│`);
  }
  console.log('  ├──────────────────────────────────────────────┤');
  console.log(`  │  All cards valid & unique: ${allValid && noDuplicates ? '✅ PASS' : '❌ FAIL'}              │`);
  console.log(`  │  B1 fix verified: ${dealtCards.length === NUM_PLAYERS * 2 ? '✅ P2 CAN DECRYPT' : '❌ P2 CANNOT DECRYPT'} │`);
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');

  if (allValid && noDuplicates && dealtCards.length === NUM_PLAYERS * 2) {
    console.log('  🎉 B1 FIX VERIFIED: All 3 players can decrypt their hole cards!');
    process.exit(0);
  } else {
    console.log('  ❌ TEST FAILED');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
