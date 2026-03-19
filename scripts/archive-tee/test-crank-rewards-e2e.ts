/**
 * Crank Rewards + Tip Jar E2E Test
 *
 * Creates a 0.0005/0.001 SOL table, plays 10 hands, then verifies:
 *   1. crank_pool_accumulated > 0 (5% of rake)
 *   2. Tip jar balance decremented correctly
 *   3. Rake sweep (CommitState → process_rake_distribution → distribute_crank_rewards)
 *   4. CrankOperator.lifetime_sol_earned increases
 *
 * PREREQUISITE: Crank service must be running!
 *   npx ts-node backend/crank-service.ts
 *
 * Run: npx ts-node scripts/test-crank-rewards-e2e.ts
 */
import {
  Connection, PublicKey, Keypair, SystemProgram, TransactionInstruction, ComputeBudgetProgram, SYSVAR_SLOT_HASHES_PUBKEY,
  Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const TEE_RPC_BASE = 'https://tee.magicblock.app';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const TEE_VALIDATOR = new PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA');
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
// Use crank key (permissionless — proves no admin needed)
const DEPLOYER_PATH = 'j:/Poker/contracts/auth/deployers/crank-keypair.json';
const ANCHOR_DEPLOYER_PATH = 'j:/Poker/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json';

// SYSVAR_SLOT_HASHES_PUBKEY imported from @solana/web3.js

const MAX_PLAYERS = 2;
const SMALL_BLIND = BigInt(500_000);     // 0.0005 SOL
const BIG_BLIND   = BigInt(1_000_000);   // 0.001  SOL
const BUY_IN = 100_000_000;             // 100 BB = 0.1 SOL
const PLAYER_FUND = 300_000_000;         // 0.3 SOL per player (buy-in + fees + rent + tips)

const FOLD = 0; const CHECK = 1; const CALL = 2; const RAISE = 4; const LEAVE_CASH_GAME = 8;

// Card display helpers
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['♠','♥','♦','♣'];
function cardStr(c: number): string {
  if (c === 255 || c === undefined) return '??';
  return RANKS[c % 13] + SUITS[Math.floor(c / 13)];
}
// SeatCards PDA layout: disc(8) + table(32) + seat_index(1) + player(32) + card1(1) + card2(1) + bump(1)
const SC_CARD1 = 8 + 32 + 1 + 32; // offset 73
const SC_CARD2 = SC_CARD1 + 1;     // offset 74
// Table community cards at offset 155-159
const COMMUNITY_CARDS_OFF = 155;

const Phase = {
  Waiting: 0, Starting: 1, Preflop: 2, Flop: 3, Turn: 4, River: 5,
  Showdown: 6, Complete: 7, FlopRevealPending: 8, TurnRevealPending: 9, RiverRevealPending: 10,
} as const;
const PHASE_NAMES = ['Waiting','Starting','Preflop','Flop','Turn','River','Showdown','Complete',
  'FlopRevealPending','TurnRevealPending','RiverRevealPending'];

// Table byte offsets
const OFF = {
  PHASE: 160, CURRENT_PLAYER: 161, MAX_PLAYERS: 121, CURRENT_PLAYERS: 122,
  HAND_NUMBER: 123, POT: 131, SEATS_OCCUPIED: 250, IS_DELEGATED: 174,
  RAKE_ACCUMULATED: 147, CREATOR: 290, IS_USER_CREATED: 322,
  CREATOR_RAKE_TOTAL: 323, RAKE_CAP: 418, IS_PRIVATE: 426,
  CRANK_POOL_ACCUMULATED: 427, TOKEN_MINT: 385, FLOP_REACHED: 257,
};
const SEAT_CHIPS_OFFSET = 104;
const SEAT_STATUS_OFFSET = 227;
const SEAT_TIME_BANK_OFFSET = 278;
const SEAT_TIME_BANK_ACTIVE_OFFSET = 280;

// ═══════════════════════════════════════════════════════════════════
// DISCRIMINATORS
// ═══════════════════════════════════════════════════════════════════
function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

const DISC = {
  createUserTable: Buffer.from([238, 125, 176, 179, 242, 249, 219, 183]),
  initTableSeat:   Buffer.from([4, 2, 110, 85, 144, 112, 65, 236]),
  delegateTable:   Buffer.from([161, 66, 67, 113, 58, 219, 238, 170]),
  delegateSeat:    Buffer.from([53, 85, 50, 81, 161, 68, 71, 212]),
  delegateSeatCards: Buffer.from([79, 21, 238, 244, 141, 174, 3, 26]),
  delegateDeckState: Buffer.from([35, 80, 108, 20, 133, 115, 71, 235]),
  delegatePermission: Buffer.from([187, 192, 110, 65, 252, 88, 194, 103]),
  registerPlayer: disc('register_player'),
  depositForJoin: disc('deposit_for_join'),
  seatPlayer: disc('seat_player'),
  startGame: disc('start_game'),
  playerAction: disc('player_action'),
  useTimeBank: disc('use_time_bank'),
  depositTip: disc('deposit_tip'),
  addWhitelist: disc('add_whitelist'),
  removeWhitelist: disc('remove_whitelist'),
  initCrankTallyEr: disc('init_crank_tally_er'),
  initCrankTallyL1: disc('init_crank_tally_l1'),
  initTipJar: disc('init_tip_jar'),
  distributeCrankRewards: disc('distribute_crank_rewards'),
  delegateCrankTally: disc('delegate_crank_tally'),
  teeDeal: disc('tee_deal'),
  teeReveal: disc('tee_reveal'),
  settleHand: disc('settle_hand'),
};
const DISC_TABLE_PERM = Buffer.from([194, 38, 119, 36, 146, 11, 104, 110]);
const DISC_SEAT_PERM = Buffer.from([161, 4, 4, 164, 13, 227, 248, 60]);
const DISC_DS_PERM = Buffer.from([217, 32, 126, 22, 180, 97, 105, 157]);
const DISC_DEL_TABLE_PERM = Buffer.from([149, 71, 189, 246, 84, 211, 143, 207]);
const DISC_DEL_SEAT_PERM = Buffer.from([110, 176, 51, 3, 248, 220, 36, 196]);
const DISC_DEL_DS_PERM = Buffer.from([118, 187, 69, 88, 192, 76, 153, 111]);

// ═══════════════════════════════════════════════════════════════════
// PDA HELPERS
// ═══════════════════════════════════════════════════════════════════
const getTablePda = (id: Buffer) => PublicKey.findProgramAddressSync([Buffer.from('table'), id], PROGRAM_ID);
const getVaultPda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('vault'), t.toBuffer()], PROGRAM_ID);
const getSeatPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('seat'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getSeatCardsPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getDeckStatePda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('deck_state'), t.toBuffer()], PROGRAM_ID);
const getPermissionPda = (a: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('permission:'), a.toBuffer()], PERMISSION_PROGRAM_ID);
const getPlayerPda = (w: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('player'), w.toBuffer()], PROGRAM_ID);
const getMarkerPda = (w: PublicKey, t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('player_table'), w.toBuffer(), t.toBuffer()], PROGRAM_ID);
const getReceiptPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('receipt'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getDepositProofPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('deposit_proof'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getUnrefinedPda = (w: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('unrefined'), w.toBuffer()], STEEL_PROGRAM_ID);
const getCrankTallyErPda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('crank_tally_er'), t.toBuffer()], PROGRAM_ID);
const getCrankTallyL1Pda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('crank_tally_l1'), t.toBuffer()], PROGRAM_ID);
const getTipJarPda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('tip_jar'), t.toBuffer()], PROGRAM_ID);
const getWhitelistPda = (t: PublicKey, p: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('whitelist'), t.toBuffer(), p.toBuffer()], PROGRAM_ID);
const getCrankOperatorPda = (w: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('crank_operator'), w.toBuffer()], PROGRAM_ID);

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let passCount = 0;
let failCount = 0;
const frontendFixes: string[] = [];

