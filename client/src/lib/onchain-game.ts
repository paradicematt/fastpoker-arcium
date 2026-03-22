import { 
  AccountMeta,
  Connection, 
  PublicKey, 
  Transaction, 
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { ANCHOR_PROGRAM_ID, POOL_PDA, TREASURY, STEEL_PROGRAM_ID, POKER_MINT, TABLE_SEED, SEAT_SEED, SEAT_CARDS_SEED, PLAYER_SEED, VAULT_SEED, RECEIPT_SEED, DEPOSIT_PROOF_SEED, DECK_STATE_SEED, CRANK_TALLY_ER_SEED, CRANK_TALLY_L1_SEED } from './constants';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Anchor instruction discriminators (SHA256("global:<instruction_name>")[0..8])
// Verified from cash-game-1-2-test.ts
const DISCRIMINATORS = {
  createTable: Buffer.from([214, 142, 131, 250, 242, 83, 135, 185]),
  joinTable: Buffer.from([14, 117, 84, 51, 95, 146, 171, 70]),
  startGame: Buffer.from([249, 47, 252, 172, 184, 162, 245, 14]),
  playerAction: Buffer.from([37, 85, 25, 135, 200, 116, 96, 101]),
  settle: Buffer.from([226, 143, 58, 196, 148, 75, 164, 43]),
  delegateGame: Buffer.from([116, 183, 70, 107, 112, 223, 122, 210]),
  leaveTable: Buffer.from([163, 153, 94, 194, 19, 106, 113, 32]),
  distributePrizes: Buffer.from([154, 99, 201, 93, 82, 104, 73, 232]),
  createUserTable: Buffer.from([238, 125, 176, 179, 242, 249, 219, 183]),
  claimCreatorRake: Buffer.from([35, 126, 96, 215, 134, 7, 129, 147]),
  rebuy: Buffer.from([147, 185, 111, 149, 82, 245, 49, 165]),
  closeTable: Buffer.from([149, 214, 44, 14, 190, 244, 132, 48]),
  placeBid: Buffer.from([238, 77, 148, 91, 200, 151, 92, 146]),
  resolveAuction: Buffer.from([191, 112, 64, 241, 38, 232, 227, 26]),
  initRakeVault: Buffer.from([221, 36, 22, 1, 186, 184, 193, 220]),
  depositToVault: Buffer.from([18, 62, 110, 8, 26, 106, 248, 151]),
  claimRakeReward: Buffer.from([144, 116, 141, 203, 98, 126, 82, 193]),
  sitOut: Buffer.from([38, 153, 223, 30, 115, 79, 247, 171]),
  sitIn: Buffer.from([218, 106, 130, 189, 169, 100, 65, 72]),
  awardXp: Buffer.from([166, 38, 214, 182, 43, 11, 145, 119]),
  processRakeDistribution: Buffer.from([192, 192, 59, 121, 214, 43, 153, 54]),
  clearAccumulatedRake: Buffer.from([1, 188, 118, 43, 60, 168, 103, 230]),
  resizeVault: Buffer.from([252, 157, 28, 248, 125, 252, 63, 121]),
  // Pre-created seats architecture
  initTableSeat: Buffer.from([4, 2, 110, 85, 144, 112, 65, 236]),
  delegateTable: Buffer.from([161, 66, 67, 113, 58, 219, 238, 170]),
  delegateSeat: Buffer.from([53, 85, 50, 81, 161, 68, 71, 212]),
  delegateSeatCards: Buffer.from([79, 21, 238, 244, 141, 174, 3, 26]),
  delegateDepositProof: Buffer.from([38, 124, 73, 174, 143, 27, 169, 130]),
  delegateDeckState: Buffer.from([35, 80, 108, 20, 133, 115, 71, 235]),
  delegatePermission: Buffer.from([187, 192, 110, 65, 252, 88, 194, 103]),
  depositForJoin: Buffer.from([99, 149, 87, 125, 87, 44, 45, 46]),
  seatPlayer: Buffer.from([7, 38, 253, 140, 213, 3, 208, 119]),
  cleanupDepositProof: Buffer.from([128, 121, 105, 70, 79, 66, 109, 183]),
  crankRemovePlayer: Buffer.from([114, 166, 140, 236, 207, 233, 19, 217]),
  initializeAuctionConfig: Buffer.from([94, 1, 96, 31, 46, 102, 88, 102]),
  // TEE permission creation + delegation (required for getAccountInfo on TEE)
  createTablePermission: Buffer.from([194, 38, 119, 36, 146, 11, 104, 110]),
  createSeatPermission: Buffer.from([161, 4, 4, 164, 13, 227, 248, 60]),
  createDeckStatePermission: Buffer.from([217, 32, 126, 22, 180, 97, 105, 157]),
  delegateTablePermission: Buffer.from([149, 71, 189, 246, 84, 211, 143, 207]),
  delegateSeatPermission: Buffer.from([110, 176, 51, 3, 248, 220, 36, 196]),
  delegateDeckStatePermission: Buffer.from([118, 187, 69, 88, 192, 76, 153, 111]),
  resetSeatPermission: Buffer.from([39, 40, 118, 229, 222, 61, 232, 208]),
  commitAndUndelegateTable: Buffer.from([254, 12, 101, 73, 32, 39, 120, 188]),
  refundFailedDeposit: Buffer.from([1, 151, 141, 175, 52, 83, 183, 94]),
  useTimeBank: Buffer.from([220, 110, 49, 12, 59, 132, 222, 130]),
  adminListToken: Buffer.from([44, 3, 235, 140, 142, 71, 129, 85]),
  setX25519Key: Buffer.from([0x0e, 0x88, 0x15, 0x54, 0x7a, 0x60, 0x10, 0x8f]),
  arciumClaimCardsQueue: Buffer.from([20, 225, 139, 123, 8, 246, 146, 76]),
};

// Game type values matching Anchor enum
export enum OnChainGameType {
  SitAndGoHeadsUp = 0,
  SitAndGo6Max = 1,
  SitAndGo9Max = 2,
  CashGame = 3,
}

// Stakes values matching Anchor enum
export enum OnChainStakes {
  Micro = 0,  // 5/10
  Low = 1,    // 10/20
  Mid = 2,    // 25/50
  High = 3,   // 50/100
}

// Game phase values from on-chain (Arcium architecture)
// CRITICAL: AwaitingDeal(2) and AwaitingShowdown(8) are NEW — all phases after Starting shifted!
export enum OnChainPhase {
  Waiting = 0,
  Starting = 1,
  AwaitingDeal = 2,        // NEW — MPC shuffle queued, waiting for callback
  Preflop = 3,             // was 2 in old TEE arch
  Flop = 4,                // was 3
  Turn = 5,                // was 4
  River = 6,               // was 5
  Showdown = 7,            // was 6
  AwaitingShowdown = 8,    // NEW — MPC reveal queued, waiting for callback
  Complete = 9,            // was 7
  FlopRevealPending = 10,  // was 8
  TurnRevealPending = 11,  // was 9
  RiverRevealPending = 12, // was 10
}

// Seat status (must match Anchor SeatStatus enum in seat.rs)
export enum SeatStatus {
  Empty = 0,
  Active = 1,
  Folded = 2,
  AllIn = 3,
  SittingOut = 4,
  Busted = 5,
  Leaving = 6,
}

// Action type values (must match Anchor PokerAction enum)
export enum ActionType {
  Fold = 0,
  Check = 1,
  Call = 2,
  Bet = 3,
  Raise = 4,
  AllIn = 5,
  SitOut = 6,
  ReturnToPlay = 7,
  LeaveCashGame = 8,
}

// PDA derivation functions
export function getTablePda(tableId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(TABLE_SEED), Buffer.from(tableId)],
    ANCHOR_PROGRAM_ID
  );
}

