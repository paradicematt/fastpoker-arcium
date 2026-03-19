/**
 * Smoke Test: FastPoker Game Loop on Local Validator
 *
 * Tests the core game flow WITHOUT Arcium MPC (uses devnet_bypass_deal mock):
 *   1. Register 2 players (with Steel CPI for unrefined PDA init)
 *   2. Create HU cash game table (micro stakes)
 *   3. Init table seats (seat 0, seat 1)
 *   4. Join table with both players
 *   5. Start game → Starting phase
 *   6. devnet_bypass_deal → Preflop phase
 *   7. Player action: fold → hand resolves
 *   8. Read table state to verify
 *
 * Program IDs:
 *   FastPoker: BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N
 *   STEEL:     9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6
 *
 * Run: npx ts-node smoke-test-game-loop.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  SYSVAR_SLOT_HASHES_PUBKEY,
} from '@solana/web3.js';
import * as crypto from 'crypto';

// ============================================================
// Constants
// ============================================================
const FASTPOKER_PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const RPC_URL = 'http://127.0.0.1:8899';

// PDA Seeds (must match constants.rs)
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
const TABLE_AUTHORITY_SEED = Buffer.from('table_authority');
const UNREFINED_SEED = Buffer.from('unrefined');

// Treasury: 4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// ============================================================
// Anchor Discriminator Helper
// ============================================================
function anchorDiscriminator(instructionName: string): Buffer {
  const hash = crypto.createHash('sha256').update(`global:${instructionName}`).digest();
  return Buffer.from(hash.subarray(0, 8));
}

// Pre-compute discriminators
const IX = {
  register_player: anchorDiscriminator('register_player'),
  create_table: anchorDiscriminator('create_table'),
  init_table_seat: anchorDiscriminator('init_table_seat'),
  join_table: anchorDiscriminator('join_table'),
  start_game: anchorDiscriminator('start_game'),
  devnet_bypass_deal: anchorDiscriminator('devnet_bypass_deal'),
  player_action: anchorDiscriminator('player_action'),
  settle_hand: anchorDiscriminator('settle_hand'),
};

// ============================================================
// PDA Derivation Helpers
// ============================================================
function getTablePDA(tableId: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TABLE_SEED, tableId], FASTPOKER_PROGRAM_ID);
}

function getSeatPDA(tablePDA: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEAT_SEED, tablePDA.toBuffer(), Buffer.from([seatIndex])],
    FASTPOKER_PROGRAM_ID,
  );
}

function getSeatCardsPDA(tablePDA: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEAT_CARDS_SEED, tablePDA.toBuffer(), Buffer.from([seatIndex])],
    FASTPOKER_PROGRAM_ID,
  );
}

function getDeckStatePDA(tablePDA: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([DECK_STATE_SEED, tablePDA.toBuffer()], FASTPOKER_PROGRAM_ID);
}

function getVaultPDA(tablePDA: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED, tablePDA.toBuffer()], FASTPOKER_PROGRAM_ID);
}

function getReceiptPDA(tablePDA: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [RECEIPT_SEED, tablePDA.toBuffer(), Buffer.from([seatIndex])],
    FASTPOKER_PROGRAM_ID,
  );
}

function getDepositProofPDA(tablePDA: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [DEPOSIT_PROOF_SEED, tablePDA.toBuffer(), Buffer.from([seatIndex])],
    FASTPOKER_PROGRAM_ID,
  );
}

function getPlayerAccountPDA(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PLAYER_SEED, wallet.toBuffer()], FASTPOKER_PROGRAM_ID);
}

function getPlayerTableMarkerPDA(wallet: PublicKey, tablePDA: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PLAYER_TABLE_SEED, wallet.toBuffer(), tablePDA.toBuffer()],
    FASTPOKER_PROGRAM_ID,
  );
}

function getCrankTallyErPDA(tablePDA: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CRANK_TALLY_ER_SEED, tablePDA.toBuffer()], FASTPOKER_PROGRAM_ID);
}

function getCrankTallyL1PDA(tablePDA: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CRANK_TALLY_L1_SEED, tablePDA.toBuffer()], FASTPOKER_PROGRAM_ID);
}

function getTableAuthorityPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TABLE_AUTHORITY_SEED], FASTPOKER_PROGRAM_ID);
}

function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('pool')], STEEL_PROGRAM_ID);
}

function getUnrefinedPDA(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([UNREFINED_SEED, wallet.toBuffer()], STEEL_PROGRAM_ID);
}

// ============================================================
// Borsh Serialization Helpers
// ============================================================

/**
 * Serialize TableConfig for create_table instruction.
 * Layout: table_id(32) + game_type(u8 enum) + stakes(u8 enum) + max_players(u8) + tier(u8 enum)
 */
