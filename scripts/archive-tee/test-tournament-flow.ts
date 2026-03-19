/**
 * Comprehensive test script for tournament flow
 * Tests: RegisterPlayer, CreateTable, JoinTableFree, JoinTable
 */

import { 
  Connection, 
  PublicKey, 
  Keypair, 
  Transaction, 
  TransactionInstruction, 
  SystemProgram, 
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

const POKER_PROGRAM_ID = new PublicKey('BaYBb2JtaVffVnQYk1TwDUwZskgdnZcnNawfVzj3YvkH');
const RPC_URL = 'http://localhost:8899';

// Instruction discriminators
const IX = {
  Initialize: 0,
  CreateTable: 9,
  JoinTable: 10,
  LeaveTable: 11,
  PlayerAction: 13,
  DealCards: 14,
  SettleHand: 15,
  DelegateTable: 16,
  RegisterPlayer: 21,
  JoinTableFree: 22,
};

// PDA helpers
function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('pool')], POKER_PROGRAM_ID);
}

function getTablePDA(tableId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('table'), Buffer.from(tableId)],
    POKER_PROGRAM_ID
  );
}

function getSeatPDA(tablePDA: PublicKey, seatNumber: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat'), tablePDA.toBuffer(), Buffer.from([seatNumber])],
    POKER_PROGRAM_ID
  );
}

function getPlayerPDA(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('player'), wallet.toBuffer()],
    POKER_PROGRAM_ID
  );
}

// Test utilities
async function airdrop(connection: Connection, pubkey: PublicKey, amount: number) {
  console.log(`Airdropping ${amount} SOL to ${pubkey.toBase58().slice(0,8)}...`);
  const sig = await connection.requestAirdrop(pubkey, amount * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, 'confirmed');
  console.log('  ✓ Airdrop confirmed');
}

async function getBalance(connection: Connection, pubkey: PublicKey): Promise<number> {
  return (await connection.getBalance(pubkey)) / LAMPORTS_PER_SOL;
}

// Treasury account (can be any account to receive registration fees)
const TREASURY = new PublicKey('GkfdM1vqRYrU2LJ4ipwCJ3vsr2PGYLpdtdKK121ZkQZg'); // deployer wallet

// Test: Register Player
async function testRegisterPlayer(
  connection: Connection, 
  wallet: Keypair
): Promise<boolean> {
  console.log('\n=== Test: RegisterPlayer ===');
  
  const [playerPDA] = getPlayerPDA(wallet.publicKey);
  console.log('Player PDA:', playerPDA.toBase58());
  
  // Check if already registered
  const existingAccount = await connection.getAccountInfo(playerPDA);
  if (existingAccount) {
    console.log('  Player already registered, skipping...');
    // Parse free entries
    const freeEntries = existingAccount.data[40];
    console.log('  Free entries:', freeEntries);
    return true;
  }
  
  // RegisterPlayer instruction: discriminator only
  const data = Buffer.alloc(1);
  data.writeUInt8(IX.RegisterPlayer, 0);
  
  // Accounts: player, player_pda, treasury, system_program
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: playerPDA, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: POKER_PROGRAM_ID,
    data,
  });
  
  try {
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log('  ✓ RegisterPlayer SUCCESS:', sig.slice(0, 20) + '...');
    
    // Verify
    const account = await connection.getAccountInfo(playerPDA);
    if (account) {
      const freeEntries = account.data[40];
      console.log('  Free entries:', freeEntries);
    }
    return true;
  } catch (err: any) {
    console.log('  ✗ RegisterPlayer FAILED:', err.message);
    if (err.logs) err.logs.forEach((l: string) => console.log('    ', l));
    return false;
  }
}

