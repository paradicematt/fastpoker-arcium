/**
 * Smoke Test: Arcium Deal — Queue MPC shuffle_and_deal
 *
 * Tests the arcium_deal instruction which does CPI to Arcium's queue_computation:
 *   1. Register 2 players + create HU cash game
 *   2. Init seats, join table, start game (→ Starting)
 *   3. Call arcium_deal (→ AwaitingDeal) — queues MPC shuffle_and_deal
 *   4. Verify phase transition and computation offset in DeckState
 *
 * Run from backend/: npx ts-node ../tests/smoke-test-arcium-deal.ts
 * Requires: arcium localnet running (scripts/start-arcium-localnet.sh)
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

// Arcium PDA helpers
function getArciumClockPda(): PublicKey {
  return PublicKey.findProgramAddressSync([getArciumAccountBaseSeed('ClockAccount')], ARCIUM_PROG_ID)[0];
}
function getArciumFeePoolPda(): PublicKey {
  return PublicKey.findProgramAddressSync([getArciumAccountBaseSeed('FeePool')], ARCIUM_PROG_ID)[0];
}

// Table state reader
const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop',
  4: 'Flop', 5: 'Turn', 6: 'River', 7: 'Showdown',
  8: 'AwaitingShowdown', 9: 'Complete',
  10: 'FlopRevealPending', 11: 'TurnRevealPending', 12: 'RiverRevealPending',
};
function readPhase(data: Buffer): number { return data.readUInt8(160); }
function readHandNumber(data: Buffer): bigint { return data.readBigUInt64LE(123); }

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
  const buf = Buffer.alloc(36);
  tableId.copy(buf, 0, 0, 32);
  buf.writeUInt8(3, 32);  // CashGame
  buf.writeUInt8(0, 33);  // Micro
  buf.writeUInt8(2, 34);  // HU (2 players)
  buf.writeUInt8(0, 35);  // Micro tier
  return buf;
}

// ── Main Test ──
async function main() {
  console.log('='.repeat(70));
  console.log('  Arcium Deal Smoke Test — MPC shuffle_and_deal');
  console.log('='.repeat(70));

  const conn = new Connection(RPC_URL, 'confirmed');
  const playerA = Keypair.generate();
  const playerB = Keypair.generate();

  step('STEP 0: Setup');
  await airdrop(conn, playerA.publicKey, 10 * LAMPORTS_PER_SOL);
  await airdrop(conn, playerB.publicKey, 10 * LAMPORTS_PER_SOL);
  console.log(`  Player A: ${playerA.publicKey.toBase58().slice(0, 16)}...`);
  console.log(`  Player B: ${playerB.publicKey.toBase58().slice(0, 16)}...`);

  // Register players
  step('STEP 1: Register Players');
  for (const [label, player] of [['A', playerA], ['B', playerB]] as [string, Keypair][]) {
    await send(conn, new TransactionInstruction({
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
    }), [player], `Register ${label}`);
  }

  // Create table
  step('STEP 2: Create Table (HU Cash)');
  const tableId = crypto.randomBytes(32);
  const tablePDA = getTable(tableId);
  console.log(`  Table PDA: ${tablePDA.toBase58().slice(0, 16)}...`);

  await send(conn, new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: playerA.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: getPool(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.create_table, serializeTableConfig(tableId)]),
  }), [playerA], 'Create Table');

  // Init seats
  step('STEP 3: Init Seats');
  for (let i = 0; i < 2; i++) {
    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: playerA.publicKey, isSigner: true, isWritable: true },
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
    }), [playerA], `Init Seat ${i}`);
  }

  // Join table
  step('STEP 4: Join Table');
  const BUY_IN = 100_000n;
  for (const [label, player, i] of [['A', playerA, 0], ['B', playerB, 1]] as [string, Keypair, number][]) {
    const joinData = Buffer.alloc(25);
    IX.join_table.copy(joinData, 0);
    joinData.writeBigUInt64LE(BUY_IN, 8);
    joinData.writeUInt8(i, 16);
    joinData.writeBigUInt64LE(0n, 17);

    await send(conn, new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: getPlayer(player.publicKey), isSigner: false, isWritable: true },
        { pubkey: tablePDA, isSigner: false, isWritable: true },
        { pubkey: getSeat(tablePDA, i), isSigner: false, isWritable: true },
        { pubkey: getMarker(player.publicKey, tablePDA), isSigner: false, isWritable: true },
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
    }), [player], `Join ${label} (seat ${i})`);
  }

  // Start game
  step('STEP 5: Start Game');
  const startIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: playerA.publicKey, isSigner: false, isWritable: false },
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: getDeckState(tablePDA), isSigner: false, isWritable: true },
      { pubkey: getSeat(tablePDA, 0), isSigner: false, isWritable: true },
      { pubkey: getSeat(tablePDA, 1), isSigner: false, isWritable: true },
    ],
    data: IX.start_game,
  });
  const started = await send(conn, startIx, [playerA], 'Start Game');
  if (!started) { console.log('  ⚠️  start_game failed — aborting'); return; }

  let info = await conn.getAccountInfo(tablePDA);
  if (info) {
    const phase = readPhase(info.data);
    console.log(`  Phase: ${PHASE_NAMES[phase]} (${phase})`);
    if (phase !== 1) { console.log('  ⚠️  Expected Starting (1)'); return; }
  }

  // ── STEP 6: ARCIUM DEAL ──
  step('STEP 6: arcium_deal (MPC queue_computation CPI)');

  try {
    const arciumEnv = getArciumEnv();
    const clusterOffset = arciumEnv.arciumClusterOffset;

    // Computation offset: unique
    const computationOffset = BigInt(1) * BigInt(1_000_000) + BigInt(Date.now() % 1_000_000);
    const compDefOffset = Buffer.from(getCompDefAccOffset('shuffle_and_deal')).readUInt32LE(0);

    // Player x25519 pubkeys + nonces
    // Generate x25519 keypairs for ALL 9 slots.
    // Empty seats use a valid dummy key (all-zero pubkeys are rejected by Arcium MPC nodes).
    const dummyPrivKey = x25519.utils.randomSecretKey();
    const dummyPubKey = x25519.getPublicKey(dummyPrivKey);
    const playerPubkeys: Buffer[] = [];
    const playerNonces: Buffer[] = [];
    for (let i = 0; i < 9; i++) {
      if (i < 2) {
        const privKey = x25519.utils.randomSecretKey();
        const pubKey = x25519.getPublicKey(privKey);
        playerPubkeys.push(Buffer.from(pubKey));
        playerNonces.push(crypto.randomBytes(16));
      } else {
        // Empty seat — use valid dummy x25519 key (Arcium rejects all-zero pubkeys)
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
    const signPdaAccount = getSignPda();
    const feePool = getArciumFeePoolPda();
    const clockPda = getArciumClockPda();

    console.log(`  Computation offset: ${computationOffset}`);
    console.log(`  CompDef offset: ${compDefOffset}`);
    console.log(`  MXE: ${mxeAccount.toBase58().slice(0, 16)}...`);
    console.log(`  CompDef: ${compDefAccount.toBase58().slice(0, 16)}...`);
    console.log(`  Computation: ${computationAccount.toBase58().slice(0, 16)}...`);

    // Build instruction data:
    // disc(8) + computation_offset(u64) + player_data(Vec<u8>: u32 len + 9×48) + num_players(u8)
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
    data.writeUInt8(2, off); // num_players = 2

    // Account list matching ArciumDeal struct
    const arciumDealIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: playerA.publicKey,       isSigner: true,  isWritable: true  }, // payer
        { pubkey: signPdaAccount,          isSigner: false, isWritable: true  }, // sign_pda_account
        { pubkey: mxeAccount,              isSigner: false, isWritable: false }, // mxe_account
        { pubkey: mempoolAccount,          isSigner: false, isWritable: true  }, // mempool_account
        { pubkey: executingPool,           isSigner: false, isWritable: true  }, // executing_pool
        { pubkey: computationAccount,      isSigner: false, isWritable: true  }, // computation_account
        { pubkey: compDefAccount,          isSigner: false, isWritable: false }, // comp_def_account
        { pubkey: clusterAccount,          isSigner: false, isWritable: true  }, // cluster_account
        { pubkey: feePool,                 isSigner: false, isWritable: true  }, // pool_account
        { pubkey: clockPda,                isSigner: false, isWritable: true  }, // clock_account
        { pubkey: ARCIUM_PROG_ID,          isSigner: false, isWritable: false }, // arcium_program
        { pubkey: tablePDA,                isSigner: false, isWritable: true  }, // table
        { pubkey: getDeckState(tablePDA),  isSigner: false, isWritable: true  }, // deck_state
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const ok = await send(conn, arciumDealIx, [playerA], 'arcium_deal');

    if (ok) {
      info = await conn.getAccountInfo(tablePDA);
      if (info) {
        const phase = readPhase(info.data);
        const handNum = readHandNumber(info.data);
        console.log(`\n  📊 After arcium_deal:`);
        console.log(`  Phase: ${PHASE_NAMES[phase]} (${phase})`);
        console.log(`  Hand #${handNum}`);
        if (phase === 2) {
          console.log(`  ✅ SUCCESS — Phase transitioned to AwaitingDeal!`);
          console.log(`  MPC shuffle_and_deal computation queued on Arcium`);
        } else {
          console.log(`  ⚠️  Expected AwaitingDeal (2), got ${PHASE_NAMES[phase]}`);
        }
      }

      // Read DeckState to verify computation_offset
      const deckInfo = await conn.getAccountInfo(getDeckState(tablePDA));
      if (deckInfo && deckInfo.data.length > 50) {
        const storedOffset = deckInfo.data.readBigUInt64LE(8 + 32 + 1 + 1 + 1 + 8); // after disc+table+bump+shuffle+cards+hand
        console.log(`  DeckState computation_offset: ${storedOffset}`);
      }
    }
  } catch (e: any) {
    console.error(`  ❌ arcium_deal error: ${e.message?.slice(0, 200)}`);
    if (e.logs) e.logs.slice(-10).forEach((l: string) => console.log(`     ${l}`));
  }

  // ── STEP 7: Poll for MPC callback result ──
  step('STEP 7: Waiting for MPC callback (up to 5 min)');
  const pollStart = Date.now();
  const POLL_TIMEOUT_MS = 5 * 60 * 1000;
  const POLL_INTERVAL_MS = 3000;
  let finalPhase = -1;

  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    const tInfo = await conn.getAccountInfo(tablePDA);
    if (tInfo) {
      const phase = readPhase(tInfo.data);
      if (phase !== 2) { // No longer AwaitingDeal
        finalPhase = phase;
        break;
      }
    }
    const elapsed = Math.round((Date.now() - pollStart) / 1000);
    process.stdout.write(`\r  Polling... ${elapsed}s (phase=AwaitingDeal)   `);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (finalPhase === 3) {
    console.log(`\n  ✅ MPC CALLBACK SUCCESS! Phase → Preflop (3)`);
    console.log(`  Encrypted cards have been dealt to SeatCards.`);

    // Read SeatCards to verify encrypted data
    for (let i = 0; i < 2; i++) {
      const scInfo = await conn.getAccountInfo(getSeatCards(tablePDA, i));
      if (scInfo) {
        // enc_card1 at offset 76 (32 bytes)
        const enc1 = scInfo.data.slice(76, 108);
        const hasEnc = !enc1.every((b: number) => b === 0);
        console.log(`  SeatCards[${i}]: enc_card1 present=${hasEnc} (${enc1.slice(0, 4).toString('hex')}...)`);
      }
    }

    // Read DeckState encrypted community
    const dsInfo = await conn.getAccountInfo(getDeckState(tablePDA));
    if (dsInfo && dsInfo.data.length > 200) {
      console.log(`  DeckState: shuffle_complete=${dsInfo.data[8 + 32 + 1] === 1}`);
    }
  } else if (finalPhase === -1) {
    console.log(`\n  ⏰ TIMEOUT — MPC callback did not arrive in 5 minutes.`);
    console.log(`  Table still in AwaitingDeal. Possible causes:`);
    console.log(`    - Circuit bytecode incomplete (shuffle_and_deal upload timed out)`);
    console.log(`    - MPC nodes need more preprocessing time for first execution`);
    console.log(`    - Docker resource constraints`);
  } else {
    console.log(`\n  ⚠️ Unexpected phase: ${PHASE_NAMES[finalPhase]} (${finalPhase})`);
    if (finalPhase === 0) {
      console.log(`  Phase=Waiting — MPC callback arrived but returned Failure (AbortedComputation).`);
      console.log(`  Check Docker node logs: wsl docker logs artifacts-arx-node-0-1`);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('  Arcium deal smoke test complete!');
  console.log('='.repeat(70));
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