function serializeTableConfig(tableId: Buffer, gameType: number, stakes: number, maxPlayers: number, tier: number): Buffer {
  const buf = Buffer.alloc(36);
  tableId.copy(buf, 0, 0, 32);
  buf.writeUInt8(gameType, 32);  // GameType enum
  buf.writeUInt8(stakes, 33);    // Stakes enum
  buf.writeUInt8(maxPlayers, 34); // max_players
  buf.writeUInt8(tier, 35);      // SnGTier enum
  return buf;
}

// GameType enum: 0=SitAndGoHeadsUp, 1=SitAndGo6Max, 2=SitAndGo9Max, 3=CashGame
// Stakes enum: 0=Micro, 1=Low, 2=Mid, 3=High
// SnGTier enum: 0=Micro, 1=Bronze, 2=Silver, 3=Gold, 4=Platinum, 5=Diamond

// PokerAction enum: 0=Fold, 1=Check, 2=Call, 3=Bet{u64}, 4=Raise{u64}, 5=AllIn, ...
function serializeFold(): Buffer {
  return Buffer.from([0]); // Fold variant index
}

// ============================================================
// Table State Reader
// ============================================================
interface TableState {
  phase: number;
  currentPlayers: number;
  maxPlayers: number;
  handNumber: bigint;
  pot: bigint;
  smallBlind: bigint;
  bigBlind: bigint;
  currentPlayer: number;
  dealerButton: number;
  seatsOccupied: number;
}

function readTableState(data: Buffer): TableState {
  // Offsets from Table struct (discriminator=8 bytes)
  // table_id: 8..40 (32)
  // authority: 40..72 (32)
  // pool: 72..104 (32)
  // game_type: 104 (1)
  // small_blind: 105..113 (8)
  // big_blind: 113..121 (8)
  // max_players: 121 (1)
  // current_players: 122 (1)
  // hand_number: 123..131 (8)
  // pot: 131..139 (8)
  // min_bet: 139..147 (8)
  // rake_accumulated: 147..155 (8)
  // community_cards: 155..160 (5)
  // phase: 160 (1)
  // current_player: 161 (1)
  // actions_this_round: 162 (1)
  // dealer_button: 163 (1)
  // small_blind_seat: 164 (1)
  // big_blind_seat: 165 (1)
  // last_action_slot: 166..174 (8)
  // is_delegated: 174 (1)
  // revealed_hands: 175..193 (18)
  // hand_results: 193..202 (9)
  // pre_community: 202..207 (5)
  // deck_seed: 207..239 (32)
  // deck_index: 239 (1)
  // stakes_level: 240 (1)
  // blind_level: 241 (1)
  // tournament_start_slot: 242..250 (8)
  // seats_occupied: 250..252 (2)
  return {
    phase: data.readUInt8(160),
    currentPlayers: data.readUInt8(122),
    maxPlayers: data.readUInt8(121),
    handNumber: data.readBigUInt64LE(123),
    pot: data.readBigUInt64LE(131),
    smallBlind: data.readBigUInt64LE(105),
    bigBlind: data.readBigUInt64LE(113),
    currentPlayer: data.readUInt8(161),
    dealerButton: data.readUInt8(163),
    seatsOccupied: data.readUInt16LE(250),
  };
}

const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting',
  1: 'Starting',
  2: 'AwaitingDeal',
  3: 'Preflop',
  4: 'Flop',
  5: 'Turn',
  6: 'River',
  7: 'Showdown',
  8: 'AwaitingShowdown',
  9: 'Complete',
  10: 'FlopRevealPending',
  11: 'TurnRevealPending',
  12: 'RiverRevealPending',
};

// ============================================================
// Test Helpers
// ============================================================
async function airdrop(connection: Connection, pubkey: PublicKey, amount: number) {
  const sig = await connection.requestAirdrop(pubkey, amount);
  await connection.confirmTransaction(sig, 'confirmed');
}