export function getSeatPda(tablePda: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEAT_SEED), tablePda.toBuffer(), Buffer.from([seatIndex])],
    ANCHOR_PROGRAM_ID
  );
}

export function getSeatCardsPda(tablePda: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEAT_CARDS_SEED), tablePda.toBuffer(), Buffer.from([seatIndex])],
    ANCHOR_PROGRAM_ID
  );
}

export function getPlayerPda(playerPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PLAYER_SEED), playerPubkey.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

// Generate unique table ID
export function generateTableId(prefix: string = 'sng'): Uint8Array {
  const tableId = new Uint8Array(32);
  const idStr = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const encoder = new TextEncoder();
  const encoded = encoder.encode(idStr);
  tableId.set(encoded.slice(0, Math.min(encoded.length, 32)));
  return tableId;
}

/**
 * Build create_table instruction
 */
export function buildCreateTableInstruction(
  authority: PublicKey,
  tableId: Uint8Array,
  gameType: OnChainGameType,
  stakes: OnChainStakes,
  maxPlayers: number,
  tier: number = 0 // SnGTier enum: 0=Micro,1=Bronze,...5=Diamond
): { instruction: TransactionInstruction; tablePda: PublicKey } {
  const [tablePda] = getTablePda(tableId);

  // Build instruction data: discriminator(8) + table_id(32) + game_type(1) + stakes(1) + max_players(1) + tier(1)
  const data = Buffer.alloc(8 + 32 + 4);
  DISCRIMINATORS.createTable.copy(data, 0);
  Buffer.from(tableId).copy(data, 8);
  data.writeUInt8(gameType, 40);
  data.writeUInt8(stakes, 41);
  data.writeUInt8(maxPlayers, 42);
  data.writeUInt8(tier, 43);

  const instruction = new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  return { instruction, tablePda };
}

/**
 * Build join_table instruction
 * Accounts: player, playerAccount, table, seat, treasury, pool, playerTokenAccount?, tableTokenAccount?, tokenProgram?, systemProgram
 */
// Get player-table marker PDA (prevents same player joining multiple seats)
export function getPlayerTableMarkerPda(player: PublicKey, tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('player_table'), player.toBuffer(), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getVaultPda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getCrankTallyErPda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(CRANK_TALLY_ER_SEED), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getCrankTallyL1Pda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(CRANK_TALLY_L1_SEED), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

export function getReceiptPda(tablePda: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(RECEIPT_SEED), tablePda.toBuffer(), Buffer.from([seatIndex])],
    ANCHOR_PROGRAM_ID
  );
}

export function getDepositProofPda(tablePda: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(DEPOSIT_PROOF_SEED), tablePda.toBuffer(), Buffer.from([seatIndex])],
    ANCHOR_PROGRAM_ID
  );
}

export function getDeckStatePda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(DECK_STATE_SEED), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

/**
 * Build join_table instruction.
 * Accounts must match JoinTable struct (14 accounts):
 *   player, player_account, table, seat, player_table_marker,
 *   vault(Opt), receipt(Opt), treasury(Opt), pool(Opt),
 *   player_token_account(Opt), table_token_account(Opt),
 *   unclaimed_balance(Opt), token_program(Opt), system_program
 *
 * For SNG: vault/receipt/token accounts = PROGRAM_ID (None)
 * For Cash (SOL): vault + receipt = real PDAs, token accounts = PROGRAM_ID
 * For Cash (SPL): vault + receipt + token accounts = real PDAs/ATAs
 */
export function buildJoinTableInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  buyIn: number | bigint,
  opts?: {
    isCashGame?: boolean;
    reserve?: bigint;
    playerTokenAccount?: PublicKey;
    tableTokenAccount?: PublicKey;
    unclaimedBalancePda?: PublicKey;
    tokenProgram?: PublicKey;
  },
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [playerAccountPda] = getPlayerPda(player);
  const [playerTableMarkerPda] = getPlayerTableMarkerPda(player, tablePda);

  const reserve = opts?.reserve ?? BigInt(0);

  // Build instruction data: discriminator(8) + buy_in(8) + seat_index(1) + reserve(8)
  const data = Buffer.alloc(25);
  DISCRIMINATORS.joinTable.copy(data, 0);
  data.writeBigUInt64LE(BigInt(buyIn), 8);
  data.writeUInt8(seatIndex, 16);
  data.writeBigUInt64LE(reserve, 17);

  const isCash = opts?.isCashGame ?? false;
  const [vaultPda] = isCash ? getVaultPda(tablePda) : [ANCHOR_PROGRAM_ID];
  const [receiptPda] = isCash ? getReceiptPda(tablePda, seatIndex) : [ANCHOR_PROGRAM_ID];

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: playerAccountPda, isSigner: false, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      { pubkey: playerTableMarkerPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: isCash },                       // vault
      { pubkey: receiptPda, isSigner: false, isWritable: isCash },                      // receipt
      { pubkey: TREASURY, isSigner: false, isWritable: true },                          // treasury
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },                          // pool
      { pubkey: opts?.playerTokenAccount ?? ANCHOR_PROGRAM_ID, isSigner: false, isWritable: !!opts?.playerTokenAccount }, // player_token_account
      { pubkey: opts?.tableTokenAccount ?? ANCHOR_PROGRAM_ID, isSigner: false, isWritable: !!opts?.tableTokenAccount },  // table_token_account
      { pubkey: opts?.unclaimedBalancePda ?? ANCHOR_PROGRAM_ID, isSigner: false, isWritable: !!opts?.unclaimedBalancePda }, // unclaimed_balance
      { pubkey: opts?.tokenProgram ?? ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build crank_remove_player instruction (permissionless inactive-seat kick)
 */
export function buildCrankRemovePlayerInstruction(
  caller: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  playerWallet: PublicKey,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [unclaimedPda] = getUnclaimedBalancePda(tablePda, playerWallet);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: caller, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      { pubkey: unclaimedPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.crankRemovePlayer,
  });
}

/**
 * Build start_game instruction (called by authority/crank)
 * Contract-level guard: requires deck_state + seat_cards as writable.
 * On TEE, writable accounts that aren't delegated are rejected,
 * preventing games from starting with partially-delegated accounts.
 */