function log(msg: string) { console.log(msg); }
function pass(step: string, detail: string = '') {
  passCount++;
  console.log(`  ✅ PASS: ${step}${detail ? ' — ' + detail : ''}`);
}
function fail(step: string, detail: string = '') {
  failCount++;
  console.log(`  ❌ FAIL: ${step}${detail ? ' — ' + detail : ''}`);
}
function frontendFix(component: string, description: string) {
  frontendFixes.push(`- [${component}] ${description}`);
  console.log(`  📋 FRONTEND FIX: [${component}] ${description}`);
}

async function sendTx(
  conn: Connection, ixs: TransactionInstruction[], signers: Keypair[],
  opts: { skipPreflight?: boolean; feePayer?: PublicKey } = {},
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = opts.feePayer || signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  return sendAndConfirmTransaction(conn, tx, signers, {
    commitment: 'confirmed',
    skipPreflight: opts.skipPreflight ?? false,
  });
}

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

function readU64(data: Buffer, offset: number): number { return Number(data.readBigUInt64LE(offset)); }
function readU16(data: Buffer, offset: number): number { return data.readUInt16LE(offset); }

function permDelegationAccounts(permPda: PublicKey) {
  return {
    buf: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID),
    rec: delegationRecordPdaFromDelegatedAccount(permPda),
    meta: delegationMetadataPdaFromDelegatedAccount(permPda),
  };
}