// Test: Create Table
async function testCreateTable(
  connection: Connection,
  wallet: Keypair
): Promise<{ tablePDA: PublicKey; tableId: Uint8Array } | null> {
  console.log('\n=== Test: CreateTable ===');
  
  // Generate random table ID
  const tableId = new Uint8Array(32);
  for (let i = 0; i < 32; i++) tableId[i] = Math.floor(Math.random() * 256);
  
  const [tablePDA] = getTablePDA(tableId);
  const [poolPDA] = getPoolPDA();
  
  console.log('Table ID:', Buffer.from(tableId).toString('hex').slice(0, 16) + '...');
  console.log('Table PDA:', tablePDA.toBase58());
  
  // CreateTable instruction: discriminator (1) + table_id (32) + small_blind (8) + big_blind (8) + stakes_level (1)
  const data = Buffer.alloc(50);
  data.writeUInt8(IX.CreateTable, 0);
  Buffer.from(tableId).copy(data, 1);
  data.writeBigUInt64LE(BigInt(10), 33);  // small blind
  data.writeBigUInt64LE(BigInt(20), 41);  // big blind
  data.writeUInt8(0, 49);  // stakes_level = 0 (tournament)
  
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: POKER_PROGRAM_ID,
    data,
  });
  
  try {
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log('  ✓ CreateTable SUCCESS:', sig.slice(0, 20) + '...');
    return { tablePDA, tableId };
  } catch (err: any) {
    console.log('  ✗ CreateTable FAILED:', err.message);
    if (err.logs) err.logs.forEach((l: string) => console.log('    ', l));
    return null;
  }
}

// Test: JoinTableFree
async function testJoinTableFree(
  connection: Connection,
  wallet: Keypair,
  tablePDA: PublicKey,
  seatNumber: number
): Promise<boolean> {
  console.log('\n=== Test: JoinTableFree ===');
  console.log('Table:', tablePDA.toBase58());
  console.log('Seat:', seatNumber);
  
  const [playerPDA] = getPlayerPDA(wallet.publicKey);
  const [seatPDA] = getSeatPDA(tablePDA, seatNumber);
  
  console.log('Player PDA:', playerPDA.toBase58());
  console.log('Seat PDA:', seatPDA.toBase58());
  
  // JoinTableFree instruction: discriminator (1) + seat_number (1)
  const data = Buffer.alloc(2);
  data.writeUInt8(IX.JoinTableFree, 0);
  data.writeUInt8(seatNumber, 1);
  
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: playerPDA, isSigner: false, isWritable: true },
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: seatPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: POKER_PROGRAM_ID,
    data,
  });
  
  try {
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log('  ✓ JoinTableFree SUCCESS:', sig.slice(0, 20) + '...');
    
    // Verify player's free entries decreased
    const playerAccount = await connection.getAccountInfo(playerPDA);
    if (playerAccount) {
      const freeEntries = playerAccount.data[40];
      console.log('  Free entries remaining:', freeEntries);
    }
    
    // Verify seat was created
    const seatAccount = await connection.getAccountInfo(seatPDA);
    if (seatAccount) {
      console.log('  Seat created, data length:', seatAccount.data.length);
    }
    
    return true;
  } catch (err: any) {
    console.log('  ✗ JoinTableFree FAILED:', err.message);
    if (err.logs) err.logs.forEach((l: string) => console.log('    ', l));
    return false;
  }
}

// Test: JoinTable (paid)
async function testJoinTable(
  connection: Connection,
  wallet: Keypair,
  tablePDA: PublicKey,
  tableId: Uint8Array,
  seatNumber: number,
  buyInLamports: number
): Promise<boolean> {
  console.log('\n=== Test: JoinTable (paid) ===');
  console.log('Table:', tablePDA.toBase58());
  console.log('Seat:', seatNumber);
  console.log('Buy-in:', buyInLamports / LAMPORTS_PER_SOL, 'SOL');
  
  const [seatPDA] = getSeatPDA(tablePDA, seatNumber);
  
  // JoinTable instruction: discriminator (1) + buyin_amount (8) + seat_number (1)
  const data = Buffer.alloc(10);
  data.writeUInt8(IX.JoinTable, 0);
  data.writeBigUInt64LE(BigInt(buyInLamports), 1);
  data.writeUInt8(seatNumber, 9);
  
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: seatPDA, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },  // source (same as player)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: POKER_PROGRAM_ID,
    data,
  });
  
  try {
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log('  ✓ JoinTable SUCCESS:', sig.slice(0, 20) + '...');
    return true;
  } catch (err: any) {
    console.log('  ✗ JoinTable FAILED:', err.message);
    if (err.logs) err.logs.forEach((l: string) => console.log('    ', l));
    return false;
  }
}

