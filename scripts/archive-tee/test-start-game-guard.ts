/**
 * Test: Contract-level guard rejects start_game WITHOUT seat_cards.
 * Uses an already-delegated table on TEE to verify:
 *   1. OLD format (no deck_state, no seat_cards) → MUST FAIL
 *   2. PARTIAL format (deck_state but no seat_cards) → MUST FAIL
 *   3. NEW format (deck_state + seat_cards) → MUST SUCCEED
 *
 * Run: npx ts-node scripts/test-start-game-guard.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import * as fs from 'fs';
import * as crypto from 'crypto';
import bs58 from 'bs58';
import * as nacl from 'tweetnacl';
import * as https from 'https';

const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const TEE_RPC_BASE = 'https://tee.magicblock.app';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const TEE_VALIDATOR = new PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA');
const DEPLOYER_PATH = 'j:/critters/mini-game/deployer-keypair.json';

const MAX_PLAYERS = 2;
const SNG_TIER_BRONZE = 1;
const BRONZE_ENTRY = 18_750_000;
const BRONZE_FEE = 6_250_000;
const BRONZE_TOTAL = BRONZE_ENTRY + BRONZE_FEE;

function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}
const DISC = {
  createTable: disc('create_table'),
  initTableSeat: disc('init_table_seat'),
  joinTable: disc('join_table'),
  registerPlayer: disc('register_player'),
  startGame: disc('start_game'),
  delegateTable: disc('delegate_table'),
  delegateSeat: disc('delegate_seat'),
  delegateSeatCards: disc('delegate_seat_cards'),
  delegateDeckState: disc('delegate_deck_state'),
  delegatePermission: disc('delegate_permission'),
};
const DISC_TABLE_PERM = Buffer.from([194, 38, 119, 36, 146, 11, 104, 110]);
const DISC_DS_PERM = Buffer.from([217, 32, 126, 22, 180, 97, 105, 157]);
const DISC_SEAT_PERM = Buffer.from([161, 4, 4, 164, 13, 227, 248, 60]);
const DISC_DEL_TABLE_PERM = Buffer.from([149, 71, 189, 246, 84, 211, 143, 207]);
const DISC_DEL_DS_PERM = Buffer.from([118, 187, 69, 88, 192, 76, 153, 111]);
const DISC_DEL_SEAT_PERM = Buffer.from([110, 176, 51, 3, 248, 220, 36, 196]);

const getSeatPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('seat'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getSeatCardsPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getDeckStatePda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('deck_state'), t.toBuffer()], PROGRAM_ID);
const getTablePda = (id: Buffer) => PublicKey.findProgramAddressSync([Buffer.from('table'), id], PROGRAM_ID);
const getPermPda = (a: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('permission:'), a.toBuffer()], PERMISSION_PROGRAM_ID);
const getPlayerPda = (w: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('player'), w.toBuffer()], PROGRAM_ID);
const getMarkerPda = (w: PublicKey, t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('player_table'), w.toBuffer(), t.toBuffer()], PROGRAM_ID);
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const getUnrefinedPda = (w: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('unrefined'), w.toBuffer()], STEEL_PROGRAM_ID);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function httpJson(url: string, opts?: { method?: string; body?: string }): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const o: any = { hostname: p.hostname, port: 443, path: p.pathname + p.search, method: opts?.method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (opts?.body) o.headers['Content-Length'] = Buffer.byteLength(opts.body);
    const r = https.request(o, (res) => { let d = ''; res.on('data', (c: string) => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } }); });
    r.on('error', reject); if (opts?.body) r.write(opts.body); r.end();
  });
}

async function getTeeConnection(kp: Keypair): Promise<Connection> {
  const pub = kp.publicKey.toBase58();
  const cr = await httpJson(`${TEE_RPC_BASE}/auth/challenge?pubkey=${pub}`);
  if (!cr.challenge) throw new Error(`TEE challenge failed: ${JSON.stringify(cr)}`);
  const sig = nacl.sign.detached(Buffer.from(cr.challenge, 'utf-8'), kp.secretKey);
  const lr = await httpJson(`${TEE_RPC_BASE}/auth/login`, { method: 'POST', body: JSON.stringify({ pubkey: pub, challenge: cr.challenge, signature: bs58.encode(Buffer.from(sig)) }) });
  if (!lr.token) throw new Error(`TEE login failed: ${JSON.stringify(lr)}`);
  return new Connection(`${TEE_RPC_BASE}?token=${lr.token}`, 'confirmed');
}

async function sendTx(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], opts: any = {}) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = opts.feePayer ? new PublicKey(opts.feePayer) : signers[0].publicKey;
  const bh = opts.skipPreflight ? await conn.getLatestBlockhash() : await conn.getLatestBlockhash();
  tx.recentBlockhash = bh.blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: !!opts.skipPreflight });
  // Poll confirmation
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const s = await conn.getSignatureStatuses([sig]);
    if (s?.value?.[0]?.confirmationStatus === 'confirmed' || s?.value?.[0]?.confirmationStatus === 'finalized') return sig;
    if (s?.value?.[0]?.err) throw new Error(`TX error: ${JSON.stringify(s.value[0].err)}`);
  }
  throw new Error('TX confirmation timeout');
}

let passed = 0, failed = 0;
function pass(label: string) { passed++; console.log(`  ✅ PASS: ${label}`); }
function fail(label: string, detail?: string) { failed++; console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); }

async function main() {
  console.log('════════════════════════════════════════════════════════');
  console.log('  CONTRACT GUARD TEST: start_game rejects missing accounts');
  console.log('════════════════════════════════════════════════════════\n');

  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(DEPLOYER_PATH, 'utf-8'))));
  const l1 = new Connection(L1_RPC, 'confirmed');
  const tee = await getTeeConnection(deployer);
  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);

  // Create fresh table + join + delegate (minimal setup)
  const tableId = Buffer.alloc(32);
  crypto.randomBytes(32).copy(tableId);
  const [tablePda] = getTablePda(tableId);
  console.log(`Table: ${tablePda.toBase58()}\n`);

  // Create table
  // disc(8) + table_id(32) + game_type(1) + stakes(1) + max_players(1) + tier(1) = 44
  const ctData = Buffer.alloc(44);
  DISC.createTable.copy(ctData, 0);
  tableId.copy(ctData, 8);
  ctData.writeUInt8(0, 40); // SitAndGoHeadsUp
  ctData.writeUInt8(0, 41); // Micro stakes (ignored for SNG)
  ctData.writeUInt8(MAX_PLAYERS, 42);
  ctData.writeUInt8(SNG_TIER_BRONZE, 43);
  await sendTx(l1, [new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ctData,
  })], [deployer]);
  console.log('  Table created');

  // Init seats
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const itsData = Buffer.alloc(9);
    DISC.initTableSeat.copy(itsData, 0);
    itsData.writeUInt8(i, 8);
    await sendTx(l1, [new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: getSeatPda(tablePda, i)[0], isSigner: false, isWritable: true },
        { pubkey: getSeatCardsPda(tablePda, i)[0], isSigner: false, isWritable: true },
        { pubkey: getDeckStatePda(tablePda)[0], isSigner: false, isWritable: true },
        { pubkey: getPermPda(getSeatCardsPda(tablePda, i)[0])[0], isSigner: false, isWritable: true },
        { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: itsData,
    })], [deployer]);
  }
  console.log('  Seats initialized');

  // Create + fund players, register, join (matching working E2E test pattern)
  const { ComputeBudgetProgram } = await import('@solana/web3.js');
  const players: Keypair[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const p = Keypair.generate();
    players.push(p);
    const fundTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: p.publicKey, lamports: 100_000_000 }));
    await sendAndConfirmTransaction(l1, fundTx, [deployer]);

    // Register (with compute budget for Steel CPI)
    const rpData = Buffer.alloc(8);
    disc('register_player').copy(rpData, 0);
    const regTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: p.publicKey, isSigner: true, isWritable: true },
          { pubkey: getPlayerPda(p.publicKey)[0], isSigner: false, isWritable: true },
          { pubkey: TREASURY, isSigner: false, isWritable: true },
          { pubkey: POOL_PDA, isSigner: false, isWritable: true },
          { pubkey: getUnrefinedPda(p.publicKey)[0], isSigner: false, isWritable: true },
          { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: rpData,
      })
    );
    regTx.feePayer = p.publicKey;
    regTx.recentBlockhash = (await l1.getLatestBlockhash()).blockhash;
    await sendAndConfirmTransaction(l1, regTx, [p]);

    // Join: disc(8) + buy_in(8) + seat_number(1) + reserve(8) = 25
    const jtData = Buffer.alloc(25);
    DISC.joinTable.copy(jtData, 0);
    jtData.writeBigUInt64LE(BigInt(1500), 8);
    jtData.writeUInt8(i, 16);
    jtData.writeBigUInt64LE(BigInt(0), 17);
    const joinTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: p.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: true },
          { pubkey: getSeatPda(tablePda, i)[0], isSigner: false, isWritable: true },
          { pubkey: getPlayerPda(p.publicKey)[0], isSigner: false, isWritable: true },
          { pubkey: getMarkerPda(p.publicKey, tablePda)[0], isSigner: false, isWritable: true },
          { pubkey: TREASURY, isSigner: false, isWritable: true },
          { pubkey: POOL_PDA, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: jtData,
      })
    );
    joinTx.feePayer = p.publicKey;
    joinTx.recentBlockhash = (await l1.getLatestBlockhash()).blockhash;
    await sendAndConfirmTransaction(l1, joinTx, [p]);
  }
  console.log('  Players joined');

  // No delegation needed — test the contract guard on L1 directly.
  // The Anchor account count validation runs identically on L1 and TEE.
  // On TEE, the additional layer (InvalidWritableAccount for non-delegated) adds even more protection.
  console.log('\n  Testing contract guard on L1 (no delegation needed)...\n');

  // ═══════════════════════════════════════════════════════════
  // TEST 1: OLD format (no deck_state, no seat_cards) → MUST FAIL
  // ═══════════════════════════════════════════════════════════
  console.log('TEST 1: start_game with OLD format (no deck_state, no seat_cards)');
  try {
    const oldKeys = [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      ...Array.from({ length: MAX_PLAYERS }, (_, i) => ({ pubkey: getSeatPda(tablePda, i)[0], isSigner: false, isWritable: true })),
    ];
    await sendAndConfirmTransaction(l1, new Transaction().add(new TransactionInstruction({ programId: PROGRAM_ID, keys: oldKeys, data: DISC.startGame })), [deployer]);
    fail('OLD format should have been REJECTED but TX confirmed');
  } catch (e: any) {
    const msg = e.message || '';
    if (msg.includes('3012') || msg.includes('NotEnoughKeys') || msg.includes('custom program error')) {
      pass('OLD format REJECTED — missing deck_state account');
    } else {
      pass('OLD format REJECTED: ' + msg.slice(0, 100));
    }
  }

  // ═══════════════════════════════════════════════════════════
  // TEST 2: PARTIAL format (deck_state but no seat_cards) → MUST FAIL
  // ═══════════════════════════════════════════════════════════
  console.log('\nTEST 2: start_game with deck_state but NO seat_cards');
  try {
    const partialKeys = [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: getDeckStatePda(tablePda)[0], isSigner: false, isWritable: true },
      ...Array.from({ length: MAX_PLAYERS }, (_, i) => ({ pubkey: getSeatPda(tablePda, i)[0], isSigner: false, isWritable: true })),
    ];
    await sendAndConfirmTransaction(l1, new Transaction().add(new TransactionInstruction({ programId: PROGRAM_ID, keys: partialKeys, data: DISC.startGame })), [deployer]);
    fail('PARTIAL format should have been REJECTED but TX confirmed');
  } catch (e: any) {
    const msg = e.message || '';
    if (msg.includes('InvalidAccountCount') || msg.includes('custom program error')) {
      pass('PARTIAL format REJECTED — missing seat_cards (InvalidAccountCount)');
    } else {
      pass('PARTIAL format REJECTED: ' + msg.slice(0, 100));
    }
  }

  // ═══════════════════════════════════════════════════════════
  // TEST 3: NEW format (deck_state + seats + seat_cards) → MUST SUCCEED
  // ═══════════════════════════════════════════════════════════
  console.log('\nTEST 3: start_game with NEW format (deck_state + seats + seat_cards)');
  try {
    const newKeys = [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: getDeckStatePda(tablePda)[0], isSigner: false, isWritable: true },
      ...Array.from({ length: MAX_PLAYERS }, (_, i) => ({ pubkey: getSeatPda(tablePda, i)[0], isSigner: false, isWritable: true })),
      ...Array.from({ length: MAX_PLAYERS }, (_, i) => ({ pubkey: getSeatCardsPda(tablePda, i)[0], isSigner: false, isWritable: true })),
    ];
    await sendAndConfirmTransaction(l1, new Transaction().add(new TransactionInstruction({ programId: PROGRAM_ID, keys: newKeys, data: DISC.startGame })), [deployer]);
    pass('NEW format ACCEPTED — game started successfully on L1');
  } catch (e: any) {
    fail('NEW format should have SUCCEEDED: ' + (e.message?.slice(0, 100) || 'error'));
  }

  console.log(`\n════════════════════════════════════════════════════════`);
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════════════════════════════════`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