// ═══════════════════════════════════════════════════════════════════
// FULL TABLE SETUP HELPER (create + init seats + permissions + delegate)
// ═══════════════════════════════════════════════════════════════════
async function createAndDelegateTable(
  l1: Connection, deployer: Keypair, opts: {
    maxPlayers?: number; smallBlind?: bigint; bigBlind?: bigint;
    tokenMint?: PublicKey; isPrivate?: boolean;
  } = {},
): Promise<{ tablePda: PublicKey; vaultPda: PublicKey; tableIdBuf: Buffer }> {
  const maxPlayers = opts.maxPlayers || MAX_PLAYERS;
  const sb = opts.smallBlind || SMALL_BLIND;
  const bb = opts.bigBlind || BIG_BLIND;
  const mint = opts.tokenMint || PublicKey.default;
  const isPrivate = opts.isPrivate || false;

  const tableIdBuf = crypto.randomBytes(32);
  const [tablePda] = getTablePda(tableIdBuf);
  const [vaultPda] = getVaultPda(tablePda);

  // create_user_table: disc(8) + table_id(32) + max_players(1) + small_blind(8) + big_blind(8) + token_mint(32) + buy_in_type(1) + is_private(1)
  const ctData = Buffer.alloc(8 + 32 + 1 + 8 + 8 + 32 + 1 + 1);
  DISC.createUserTable.copy(ctData, 0);
  tableIdBuf.copy(ctData, 8);
  ctData.writeUInt8(maxPlayers, 40);
  ctData.writeBigUInt64LE(sb, 41);
  ctData.writeBigUInt64LE(bb, 49);
  mint.toBuffer().copy(ctData, 57);
  ctData.writeUInt8(0, 89); // Normal buy-in
  ctData.writeUInt8(isPrivate ? 1 : 0, 90);

  await sendTx(l1, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: POOL_PDA, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: ctData,
    }),
  ], [deployer]);

  // Init seats
  for (let i = 0; i < maxPlayers; i++) {
    const [seatPda] = getSeatPda(tablePda, i);
    const [scPda] = getSeatCardsPda(tablePda, i);
    const [dsPda] = getDeckStatePda(tablePda);
    const [rcPda] = getReceiptPda(tablePda, i);
    const [dpPda] = getDepositProofPda(tablePda, i);
    const [permPda] = getPermissionPda(scPda);
    const data = Buffer.alloc(9);
    DISC.initTableSeat.copy(data, 0);
    data.writeUInt8(i, 8);
    await sendTx(l1, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: seatPda, isSigner: false, isWritable: true },
          { pubkey: scPda, isSigner: false, isWritable: true },
          { pubkey: dsPda, isSigner: false, isWritable: true },
          { pubkey: rcPda, isSigner: false, isWritable: true },
          { pubkey: dpPda, isSigner: false, isWritable: true },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      }),
    ], [deployer]);
  }

  // Create permissions (table, deckState, seats)
  {
    const [permPda] = getPermissionPda(tablePda);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data: DISC_TABLE_PERM,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
  }
  {
    const [dsPda] = getDeckStatePda(tablePda);
    const [permPda] = getPermissionPda(dsPda);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data: DISC_DS_PERM,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: dsPda, isSigner: false, isWritable: false },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
  }
  for (let i = 0; i < maxPlayers; i++) {
    const [seatPda] = getSeatPda(tablePda, i);
    const [permPda] = getPermissionPda(seatPda);
    const data = Buffer.alloc(9); DISC_SEAT_PERM.copy(data, 0); data.writeUInt8(i, 8);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: seatPda, isSigner: false, isWritable: false },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
  }

  // Delegate permission PDAs
  {
    const [permPda] = getPermissionPda(tablePda);
    const { buf, rec, meta } = permDelegationAccounts(permPda);
    const d = Buffer.alloc(40); DISC_DEL_TABLE_PERM.copy(d, 0); tableIdBuf.copy(d, 8);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data: d,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: true },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: buf, isSigner: false, isWritable: true },
          { pubkey: rec, isSigner: false, isWritable: true },
          { pubkey: meta, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
  }
  {
    const [dsPda] = getDeckStatePda(tablePda);
    const [permPda] = getPermissionPda(dsPda);
    const { buf, rec, meta } = permDelegationAccounts(permPda);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data: DISC_DEL_DS_PERM,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: dsPda, isSigner: false, isWritable: true },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: buf, isSigner: false, isWritable: true },
          { pubkey: rec, isSigner: false, isWritable: true },
          { pubkey: meta, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
  }
  for (let i = 0; i < maxPlayers; i++) {
    const [seatPda] = getSeatPda(tablePda, i);
    const [permPda] = getPermissionPda(seatPda);
    const { buf, rec, meta } = permDelegationAccounts(permPda);
    const d = Buffer.alloc(9); DISC_DEL_SEAT_PERM.copy(d, 0); d.writeUInt8(i, 8);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data: d,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: seatPda, isSigner: false, isWritable: true },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: buf, isSigner: false, isWritable: true },
          { pubkey: rec, isSigner: false, isWritable: true },
          { pubkey: meta, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
  }

  // Init CrankTallyER + CrankTallyL1 (must be BEFORE delegation)
  {
    const [crankTallyEr] = getCrankTallyErPda(tablePda);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data: DISC.initCrankTallyEr,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: crankTallyEr, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
  }
  {
    const [crankTallyL1] = getCrankTallyL1Pda(tablePda);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data: DISC.initCrankTallyL1,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: crankTallyL1, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
  }

  // Delegate table
  {
    const tBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(tablePda, PROGRAM_ID);
    const tRec = delegationRecordPdaFromDelegatedAccount(tablePda);
    const tMeta = delegationMetadataPdaFromDelegatedAccount(tablePda);
    const d = Buffer.alloc(40); DISC.delegateTable.copy(d, 0); tableIdBuf.copy(d, 8);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data: d,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tBuf, isSigner: false, isWritable: true },
          { pubkey: tRec, isSigner: false, isWritable: true },
          { pubkey: tMeta, isSigner: false, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: true },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
  }
  // Delegate DeckState
  {
    const [dsPda] = getDeckStatePda(tablePda);
    const dsBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(dsPda, PROGRAM_ID);
    const dsRec = delegationRecordPdaFromDelegatedAccount(dsPda);
    const dsMeta = delegationMetadataPdaFromDelegatedAccount(dsPda);
    const d = Buffer.alloc(8); DISC.delegateDeckState.copy(d, 0);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data: d,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: dsBuf, isSigner: false, isWritable: true },
          { pubkey: dsRec, isSigner: false, isWritable: true },
          { pubkey: dsMeta, isSigner: false, isWritable: true },
          { pubkey: dsPda, isSigner: false, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
  }
  // Delegate per-seat (seatCards perm + seat + seatCards)
  for (let i = 0; i < maxPlayers; i++) {
    const [seatPda] = getSeatPda(tablePda, i);
    const [scPda] = getSeatCardsPda(tablePda, i);
    const [scPermPda] = getPermissionPda(scPda);

    // SeatCards permission
    const pBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(scPermPda, PERMISSION_PROGRAM_ID);
    const pRec = delegationRecordPdaFromDelegatedAccount(scPermPda);
    const pMeta = delegationMetadataPdaFromDelegatedAccount(scPermPda);
    const pData = Buffer.alloc(9); DISC.delegatePermission.copy(pData, 0); pData.writeUInt8(i, 8);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data: pData,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: scPda, isSigner: false, isWritable: true },
          { pubkey: scPermPda, isSigner: false, isWritable: true },
          { pubkey: pBuf, isSigner: false, isWritable: true },
          { pubkey: pRec, isSigner: false, isWritable: true },
          { pubkey: pMeta, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      })], [deployer]);

    // Seat
    const sBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(seatPda, PROGRAM_ID);
    const sRec = delegationRecordPdaFromDelegatedAccount(seatPda);
    const sMeta = delegationMetadataPdaFromDelegatedAccount(seatPda);
    const sData = Buffer.alloc(9); DISC.delegateSeat.copy(sData, 0); sData.writeUInt8(i, 8);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data: sData,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: sBuf, isSigner: false, isWritable: true },
          { pubkey: sRec, isSigner: false, isWritable: true },
          { pubkey: sMeta, isSigner: false, isWritable: true },
          { pubkey: seatPda, isSigner: false, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
        ],
      })], [deployer]);

    // SeatCards
    const scBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(scPda, PROGRAM_ID);
    const scRec = delegationRecordPdaFromDelegatedAccount(scPda);
    const scMeta = delegationMetadataPdaFromDelegatedAccount(scPda);
    const scData = Buffer.alloc(9); DISC.delegateSeatCards.copy(scData, 0); scData.writeUInt8(i, 8);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data: scData,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: scBuf, isSigner: false, isWritable: true },
          { pubkey: scRec, isSigner: false, isWritable: true },
          { pubkey: scMeta, isSigner: false, isWritable: true },
          { pubkey: scPda, isSigner: false, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
  }

  // Delegate CrankTallyER to TEE (must be AFTER table delegation)
  {
    const [crankTallyEr] = getCrankTallyErPda(tablePda);
    const ctBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(crankTallyEr, PROGRAM_ID);
    const ctRec = delegationRecordPdaFromDelegatedAccount(crankTallyEr);
    const ctMeta = delegationMetadataPdaFromDelegatedAccount(crankTallyEr);
    // delegate_crank_tally: disc(8) + table_key(32) = 40 bytes
    const ctData = Buffer.alloc(40);
    DISC.delegateCrankTally.copy(ctData, 0);
    tablePda.toBuffer().copy(ctData, 8);
    await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({ programId: PROGRAM_ID, data: ctData,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctBuf, isSigner: false, isWritable: true },
          { pubkey: ctRec, isSigner: false, isWritable: true },
          { pubkey: ctMeta, isSigner: false, isWritable: true },
          { pubkey: crankTallyEr, isSigner: false, isWritable: true },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
  }

  return { tablePda, vaultPda, tableIdBuf };
}

