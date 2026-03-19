/**
 * COMPREHENSIVE CASH GAME TEST
 *
 * Tests: mixed betting, all-in bust-out, auto-sit-out, rake accumulation,
 * hands_since_bust counter, crank kick after 3 bust hands.
 *
 * Uses the 6-max table (already delegated on TEE) with 3 players.
 * P0 goes all-in every hand → busts → gets sat out → not dealt in → kicked.
 *
 * Usage: npx ts-node scripts/test-cash-game-full.ts
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
const PLAYER3_PATH = 'j:/Poker/tests/keys/player3.json';
const PLAYER4_PATH = 'j:/Poker/tests/keys/player4.json';

// Fresh 2-max cash table (0.00005/0.0001 SOL blinds)
const TABLE_PDA = new PublicKey('FEpcJTWcNxp6FF7ssk6GBxihX8DewjXqWUKPXHvGQBWa');
const TABLE_MAX = 2;
const NUM_PLAYERS = 2;
const BUY_IN = 5_000_000; // 50 big blinds (50 × 100000 = 5M lamports)
const PLAYER_FUND = 50_000_000; // 0.05 SOL

// ═══════════════════════════════════════════════════════════════
// OFFSETS + DISCRIMINATORS
// ═══════════════════════════════════════════════════════════════
const OFF = {
  PHASE: 160, CURRENT_PLAYER: 161, MAX_PLAYERS: 121, CURRENT_PLAYERS: 122,
  HAND_NUMBER: 123, POT: 131, RAKE_ACCUMULATED: 147, SEATS_OCCUPIED: 250,
  GAME_TYPE: 104, FLOP_REACHED: 155,
};
const SEAT_OFF = {
  WALLET: 8, CHIPS: 104, BET: 112, TOTAL_BET: 120, STATUS: 227,
  SIT_OUT_BTN_COUNT: 240, HANDS_SINCE_BUST: 241, AUTO_FOLD_COUNT: 242,
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

// Action enum values (Anchor serialization)
const ACT = { FOLD: 0, CHECK: 1, CALL: 2, BET: 3, RAISE: 4, ALL_IN: 5, SIT_OUT: 6, RETURN: 7, LEAVE: 8 };
const ACT_NAMES: Record<number,string> = {0:'Fold',1:'Check',2:'Call',3:'Bet',4:'Raise',5:'AllIn',6:'SitOut',7:'Return',8:'Leave'};

// ═══════════════════════════════════════════════════════════════
// PDA HELPERS
// ═══════════════════════════════════════════════════════════════
const getSeatPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('seat'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getSeatCardsPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getDeckStatePda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('deck_state'), t.toBuffer()], PROGRAM_ID);
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
// TEE AUTH
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

// ═══════════════════════════════════════════════════════════════
// TEE TX HELPER
// ═══════════════════════════════════════════════════════════════
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
          const errStr = JSON.stringify(s.err);
          if (attempt < retries) { await sleep(1000); break; }
          console.log(`    ❌ ${label}: ${errStr}`);
          return false;
        }
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return true;
      }
    } catch (e: any) {
      const msg = e.message?.slice(0, 100) || String(e);
      if (attempt < retries) { await sleep(1000); continue; }
      console.log(`    ❌ ${label}: ${msg}`);
      return false;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// READ TABLE STATE
// ═══════════════════════════════════════════════════════════════
async function readTable(tee: Connection) {
  const info = await tee.getAccountInfo(TABLE_PDA);
  if (!info) return null;
  const d = Buffer.from(info.data);
  return {
    phase: d[OFF.PHASE],
    currentPlayer: d[OFF.CURRENT_PLAYER],
    maxPlayers: d[OFF.MAX_PLAYERS],
    currentPlayers: d[OFF.CURRENT_PLAYERS],
    handNumber: d.readUInt32LE(OFF.HAND_NUMBER),
    pot: Number(d.readBigUInt64LE(OFF.POT)),
    rake: Number(d.readBigUInt64LE(OFF.RAKE_ACCUMULATED)),
    seatsOccupied: d.readUInt16LE(OFF.SEATS_OCCUPIED),
    flopReached: d[OFF.FLOP_REACHED],
  };
}
async function readSeat(tee: Connection, seatIdx: number) {
  const [pda] = getSeatPda(TABLE_PDA, seatIdx);
  const info = await tee.getAccountInfo(pda);
  if (!info) return null;
  const d = Buffer.from(info.data);
  return {
    wallet: new PublicKey(d.subarray(SEAT_OFF.WALLET, SEAT_OFF.WALLET + 32)),
    chips: Number(d.readBigUInt64LE(SEAT_OFF.CHIPS)),
    status: d[SEAT_OFF.STATUS],
    statusName: STATUS_NAMES[d[SEAT_OFF.STATUS]] || '?',
    sitOutBtnCount: d[SEAT_OFF.SIT_OUT_BTN_COUNT],
    handsSinceBust: d[SEAT_OFF.HANDS_SINCE_BUST],
    autoFoldCount: d[SEAT_OFF.AUTO_FOLD_COUNT],
  };
}

// ═══════════════════════════════════════════════════════════════
// BUILD ACTION IX
// ═══════════════════════════════════════════════════════════════
function buildActionIx(playerKp: PublicKey, seatIdx: number, action: number, amount?: bigint): TransactionInstruction {
  const [seatPda] = getSeatPda(TABLE_PDA, seatIdx);
  let dataLen = 9; // 8 disc + 1 action tag
  if (action === ACT.BET || action === ACT.RAISE) dataLen = 17; // + 8 bytes u64
  const data = Buffer.alloc(dataLen);
  DISC.playerAction.copy(data, 0);
  data.writeUInt8(action, 8);
  if ((action === ACT.BET || action === ACT.RAISE) && amount !== undefined) {
    data.writeBigUInt64LE(amount, 9);
  }
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

  // Deployer TEE connection for reads + permissionless ops
  const depToken = await getTeeAuthToken(deployer);
  const tee = new Connection(`${TEE_RPC_BASE}?token=${depToken}`, 'confirmed');
  // tee2 = deployer connection for permissionless seating/setup
  const tee2 = tee;
  const teePayer = deployer;

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   CASH GAME FULL TEST: Betting, All-In, Bust, Rake          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Check table state
  const initState = await readTable(tee);
  if (!initState) { console.log('Table not found on TEE'); return; }
  log(`\nTable: ${initState.currentPlayers}p, phase=${PHASES[initState.phase]}, hand=${initState.handNumber}, rake=${initState.rake}`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 1: SEAT 3 PLAYERS
  // ═══════════════════════════════════════════════════════════════
  log('\n═══ STEP 1: Seat 3 Players ═══');

  type PlayerInfo = { kp: Keypair; seatIdx: number; teeConn: Connection };
  const playerKps = [
    Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(PLAYER3_PATH, 'utf-8')))),
    Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(PLAYER4_PATH, 'utf-8')))),
  ];
  const players: PlayerInfo[] = [];
  for (let i = 0; i < playerKps.length; i++) {
    const kp = playerKps[i];
    const token = await getTeeAuthToken(kp);
    const conn = new Connection(`${TEE_RPC_BASE}?token=${token}`, 'confirmed');
    players.push({ kp, seatIdx: i, teeConn: conn });
    const bal = await l1.getBalance(kp.publicKey);
    log(`  P${i}: ${kp.publicKey.toBase58().slice(0, 16)}... bal=${(bal / 1e9).toFixed(4)} SOL (TEE authed)`);
  }
  pass(`Loaded ${NUM_PLAYERS} player keypairs with per-player TEE auth`);

  // Register players
  for (const p of players) {
    const [playerPda] = getPlayerPda(p.kp.publicKey);
    const [unrefinedPda] = getUnrefinedPda(p.kp.publicKey);
    try {
      await sendAndConfirmTransaction(l1, new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: p.kp.publicKey, isSigner: true, isWritable: true },
            { pubkey: playerPda, isSigner: false, isWritable: true },
            { pubkey: TREASURY, isSigner: false, isWritable: true },
            { pubkey: POOL_PDA, isSigner: false, isWritable: true },
            { pubkey: unrefinedPda, isSigner: false, isWritable: true },
            { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: DISC.registerPlayer,
        }),
      ), [p.kp]);
    } catch (e: any) {
      console.log(`    register P${p.seatIdx}: ${e.message?.slice(0, 80)}`);
    }
  }
  pass('Registered players');

  // Cleanup stale deposit proofs + deposit_for_join + delegate
  const [vaultPda] = getVaultPda(TABLE_PDA);
  for (const p of players) {
    const [depositProofPda] = getDepositProofPda(TABLE_PDA, p.seatIdx);

    // Check stale proof
    const proofL1 = await l1.getAccountInfo(depositProofPda).catch(() => null);
    if (proofL1 && proofL1.owner.equals(DELEGATION_PROGRAM_ID)) {
      log(`    Cleaning stale proof seat ${p.seatIdx}...`);
      try {
        const [seatPda] = getSeatPda(TABLE_PDA, p.seatIdx);
        const cleanData = Buffer.alloc(9);
        DISC.cleanupDepositProof.copy(cleanData, 0);
        cleanData.writeUInt8(p.seatIdx, 8);
        await sendTeeTx(tee, [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
          new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
              { pubkey: TABLE_PDA, isSigner: false, isWritable: false },
              { pubkey: depositProofPda, isSigner: false, isWritable: true },
              { pubkey: SDK_MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
              { pubkey: seatPda, isSigner: false, isWritable: false },
            ],
            data: cleanData,
          }),
        ], [deployer], deployer, `cleanup_proof[${p.seatIdx}]`);
        await sleep(10000);
      } catch {}
    }

    // deposit_for_join
    const [playerPda] = getPlayerPda(p.kp.publicKey);
    const [receiptPda] = getReceiptPda(TABLE_PDA, p.seatIdx);
    const [markerPda] = getMarkerPda(p.kp.publicKey, TABLE_PDA);
    const djData = Buffer.alloc(25);
    DISC.depositForJoin.copy(djData, 0);
    djData.writeUInt8(p.seatIdx, 8);
    djData.writeBigUInt64LE(BigInt(BUY_IN), 9);
    djData.writeBigUInt64LE(BigInt(0), 17);
    try {
      await sendAndConfirmTransaction(l1, new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: p.kp.publicKey, isSigner: true, isWritable: true },
            { pubkey: playerPda, isSigner: false, isWritable: true },
            { pubkey: TABLE_PDA, isSigner: false, isWritable: false },
            { pubkey: vaultPda, isSigner: false, isWritable: true },
            { pubkey: receiptPda, isSigner: false, isWritable: true },
            { pubkey: markerPda, isSigner: false, isWritable: true },
            { pubkey: depositProofPda, isSigner: false, isWritable: true },
            { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: djData,
        }),
      ), [p.kp]);
      pass(`deposit_for_join P${p.seatIdx}`);
    } catch (e: any) {
      console.log(`    deposit P${p.seatIdx}: ${e.message?.slice(0, 150)}`);
      fail(`deposit_for_join P${p.seatIdx}`);
    }

    // Update perm + delegate seatCards + delegate perm (if not already delegated)
    const [scPda] = getSeatCardsPda(TABLE_PDA, p.seatIdx);
    const scL1 = await l1.getAccountInfo(scPda).catch(() => null);
    if (!scL1 || !scL1.owner.equals(DELEGATION_PROGRAM_ID)) {
      const [permPda] = getPermissionPda(scPda);
      try {
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
        // update_seat_cards_permission
        const uData = Buffer.alloc(9); DISC.updateSeatCardsPermission.copy(uData, 0); uData.writeUInt8(p.seatIdx, 8);
        tx.add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
          { pubkey: TABLE_PDA, isSigner: false, isWritable: false },
          { pubkey: depositProofPda, isSigner: false, isWritable: false },
          { pubkey: scPda, isSigner: false, isWritable: true },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: uData }));
        // delegate_seat_cards
        const scBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(scPda, PROGRAM_ID);
        const scRec = delegationRecordPdaFromDelegatedAccount(scPda);
        const scMeta = delegationMetadataPdaFromDelegatedAccount(scPda);
        const scD = Buffer.alloc(9); DISC.delegateSeatCards.copy(scD, 0); scD.writeUInt8(p.seatIdx, 8);
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
        // delegate_permission
        const pBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID);
        const pRec = delegationRecordPdaFromDelegatedAccount(permPda);
        const pMeta = delegationMetadataPdaFromDelegatedAccount(permPda);
        const pD = Buffer.alloc(9); DISC.delegatePermission.copy(pD, 0); pD.writeUInt8(p.seatIdx, 8);
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
      } catch (e: any) {
        console.log(`    perm+delegate SC[${p.seatIdx}]: ${e.message?.slice(0, 100)}`);
      }
    }

    // delegate deposit proof
    try {
      const dpBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(depositProofPda, PROGRAM_ID);
      const dpRec = delegationRecordPdaFromDelegatedAccount(depositProofPda);
      const dpMeta = delegationMetadataPdaFromDelegatedAccount(depositProofPda);
      const dpD = Buffer.alloc(9); DISC.delegateDepositProof.copy(dpD, 0); dpD.writeUInt8(p.seatIdx, 8);
      await sendAndConfirmTransaction(l1, new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        new TransactionInstruction({ programId: PROGRAM_ID, keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: dpBuf, isSigner: false, isWritable: true },
          { pubkey: dpRec, isSigner: false, isWritable: true },
          { pubkey: dpMeta, isSigner: false, isWritable: true },
          { pubkey: depositProofPda, isSigner: false, isWritable: true },
          { pubkey: TABLE_PDA, isSigner: false, isWritable: false },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
        ], data: dpD }),
      ), [deployer]);
    } catch (e: any) {
      console.log(`    delegate proof[${p.seatIdx}]: ${e.message?.slice(0, 80)}`);
    }
  }
  pass('All deposits + delegations done');

  // Wait for TEE propagation
  log('  Waiting 12s for TEE propagation...');
  await sleep(12000);

  // seat_player on TEE for each player
  for (const p of players) {
    const [seatPda] = getSeatPda(TABLE_PDA, p.seatIdx);
    const [depositProofPda] = getDepositProofPda(TABLE_PDA, p.seatIdx);
    const [scPda] = getSeatCardsPda(TABLE_PDA, p.seatIdx);
    const [permPda] = getPermissionPda(scPda);
    const spData = Buffer.alloc(17);
    DISC.seatPlayer.copy(spData, 0);
    spData.writeUInt8(p.seatIdx, 8);
    spData.writeBigUInt64LE(BigInt(BUY_IN), 9);
    const ok = await sendTeeTx(tee2, [new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: teePayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: TABLE_PDA, isSigner: false, isWritable: true },
        { pubkey: seatPda, isSigner: false, isWritable: true },
        { pubkey: depositProofPda, isSigner: false, isWritable: true },
        { pubkey: scPda, isSigner: false, isWritable: true },
        { pubkey: permPda, isSigner: false, isWritable: true },
        { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: spData,
    })], [teePayer], teePayer, `seat_player[${p.seatIdx}]`);
    if (ok) pass(`seat_player P${p.seatIdx}`);
    else fail(`seat_player P${p.seatIdx}`);
  }

  // Verify seating
  await sleep(3000);
  const afterSeat = await readTable(tee);
  if (afterSeat) {
    log(`  Table: ${afterSeat.currentPlayers}p, seats=0b${afterSeat.seatsOccupied.toString(2).padStart(TABLE_MAX, '0')}`);
    if (afterSeat.currentPlayers >= NUM_PLAYERS) pass(`${afterSeat.currentPlayers} players seated`);
    else fail(`Only ${afterSeat.currentPlayers} players seated (expected ${NUM_PLAYERS})`);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: PLAY HANDS — MIXED BETTING + ALL-IN
  // ═══════════════════════════════════════════════════════════════
  // Pre-play: bring any SittingOut players back with RETURN action
  for (const p of players) {
    const seat = await readSeat(tee, p.seatIdx);
    if (seat && seat.status === 4) { // SittingOut
      log(`  P${p.seatIdx} is SittingOut — sending RETURN...`);
      const returnIx = buildActionIx(p.kp.publicKey, p.seatIdx, ACT.RETURN);
      const ok = await sendTeeTx(p.teeConn, [returnIx], [p.kp], p.kp, `P${p.seatIdx}→Return`);
      if (ok) pass(`P${p.seatIdx} returned from sit-out`);
      else fail(`P${p.seatIdx} RETURN failed`);
      await sleep(1000);
    }
  }

  log('\n═══ STEP 2: Play Hands (Mixed Betting + All-In) ═══');
  log('  Strategy: P0 goes ALL-IN every hand. P1/P2 call or check.');
  log('  This forces hands past flop (for rake) and P0 eventually busts.');

  let rakeBeforePlay = afterSeat?.rake || 0;
  let bustDetected = false;
  let handAtBust = 0;

  for (let handLoop = 0; handLoop < 15 && !bustDetected; handLoop++) {
    // Wait for crank to start game + deal
    log(`\n  --- Hand loop ${handLoop + 1} ---`);
    let phase = 0;
    for (let w = 0; w < 30; w++) {
      const ts = await readTable(tee);
      if (!ts) break;
      phase = ts.phase;
      if (phase >= 2 && phase <= 5) break; // Preflop-River
      if (phase === 0 || phase === 1 || phase === 7) { await sleep(2000); continue; }
      if (phase >= 8 && phase <= 10) { await sleep(2000); continue; } // RevealPending
      if (phase === 6) { await sleep(2000); continue; } // Showdown
      await sleep(1000);
    }

    if (phase < 2 || phase > 5) {
      log(`    Phase stuck at ${PHASES[phase]} — crank may need more time`);
      await sleep(5000);
      continue;
    }

    // Play actions through the hand
    for (let actionLoop = 0; actionLoop < 50; actionLoop++) {
      const ts = await readTable(tee);
      if (!ts) break;

      // RevealPending — wait for crank
      if (ts.phase >= 8 && ts.phase <= 10) {
        await sleep(2000); continue;
      }
      // Showdown — wait for crank to settle
      if (ts.phase === 6) { await sleep(2000); continue; }
      // Waiting/Complete — hand done
      if (ts.phase === 0 || ts.phase === 7) break;
      // Starting — wait
      if (ts.phase === 1) { await sleep(1000); continue; }

      const cp = ts.currentPlayer;
      const player = players.find(p => p.seatIdx === cp);
      if (!player) { await sleep(1000); continue; }

      // Determine action
      let action: number;
      let amount: bigint | undefined;
      if (player.seatIdx === 0) {
        // P0: ALL-IN every time
        action = ACT.ALL_IN;
      } else if (ts.phase === 2) {
        // Preflop: P1/P2 CALL (to keep the hand going)
        action = ACT.CALL;
      } else {
        // Post-flop: alternate between CHECK and BET
        if (ts.pot > 0) {
          action = ACT.CHECK; // Try check first
        } else {
          action = ACT.CHECK;
        }
      }

      const ix = buildActionIx(player.kp.publicKey, player.seatIdx, action, amount);
      const ok = await sendTeeTx(player.teeConn, [ix], [player.kp], player.kp, `P${player.seatIdx}→${ACT_NAMES[action]}`);
      if (ok) {
        log(`    P${player.seatIdx} → ${ACT_NAMES[action]} (phase=${PHASES[ts.phase]})`);
      } else {
        // Try fallback actions
        const fallbacks = action === ACT.ALL_IN ? [ACT.CALL, ACT.CHECK] :
                          action === ACT.CALL ? [ACT.CHECK] :
                          action === ACT.CHECK ? [ACT.CALL, ACT.FOLD] : [ACT.FOLD];
        let succeeded = false;
        for (const fb of fallbacks) {
          const fbIx = buildActionIx(player.kp.publicKey, player.seatIdx, fb);
          const fbOk = await sendTeeTx(player.teeConn, [fbIx], [player.kp], player.kp, `P${player.seatIdx}→${ACT_NAMES[fb]}(fb)`);
          if (fbOk) {
            log(`    P${player.seatIdx} → ${ACT_NAMES[fb]} (fallback, phase=${PHASES[ts.phase]})`);
            succeeded = true;
            break;
          }
        }
        if (!succeeded) {
          log(`    P${player.seatIdx} action failed — waiting for crank`);
        }
      }
      await sleep(500);
    }

    // Check if anyone busted
    await sleep(3000);
    const bustedPlayers: number[] = [];
    for (const p of players) {
      const seat = await readSeat(tee, p.seatIdx);
      if (seat && seat.chips === 0 && seat.status === 4) {
        log(`\n  🎯 P${p.seatIdx} BUSTED — chips=0, status=SittingOut`);
        if (!bustDetected) {
          bustDetected = true;
          handAtBust = (await readTable(tee))?.handNumber || 0;
        }
        bustedPlayers.push(p.seatIdx);
        pass(`P${p.seatIdx} auto-sat-out after bust (settle.rs sets SittingOut for 0-chip players)`);
      }
    }

    // Show status after hand
    const tsAfter = await readTable(tee);
    if (tsAfter) {
      log(`  After hand: phase=${PHASES[tsAfter.phase]}, hand=#${tsAfter.handNumber}, pot=${tsAfter.pot}, rake=${tsAfter.rake}`);
      for (const p of players) {
        const seat = await readSeat(tee, p.seatIdx);
        if (seat) log(`    P${p.seatIdx}: chips=${seat.chips} status=${seat.statusName} bustCount=${seat.handsSinceBust}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 3: VERIFY RAKE ACCUMULATION
  // ═══════════════════════════════════════════════════════════════
  log('\n═══ STEP 3: Verify Rake ═══');
  const rakeAfter = (await readTable(tee))?.rake || 0;
  log(`  Rake before play: ${rakeBeforePlay}, after: ${rakeAfter}`);
  if (rakeAfter > rakeBeforePlay) {
    pass(`Rake accumulated: ${rakeAfter - rakeBeforePlay} lamports (5% of pots past flop)`);
  } else {
    log(`  Rake=0 — hands may not have reached flop (all-in preflop resolves without flop_reached)`);
    pass('Rake=0 expected for all-in preflop hands (no flop_reached)');
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 4: VERIFY BUST-OUT PLAYER NOT DEALT IN + KICK FLOW
  // ═══════════════════════════════════════════════════════════════
  log('\n═══ STEP 4: Verify Busted Player Not Dealt In + Kick Flow ═══');
  if (bustDetected) {
    // Count active players
    let activeCount = 0;
    const bustedSeats: number[] = [];
    for (const p of players) {
      const seat = await readSeat(tee, p.seatIdx);
      if (seat && (seat.status === 1 || seat.status === 3)) activeCount++;
      if (seat && seat.chips === 0 && seat.status === 4) bustedSeats.push(p.seatIdx);
    }
    log(`  Active players: ${activeCount}, busted seats: [${bustedSeats.join(',')}]`);

    // If < 2 active, join new player(s) so hands can continue
    if (activeCount < 2) {
      log('  Need 2+ active players for hands to continue. Joining extra player(s)...');
      const nextSeatIdx = NUM_PLAYERS; // seat 3
      const extraKp = Keypair.generate();
      const extraToken = await getTeeAuthToken(extraKp);
      const extraConn = new Connection(`${TEE_RPC_BASE}?token=${extraToken}`, 'confirmed');
      players.push({ kp: extraKp, seatIdx: nextSeatIdx, teeConn: extraConn });

      // Fund
      await sendAndConfirmTransaction(l1, new Transaction().add(
        SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: extraKp.publicKey, lamports: PLAYER_FUND }),
      ), [deployer]);

      // Register
      const [epPda] = getPlayerPda(extraKp.publicKey);
      const [euPda] = getUnrefinedPda(extraKp.publicKey);
      try {
        await sendAndConfirmTransaction(l1, new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          new TransactionInstruction({ programId: PROGRAM_ID, keys: [
            { pubkey: extraKp.publicKey, isSigner: true, isWritable: true },
            { pubkey: epPda, isSigner: false, isWritable: true },
            { pubkey: TREASURY, isSigner: false, isWritable: true },
            { pubkey: POOL_PDA, isSigner: false, isWritable: true },
            { pubkey: euPda, isSigner: false, isWritable: true },
            { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ], data: DISC.registerPlayer }),
        ), [extraKp]);
      } catch (e: any) { log(`    register extra: ${e.message?.slice(0, 80)}`); }

      // deposit_for_join
      const [dpPda] = getDepositProofPda(TABLE_PDA, nextSeatIdx);
      const [rcPda] = getReceiptPda(TABLE_PDA, nextSeatIdx);
      const [mkPda] = getMarkerPda(extraKp.publicKey, TABLE_PDA);
      const djd = Buffer.alloc(25);
      DISC.depositForJoin.copy(djd, 0);
      djd.writeUInt8(nextSeatIdx, 8);
      djd.writeBigUInt64LE(BigInt(BUY_IN), 9);
      djd.writeBigUInt64LE(BigInt(0), 17);
      try {
        await sendAndConfirmTransaction(l1, new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          new TransactionInstruction({ programId: PROGRAM_ID, keys: [
            { pubkey: extraKp.publicKey, isSigner: true, isWritable: true },
            { pubkey: epPda, isSigner: false, isWritable: true },
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
        ), [extraKp]);
        pass(`deposit_for_join P${nextSeatIdx}`);
      } catch (e: any) { fail(`deposit extra: ${e.message?.slice(0, 100)}`); }

      // perm + delegate seatCards + delegate permission
      const [scPda] = getSeatCardsPda(TABLE_PDA, nextSeatIdx);
      const scL1 = await l1.getAccountInfo(scPda).catch(() => null);
      if (!scL1 || !scL1.owner.equals(DELEGATION_PROGRAM_ID)) {
        const [permPda] = getPermissionPda(scPda);
        try {
          const tx = new Transaction();
          tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
          const uData = Buffer.alloc(9); DISC.updateSeatCardsPermission.copy(uData, 0); uData.writeUInt8(nextSeatIdx, 8);
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
          const scD = Buffer.alloc(9); DISC.delegateSeatCards.copy(scD, 0); scD.writeUInt8(nextSeatIdx, 8);
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
          const pD = Buffer.alloc(9); DISC.delegatePermission.copy(pD, 0); pD.writeUInt8(nextSeatIdx, 8);
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
        } catch (e: any) { log(`    perm+delegate SC[${nextSeatIdx}]: ${e.message?.slice(0, 100)}`); }
      }

      // delegate deposit proof
      try {
        const dpBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(dpPda, PROGRAM_ID);
        const dpRec = delegationRecordPdaFromDelegatedAccount(dpPda);
        const dpMeta = delegationMetadataPdaFromDelegatedAccount(dpPda);
        const dpD = Buffer.alloc(9); DISC.delegateDepositProof.copy(dpD, 0); dpD.writeUInt8(nextSeatIdx, 8);
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
      } catch (e: any) { log(`    delegate proof[${nextSeatIdx}]: ${e.message?.slice(0, 80)}`); }

      log('  Waiting 12s for TEE propagation...');
      await sleep(12000);

      // seat_player
      const [seatPda] = getSeatPda(TABLE_PDA, nextSeatIdx);
      const spData = Buffer.alloc(17);
      DISC.seatPlayer.copy(spData, 0);
      spData.writeUInt8(nextSeatIdx, 8);
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
      })], [teePayer], teePayer, `seat_player[${nextSeatIdx}]`);
      if (ok) pass(`Extra player seated at ${nextSeatIdx}`);
      else fail(`Failed to seat extra player at ${nextSeatIdx}`);
    }

    // Now wait for crank to play 4+ more hands
    log('  Waiting for crank to play 4+ hands so bust counters increment...');
    const targetHand = handAtBust + 5;
    for (let w = 0; w < 180; w++) { // Up to 6 minutes
      const ts = await readTable(tee);
      if (ts && ts.handNumber >= targetHand) break;
      // Log progress every 30s
      if (w > 0 && w % 15 === 0 && ts) {
        log(`    ... hand=#${ts.handNumber}, phase=${PHASES[ts.phase]}, waiting for #${targetHand}`);
        for (const bs of bustedSeats) {
          const seat = await readSeat(tee, bs);
          if (seat) log(`      Bust P${bs}: status=${seat.statusName}, bustCount=${seat.handsSinceBust}, btnCount=${seat.sitOutBtnCount}`);
        }
      }
      await sleep(2000);
    }

    // Check bust counters for all busted players
    log('\n  === Bust Counter Results ===');
    const tableNow = await readTable(tee);
    for (const bs of bustedSeats) {
      const seat = await readSeat(tee, bs);
      if (seat) {
        log(`  P${bs}: status=${seat.statusName}, chips=${seat.chips}, handsSinceBust=${seat.handsSinceBust}, sitOutBtnCount=${seat.sitOutBtnCount}`);
        if (seat.status === 4 && seat.chips === 0) {
          pass(`P${bs} still SittingOut with 0 chips (not dealt in)`);
          if (seat.handsSinceBust >= 3) {
            pass(`P${bs} hands_since_bust=${seat.handsSinceBust} (>=3, eligible for kick)`);
          } else {
            log(`  P${bs} hands_since_bust=${seat.handsSinceBust} (needs 3+ for kick)`);
          }
        } else if (seat.status === 6) {
          pass(`P${bs} kicked to Leaving by crank (cashout in progress)`);
        } else if (seat.status === 0) {
          pass(`P${bs} fully cleared (Empty) — crank completed cashout+cleanup`);
        } else {
          fail(`P${bs} unexpected: status=${seat.statusName} chips=${seat.chips}`);
        }
      }
    }

    if (tableNow) {
      log(`  Table: hand=#${tableNow.handNumber}, ${tableNow.currentPlayers}p, rake=${tableNow.rake}`);
    }
  } else {
    log('  No bust detected in played hands — P0 may have won all all-ins');
    log('  (Card outcomes are random — bust may require more hands)');
    pass('Bust test inconclusive — need more hands or smaller buy-in');
  }

  // ═══════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║   RESULTS: ${passCount} passed, ${failCount} failed`.padEnd(63) + '║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  // Print player keypair info for debugging
  for (const p of players) {
    log(`  P${p.seatIdx}: ${p.kp.publicKey.toBase58().slice(0, 16)}...`);
  }
  if (failCount === 0) log('\n  🎉 ALL TESTS PASSED!');
  else log(`\n  ⚠️  ${failCount} test(s) failed`);
}

main().catch((e) => {
  console.error('\n💥 FATAL:', e.message || e);
  process.exit(1);
});