function step(name: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${name}`);
  console.log('='.repeat(70));
}

async function sendTx(
  connection: Connection,
  ix: TransactionInstruction,
  signers: Keypair[],
  label: string,
): Promise<string | null> {
  try {
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = signers[0].publicKey;
    const sig = await sendAndConfirmTransaction(connection, tx, signers, {
      commitment: 'confirmed',
      skipPreflight: false,
    });
    console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
    return sig;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0, 120)}`);
    if (e.logs) {
      const relevant = e.logs.filter((l: string) => l.includes('Error') || l.includes('failed') || l.includes('Program log'));
      relevant.slice(-5).forEach((l: string) => console.log(`     ${l}`));
    }
    return null;
  }
}

// ============================================================
// Main Test
// ============================================================
async function main() {
  console.log('='.repeat(70));
  console.log('  FastPoker Smoke Test — Game Loop on Local Validator');
  console.log('='.repeat(70));
  console.log(`  FastPoker: ${FASTPOKER_PROGRAM_ID.toBase58()}`);
  console.log(`  STEEL:     ${STEEL_PROGRAM_ID.toBase58()}`);
  console.log(`  RPC:       ${RPC_URL}`);

  const connection = new Connection(RPC_URL, 'confirmed');

  // Verify programs are deployed
  const fpInfo = await connection.getAccountInfo(FASTPOKER_PROGRAM_ID);
  const steelInfo = await connection.getAccountInfo(STEEL_PROGRAM_ID);
  console.log(`\n  FastPoker deployed: ${fpInfo?.executable ?? false}`);
  console.log(`  STEEL deployed:     ${steelInfo?.executable ?? false}`);
  if (!fpInfo?.executable || !steelInfo?.executable) {
    console.log('\n  ⚠️  Programs not deployed. Run start-local-validator.sh first.');
    return;
  }

  // Generate test wallets
  const playerA = Keypair.generate();
  const playerB = Keypair.generate();
  console.log(`\n  Player A: ${playerA.publicKey.toBase58().slice(0, 16)}...`);
  console.log(`  Player B: ${playerB.publicKey.toBase58().slice(0, 16)}...`);

  // ============================================================
  // STEP 0: Airdrop SOL
  // ============================================================
  step('STEP 0: Airdrop SOL');
  await airdrop(connection, playerA.publicKey, 10 * LAMPORTS_PER_SOL);
  await airdrop(connection, playerB.publicKey, 10 * LAMPORTS_PER_SOL);
  const balA = await connection.getBalance(playerA.publicKey);
  const balB = await connection.getBalance(playerB.publicKey);
  console.log(`  Player A: ${balA / LAMPORTS_PER_SOL} SOL`);
  console.log(`  Player B: ${balB / LAMPORTS_PER_SOL} SOL`);

  // ============================================================
  // STEP 1: Register Players
  // ============================================================
  step('STEP 1: Register Players');

  for (const [label, player] of [['A', playerA], ['B', playerB]] as [string, Keypair][]) {
    const [playerAccountPDA] = getPlayerAccountPDA(player.publicKey);
    const [poolPDA] = getPoolPDA();
    const [unrefinedPDA] = getUnrefinedPDA(player.publicKey);

    const ix = new TransactionInstruction({
      programId: FASTPOKER_PROGRAM_ID,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: playerAccountPDA, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: unrefinedPDA, isSigner: false, isWritable: true },
        { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: IX.register_player,
    });
    await sendTx(connection, ix, [player], `Register Player ${label}`);
  }

  // ============================================================
  // STEP 2: Create Table (HU Cash Game, Micro Stakes)
  // ============================================================
  step('STEP 2: Create Table');

  // Generate a unique table ID
  const tableId = crypto.randomBytes(32);
  const [tablePDA] = getTablePDA(tableId);
  const [poolPDA] = getPoolPDA();

  console.log(`  Table ID: ${tableId.toString('hex').slice(0, 16)}...`);
  console.log(`  Table PDA: ${tablePDA.toBase58()}`);

  const createTableData = Buffer.concat([
    IX.create_table,
    serializeTableConfig(tableId, 3 /* CashGame */, 0 /* Micro */, 2 /* HU */, 0 /* Micro tier */),
  ]);

  const createTableIx = new TransactionInstruction({
    programId: FASTPOKER_PROGRAM_ID,
    keys: [
      { pubkey: playerA.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: createTableData,
  });
  const createResult = await sendTx(connection, createTableIx, [playerA], 'Create Table');
  if (!createResult) {
    console.log('  ⚠️  Table creation failed — aborting.');
    return;
  }

  // Read table state
  let tableInfo = await connection.getAccountInfo(tablePDA);
  if (tableInfo) {
    const state = readTableState(tableInfo.data);
    console.log(`  Phase: ${PHASE_NAMES[state.phase]} (${state.phase})`);
    console.log(`  Blinds: ${state.smallBlind}/${state.bigBlind}`);
    console.log(`  Max Players: ${state.maxPlayers}`);
  }

  // ============================================================
  // STEP 3: Init Table Seats
  // ============================================================
  step('STEP 3: Init Table Seats');

  for (let seatIdx = 0; seatIdx < 2; seatIdx++) {
    const [seatPDA] = getSeatPDA(tablePDA, seatIdx);
    const [seatCardsPDA] = getSeatCardsPDA(tablePDA, seatIdx);
    const [deckStatePDA] = getDeckStatePDA(tablePDA);
    const [receiptPDA] = getReceiptPDA(tablePDA, seatIdx);
    const [depositProofPDA] = getDepositProofPDA(tablePDA, seatIdx);
    const [vaultPDA] = getVaultPDA(tablePDA);
    const [crankTallyErPDA] = getCrankTallyErPDA(tablePDA);
    const [crankTallyL1PDA] = getCrankTallyL1PDA(tablePDA);

    const initData = Buffer.concat([IX.init_table_seat, Buffer.from([seatIdx])]);
    const ix = new TransactionInstruction({
      programId: FASTPOKER_PROGRAM_ID,
      keys: [
        { pubkey: playerA.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePDA, isSigner: false, isWritable: false },
        { pubkey: seatPDA, isSigner: false, isWritable: true },
        { pubkey: seatCardsPDA, isSigner: false, isWritable: true },
        { pubkey: deckStatePDA, isSigner: false, isWritable: true },
        { pubkey: receiptPDA, isSigner: false, isWritable: true },
        { pubkey: depositProofPDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: crankTallyErPDA, isSigner: false, isWritable: true },
        { pubkey: crankTallyL1PDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: initData,
    });
    await sendTx(connection, ix, [playerA], `Init Seat ${seatIdx}`);
  }

  // ============================================================
  // STEP 4: Join Table (Both Players)
  // ============================================================
  step('STEP 4: Join Table');

  const BUY_IN = 100_000n; // 100k lamports (50 BB at micro)
  const RESERVE = 0n;

  for (const [label, player, seatIdx] of [
    ['A', playerA, 0],
    ['B', playerB, 1],
  ] as [string, Keypair, number][]) {
    const [playerAccountPDA] = getPlayerAccountPDA(player.publicKey);
    const [seatPDA] = getSeatPDA(tablePDA, seatIdx);
    const [markerPDA] = getPlayerTableMarkerPDA(player.publicKey, tablePDA);
    const [vaultPDA] = getVaultPDA(tablePDA);
    const [receiptPDA] = getReceiptPDA(tablePDA, seatIdx);

    // join_table args: buy_in(u64) + seat_number(u8) + reserve(u64)
    const joinData = Buffer.alloc(8 + 8 + 1 + 8);
    IX.join_table.copy(joinData, 0);
    joinData.writeBigUInt64LE(BUY_IN, 8);
    joinData.writeUInt8(seatIdx, 16);
    joinData.writeBigUInt64LE(RESERVE, 17);

    const ix = new TransactionInstruction({
      programId: FASTPOKER_PROGRAM_ID,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: playerAccountPDA, isSigner: false, isWritable: true },
        { pubkey: tablePDA, isSigner: false, isWritable: true },
        { pubkey: seatPDA, isSigner: false, isWritable: true },
        { pubkey: markerPDA, isSigner: false, isWritable: true },
        // vault (Option)
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        // receipt (Option)
        { pubkey: receiptPDA, isSigner: false, isWritable: true },
        // treasury (Option) — for SNG fee; None for cash
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // pool (Option) — for SNG fee; None for cash
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // player_token_account (Option) — None for SOL
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // table_token_account (Option) — None for SOL
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // unclaimed_balance (Option) — None
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // token_program (Option) — None for SOL
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // system_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: joinData,
    });
    await sendTx(connection, ix, [player], `Join Table Player ${label} (seat ${seatIdx})`);
  }

  // Read table state after joins
  tableInfo = await connection.getAccountInfo(tablePDA);
  if (tableInfo) {
    const state = readTableState(tableInfo.data);
    console.log(`\n  After joins:`);
    console.log(`  Phase: ${PHASE_NAMES[state.phase]} (${state.phase})`);
    console.log(`  Current Players: ${state.currentPlayers}`);
    console.log(`  Seats Occupied: 0b${state.seatsOccupied.toString(2).padStart(2, '0')}`);
  }

  // ============================================================
  // STEP 5: Start Game
  // ============================================================
  step('STEP 5: Start Game');

  const [deckStatePDA] = getDeckStatePDA(tablePDA);
  const [seat0PDA] = getSeatPDA(tablePDA, 0);
  const [seat1PDA] = getSeatPDA(tablePDA, 1);

  const startGameIx = new TransactionInstruction({
    programId: FASTPOKER_PROGRAM_ID,
    keys: [
      { pubkey: playerA.publicKey, isSigner: false, isWritable: false }, // initiator (CHECK)
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: deckStatePDA, isSigner: false, isWritable: true },
    ],
    // remaining_accounts: occupied seats
    data: IX.start_game,
  });
  // Add seat PDAs as remaining accounts (occupied seats bitmask)
  startGameIx.keys.push(
    { pubkey: seat0PDA, isSigner: false, isWritable: true },
    { pubkey: seat1PDA, isSigner: false, isWritable: true },
  );
  await sendTx(connection, startGameIx, [playerA], 'Start Game');

  // Read table state
  tableInfo = await connection.getAccountInfo(tablePDA);
  if (tableInfo) {
    const state = readTableState(tableInfo.data);
    console.log(`  Phase: ${PHASE_NAMES[state.phase]} (${state.phase})`);
    console.log(`  Hand #${state.handNumber}`);
    console.log(`  Pot: ${state.pot}`);
    console.log(`  Current Player: seat ${state.currentPlayer}`);
    console.log(`  Dealer Button: seat ${state.dealerButton}`);
  }

  // ============================================================
  // STEP 6: devnet_bypass_deal (Mock Deal)
  // ============================================================
  step('STEP 6: devnet_bypass_deal (Mock)');

  const [sc0PDA] = getSeatCardsPDA(tablePDA, 0);
  const [sc1PDA] = getSeatCardsPDA(tablePDA, 1);

  const dealIx = new TransactionInstruction({
    programId: FASTPOKER_PROGRAM_ID,
    keys: [
      { pubkey: playerA.publicKey, isSigner: true, isWritable: false }, // caller (Signer)
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: deckStatePDA, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: IX.devnet_bypass_deal,
  });
  // remaining_accounts: [seats..., seat_cards...] (paired layout)
  dealIx.keys.push(
    { pubkey: seat0PDA, isSigner: false, isWritable: true },
    { pubkey: seat1PDA, isSigner: false, isWritable: true },
    { pubkey: sc0PDA, isSigner: false, isWritable: true },
    { pubkey: sc1PDA, isSigner: false, isWritable: true },
  );
  await sendTx(connection, dealIx, [playerA], 'devnet_bypass_deal');

  // Read table state
  tableInfo = await connection.getAccountInfo(tablePDA);
  if (tableInfo) {
    const state = readTableState(tableInfo.data);
    console.log(`  Phase: ${PHASE_NAMES[state.phase]} (${state.phase})`);
    console.log(`  Current Player: seat ${state.currentPlayer}`);
    console.log(`  Pot: ${state.pot}`);
  }

  // ============================================================
  // STEP 7: Player Action — Fold
  // ============================================================
  step('STEP 7: Player Action (Fold)');

  // In HU preflop: SB (seat 0, also button) acts first
  // Read table to determine who acts
  tableInfo = await connection.getAccountInfo(tablePDA);
  let actingSeat = 0;
  let actingPlayer = playerA;
  if (tableInfo) {
    const state = readTableState(tableInfo.data);
    actingSeat = state.currentPlayer;
    actingPlayer = actingSeat === 0 ? playerA : playerB;
    console.log(`  Acting player: seat ${actingSeat} (Player ${actingSeat === 0 ? 'A' : 'B'})`);
  }

  const [actingSeatPDA] = getSeatPDA(tablePDA, actingSeat);
  const foldData = Buffer.concat([IX.player_action, serializeFold()]);

  const foldIx = new TransactionInstruction({
    programId: FASTPOKER_PROGRAM_ID,
    keys: [
      { pubkey: actingPlayer.publicKey, isSigner: true, isWritable: false }, // signer
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: actingSeatPDA, isSigner: false, isWritable: true },
      // session_token: None (Option<Account>) — pass program ID as sentinel
      { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: foldData,
  });
  await sendTx(connection, foldIx, [actingPlayer], `Fold (seat ${actingSeat})`);

  // Read table state after fold
  tableInfo = await connection.getAccountInfo(tablePDA);
  if (tableInfo) {
    const state = readTableState(tableInfo.data);
    console.log(`  Phase: ${PHASE_NAMES[state.phase]} (${state.phase})`);
    console.log(`  Pot: ${state.pot}`);
    console.log(`  Hand #${state.handNumber}`);
  }

  // ============================================================
  // STEP 8: Settle Hand (if needed)
  // ============================================================
  step('STEP 8: Settle Hand');

  tableInfo = await connection.getAccountInfo(tablePDA);
  if (tableInfo) {
    const state = readTableState(tableInfo.data);
    if (state.phase === 7 || state.phase === 8) {
      // Showdown or AwaitingShowdown — need to settle
      const [sc0PDA] = getSeatCardsPDA(tablePDA, 0);
      const [sc1PDA] = getSeatCardsPDA(tablePDA, 1);

      const settleIx = new TransactionInstruction({
        programId: FASTPOKER_PROGRAM_ID,
        keys: [
          { pubkey: playerA.publicKey, isSigner: false, isWritable: false }, // settler (CHECK)
          { pubkey: tablePDA, isSigner: false, isWritable: true },
          { pubkey: deckStatePDA, isSigner: false, isWritable: true },
        ],
        data: IX.settle_hand,
      });
      // remaining_accounts: [seat0, seat1, seatCards0, seatCards1]
      settleIx.keys.push(
        { pubkey: seat0PDA, isSigner: false, isWritable: true },
        { pubkey: seat1PDA, isSigner: false, isWritable: true },
        { pubkey: sc0PDA, isSigner: false, isWritable: true },
        { pubkey: sc1PDA, isSigner: false, isWritable: true },
      );
      await sendTx(connection, settleIx, [playerA], 'Settle Hand');
    } else if (state.phase === 9) {
      console.log(`  ✅ Hand already Complete (fold resolved inline)`);
    } else if (state.phase === 0) {
      console.log(`  ✅ Already back to Waiting (hand completed + reset)`);
    } else {
      console.log(`  ⚠️  Unexpected phase: ${PHASE_NAMES[state.phase]} (${state.phase})`);
    }
  }

  // ============================================================
  // FINAL: Read Final State
  // ============================================================
  step('FINAL SUMMARY');

  tableInfo = await connection.getAccountInfo(tablePDA);
  if (tableInfo) {
    const state = readTableState(tableInfo.data);
    console.log(`  Phase: ${PHASE_NAMES[state.phase]} (${state.phase})`);
    console.log(`  Hand #${state.handNumber}`);
    console.log(`  Pot: ${state.pot}`);
    console.log(`  Current Players: ${state.currentPlayers}`);
  }

  // Read seat chip balances
  for (let i = 0; i < 2; i++) {
    const [seatPDA] = getSeatPDA(tablePDA, i);
    const seatInfo = await connection.getAccountInfo(seatPDA);
    if (seatInfo && seatInfo.data.length >= 120) {
      // chips at offset 104 (8+32+32+32=104)
      const chips = seatInfo.data.readBigUInt64LE(104);
      const status = seatInfo.data.readUInt8(227); // STATUS_OFFSET
      const statusNames: Record<number, string> = {
        0: 'Empty', 1: 'Active', 2: 'Folded', 3: 'AllIn',
        4: 'SittingOut', 5: 'Busted', 6: 'Leaving',
      };
      console.log(`  Seat ${i}: ${chips} chips, status=${statusNames[status] ?? status}`);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('  Smoke test complete!');
  console.log('='.repeat(70));
}

main().catch((e) => {
  console.error('Smoke test failed:', e);
  process.exit(1);
});