export function buildStartGameInstruction(
  authority: PublicKey,
  tablePda: PublicKey,
  maxPlayers: number = 2,
  seatsOccupied: number = (1 << maxPlayers) - 1,
): TransactionInstruction {
  const data = Buffer.alloc(8);
  DISCRIMINATORS.startGame.copy(data, 0);

  const keys = [
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: getDeckStatePda(tablePda)[0], isSigner: false, isWritable: true },
  ];
  // remaining_accounts: [seats..., seat_cards...] in ascending seat order
  for (let i = 0; i < maxPlayers; i++) {
    if (seatsOccupied & (1 << i)) {
      keys.push({ pubkey: getSeatPda(tablePda, i)[0], isSigner: false, isWritable: true });
    }
  }
  for (let i = 0; i < maxPlayers; i++) {
    if (seatsOccupied & (1 << i)) {
      keys.push({ pubkey: getSeatCardsPda(tablePda, i)[0], isSigner: false, isWritable: true });
    }
  }

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build player_action instruction
 */
export function buildPlayerActionInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  action: ActionType,
  amount?: number,
  sessionTokenPda?: PublicKey,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);

  // Always send 17 bytes: discriminator(8) + action_type(1) + amount(8)
  // Anchor ignores trailing bytes for actions without amount
  const data = Buffer.alloc(17);
  DISCRIMINATORS.playerAction.copy(data, 0);
  data.writeUInt8(action, 8);
  
  if (amount !== undefined) {
    data.writeBigUInt64LE(BigInt(amount), 9);
  }

  // session_token: Option<Account<SessionToken>> — omit entirely when None.
  // CRITICAL: Do NOT pass PROGRAM_ID as placeholder — TEE proxy tries to load it
  // as a regular account and returns 500. Anchor handles missing Optional accounts.
  const keys = [
    { pubkey: player, isSigner: true, isWritable: false },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: seatPda, isSigner: false, isWritable: true },
  ];
  if (sessionTokenPda) {
    keys.push({ pubkey: sessionTokenPda, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build use_time_bank instruction — player activates 15s time extension
 * Accounts: player (signer), table (mut), seat (mut)
 */
export function buildUseTimeBankInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
    ],
    data: DISCRIMINATORS.useTimeBank,
  });
}

/**
 * Build set_x25519_key instruction.
 * Sets the player's x25519 public key for Arcium MPC card encryption.
 * Stored in PlayerSeat.hole_cards_commitment (repurposed 32-byte field).
 * Must be called after join_table, before game starts.
 *
 * Accounts: player(signer), table, seat(mut)
 * Data: discriminator(8) + x25519_pubkey(32) = 40 bytes
 */
export function buildSetX25519KeyInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  x25519Pubkey: Uint8Array,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);

  const data = Buffer.alloc(40);
  DISCRIMINATORS.setX25519Key.copy(data, 0);
  Buffer.from(x25519Pubkey).copy(data, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: seatPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/**
 * Build leave_table instruction
 * Player leaves table, seat + marker PDAs are closed, rent returned
 */
export function buildLeaveTableInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [markerPda] = getPlayerTableMarkerPda(player, tablePda);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      { pubkey: markerPda, isSigner: false, isWritable: true },
      // Optional token accounts (use program ID as placeholder for SNG)
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.leaveTable,
  });
}

/**
 * Parse table account data
 */
export interface TableState {
  tableId: Uint8Array;
  authority: PublicKey;
  pool: PublicKey;
  gameType: OnChainGameType;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  currentPlayers: number;
  handNumber: number;
  pot: number;
  phase: OnChainPhase;
  dealerButton: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  currentPlayer: number;
  currentBet: number;
  communityCards: number[];
  lastActionTime: number;
  tier: number;
  entryAmount: number;
  feeAmount: number;
  prizePool: number;
  blindLevel: number;
  tournamentStartTime: number;
  tokenMint: string;
  seatsOccupied: number;
}

// Verified byte offsets from Table struct in programs/cq-poker/src/state/table.rs
// All offsets include the 8-byte Anchor discriminator
const TABLE_OFFSETS = {
  TABLE_ID: 8,           // [u8; 32]
  AUTHORITY: 40,         // Pubkey
  POOL: 72,              // Pubkey
  GAME_TYPE: 104,        // u8 (enum)
  SMALL_BLIND: 105,      // u64
  BIG_BLIND: 113,        // u64
  MAX_PLAYERS: 121,      // u8
  CURRENT_PLAYERS: 122,  // u8
  HAND_NUMBER: 123,      // u64
  POT: 131,              // u64
  MIN_BET: 139,          // u64
  RAKE_ACCUMULATED: 147, // u64
  COMMUNITY_CARDS: 155,  // [u8; 5]
  PHASE: 160,            // u8 (enum)
  CURRENT_PLAYER: 161,   // u8
  ACTIONS_THIS_ROUND: 162, // u8
  DEALER_BUTTON: 163,    // u8
  SMALL_BLIND_SEAT: 164, // u8
  BIG_BLIND_SEAT: 165,   // u8
  LAST_ACTION_SLOT: 166, // u64
  IS_DELEGATED: 174,     // bool
  REVEALED_HANDS: 175,   // [u8; 18] (9 seats × 2 cards, 255=hidden)
  HAND_RESULTS: 193,     // [u8; 9] (hand rank per seat)
  PRE_COMMUNITY: 202,    // [u8; 5]
  DECK_SEED: 207,        // [u8; 32]
  DECK_INDEX: 239,       // u8
  STAKES_LEVEL: 240,     // u8
  BLIND_LEVEL: 241,      // u8
  TOURNAMENT_START_SLOT: 242, // u64
  SEATS_OCCUPIED: 250,   // u16
  SEATS_ALLIN: 252,      // u16
  SEATS_FOLDED: 254,     // u16
  DEAD_BUTTON: 256,      // bool
  FLOP_REACHED: 257,     // bool
  TOKEN_ESCROW: 258,     // Pubkey
  CREATOR: 290,          // Pubkey
  IS_USER_CREATED: 322,  // bool
  CREATOR_RAKE_TOTAL: 323, // u64
  LAST_RAKE_EPOCH: 331,  // u64
  PRIZES_DISTRIBUTED: 339, // bool
  UNCLAIMED_BALANCE_COUNT: 340, // u8
  BUMP: 341,             // u8
  ELIMINATED_SEATS: 342, // [u8; 9]
  ELIMINATED_COUNT: 351, // u8
  ENTRY_FEES_ESCROWED: 352, // u64
  TIER: 360,             // u8 (SnGTier enum)
  ENTRY_AMOUNT: 361,     // u64 (lamports)
  FEE_AMOUNT: 369,       // u64 (lamports)
  PRIZE_POOL: 377,       // u64 (lamports)
  TOKEN_MINT: 385,       // Pubkey (32 bytes)
  BUY_IN_TYPE: 417,      // u8
  RAKE_CAP: 418,         // u64
  IS_PRIVATE: 426,       // bool
  CRANK_POOL_ACCUMULATED: 427, // u64
  ACTION_NONCE: 435,     // u16
  // Total Table SIZE = 437 bytes
};

