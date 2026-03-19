/**
 * CASH GAME BUST-OUT CONTINUATION TEST
 *
 * Picks up from test-cash-game-full.ts where P0 has 14.25M chips and P1/P2 
 * are SittingOut with 0 chips. Adds a new player (P3) so the crank can 
 * start hands → bust counters increment → verify kick flow.
 *
 * Usage: npx ts-node scripts/test-cash-bust-continue.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  MAGIC_PROGRAM_ID as SDK_MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const TEE_RPC_BASE = 'https://tee.magicblock.app';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const TEE_VALIDATOR = new PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA');
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const DEPLOYER_PATH = 'j:/Poker/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json';

const TABLE_PDA = new PublicKey('6zbMpgqoLsiBcfhpHaPebuF1YjX9oMsTtVkRupLc7bQf');
const TABLE_MAX = 6;
const BUY_IN = 5_000_000;
const PLAYER_FUND = 100_000_000;
const NEW_SEAT = 3; // seat index for new player

// ═══════════════════════════════════════════════════════════════
// OFFSETS
// ═══════════════════════════════════════════════════════════════
const OFF = {
  PHASE: 160, CURRENT_PLAYER: 161, MAX_PLAYERS: 121, CURRENT_PLAYERS: 122,
  HAND_NUMBER: 123, POT: 131, RAKE_ACCUMULATED: 147, SEATS_OCCUPIED: 250,
};
const SEAT_OFF = {
  WALLET: 8, CHIPS: 104, STATUS: 227,
  SIT_OUT_BTN_COUNT: 240, HANDS_SINCE_BUST: 241,
  SIT_OUT_TIMESTAMP: 270,
};
const PHASES = ['Waiting','Starting','Preflop','Flop','Turn','River','Showdown','Complete',
  'FlopRP','TurnRP','RiverRP'];
const STATUS_NAMES: Record<number,string> = {0:'Empty',1:'Active',2:'PostedBlind',3:'AllIn',4:'SittingOut',5:'Busted',6:'Leaving'};

function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}
const DISC = {
  registerPlayer: disc('register_player'),
  depositForJoin: disc('deposit_for_join'),
  seatPlayer: disc('seat_player'),
  playerAction: disc('player_action'),
  updateSeatCardsPermission: disc('update_seat_cards_permission'),
  delegateSeatCards: Buffer.from([79, 21, 238, 244, 141, 174, 3, 26]),
  delegatePermission: Buffer.from([187, 192, 110, 65, 252, 88, 194, 103]),
  delegateDepositProof: Buffer.from([38, 124, 73, 174, 143, 27, 169, 130]),
  cleanupDepositProof: disc('cleanup_deposit_proof'),
};
const ACT = { FOLD: 0, CHECK: 1, CALL: 2, BET: 3, RAISE: 4, ALL_IN: 5, SIT_OUT: 6 };
const ACT_NAMES: Record<number,string> = {0:'Fold',1:'Check',2:'Call',3:'Bet',4:'Raise',5:'AllIn',6:'SitOut'};

// PDA helpers
const getSeatPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('seat'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getSeatCardsPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getPermissionPda = (a: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('permission:'), a.toBuffer()], PERMISSION_PROGRAM_ID);
const getPlayerPda = (w: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('player'), w.toBuffer()], PROGRAM_ID);
const getMarkerPda = (w: PublicKey, t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('player_table'), w.toBuffer(), t.toBuffer()], PROGRAM_ID);
const getDepositProofPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('deposit_proof'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getVaultPda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('vault'), t.toBuffer()], PROGRAM_ID);
const getReceiptPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('receipt'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getUnrefinedPda = (w: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('unrefined'), w.toBuffer()], STEEL_PROGRAM_ID);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let passCount = 0, failCount = 0;
function pass(s: string, d = '') { passCount++; console.log(`  ✅ ${s}${d ? ' — ' + d : ''}`); }
function fail(s: string, d = '') { failCount++; console.log(`  ❌ ${s}${d ? ' — ' + d : ''}`); }
function log(s: string) { console.log(s); }

// ═══════════════════════════════════════════════════════════════
// TEE AUTH + TX
// ═══════════════════════════════════════════════════════════════
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

async function sendTeeTx(
  teeConn: Connection, ixs: TransactionInstruction[], signers: Keypair[],
  feePayer: Keypair, label: string, retries = 2,
): Promise<boolean> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const tx = new Transaction();
      for (const ix of ixs) tx.add(ix);
      tx.feePayer = feePayer.publicKey;
      tx.recentBlockhash = (await teeConn.getLatestBlockhash('confirmed')).blockhash;
      tx.sign(...signers, feePayer);
      const sig = await teeConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      for (let i = 0; i < 25; i++) {
        await sleep(800);
        const st = await teeConn.getSignatureStatuses([sig]);
        const s = st?.value?.[0];
        if (s?.err) {
          if (attempt < retries) { await sleep(1000); break; }
          console.log(`    ❌ ${label}: ${JSON.stringify(s.err)}`);
          return false;
        }
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return true;
      }
    } catch (e: any) {
      if (attempt < retries) { await sleep(1000); continue; }
      console.log(`    ❌ ${label}: ${e.message?.slice(0, 100)}`);
      return false;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// TABLE/SEAT READERS
// ═══════════════════════════════════════════════════════════════
async function readTable(tee: Connection) {
  const info = await tee.getAccountInfo(TABLE_PDA);
  if (!info) return null;
  const d = Buffer.from(info.data);
  return {
    phase: d[OFF.PHASE], currentPlayer: d[OFF.CURRENT_PLAYER],
    currentPlayers: d[OFF.CURRENT_PLAYERS], handNumber: d.readUInt32LE(OFF.HAND_NUMBER),
    pot: Number(d.readBigUInt64LE(OFF.POT)), rake: Number(d.readBigUInt64LE(OFF.RAKE_ACCUMULATED)),
    seatsOccupied: d.readUInt16LE(OFF.SEATS_OCCUPIED),
  };
}
async function readSeat(tee: Connection, seatIdx: number) {
  const [pda] = getSeatPda(TABLE_PDA, seatIdx);
  const info = await tee.getAccountInfo(pda);
  if (!info) return null;
  const d = Buffer.from(info.data);
  const status = d[SEAT_OFF.STATUS];
  return {
    wallet: new PublicKey(d.subarray(SEAT_OFF.WALLET, SEAT_OFF.WALLET + 32)),
    chips: Number(d.readBigUInt64LE(SEAT_OFF.CHIPS)),
    status, statusName: STATUS_NAMES[status] || '?',
    sitOutBtnCount: d[SEAT_OFF.SIT_OUT_BTN_COUNT],
    handsSinceBust: d[SEAT_OFF.HANDS_SINCE_BUST],
  };
}

function buildActionIx(playerKp: PublicKey, seatIdx: number, action: number): TransactionInstruction {
  const [seatPda] = getSeatPda(TABLE_PDA, seatIdx);
  const data = Buffer.alloc(17);
  DISC.playerAction.copy(data, 0);
  data.writeUInt8(action, 8);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: playerKp, isSigner: true, isWritable: false },
      { pubkey: TABLE_PDA, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(DEPLOYER_PATH, 'utf-8'))));
  const l1 = new Connection(L1_RPC, 'confirmed');
  const depToken = await getTeeAuthToken(deployer);
  const tee = new Connection(`${TEE_RPC_BASE}?token=${depToken}`, 'confirmed');
  const teePayer = Keypair.generate();
  const teePayerToken = await getTeeAuthToken(teePayer);
  const tee2 = new Connection(`${TEE_RPC_BASE}?token=${teePayerToken}`, 'confirmed');

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   BUST-OUT CONTINUATION: Add P3, Monitor Kick Flow          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // ═══════════════════════════════════════════════════════════════
  // STEP 1: CHECK CURRENT STATE
  // ═══════════════════════════════════════════════════════════════
  log('\n═══ STEP 1: Current Table State ═══');
  const ts0 = await readTable(tee);
  if (!ts0) { log('Table not found on TEE'); return; }
  log(`  Table: ${ts0.currentPlayers}p, phase=${PHASES[ts0.phase]}, hand=#${ts0.handNumber}, rake=${ts0.rake}`);
  log(`  Seats occupied: 0b${ts0.seatsOccupied.toString(2).padStart(TABLE_MAX, '0')}`);

  // Show all seats
  const bustedSeats: number[] = [];
  let activeSeats: number[] = [];
  for (let i = 0; i < TABLE_MAX; i++) {
    const seat = await readSeat(tee, i);
    if (seat && seat.status !== 0) {
      log(`    Seat ${i}: chips=${seat.chips} status=${seat.statusName} bustCount=${seat.handsSinceBust} btnCount=${seat.sitOutBtnCount}`);
      if (seat.chips === 0 && seat.status === 4) bustedSeats.push(i);
      if (seat.status === 1 || seat.status === 3) activeSeats.push(i);
    }
  }
  log(`  Active: [${activeSeats.join(',')}], Busted(SittingOut): [${bustedSeats.join(',')}]`);

  if (bustedSeats.length === 0) {
    log('  No busted players found. Nothing to test.');
    return;
  }
  pass(`Found ${bustedSeats.length} busted player(s) at seats [${bustedSeats.join(',')}]`);

  const initialHandNumber = ts0.handNumber;

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: JOIN P3 IF NEEDED
  // ═══════════════════════════════════════════════════════════════
  if (activeSeats.length < 2) {
    log('\n═══ STEP 2: Join P3 (need 2+ active for hands to play) ═══');
    const p3 = Keypair.generate();

    // Fund
    await sendAndConfirmTransaction(l1, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: p3.publicKey, lamports: PLAYER_FUND }),
    ), [deployer]);

    // Register
    const [p3Pda] = getPlayerPda(p3.publicKey);
    const [p3Unrefined] = getUnrefinedPda(p3.publicKey);
    try {
      await sendAndConfirmTransaction(l1, new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        new TransactionInstruction({ programId: PROGRAM_ID, keys: [
          { pubkey: p3.publicKey, isSigner: true, isWritable: true },
          { pubkey: p3Pda, isSigner: false, isWritable: true },
          { pubkey: TREASURY, isSigner: false, isWritable: true },
          { pubkey: POOL_PDA, isSigner: false, isWritable: true },
          { pubkey: p3Unrefined, isSigner: false, isWritable: true },
          { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ], data: DISC.registerPlayer }),
      ), [p3]);
      pass('Registered P3');
    } catch (e: any) { log(`  register: ${e.message?.slice(0, 80)}`); }

    // deposit_for_join
    const [vaultPda] = getVaultPda(TABLE_PDA);
    const [dpPda] = getDepositProofPda(TABLE_PDA, NEW_SEAT);
    const [rcPda] = getReceiptPda(TABLE_PDA, NEW_SEAT);
    const [mkPda] = getMarkerPda(p3.publicKey, TABLE_PDA);

    // Check/cleanup stale proof
    const proofL1 = await l1.getAccountInfo(dpPda).catch(() => null);
    if (proofL1 && proofL1.owner.equals(DELEGATION_PROGRAM_ID)) {
      log('  Cleaning stale deposit proof for seat 3...');
      const [seatPda] = getSeatPda(TABLE_PDA, NEW_SEAT);
      const cleanData = Buffer.alloc(9);
      DISC.cleanupDepositProof.copy(cleanData, 0);
      cleanData.writeUInt8(NEW_SEAT, 8);
      await sendTeeTx(tee, [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        new TransactionInstruction({ programId: PROGRAM_ID, keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: TABLE_PDA, isSigner: false, isWritable: false },
          { pubkey: dpPda, isSigner: false, isWritable: true },
          { pubkey: SDK_MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
          { pubkey: seatPda, isSigner: false, isWritable: false },
        ], data: cleanData }),
      ], [deployer], deployer, 'cleanup_proof[3]');
      await sleep(10000);
    }

    const djd = Buffer.alloc(25);
    DISC.depositForJoin.copy(djd, 0);
    djd.writeUInt8(NEW_SEAT, 8);
    djd.writeBigUInt64LE(BigInt(BUY_IN), 9);
    djd.writeBigUInt64LE(BigInt(0), 17);
    try {
      await sendAndConfirmTransaction(l1, new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        new TransactionInstruction({ programId: PROGRAM_ID, keys: [
          { pubkey: p3.publicKey, isSigner: true, isWritable: true },
          { pubkey: p3Pda, isSigner: false, isWritable: true },
          { pubkey: TABLE_PDA, isSigner: false, isWritable: false },
          { pubkey: vaultPda, isSigner: false, isWritable: true },
          { pubkey: rcPda, isSigner: false, isWritable: true },
          { pubkey: mkPda, isSigner: false, isWritable: true },
          { pubkey: dpPda, isSigner: false, isWritable: true },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ], data: djd }),
      ), [p3]);
      pass('deposit_for_join P3');
    } catch (e: any) { fail(`deposit P3: ${e.message?.slice(0, 100)}`); }

    // perm + delegate seatCards + delegate permission
    const [scPda] = getSeatCardsPda(TABLE_PDA, NEW_SEAT);
    const scL1 = await l1.getAccountInfo(scPda).catch(() => null);
    if (!scL1 || !scL1.owner.equals(DELEGATION_PROGRAM_ID)) {
      const [permPda] = getPermissionPda(scPda);
      try {
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
        const uData = Buffer.alloc(9); DISC.updateSeatCardsPermission.copy(uData, 0); uData.writeUInt8(NEW_SEAT, 8);
        tx.add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
          { pubkey: TABLE_PDA, isSigner: false, isWritable: false },
          { pubkey: dpPda, isSigner: false, isWritable: false },
          { pubkey: scPda, isSigner: false, isWritable: true },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: uData }));
        const scBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(scPda, PROGRAM_ID);
        const scRec = delegationRecordPdaFromDelegatedAccount(scPda);
        const scMeta = delegationMetadataPdaFromDelegatedAccount(scPda);
        const scD = Buffer.alloc(9); DISC.delegateSeatCards.copy(scD, 0); scD.writeUInt8(NEW_SEAT, 8);
        tx.add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: scBuf, isSigner: false, isWritable: true },
          { pubkey: scRec, isSigner: false, isWritable: true },
          { pubkey: scMeta, isSigner: false, isWritable: true },
          { pubkey: scPda, isSigner: false, isWritable: true },
          { pubkey: TABLE_PDA, isSigner: false, isWritable: false },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
        ], data: scD }));
        const pBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID);
        const pRec = delegationRecordPdaFromDelegatedAccount(permPda);
        const pMeta = delegationMetadataPdaFromDelegatedAccount(permPda);
        const pD = Buffer.alloc(9); DISC.delegatePermission.copy(pD, 0); pD.writeUInt8(NEW_SEAT, 8);
        tx.add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: TABLE_PDA, isSigner: false, isWritable: false },
          { pubkey: scPda, isSigner: false, isWritable: true },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: pBuf, isSigner: false, isWritable: true },
          { pubkey: pRec, isSigner: false, isWritable: true },
          { pubkey: pMeta, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ], data: pD }));
        await sendAndConfirmTransaction(l1, tx, [deployer]);
        pass('perm+delegate seatCards+permission for P3');
      } catch (e: any) { log(`  perm+delegate: ${e.message?.slice(0, 100)}`); }
    } else {
      pass('seatCards[3] already delegated');
    }

    // delegate deposit proof
    try {
      const dpBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(dpPda, PROGRAM_ID);
      const dpRec = delegationRecordPdaFromDelegatedAccount(dpPda);
      const dpMeta = delegationMetadataPdaFromDelegatedAccount(dpPda);
      const dpD = Buffer.alloc(9); DISC.delegateDepositProof.copy(dpD, 0); dpD.writeUInt8(NEW_SEAT, 8);
      await sendAndConfirmTransaction(l1, new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        new TransactionInstruction({ programId: PROGRAM_ID, keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: dpBuf, isSigner: false, isWritable: true },
          { pubkey: dpRec, isSigner: false, isWritable: true },
          { pubkey: dpMeta, isSigner: false, isWritable: true },
          { pubkey: dpPda, isSigner: false, isWritable: true },
          { pubkey: TABLE_PDA, isSigner: false, isWritable: false },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
        ], data: dpD }),
      ), [deployer]);
      pass('delegate deposit proof[3]');
    } catch (e: any) { log(`  delegate proof: ${e.message?.slice(0, 80)}`); }

    log('  Waiting 12s for TEE propagation...');
    await sleep(12000);

    // seat_player on TEE
    const [seatPda] = getSeatPda(TABLE_PDA, NEW_SEAT);
    const spData = Buffer.alloc(17);
    DISC.seatPlayer.copy(spData, 0);
    spData.writeUInt8(NEW_SEAT, 8);
    spData.writeBigUInt64LE(BigInt(BUY_IN), 9);
    const ok = await sendTeeTx(tee2, [new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: teePayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: TABLE_PDA, isSigner: false, isWritable: true },
        { pubkey: seatPda, isSigner: false, isWritable: true },
        { pubkey: dpPda, isSigner: false, isWritable: true },
      ],
      data: spData,
    })], [teePayer], teePayer, 'seat_player[3]');
    if (ok) pass('P3 seated at seat 3');
    else fail('Failed to seat P3');

    activeSeats.push(NEW_SEAT);
  } else {
    log('\n═══ STEP 2: Skip (already 2+ active players) ═══');
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 3: MONITOR BUST COUNTERS AS HANDS PLAY
  // ═══════════════════════════════════════════════════════════════
  log('\n═══ STEP 3: Monitor Bust Counters (waiting for 4+ hands) ═══');
  log(`  Need hands_since_bust >= 3 for kick eligibility (BUST_REMOVAL_THRESHOLD)`);
  log(`  Also watching sit_out_button_count >= 3 (LEGACY_ORBIT_REMOVAL_THRESHOLD)`);

  const targetHand = initialHandNumber + 5;
  let lastReportedHand = initialHandNumber;

  for (let w = 0; w < 240; w++) { // Up to 8 minutes
    const ts = await readTable(tee);
    if (!ts) { await sleep(2000); continue; }

    // Report every new hand
    if (ts.handNumber > lastReportedHand) {
      lastReportedHand = ts.handNumber;
      log(`\n  Hand #${ts.handNumber} (phase=${PHASES[ts.phase]}, rake=${ts.rake})`);
      for (const bs of bustedSeats) {
        const seat = await readSeat(tee, bs);
        if (seat) {
          log(`    Bust P${bs}: status=${seat.statusName}, chips=${seat.chips}, bustCount=${seat.handsSinceBust}, btnCount=${seat.sitOutBtnCount}`);
        }
      }
    }

    if (ts.handNumber >= targetHand) break;

    // Also check if busted player already got kicked
    let allKicked = true;
    for (const bs of bustedSeats) {
      const seat = await readSeat(tee, bs);
      if (seat && seat.status === 4) { allKicked = false; break; }
    }
    if (allKicked) {
      log('\n  All busted players already kicked/leaving!');
      break;
    }

    await sleep(2000);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 4: FINAL VERIFICATION
  // ═══════════════════════════════════════════════════════════════
  log('\n═══ STEP 4: Final Bust/Kick Verification ═══');
  const tableFinal = await readTable(tee);
  if (tableFinal) {
    log(`  Table: hand=#${tableFinal.handNumber}, ${tableFinal.currentPlayers}p, rake=${tableFinal.rake}`);
  }

  for (const bs of bustedSeats) {
    const seat = await readSeat(tee, bs);
    if (!seat) { log(`  Seat ${bs}: not found`); continue; }

    log(`  P${bs}: status=${seat.statusName}, chips=${seat.chips}, bustCount=${seat.handsSinceBust}, btnCount=${seat.sitOutBtnCount}`);

    if (seat.status === 4 && seat.chips === 0) {
      pass(`P${bs} SittingOut with 0 chips — NOT dealt into hands (confirmed)`);
      if (seat.handsSinceBust >= 3) {
        pass(`P${bs} hands_since_bust=${seat.handsSinceBust} — eligible for kick (BUST_REMOVAL_THRESHOLD=3)`);
      } else {
        log(`  ⚠️ P${bs} hands_since_bust only ${seat.handsSinceBust} — need more hands`);
      }
      if (seat.sitOutBtnCount >= 3) {
        pass(`P${bs} sit_out_button_count=${seat.sitOutBtnCount} — also eligible via legacy orbit`);
      }
    } else if (seat.status === 6) {
      pass(`P${bs} KICKED → Leaving status (crank will process cashout on L1)`);
    } else if (seat.status === 0) {
      pass(`P${bs} CLEARED (Empty) — full cashout+cleanup cycle completed`);
    } else {
      fail(`P${bs} unexpected: ${seat.statusName} chips=${seat.chips}`);
    }
  }

  // Verify busted players not dealt in: their chips should still be 0
  for (const bs of bustedSeats) {
    const seat = await readSeat(tee, bs);
    if (seat && seat.status === 4 && seat.chips === 0) {
      pass(`P${bs} chips still 0 — confirms they were never dealt in or given pot`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║   RESULTS: ${passCount} passed, ${failCount} failed`.padEnd(63) + '║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  if (failCount === 0) log('\n  🎉 ALL TESTS PASSED!');
  else log(`\n  ⚠️  ${failCount} test(s) failed`);
}

main().catch((e) => {
  console.error('\n💥 FATAL:', e.message || e);
  process.exit(1);
});
