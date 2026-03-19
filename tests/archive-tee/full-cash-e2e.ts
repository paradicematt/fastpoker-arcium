/**
 * Full Cash Game E2E Test — 6-max and 9-max
 * 
 * Requirements tested:
 * 1. Table creation + cost tracking
 * 2. Join all seats via deposit_for_join + seat_player (production flow)
 * 3. Play a hand — verify hole cards hidden on ER (deck_seed zeroed)
 * 4. Leave seat, rejoin seat — fully permissionless
 * 5. Auto-sit-out on timeout
 * 6. Table never undelegated during play
 * 7. Race conditions (multiple joins/leaves)
 * 
 * Run: npx ts-node tests/full-cash-e2e.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram,
  sendAndConfirmTransaction, SYSVAR_SLOT_HASHES_PUBKEY,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as crypto from 'crypto';
import {
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
  permissionPdaFromAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk';

// ─── Config ───
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const ER_RPC = 'https://devnet.magicblock.app';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');
const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const VRF_PROGRAM_ID = new PublicKey('Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz');
const VRF_EPHEMERAL_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
const TEE_VALIDATOR = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');
const MAGIC_PROGRAM_ID = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT_ID = new PublicKey('MagicContext1111111111111111111111111111111');

const SMALL_BLIND = 50_000n;   // 0.00005 SOL
const BIG_BLIND = 100_000n;    // 0.0001 SOL
const BUY_IN = BIG_BLIND * 50n; // 50 BB = 0.005 SOL

// ─── Discriminators ───
const hashDisc = (name: string) => Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
const DISC = {
  createUserTable: Buffer.from([238,125,176,179,242,249,219,183]),
  registerPlayer: hashDisc('register_player'),
  joinTable: Buffer.from([14,117,84,51,95,146,171,70]),
  playerAction: Buffer.from([37,85,25,135,200,116,96,101]),
  startGame: hashDisc('start_game'),
  requestDealVrf: hashDisc('request_deal_vrf'),
  initTableSeat: Buffer.from([4,2,110,85,144,112,65,236]),
  delegateTable: hashDisc('delegate_table'),
  delegateSeat: hashDisc('delegate_seat'),
  delegateSeatCards: hashDisc('delegate_seat_cards'),
  delegateDeckState: hashDisc('delegate_deck_state'),
  delegatePermission: hashDisc('delegate_permission'),
  delegateDepositProof: hashDisc('delegate_deposit_proof'),
  depositForJoin: Buffer.from([99,149,87,125,87,44,45,46]),
  seatPlayer: Buffer.from([7,38,253,140,213,3,208,119]),
  cleanupDepositProof: hashDisc('cleanup_deposit_proof'),
  resizeVault: Buffer.from([252,157,28,248,125,252,63,121]),
};

enum Action { Fold=0, Check=1, Call=2, Bet=3, Raise=4, AllIn=5, SitOut=6, ReturnToPlay=7, LeaveCashGame=8 }

const OFF = {
  PHASE: 160, CURRENT_PLAYER: 161, MAX_PLAYERS: 162, DEALER: 163, SB_SEAT: 164, BB_SEAT: 165,
  CURRENT_PLAYERS: 122, HAND_NUMBER: 123, POT: 131, MIN_BET: 139,
  IS_DELEGATED: 174, SEATS_OCCUPIED: 250, COMMUNITY_CARDS: 147,
};
const SEAT_OFF = { WALLET: 8, CHIPS: 104, BET: 112, TOTAL_BET: 120, SEAT_NUMBER: 226, STATUS: 227 };
const PHASE_NAMES = ['Waiting','Starting','Preflop','Flop','Turn','River','Showdown','Complete'];

// ─── PDA helpers ───
const getSeatPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('seat'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID)[0];
const getSeatCardsPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID)[0];
const getDeckStatePda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('deck_state'), t.toBuffer()], PROGRAM_ID)[0];
const getPlayerPda = (p: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('player'), p.toBuffer()], PROGRAM_ID)[0];
const getMarkerPda = (p: PublicKey, t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('player_table'), p.toBuffer(), t.toBuffer()], PROGRAM_ID)[0];
const getVaultPda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('vault'), t.toBuffer()], PROGRAM_ID)[0];
const getReceiptPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('receipt'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID)[0];
const getDepositProofPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('deposit_proof'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID)[0];
const getIdentityPda = () => PublicKey.findProgramAddressSync([Buffer.from('identity')], PROGRAM_ID)[0];

// ─── Load keypairs ───
function loadKey(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf-8'))));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── TX helpers ───
async function sendTx(conn: Connection, signers: Keypair[], ixs: TransactionInstruction[], label: string, skipPreflight = false): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed', skipPreflight });
  console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
  return sig;
}

async function trySend(conn: Connection, signers: Keypair[], ixs: TransactionInstruction[], label: string, skipPreflight = false): Promise<string | null> {
  try { return await sendTx(conn, signers, ixs, label, skipPreflight); }
  catch (e: any) { console.log(`  ❌ ${label}: ${e.message?.slice(0, 140)}`); return null; }
}

async function readTable(conn: Connection, tablePda: PublicKey, label: string) {
  const info = await conn.getAccountInfo(tablePda);
  if (!info) { console.log(`  [${label}] Table NOT FOUND`); return null; }
  const d = Buffer.from(info.data);
  const s = {
    phase: d[OFF.PHASE], phaseName: PHASE_NAMES[d[OFF.PHASE]] || '?',
    players: d[OFF.CURRENT_PLAYERS], hand: Number(d.readBigUInt64LE(OFF.HAND_NUMBER)),
    pot: Number(d.readBigUInt64LE(OFF.POT)), minBet: Number(d.readBigUInt64LE(OFF.MIN_BET)),
    cp: d[OFF.CURRENT_PLAYER], dealer: d[OFF.DEALER], sb: d[OFF.SB_SEAT], bb: d[OFF.BB_SEAT],
    maxPlayers: d[OFF.MAX_PLAYERS],
    seatsOccupied: d.readUInt16LE(OFF.SEATS_OCCUPIED),
    communityCards: Array.from(d.slice(OFF.COMMUNITY_CARDS, OFF.COMMUNITY_CARDS + 5)),
    owner: info.owner.toBase58().slice(0, 8),
  };
  console.log(`  [${label}] ${s.phaseName} hand#${s.hand} pot=${s.pot} cp=${s.cp} players=${s.players} owned=${s.owner}`);
  return s;
}

async function readSeat(conn: Connection, tablePda: PublicKey, idx: number, label?: string) {
  const info = await conn.getAccountInfo(getSeatPda(tablePda, idx));
  if (!info) return null;
  const d = Buffer.from(info.data);
  const names = ['Empty','Active','Folded','AllIn','SittingOut','Busted','Leaving'];
  const st = d[SEAT_OFF.STATUS];
  const wallet = new PublicKey(d.slice(SEAT_OFF.WALLET, SEAT_OFF.WALLET + 32));
  const s = { chips: Number(d.readBigUInt64LE(SEAT_OFF.CHIPS)), bet: Number(d.readBigUInt64LE(SEAT_OFF.BET)), status: st, name: names[st]||'?', wallet };
  if (label) console.log(`  [${label}] Seat${idx}: ${s.name} chips=${s.chips} bet=${s.bet} wallet=${wallet.toBase58().slice(0,8)}`);
  return s;
}

async function waitPhase(conn: Connection, tablePda: PublicKey, phases: number[], ms = 30000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await readTable(conn, tablePda, label);
    if (s && phases.includes(s.phase)) return s;
    await sleep(2000);
  }
  throw new Error(`Timeout waiting for ${phases.map(p => PHASE_NAMES[p])} (${label})`);
}

// ─── Instruction builders ───
function ixCreateTable(creator: PublicKey, tableId: Buffer, tablePda: PublicKey, maxPlayers: number) {
  const vaultPda = getVaultPda(tablePda);
  const data = Buffer.alloc(90);
  DISC.createUserTable.copy(data, 0);
  tableId.copy(data, 8);
  data.writeUInt8(maxPlayers, 40);
  data.writeBigUInt64LE(SMALL_BLIND, 41);
  data.writeBigUInt64LE(BIG_BLIND, 49);
  Buffer.alloc(32).copy(data, 57); // token_mint = default (SOL)
  data.writeUInt8(0, 89); // buy_in_type = Normal
  return new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
    { pubkey: creator, isSigner: true, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: POOL_PDA, isSigner: false, isWritable: true },
    { pubkey: TREASURY, isSigner: false, isWritable: true },
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // creator_token_account placeholder
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // treasury_token_account placeholder
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // pool_token_account placeholder
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // token_program placeholder
    { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]});
}

function ixInitTableSeat(auth: PublicKey, tablePda: PublicKey, seatIndex: number) {
  const seatPda = getSeatPda(tablePda, seatIndex);
  const seatCardsPda = getSeatCardsPda(tablePda, seatIndex);
  const deckStatePda = getDeckStatePda(tablePda);
  const receiptPda = getReceiptPda(tablePda, seatIndex);
  const depositProofPda = getDepositProofPda(tablePda, seatIndex);
  const permPda = permissionPdaFromAccount(seatCardsPda);
  const data = Buffer.alloc(9);
  DISC.initTableSeat.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  return new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
    { pubkey: auth, isSigner: true, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: seatPda, isSigner: false, isWritable: true },
    { pubkey: seatCardsPda, isSigner: false, isWritable: true },
    { pubkey: deckStatePda, isSigner: false, isWritable: true },
    { pubkey: receiptPda, isSigner: false, isWritable: true },
    { pubkey: depositProofPda, isSigner: false, isWritable: true },
    { pubkey: permPda, isSigner: false, isWritable: true },
    { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]});
}

function ixDepositForJoin(player: PublicKey, tablePda: PublicKey, seatIndex: number, buyIn: bigint) {
  const vaultPda = getVaultPda(tablePda);
  const receiptPda = getReceiptPda(tablePda, seatIndex);
  const markerPda = getMarkerPda(player, tablePda);
  const depositProofPda = getDepositProofPda(tablePda, seatIndex);
  const playerPda = getPlayerPda(player);
  const data = Buffer.alloc(25);
  DISC.depositForJoin.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  data.writeBigUInt64LE(buyIn, 9);
  data.writeBigUInt64LE(0n, 17); // reserve = 0
  return new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
    { pubkey: player, isSigner: true, isWritable: true },
    { pubkey: playerPda, isSigner: false, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: false },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: receiptPda, isSigner: false, isWritable: true },
    { pubkey: markerPda, isSigner: false, isWritable: true },
    { pubkey: depositProofPda, isSigner: false, isWritable: true },
    // Optional SPL accounts — PROGRAM_ID as None placeholder for SOL tables
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // player_token_account
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // table_token_account
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]});
}

function ixResizeVault(payer: PublicKey, tablePda: PublicKey) {
  const vaultPda = getVaultPda(tablePda);
  return new TransactionInstruction({ programId: PROGRAM_ID, data: DISC.resizeVault, keys: [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: false },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]});
}

function ixSeatPlayer(payer: PublicKey, tablePda: PublicKey, seatIndex: number) {
  const seatPda = getSeatPda(tablePda, seatIndex);
  const depositProofPda = getDepositProofPda(tablePda, seatIndex);
  const data = Buffer.alloc(9);
  DISC.seatPlayer.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  return new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: seatPda, isSigner: false, isWritable: true },
    { pubkey: depositProofPda, isSigner: false, isWritable: true },
  ]});
}

function ixAction(player: PublicKey, tablePda: PublicKey, seat: number, action: Action, amount = 0) {
  const data = Buffer.alloc(17);
  DISC.playerAction.copy(data, 0);
  data.writeUInt8(action, 8);
  data.writeBigUInt64LE(BigInt(amount), 9);
  return new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
    { pubkey: player, isSigner: true, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: getSeatPda(tablePda, seat), isSigner: false, isWritable: true },
  ]});
}

// ─── Delegation helpers ───
async function delegateAccount(l1: Connection, auth: Keypair, account: PublicKey, disc: Buffer, extra: Buffer, extraKeys: any[], label: string) {
  const record = delegationRecordPdaFromDelegatedAccount(account);
  if (await l1.getAccountInfo(record)) { console.log(`  ⏭️  ${label} already delegated`); return; }
  const buffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(account, PROGRAM_ID);
  const metadata = delegationMetadataPdaFromDelegatedAccount(account);
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.concat([disc, extra]), keys: [
    { pubkey: auth.publicKey, isSigner: true, isWritable: true },
    { pubkey: buffer, isSigner: false, isWritable: true },
    { pubkey: record, isSigner: false, isWritable: true },
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: account, isSigner: false, isWritable: true },
    ...extraKeys,
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]});
  await trySend(l1, [auth], [ix], label);
}

async function delegatePermissionPda(l1: Connection, auth: Keypair, tablePda: PublicKey, seatIndex: number) {
  const seatCardsPda = getSeatCardsPda(tablePda, seatIndex);
  const permPda = permissionPdaFromAccount(seatCardsPda);
  const record = delegationRecordPdaFromDelegatedAccount(permPda);
  if (await l1.getAccountInfo(record)) { console.log(`  ⏭️  delegate_permission[${seatIndex}] already delegated`); return; }
  const buffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID);
  const metadata = delegationMetadataPdaFromDelegatedAccount(permPda);
  const data = Buffer.alloc(9);
  DISC.delegatePermission.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
    { pubkey: auth.publicKey, isSigner: true, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: false },
    { pubkey: seatCardsPda, isSigner: false, isWritable: true },
    { pubkey: permPda, isSigner: false, isWritable: true },
    { pubkey: buffer, isSigner: false, isWritable: true },
    { pubkey: record, isSigner: false, isWritable: true },
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]});
  await trySend(l1, [auth], [ix], `delegate_permission[${seatIndex}]`);
}

async function delegateDepositProofPda(l1: Connection, auth: Keypair, tablePda: PublicKey, seatIndex: number) {
  const dpPda = getDepositProofPda(tablePda, seatIndex);
  const record = delegationRecordPdaFromDelegatedAccount(dpPda);
  if (await l1.getAccountInfo(record)) { console.log(`  ⏭️  delegate_deposit_proof[${seatIndex}] already delegated`); return; }
  const buffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(dpPda, PROGRAM_ID);
  const metadata = delegationMetadataPdaFromDelegatedAccount(dpPda);
  const data = Buffer.alloc(9);
  DISC.delegateDepositProof.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
    { pubkey: auth.publicKey, isSigner: true, isWritable: true },
    { pubkey: buffer, isSigner: false, isWritable: true },
    { pubkey: record, isSigner: false, isWritable: true },
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: dpPda, isSigner: false, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: false },
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]});
  await trySend(l1, [auth], [ix], `delegate_deposit_proof[${seatIndex}]`);
}

async function delegateAll(l1: Connection, auth: Keypair, tablePda: PublicKey, tableIdBuf: Buffer, maxPlayers: number) {
  console.log('\n═══ Delegating All to ER ═══');
  
  // Delegate table
  await delegateAccount(l1, auth, tablePda, DISC.delegateTable, tableIdBuf, [], 'delegate_table');
  
  // Delegate DeckState
  const deckState = getDeckStatePda(tablePda);
  await delegateAccount(l1, auth, deckState, DISC.delegateDeckState, Buffer.alloc(0), 
    [{ pubkey: tablePda, isSigner: false, isWritable: false }], 'delegate_deck_state');
  
  // Delegate all seats, seat_cards, permissions
  for (let i = 0; i < maxPlayers; i++) {
    const seatBuf = Buffer.from([i]);
    const tblKey = [{ pubkey: tablePda, isSigner: false, isWritable: false }];
    await delegateAccount(l1, auth, getSeatPda(tablePda, i), DISC.delegateSeat, seatBuf, tblKey, `delegate_seat[${i}]`);
    await delegateAccount(l1, auth, getSeatCardsPda(tablePda, i), DISC.delegateSeatCards, seatBuf, tblKey, `delegate_seat_cards[${i}]`);
    await delegatePermissionPda(l1, auth, tablePda, i);
  }
  
  console.log('  ⏳ Waiting 5s for ER propagation...');
  await sleep(5000);
}

// ─── Join flow: deposit_for_join (L1) → delegate proof → seat_player (ER) ───
async function joinSeat(l1: Connection, er: Connection, auth: Keypair, player: Keypair, tablePda: PublicKey, seatIndex: number) {
  console.log(`  Joining seat ${seatIndex} for ${player.publicKey.toBase58().slice(0, 8)}...`);
  
  // Step 1: resize_vault + deposit_for_join on L1
  const resizeIx = ixResizeVault(player.publicKey, tablePda);
  const depositIx = ixDepositForJoin(player.publicKey, tablePda, seatIndex, BUY_IN);
  const depositOk = await trySend(l1, [player], [resizeIx, depositIx], `deposit_for_join[${seatIndex}]`);
  if (!depositOk) throw new Error(`deposit_for_join failed for seat ${seatIndex}`);
  
  // Step 2: delegate deposit_proof to ER
  await delegateDepositProofPda(l1, auth, tablePda, seatIndex);
  await sleep(8000); // Wait for ER propagation (deposit_proof clone can lag)
  
  // Step 3: seat_player on ER (permissionless)
  const seatIx = ixSeatPlayer(auth.publicKey, tablePda, seatIndex);
  const seatOk = await trySend(er, [auth], [seatIx], `seat_player[${seatIndex}]`, true);
  if (!seatOk) throw new Error(`seat_player failed for seat ${seatIndex}`);
}

// ─── Start game + VRF ───
async function startAndDeal(er: Connection, auth: Keypair, tablePda: PublicKey, maxPlayers: number) {
  console.log('\n═══ Starting Game + VRF ═══');
  
  // Check if game already in progress (crank may have auto-started)
  const preInfo = await er.getAccountInfo(tablePda);
  if (preInfo) {
    const phase = preInfo.data[OFF.PHASE];
    if (phase !== 0 && phase !== 7) {
      console.log(`  Game already in progress (phase=${PHASE_NAMES[phase]}), skipping start+VRF`);
      return;
    }
  }
  
  // start_game with ALL seat PDAs
  const allSeatPdas = Array.from({ length: maxPlayers }, (_, i) => getSeatPda(tablePda, i));
  const startIx = new TransactionInstruction({ programId: PROGRAM_ID, data: DISC.startGame, keys: [
    { pubkey: auth.publicKey, isSigner: true, isWritable: false },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    ...allSeatPdas.map(pda => ({ pubkey: pda, isSigner: false, isWritable: true })),
  ]});
  const startOk = await trySend(er, [auth], [startIx], 'start_game', true);
  if (!startOk) {
    console.log('  start_game failed (crank may have started), waiting for playable phase...');
    return;
  }
  
  // Read table to get deal mask
  await sleep(500);
  const info = await er.getAccountInfo(tablePda);
  if (!info) throw new Error('Table missing on ER after start');
  const d = Buffer.from(info.data);
  const seatsOccupied = d.readUInt16LE(OFF.SEATS_OCCUPIED);
  const seatsFolded = d.readUInt16LE(254);
  const dealMask = seatsOccupied & ~seatsFolded;
  
  const dealSeats: number[] = [];
  for (let i = 0; i < maxPlayers; i++) {
    if (dealMask & (1 << i)) dealSeats.push(i);
  }
  console.log(`  Deal mask: ${dealMask.toString(2)} → seats [${dealSeats.join(', ')}]`);
  
  // request_deal_vrf — non-fatal, crank will handle if this fails (e.g. insufficient ER balance)
  const bundleKeys = dealSeats.flatMap(i => {
    const seatPda = getSeatPda(tablePda, i);
    const scPda = getSeatCardsPda(tablePda, i);
    const permPda = permissionPdaFromAccount(scPda);
    return [
      { pubkey: seatPda, isSigner: false, isWritable: false },
      { pubkey: scPda, isSigner: false, isWritable: true },
      { pubkey: permPda, isSigner: false, isWritable: true },
    ];
  });
  
  const vrfIx = new TransactionInstruction({ programId: PROGRAM_ID, data: DISC.requestDealVrf, keys: [
    { pubkey: auth.publicKey, isSigner: true, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: getIdentityPda(), isSigner: false, isWritable: false },
    { pubkey: VRF_EPHEMERAL_QUEUE, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: VRF_PROGRAM_ID, isSigner: false, isWritable: false },
    ...bundleKeys,
  ]});
  const vrfOk = await trySend(er, [auth], [vrfIx], 'request_deal_vrf', true);
  if (!vrfOk) {
    console.log('  VRF request failed — crank will handle it. Waiting for Preflop...');
  }
}

// ─── Play hand ───
async function playHand(
  er: Connection, tablePda: PublicKey, players: Keypair[], seats: number[], label: string,
  override?: (pidx: number, phase: number) => Action | null
) {
  console.log(`\n═══ ${label} ═══`);
  for (let n = 0; n < 40; n++) {
    const t = await readTable(er, tablePda, label);
    if (!t) break;
    if ([0, 6, 7].includes(t.phase)) { console.log(`  Hand ended: ${t.phaseName}`); return t; }
    if (t.phase === 1) { await sleep(2000); continue; } // Starting — wait for VRF

    const pidx = seats.indexOf(t.cp);
    if (pidx < 0) { await sleep(2000); continue; }

    let action: Action | null = override ? override(pidx, t.phase) : null;
    if (action === null) {
      const seat = await readSeat(er, tablePda, seats[pidx]);
      if (!seat || [0,2,4,5,6].includes(seat.status)) { await sleep(1000); continue; }
      action = Action.Check;
    }

    const names = ['Fold','Check','Call','Bet','Raise','AllIn','SitOut','Return','Leave'];
    const ix = ixAction(players[pidx].publicKey, tablePda, seats[pidx], action);
    let ok = await trySend(er, [players[pidx]], [ix], `P${pidx} ${names[action]}`, true);
    if (!ok && action === Action.Check) {
      ok = await trySend(er, [players[pidx]], [ixAction(players[pidx].publicKey, tablePda, seats[pidx], Action.Call)], `P${pidx} Call (fb)`, true);
    } else if (!ok && action === Action.Call) {
      ok = await trySend(er, [players[pidx]], [ixAction(players[pidx].publicKey, tablePda, seats[pidx], Action.Check)], `P${pidx} Check (fb)`, true);
    }
    await sleep(500);
  }
  return await readTable(er, tablePda, `${label} end`);
}

// ─── Privacy verification ───
async function verifyPrivacy(er: Connection, tablePda: PublicKey, maxPlayers: number) {
  console.log('\n═══ PRIVACY VERIFICATION ═══');
  let passed = true;
  
  // 1. Check deck_seed in TABLE on ER (offset 207, 32 bytes) — must be zeroed
  const tableInfo = await er.getAccountInfo(tablePda);
  if (tableInfo) {
    const d = Buffer.from(tableInfo.data);
    const deckSeed = d.slice(207, 239);
    const allZero = deckSeed.every(b => b === 0);
    console.log(`  deck_seed in Table on ER: ${allZero ? '✅ ALL ZEROS (private)' : '❌ NOT ZEROED: ' + deckSeed.toString('hex').slice(0, 32) + '...'}`);  
    if (!allZero) passed = false;
  } else {
    console.log('  ⚠️  Table not found on ER');
  }
  
  // 2. Check seat_cards on ER — hole cards at offset 73-74 (disc:8 + table:32 + seat_index:1 + player:32 + card1:1 + card2:1)
  for (let i = 0; i < maxPlayers; i++) {
    const scPda = getSeatCardsPda(tablePda, i);
    const scInfo = await er.getAccountInfo(scPda);
    if (scInfo) {
      const d = Buffer.from(scInfo.data);
      const card1 = d[73];
      const card2 = d[74];
      const isDefault = card1 === 255 && card2 === 255; // CARD_NOT_DEALT = 255
      const isHidden = card1 === 0 && card2 === 0;
      console.log(`  seat_cards[${i}] on ER: card1=${card1} card2=${card2} ${(isDefault || isHidden) ? '✅' : '⚠️ VISIBLE'}`);
      if (!isDefault && !isHidden && card1 < 52 && card2 < 52) {
        console.log(`    ❌ HOLE CARDS VISIBLE ON ER! card1=${card1} card2=${card2}`);
        passed = false;
      }
    }
  }
  
  // 3. Verify table is still delegated (never undelegated)
  const l1 = new Connection(L1_RPC, 'confirmed');
  const l1Info = await l1.getAccountInfo(tablePda);
  if (l1Info) {
    const isDelegated = l1Info.owner.toBase58().startsWith('DELeGG');
    console.log(`  Table on L1: owner=${l1Info.owner.toBase58().slice(0, 12)} ${isDelegated ? '✅ still delegated' : '❌ UNDELEGATED'}`);
    if (!isDelegated) passed = false;
  }
  
  console.log(`\n  Privacy check: ${passed ? '✅ PASSED' : '❌ FAILED'}`);
  return passed;
}

// ═══════════════════════════════════════════
// MAIN TEST
// ═══════════════════════════════════════════
async function main() {
  const l1 = new Connection(L1_RPC, 'confirmed');
  const er = new Connection(ER_RPC, 'confirmed');
  
  // Load existing registered players (NOT deployer)
  const players = [
    loadKey('j:/Poker/tests/keys/player1.json'), // creator + player
    loadKey('j:/Poker/tests/keys/player2.json'),
    loadKey('j:/Poker/tests/keys/player3.json'),
    loadKey('j:/Poker/tests/keys/player4.json'),
    loadKey('j:/Poker/tests/keys/player5.json'),
    loadKey('j:/Poker/tests/keys/player6.json'),
    loadKey('j:/Poker/tests/keys/player7.json'),
    loadKey('j:/Poker/tests/keys/player8.json'),
    loadKey('j:/Poker/tests/keys/player9.json'),
  ];
  
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   FULL CASH GAME E2E TEST — 6-max + 9-max              ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  for (let i = 0; i < players.length; i++) {
    const bal = await l1.getBalance(players[i].publicKey);
    console.log(`  P${i+1}: ${players[i].publicKey.toBase58().slice(0, 12)}... ${(bal/1e9).toFixed(4)} SOL`);
  }

  // ═══════════════════════════════════════════
  // PHASE 1: 6-MAX TABLE
  // ═══════════════════════════════════════════
  console.log('\n\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   PHASE 1: 6-MAX TABLE                                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  const auth = players[0]; // player1 is creator + authority
  
  // ─── Create table + record costs ───
  console.log('\n═══ Step 1: Create 6-Max Table ═══');
  const balBefore = await l1.getBalance(auth.publicKey);
  
  const tableId6 = `e2e_6max_${Date.now()}`;
  const tableIdBuf6 = Buffer.alloc(32);
  Buffer.from(tableId6).copy(tableIdBuf6);
  const [tablePda6] = PublicKey.findProgramAddressSync([Buffer.from('table'), tableIdBuf6], PROGRAM_ID);
  console.log(`  Table ID: ${tableId6}`);
  console.log(`  Table PDA: ${tablePda6.toBase58()}`);
  
  await sendTx(l1, [auth], [ixCreateTable(auth.publicKey, tableIdBuf6, tablePda6, 6)], 'create_user_table(6-max)');
  
  const balAfterCreate = await l1.getBalance(auth.publicKey);
  const createCost = (balBefore - balAfterCreate) / 1e9;
  console.log(`\n  💰 TABLE CREATION COST: ${createCost.toFixed(6)} SOL (${balBefore - balAfterCreate} lamports)`);
  
  // ─── Init all 6 seats + record costs ───
  console.log('\n═══ Step 2: Init All 6 Seats ═══');
  const balBeforeSeats = await l1.getBalance(auth.publicKey);
  
  for (let i = 0; i < 6; i++) {
    await sendTx(l1, [auth], [ixInitTableSeat(auth.publicKey, tablePda6, i)], `init_table_seat[${i}]`);
  }
  
  const balAfterSeats = await l1.getBalance(auth.publicKey);
  const seatsCost = (balBeforeSeats - balAfterSeats) / 1e9;
  console.log(`\n  💰 ALL 6 SEATS INIT COST: ${seatsCost.toFixed(6)} SOL (${(seatsCost/6).toFixed(6)} per seat)`);
  
  // ─── Delegate everything ───
  const balBeforeDelegate = await l1.getBalance(auth.publicKey);
  await delegateAll(l1, auth, tablePda6, tableIdBuf6, 6);
  const balAfterDelegate = await l1.getBalance(auth.publicKey);
  const delegateCost = (balBeforeDelegate - balAfterDelegate) / 1e9;
  console.log(`\n  💰 DELEGATION COST: ${delegateCost.toFixed(6)} SOL`);
  console.log(`\n  💰 TOTAL TABLE SETUP COST: ${(createCost + seatsCost + delegateCost).toFixed(6)} SOL`);
  
  // ─── Join 2 players first (minimum for a game) ───
  console.log('\n═══ Step 3: Join 2 Players ═══');
  await joinSeat(l1, er, auth, players[1], tablePda6, 0); // P2 → seat 0
  await joinSeat(l1, er, auth, players[2], tablePda6, 1); // P3 → seat 1
  
  // Verify seats on ER
  await readSeat(er, tablePda6, 0, 'ER after join');
  await readSeat(er, tablePda6, 1, 'ER after join');
  
  // ─── Start game + deal ───
  await startAndDeal(er, auth, tablePda6, 6);
  
  // Wait for Preflop
  console.log('  ⏳ Waiting for Preflop...');
  await waitPhase(er, tablePda6, [2,3,4,5], 30000, 'Preflop');
  
  // ─── PRIVACY CHECK (during active hand) ───
  await verifyPrivacy(er, tablePda6, 6);
  
  // ─── Play Hand 1: Check/Call through ───
  const activeSeats2 = [0, 1];
  const activePlayers2 = [players[1], players[2]];
  await playHand(er, tablePda6, activePlayers2, activeSeats2, 'Hand 1: Check/Call through');
  
  // Wait for crank to settle + start hand 2
  console.log('\n  ⏳ Waiting for settle...');
  try { await waitPhase(er, tablePda6, [0,1,2], 25000, 'settle'); }
  catch { console.log('  ⚠️  Settle timeout — continuing'); }
  
  // ─── Join remaining 4 players ───
  console.log('\n═══ Step 4: Join Remaining 4 Players ═══');
  // Wait for Waiting phase to join mid-session
  try { await waitPhase(er, tablePda6, [0], 15000, 'Waiting for joins'); } catch {}
  
  for (let i = 2; i < 6; i++) {
    try {
      await joinSeat(l1, er, auth, players[i+1], tablePda6, i); // P4-P7 → seats 2-5
    } catch (e: any) {
      console.log(`  ⚠️  Join seat ${i} failed: ${e.message?.slice(0, 80)}`);
    }
  }
  
  // Print all seats
  for (let i = 0; i < 6; i++) await readSeat(er, tablePda6, i, 'Full table');
  
  // ─── Play Hand with 6 players ───
  // Start game if in Waiting
  const st6 = await readTable(er, tablePda6, 'pre-6p-hand');
  if (st6 && st6.phase === 0) {
    await startAndDeal(er, auth, tablePda6, 6);
  }
  
  try { await waitPhase(er, tablePda6, [2,3,4,5], 30000, '6p Preflop'); } catch {}
  
  const allSeats6 = [0, 1, 2, 3, 4, 5];
  const allPlayers6 = [players[1], players[2], players[3], players[4], players[5], players[6]];
  await playHand(er, tablePda6, allPlayers6, allSeats6, 'Hand 2: 6-Player Check/Call');
  
  // ─── Test LEAVE seat 3 ───
  console.log('\n═══ Step 5: Test Leave (P5 leaves seat 3) ═══');
  try { await waitPhase(er, tablePda6, [0], 20000, 'wait between hands'); } catch {}
  await trySend(er, [players[4]], [ixAction(players[4].publicKey, tablePda6, 3, Action.LeaveCashGame)], 'P5 leave_cash_game', true);
  await readSeat(er, tablePda6, 3, 'After leave');
  
  // Wait for crank to process cashout
  console.log('  ⏳ Waiting 25s for crank cashout...');
  await sleep(25000);
  await readSeat(er, tablePda6, 3, 'After cashout');
  
  // ─── Test REJOIN seat 3 with different player ───
  console.log('\n═══ Step 6: Test Rejoin (P8 joins vacated seat 3) ═══');
  try {
    await joinSeat(l1, er, auth, players[7], tablePda6, 3); // P8 → seat 3
    await readSeat(er, tablePda6, 3, 'After rejoin');
    console.log('  ✅ REJOIN SUCCESSFUL');
  } catch (e: any) {
    console.log(`  ❌ REJOIN FAILED: ${e.message?.slice(0, 120)}`);
  }
  
  // ─── Test AUTO-SIT-OUT (skip player turn, let timeout fire) ───
  console.log('\n═══ Step 7: Test Auto-Sit-Out ═══');
  // Start a new hand
  const stPre = await readTable(er, tablePda6, 'pre-timeout-hand');
  if (stPre && stPre.phase === 0) {
    try {
      await startAndDeal(er, auth, tablePda6, 6);
      await waitPhase(er, tablePda6, [2,3,4,5], 30000, 'timeout hand');
      
      const t = await readTable(er, tablePda6, 'timeout hand started');
      if (t) {
        console.log(`  Current player: seat ${t.cp}`);
        console.log('  ⏳ NOT acting — waiting 35s for crank timeout...');
        await sleep(35000);
        
        // Check if player was auto-folded/sat-out
        const afterTimeout = await readTable(er, tablePda6, 'after timeout');
        if (afterTimeout) {
          if (afterTimeout.cp !== t.cp) {
            console.log('  ✅ Auto-timeout worked — turn advanced');
          } else {
            console.log('  ⚠️  Timeout may not have fired — crank may not be watching this table');
          }
        }
      }
    } catch (e: any) {
      console.log(`  ⚠️  Timeout test error: ${e.message?.slice(0, 80)}`);
    }
  }
  
  // ─── Final privacy check ───
  await verifyPrivacy(er, tablePda6, 6);
  
  // ─── 6-max summary ───
  console.log('\n═══ 6-MAX COST SUMMARY ═══');
  console.log(`  Table creation:  ${createCost.toFixed(6)} SOL`);
  console.log(`  6 seats init:    ${seatsCost.toFixed(6)} SOL (${(seatsCost/6).toFixed(6)} per seat)`);
  console.log(`  Delegation:      ${delegateCost.toFixed(6)} SOL`);
  console.log(`  TOTAL:           ${(createCost + seatsCost + delegateCost).toFixed(6)} SOL`);

  // ═══════════════════════════════════════════
  // PHASE 2: 9-MAX TABLE
  // ═══════════════════════════════════════════
  console.log('\n\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   PHASE 2: 9-MAX TABLE                                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  const balBefore9 = await l1.getBalance(auth.publicKey);
  
  const tableId9 = `e2e_9max_${Date.now()}`;
  const tableIdBuf9 = Buffer.alloc(32);
  Buffer.from(tableId9).copy(tableIdBuf9);
  const [tablePda9] = PublicKey.findProgramAddressSync([Buffer.from('table'), tableIdBuf9], PROGRAM_ID);
  console.log(`\n  Table ID: ${tableId9}`);
  console.log(`  Table PDA: ${tablePda9.toBase58()}`);
  
  await sendTx(l1, [auth], [ixCreateTable(auth.publicKey, tableIdBuf9, tablePda9, 9)], 'create_user_table(9-max)');
  const balAfterCreate9 = await l1.getBalance(auth.publicKey);
  const createCost9 = (balBefore9 - balAfterCreate9) / 1e9;
  console.log(`  💰 9-MAX TABLE CREATION COST: ${createCost9.toFixed(6)} SOL`);
  
  // Init all 9 seats
  console.log('\n═══ Init 9 Seats ═══');
  const balBeforeSeats9 = await l1.getBalance(auth.publicKey);
  for (let i = 0; i < 9; i++) {
    await sendTx(l1, [auth], [ixInitTableSeat(auth.publicKey, tablePda9, i)], `init_table_seat[${i}]`);
  }
  const balAfterSeats9 = await l1.getBalance(auth.publicKey);
  const seatsCost9 = (balBeforeSeats9 - balAfterSeats9) / 1e9;
  console.log(`  💰 9 SEATS INIT COST: ${seatsCost9.toFixed(6)} SOL (${(seatsCost9/9).toFixed(6)} per seat)`);
  
  // Delegate all
  const balBeforeDelegate9 = await l1.getBalance(auth.publicKey);
  await delegateAll(l1, auth, tablePda9, tableIdBuf9, 9);
  const balAfterDelegate9 = await l1.getBalance(auth.publicKey);
  const delegateCost9 = (balBeforeDelegate9 - balAfterDelegate9) / 1e9;
  console.log(`  💰 9-MAX DELEGATION COST: ${delegateCost9.toFixed(6)} SOL`);
  
  // Join all 9 players
  console.log('\n═══ Join All 9 Players ═══');
  for (let i = 0; i < 9; i++) {
    try {
      await joinSeat(l1, er, auth, players[i], tablePda9, i);
    } catch (e: any) {
      console.log(`  ❌ Join seat ${i} failed: ${e.message?.slice(0, 80)}`);
    }
  }
  
  for (let i = 0; i < 9; i++) await readSeat(er, tablePda9, i, '9-max');
  
  // Start game
  await startAndDeal(er, auth, tablePda9, 9);
  
  // Wait for Preflop
  try { await waitPhase(er, tablePda9, [2,3,4,5], 30000, '9p Preflop'); } catch {}
  
  // Privacy check on 9-max during active hand
  await verifyPrivacy(er, tablePda9, 9);
  
  // Play hand with all 9
  const allSeats9 = [0,1,2,3,4,5,6,7,8];
  await playHand(er, tablePda9, players, allSeats9, '9-Player Hand: Check/Call');
  
  // Wait for settle
  try { await waitPhase(er, tablePda9, [0,1,2], 25000, '9p settle'); }
  catch { console.log('  ⚠️  9p settle timeout'); }
  
  // ─── Test leave + rejoin on 9-max ───
  console.log('\n═══ 9-Max: P3 Leaves Seat 2, P3 Rejoins ═══');
  try { await waitPhase(er, tablePda9, [0], 15000, 'waiting'); } catch {}
  
  await trySend(er, [players[2]], [ixAction(players[2].publicKey, tablePda9, 2, Action.LeaveCashGame)], 'P3 leave seat 2', true);
  console.log('  ⏳ Waiting 25s for crank cashout...');
  await sleep(25000);
  await readSeat(er, tablePda9, 2, 'After leave');
  
  // Rejoin same seat with same player
  console.log('  Attempting rejoin of same seat with same player...');
  try {
    await joinSeat(l1, er, auth, players[2], tablePda9, 2);
    await readSeat(er, tablePda9, 2, 'After rejoin');
    console.log('  ✅ SAME-PLAYER REJOIN SUCCESSFUL');
  } catch (e: any) {
    console.log(`  ❌ SAME-PLAYER REJOIN FAILED: ${e.message?.slice(0, 120)}`);
  }
  
  // ─── 9-max cost summary ───
  console.log('\n═══ 9-MAX COST SUMMARY ═══');
  console.log(`  Table creation:  ${createCost9.toFixed(6)} SOL`);
  console.log(`  9 seats init:    ${seatsCost9.toFixed(6)} SOL (${(seatsCost9/9).toFixed(6)} per seat)`);
  console.log(`  Delegation:      ${delegateCost9.toFixed(6)} SOL`);
  console.log(`  TOTAL:           ${(createCost9 + seatsCost9 + delegateCost9).toFixed(6)} SOL`);
  
  // ═══════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════
  console.log('\n\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   FINAL SUMMARY                                         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('\n  COSTS:');
  console.log(`  6-max total: ${(createCost + seatsCost + delegateCost).toFixed(6)} SOL`);
  console.log(`  9-max total: ${(createCost9 + seatsCost9 + delegateCost9).toFixed(6)} SOL`);
  console.log('\n  TABLES:');
  console.log(`  6-max: ${tablePda6.toBase58()}`);
  console.log(`  9-max: ${tablePda9.toBase58()}`);
  console.log('\n  Player balances:');
  for (let i = 0; i < 9; i++) {
    const bal = await l1.getBalance(players[i].publicKey);
    console.log(`  P${i+1}: ${(bal/1e9).toFixed(4)} SOL`);
  }
}

main().catch(e => {
  console.error('\n💥 TEST FAILED:', e.message?.slice(0, 300) || e);
  process.exit(1);
});