export { TABLE_OFFSETS };

export function parseTableState(data: Buffer): TableState | null {
  if (data.length < 385) return null;
  
  try {
    const o = TABLE_OFFSETS;
    
    const tableId = new Uint8Array(data.slice(o.TABLE_ID, o.TABLE_ID + 32));
    const authority = new PublicKey(data.slice(o.AUTHORITY, o.AUTHORITY + 32));
    const pool = new PublicKey(data.slice(o.POOL, o.POOL + 32));
    const gameType = data[o.GAME_TYPE] as OnChainGameType;
    const smallBlind = Number(data.readBigUInt64LE(o.SMALL_BLIND));
    const bigBlind = Number(data.readBigUInt64LE(o.BIG_BLIND));
    const maxPlayers = data[o.MAX_PLAYERS];
    const currentPlayers = data[o.CURRENT_PLAYERS];
    const handNumber = Number(data.readBigUInt64LE(o.HAND_NUMBER));
    const pot = Number(data.readBigUInt64LE(o.POT));
    const minBet = Number(data.readBigUInt64LE(o.MIN_BET));
    const communityCards = Array.from(data.slice(o.COMMUNITY_CARDS, o.COMMUNITY_CARDS + 5));
    const phase = data[o.PHASE] as OnChainPhase;
    const currentPlayer = data[o.CURRENT_PLAYER];
    const dealerButton = data[o.DEALER_BUTTON];
    const smallBlindSeat = data[o.SMALL_BLIND_SEAT];
    const bigBlindSeat = data[o.BIG_BLIND_SEAT];
    const lastActionSlot = Number(data.readBigUInt64LE(o.LAST_ACTION_SLOT));
    
    return {
      tableId,
      authority,
      pool,
      gameType,
      smallBlind,
      bigBlind,
      maxPlayers,
      currentPlayers,
      handNumber,
      pot,
      phase,
      dealerButton,
      smallBlindSeat,
      bigBlindSeat,
      currentPlayer,
      currentBet: minBet,
      communityCards,
      lastActionTime: lastActionSlot,
      tier: data[o.TIER],
      entryAmount: Number(data.readBigUInt64LE(o.ENTRY_AMOUNT)),
      feeAmount: Number(data.readBigUInt64LE(o.FEE_AMOUNT)),
      prizePool: Number(data.readBigUInt64LE(o.PRIZE_POOL)),
      blindLevel: data[o.BLIND_LEVEL],
      tournamentStartTime: Number(data.readBigUInt64LE(o.TOURNAMENT_START_SLOT)),
      seatsOccupied: data.readUInt16LE(o.SEATS_OCCUPIED),
      tokenMint: data.length >= 385 + 32
        ? new PublicKey(data.slice(o.TOKEN_MINT, o.TOKEN_MINT + 32)).toBase58()
        : PublicKey.default.toBase58(),
    };
  } catch (e) {
    console.error('Failed to parse table state:', e);
    return null;
  }
}

/**
 * Parse seat account data
 */
export interface SeatState {
  player: PublicKey;
  sessionKey: PublicKey;
  table: PublicKey;
  chips: number;
  betThisRound: number;
  totalBetThisHand: number;
  seatIndex: number;
  status: SeatStatus;
  sitOutButtonCount: number;
  handsSinceBust: number;
  sitOutTimestamp: number;
  timeBankSeconds: number;
  timeBankActive: boolean;
}

// Verified byte offsets from PlayerSeat struct in programs/cq-poker/src/state/seat.rs
const SEAT_OFFSETS = {
  WALLET: 8,                    // Pubkey (32)
  SESSION_KEY: 40,              // Pubkey (32)
  TABLE: 72,                    // Pubkey (32)
  CHIPS: 104,                   // u64
  BET_THIS_ROUND: 112,          // u64
  TOTAL_BET_THIS_HAND: 120,     // u64
  HOLE_CARDS_ENCRYPTED: 128,    // [u8; 64]
  HOLE_CARDS_COMMITMENT: 192,   // [u8; 32]
  HOLE_CARDS: 224,              // [u8; 2]
  SEAT_NUMBER: 226,             // u8
  STATUS: 227,                  // u8 (SeatStatus enum)
  LAST_ACTION_SLOT: 228,        // u64
  MISSED_SB: 236,               // bool
  MISSED_BB: 237,               // bool
  POSTED_BLIND: 238,            // bool
  WAITING_FOR_BB: 239,          // bool
  SIT_OUT_BUTTON_COUNT: 240,    // u8
  HANDS_SINCE_BUST: 241,        // u8
  AUTO_FOLD_COUNT: 242,         // u8
  MISSED_BB_COUNT: 243,         // u8
  BUMP: 244,                    // u8
  PAID_ENTRY: 245,              // bool
  CASHOUT_CHIPS: 246,           // u64
  CASHOUT_NONCE: 254,           // u64
  VAULT_RESERVE: 262,           // u64
  SIT_OUT_TIMESTAMP: 270,       // i64
  TIME_BANK_SECONDS: 278,       // u16
  TIME_BANK_ACTIVE: 280,        // bool
};

export { SEAT_OFFSETS };

export function parseSeatState(data: Buffer): SeatState | null {
  if (data.length < 245) return null;
  
  try {
    const o = SEAT_OFFSETS;
    
    const player = new PublicKey(data.slice(o.WALLET, o.WALLET + 32));
    const sessionKey = new PublicKey(data.slice(o.SESSION_KEY, o.SESSION_KEY + 32));
    const table = new PublicKey(data.slice(o.TABLE, o.TABLE + 32));
    const chips = Number(data.readBigUInt64LE(o.CHIPS));
    const betThisRound = Number(data.readBigUInt64LE(o.BET_THIS_ROUND));
    const totalBetThisHand = Number(data.readBigUInt64LE(o.TOTAL_BET_THIS_HAND));
    const seatIndex = data[o.SEAT_NUMBER];
    const status = data[o.STATUS] as SeatStatus;
    const sitOutButtonCount = data.length > o.SIT_OUT_BUTTON_COUNT ? data[o.SIT_OUT_BUTTON_COUNT] : 0;
    const handsSinceBust = data.length > o.HANDS_SINCE_BUST ? data[o.HANDS_SINCE_BUST] : 0;
    const sitOutTimestamp =
      data.length >= o.SIT_OUT_TIMESTAMP + 8
        ? Number(data.readBigInt64LE(o.SIT_OUT_TIMESTAMP))
        : 0;
    const timeBankSeconds =
      data.length >= o.TIME_BANK_SECONDS + 2
        ? data.readUInt16LE(o.TIME_BANK_SECONDS)
        : 0;
    const timeBankActive =
      data.length > o.TIME_BANK_ACTIVE
        ? data[o.TIME_BANK_ACTIVE] === 1
        : false;
    
    return {
      player,
      sessionKey,
      table,
      chips,
      betThisRound,
      totalBetThisHand,
      seatIndex,
      status,
      sitOutButtonCount,
      handsSinceBust,
      sitOutTimestamp,
      timeBankSeconds,
      timeBankActive,
    };
  } catch (e) {
    console.error('Failed to parse seat state:', e);
    return null;
  }
}