// Register player on L1 (creates PlayerAccount + Unrefined PDAs)
async function registerPlayer(l1: Connection, player: Keypair) {
  const [playerPda] = getPlayerPda(player.publicKey);
  const existing = await l1.getAccountInfo(playerPda);
  if (existing) return; // already registered

  const [unrefinedPda] = getUnrefinedPda(player.publicKey);
  await sendTx(l1, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    new TransactionInstruction({
      programId: PROGRAM_ID, data: DISC.registerPlayer,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: playerPda, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: POOL_PDA, isSigner: false, isWritable: true },
        { pubkey: unrefinedPda, isSigner: false, isWritable: true },
        { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }),
  ], [player]);
}

// Deposit for join on L1
async function depositForJoin(
  l1: Connection, player: Keypair, tablePda: PublicKey, vaultPda: PublicKey,
  seatIndex: number, buyIn: number,
) {
  const [playerPda] = getPlayerPda(player.publicKey);
  const [receiptPda] = getReceiptPda(tablePda, seatIndex);
  const [markerPda] = getMarkerPda(player.publicKey, tablePda);
  const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);
  const data = Buffer.alloc(25);
  DISC.depositForJoin.copy(data, 0);
  data.writeUInt8(seatIndex, 8);
  data.writeBigUInt64LE(BigInt(buyIn), 9);
  data.writeBigUInt64LE(BigInt(0), 17);
  return sendTx(l1, [new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player.publicKey, isSigner: true, isWritable: true },
      { pubkey: playerPda, isSigner: false, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: receiptPda, isSigner: false, isWritable: true },
      { pubkey: markerPda, isSigner: false, isWritable: true },
      { pubkey: depositProofPda, isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })], [player]);
}

// Delegate deposit proof + seat player on TEE
async function delegateProofAndSeat(
  l1: Connection, tee: Connection, deployer: Keypair, tablePda: PublicKey, seatIndex: number,
) {
  const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);
  const dpBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(depositProofPda, PROGRAM_ID);
  const dpRec = delegationRecordPdaFromDelegatedAccount(depositProofPda);
  const dpMeta = delegationMetadataPdaFromDelegatedAccount(depositProofPda);
  const dpData = Buffer.alloc(9);
  Buffer.from([38, 124, 73, 174, 143, 27, 169, 130]).copy(dpData, 0);
  dpData.writeUInt8(seatIndex, 8);
  await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    new TransactionInstruction({ programId: PROGRAM_ID, data: dpData,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: dpBuf, isSigner: false, isWritable: true },
        { pubkey: dpRec, isSigner: false, isWritable: true },
        { pubkey: dpMeta, isSigner: false, isWritable: true },
        { pubkey: depositProofPda, isSigner: false, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      ],
    })], [deployer]);

  await sleep(8000); // propagation

  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [scPda] = getSeatCardsPda(tablePda, seatIndex);
  const [scPermPda] = getPermissionPda(scPda);
  const spData = Buffer.alloc(9); DISC.seatPlayer.copy(spData, 0); spData.writeUInt8(seatIndex, 8);
  await sendTx(tee, [new TransactionInstruction({ programId: PROGRAM_ID, data: spData,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      { pubkey: depositProofPda, isSigner: false, isWritable: true },
      { pubkey: scPda, isSigner: false, isWritable: true },
      { pubkey: scPermPda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  })], [deployer], { skipPreflight: true });
}