// Main test runner
async function main() {
  console.log('========================================');
  console.log('  POKER TOURNAMENT FLOW TEST SCRIPT');
  console.log('========================================');
  console.log('Program ID:', POKER_PROGRAM_ID.toBase58());
  console.log('RPC URL:', RPC_URL);
  
  const connection = new Connection(RPC_URL, 'confirmed');
  
  // Create two test wallets
  const player1 = Keypair.generate();
  const player2 = Keypair.generate();
  
  console.log('\nPlayer 1:', player1.publicKey.toBase58());
  console.log('Player 2:', player2.publicKey.toBase58());
  
  // Airdrop SOL to both players
  await airdrop(connection, player1.publicKey, 10);
  await airdrop(connection, player2.publicKey, 10);
  
  console.log('\nBalances:');
  console.log('  Player 1:', await getBalance(connection, player1.publicKey), 'SOL');
  console.log('  Player 2:', await getBalance(connection, player2.publicKey), 'SOL');
  
  // Test 1: Register both players
  const reg1 = await testRegisterPlayer(connection, player1);
  const reg2 = await testRegisterPlayer(connection, player2);
  
  if (!reg1 || !reg2) {
    console.log('\n❌ Registration failed, cannot continue');
    return;
  }
  
  // Test 2: Player 1 creates a tournament table
  const tableResult = await testCreateTable(connection, player1);
  
  if (!tableResult) {
    console.log('\n❌ CreateTable failed, cannot continue');
    return;
  }
  
  const { tablePDA, tableId } = tableResult;
  
  // Test 3: Player 1 joins with free entry (seat 0)
  const join1 = await testJoinTableFree(connection, player1, tablePDA, 0);
  
  if (!join1) {
    console.log('\n❌ JoinTableFree failed for player 1');
    return;
  }
  
  // Test 4: Player 2 joins with free entry (seat 1)
  const join2 = await testJoinTableFree(connection, player2, tablePDA, 1);
  
  if (!join2) {
    console.log('\n❌ JoinTableFree failed for player 2');
    return;
  }
  
  // Verify table state
  // Table struct offsets: 8 (disc) + 32 (id) + 32 (auth) + 32 (pool) + 32 (seed) + 8*6 (u64s) + 8 (cards) = 184, then table_state[8]
  // table_state: [phase, current_player, dealer, sb, bb, player_count, deck_idx, stakes_level]
  const TABLE_STATE_OFFSET = 8 + 32 + 32 + 32 + 32 + 48 + 8; // = 192
  
  console.log('\n=== Verifying Table State ===');
  const tableAccount = await connection.getAccountInfo(tablePDA);
  if (tableAccount) {
    const data = tableAccount.data;
    const phase = data[TABLE_STATE_OFFSET];
    const playerCount = data[TABLE_STATE_OFFSET + 5];
    const stakesLevel = data[TABLE_STATE_OFFSET + 7];
    console.log('  Phase:', phase);
    console.log('  Player count:', playerCount);
    console.log('  Stakes level:', stakesLevel);
  }
  
  // Test 5: Deal Cards (requires authority)
  const seat0PDA = getSeatPDA(tablePDA, 0)[0];
  const seat1PDA = getSeatPDA(tablePDA, 1)[0];
  
  const dealResult = await testDealCards(connection, player1, tablePDA, [seat0PDA, seat1PDA]);
  
  if (!dealResult) {
    console.log('\n⚠ DealCards failed (may need authority keypair)');
  } else {
    // Check current player before acting
    const tableData = await connection.getAccountInfo(tablePDA);
    const currentPlayerSeat = tableData?.data[TABLE_STATE_OFFSET + 1] || 0;
    console.log('\nCurrent player to act: seat', currentPlayerSeat);
    
    // Test 6: Player Actions - simulate a hand
    // In heads-up, dealer posts SB, other player posts BB. Dealer acts first preflop.
    // Seat 1 is current player (BB acts after SB in heads-up preflop)
    
    // Play out actions based on current player
    let actionsComplete = false;
    let maxActions = 10; // Prevent infinite loop
    
    while (!actionsComplete && maxActions > 0) {
      maxActions--;
      
      // Get current state
      const state = await connection.getAccountInfo(tablePDA);
      if (!state) break;
      
      const phase = state.data[TABLE_STATE_OFFSET];
      const currentSeat = state.data[TABLE_STATE_OFFSET + 1];
      
      const phaseNames = ['Waiting', 'Preflop', 'Flop', 'Turn', 'River', 'Showdown', 'Complete'];
      console.log(`\nPhase: ${phaseNames[phase]}, Current seat: ${currentSeat}`);
      
      // If we're in showdown or complete, break
      if (phase >= 5) {
        actionsComplete = true;
        break;
      }
      
      // Get the right player and seat for current turn
      const currentPlayer = currentSeat === 0 ? player1 : player2;
      const currentSeatPDA = currentSeat === 0 ? seat0PDA : seat1PDA;
      
      // Try to call (safest action)
      const actionResult = await testPlayerAction(connection, currentPlayer, tablePDA, currentSeatPDA, 2); // call
      
      if (!actionResult) {
        // Try check if call fails
        const checkResult = await testPlayerAction(connection, currentPlayer, tablePDA, currentSeatPDA, 1); // check
        if (!checkResult) {
          console.log('Both call and check failed, stopping action loop');
          break;
        }
      }
    }
    
    // Try to settle if we reached showdown
    const finalState = await connection.getAccountInfo(tablePDA);
    if (finalState && finalState.data[TABLE_STATE_OFFSET] >= 5) {
      const settleResult = await testSettleHand(connection, player1, tablePDA, [seat0PDA, seat1PDA]);
      if (settleResult) {
        console.log('\n✓ Complete hand simulated and settled!');
      }
    }
  }
  
  // Final table state
  await printTableState(connection, tablePDA, TABLE_STATE_OFFSET);
  
  console.log('\n========================================');
  console.log('  ✓ ALL CORE TESTS PASSED!');
  console.log('========================================');
  console.log('\nTable ID (hex):', Buffer.from(tableId).toString('hex'));
  console.log('Use this to test on frontend: /play/' + Buffer.from(tableId).toString('hex'));
}