/**
 * Parse seat cards (hole cards) - only visible to the player
 */
export interface SeatCardsState {
  table: PublicKey;
  seatIndex: number;
  player: PublicKey;
  card1: number;
  card2: number;
}

export function parseSeatCardsState(data: Buffer): SeatCardsState | null {
  if (data.length < 76) return null;
  
  try {
    let offset = 8; // Skip discriminator
    
    // table: Pubkey
    const table = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;
    
    // seat_index: u8
    const seatIndex = data[offset];
    offset += 1;
    
    // player: Pubkey
    const player = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;
    
    // card1: u8
    const card1 = data[offset];
    offset += 1;
    
    // card2: u8
    const card2 = data[offset];
    
    return { table, seatIndex, player, card1, card2 };
  } catch (e) {
    console.error('Failed to parse seat cards:', e);
    return null;
  }
}

/**
 * Convert on-chain phase to display string
 */
export function phaseToString(phase: OnChainPhase): string {
  switch (phase) {
    case OnChainPhase.Waiting: return 'Waiting';
    case OnChainPhase.Starting: return 'Starting';
    case OnChainPhase.AwaitingDeal: return 'AwaitingDeal';
    case OnChainPhase.Preflop: return 'PreFlop';
    case OnChainPhase.Flop: return 'Flop';
    case OnChainPhase.Turn: return 'Turn';
    case OnChainPhase.River: return 'River';
    case OnChainPhase.Showdown: return 'Showdown';
    case OnChainPhase.AwaitingShowdown: return 'AwaitingShowdown';
    case OnChainPhase.Complete: return 'Complete';
    case OnChainPhase.FlopRevealPending: return 'FlopRevealPending';
    case OnChainPhase.TurnRevealPending: return 'TurnRevealPending';
    case OnChainPhase.RiverRevealPending: return 'RiverRevealPending';
    default: return 'Unknown';
  }
}

// ============================================
// CASH GAME TABLE HELPERS
// ============================================

/**
 * Build create_user_table instruction (cash game, creator earns 25% rake)
 * New UserTableConfig: table_id(32) + max_players(1) + small_blind(8) + big_blind(8) + token_mint(32)
 *
 * For SOL tables (tokenMint = PublicKey.default):
 *   - Fee = 1 BB in SOL (system_program::transfer)
 *   - creator_token_account / treasury_token_account / token_program = PROGRAM_ID placeholder
 *
 * For SPL token tables (POKER, USDC, auction-listed):
 *   - Fee = 1 BB in the table's token (token::transfer)
 *   - creator_token_account = creator's ATA for the mint
 *   - treasury_token_account = treasury's ATA for the mint
 *   - token_program = TOKEN_PROGRAM_ID
 */
export function buildCreateUserTableInstruction(
  creator: PublicKey,
  tableId: Uint8Array,
  smallBlind: bigint,
  bigBlind: bigint,
  maxPlayers: number,
  tokenMint: PublicKey = PublicKey.default,
  creatorTokenAccount?: PublicKey,
  treasuryTokenAccount?: PublicKey,
  buyInType: number = 0, // 0=Normal, 1=Deep Stack
  poolTokenAccount?: PublicKey,
  isPrivate: boolean = false,
): { instruction: TransactionInstruction; tablePda: PublicKey } {
  const [tablePda] = getTablePda(tableId);

  const isSol = tokenMint.equals(PublicKey.default);

  // UserTableConfig: table_id(32) + max_players(1) + small_blind(8) + big_blind(8) + token_mint(32) + buy_in_type(1) + is_private(1)
  const data = Buffer.alloc(8 + 32 + 1 + 8 + 8 + 32 + 1 + 1);
  DISCRIMINATORS.createUserTable.copy(data, 0);
  Buffer.from(tableId).copy(data, 8);
  data.writeUInt8(maxPlayers, 40);
  data.writeBigUInt64LE(smallBlind, 41);
  data.writeBigUInt64LE(bigBlind, 49);
  tokenMint.toBuffer().copy(data, 57);
  data.writeUInt8(buyInType, 89);
  data.writeUInt8(isPrivate ? 1 : 0, 90);

  const [vaultPda] = getVaultPda(tablePda);

  // Core accounts — order must match CreateUserTable struct in contract
  const keys = [
    { pubkey: creator, isSigner: true, isWritable: true },
    { pubkey: tablePda, isSigner: false, isWritable: true },
    { pubkey: POOL_PDA, isSigner: false, isWritable: true },
    { pubkey: TREASURY, isSigner: false, isWritable: true },
    { pubkey: creatorTokenAccount ?? ANCHOR_PROGRAM_ID, isSigner: false, isWritable: !isSol },
    { pubkey: treasuryTokenAccount ?? ANCHOR_PROGRAM_ID, isSigner: false, isWritable: !isSol },
    { pubkey: poolTokenAccount ?? ANCHOR_PROGRAM_ID, isSigner: false, isWritable: !isSol },
    { pubkey: isSol ? ANCHOR_PROGRAM_ID : TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  // Non-premium tokens (auction-listed): append ListedToken PDA as remaining_accounts[0]
  const isPremium = isSol || tokenMint.equals(POKER_MINT);
  if (!isPremium) {
    keys.push({ pubkey: getListedTokenPda(tokenMint), isSigner: false, isWritable: false });
  }

  const instruction = new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys,
    data,
  });

  return { instruction, tablePda };
}

// ============================================
// PRE-CREATED SEATS ARCHITECTURE
// ============================================

/**
 * Build init_table_seat instruction — creates seat PDA + seat_cards PDA on L1.
 * Called once per seat during table setup. Creator pays rent.
 * Arcium: no Permission PDAs needed (privacy via MPC, not TEE access control).
 */
export function buildInitTableSeatInstruction(
  creator: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
  const [deckStatePda] = getDeckStatePda(tablePda);
  const [receiptPda] = getReceiptPda(tablePda, seatIndex);
  const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);
  const [vaultPda] = getVaultPda(tablePda);
  const [crankTallyErPda] = getCrankTallyErPda(tablePda);
  const [crankTallyL1Pda] = getCrankTallyL1Pda(tablePda);

  const data = Buffer.alloc(9);
  DISCRIMINATORS.initTableSeat.copy(data, 0);
  data.writeUInt8(seatIndex, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      { pubkey: seatCardsPda, isSigner: false, isWritable: true },
      { pubkey: deckStatePda, isSigner: false, isWritable: true },
      { pubkey: receiptPda, isSigner: false, isWritable: true },
      { pubkey: depositProofPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: crankTallyErPda, isSigner: false, isWritable: true },
      { pubkey: crankTallyL1Pda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build process_rake_distribution instruction (L1)
 * Parameterless: contract reads committed table data and routes shares on-chain.
 */
export function buildProcessRakeDistributionInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  isUserCreated: boolean,
  creatorWallet: PublicKey,
): TransactionInstruction {
  const [vaultPda] = getVaultPda(tablePda);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: isUserCreated ? creatorWallet : TREASURY, isSigner: false, isWritable: true },
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.processRakeDistribution,
  });
}

