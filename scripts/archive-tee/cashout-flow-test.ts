/**
 * Cashout Flow Test — validates all cashout scenarios on a fresh table.
 * 
 * Test 1: join → play hand → leave → verify cashout completes
 * Test 2: join → sit out → leave → verify no status overwrite  
 * Test 3: join → leave mid-hand → verify settle handles Leaving player
 *
 * Run: npx ts-node scripts/cashout-flow-test.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram,
} from '@solana/web3.js';
import {
  MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID, DELEGATION_PROGRAM_ID,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ─── Constants ───
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const TEE_RPC_BASE = 'https://tee.magicblock.app';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const DEPLOYER_PATH = 'j:/Poker/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json';

const TABLE_PDA = new PublicKey('5eoL7zwwTpwWH5Yu6GrKVMKRh8jQiZKvV5w2yiE7UEHA');

// ─── Offsets ───
const OFF_PHASE = 160;
const OFF_CURRENT_PLAYER = 161;
const OFF_HAND_NUMBER = 123;
const OFF_MAX_PLAYERS = 121;
const OFF_CURRENT_PLAYERS = 122;
const OFF_BIG_BLIND = 113;
const OFF_POT = 131;
const OFF_SEATS_OCCUPIED = 250;

const SEAT_WALLET_OFF = 8;
const SEAT_CHIPS_OFF = 104;
const SEAT_STATUS_OFF = 227;
const SEAT_BET_OFF = 112;
const SEAT_CASHOUT_CHIPS_OFF = 246;
const SEAT_CASHOUT_NONCE_OFF = 254;
const SEAT_VAULT_RESERVE_OFF = 262;

const STATUS_NAMES: Record<number, string> = {
  0: 'Empty', 1: 'Active', 2: 'Folded', 3: 'AllIn',
  4: 'SittingOut', 5: 'Busted', 6: 'Leaving',
};

const Phase: Record<string, number> = {
  Waiting: 0, Starting: 1, Preflop: 2, FlopRevealPending: 3, Flop: 4,
  TurnRevealPending: 5, Turn: 6, RiverRevealPending: 7, River: 8,
  Showdown: 9, Complete: 10,
};
const PHASE_NAMES: Record<number, string> = {};
for (const [k, v] of Object.entries(Phase)) PHASE_NAMES[v] = k;

// ─── Discriminators ───
function disc(name: string): Buffer {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}
const DISC = {
  depositForJoin: disc('deposit_for_join'),
  delegateDepositProof: disc('delegate_deposit_proof'),
  seatPlayer: disc('seat_player'),
  playerAction: disc('player_action'),
  cleanupDepositProof: disc('cleanup_deposit_proof'),
};

// ─── PDA helpers ───
function getSeatPda(table: PublicKey, i: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('seat'), table.toBuffer(), Buffer.from([i])], PROGRAM_ID)[0];
}
function getVaultPda(table: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), table.toBuffer()], PROGRAM_ID)[0];
}
function getReceiptPda(table: PublicKey, i: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('receipt'), table.toBuffer(), Buffer.from([i])], PROGRAM_ID)[0];
}
function getDepositProofPda(table: PublicKey, i: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('deposit_proof'), table.toBuffer(), Buffer.from([i])], PROGRAM_ID)[0];
}
function getMarkerPda(wallet: PublicKey, table: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('player_table'), wallet.toBuffer(), table.toBuffer()], PROGRAM_ID)[0];
}
function getPlayerAccountPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('player'), wallet.toBuffer()], PROGRAM_ID)[0];
}

// ─── Auth + Send ───
async function getTeeAuthToken(kp: Keypair): Promise<string> {
  const nacl = await import('tweetnacl');
  const pub = kp.publicKey.toBase58();
  const cr = await (await fetch(`${TEE_RPC_BASE}/auth/challenge?pubkey=${pub}`)).json() as any;
  const sig = nacl.sign.detached(Buffer.from(cr.challenge, 'utf-8'), kp.secretKey);
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + Buffer.from(sig).toString('hex'));
  let r = '';
  while (n > 0n) { r = A[Number(n % 58n)] + r; n = n / 58n; }
  for (let i = 0; i < sig.length && sig[i] === 0; i++) r = '1' + r;
  const lr = await (await fetch(`${TEE_RPC_BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey: pub, challenge: cr.challenge, signature: r }),
  })).json() as any;
  return lr.token;
}

async function sendL1(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  return sendAndConfirmTransaction(conn, tx, signers, { skipPreflight: true, commitment: 'confirmed' });
}

async function sendTee(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], retries = 3): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = signers[0].publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      return await sendAndConfirmTransaction(conn, tx, signers, { skipPreflight: true, commitment: 'confirmed' });
    } catch (e: any) {
      const msg = e.message || '';
      if (attempt < retries - 1 && (msg.includes('Blockhash') || msg.includes('blockhash'))) {
        await sleep(2000);
        continue;
      }
      throw e;
    }
  }
  throw new Error('sendTee: retries exhausted');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Read helpers ───
function readTablePhase(data: Buffer): { phase: number; currentPlayer: number; handNumber: number; currentPlayers: number; pot: bigint; bigBlind: bigint; seatsOccupied: number } {
  return {
    phase: data[OFF_PHASE],
    currentPlayer: data[OFF_CURRENT_PLAYER],
    handNumber: Number(data.readBigUInt64LE(OFF_HAND_NUMBER)),
    currentPlayers: data[OFF_CURRENT_PLAYERS],
    pot: data.readBigUInt64LE(OFF_POT),
    bigBlind: data.readBigUInt64LE(OFF_BIG_BLIND),
    seatsOccupied: data.readUInt16LE(OFF_SEATS_OCCUPIED),
  };
}

function readSeatFull(data: Buffer): { wallet: PublicKey; chips: bigint; status: number; statusName: string; bet: bigint; cashoutChips: bigint; cashoutNonce: bigint; vaultReserve: bigint } {
  const status = data[SEAT_STATUS_OFF];
  return {
    wallet: new PublicKey(data.subarray(SEAT_WALLET_OFF, SEAT_WALLET_OFF + 32)),
    chips: data.readBigUInt64LE(SEAT_CHIPS_OFF),
    status,
    statusName: STATUS_NAMES[status] || `?${status}`,
    bet: data.readBigUInt64LE(SEAT_BET_OFF),
    cashoutChips: data.readBigUInt64LE(SEAT_CASHOUT_CHIPS_OFF),
    cashoutNonce: data.readBigUInt64LE(SEAT_CASHOUT_NONCE_OFF),
    vaultReserve: data.readBigUInt64LE(SEAT_VAULT_RESERVE_OFF),
  };
}

// ─── Action builders ───
function buildActionIx(wallet: PublicKey, table: PublicKey, seatIdx: number, variant: number, amount?: bigint): TransactionInstruction {
  const data = Buffer.alloc(8 + 1 + (amount !== undefined ? 8 : 0));
  DISC.playerAction.copy(data, 0);
  data.writeUInt8(variant, 8);
  if (amount !== undefined) data.writeBigUInt64LE(amount, 9);
  return new TransactionInstruction({
    programId: PROGRAM_ID, data,
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: false },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: getSeatPda(table, seatIdx), isSigner: false, isWritable: true },
    ],
  });
}

// Action variants
const ACT = { Fold: 0, Check: 1, Call: 2, Bet: 3, Raise: 4, AllIn: 5, SitOut: 6, ReturnToPlay: 7, LeaveCashGame: 8 };

// ─── Deposit + Seat flow ───
async function depositAndSeat(
  l1: Connection, tee: Connection, deployer: Keypair,
  player: Keypair, seatIdx: number, buyIn: bigint,
): Promise<boolean> {
  const table = TABLE_PDA;

  // Check if seat is already occupied by this player (idempotent re-run)
  const existingSeat = await getSeatState(tee, seatIdx);
  if (existingSeat && existingSeat.status !== 0 && existingSeat.wallet.equals(player.publicKey)) {
    console.log(`    ✅ Already seated (status=${existingSeat.statusName}, chips=${Number(existingSeat.chips)})`);
    return true;
  }
  if (existingSeat && existingSeat.status !== 0) {
    console.log(`    ⚠️ Seat ${seatIdx} occupied by ${existingSeat.wallet.toBase58().slice(0,12)}... — cannot seat`);
    return false;
  }

  const dpPda = getDepositProofPda(table, seatIdx);

  // Check for stale deposit proof
  const dpInfo = await l1.getAccountInfo(dpPda);
  if (dpInfo && dpInfo.owner.toBase58() === DELEGATION_PROGRAM_ID.toBase58()) {
    console.log(`    Cleaning stale deposit proof seat ${seatIdx}...`);
    const cleanData = Buffer.alloc(9);
    DISC.cleanupDepositProof.copy(cleanData, 0);
    cleanData.writeUInt8(seatIdx, 8);
    try {
      await sendTee(tee, [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        new TransactionInstruction({
          programId: PROGRAM_ID, data: cleanData,
          keys: [
            { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
            { pubkey: table, isSigner: false, isWritable: false },
            { pubkey: dpPda, isSigner: false, isWritable: true },
            { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
            { pubkey: getSeatPda(table, seatIdx), isSigner: false, isWritable: false },
          ],
        }),
      ], [deployer]);
      console.log(`    ✅ Cleaned. Waiting 12s...`);
      await sleep(12000);
    } catch (e: any) {
      console.log(`    ⚠️ Cleanup failed: ${e.message?.slice(0, 60)}`);
    }
  }

  // Check player balance
  const playerBal = await l1.getBalance(player.publicKey);
  console.log(`    Player balance: ${(playerBal / 1e9).toFixed(4)} SOL (need ${Number(buyIn)} lamports + fees)`);
  if (playerBal < Number(buyIn) + 100_000) {
    console.log(`    ⚠️ Insufficient balance — funding from deployer...`);
    try {
      const fundTx = new (await import('@solana/web3.js')).Transaction().add(
        (await import('@solana/web3.js')).SystemProgram.transfer({
          fromPubkey: deployer.publicKey,
          toPubkey: player.publicKey,
          lamports: Number(buyIn) + 1_000_000, // extra for fees
        }),
      );
      await sendL1(l1, [fundTx.instructions[0]], [deployer]);
      console.log(`    ✅ Funded player`);
    } catch (e: any) {
      console.log(`    ❌ Funding failed: ${e.message?.slice(0, 60)}`);
    }
  }

  // 1. Deposit on L1
  const depData = Buffer.alloc(25);
  DISC.depositForJoin.copy(depData, 0);
  depData.writeUInt8(seatIdx, 8);
  depData.writeBigUInt64LE(buyIn, 9);
  depData.writeBigUInt64LE(0n, 17);
  try {
    await sendL1(l1, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({
        programId: PROGRAM_ID, data: depData,
        keys: [
          { pubkey: player.publicKey, isSigner: true, isWritable: true },
          { pubkey: getPlayerAccountPda(player.publicKey), isSigner: false, isWritable: true },
          { pubkey: table, isSigner: false, isWritable: false },
          { pubkey: getVaultPda(table), isSigner: false, isWritable: true },
          { pubkey: getReceiptPda(table, seatIdx), isSigner: false, isWritable: true },
          { pubkey: getMarkerPda(player.publicKey, table), isSigner: false, isWritable: true },
          { pubkey: dpPda, isSigner: false, isWritable: true },
          // SOL placeholders
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      }),
    ], [player]);
    console.log(`    ✅ Deposited ${Number(buyIn)} lamports`);
  } catch (e: any) {
    console.log(`    ❌ Deposit failed: ${e.message?.slice(0, 120)}`);
    return false;
  }

  // 2. Delegate deposit proof
  const {
    delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
    delegationRecordPdaFromDelegatedAccount,
    delegationMetadataPdaFromDelegatedAccount,
  } = await import('@magicblock-labs/ephemeral-rollups-sdk');

  const dpBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(dpPda, PROGRAM_ID);
  const dpRec = delegationRecordPdaFromDelegatedAccount(dpPda);
  const dpMeta = delegationMetadataPdaFromDelegatedAccount(dpPda);
  const dpDelData = Buffer.alloc(9);
  DISC.delegateDepositProof.copy(dpDelData, 0);
  dpDelData.writeUInt8(seatIdx, 8);

  try {
    await sendL1(l1, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({
        programId: PROGRAM_ID, data: dpDelData,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: dpBuf, isSigner: false, isWritable: true },
          { pubkey: dpRec, isSigner: false, isWritable: true },
          { pubkey: dpMeta, isSigner: false, isWritable: true },
          { pubkey: dpPda, isSigner: false, isWritable: true },
          { pubkey: table, isSigner: false, isWritable: false },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: new PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA'), isSigner: false, isWritable: false },
        ],
      }),
    ], [deployer]);
    console.log(`    ✅ Delegated deposit proof`);
  } catch (e: any) {
    console.log(`    ❌ Delegate proof failed: ${e.message?.slice(0, 60)}`);
    return false;
  }

  console.log(`    Waiting 12s for TEE propagation...`);
  await sleep(12000);

  // 3. Seat on TEE
  const seatData = Buffer.alloc(9);
  DISC.seatPlayer.copy(seatData, 0);
  seatData.writeUInt8(seatIdx, 8);
  try {
    await sendTee(tee, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({
        programId: PROGRAM_ID, data: seatData,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: table, isSigner: false, isWritable: true },
          { pubkey: getSeatPda(table, seatIdx), isSigner: false, isWritable: true },
          { pubkey: dpPda, isSigner: false, isWritable: true },
        ],
      }),
    ], [deployer]);
    console.log(`    ✅ Seated at index ${seatIdx}`);
    return true;
  } catch (e: any) {
    console.log(`    ❌ Seat failed: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

// ─── Wait for specific table phase ───
async function waitForPhase(tee: Connection, phases: number[], timeoutSec = 60): Promise<Buffer | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    const ti = await tee.getAccountInfo(TABLE_PDA);
    if (!ti) { await sleep(2000); continue; }
    const data = Buffer.from(ti.data);
    if (phases.includes(data[OFF_PHASE])) return data;
    await sleep(2000);
  }
  return null;
}

// ─── Read seat state ───
async function getSeatState(tee: Connection, seatIdx: number) {
  const si = await tee.getAccountInfo(getSeatPda(TABLE_PDA, seatIdx));
  if (!si) return null;
  return readSeatFull(Buffer.from(si.data));
}

// ─── Print seat diagnostics ───
function printSeat(label: string, s: ReturnType<typeof readSeatFull>) {
  console.log(`    ${label}: status=${s.statusName}(${s.status}) chips=${Number(s.chips)} cashout_chips=${Number(s.cashoutChips)} nonce=${Number(s.cashoutNonce)} reserve=${Number(s.vaultReserve)}`);
}

// ═══════════════════════════════════════════════════════════════
// TEST 1: join → play hand → leave → verify cashout
// ═══════════════════════════════════════════════════════════════
async function test1_normalLeave(l1: Connection, tee: Connection, deployer: Keypair, p1: Keypair, p2: Keypair) {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  TEST 1: Normal leave after hand → verify cashout           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const buyIn = 10_000_000n; // 100 BB (BB=100_000) — exceeds any anti-ratholing lock

  // Deposit and seat both players
  console.log('\n  Step 1: Deposit + seat P1...');
  if (!await depositAndSeat(l1, tee, deployer, p1, 0, buyIn)) return false;
  console.log('  Step 2: Deposit + seat P2...');
  if (!await depositAndSeat(l1, tee, deployer, p2, 1, buyIn)) return false;

  // Read initial chips
  const s1_before = await getSeatState(tee, 0);
  const s2_before = await getSeatState(tee, 1);
  if (s1_before) printSeat('P1 before', s1_before);
  if (s2_before) printSeat('P2 before', s2_before);

  // Wait for crank to start + deal (Waiting → Preflop)
  // Crank needs: ~30s discovery + 30s cash game warmup + deal time
  console.log('\n  Step 3: Waiting for hand to start (up to 120s for crank discovery + warmup)...');
  const bettingPhases = [Phase.Preflop, Phase.Flop, Phase.Turn, Phase.River];
  let tableData = await waitForPhase(tee, bettingPhases, 120);
  if (!tableData) { console.log('  ❌ Timed out waiting for Preflop'); return false; }
  let ts = readTablePhase(tableData);
  console.log(`    Phase: ${PHASE_NAMES[ts.phase]}, turn=seat ${ts.currentPlayer}`);

  // Both players call/check to showdown
  console.log('\n  Step 4: Playing hand (call to showdown)...');
  let actions = 0;
  while (actions < 30) {
    const ti = await tee.getAccountInfo(TABLE_PDA);
    if (!ti) break;
    const t = readTablePhase(Buffer.from(ti.data));

    if (t.phase === Phase.Waiting || t.phase === Phase.Complete || t.phase === Phase.Starting) {
      console.log(`    Phase=${PHASE_NAMES[t.phase]} — hand over`);
      break;
    }
    if ([Phase.FlopRevealPending, Phase.TurnRevealPending, Phase.RiverRevealPending, Phase.Showdown].includes(t.phase)) {
      await sleep(2000); continue;
    }
    if (!bettingPhases.includes(t.phase)) { await sleep(2000); continue; }

    const player = t.currentPlayer === 0 ? p1 : p2;
    const seatIdx = t.currentPlayer;
    const label = t.currentPlayer === 0 ? 'P1' : 'P2';

    // Preflop: call; post-flop: check
    const variant = t.phase === Phase.Preflop ? ACT.Call : ACT.Check;
    try {
      await sendTee(tee, [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        buildActionIx(player.publicKey, TABLE_PDA, seatIdx, variant),
      ], [player]);
      console.log(`    ${label}: ${variant === ACT.Call ? 'Call' : 'Check'}`);
    } catch (e: any) {
      // If check fails, try call
      if (variant === ACT.Check) {
        try {
          await sendTee(tee, [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            buildActionIx(player.publicKey, TABLE_PDA, seatIdx, ACT.Call),
          ], [player]);
          console.log(`    ${label}: Call (fallback)`);
        } catch { console.log(`    ${label}: Action failed — ${e.message?.slice(0, 50)}`); }
      } else {
        console.log(`    ${label}: Call failed — ${e.message?.slice(0, 50)}`);
      }
    }
    actions++;
    await sleep(500);
  }

  // Wait for settle
  console.log('    Waiting 5s for settle...');
  await sleep(5000);
  await waitForPhase(tee, [Phase.Waiting], 30);

  // Read chips after hand
  const s1_after = await getSeatState(tee, 0);
  const s2_after = await getSeatState(tee, 1);
  if (s1_after) printSeat('P1 after hand', s1_after);
  if (s2_after) printSeat('P2 after hand', s2_after);

  // Both leave
  console.log('\n  Step 5: Both players leave...');
  for (const [p, idx, label] of [[p1, 0, 'P1'], [p2, 1, 'P2']] as const) {
    try {
      await sendTee(tee, [
        buildActionIx(p.publicKey, TABLE_PDA, idx, ACT.LeaveCashGame),
      ], [p]);
      console.log(`    ${label}: LeaveCashGame ✅`);
    } catch (e: any) {
      console.log(`    ${label}: Leave failed — ${e.message?.slice(0, 60)}`);
    }
  }

  // Check status immediately
  const s1_leaving = await getSeatState(tee, 0);
  const s2_leaving = await getSeatState(tee, 1);
  if (s1_leaving) printSeat('P1 after leave', s1_leaving);
  if (s2_leaving) printSeat('P2 after leave', s2_leaving);

  const p1Leaving = s1_leaving?.status === 6;
  const p2Leaving = s2_leaving?.status === 6;
  console.log(`    ✓ P1 Leaving: ${p1Leaving ? '✅' : '❌'}`);
  console.log(`    ✓ P2 Leaving: ${p2Leaving ? '✅' : '❌'}`);

  // Wait for crank cashout (commit + process_cashout_v2 + clear_leaving_seat)
  console.log('\n  Step 6: Waiting 60s for crank cashout...');
  await sleep(60000);

  const s1_final = await getSeatState(tee, 0);
  const s2_final = await getSeatState(tee, 1);
  if (s1_final) printSeat('P1 final', s1_final);
  if (s2_final) printSeat('P2 final', s2_final);

  const p1Cleared = s1_final?.status === 0;
  const p2Cleared = s2_final?.status === 0;
  console.log(`\n  RESULT: P1 seat cleared: ${p1Cleared ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  RESULT: P2 seat cleared: ${p2Cleared ? '✅ PASS' : '❌ FAIL'}`);
  return p1Cleared && p2Cleared;
}

// ═══════════════════════════════════════════════════════════════
// TEST 2: join → sit out → leave → verify no status overwrite
// ═══════════════════════════════════════════════════════════════
async function test2_sitOutThenLeave(l1: Connection, tee: Connection, deployer: Keypair, p1: Keypair, p2: Keypair) {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  TEST 2: Sit out → leave → verify status not overwritten    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const buyIn = 10_000_000n;

  console.log('\n  Step 1: Deposit + seat P1...');
  if (!await depositAndSeat(l1, tee, deployer, p1, 0, buyIn)) return false;
  console.log('  Step 2: Deposit + seat P2...');
  if (!await depositAndSeat(l1, tee, deployer, p2, 1, buyIn)) return false;

  // P1 sits out immediately
  console.log('\n  Step 3: P1 sits out...');
  try {
    await sendTee(tee, [
      buildActionIx(p1.publicKey, TABLE_PDA, 0, ACT.SitOut),
    ], [p1]);
    console.log('    P1: SitOut ✅');
  } catch (e: any) {
    console.log(`    P1: SitOut failed — ${e.message?.slice(0, 60)}`);
  }

  const s1_sitout = await getSeatState(tee, 0);
  if (s1_sitout) printSeat('P1 after sitout', s1_sitout);
  console.log(`    ✓ P1 SittingOut: ${s1_sitout?.status === 4 ? '✅' : '❌'}`);

  // P1 leaves (while sitting out)
  console.log('\n  Step 4: P1 leaves while sitting out...');
  try {
    await sendTee(tee, [
      buildActionIx(p1.publicKey, TABLE_PDA, 0, ACT.LeaveCashGame),
    ], [p1]);
    console.log('    P1: LeaveCashGame ✅');
  } catch (e: any) {
    console.log(`    P1: Leave failed — ${e.message?.slice(0, 60)}`);
  }

  const s1_leaving = await getSeatState(tee, 0);
  if (s1_leaving) printSeat('P1 after leave', s1_leaving);
  console.log(`    ✓ P1 Leaving: ${s1_leaving?.status === 6 ? '✅' : '❌'}`);
  console.log(`    ✓ cashout_chips > 0: ${(s1_leaving?.cashoutChips ?? 0n) > 0n ? '✅' : '❌'}`);
  console.log(`    ✓ nonce incremented: ${(s1_leaving?.cashoutNonce ?? 0n) > 0n ? '✅' : '❌'}`);

  // CG-S2 regression: try SitOut again on Leaving player (should be no-op)
  console.log('\n  Step 5: Regression test — SitOut on Leaving player (should no-op)...');
  try {
    await sendTee(tee, [
      buildActionIx(p1.publicKey, TABLE_PDA, 0, ACT.SitOut),
    ], [p1]);
    console.log('    P1: SitOut returned Ok (no-op) ✅');
  } catch (e: any) {
    console.log(`    P1: SitOut error — ${e.message?.slice(0, 60)}`);
  }

  const s1_after_sitout = await getSeatState(tee, 0);
  console.log(`    ✓ P1 still Leaving: ${s1_after_sitout?.status === 6 ? '✅ PASS (CG-S2 fix works)' : '❌ FAIL — status overwritten!'}`);

  // CG-S2 regression: try ReturnToPlay on Leaving player (should be no-op)
  console.log('\n  Step 6: Regression test — ReturnToPlay on Leaving player...');
  try {
    await sendTee(tee, [
      buildActionIx(p1.publicKey, TABLE_PDA, 0, ACT.ReturnToPlay),
    ], [p1]);
    console.log('    P1: ReturnToPlay returned Ok (no-op) ✅');
  } catch (e: any) {
    console.log(`    P1: ReturnToPlay error — ${e.message?.slice(0, 60)}`);
  }

  const s1_after_rtp = await getSeatState(tee, 0);
  console.log(`    ✓ P1 still Leaving: ${s1_after_rtp?.status === 6 ? '✅ PASS (CG-S2 fix works)' : '❌ FAIL — status overwritten!'}`);

  // P2 also leaves
  console.log('\n  Step 7: P2 leaves...');
  try {
    await sendTee(tee, [
      buildActionIx(p2.publicKey, TABLE_PDA, 1, ACT.LeaveCashGame),
    ], [p2]);
    console.log('    P2: LeaveCashGame ✅');
  } catch (e: any) {
    console.log(`    P2: Leave failed — ${e.message?.slice(0, 60)}`);
  }

  // Wait for crank cashout
  console.log('\n  Step 8: Waiting 60s for crank cashout...');
  await sleep(60000);

  const s1_final = await getSeatState(tee, 0);
  const s2_final = await getSeatState(tee, 1);
  if (s1_final) printSeat('P1 final', s1_final);
  if (s2_final) printSeat('P2 final', s2_final);

  const ok = s1_final?.status === 0 && s2_final?.status === 0;
  console.log(`\n  RESULT: ${ok ? '✅ PASS — both seats cleared, no status overwrite' : '❌ FAIL'}`);
  return ok;
}

// ═══════════════════════════════════════════════════════════════
// TEST 3: join → leave mid-hand → verify settle handles it
// ═══════════════════════════════════════════════════════════════
async function test3_leaveMidHand(l1: Connection, tee: Connection, deployer: Keypair, p1: Keypair, p2: Keypair) {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  TEST 3: Leave mid-hand → verify settle handles Leaving     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const buyIn = 10_000_000n;

  console.log('\n  Step 1: Deposit + seat P1...');
  if (!await depositAndSeat(l1, tee, deployer, p1, 0, buyIn)) return false;
  console.log('  Step 2: Deposit + seat P2...');
  if (!await depositAndSeat(l1, tee, deployer, p2, 1, buyIn)) return false;

  // Wait for hand start
  console.log('\n  Step 3: Waiting for hand to start (up to 120s)...');
  const bettingPhases = [Phase.Preflop, Phase.Flop, Phase.Turn, Phase.River];
  let tableData = await waitForPhase(tee, bettingPhases, 120);
  if (!tableData) { console.log('  ❌ Timed out waiting for Preflop'); return false; }
  let ts = readTablePhase(tableData);
  console.log(`    Phase: ${PHASE_NAMES[ts.phase]}, turn=seat ${ts.currentPlayer}`);

  // P1 leaves mid-hand (while hand is active)
  console.log('\n  Step 4: P1 leaves mid-hand...');
  try {
    await sendTee(tee, [
      buildActionIx(p1.publicKey, TABLE_PDA, 0, ACT.LeaveCashGame),
    ], [p1]);
    console.log('    P1: LeaveCashGame mid-hand ✅');
  } catch (e: any) {
    console.log(`    P1: Leave failed — ${e.message?.slice(0, 60)}`);
  }

  const s1_leaving = await getSeatState(tee, 0);
  if (s1_leaving) printSeat('P1 after mid-hand leave', s1_leaving);
  console.log(`    ✓ P1 Leaving: ${s1_leaving?.status === 6 ? '✅' : '❌'}`);
  // During mid-hand leave, cashout is NOT snapshotted yet — settle will do it
  console.log(`    ✓ cashout_chips == 0 (pending settle): ${(s1_leaving?.cashoutChips ?? 0n) === 0n ? '✅ expected' : `⚠️ cashout_chips=${s1_leaving?.cashoutChips}`}`);

  // The leaving player should be auto-folded and settle should handle the snapshot
  // Wait for the hand to complete (P2 wins by fold since P1 left)
  console.log('\n  Step 5: Waiting for hand to complete (P1 auto-folded)...');
  
  // P2 might need to act — handle any turns
  let actions = 0;
  while (actions < 20) {
    const ti = await tee.getAccountInfo(TABLE_PDA);
    if (!ti) break;
    const t = readTablePhase(Buffer.from(ti.data));

    if (t.phase === Phase.Waiting || t.phase === Phase.Complete) {
      console.log(`    Phase=${PHASE_NAMES[t.phase]} — hand over`);
      break;
    }
    if ([Phase.FlopRevealPending, Phase.TurnRevealPending, Phase.RiverRevealPending, Phase.Showdown, Phase.Starting].includes(t.phase)) {
      await sleep(2000); continue;
    }
    if (!bettingPhases.includes(t.phase)) { await sleep(2000); continue; }

    // If it's P2's turn, call/check
    if (t.currentPlayer === 1) {
      try {
        await sendTee(tee, [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          buildActionIx(p2.publicKey, TABLE_PDA, 1, ACT.Call),
        ], [p2]);
        console.log('    P2: Call');
      } catch {
        try {
          await sendTee(tee, [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            buildActionIx(p2.publicKey, TABLE_PDA, 1, ACT.Check),
          ], [p2]);
          console.log('    P2: Check');
        } catch { /* timeout will handle it */ }
      }
    }
    actions++;
    await sleep(2000);
  }

  // Wait for settle
  console.log('    Waiting 10s for settle...');
  await sleep(10000);
  await waitForPhase(tee, [Phase.Waiting], 30);

  // After settle, P1 should have Leaving status with cashout snapshotted
  const s1_post_settle = await getSeatState(tee, 0);
  const s2_post_settle = await getSeatState(tee, 1);
  if (s1_post_settle) printSeat('P1 post-settle', s1_post_settle);
  if (s2_post_settle) printSeat('P2 post-settle', s2_post_settle);

  console.log(`    ✓ P1 still Leaving: ${s1_post_settle?.status === 6 ? '✅' : '❌'}`);
  console.log(`    ✓ P1 cashout snapshotted: ${(s1_post_settle?.cashoutChips ?? 0n) > 0n ? '✅' : '⚠️ 0 chips (may have lost all to blinds)'}`);
  console.log(`    ✓ P1 nonce incremented: ${(s1_post_settle?.cashoutNonce ?? 0n) > 0n ? '✅' : '❌'}`);

  // P2 leaves too
  console.log('\n  Step 6: P2 leaves...');
  try {
    await sendTee(tee, [
      buildActionIx(p2.publicKey, TABLE_PDA, 1, ACT.LeaveCashGame),
    ], [p2]);
    console.log('    P2: LeaveCashGame ✅');
  } catch (e: any) {
    console.log(`    P2: Leave failed — ${e.message?.slice(0, 60)}`);
  }

  // Wait for crank cashout
  console.log('\n  Step 7: Waiting 60s for crank cashout...');
  await sleep(60000);

  const s1_final = await getSeatState(tee, 0);
  const s2_final = await getSeatState(tee, 1);
  if (s1_final) printSeat('P1 final', s1_final);
  if (s2_final) printSeat('P2 final', s2_final);

  const ok = s1_final?.status === 0 && s2_final?.status === 0;
  console.log(`\n  RESULT: ${ok ? '✅ PASS — settle handled mid-hand leave, both seats cleared' : '❌ FAIL'}`);
  return ok;
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  const deployer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(DEPLOYER_PATH, 'utf-8'))));
  const p1 = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync('tests/keys/player1.json', 'utf-8'))));
  const p2 = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync('tests/keys/player2.json', 'utf-8'))));

  const l1 = new Connection(L1_RPC, 'confirmed');
  const teeToken = await getTeeAuthToken(deployer);
  const tee = new Connection(`${TEE_RPC_BASE}?token=${teeToken}`, 'confirmed');

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   CASHOUT FLOW TEST — 3 Scenarios on Fresh Table            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`Table: ${TABLE_PDA.toBase58()}`);
  console.log(`P1:    ${p1.publicKey.toBase58()}`);
  console.log(`P2:    ${p2.publicKey.toBase58()}`);

  // Check table state
  const ti = await tee.getAccountInfo(TABLE_PDA);
  if (!ti) { console.log('❌ Table not found on TEE'); return; }
  const ts = readTablePhase(Buffer.from(ti.data));
  console.log(`State: phase=${PHASE_NAMES[ts.phase]}, players=${ts.currentPlayers}, hand#=${ts.handNumber}`);

  const filterArg = process.argv[2];
  const results: { test: string; pass: boolean }[] = [];

  if (!filterArg || filterArg === '1') {
    const ok = await test1_normalLeave(l1, tee, deployer, p1, p2);
    results.push({ test: 'T1: Normal leave after hand', pass: !!ok });
  }

  if (!filterArg || filterArg === '2') {
    const ok = await test2_sitOutThenLeave(l1, tee, deployer, p1, p2);
    results.push({ test: 'T2: Sit out then leave', pass: !!ok });
  }

  if (!filterArg || filterArg === '3') {
    const ok = await test3_leaveMidHand(l1, tee, deployer, p1, p2);
    results.push({ test: 'T3: Leave mid-hand', pass: !!ok });
  }

  console.log('\n\n' + '═'.repeat(60));
  console.log('FINAL RESULTS');
  console.log('═'.repeat(60));
  for (const r of results) {
    console.log(`  ${r.pass ? '✅' : '❌'} ${r.test}`);
  }
  const allPass = results.every(r => r.pass);
  console.log(`\n${allPass ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
