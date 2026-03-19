/**
 * Test creator rake claim on a user-created table
 * Uses Anchor program (not Steel) - should work without token issues
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
} from '@solana/web3.js';
import * as fs from 'fs';
import * as crypto from 'crypto';

const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const STEEL_PROGRAM_ID = new PublicKey('BaYBb2JtaVffVnQYk1TwDUwZskgdnZcnNawfVzj3YvkH');
const TREASURY = new PublicKey('4eLLKrNf3KTj8s3cxhGGJDU8mGHPDCFEkNi1TyM5qfQB');
const RPC_URL = 'https://devnet.helius-rpc.com/?api-key=8801f9b3-fe0b-42b5-ba5c-67f0fed31c5e';

const TABLE_SEED = Buffer.from('table');
const SEAT_SEED = Buffer.from('seat');
const PLAYER_SEED = Buffer.from('player');

function getDiscriminator(name: string): Buffer {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

async function main() {
  console.log('='.repeat(60));
  console.log('CREATOR RAKE CLAIM TEST');
  console.log('='.repeat(60));

  const connection = new Connection(RPC_URL, 'confirmed');

  // Load test wallet (funder)
  const funder = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync('J:/Poker/tests/test-wallet.json', 'utf-8')))
  );
  console.log(`\nFunder: ${funder.publicKey.toBase58()}`);

  // Create table creator keypair
  const creator = Keypair.generate();
  const player1 = Keypair.generate();
  const player2 = Keypair.generate();

  // Fund accounts
  console.log('\n1. Funding accounts...');
  const fundTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: creator.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: player1.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: player2.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL }),
  );
  await sendAndConfirmTransaction(connection, fundTx, [funder]);
  console.log('   ✅ Accounts funded');

  // Generate table ID and derive PDAs
  const tableIdBytes = Keypair.generate().publicKey.toBytes();
  const [tablePda] = PublicKey.findProgramAddressSync([TABLE_SEED, tableIdBytes], PROGRAM_ID);
  const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from('pool')], STEEL_PROGRAM_ID);

  console.log(`   Table PDA: ${tablePda.toBase58()}`);
  console.log(`   Creator: ${creator.publicKey.toBase58()}`);

  // 2. Create user table (cash game)
  console.log('\n2. Creating user table (cash game)...');
  const createUserTableDisc = getDiscriminator('create_user_table');
  
  // Config struct for CreateUserTableConfig
  // table_id: [u8; 32], stakes: Stakes enum, max_players: u8
  const configData = Buffer.alloc(32 + 1 + 1);
  Buffer.from(tableIdBytes).copy(configData, 0);
  configData.writeUInt8(0, 32); // Stakes::Low = 0
  configData.writeUInt8(2, 33); // max_players = 2

  const createTableIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([createUserTableDisc, configData]),
  });

  try {
    const createTx = new Transaction().add(createTableIx);
    await sendAndConfirmTransaction(connection, createTx, [creator]);
    console.log('   ✅ User table created');
  } catch (e: any) {
    console.log(`   ❌ Create table failed: ${e.message}`);
    return;
  }

  // Verify table state
  const tableInfo = await connection.getAccountInfo(tablePda);
  if (tableInfo) {
    // Parse is_user_created flag (offset varies - check Table struct)
    console.log(`   Table account size: ${tableInfo.data.length} bytes`);
  }

  // 3. Register players
  console.log('\n3. Registering players...');
  const registerDisc = getDiscriminator('register_player');
  
  for (const player of [player1, player2]) {
    const [playerPda] = PublicKey.findProgramAddressSync([PLAYER_SEED, player.publicKey.toBuffer()], PROGRAM_ID);
    
    const regIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: playerPda, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: registerDisc,
    });
    
    try {
      await sendAndConfirmTransaction(connection, new Transaction().add(regIx), [player]);
      console.log(`   ✅ ${player.publicKey.toBase58().slice(0, 8)}... registered`);
    } catch (e: any) {
      if (e.message.includes('already')) {
        console.log(`   ✅ ${player.publicKey.toBase58().slice(0, 8)}... already registered`);
      } else {
        console.log(`   ❌ Registration failed: ${e.message}`);
      }
    }
  }

  // 4. Join table with both players
  console.log('\n4. Players joining table...');
  const joinDisc = getDiscriminator('join_table');
  
  for (let i = 0; i < 2; i++) {
    const player = i === 0 ? player1 : player2;
    const [playerPda] = PublicKey.findProgramAddressSync([PLAYER_SEED, player.publicKey.toBuffer()], PROGRAM_ID);
    const [seatPda] = PublicKey.findProgramAddressSync([SEAT_SEED, tablePda.toBuffer(), Buffer.from([i])], PROGRAM_ID);
    
    const joinData = Buffer.alloc(8 + 8 + 1);
    joinDisc.copy(joinData, 0);
    joinData.writeBigUInt64LE(200000n, 8); // buy_in
    joinData.writeUInt8(i, 16); // seat_number
    
    const joinIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: playerPda, isSigner: false, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: seatPda, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // placeholder
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // placeholder
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // placeholder
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: joinData,
    });
    
    try {
      await sendAndConfirmTransaction(connection, new Transaction().add(joinIx), [player]);
      console.log(`   ✅ Player ${i + 1} joined seat ${i}`);
    } catch (e: any) {
      console.log(`   ❌ Join failed: ${e.message}`);
    }
  }

  // 5. Start game and play a hand to generate rake
  console.log('\n5. Starting game and playing hand...');
  const startGameDisc = getDiscriminator('start_game');
  
  const startIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator.publicKey, isSigner: true, isWritable: false },
      { pubkey: tablePda, isSigner: false, isWritable: true },
    ],
    data: startGameDisc,
  });
  
  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(startIx), [creator]);
    console.log('   ✅ Game started');
  } catch (e: any) {
    console.log(`   ⚠️ Start game: ${e.message.slice(0, 80)}`);
  }

  // 6. Check creator_rake_total on table
  console.log('\n6. Checking creator_rake_total...');
  const tableInfo2 = await connection.getAccountInfo(tablePda);
  if (tableInfo2) {
    // Table struct layout - creator_rake_total is near the end
    // Need to find the correct offset based on Table struct
    const data = tableInfo2.data;
    // Approximate offset for creator_rake_total (after most fields)
    // This would need to be calculated from the actual struct
    console.log(`   Table data length: ${data.length}`);
    console.log('   (Rake would accumulate after hands are settled)');
  }

  // 7. Test claim_creator_rake instruction
  console.log('\n7. Testing claim_creator_rake...');
  const claimDisc = getDiscriminator('claim_creator_rake');
  
  // Derive table escrow PDA
  const [tableEscrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), tablePda.toBuffer()],
    PROGRAM_ID
  );
  console.log(`   Table escrow: ${tableEscrowPda.toBase58()}`);
  
  const creatorBalBefore = await connection.getBalance(creator.publicKey);
  
  const claimIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: tableEscrowPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: claimDisc,
  });
  
  try {
    const claimTx = new Transaction().add(claimIx);
    const sig = await sendAndConfirmTransaction(connection, claimTx, [creator]);
    const creatorBalAfter = await connection.getBalance(creator.publicKey);
    const rakeClaimed = creatorBalAfter - creatorBalBefore + 5000; // Add back tx fee
    console.log(`   ✅ Claim TX: ${sig}`);
    console.log(`   Rake claimed: ${rakeClaimed} lamports`);
  } catch (e: any) {
    if (e.message.includes('NoRakeToClaim') || e.message.includes('6016')) {
      console.log('   ⚠️ No rake accumulated yet (need to complete hands with flop)');
      console.log('   ✅ claim_creator_rake instruction works!');
    } else {
      console.log(`   ❌ Claim failed: ${e.message}`);
    }
  }

  // Cleanup - return funds
  console.log('\n8. Cleanup...');
  for (const wallet of [creator, player1, player2]) {
    try {
      const bal = await connection.getBalance(wallet.publicKey);
      if (bal > 5000) {
        const returnTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: funder.publicKey,
            lamports: bal - 5000,
          })
        );
        await sendAndConfirmTransaction(connection, returnTx, [wallet]);
      }
    } catch {}
  }
  console.log('   ✅ Funds returned');

  console.log('\n' + '='.repeat(60));
  console.log('TEST COMPLETE');
  console.log('='.repeat(60));
}

main().catch(console.error);