/**
 * Build clear_accumulated_rake instruction (ER)
 * Zeroes table.rake_accumulated after successful L1 distribution
 */
export function buildClearAccumulatedRakeInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: tablePda, isSigner: false, isWritable: true },
    ],
    data: DISCRIMINATORS.clearAccumulatedRake,
  });
}

/**
 * Build close_table instruction
 * Closes a table and returns rent to creator. Cash games: must have 0 players.
 *
 * remaining_accounts layout (per seat): [player_wallet, seat_pda, seat_cards_pda, marker_pda]
 * After all seats: vault_pda, receipt PDAs (one per seat)
 *
 * Always uses creator as wallet for all seats — creator paid for all PDA rent at
 * init_table_seat, so all rent returns to creator. This also keeps unique account
 * keys minimal (~33 for 9-max) to fit within Solana's 1232-byte TX limit.
 */
export function buildCloseTableInstruction(
  payer: PublicKey,
  tablePda: PublicKey,
  creator: PublicKey,
  maxPlayers: number = 0,
): TransactionInstruction {
  const remaining: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];

  // Per-seat groups of 4: [player_wallet, seat_pda, seat_cards_pda, marker_pda]
  // Use creator for all wallets — they paid the rent, they get it back.
  // This also ensures only 1 unique marker PDA (all derived from same wallet+table).
  const [markerPda] = getPlayerTableMarkerPda(creator, tablePda);
  for (let i = 0; i < maxPlayers; i++) {
    const [seatPda] = getSeatPda(tablePda, i);
    const [seatCardsPda] = getSeatCardsPda(tablePda, i);

    remaining.push(
      { pubkey: creator, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
      { pubkey: seatCardsPda, isSigner: false, isWritable: true },
      { pubkey: markerPda, isSigner: false, isWritable: true },
    );
  }

  // Vault, DeckState, and receipt PDAs — rent goes to creator
  const [vaultPda] = getVaultPda(tablePda);
  remaining.push({ pubkey: vaultPda, isSigner: false, isWritable: true });

  const [deckStatePda] = getDeckStatePda(tablePda);
  remaining.push({ pubkey: deckStatePda, isSigner: false, isWritable: true });

  for (let i = 0; i < maxPlayers; i++) {
    const [receiptPda] = getReceiptPda(tablePda, i);
    remaining.push({ pubkey: receiptPda, isSigner: false, isWritable: true });
  }

  for (let i = 0; i < maxPlayers; i++) {
    const [depositProofPda] = getDepositProofPda(tablePda, i);
    remaining.push({ pubkey: depositProofPda, isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: creator, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...remaining,
    ],
    data: DISCRIMINATORS.closeTable,
  });
}


/**
 * Build sit_out instruction (cash games — player stays at table but skips hands)
 */
export function buildSitOutInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
    ],
    data: DISCRIMINATORS.sitOut,
  });
}

/**
 * Build sit_in instruction (return from sitting out)
 * post_missed_blinds: if true, deducts missed BB/SB from chips immediately
 */
export function buildSitInInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  seatIndex: number,
  postMissedBlinds: boolean = true
): TransactionInstruction {
  const [seatPda] = getSeatPda(tablePda, seatIndex);
  // Data: discriminator(8) + post_missed_blinds(1)
  const data = Buffer.alloc(9);
  DISCRIMINATORS.sitIn.copy(data, 0);
  data.writeUInt8(postMissedBlinds ? 1 : 0, 8);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

export { DISCRIMINATORS };

// ============================================
// UNCLAIMED BALANCE HELPERS (Cash Games)
// ============================================

const UNCLAIMED_SEED = 'unclaimed';

// Additional discriminators for unclaimed balance instructions
const UNCLAIMED_DISCRIMINATORS = {
  forceReleaseSeat: Buffer.from([0x5f, 0x8c, 0x1e, 0x2d, 0x3a, 0x4b, 0x5c, 0x6d]), // Will be updated from IDL
  claimUnclaimed: Buffer.from([0x1a, 0x2b, 0x3c, 0x4d, 0x5e, 0x6f, 0x7a, 0x8b]),
  claimUnclaimedSol: Buffer.from([0x87, 0x3d, 0x87, 0x0e, 0xab, 0x2b, 0x3e, 0x0b]),
  reclaimExpired: Buffer.from([0x9c, 0xad, 0xbe, 0xcf, 0xda, 0xeb, 0xfc, 0x0d]),
};

/**
 * Get UnclaimedBalance PDA for a player at a specific table
 * Seeds: ["unclaimed", table_pubkey, player_pubkey]
 */
export function getUnclaimedBalancePda(tablePda: PublicKey, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(UNCLAIMED_SEED), tablePda.toBuffer(), player.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

/**
 * Get escrow authority PDA for a table (controls token escrow)
 * Seeds: ["escrow", table_pubkey]
 */
export function getEscrowAuthorityPda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), tablePda.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

/**
 * Check if an unclaimed balance exists for a player at a table
 */
export async function checkUnclaimedBalance(
  connection: Connection,
  tablePda: PublicKey,
  player: PublicKey
): Promise<{ exists: boolean; amount: number; lastActiveAt: number } | null> {
  const [unclaimedPda] = getUnclaimedBalancePda(tablePda, player);
  
  try {
    const accountInfo = await connection.getAccountInfo(unclaimedPda);
    if (!accountInfo || accountInfo.data.length === 0) {
      return { exists: false, amount: 0, lastActiveAt: 0 };
    }
    
    // Parse UnclaimedBalance: discriminator(8) + player(32) + table(32) + amount(8) + last_active_at(8) + bump(1)
    const data = accountInfo.data;
    const amount = Number(data.readBigUInt64LE(72)); // 8 + 32 + 32 = 72
    const lastActiveAt = Number(data.readBigInt64LE(80)); // 72 + 8 = 80
    
    return { exists: true, amount, lastActiveAt };
  } catch (e) {
    console.error('Failed to check unclaimed balance:', e);
    return null;
  }
}

/**
 * Build claim_unclaimed instruction (player claims their unclaimed balance)
 */
export function buildClaimUnclaimedInstruction(
  player: PublicKey,
  tablePda: PublicKey,
  tableTokenAccount: PublicKey,
  playerTokenAccount: PublicKey
): TransactionInstruction {
  const [unclaimedPda] = getUnclaimedBalancePda(tablePda, player);
  const [escrowAuthorityPda] = getEscrowAuthorityPda(tablePda);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: unclaimedPda, isSigner: false, isWritable: true },
      { pubkey: tableTokenAccount, isSigner: false, isWritable: true },
      { pubkey: playerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: escrowAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: UNCLAIMED_DISCRIMINATORS.claimUnclaimed,
  });
}