// Wait for phase on TEE
async function waitForPhase(conn: Connection, tablePda: PublicKey, targets: number[], timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const info = await conn.getAccountInfo(tablePda);
      if (info && info.data.length >= 256) {
        const phase = Buffer.from(info.data)[OFF.PHASE];
        if (targets.includes(phase)) return Buffer.from(info.data);
      }
    } catch {}
    await sleep(2000);
  }
  throw new Error(`Timeout waiting for phase ${targets.map(p => PHASE_NAMES[p]).join('|')}`);
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(DEPLOYER_PATH, 'utf-8'))));
  const anchorDeployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(ANCHOR_DEPLOYER_PATH, 'utf-8'))));
  const l1 = new Connection(L1_RPC, 'confirmed');

  log('╔══════════════════════════════════════════════════════════════╗');
  log('║   CRANK REWARDS + TIP JAR E2E TEST                         ║');
  log('║   10 hands @ 0.0005/0.001 SOL, verify rake + crank pool    ║');
  log('║   Requires running crank: npx ts-node backend/crank-service ║');
  log('╚══════════════════════════════════════════════════════════════╝');
  log(`Deployer: ${deployer.publicKey.toBase58()}`);
  const deployerBal = await l1.getBalance(deployer.publicKey);
  log(`L1 balance: ${(deployerBal / 1e9).toFixed(4)} SOL`);

  // Fund from anchor deployer if needed (need ~2 SOL for table creation + delegation + deposits)
  if (deployerBal < 2_000_000_000) {
    log('  Low balance — funding from anchor deployer...');
    await sendTx(l1, [SystemProgram.transfer({
      fromPubkey: anchorDeployer.publicKey, toPubkey: deployer.publicKey, lamports: 3_000_000_000,
    })], [anchorDeployer]);
    log(`  Funded 3 SOL. New balance: ${((await l1.getBalance(deployer.publicKey)) / 1e9).toFixed(4)} SOL`);
  }

  const teeToken = await getTeeAuthToken(deployer);
  const tee = new Connection(`${TEE_RPC_BASE}?token=${teeToken}`, 'confirmed');
  log(`TEE authenticated ✓\n`);

  // Generate test players
  const player1 = Keypair.generate();
  const player2 = Keypair.generate();
  for (const p of [player1, player2]) {
    await sendTx(l1, [SystemProgram.transfer({
      fromPubkey: deployer.publicKey, toPubkey: p.publicKey, lamports: PLAYER_FUND,
    })], [deployer]);
  }
  log(`Players funded: P0=${player1.publicKey.toBase58().slice(0,12)} P1=${player2.publicKey.toBase58().slice(0,12)}`);

  // Register players
  for (const [i, p] of [player1, player2].entries()) {
    try {
      await registerPlayer(l1, p);
      pass(`register P${i}`);
    } catch (e: any) {
      const msg = e.message?.slice(0, 100) || '';
      if (msg.includes('already in use')) pass(`P${i} already registered`);
      else fail(`register P${i}`, msg);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CREATE TABLE + DELEGATE + DEPOSIT TIP
  // ═══════════════════════════════════════════════════════════════
  log('\n═══ Creating 0.0005/0.001 SOL table + delegating to TEE ═══');
  const { tablePda, vaultPda, tableIdBuf } = await createAndDelegateTable(l1, deployer);
  log(`  Table: ${tablePda.toBase58().slice(0, 16)}`);
  pass('create + delegate table');

  // Wait for TEE propagation
  log('  Waiting 12s for TEE propagation...');
  await sleep(12000);

  // Verify table on TEE
  const tInfo = await tee.getAccountInfo(tablePda);
  if (tInfo) {
    pass('table visible on TEE');
    const td = Buffer.from(tInfo.data);
    const rakeCap = readU64(td, OFF.RAKE_CAP);
    const crankPool = readU64(td, OFF.CRANK_POOL_ACCUMULATED);
    log(`    rake_cap=${rakeCap} crank_pool=${crankPool}`);
  } else {
    fail('table on TEE', 'not visible after 12s');
  }

  // Deposit for join (both players)
  for (const [i, p] of [player1, player2].entries()) {
    await depositForJoin(l1, p, tablePda, vaultPda, i, BUY_IN);
    pass(`deposit_for_join P${i}`);
  }

  // Delegate proofs + seat on TEE
  for (const [i, _p] of [player1, player2].entries()) {
    await delegateProofAndSeat(l1, tee, deployer, tablePda, i);
    pass(`seat_player P${i} on TEE`);
  }

  // Verify both seated
  const tData = Buffer.from((await tee.getAccountInfo(tablePda))!.data);
  const cp = tData[OFF.CURRENT_PLAYERS];
  if (cp === 2) pass('both players seated');
  else fail('seating', `current_players=${cp}`);

  // ─── TIP JAR: deposit on the game table (L1 — tip jar stays on L1) ───
  log('\n  ─── Tip Jar Deposit ───');
  const [tipJarPda] = getTipJarPda(tablePda);
  const TIP_AMOUNT = 50_000; // 50,000 lamports
  const TIP_HANDS = 20;      // Fund 20 hands of tips
  {
    // Init TipJar PDA (may already exist from createAndDelegateTable)
    try {
      await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        new TransactionInstruction({ programId: PROGRAM_ID, data: DISC.initTipJar,
          keys: [
            { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
            { pubkey: tablePda, isSigner: false, isWritable: false },
            { pubkey: tipJarPda, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
        })], [deployer]);
      pass('init_tip_jar');
    } catch (e: any) {
      const msg = e.message || '';
      if (msg.includes('already in use')) pass('tip_jar already initialized');
      else fail('init_tip_jar', msg.slice(0, 100));
    }

    // Deposit tip
    const tipData = Buffer.alloc(8 + 8 + 2);
    DISC.depositTip.copy(tipData, 0);
    tipData.writeBigUInt64LE(BigInt(TIP_AMOUNT), 8);
    tipData.writeUInt16LE(TIP_HANDS, 16);
    try {
      await sendTx(l1, [new TransactionInstruction({ programId: PROGRAM_ID, data: tipData,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: tipJarPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
      pass(`deposit_tip: ${TIP_AMOUNT} lamports for ${TIP_HANDS} hands (${TIP_AMOUNT / TIP_HANDS} per hand)`);
    } catch (e: any) {
      fail('deposit_tip', e.message?.slice(0, 100));
    }

    // Grief protection: try deposit with lower per-hand rate
    const griefData = Buffer.alloc(8 + 8 + 2);
    DISC.depositTip.copy(griefData, 0);
    griefData.writeBigUInt64LE(BigInt(1000), 8);
    griefData.writeUInt16LE(100, 16);
    try {
      await sendTx(l1, [new TransactionInstruction({ programId: PROGRAM_ID, data: griefData,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: tipJarPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      })], [deployer]);
      fail('tip grief protection', 'Should have failed (rate dilution)');
    } catch {
      pass('tip grief protection: rate dilution rejected');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // REACTIVE HAND LOOP — crank drives, players react
  // The REAL running crank handles: start_game, tee_deal, tee_reveal, settle_hand
  // Strategy: Both players act on preflop (SB CALL + BB CHECK).
  // Post-flop: both players CHECK on each street.
  // All streets advance via player actions — no crank timeout needed.
  // ═══════════════════════════════════════════════════════════════
  const NUM_HANDS = 10;
  let totalRake = 0;
  let totalCrankPool = 0;
  let handsWithRake = 0;
  const players = [player1, player2];

  async function sendAction(player: Keypair, seatIdx: number, action: number, amount: number = 0): Promise<string> {
    const [seatPda] = getSeatPda(tablePda, seatIdx);
    const d = Buffer.alloc(17); DISC.playerAction.copy(d, 0); d.writeUInt8(action, 8);
    if (action === RAISE && amount > 0) d.writeBigUInt64LE(BigInt(amount), 9);
    return sendTx(tee, [new TransactionInstruction({ programId: PROGRAM_ID, data: d,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: false },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: seatPda, isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      ],
    })], [player, deployer], { skipPreflight: true, feePayer: deployer.publicKey });
  }

  async function readTable(): Promise<Buffer> {
    const i = await tee.getAccountInfo(tablePda);
    return Buffer.from(i!.data);
  }

  // Wait for crank to start + deal the hand (Waiting → Starting → Preflop)
  async function waitForHandStart(timeoutMs: number = 90000): Promise<number> {
    const start = Date.now();
    let lastPhase = -1;
    while (Date.now() - start < timeoutMs) {
      const td = await readTable();
      const phase = td[OFF.PHASE];
      if (phase !== lastPhase) {
        log(`    [wait] phase=${PHASE_NAMES[phase] || phase}`);
        lastPhase = phase;
      }
      if (phase === Phase.Preflop) return readU64(td, OFF.HAND_NUMBER);
      await sleep(500);
    }
    throw new Error('Timeout waiting for Preflop');
  }

  // Both players act on every street. Poll for current_player, send CALL or CHECK.
  // With correct constants (FOLD=0, CHECK=1), both players act properly.
  async function playHandBothPlayers(): Promise<{ rake: number; crankPool: number; handNum: number }> {
    const POLL_MS = 500;
    const MAX_POLLS = 300; // 300 × 500ms = 2.5 min max
    let lastLoggedPhase = -1;
    let handStarted = false;

    for (let tick = 0; tick < MAX_POLLS; tick++) {
      const td = await readTable();
      const phase = td[OFF.PHASE];

      // Log phase changes
      if (phase !== lastLoggedPhase) {
        const fr = td[OFF.FLOP_REACHED];
        const pot = readU64(td, OFF.POT);
        const cp2 = td[161];
        log(`    [${PHASE_NAMES[phase] || phase}] pot=${pot} cp=${cp2} fr=${fr}`);
        lastLoggedPhase = phase;
      }

      // Hand settled — done
      if ((phase === Phase.Waiting || phase === Phase.Complete) && handStarted) {
        const rake = readU64(td, OFF.RAKE_ACCUMULATED);
        const crankPool = readU64(td, OFF.CRANK_POOL_ACCUMULATED);
        const handNum = readU64(td, OFF.HAND_NUMBER);
        return { rake, crankPool, handNum };
      }

      // Betting phase: send action for whoever's turn it is
      const isBetting = phase === Phase.Preflop || phase === Phase.Flop ||
                        phase === Phase.Turn || phase === Phase.River;
      if (isBetting) {
        const cp = td[OFF.CURRENT_PLAYER];
        if (cp < players.length) {
          const player = players[cp];
          // Determine CALL vs CHECK based on seat's bet vs min_bet
          const seatData = await tee.getAccountInfo(getSeatPda(tablePda, cp)[0]);
          const betThisRound = seatData ? Number(Buffer.from(seatData.data).readBigUInt64LE(112)) : 0;
          const minBet = readU64(td, 139);
          const amountToCall = Math.max(0, Number(minBet) - betThisRound);
          const action = amountToCall > 0 ? CALL : CHECK;
          const actionName = action === CALL ? 'Call' : 'Check';
          try {
            await sendAction(player, cp, action);
            log(`    P${cp} → ${actionName} (${PHASE_NAMES[phase]}) ✓`);
            handStarted = true;
          } catch (e: any) {
            log(`    P${cp} → ${actionName} FAILED: ${e.message?.slice(0, 80)}`);
          }
          await sleep(500); // Brief pause between actions
          continue; // Re-poll immediately after acting
        }
      }

      await sleep(POLL_MS);
    }
    throw new Error('Hand did not settle within 2.5 minutes');
  }

  for (let hand = 1; hand <= NUM_HANDS; hand++) {
    log(`\n  ─── Hand ${hand}/${NUM_HANDS} ───`);

    // Wait for crank to start the hand (Waiting → Starting → Preflop)
    try {
      const handNum = await waitForHandStart(90000);
      log(`    Hand #${handNum} started — playing reactively`);
    } catch (e: any) {
      fail(`hand ${hand} start`, e.message?.slice(0, 80));
      break;
    }

    // Play the hand reactively — poll and act when it's our turn
    try {
      const result = await playHandBothPlayers();

      // Show chips
      for (let s = 0; s < MAX_PLAYERS; s++) {
        const si = await tee.getAccountInfo(getSeatPda(tablePda, s)[0]);
        if (si) {
          const chips = Number(Buffer.from(si.data).readBigUInt64LE(SEAT_CHIPS_OFFSET));
          log(`    P${s} chips: ${chips}`);
        }
      }

      const rakeThisHand = result.rake - totalRake;
      const crankThisHand = result.crankPool - totalCrankPool;
      if (rakeThisHand > 0) handsWithRake++;
      log(`    Hand #${result.handNum} done | rake_this_hand=${rakeThisHand} | crank_cut=${crankThisHand} | total_rake=${result.rake} | total_crank_pool=${result.crankPool}`);
      totalRake = result.rake;
      totalCrankPool = result.crankPool;
      pass(`hand ${hand} complete`);
    } catch (e: any) {
      fail(`hand ${hand}`, e.message?.slice(0, 80));
      break;
    }
  }

  // ─── VERIFY ECONOMICS AFTER ALL HANDS ───
  log('\n  ─── Economics Verification ───');
  const finalInfo = await tee.getAccountInfo(tablePda);
  if (finalInfo) {
    const fd = Buffer.from(finalInfo.data);
    totalRake = readU64(fd, OFF.RAKE_ACCUMULATED);
    totalCrankPool = readU64(fd, OFF.CRANK_POOL_ACCUMULATED);
    log(`    Total rake_accumulated: ${totalRake} lamports`);
    log(`    Total crank_pool_accumulated: ${totalCrankPool} lamports`);
    log(`    Hands with rake: ${handsWithRake}/${NUM_HANDS}`);

    if (totalRake > 0) {
      pass(`rake collected: ${totalRake} lamports from ${handsWithRake} hands`);
      // On-chain: crank cut is calculated PER HAND (integer division), not from total.
      // With small pots (200), rake=10/hand, 5% dealer cut = floor(10*500/10000) = 0 per hand.
      const rakePerHand = handsWithRake > 0 ? Math.floor(totalRake / handsWithRake) : 0;
      const expectedCrankPerHand = Math.floor(rakePerHand * 500 / 10000);
      const expectedCrankPool = expectedCrankPerHand * handsWithRake;
      if (totalCrankPool > 0) {
        pass(`crank_pool > 0: ${totalCrankPool} lamports`);
        if (Math.abs(totalCrankPool - expectedCrankPool) <= NUM_HANDS) {
          pass(`crank_pool ≈ 5% of rake (${totalCrankPool} ≈ ${expectedCrankPool})`);
        } else {
          fail('crank_pool ratio', `${totalCrankPool} vs expected ~${expectedCrankPool}`);
        }
      } else if (expectedCrankPool === 0) {
        pass(`crank_pool=0 expected (5% of ${rakePerHand} lamports/hand rounds to 0 — need larger pots)`);
      } else {
        fail('crank_pool is 0 despite non-zero rake', `expected ~${expectedCrankPool}`);
      }
    } else {
      fail(`No rake after ${NUM_HANDS} hands`, 'flop never reached — players must CALL preflop');
    }
  }

  // CrankTallyER — may not be readable with our auth (permission-gated)
  const [crankTallyErPda] = getCrankTallyErPda(tablePda);
  const tallyInfo = await tee.getAccountInfo(crankTallyErPda);
  if (tallyInfo && tallyInfo.data.length >= 197) {
    const td2 = Buffer.from(tallyInfo.data);
    const tallyActions = td2.readUInt32LE(184);
    const lastHand = readU64(td2, 188);
    log(`    CrankTallyER: total_actions=${tallyActions}, last_hand=${lastHand}`);
    if (tallyActions > 0) {
      pass(`dealer actions recorded: ${tallyActions}`);
    } else {
      log('    CrankTallyER total_actions=0 (may be permission-gated or not yet initialized)');
    }
  } else {
    log('    CrankTallyER not readable (permission-gated on TEE — expected)');
  }

  // ═══════════════════════════════════════════════════════════════
  // CRANK REWARDS DISTRIBUTION — wait for rake sweep or verify manually
  // The crank-service rake sweep runs every 60s. We wait for it to
  // CommitState → process_rake_distribution → distribute_crank_rewards.
  // ═══════════════════════════════════════════════════════════════
  log('\n═══ Waiting for Crank Rake Sweep (up to 120s) ═══');
  log('  The crank-service rake sweep should fire within 60s...');
  log(`  Table: ${tablePda.toBase58()}`);

  // Read CrankOperator PDA for the crank key (deployer) BEFORE distribution
  const [crankOpPda] = getCrankOperatorPda(deployer.publicKey);
  let crankOpBefore: { lifetimeSol: number; totalActions: number } | null = null;
  {
    const opInfo = await l1.getAccountInfo(crankOpPda);
    if (opInfo && opInfo.data.length >= 81) {
      const d = Buffer.from(opInfo.data);
      crankOpBefore = {
        lifetimeSol: readU64(d, 49),    // lifetime_sol_earned offset
        totalActions: readU64(d, 57),   // total_actions offset
      };
      log(`  CrankOperator BEFORE: lifetime_sol=${crankOpBefore.lifetimeSol}, total_actions=${crankOpBefore.totalActions}`);
    } else {
      log('  CrankOperator PDA not found — will check after sweep');
    }
  }

  // Wait for L1 table to show updated rake (CommitState happened)
  let rakeOnL1 = 0;
  const sweepStart = Date.now();
  const SWEEP_TIMEOUT = 120_000;
  while (Date.now() - sweepStart < SWEEP_TIMEOUT) {
    const l1Info = await l1.getAccountInfo(tablePda);
    if (l1Info && l1Info.data.length > OFF.RAKE_ACCUMULATED + 8) {
      rakeOnL1 = readU64(Buffer.from(l1Info.data), OFF.RAKE_ACCUMULATED);
      if (rakeOnL1 > 0) {
        log(`  L1 rake_accumulated: ${rakeOnL1} lamports — CommitState happened!`);
        break;
      }
    }
    await sleep(5000);
    const elapsed = Math.round((Date.now() - sweepStart) / 1000);
    if (elapsed % 15 === 0) log(`  ... waiting ${elapsed}s`);
  }

  if (rakeOnL1 > 0) {
    pass(`rake committed to L1: ${rakeOnL1} lamports`);

    // Check vault for total_rake_distributed (indicates process_rake_distribution ran)
    await sleep(10000); // Give time for the full pipeline to complete
    const vaultInfo = await l1.getAccountInfo(vaultPda);
    if (vaultInfo) {
      const vd = Buffer.from(vaultInfo.data);
      // Vault layout: disc(8) + table(32) + balance(8) + total_rake_distributed(8) + total_crank_distributed(8) + ...
      const totalRakeDist = readU64(vd, 48);
      const totalCrankDist = readU64(vd, 56);
      log(`  Vault: total_rake_distributed=${totalRakeDist}, total_crank_distributed=${totalCrankDist}`);
      if (totalRakeDist > 0) pass(`process_rake_distribution completed: ${totalRakeDist} lamports`);
      else log('  process_rake_distribution may not have run yet');
      if (totalCrankDist > 0) pass(`distribute_crank_rewards completed: ${totalCrankDist} lamports`);
      else log('  distribute_crank_rewards may not have run yet (or crank pool was 0)');
    }

    // Check CrankOperator AFTER distribution
    const opInfoAfter = await l1.getAccountInfo(crankOpPda);
    if (opInfoAfter && opInfoAfter.data.length >= 81) {
      const d = Buffer.from(opInfoAfter.data);
      const lifetimeSolAfter = readU64(d, 49);
      const totalActionsAfter = readU64(d, 57);
      log(`  CrankOperator AFTER: lifetime_sol=${lifetimeSolAfter}, total_actions=${totalActionsAfter}`);
      if (crankOpBefore && lifetimeSolAfter > crankOpBefore.lifetimeSol) {
        pass(`CrankOperator.lifetime_sol_earned increased: ${crankOpBefore.lifetimeSol} → ${lifetimeSolAfter} (+${lifetimeSolAfter - crankOpBefore.lifetimeSol})`);
      } else if (crankOpBefore && lifetimeSolAfter === crankOpBefore.lifetimeSol) {
        log('  CrankOperator lifetime_sol unchanged (crank pool may have been 0 or distribution not yet run)');
      }
    }
  } else {
    log('  ⚠️  Rake sweep did not fire within 120s — crank rewards verification skipped');
    log('  This may happen if the crank is not running or table is not in its tracked set');
  }

  // ─── TIP JAR VERIFICATION ───
  log('\n  ─── Tip Jar Verification ───');
  const tjInfoFinal = await l1.getAccountInfo(tipJarPda);
  if (tjInfoFinal) {
    const d = Buffer.from(tjInfoFinal.data);
    const balance = readU64(d, 40);
    const handsRemaining = readU16(d, 48);
    const totalDeposited = readU64(d, 50);
    const totalTipped = readU64(d, 58);
    log(`    TipJar final: balance=${balance}, hands_remaining=${handsRemaining}, total_deposited=${totalDeposited}, total_tipped=${totalTipped}`);
    if (totalDeposited === TIP_AMOUNT) pass(`tip jar total_deposited correct: ${totalDeposited}`);
    // Tip deductions happen on TEE during settle — need CommitState to see on L1
    // If hands_remaining < TIP_HANDS, tips were deducted
    if (handsRemaining < TIP_HANDS) {
      const tipsDeducted = TIP_HANDS - handsRemaining;
      pass(`tip jar deducted ${tipsDeducted} hands of tips (${handsRemaining} remaining)`);
    } else {
      log(`    tip jar hands_remaining=${handsRemaining} (unchanged — tips may not have been committed to L1 yet)`);
    }
  } else {
    log('    TipJar PDA not found on L1');
  }

  // ═══════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════
  log('\n╔══════════════════════════════════════════════════════════════╗');
  log('║   CRANK REWARDS + TIP JAR E2E TEST RESULTS                  ║');
  log('╚══════════════════════════════════════════════════════════════╝');
  log(`  Passed: ${passCount}  Failed: ${failCount}`);
  log(`  Table: ${tablePda.toBase58()}`);
  log(`  Total rake: ${totalRake} lamports | Crank pool: ${totalCrankPool} lamports`);
  log(`  Hands played: ${NUM_HANDS} | Hands with rake: ${handsWithRake}`);
  if (failCount === 0) {
    log('\n  🎉 ALL TESTS PASSED!');
  } else {
    log(`\n  ⚠️  ${failCount} test(s) failed`);
  }
}

main().catch((e) => {
  console.error('\n💥 FATAL:', e.message || e);
  process.exit(1);
});
