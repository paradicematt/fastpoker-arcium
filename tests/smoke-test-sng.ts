/**
 * Smoke Test: SNG (Sit & Go) Game Loop on Local Validator
 *
 * Tests the SNG-specific flow (HU SNG, Micro tier):
 *   1. Register 2 players
 *   2. Create HU SNG table (GameType=0, Tier=Micro)
 *   3. Init table seats (seat 0, seat 1)
 *   4. Join table — SNG buy-in (entry + fee transferred to table PDA)
 *   5. Start game — requires full table (2/2)
 *   6. devnet_bypass_deal → Preflop (blinds 10/20, chips 1500)
 *   7. Player fold → settle (fold-win fast-path)
 *   8. Verify SNG state (chips, blinds, tournament_start_slot)
 *
 * Run: npx ts-node smoke-test-sng.ts
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
const TABLE_AUTHORITY_SEED = Buffer.from('table_authority');
const UNREFINED_SEED = Buffer.from('unrefined');

// ============================================================
// Discriminators
// ============================================================
function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));
}

const IX = {
  register_player: disc('register_player'),
  create_table: disc('create_table'),
  init_table_seat: disc('init_table_seat'),
  join_table: disc('join_table'),
  start_game: disc('start_game'),
  devnet_bypass_deal: disc('devnet_bypass_deal'),
  player_action: disc('player_action'),
  settle_hand: disc('settle_hand'),
};

// ============================================================
// PDA Helpers
// ============================================================
const pda = (seeds: Buffer[], prog = FASTPOKER_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, prog)[0];

const tablePda = (id: Buffer) => pda([TABLE_SEED, id]);
const seatPda = (t: PublicKey, i: number) => pda([SEAT_SEED, t.toBuffer(), Buffer.from([i])]);
const seatCardsPda = (t: PublicKey, i: number) => pda([SEAT_CARDS_SEED, t.toBuffer(), Buffer.from([i])]);
const deckStatePda = (t: PublicKey) => pda([DECK_STATE_SEED, t.toBuffer()]);
const vaultPda = (t: PublicKey) => pda([VAULT_SEED, t.toBuffer()]);
const receiptPda = (t: PublicKey, i: number) => pda([RECEIPT_SEED, t.toBuffer(), Buffer.from([i])]);
const depositProofPda = (t: PublicKey, i: number) => pda([DEPOSIT_PROOF_SEED, t.toBuffer(), Buffer.from([i])]);
const playerPda = (w: PublicKey) => pda([PLAYER_SEED, w.toBuffer()]);
const markerPda = (w: PublicKey, t: PublicKey) => pda([PLAYER_TABLE_SEED, w.toBuffer(), t.toBuffer()]);
const crankTallyErPda = (t: PublicKey) => pda([CRANK_TALLY_ER_SEED, t.toBuffer()]);
const crankTallyL1Pda = (t: PublicKey) => pda([CRANK_TALLY_L1_SEED, t.toBuffer()]);
const poolPda = () => pda([Buffer.from('pool')], STEEL_PROGRAM_ID);
const unrefinedPda = (w: PublicKey) => pda([UNREFINED_SEED, w.toBuffer()], STEEL_PROGRAM_ID);

// ============================================================
// Serialization
// ============================================================
// TableConfig: table_id(32) + game_type(u8) + stakes(u8) + max_players(u8) + tier(u8)
function serializeTableConfig(tableId: Buffer, gameType: number, stakes: number, maxPlayers: number, tier: number): Buffer {
  const buf = Buffer.alloc(36);
  tableId.copy(buf, 0, 0, 32);
  buf.writeUInt8(gameType, 32);
  buf.writeUInt8(stakes, 33);
  buf.writeUInt8(maxPlayers, 34);
  buf.writeUInt8(tier, 35);
  return buf;
}

// ============================================================
// Table State Reader
// ============================================================
const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop',
  4: 'Flop', 5: 'Turn', 6: 'River', 7: 'Showdown',
  8: 'AwaitingShowdown', 9: 'Complete', 10: 'FlopRevealPending',
  11: 'TurnRevealPending', 12: 'RiverRevealPending',
};

function readTable(data: Buffer) {
  return {
    gameType:       data.readUInt8(104),
    phase:          data.readUInt8(160),
    currentPlayers: data.readUInt8(122),
    maxPlayers:     data.readUInt8(121),
    handNumber:     Number(data.readBigUInt64LE(123)),
    pot:            Number(data.readBigUInt64LE(131)),
    smallBlind:     Number(data.readBigUInt64LE(105)),
    bigBlind:       Number(data.readBigUInt64LE(113)),
    currentPlayer:  data.readUInt8(161),
    dealerButton:   data.readUInt8(163),
    seatsOccupied:  data.readUInt16LE(250),
    blindLevel:     data.readUInt8(241),
    tournamentStart: Number(data.readBigUInt64LE(242)),
    tier:           data.length > 360 ? data.readUInt8(360) : 0,
    entryAmount:    data.length > 369 ? Number(data.readBigUInt64LE(361)) : 0,
    feeAmount:      data.length > 377 ? Number(data.readBigUInt64LE(369)) : 0,
    prizePool:      data.length > 385 ? Number(data.readBigUInt64LE(377)) : 0,
  };
}

function readSeat(data: Buffer) {
  return {
    chips:  Number(data.readBigUInt64LE(104)),
    status: data.readUInt8(227),
    seatNum: data.readUInt8(226),
  };
}

const STATUS_NAMES: Record<number, string> = {
  0: 'Empty', 1: 'Active', 2: 'Folded', 3: 'AllIn',
  4: 'SittingOut', 5: 'Busted', 6: 'Leaving',
};

// ============================================================
// Helpers
// ============================================================
async function airdrop(c: Connection, pk: PublicKey, amt: number) {
  await c.confirmTransaction(await c.requestAirdrop(pk, amt), 'confirmed');
}

function step(name: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${name}`);
  console.log('='.repeat(70));
}

async function send(c: Connection, ix: TransactionInstruction, signers: Keypair[], label: string): Promise<boolean> {
  try {
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    tx.feePayer = signers[0].publicKey;
    const sig = await sendAndConfirmTransaction(c, tx, signers, { commitment: 'confirmed' });
    console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
    return true;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0, 150)}`);
    if (e.logs) e.logs.filter((l: string) => l.includes('Error') || l.includes('Program log')).slice(-5).forEach((l: string) => console.log(`     ${l}`));
    return false;
  }
}

// ============================================================
// Main SNG Test
// ============================================================
async function main() {
  console.log('='.repeat(70));
  console.log('  FastPoker Smoke Test — SNG (Heads-Up, Micro Tier)');
  console.log('='.repeat(70));

  const c = new Connection(RPC_URL, 'confirmed');

  // Verify programs
  const fpOk = (await c.getAccountInfo(FASTPOKER_PROGRAM_ID))?.executable;
  const stOk = (await c.getAccountInfo(STEEL_PROGRAM_ID))?.executable;
  console.log(`  FastPoker: ${fpOk ? 'deployed' : 'MISSING'}`);
  console.log(`  STEEL:     ${stOk ? 'deployed' : 'MISSING'}`);
  if (!fpOk || !stOk) { console.log('  ⚠️  Programs not deployed.'); return; }

  const playerA = Keypair.generate();
  const playerB = Keypair.generate();

  // ── STEP 0: Airdrop ──
  step('STEP 0: Airdrop SOL');
  await airdrop(c, playerA.publicKey, 10 * LAMPORTS_PER_SOL);
  await airdrop(c, playerB.publicKey, 10 * LAMPORTS_PER_SOL);
  console.log(`  Player A: ${(await c.getBalance(playerA.publicKey)) / LAMPORTS_PER_SOL} SOL`);

  // ── STEP 1: Register Players ──
  step('STEP 1: Register Players');
  for (const [label, p] of [['A', playerA], ['B', playerB]] as [string, Keypair][]) {
    const ix = new TransactionInstruction({
      programId: FASTPOKER_PROGRAM_ID,
      keys: [
        { pubkey: p.publicKey, isSigner: true, isWritable: true },
        { pubkey: playerPda(p.publicKey), isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: poolPda(), isSigner: false, isWritable: true },
        { pubkey: unrefinedPda(p.publicKey), isSigner: false, isWritable: true },
        { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: IX.register_player,
    });
    await send(c, ix, [p], `Register Player ${label}`);
  }

  // ── STEP 2: Create HU SNG Table (Micro Tier) ──
  step('STEP 2: Create SNG Table (HU, Micro)');
  const tableId = crypto.randomBytes(32);
  const table = tablePda(tableId);
  console.log(`  Table PDA: ${table.toBase58()}`);

  // GameType: 0=SitAndGoHeadsUp, Stakes: 0=Micro, MaxPlayers: 2, Tier: 0=Micro
  const createData = Buffer.concat([IX.create_table, serializeTableConfig(tableId, 0, 0, 2, 0)]);
  const createIx = new TransactionInstruction({
    programId: FASTPOKER_PROGRAM_ID,
    keys: [
      { pubkey: playerA.publicKey, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: poolPda(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: createData,
  });
  if (!await send(c, createIx, [playerA], 'Create SNG Table')) return;

  let info = await c.getAccountInfo(table);
  if (info) {
    const s = readTable(info.data);
    console.log(`  GameType: ${s.gameType} (0=SitAndGoHU)`);
    console.log(`  Blinds: ${s.smallBlind}/${s.bigBlind}`);
    console.log(`  Tier: ${s.tier} (0=Micro)`);
    console.log(`  Entry: ${s.entryAmount}, Fee: ${s.feeAmount}`);
    console.log(`  Phase: ${PHASE_NAMES[s.phase]}`);
  }

  // ── STEP 3: Init Table Seats ──
  step('STEP 3: Init Table Seats');
  for (let i = 0; i < 2; i++) {
    const initData = Buffer.concat([IX.init_table_seat, Buffer.from([i])]);
    const ix = new TransactionInstruction({
      programId: FASTPOKER_PROGRAM_ID,
      keys: [
        { pubkey: playerA.publicKey, isSigner: true, isWritable: true },
        { pubkey: table, isSigner: false, isWritable: false },
        { pubkey: seatPda(table, i), isSigner: false, isWritable: true },
        { pubkey: seatCardsPda(table, i), isSigner: false, isWritable: true },
        { pubkey: deckStatePda(table), isSigner: false, isWritable: true },
        { pubkey: receiptPda(table, i), isSigner: false, isWritable: true },
        { pubkey: depositProofPda(table, i), isSigner: false, isWritable: true },
        { pubkey: vaultPda(table), isSigner: false, isWritable: true },
        { pubkey: crankTallyErPda(table), isSigner: false, isWritable: true },
        { pubkey: crankTallyL1Pda(table), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: initData,
    });
    await send(c, ix, [playerA], `Init Seat ${i}`);
  }

  // ── STEP 4: Join Table (SNG Buy-In) ──
  step('STEP 4: Join Table (SNG Buy-In)');
  // SNG join: buy_in param is ignored; SOL transfer = table.entry_amount + table.fee_amount
  // For Micro tier: entry=0, fee=10_000_000 lamports → total=10_000_000
  // Starting chips = 1500 (fixed)

  for (const [label, player, seatIdx] of [
    ['A', playerA, 0],
    ['B', playerB, 1],
  ] as [string, Keypair, number][]) {
    // join_table args: buy_in(u64) + seat_number(u8) + reserve(u64)
    const joinData = Buffer.alloc(8 + 8 + 1 + 8);
    IX.join_table.copy(joinData, 0);
    joinData.writeBigUInt64LE(0n, 8);       // buy_in (ignored for SNG)
    joinData.writeUInt8(seatIdx, 16);        // seat_number
    joinData.writeBigUInt64LE(0n, 17);       // reserve (not used for SNG)

    const ix = new TransactionInstruction({
      programId: FASTPOKER_PROGRAM_ID,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: playerPda(player.publicKey), isSigner: false, isWritable: true },
        { pubkey: table, isSigner: false, isWritable: true },
        { pubkey: seatPda(table, seatIdx), isSigner: false, isWritable: true },
        { pubkey: markerPda(player.publicKey, table), isSigner: false, isWritable: true },
        // vault: None (SNG doesn't use vault for join)
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // receipt: None (SNG doesn't use receipt)
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // treasury: None
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // pool: None
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // player_token_account: None
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // table_token_account: None
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // unclaimed_balance: None
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // token_program: None
        { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
        // system_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: joinData,
    });
    await send(c, ix, [player], `Join SNG Player ${label} (seat ${seatIdx})`);
  }

  // Verify state after joins
  info = await c.getAccountInfo(table);
  if (info) {
    const s = readTable(info.data);
    console.log(`\n  After joins:`);
    console.log(`  Current Players: ${s.currentPlayers}/${s.maxPlayers}`);
    console.log(`  Prize Pool: ${s.prizePool} lamports`);
    console.log(`  Seats Occupied: 0b${s.seatsOccupied.toString(2).padStart(2, '0')}`);
  }
  // Verify starting chips
  for (let i = 0; i < 2; i++) {
    const si = await c.getAccountInfo(seatPda(table, i));
    if (si && si.data.length > 227) {
      const seat = readSeat(si.data);
      console.log(`  Seat ${i}: ${seat.chips} chips, ${STATUS_NAMES[seat.status]}`);
    }
  }

  // ── STEP 5: Start Game ──
  step('STEP 5: Start Game');
  const startIx = new TransactionInstruction({
    programId: FASTPOKER_PROGRAM_ID,
    keys: [
      { pubkey: playerA.publicKey, isSigner: false, isWritable: false },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: deckStatePda(table), isSigner: false, isWritable: true },
      // remaining: occupied seats
      { pubkey: seatPda(table, 0), isSigner: false, isWritable: true },
      { pubkey: seatPda(table, 1), isSigner: false, isWritable: true },
    ],
    data: IX.start_game,
  });
  if (!await send(c, startIx, [playerA], 'Start Game')) return;

  info = await c.getAccountInfo(table);
  if (info) {
    const s = readTable(info.data);
    console.log(`  Phase: ${PHASE_NAMES[s.phase]} (${s.phase})`);
    console.log(`  Hand #${s.handNumber}`);
    console.log(`  Blinds: ${s.smallBlind}/${s.bigBlind}`);
    console.log(`  Pot: ${s.pot}`);
    console.log(`  Tournament Start: ${s.tournamentStart}`);
    console.log(`  Dealer: seat ${s.dealerButton}`);
    console.log(`  Current Player: seat ${s.currentPlayer}`);
  }

  // ── STEP 6: devnet_bypass_deal ──
  step('STEP 6: devnet_bypass_deal (Mock)');
  const dealIx = new TransactionInstruction({
    programId: FASTPOKER_PROGRAM_ID,
    keys: [
      { pubkey: playerA.publicKey, isSigner: true, isWritable: false },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: deckStatePda(table), isSigner: false, isWritable: true },
      { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
      // remaining: [seats..., seat_cards...] (paired layout)
      { pubkey: seatPda(table, 0), isSigner: false, isWritable: true },
      { pubkey: seatPda(table, 1), isSigner: false, isWritable: true },
      { pubkey: seatCardsPda(table, 0), isSigner: false, isWritable: true },
      { pubkey: seatCardsPda(table, 1), isSigner: false, isWritable: true },
    ],
    data: IX.devnet_bypass_deal,
  });
  if (!await send(c, dealIx, [playerA], 'devnet_bypass_deal')) return;

  info = await c.getAccountInfo(table);
  if (info) {
    const s = readTable(info.data);
    console.log(`  Phase: ${PHASE_NAMES[s.phase]} (${s.phase})`);
    console.log(`  Current Player: seat ${s.currentPlayer}`);
  }

  // ── STEP 7: Player Action (Fold) ──
  step('STEP 7: Player Action (Fold)');
  info = await c.getAccountInfo(table);
  const actingSeat = info ? info.data.readUInt8(161) : 0;
  const actingPlayer = actingSeat === 0 ? playerA : playerB;
  console.log(`  Acting: seat ${actingSeat} (Player ${actingSeat === 0 ? 'A' : 'B'})`);

  const foldIx = new TransactionInstruction({
    programId: FASTPOKER_PROGRAM_ID,
    keys: [
      { pubkey: actingPlayer.publicKey, isSigner: true, isWritable: false },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: seatPda(table, actingSeat), isSigner: false, isWritable: true },
      // session_token: None
      { pubkey: FASTPOKER_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.player_action, Buffer.from([0])]), // Fold
  });
  if (!await send(c, foldIx, [actingPlayer], `Fold (seat ${actingSeat})`)) return;

  info = await c.getAccountInfo(table);
  if (info) {
    const s = readTable(info.data);
    console.log(`  Phase: ${PHASE_NAMES[s.phase]} (${s.phase})`);
    console.log(`  Pot: ${s.pot}`);
  }

  // ── STEP 8: Settle Hand ──
  step('STEP 8: Settle Hand');
  info = await c.getAccountInfo(table);
  if (info) {
    const phase = info.data.readUInt8(160);
    if (phase === 7) { // Showdown
      const settleIx = new TransactionInstruction({
        programId: FASTPOKER_PROGRAM_ID,
        keys: [
          { pubkey: playerA.publicKey, isSigner: false, isWritable: false },
          { pubkey: table, isSigner: false, isWritable: true },
          { pubkey: deckStatePda(table), isSigner: false, isWritable: true },
          // remaining: seats + seat_cards
          { pubkey: seatPda(table, 0), isSigner: false, isWritable: true },
          { pubkey: seatPda(table, 1), isSigner: false, isWritable: true },
          { pubkey: seatCardsPda(table, 0), isSigner: false, isWritable: true },
          { pubkey: seatCardsPda(table, 1), isSigner: false, isWritable: true },
        ],
        data: IX.settle_hand,
      });
      await send(c, settleIx, [playerA], 'Settle Hand');
    } else if (phase === 0) {
      console.log(`  ✅ Already Waiting (fold-win resolved + reset)`);
    } else {
      console.log(`  Phase: ${PHASE_NAMES[phase]} (${phase})`);
    }
  }

  // ── FINAL: Verify SNG State ──
  step('FINAL SUMMARY');
  info = await c.getAccountInfo(table);
  if (info) {
    const s = readTable(info.data);
    console.log(`  Phase: ${PHASE_NAMES[s.phase]} (${s.phase})`);
    console.log(`  Hand #${s.handNumber}`);
    console.log(`  Pot: ${s.pot}`);
    console.log(`  Blinds: ${s.smallBlind}/${s.bigBlind}`);
    console.log(`  Tournament Start: ${s.tournamentStart > 0 ? 'SET' : 'NOT SET'} (${s.tournamentStart})`);
    console.log(`  Blind Level: ${s.blindLevel}`);
    console.log(`  Prize Pool: ${s.prizePool} lamports`);
  }

  // Seat chip balances
  for (let i = 0; i < 2; i++) {
    const si = await c.getAccountInfo(seatPda(table, i));
    if (si && si.data.length > 227) {
      const seat = readSeat(si.data);
      console.log(`  Seat ${i}: ${seat.chips} chips, status=${STATUS_NAMES[seat.status] ?? seat.status}`);
    }
  }

  // Verify SNG-specific properties
  if (info) {
    const s = readTable(info.data);
    const checks = [
      ['GameType = SitAndGoHU (0)', s.gameType === 0],
      ['Blinds = 10/20', s.smallBlind === 10 && s.bigBlind === 20],
      ['Tournament started', s.tournamentStart > 0],
      ['Phase back to Waiting', s.phase === 0],
      ['Pot cleared', s.pot === 0],
    ];
    console.log(`\n  SNG Checks:`);
    for (const [label, ok] of checks) {
      console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('  SNG smoke test complete!');
  console.log('='.repeat(70));
}

main().catch((e) => { console.error('SNG test failed:', e); process.exit(1); });