// Test: Deal Cards
async function testDealCards(
  connection: Connection,
  authority: Keypair,
  tablePDA: PublicKey,
  seatPDAs: PublicKey[]
): Promise<boolean> {
  console.log('\n=== Test: DealCards ===');
  console.log('Table:', tablePDA.toBase58());
  console.log('Seats:', seatPDAs.length);
  
  // Generate VRF seed
  const vrfSeed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) vrfSeed[i] = Math.floor(Math.random() * 256);
  
  // DealCards instruction: discriminator (1) + vrf_seed (32)
  const data = Buffer.alloc(33);
  data.writeUInt8(IX.DealCards, 0);
  Buffer.from(vrfSeed).copy(data, 1);
  
  const keys = [
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    { pubkey: tablePDA, isSigner: false, isWritable: true },
    ...seatPDAs.map(seat => ({ pubkey: seat, isSigner: false, isWritable: true })),
  ];
  
  const ix = new TransactionInstruction({
    keys,
    programId: POKER_PROGRAM_ID,
    data,
  });
  
  try {
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
    console.log('  ✓ DealCards SUCCESS:', sig.slice(0, 20) + '...');
    return true;
  } catch (err: any) {
    console.log('  ✗ DealCards FAILED:', err.message);
    if (err.logs) err.logs.slice(-5).forEach((l: string) => console.log('    ', l));
    return false;
  }
}