/**
 * Build claim_unclaimed_sol instruction (SOL tables — lamports from table PDA)
 * PERMISSIONLESS: anyone can call it. SOL goes to playerWallet, rent to caller.
 * For player self-claim, caller == playerWallet.
 */
export function buildClaimUnclaimedSolInstruction(
  caller: PublicKey,
  tablePda: PublicKey,
  playerWallet?: PublicKey,
): TransactionInstruction {
  const wallet = playerWallet || caller;
  const [unclaimedPda] = getUnclaimedBalancePda(tablePda, wallet);

  // Instruction data: discriminator(8) + player_wallet(32)
  const data = Buffer.alloc(40);
  UNCLAIMED_DISCRIMINATORS.claimUnclaimedSol.copy(data, 0);
  wallet.toBuffer().copy(data, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: caller, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: unclaimedPda, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build reclaim_expired instruction (creator reclaims expired unclaimed balance)
 */
export function buildReclaimExpiredInstruction(
  creator: PublicKey,
  tablePda: PublicKey,
  player: PublicKey, // Player whose expired balance to reclaim
  tableTokenAccount: PublicKey,
  creatorTokenAccount: PublicKey
): TransactionInstruction {
  const [unclaimedPda] = getUnclaimedBalancePda(tablePda, player);
  const [escrowAuthorityPda] = getEscrowAuthorityPda(tablePda);

  // Instruction data: discriminator(8) + player(32)
  const data = Buffer.alloc(40);
  UNCLAIMED_DISCRIMINATORS.reclaimExpired.copy(data, 0);
  player.toBuffer().copy(data, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: unclaimedPda, isSigner: false, isWritable: true },
      { pubkey: tableTokenAccount, isSigner: false, isWritable: true },
      { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: escrowAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}


/**
 * Calculate if an unclaimed balance is expired (100 days from last_active_at)
 */
export function isUnclaimedExpired(lastActiveAt: number): boolean {
  const UNCLAIMED_EXPIRY_SECONDS = 100 * 24 * 60 * 60; // 100 days
  const now = Math.floor(Date.now() / 1000);
  return now >= lastActiveAt + UNCLAIMED_EXPIRY_SECONDS;
}

/**
 * Calculate days until unclaimed balance expires
 */
export function daysUntilExpiry(lastActiveAt: number): number {
  const UNCLAIMED_EXPIRY_SECONDS = 100 * 24 * 60 * 60; // 100 days
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = lastActiveAt + UNCLAIMED_EXPIRY_SECONDS;
  const secondsRemaining = expiresAt - now;
  return Math.max(0, Math.ceil(secondsRemaining / (24 * 60 * 60)));
}

// ─── Token Listing Auction Instructions (Permissionless) ───
// Epoch tracked by AuctionConfig singleton PDA (adaptive duration).
// Legacy fallback: Math.floor(unixTimestamp / 604800) for old epochs.

const AUCTION_EPOCH_SECS = 604_800;
const AUCTION_SEED = Buffer.from('auction');
const AUCTION_CONFIG_SEED = Buffer.from('auction_config');
const LISTED_TOKEN_SEED = Buffer.from('listed_token');
const TOKEN_BID_SEED = Buffer.from('token_bid');
const BID_CONTRIBUTION_SEED = Buffer.from('bid_contrib');
const GLOBAL_BID_SEED = Buffer.from('global_bid');
const GLOBAL_CONTRIB_SEED = Buffer.from('global_contrib');

/** AuctionConfig singleton PDA */
export function getAuctionConfigPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [AUCTION_CONFIG_SEED],
    ANCHOR_PROGRAM_ID,
  );
  return pda;
}

/** Parse AuctionConfig from on-chain data */
export function parseAuctionConfig(data: Buffer): {
  currentEpoch: bigint;
  currentEpochStart: number;
  currentEpochDuration: number;
  lastTotalBid: bigint;
} {
  return {
    currentEpoch: data.readBigUInt64LE(8),
    currentEpochStart: Number(data.readBigInt64LE(16)),
    currentEpochDuration: Number(data.readBigInt64LE(24)),
    lastTotalBid: data.readBigUInt64LE(32),
  };
}

/** Fallback: compute wall-clock epoch (for old/legacy epochs before config existed) */
export function getCurrentAuctionEpoch(): bigint {
  return BigInt(Math.floor(Date.now() / 1000 / AUCTION_EPOCH_SECS));
}

/** Fallback: wall-clock based end time */
export function getAuctionEndTime(epoch: bigint): number {
  return Number((epoch + BigInt(1)) * BigInt(AUCTION_EPOCH_SECS)) * 1000; // ms
}

export function getAuctionPda(epoch: bigint): PublicKey {
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(epoch);
  const [pda] = PublicKey.findProgramAddressSync(
    [AUCTION_SEED, epochBuf],
    ANCHOR_PROGRAM_ID,
  );
  return pda;
}

/** Legacy per-epoch TokenBid PDA (for old epoch data) */
export function getTokenBidPda(epoch: bigint, candidateMint: PublicKey): PublicKey {
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(epoch);
  const [pda] = PublicKey.findProgramAddressSync(
    [TOKEN_BID_SEED, epochBuf, candidateMint.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
  return pda;
}

/** Legacy per-epoch BidContribution PDA */
export function getBidContributionPda(epoch: bigint, candidateMint: PublicKey, bidder: PublicKey): PublicKey {
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(epoch);
  const [pda] = PublicKey.findProgramAddressSync(
    [BID_CONTRIBUTION_SEED, epochBuf, candidateMint.toBuffer(), bidder.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
  return pda;
}

/** Global persistent bid PDA — carries across epochs. Seeds: ["global_bid", mint] */
export function getGlobalBidPda(candidateMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [GLOBAL_BID_SEED, candidateMint.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
  return pda;
}

/** Global persistent contribution PDA. Seeds: ["global_contrib", mint, bidder] */
export function getGlobalContribPda(candidateMint: PublicKey, bidder: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [GLOBAL_CONTRIB_SEED, candidateMint.toBuffer(), bidder.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
  return pda;
}

/** Parse GlobalTokenBid (53 bytes) from on-chain data */
export function parseGlobalTokenBid(data: Buffer): { tokenMint: string; totalAmount: bigint; bidderCount: number } | null {
  if (data.length < 53) return null;
  return {
    tokenMint: new PublicKey(data.subarray(8, 40)).toBase58(),
    totalAmount: data.readBigUInt64LE(40),
    bidderCount: data.readUInt32LE(48),
  };
}

/** GlobalTokenBid account size for getProgramAccounts filter */
export const GLOBAL_BID_DATA_SIZE = 53;

/** GlobalBidContribution account size (90 bytes) for getProgramAccounts filter */
export const GLOBAL_CONTRIB_DATA_SIZE = 90;

/**
 * Bid SOL for a candidate token mint to be listed.
 * CPI into Steel's DepositPublicRevenue — Steel handles 50/50 split
 * (treasury + pool for staker rewards) and updates staker accounting.
 * Permissionless — auto-creates auction PDA for current epoch on first bid.
 */
export function buildPlaceBidInstruction(
  bidder: PublicKey,
  candidateMint: PublicKey,
  amountLamports: bigint,
  epoch: bigint,
  anchorVote?: bigint,
): TransactionInstruction {
  const configPda = getAuctionConfigPda();
  const auctionPda = getAuctionPda(epoch);
  const globalBidPda = getGlobalBidPda(candidateMint);
  const globalContribPda = getGlobalContribPda(candidateMint, bidder);

  // Anchor serializes Option<u64> as: 1 byte tag (0=None, 1=Some) + 8 bytes value if Some
  const anchorVoteSize = anchorVote !== undefined ? 9 : 1; // 1 tag + 8 value, or just 1 tag (None)
  const data = Buffer.alloc(8 + 8 + 8 + anchorVoteSize);
  Buffer.from(DISCRIMINATORS.placeBid).copy(data, 0);
  data.writeBigUInt64LE(epoch, 8);
  data.writeBigUInt64LE(amountLamports, 16);
  if (anchorVote !== undefined) {
    data[24] = 1; // Some tag
    data.writeBigUInt64LE(anchorVote, 25);
  } else {
    data[24] = 0; // None tag
  }

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: bidder, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: auctionPda, isSigner: false, isWritable: true },
      { pubkey: candidateMint, isSigner: false, isWritable: false },
      { pubkey: globalBidPda, isSigner: false, isWritable: true },
      { pubkey: globalContribPda, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function getListedTokenPda(tokenMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [LISTED_TOKEN_SEED, tokenMint.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
  return pda;
}

/** ListedToken account size for getProgramAccounts filter */
export const LISTED_TOKEN_DATA_SIZE = 57; // 8 disc + 32 mint + 8 epoch + 8 listed_at + 1 bump

/** Parse ListedToken from on-chain data */
export function parseListedToken(data: Buffer): { tokenMint: string; winningEpoch: bigint; listedAt: number } | null {
  if (data.length < 57) return null;
  return {
    tokenMint: new PublicKey(data.subarray(8, 40)).toBase58(),
    winningEpoch: data.readBigUInt64LE(40),
    listedAt: Number(data.readBigInt64LE(48)),
  };
}

/**
 * Resolve an ended auction epoch — permissionless, anyone (crank) can call.
 * Pass the winning TokenBid PDA (highest total_amount for that epoch).
 * Creates a ListedToken PDA so the winning mint can be used for cash game tables.
 */
export function getTierConfigPda(tokenMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('tier_config'), tokenMint.toBuffer()],
    ANCHOR_PROGRAM_ID,
  )[0];
}

export function buildResolveAuctionInstruction(
  payer: PublicKey,
  epoch: bigint,
  winningMint: PublicKey,
  computedAnchor: bigint = BigInt(0),
): TransactionInstruction {
  const configPda = getAuctionConfigPda();
  const auctionPda = getAuctionPda(epoch);
  const winningBidPda = getGlobalBidPda(winningMint);
  const listedTokenPda = getListedTokenPda(winningMint);
  const tierConfigPda = getTierConfigPda(winningMint);

  const data = Buffer.alloc(8 + 8);
  Buffer.from(DISCRIMINATORS.resolveAuction).copy(data, 0);
  data.writeBigUInt64LE(computedAnchor, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: auctionPda, isSigner: false, isWritable: true },
      { pubkey: winningBidPda, isSigner: false, isWritable: true },
      { pubkey: listedTokenPda, isSigner: false, isWritable: true },
      { pubkey: tierConfigPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Admin-only: manually create a ListedToken PDA for a token mint.
 * Bypasses auction epoch — used to restore listings after redeploy.
 */
export function buildAdminListTokenInstruction(
  admin: PublicKey,
  tokenMint: PublicKey,
  epoch: bigint,
): TransactionInstruction {
  const listedTokenPda = getListedTokenPda(tokenMint);
  const data = Buffer.alloc(16);
  DISCRIMINATORS.adminListToken.copy(data, 0);
  data.writeBigUInt64LE(epoch, 8);
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: listedTokenPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildInitializeAuctionConfigInstruction(
  payer: PublicKey,
): TransactionInstruction {
  const configPda = getAuctionConfigPda();
  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.initializeAuctionConfig),
  });
}

// ─── Rake Vault Instructions ───

const RAKE_VAULT_SEED = Buffer.from('rake_vault');
const STAKER_CLAIM_SEED = Buffer.from('staker_claim');

export function getRakeVaultPda(tokenMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [RAKE_VAULT_SEED, tokenMint.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
  return pda;
}

export function getStakerClaimPda(rakeVault: PublicKey, staker: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [STAKER_CLAIM_SEED, rakeVault.toBuffer(), staker.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
  return pda;
}

/**
 * Admin: initialize a RakeVault for a token mint
 */
export function buildInitRakeVaultInstruction(
  admin: PublicKey,
  tokenMint: PublicKey,
  vaultTokenAccount: PublicKey,
): TransactionInstruction {
  const rakeVaultPda = getRakeVaultPda(tokenMint);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: rakeVaultPda, isSigner: false, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.initRakeVault),
  });
}

/**
 * Deposit rake tokens into a vault (crank calls after distribute_rake)
 */
export function buildDepositToVaultInstruction(
  depositor: PublicKey,
  tokenMint: PublicKey,
  sourceTokenAccount: PublicKey,
  vaultTokenAccount: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const rakeVaultPda = getRakeVaultPda(tokenMint);
  const data = Buffer.alloc(8 + 8);
  Buffer.from(DISCRIMINATORS.depositToVault).copy(data, 0);
  data.writeBigUInt64LE(amount, 8);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: rakeVaultPda, isSigner: false, isWritable: true },
      { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Staker claims their proportional share of rake from a vault
 */
export function buildClaimRakeRewardInstruction(
  staker: PublicKey,
  tokenMint: PublicKey,
  vaultTokenAccount: PublicKey,
  stakerTokenAccount: PublicKey,
  pool: PublicKey,
  stakeAccount: PublicKey,
): TransactionInstruction {
  const rakeVaultPda = getRakeVaultPda(tokenMint);
  const stakerClaimPda = getStakerClaimPda(rakeVaultPda, staker);

  return new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: staker, isSigner: true, isWritable: true },
      { pubkey: rakeVaultPda, isSigner: false, isWritable: true },
      { pubkey: stakerClaimPda, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: stakerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: stakeAccount, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.claimRakeReward),
  });
}
