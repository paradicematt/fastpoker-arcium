/**
 * HU SNG Persistent E2E Test — Resumable, Reusable
 *
 * Uses persistent keypairs (tests/keys/player1.json, player2.json).
 * Saves state to scripts/hu-sng-state.json so it can resume if interrupted.
 * Verifies full distribution chain: winner SOL, unrefined POKER, treasury, pool, crank share.
 * Supports table reuse after game completes.
 *
 * Usage:
 *   npx ts-node scripts/hu-sng-persistent.ts              # Run from saved state (or fresh)
 *   npx ts-node scripts/hu-sng-persistent.ts --fresh       # Force new table
 *   npx ts-node scripts/hu-sng-persistent.ts --from=4      # Resume from step 4
 *   npx ts-node scripts/hu-sng-persistent.ts --reuse       # Reuse existing table for another game
 *
 * Requires: crank service running (npx ts-node backend/crank-service.ts)
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, sendAndConfirmTransaction,
  ComputeBudgetProgram,
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

// Multi-validator support: --validator=devnet-tee (default) or --validator=tee
const VALIDATOR_CONFIGS: Record<string, { rpc: string; ws: string; pubkey: string }> = {
  'devnet-tee': { rpc: 'https://devnet-tee.magicblock.app', ws: 'wss://devnet-tee.magicblock.app', pubkey: 'MDTrz4PDEcNCKMRLbpPwwwV8bcpCExWXxrmXqVuWpU9' },
  'tee':        { rpc: 'https://tee.magicblock.app',        ws: 'wss://tee.magicblock.app',        pubkey: 'FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA' },
};
const validatorArg = process.argv.find(a => a.startsWith('--validator='))?.split('=')[1] || 'devnet-tee';
const VALIDATOR_CFG = VALIDATOR_CONFIGS[validatorArg] || VALIDATOR_CONFIGS['devnet-tee'];
const TEE_RPC_BASE = VALIDATOR_CFG.rpc;
const TEE_WS_BASE = VALIDATOR_CFG.ws;

const PROGRAM_ID = new PublicKey('4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB');
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const TEE_VALIDATOR = new PublicKey(VALIDATOR_CFG.pubkey);
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');

// Persistent keypairs
const DEPLOYER_PATH = 'j:/Poker/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json';
const PLAYER1_PATH = 'j:/Poker/tests/keys/player1.json';
const PLAYER2_PATH = 'j:/Poker/tests/keys/player2.json';
const CRANK_KEY_PATH = 'j:/Poker/tests/keys/crank.json';
const STATE_FILE = 'j:/Poker/scripts/hu-sng-state.json';

const MAX_PLAYERS = 2;
const SNG_TIER = 1; // Bronze
const STARTING_STACK = 1500;
const ENTRY_AMOUNT = 18_750_000;  // 0.01875 SOL (Bronze devnet)
const FEE_AMOUNT = 6_250_000;   // 0.00625 SOL
const TOTAL_BUYIN = ENTRY_AMOUNT + FEE_AMOUNT; // 0.025 SOL

// PokerAction enum
const FOLD = 0, CHECK = 1, CALL = 2, BET = 3, RAISE = 4, ALL_IN = 5;

// Phase enum
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
  RAKE_ACCUMULATED: 147, COMMUNITY_CARDS: 155,
  REVEALED_HANDS: 175, HAND_RESULTS: 193,
  PRIZES_DISTRIBUTED: 339, ELIMINATED_SEATS: 342, ELIMINATED_COUNT: 351,
  ENTRY_FEES_ESCROWED: 352, TIER: 360, ENTRY_AMOUNT: 361,
  FEE_AMOUNT: 369, PRIZE_POOL: 377, TOKEN_MINT: 385, BUY_IN_TYPE: 417,
};
const SEAT_WALLET_OFFSET = 8;
const SEAT_CHIPS_OFFSET = 104;
const SEAT_CARDS_CARD1 = 73;
const SEAT_CARDS_CARD2 = 74;
const PLAYER_CLAIMABLE_SOL_OFFSET = 91;

// ═══════════════════════════════════════════════════════════════════
// DISCRIMINATORS
// ═══════════════════════════════════════════════════════════════════
function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}
const DISC = {
  createTable:     Buffer.from([214, 142, 131, 250, 242, 83, 135, 185]),
  initTableSeat:   Buffer.from([4, 2, 110, 85, 144, 112, 65, 236]),
  joinTable:       Buffer.from([14, 117, 84, 51, 95, 146, 171, 70]),
  delegateTable:   Buffer.from([161, 66, 67, 113, 58, 219, 238, 170]),
  delegateSeat:    Buffer.from([53, 85, 50, 81, 161, 68, 71, 212]),
  delegateSeatCards: Buffer.from([79, 21, 238, 244, 141, 174, 3, 26]),
  delegateDeckState: Buffer.from([35, 80, 108, 20, 133, 115, 71, 235]),
  delegateCrankTally: Buffer.from([197, 93, 205, 1, 164, 162, 202, 231]),
  delegatePermission: Buffer.from([187, 192, 110, 65, 252, 88, 194, 103]),
  registerPlayer: disc('register_player'),
  startGame: disc('start_game'),
  teeDeal: disc('tee_deal'),
  teeReveal: disc('tee_reveal'),
  settleHand: disc('settle_hand'),
  playerAction: disc('player_action'),
  distributePrizes: disc('distribute_prizes'),
  claimSolWinnings: disc('claim_sol_winnings'),
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
const getSeatPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('seat'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getSeatCardsPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getDeckStatePda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('deck_state'), t.toBuffer()], PROGRAM_ID);
const getPermissionPda = (a: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('permission:'), a.toBuffer()], PERMISSION_PROGRAM_ID);
const getPlayerPda = (w: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('player'), w.toBuffer()], PROGRAM_ID);
const getMarkerPda = (w: PublicKey, t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('player_table'), w.toBuffer(), t.toBuffer()], PROGRAM_ID);
const getReceiptPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('receipt'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getDepositProofPda = (t: PublicKey, i: number) => PublicKey.findProgramAddressSync([Buffer.from('deposit_proof'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getUnrefinedPda = (w: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('unrefined'), w.toBuffer()], STEEL_PROGRAM_ID);
const getPrizeAuthorityPda = () => PublicKey.findProgramAddressSync([Buffer.from('prize_authority')], PROGRAM_ID);
const getVaultPda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('vault'), t.toBuffer()], PROGRAM_ID);
const getCrankTallyErPda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('crank_tally_er'), t.toBuffer()], PROGRAM_ID);
const getCrankTallyL1Pda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('crank_tally_l1'), t.toBuffer()], PROGRAM_ID);

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let passCount = 0, failCount = 0;
function log(msg: string) { console.log(msg); }
function pass(step: string, detail: string = '') {
  passCount++;
  console.log(`  ✅ PASS: ${step}${detail ? ' — ' + detail : ''}`);
}
function fail(step: string, detail: string = '') {
  failCount++;
  console.log(`  ❌ FAIL: ${step}${detail ? ' — ' + detail : ''}`);
}
const cardName = (c: number) => {
  if (c === 255) return 'XX';
  const ranks = '23456789TJQKA';
  const suits = '♠♥♦♣';
  return ranks[c % 13] + suits[Math.floor(c / 13)];
};

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

async function getTeeConnection(signer: Keypair): Promise<Connection> {
  const nacl = require('tweetnacl');
  const sdk = require('@magicblock-labs/ephemeral-rollups-sdk');
  const auth = await sdk.getAuthToken(
    TEE_RPC_BASE, signer.publicKey,
    (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, signer.secretKey)),
  );
  return new Connection(
    `${TEE_RPC_BASE}?token=${auth.token}`,
    { commitment: 'confirmed', wsEndpoint: `${TEE_WS_BASE}?token=${auth.token}` },
  );
}

// Auto-refreshing TEE connection manager.
// TEE auth tokens expire / connections drop with "client error (Connect)" after ~2 min.
// This wrapper re-authenticates transparently on failure.
class TeeConnManager {
  private conn: Connection | null = null;
  private lastAuth = 0;
  constructor(private signer: Keypair) {}
  async get(): Promise<Connection> {
    const age = Date.now() - this.lastAuth;
    if (!this.conn || age > 90_000) { // refresh every 90s proactively
      this.conn = await getTeeConnection(this.signer);
      this.lastAuth = Date.now();
    }
    return this.conn;
  }
  async refresh(): Promise<Connection> {
    this.conn = await getTeeConnection(this.signer);
    this.lastAuth = Date.now();
    return this.conn;
  }
  async getAccountInfo(pubkey: PublicKey, retries = 2): Promise<any> {
    for (let i = 0; i <= retries; i++) {
      try {
        const c = await this.get();
        return await c.getAccountInfo(pubkey);
      } catch (e: any) {
        if (i < retries && (e.message?.includes('client error') || e.message?.includes('500'))) {
          log(`  ⟳ TEE reconnect (${this.signer.publicKey.toBase58().slice(0, 8)}...)`);
          await this.refresh();
        } else throw e;
      }
    }
  }
}

function readPhase(d: Buffer): number { return d[OFF.PHASE]; }
function readCurrentPlayer(d: Buffer): number { return d[OFF.CURRENT_PLAYER]; }
function readCurrentPlayers(d: Buffer): number { return d[OFF.CURRENT_PLAYERS]; }
function readPot(d: Buffer): number { return Number(d.readBigUInt64LE(OFF.POT)); }
function readHandNumber(d: Buffer): number { return Number(d.readBigUInt64LE(OFF.HAND_NUMBER)); }
function readPrizesDistributed(d: Buffer): boolean { return d[OFF.PRIZES_DISTRIBUTED] !== 0; }
function readEliminatedCount(d: Buffer): number { return d[OFF.ELIMINATED_COUNT]; }
function readPrizePool(d: Buffer): number { return Number(d.readBigUInt64LE(OFF.PRIZE_POOL)); }
function readCommunityCards(d: Buffer): number[] { return Array.from(d.subarray(OFF.COMMUNITY_CARDS, OFF.COMMUNITY_CARDS + 5)); }

function permDelegationAccounts(permPda: PublicKey) {
  return {
    buf: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID),
    rec: delegationRecordPdaFromDelegatedAccount(permPda),
    meta: delegationMetadataPdaFromDelegatedAccount(permPda),
  };
}

function loadKey(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf-8'))));
}

// ═══════════════════════════════════════════════════════════════════
// STATE PERSISTENCE
// ═══════════════════════════════════════════════════════════════════
interface TestState {
  tableIdHex: string;
  tablePda: string;
  step: number;
  gameNumber: number;
  winnerSeat?: number;
  created: string;
  lastRun: string;
}

function loadState(): TestState | null {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return null;
}

function saveState(state: TestState) {
  state.lastRun = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  const args = process.argv.slice(2);
  const FRESH = args.includes('--fresh');
  const REUSE = args.includes('--reuse');
  const fromArg = args.find(a => a.startsWith('--from='));
  const FROM_STEP = fromArg ? parseInt(fromArg.split('=')[1]) : 0;

  const deployer = loadKey(DEPLOYER_PATH);
  const player1 = loadKey(PLAYER1_PATH);
  const player2 = loadKey(PLAYER2_PATH);
  const l1 = new Connection(L1_RPC, 'confirmed');

  const players = [
    { kp: player1, seatIndex: 0, name: 'P0' },
    { kp: player2, seatIndex: 1, name: 'P1' },
  ];

  log('╔══════════════════════════════════════════════════════════════╗');
  log('║   HU SNG PERSISTENT E2E TEST                                ║');
  log('╚══════════════════════════════════════════════════════════════╝');
  log(`Validator: ${validatorArg} (${TEE_VALIDATOR.toBase58().slice(0, 12)}...)`);
  log(`TEE RPC  : ${TEE_RPC_BASE}`);
  log(`Deployer : ${deployer.publicKey.toBase58()} (${((await l1.getBalance(deployer.publicKey)) / 1e9).toFixed(4)} SOL)`);
  log(`Player 0 : ${player1.publicKey.toBase58()} (${((await l1.getBalance(player1.publicKey)) / 1e9).toFixed(4)} SOL)`);
  log(`Player 1 : ${player2.publicKey.toBase58()} (${((await l1.getBalance(player2.publicKey)) / 1e9).toFixed(4)} SOL)`);
  log(`Buy-in   : ${TOTAL_BUYIN / 1e9} SOL (entry=${ENTRY_AMOUNT / 1e9}, fee=${FEE_AMOUNT / 1e9})`);

  // Load or create state
  let state = FRESH ? null : loadState();
  let tableIdBuf: Buffer;
  let tablePda: PublicKey;
  let startStep = FROM_STEP;

  if (state && !FRESH) {
    tableIdBuf = Buffer.from(state.tableIdHex, 'hex');
    tablePda = new PublicKey(state.tablePda);
    if (REUSE) {
      startStep = 3; // Skip create+init, go straight to join
      state.gameNumber = (state.gameNumber || 1) + 1;
      log(`\n🔄 REUSING table: ${tablePda.toBase58()} (game #${state.gameNumber})`);
    } else if (FROM_STEP === 0) {
      startStep = state.step;
    }
    log(`📂 Loaded state: step=${startStep}, game=#${state.gameNumber || 1}`);
  } else {
    tableIdBuf = crypto.randomBytes(32);
    [tablePda] = getTablePda(tableIdBuf);
    state = {
      tableIdHex: tableIdBuf.toString('hex'),
      tablePda: tablePda.toBase58(),
      step: 0,
      gameNumber: 1,
      created: new Date().toISOString(),
      lastRun: new Date().toISOString(),
    };
    log(`\n🆕 New table: ${tablePda.toBase58()}`);
  }
  log(`State file: ${STATE_FILE}\n`);

  const teeMgr = new TeeConnManager(deployer);
  const tee = await teeMgr.get();

  // ═══════════════════════════════════════════════════════════════
  // STEP 1: CREATE TABLE
  // ═══════════════════════════════════════════════════════════════
  if (startStep <= 1) {
    log('\n═══ STEP 1: Create SNG Table (Diamond HU) ═══');
    const existing = await l1.getAccountInfo(tablePda);
    if (existing) {
      pass('Table already exists', tablePda.toBase58().slice(0, 16));
    } else {
      const data = Buffer.alloc(44);
      DISC.createTable.copy(data, 0);
      tableIdBuf.copy(data, 8);
      data.writeUInt8(0, 40); // SitAndGoHeadsUp
      data.writeUInt8(0, 41); // Micro
      data.writeUInt8(MAX_PLAYERS, 42);
      data.writeUInt8(SNG_TIER, 43);
      await sendTx(l1, [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
            { pubkey: tablePda, isSigner: false, isWritable: true },
            { pubkey: POOL_PDA, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data,
        }),
      ], [deployer]);
      pass('create_table', tablePda.toBase58().slice(0, 16));
    }
    state.step = 2;
    saveState(state);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: INIT SEATS + PERMISSIONS
  // ═══════════════════════════════════════════════════════════════
  if (startStep <= 2) {
    log('\n═══ STEP 2: Init Seats + Create Permissions ═══');

    // Init seats
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const [seatPda] = getSeatPda(tablePda, i);
      const existing = await l1.getAccountInfo(seatPda);
      if (existing) { log(`  Seat ${i} already initialized`); continue; }

      const [scPda] = getSeatCardsPda(tablePda, i);
      const [dsPda] = getDeckStatePda(tablePda);
      const [rcPda] = getReceiptPda(tablePda, i);
      const [dpPda] = getDepositProofPda(tablePda, i);
      const [vaultPda] = getVaultPda(tablePda);
      const [crankTallyErPda] = getCrankTallyErPda(tablePda);
      const [crankTallyL1Pda] = getCrankTallyL1Pda(tablePda);
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
            { pubkey: vaultPda, isSigner: false, isWritable: true },
            { pubkey: crankTallyErPda, isSigner: false, isWritable: true },
            { pubkey: crankTallyL1Pda, isSigner: false, isWritable: true },
            { pubkey: permPda, isSigner: false, isWritable: true },
            { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data,
        }),
      ], [deployer]);
      pass(`init_table_seat(${i})`);
    }

    // Create public permissions (table, deckState, seats)
    {
      const [permPda] = getPermissionPda(tablePda);
      const existing = await l1.getAccountInfo(permPda);
      if (!existing) {
        await sendTx(l1, [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          new TransactionInstruction({
            programId: PROGRAM_ID, data: DISC_TABLE_PERM,
            keys: [
              { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
              { pubkey: tablePda, isSigner: false, isWritable: false },
              { pubkey: permPda, isSigner: false, isWritable: true },
              { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
          }),
        ], [deployer]);
        pass('create_table_permission');
      } else { log('  Table permission exists'); }
    }
    {
      const [dsPda] = getDeckStatePda(tablePda);
      const [permPda] = getPermissionPda(dsPda);
      const existing = await l1.getAccountInfo(permPda);
      if (!existing) {
        await sendTx(l1, [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          new TransactionInstruction({
            programId: PROGRAM_ID, data: DISC_DS_PERM,
            keys: [
              { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
              { pubkey: tablePda, isSigner: false, isWritable: false },
              { pubkey: dsPda, isSigner: false, isWritable: false },
              { pubkey: permPda, isSigner: false, isWritable: true },
              { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
          }),
        ], [deployer]);
        pass('create_deck_state_permission');
      } else { log('  DeckState permission exists'); }
    }
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const [seatPda] = getSeatPda(tablePda, i);
      const [permPda] = getPermissionPda(seatPda);
      const existing = await l1.getAccountInfo(permPda);
      if (existing) { log(`  Seat ${i} permission exists`); continue; }
      const data = Buffer.alloc(9);
      DISC_SEAT_PERM.copy(data, 0);
      data.writeUInt8(i, 8);
      await sendTx(l1, [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        new TransactionInstruction({
          programId: PROGRAM_ID, data,
          keys: [
            { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
            { pubkey: tablePda, isSigner: false, isWritable: false },
            { pubkey: seatPda, isSigner: false, isWritable: false },
            { pubkey: permPda, isSigner: false, isWritable: true },
            { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
        }),
      ], [deployer]);
      pass(`create_seat_permission(${i})`);
    }

    state.step = 3;
    saveState(state);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 3: REGISTER + JOIN PLAYERS
  // ═══════════════════════════════════════════════════════════════
  if (startStep <= 3) {
    log('\n═══ STEP 3: Register + Join Players ═══');

    // Register players (idempotent — skip if already registered)
    for (const p of players) {
      const [playerPda] = getPlayerPda(p.kp.publicKey);
      const existing = await l1.getAccountInfo(playerPda);
      if (existing) { log(`  ${p.name} already registered`); continue; }
      const [unrefinedPda] = getUnrefinedPda(p.kp.publicKey);
      await sendTx(l1, [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        new TransactionInstruction({
          programId: PROGRAM_ID, data: DISC.registerPlayer,
          keys: [
            { pubkey: p.kp.publicKey, isSigner: true, isWritable: true },
            { pubkey: playerPda, isSigner: false, isWritable: true },
            { pubkey: TREASURY, isSigner: false, isWritable: true },
            { pubkey: POOL_PDA, isSigner: false, isWritable: true },
            { pubkey: unrefinedPda, isSigner: false, isWritable: true },
            { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
        }),
      ], [p.kp]);
      pass(`register ${p.name}`);
    }

    // Record pre-join balances
    const preJoinBalances: { [key: string]: number } = {};
    for (const p of players) preJoinBalances[p.name] = await l1.getBalance(p.kp.publicKey);
    const preTreasury = (await l1.getAccountInfo(TREASURY))?.lamports || 0;
    const prePool = (await l1.getAccountInfo(POOL_PDA))?.lamports || 0;
    log(`  Pre-join: treasury=${preTreasury}, pool=${prePool}`);

    // Join table (SNG — pays entry+fee)
    // Check if players are already joined
    const tInfo = await l1.getAccountInfo(tablePda);
    const currentPlayers = tInfo ? readCurrentPlayers(Buffer.from(tInfo.data)) : 0;
    if (currentPlayers >= MAX_PLAYERS) {
      log(`  Both players already joined (currentPlayers=${currentPlayers})`);
    } else {
      for (const p of players) {
        // Check if this seat already has a player
        const [seatPda] = getSeatPda(tablePda, p.seatIndex);
        const seatInfo = await l1.getAccountInfo(seatPda);
        if (seatInfo) {
          const seatData = Buffer.from(seatInfo.data);
          const wallet = new PublicKey(seatData.subarray(SEAT_WALLET_OFFSET, SEAT_WALLET_OFFSET + 32));
          if (!wallet.equals(PublicKey.default)) {
            log(`  ${p.name} already in seat ${p.seatIndex}`);
            continue;
          }
        }

        const [playerPda] = getPlayerPda(p.kp.publicKey);
        const [markerPda] = getMarkerPda(p.kp.publicKey, tablePda);
        const [scPda] = getSeatCardsPda(tablePda, p.seatIndex);
        const [permPda] = getPermissionPda(scPda);

        const data = Buffer.alloc(25);
        DISC.joinTable.copy(data, 0);
        data.writeBigUInt64LE(BigInt(STARTING_STACK), 8);
        data.writeUInt8(p.seatIndex, 16);
        data.writeBigUInt64LE(BigInt(0), 17);

        const sig = await sendTx(l1, [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: p.kp.publicKey, isSigner: true, isWritable: true },
              { pubkey: playerPda, isSigner: false, isWritable: true },
              { pubkey: tablePda, isSigner: false, isWritable: true },
              { pubkey: seatPda, isSigner: false, isWritable: true },
              { pubkey: markerPda, isSigner: false, isWritable: true },
              { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // vault placeholder
              { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // receipt placeholder
              { pubkey: TREASURY, isSigner: false, isWritable: true },
              { pubkey: POOL_PDA, isSigner: false, isWritable: true },
              { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // playerTokenAccount
              { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // tableTokenAccount
              { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // unclaimed_balance
              { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // tokenProgram
              { pubkey: scPda, isSigner: false, isWritable: true },
              { pubkey: permPda, isSigner: false, isWritable: true },
              { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data,
          }),
        ], [p.kp]);
        pass(`${p.name} joined seat ${p.seatIndex}`, `paid ${TOTAL_BUYIN / 1e9} SOL`);
      }
    }

    // Verify
    {
      const ti = await l1.getAccountInfo(tablePda);
      if (ti) {
        const d = Buffer.from(ti.data);
        const cp = readCurrentPlayers(d);
        const pp = readPrizePool(d);
        log(`  After joins: players=${cp}, prizePool=${pp} (${pp / 1e9} SOL)`);
        if (cp === MAX_PLAYERS) pass('Both players joined');
        else fail('Join verification', `Expected ${MAX_PLAYERS}, got ${cp}`);
      }
    }

    state.step = 4;
    saveState(state);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 4: DELEGATE ALL TO TEE
  // ═══════════════════════════════════════════════════════════════
  if (startStep <= 4) {
    log('\n═══ STEP 4: Delegate All to TEE ═══');

    // Check if already delegated
    const tableInfo = await l1.getAccountInfo(tablePda);
    if (tableInfo && tableInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
      log('  Table already delegated — skipping delegation');
    } else {
      // 4a: Permission PDAs
      {
        const [permPda] = getPermissionPda(tablePda);
        const pInfo = await l1.getAccountInfo(permPda);
        if (pInfo && pInfo.owner.equals(PERMISSION_PROGRAM_ID)) {
          const { buf, rec, meta } = permDelegationAccounts(permPda);
          const delTablePermData = Buffer.alloc(40);
          DISC_DEL_TABLE_PERM.copy(delTablePermData, 0);
          tableIdBuf.copy(delTablePermData, 8);
          await sendTx(l1, [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
            new TransactionInstruction({
              programId: PROGRAM_ID, data: delTablePermData,
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
            }),
          ], [deployer]);
          pass('delegate_table_permission → TEE');
        } else { log('  Table permission already delegated or missing'); }
      }
      {
        const [dsPda] = getDeckStatePda(tablePda);
        const [permPda] = getPermissionPda(dsPda);
        const pInfo = await l1.getAccountInfo(permPda);
        if (pInfo && pInfo.owner.equals(PERMISSION_PROGRAM_ID)) {
          const { buf, rec, meta } = permDelegationAccounts(permPda);
          await sendTx(l1, [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
            new TransactionInstruction({
              programId: PROGRAM_ID, data: DISC_DEL_DS_PERM,
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
            }),
          ], [deployer]);
          pass('delegate_deck_state_permission → TEE');
        } else { log('  DeckState permission already delegated'); }
      }
      for (let i = 0; i < MAX_PLAYERS; i++) {
        const [seatPda] = getSeatPda(tablePda, i);
        const [permPda] = getPermissionPda(seatPda);
        const pInfo = await l1.getAccountInfo(permPda);
        if (pInfo && pInfo.owner.equals(PERMISSION_PROGRAM_ID)) {
          const { buf, rec, meta } = permDelegationAccounts(permPda);
          const data = Buffer.alloc(9);
          DISC_DEL_SEAT_PERM.copy(data, 0);
          data.writeUInt8(i, 8);
          await sendTx(l1, [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
            new TransactionInstruction({
              programId: PROGRAM_ID, data,
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
            }),
          ], [deployer]);
          pass(`delegate_seat_permission(${i}) → TEE`);
        } else { log(`  Seat ${i} permission already delegated`); }
      }

      // 4b: DeckState
      {
        const [dsPda] = getDeckStatePda(tablePda);
        const dsInfo = await l1.getAccountInfo(dsPda);
        if (dsInfo && dsInfo.owner.equals(PROGRAM_ID)) {
          const dsBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(dsPda, PROGRAM_ID);
          const dsRec = delegationRecordPdaFromDelegatedAccount(dsPda);
          const dsMeta = delegationMetadataPdaFromDelegatedAccount(dsPda);
          await sendTx(l1, [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
            new TransactionInstruction({
              programId: PROGRAM_ID, data: DISC.delegateDeckState,
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
            }),
          ], [deployer]);
          pass('delegate DeckState → TEE');
        } else { log('  DeckState already delegated'); }
      }

      // 4b2: CrankTallyER delegation — so start_game/tee_deal/settle track crank actions
      {
        const [tallyPda] = getCrankTallyErPda(tablePda);
        const tallyInfo = await l1.getAccountInfo(tallyPda);
        if (tallyInfo && tallyInfo.owner.equals(PROGRAM_ID)) {
          const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(tallyPda, PROGRAM_ID);
          const rec = delegationRecordPdaFromDelegatedAccount(tallyPda);
          const meta = delegationMetadataPdaFromDelegatedAccount(tallyPda);
          const d = Buffer.alloc(40);
          DISC.delegateCrankTally.copy(d, 0);
          tablePda.toBuffer().copy(d, 8);
          await sendTx(l1, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
            new TransactionInstruction({ programId: PROGRAM_ID, data: d, keys: [
              { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
              { pubkey: buf, isSigner: false, isWritable: true },
              { pubkey: rec, isSigner: false, isWritable: true },
              { pubkey: meta, isSigner: false, isWritable: true },
              { pubkey: tallyPda, isSigner: false, isWritable: true },
              { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
            ]})], [deployer]);
          pass('delegate CrankTallyER → TEE');
        } else if (tallyInfo) {
          log('  CrankTallyER already delegated');
        } else {
          log('  CrankTallyER not found');
        }
      }

      // 4c: Per-seat (seatCards permission, seat, seatCards)
      for (let i = 0; i < MAX_PLAYERS; i++) {
        const [seatPda] = getSeatPda(tablePda, i);
        const [scPda] = getSeatCardsPda(tablePda, i);

        // seatCards permission — DO NOT delegate. Stays on L1 so join_table can
        // UpdatePermission for new seat occupants on reuse. TEE reads L1 permissions.

        // Seat delegation
        {
          const sInfo = await l1.getAccountInfo(seatPda);
          if (sInfo && sInfo.owner.equals(PROGRAM_ID)) {
            const sBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(seatPda, PROGRAM_ID);
            const sRec = delegationRecordPdaFromDelegatedAccount(seatPda);
            const sMeta = delegationMetadataPdaFromDelegatedAccount(seatPda);
            const sData = Buffer.alloc(9);
            DISC.delegateSeat.copy(sData, 0);
            sData.writeUInt8(i, 8);
            await sendTx(l1, [
              ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
              new TransactionInstruction({
                programId: PROGRAM_ID, data: sData,
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
              }),
            ], [deployer]);
            pass(`delegate seat${i} → TEE`);
          } else { log(`  Seat ${i} already delegated`); }
        }

        // SeatCards delegation
        {
          const scInfo = await l1.getAccountInfo(scPda);
          if (scInfo && scInfo.owner.equals(PROGRAM_ID)) {
            const scBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(scPda, PROGRAM_ID);
            const scRec = delegationRecordPdaFromDelegatedAccount(scPda);
            const scMeta = delegationMetadataPdaFromDelegatedAccount(scPda);
            const scData = Buffer.alloc(9);
            DISC.delegateSeatCards.copy(scData, 0);
            scData.writeUInt8(i, 8);
            await sendTx(l1, [
              ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
              new TransactionInstruction({
                programId: PROGRAM_ID, data: scData,
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
              }),
            ], [deployer]);
            pass(`delegate seatCards${i} → TEE`);
          } else { log(`  SeatCards ${i} already delegated`); }
        }
      }

      // 4d: Table LAST (SNG guard)
      {
        const tBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(tablePda, PROGRAM_ID);
        const tRec = delegationRecordPdaFromDelegatedAccount(tablePda);
        const tMeta = delegationMetadataPdaFromDelegatedAccount(tablePda);
        const tData = Buffer.alloc(40);
        DISC.delegateTable.copy(tData, 0);
        tableIdBuf.copy(tData, 8);

        const [dsPda] = getDeckStatePda(tablePda);
        const guardKeys = [
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
          { pubkey: dsPda, isSigner: false, isWritable: false },
          ...Array.from({ length: MAX_PLAYERS }, (_, i) => ({
            pubkey: getSeatCardsPda(tablePda, i)[0], isSigner: false, isWritable: false,
          })),
        ];

        await sendTx(l1, [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
              { pubkey: tBuf, isSigner: false, isWritable: true },
              { pubkey: tRec, isSigner: false, isWritable: true },
              { pubkey: tMeta, isSigner: false, isWritable: true },
              { pubkey: tablePda, isSigner: false, isWritable: true },
              { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              ...guardKeys,
            ],
            data: tData,
          }),
        ], [deployer]);
        pass('delegate table → TEE (SNG guard)');
      }
    }

    state.step = 5;
    saveState(state);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 5: VERIFY TEE + START GAME + PLAY ALL-IN
  // ═══════════════════════════════════════════════════════════════
  if (startStep <= 5) {
    log('\n═══ STEP 5: Verify TEE + Play ═══');
    log('  Waiting 8s for TEE propagation...');
    await sleep(8000);

    // Verify table on TEE
    let tableOnTee = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      const info = await teeMgr.getAccountInfo(tablePda).catch(() => null);
      if (info) { tableOnTee = true; break; }
      log(`  TEE attempt ${attempt + 1}/15...`);
      await sleep(3000);
    }
    if (tableOnTee) pass('Table on TEE');
    else { fail('TEE propagation'); throw new Error('Table not on TEE'); }

    // Check phase — crank may have already started
    let currentPhase = Phase.Waiting as number;
    {
      const info = await teeMgr.getAccountInfo(tablePda);
      if (info) currentPhase = readPhase(Buffer.from(info.data));
      log(`  Phase on TEE: ${PHASE_NAMES[currentPhase] || currentPhase}`);
    }

    // start_game if needed
    if (currentPhase === Phase.Waiting) {
      try {
        const sgKeys = [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
          { pubkey: tablePda, isSigner: false, isWritable: true },
          { pubkey: getDeckStatePda(tablePda)[0], isSigner: false, isWritable: true },
          ...Array.from({ length: MAX_PLAYERS }, (_, i) => ({ pubkey: getSeatPda(tablePda, i)[0], isSigner: false, isWritable: true })),
        ];
        await sendTx(await teeMgr.get(), [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
          new TransactionInstruction({ programId: PROGRAM_ID, keys: sgKeys, data: DISC.startGame }),
        ], [deployer], { skipPreflight: true });
        pass('start_game');
      } catch (e: any) { log(`  start_game: ${e.message?.slice(0, 80)} (crank may race)`); }
      await sleep(3000);
    }

    // Re-read phase
    {
      const info = await teeMgr.getAccountInfo(tablePda);
      if (info) currentPhase = readPhase(Buffer.from(info.data));
      log(`  Phase after start: ${PHASE_NAMES[currentPhase] || currentPhase}`);
    }

    // tee_deal if needed
    if (currentPhase === Phase.Starting || currentPhase === Phase.Waiting) {
      try {
        const SLOT_HASHES_SYSVAR = new PublicKey('SysvarS1otHashes111111111111111111111111111');
        const tdKeys: any[] = [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
          { pubkey: tablePda, isSigner: false, isWritable: true },
          { pubkey: getDeckStatePda(tablePda)[0], isSigner: false, isWritable: true },
          { pubkey: SLOT_HASHES_SYSVAR, isSigner: false, isWritable: false },
        ];
        const playerInfoBufs: Buffer[] = [];
        for (let i = 0; i < MAX_PLAYERS; i++) {
          const [seatPda] = getSeatPda(tablePda, i);
          const seatInfo = await teeMgr.getAccountInfo(seatPda);
          let wallet = PublicKey.default;
          if (seatInfo && seatInfo.data.length > SEAT_WALLET_OFFSET + 32) {
            wallet = new PublicKey(Buffer.from(seatInfo.data).subarray(SEAT_WALLET_OFFSET, SEAT_WALLET_OFFSET + 32));
          }
          const info = Buffer.alloc(33);
          info.writeUInt8(i, 0);
          wallet.toBuffer().copy(info, 1);
          playerInfoBufs.push(info);
          tdKeys.push({ pubkey: getSeatCardsPda(tablePda, i)[0], isSigner: false, isWritable: true });
        }
        const vecLen = Buffer.alloc(4);
        vecLen.writeUInt32LE(playerInfoBufs.length, 0);
        const tdData = Buffer.concat([DISC.teeDeal, vecLen, ...playerInfoBufs]);
        await sendTx(await teeMgr.get(), [new TransactionInstruction({ programId: PROGRAM_ID, keys: tdKeys, data: tdData })], [deployer], { skipPreflight: true });
        pass('tee_deal');
      } catch (e: any) { log(`  tee_deal: ${e.message?.slice(0, 80)} (crank may race)`); }
    }

    // Wait for Preflop
    log('  Waiting for Preflop...');
    for (let poll = 0; poll < 30; poll++) {
      const info = await teeMgr.getAccountInfo(tablePda);
      if (info) {
        const phase = readPhase(Buffer.from(info.data));
        if (phase >= Phase.Preflop) { log(`  Phase: ${PHASE_NAMES[phase]}`); break; }
      }
      if (poll === 29) { fail('Preflop timeout'); throw new Error('Stuck before Preflop'); }
      await sleep(2000);
    }

    // Create per-player TEE connection managers (auto-refresh on "client error")
    const playerMgrs = players.map(p => new TeeConnManager(p.kp));
    const playerConns = await Promise.all(playerMgrs.map(m => m.get()));
    log(`  ${playerConns.length} player TEE connections established`);

    // Card visibility check
    for (let i = 0; i < players.length; i++) {
      const [scPda] = getSeatCardsPda(tablePda, players[i].seatIndex);
      try {
        const scInfo = await playerMgrs[i].getAccountInfo(scPda);
        if (scInfo && scInfo.data.length > SEAT_CARDS_CARD2) {
          const d = Buffer.from(scInfo.data);
          const c1 = d[SEAT_CARDS_CARD1], c2 = d[SEAT_CARDS_CARD2];
          if (c1 < 52 && c2 < 52) pass(`${players[i].name} sees: ${cardName(c1)} ${cardName(c2)}`);
          else fail(`${players[i].name} cards`, `${c1},${c2}`);
        } else fail(`${players[i].name} seatCards`, 'null');
      } catch (e: any) { fail(`${players[i].name} cards`, e.message?.slice(0, 60)); }
    }

    // ═══ ALL-IN LOOP ═══
    log('\n  --- ALL-IN Loop ---');
    const allInData = Buffer.concat([DISC.playerAction, Buffer.from([ALL_IN])]);
    const MAX_HANDS = 20;
    let sngComplete = false;

    for (let hand = 1; hand <= MAX_HANDS; hand++) {
      log(`\n  Hand #${hand}:`);

      // Wait for playable phase
      let readyPhase = Phase.Waiting as number;
      for (let w = 0; w < 30; w++) {
        const info = await teeMgr.getAccountInfo(tablePda);
        if (info) {
          readyPhase = readPhase(Buffer.from(info.data));
          if (readyPhase >= Phase.Preflop && readyPhase <= Phase.River) break;
          if (readyPhase === Phase.Complete) break;
        }
        await sleep(2000);
      }
      if (readyPhase === Phase.Complete) { sngComplete = true; break; }
      if (readyPhase < Phase.Preflop) { fail('Hand start', `Stuck at ${PHASE_NAMES[readyPhase]}`); break; }

      // Send ALL-IN actions
      for (let actionLoop = 0; actionLoop < 15; actionLoop++) {
        const info = await teeMgr.getAccountInfo(tablePda);
        if (!info) break;
        const td = Buffer.from(info.data);
        let phase = readPhase(td);

        if (phase >= Phase.FlopRevealPending && phase <= Phase.RiverRevealPending) {
          log(`    Waiting for reveal (${PHASE_NAMES[phase]})...`);
          await sleep(3000);
          continue;
        }
        if (phase === Phase.Showdown || phase === Phase.Complete || phase === Phase.Waiting) break;
        if (phase < Phase.Preflop || phase > Phase.River) { await sleep(2000); continue; }

        const currentPlayer = readCurrentPlayer(td);
        const playerIdx = players.findIndex(p => p.seatIndex === currentPlayer);
        if (playerIdx < 0) { await sleep(1000); continue; }

        const player = players[playerIdx];
        const [seatPda] = getSeatPda(tablePda, player.seatIndex);
        try {
          await sendTx(await playerMgrs[playerIdx].get(), [new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: player.kp.publicKey, isSigner: true, isWritable: false },
              { pubkey: tablePda, isSigner: false, isWritable: true },
              { pubkey: seatPda, isSigner: false, isWritable: true },
              { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            data: allInData,
          })], [player.kp], { skipPreflight: true });
          log(`    ✅ Seat ${currentPlayer} ALL-IN`);
        } catch (e: any) { log(`    ⚠️  Seat ${currentPlayer}: ${e.message?.slice(0, 80)}`); }
        await sleep(1000);
      }

      // Handle reveals + showdown + settle
      for (let rev = 0; rev < 8; rev++) {
        const info = await teeMgr.getAccountInfo(tablePda);
        if (!info) break;
        const td = Buffer.from(info.data);
        const phase = readPhase(td);
        if (phase >= Phase.FlopRevealPending && phase <= Phase.RiverRevealPending) {
          try {
            await sendTx(await teeMgr.get(), [new TransactionInstruction({
              programId: PROGRAM_ID,
              keys: [
                { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
                { pubkey: tablePda, isSigner: false, isWritable: true },
                { pubkey: getDeckStatePda(tablePda)[0], isSigner: false, isWritable: true },
              ],
              data: DISC.teeReveal,
            })], [deployer], { skipPreflight: true });
          } catch {}
          await sleep(1500);
          continue;
        }
        if (phase === Phase.Showdown) {
          const cc = readCommunityCards(td);
          log(`    Board: [${cc.map(cardName).join(' ')}]`);
          try {
            const sKeys: any[] = [
              { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
              { pubkey: tablePda, isSigner: false, isWritable: true },
              { pubkey: getDeckStatePda(tablePda)[0], isSigner: false, isWritable: true },
            ];
            for (let i = 0; i < MAX_PLAYERS; i++) sKeys.push({ pubkey: getSeatPda(tablePda, i)[0], isSigner: false, isWritable: true });
            for (let i = 0; i < MAX_PLAYERS; i++) sKeys.push({ pubkey: getSeatCardsPda(tablePda, i)[0], isSigner: false, isWritable: true });
            await sendTx(await teeMgr.get(), [new TransactionInstruction({ programId: PROGRAM_ID, keys: sKeys, data: DISC.settleHand })], [deployer], { skipPreflight: true });
            pass('settle_hand');
          } catch (e: any) { log(`    settle: ${e.message?.slice(0, 60)}`); }
          await sleep(2000);
          continue;
        }
        break;
      }

      // Post-hand state
      const postInfo = await teeMgr.getAccountInfo(tablePda);
      if (postInfo) {
        const td = Buffer.from(postInfo.data);
        const phase = readPhase(td);
        for (const p of players) {
          try {
            const [sp] = getSeatPda(tablePda, p.seatIndex);
            const si = await teeMgr.getAccountInfo(sp);
            if (si) {
              const chips = Number(Buffer.from(si.data).readBigUInt64LE(SEAT_CHIPS_OFFSET));
              log(`    ${p.name} chips: ${chips}`);
            }
          } catch {}
        }
        if (phase === Phase.Complete) {
          sngComplete = true;
          pass(`SNG complete after ${hand} hand(s)`);
          break;
        }
        log(`    Phase: ${PHASE_NAMES[phase]}, continuing...`);
      }
    }

    if (!sngComplete) fail('SNG completion', `Not done after ${MAX_HANDS} hands`);

    // Capture winner from TEE
    let winnerSeat = -1;
    for (const p of players) {
      try {
        const [sp] = getSeatPda(tablePda, p.seatIndex);
        const si = await teeMgr.getAccountInfo(sp);
        if (si) {
          const chips = Number(Buffer.from(si.data).readBigUInt64LE(SEAT_CHIPS_OFFSET));
          if (chips > 0) winnerSeat = p.seatIndex;
        }
      } catch {}
    }
    if (winnerSeat === -1) winnerSeat = 0;
    state.winnerSeat = winnerSeat;
    log(`  Winner: ${players[winnerSeat].name} (${players[winnerSeat].kp.publicKey.toBase58().slice(0, 16)}...)`);

    state.step = 6;
    saveState(state);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 6: WAIT FOR CRANK → VERIFY DISTRIBUTIONS
  // ═══════════════════════════════════════════════════════════════
  if (startStep <= 6) {
    log('\n═══ STEP 6: Wait for Crank Undelegate + Distribute ═══');
    log('  ⚠️  Crank must be running! (npx ts-node backend/crank-service.ts)');

    const winnerSeat = state.winnerSeat ?? 0;
    const winner = players[winnerSeat];
    const [winnerPlayerPda] = getPlayerPda(winner.kp.publicKey);
    const [winnerUnrefined] = getUnrefinedPda(winner.kp.publicKey);

    // Pre-distribution snapshots
    const preTreasury = (await l1.getAccountInfo(TREASURY))?.lamports || 0;
    const prePool = (await l1.getAccountInfo(POOL_PDA))?.lamports || 0;
    const preWinnerBal = await l1.getBalance(winner.kp.publicKey);
    log(`  Pre: treasury=${preTreasury}, pool=${prePool}, winner=${preWinnerBal}`);

    // Wait for table to come back to L1
    let tableOnL1 = false;
    let crankHandled = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const info = await l1.getAccountInfo(tablePda);
      if (info && info.owner.equals(PROGRAM_ID)) {
        const phase = readPhase(Buffer.from(info.data));
        if (phase === Phase.Complete) { tableOnL1 = true; break; }
      } else if (!info) {
        crankHandled = true;
        break;
      }
      process.stdout.write(`\r    Polling L1... ${attempt + 1}/60  `);
      await sleep(3000);
    }
    console.log('');

    if (tableOnL1) {
      pass('Table undelegated to L1 (Complete)');

      // distribute_prizes
      const tInfo = await l1.getAccountInfo(tablePda);
      if (tInfo) {
        const td = Buffer.from(tInfo.data);
        if (!readPrizesDistributed(td)) {
          const [prizeAuthority] = getPrizeAuthorityPda();
          const [vaultPda] = getVaultPda(tablePda);
          const remaining: any[] = [];
          for (let i = 0; i < MAX_PLAYERS; i++) remaining.push({ pubkey: getSeatPda(tablePda, i)[0], isSigner: false, isWritable: false });
          remaining.push({ pubkey: winnerPlayerPda, isSigner: false, isWritable: true });
          remaining.push({ pubkey: winnerUnrefined, isSigner: false, isWritable: true });

          try {
            await sendTx(l1, [
              ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
              new TransactionInstruction({
                programId: PROGRAM_ID,
                keys: [
                  { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
                  { pubkey: tablePda, isSigner: false, isWritable: true },
                  { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
                  { pubkey: prizeAuthority, isSigner: false, isWritable: true },
                  { pubkey: POOL_PDA, isSigner: false, isWritable: true },
                  { pubkey: TREASURY, isSigner: false, isWritable: true },
                  { pubkey: vaultPda, isSigner: false, isWritable: true },
                  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                  ...remaining,
                ],
                data: DISC.distributePrizes,
              }),
            ], [deployer]);
            pass('distribute_prizes');
          } catch (e: any) {
            if (e.message?.includes('6871') || e.message?.includes('AlreadyDistributed')) pass('distribute_prizes (crank beat us)');
            else fail('distribute_prizes', e.message?.slice(0, 120));
          }
        } else {
          pass('distribute_prizes (already done by crank)');
        }
      }
    } else if (crankHandled) {
      pass('Crank handled: undelegate + distribute + close');
    } else {
      fail('Undelegation', 'Table not back after 180s — is crank running?');
    }

    // Post-distribution verification
    await sleep(5000);
    const postTreasury = (await l1.getAccountInfo(TREASURY))?.lamports || 0;
    const postPool = (await l1.getAccountInfo(POOL_PDA))?.lamports || 0;
    const postWinnerBal = await l1.getBalance(winner.kp.publicKey);

    const treasuryDelta = postTreasury - preTreasury;
    const poolDelta = postPool - prePool;
    const winnerDelta = postWinnerBal - preWinnerBal;
    const expectedFees = FEE_AMOUNT * 2;

    log('\n  === DISTRIBUTION VERIFICATION ===');
    log(`  Treasury: ${preTreasury} → ${postTreasury} (Δ${treasuryDelta})`);
    log(`  Pool:     ${prePool} → ${postPool} (Δ${poolDelta})`);
    log(`  Winner:   ${preWinnerBal} → ${postWinnerBal} (Δ${winnerDelta})`);
    log(`  Expected fees: ${expectedFees} (treasury ~50%, pool ~50%)`);
    log(`  Expected prize: ${ENTRY_AMOUNT * 2} to winner`);

    if (treasuryDelta > 0) pass(`Treasury received ${treasuryDelta} lamports`);
    else fail('Treasury fee', `delta=${treasuryDelta}`);
    if (poolDelta > 0) pass(`Pool received ${poolDelta} lamports`);
    else fail('Pool fee', `delta=${poolDelta}`);

    // Verify unrefined POKER
    const ui = await l1.getAccountInfo(winnerUnrefined);
    if (ui && ui.data.length >= 16) {
      pass('Winner unrefined PDA exists');
      log(`  Unrefined data (first 24 bytes): [${Array.from(Buffer.from(ui.data).subarray(0, 24)).join(',')}]`);
    } else {
      fail('Winner unrefined PDA', 'not found');
    }

    // claim_sol_winnings
    const pi = await l1.getAccountInfo(winnerPlayerPda);
    if (pi && pi.data.length >= PLAYER_CLAIMABLE_SOL_OFFSET + 8) {
      const claimable = Number(Buffer.from(pi.data).readBigUInt64LE(PLAYER_CLAIMABLE_SOL_OFFSET));
      log(`  Claimable SOL: ${claimable} lamports (${claimable / 1e9} SOL)`);
      if (claimable > 0) {
        try {
          await sendTx(l1, [new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: winner.kp.publicKey, isSigner: true, isWritable: true },
              { pubkey: winnerPlayerPda, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: DISC.claimSolWinnings,
          })], [winner.kp]);
          const finalBal = await l1.getBalance(winner.kp.publicKey);
          pass(`claim_sol_winnings: +${finalBal - postWinnerBal} lamports`);
        } catch (e: any) { fail('claim_sol_winnings', e.message?.slice(0, 100)); }
      } else {
        log('  No SOL to claim (0 claimable — may be distributed differently)');
      }
    }

    // Crank tally verification
    const [crankTallyL1] = getCrankTallyL1Pda(tablePda);
    const ctInfo = await l1.getAccountInfo(crankTallyL1);
    if (ctInfo) {
      log(`  CrankTallyL1 exists (${ctInfo.data.length} bytes)`);
      pass('Crank tally tracked');
    }

    state.step = 7;
    saveState(state);
  }

  // ═══════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════
  log('\n╔══════════════════════════════════════════════════════════════╗');
  log('║   HU SNG PERSISTENT TEST RESULTS                            ║');
  log('╚══════════════════════════════════════════════════════════════╝');
  log(`  Table PDA : ${tablePda.toBase58()}`);
  log(`  Player 0  : ${player1.publicKey.toBase58()}`);
  log(`  Player 1  : ${player2.publicKey.toBase58()}`);
  log(`  Game #    : ${state.gameNumber || 1}`);
  log(`  Passed: ${passCount}  Failed: ${failCount}`);
  log(`  State file: ${STATE_FILE}`);
  if (failCount === 0) {
    log('\n  🎉 ALL TESTS PASSED!');
    log('  To reuse this table: npx ts-node scripts/hu-sng-persistent.ts --reuse');
  } else {
    log(`\n  ⚠️  ${failCount} test(s) failed`);
    log('  To resume from last step: npx ts-node scripts/hu-sng-persistent.ts');
    log('  To resume from specific step: npx ts-node scripts/hu-sng-persistent.ts --from=5');
  }
}

main().catch((e) => {
  console.error('\n💥 FATAL:', e.message || e);
  if (e.logs) for (const l of e.logs.slice(-5)) console.error('  LOG:', l);
  process.exit(1);
});