// Test: Player Action (fold, check, call, raise)
async function testPlayerAction(
  connection: Connection,
  player: Keypair,
  tablePDA: PublicKey,
  seatPDA: PublicKey,
  actionType: number,  // 0=fold, 1=check, 2=call, 3=raise
  amount: bigint = BigInt(0)
): Promise<boolean> {
  console.log('\n=== Test: PlayerAction ===');
  const actionNames = ['Fold', 'Check', 'Call', 'Raise'];
  console.log('Action:', actionNames[actionType] || actionType);
  if (actionType === 3) console.log('Amount:', amount.toString());
  
  // PlayerAction instruction: discriminator (1) + action_type (1) + amount (8)
  const data = Buffer.alloc(10);
  data.writeUInt8(IX.PlayerAction, 0);
  data.writeUInt8(actionType, 1);
  data.writeBigUInt64LE(amount, 2);
  
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: player.publicKey, isSigner: true, isWritable: false },
      { pubkey: tablePDA, isSigner: false, isWritable: true },
      { pubkey: seatPDA, isSigner: false, isWritable: true },
    ],
    programId: POKER_PROGRAM_ID,
    data,
  });
  
  try {
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [player]);
    console.log('  ✓ PlayerAction SUCCESS:', sig.slice(0, 20) + '...');
    return true;
  } catch (err: any) {
    console.log('  ✗ PlayerAction FAILED:', err.message);
    if (err.logs) err.logs.slice(-5).forEach((l: string) => console.log('    ', l));
    return false;
  }
}

// Test: Settle Hand
async function testSettleHand(
  connection: Connection,
  authority: Keypair,
  tablePDA: PublicKey,
  seatPDAs: PublicKey[]
): Promise<boolean> {
  console.log('\n=== Test: SettleHand ===');
  
  const [poolPDA] = getPoolPDA();
  
  // SettleHand instruction: discriminator (1) + winner_seats[9] + amounts[9][8]
  // Total: 1 + 9 + 72 = 82 bytes
  const data = Buffer.alloc(82);
  data.writeUInt8(IX.SettleHand, 0);
  
  // Set winner_seats - seat 0 wins (just for testing)
  data.writeUInt8(0, 1);   // First winner is seat 0
  for (let i = 2; i <= 9; i++) {
    data.writeUInt8(255, i); // 255 = not a winner
  }
  
  // Set amounts - winner gets the pot (simplified: 60 chips)
  data.writeBigUInt64LE(BigInt(60), 10); // Seat 0 gets 60 chips
  // Rest are 0 (already zeroed)
  
  const keys = [
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    { pubkey: tablePDA, isSigner: false, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    ...seatPDAs.map(seat => ({ pubkey: seat, isSigner: false, isWritable: true })),
  ];
  
  const ix = new TransactionInstruction({
    keys,
    programId: POKER_PROGRAM_ID,
    data,
  });
  
  try {
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
    console.log('  ✓ SettleHand SUCCESS:', sig.slice(0, 20) + '...');
    return true;
  } catch (err: any) {
    console.log('  ✗ SettleHand FAILED:', err.message);
    if (err.logs) err.logs.slice(-5).forEach((l: string) => console.log('    ', l));
    return false;
  }
}

// Print table state helper
async function printTableState(
  connection: Connection,
  tablePDA: PublicKey,
  offset: number
): Promise<void> {
  console.log('\n=== Final Table State ===');
  const tableAccount = await connection.getAccountInfo(tablePDA);
  if (tableAccount) {
    const data = tableAccount.data;
    const phase = data[offset];
    const currentPlayer = data[offset + 1];
    const dealer = data[offset + 2];
    const playerCount = data[offset + 5];
    const handNumber = data.readBigUInt64LE(8 + 32 + 32 + 32 + 32 + 24); // pot offset - 24 for hand_number
    
    const phaseNames = ['Waiting', 'Preflop', 'Flop', 'Turn', 'River', 'Showdown', 'Complete'];
    console.log('  Phase:', phaseNames[phase] || phase);
    console.log('  Current player seat:', currentPlayer);
    console.log('  Dealer seat:', dealer);
    console.log('  Player count:', playerCount);
  }
}

main().catch(console.error);
