/**
 * Sit & Go Entry Fee 50/50 Split Test
 * Verifies entry fee splits correctly between treasury and Pool PDA
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Program, AnchorProvider, Idl } from '@coral-xyz/anchor';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Program IDs
const CQ_POKER_PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const STEEL_PROGRAM_ID = new PublicKey('BaYBb2JtaVffVnQYk1TwDUwZskgdnZcnNawfVzj3YvkH');
const TREASURY = new PublicKey('4eLLKrNf3KTj8s3cxhGGJDU8mGHPDCFEkNi1TyM5qfQB');

const RPC_URL = 'https://devnet.helius-rpc.com/?api-key=8801f9b3-fe0b-42b5-ba5c-67f0fed31c5e';

// Seeds
const PLAYER_SEED = Buffer.from('player');
const TABLE_SEED = Buffer.from('table');
const SEAT_SEED = Buffer.from('seat');
const POOL_SEED = Buffer.from('pool');

// Constants
const SNG_ENTRY_FEE = 100_000; // 0.0001 SOL

function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_SEED], STEEL_PROGRAM_ID);
}

function getPlayerPDA(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PLAYER_SEED, wallet.toBuffer()], CQ_POKER_PROGRAM_ID);
}

function getTablePDA(tableId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TABLE_SEED, tableId], CQ_POKER_PROGRAM_ID);
}

function getSeatPDA(table: PublicKey, seatNumber: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEAT_SEED, table.toBuffer(), Buffer.from([seatNumber])], CQ_POKER_PROGRAM_ID);
}

function loadIDL(): Idl {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../target/idl/cq_poker.json'), 'utf-8'));
}

function createWallet(keypair: Keypair) {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx: any) => { tx.partialSign(keypair); return tx; },
    signAllTransactions: async (txs: any[]) => { txs.forEach(tx => tx.partialSign(keypair)); return txs; },
  };
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('='.repeat(70));
  console.log('SIT & GO ENTRY FEE 50/50 SPLIT TEST');
  console.log('='.repeat(70));

  const connection = new Connection(RPC_URL, 'confirmed');

  // Load authority keypair
  const authority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync('j:/critters/mini-game/deployer-keypair.json', 'utf-8')))
  );

  const provider = new AnchorProvider(connection, createWallet(authority) as any, { commitment: 'confirmed' });
  const idl = loadIDL();
  const program = new Program(idl, CQ_POKER_PROGRAM_ID, provider);

  const [poolPda] = getPoolPDA();

  // Get balances BEFORE
  console.log('\n--- PRE-TEST BALANCES ---');
  const treasuryBefore = await connection.getBalance(TREASURY);
  const poolBefore = await connection.getBalance(poolPda);
  console.log(`Treasury: ${treasuryBefore / LAMPORTS_PER_SOL} SOL`);
  console.log(`Pool PDA: ${poolBefore / LAMPORTS_PER_SOL} SOL`);

  // Create a new test player (without free entries)
  console.log('\n--- CREATING TEST PLAYER ---');
  const testPlayer = Keypair.generate();
  
  // Fund the player
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: authority.publicKey,
      toPubkey: testPlayer.publicKey,
      lamports: 0.01 * LAMPORTS_PER_SOL,
    })
  );
  await sendAndConfirmTransaction(connection, fundTx, [authority]);
  console.log(`Funded player: ${testPlayer.publicKey.toBase58()}`);

  // Register player (this will use the 50/50 split too)
  const [playerPda] = getPlayerPDA(testPlayer.publicKey);
  
  const registerDisc = crypto.createHash('sha256')
    .update('global:register_player')
    .digest()
    .slice(0, 8);
  
  const registerIx = new TransactionInstruction({
    programId: CQ_POKER_PROGRAM_ID,
    keys: [
      { pubkey: testPlayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: playerPda, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: registerDisc,
  });

  const regTx = new Transaction().add(registerIx);
  regTx.feePayer = testPlayer.publicKey;
  regTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  regTx.sign(testPlayer);
  
  await connection.sendRawTransaction(regTx.serialize());
  console.log('Player registered (uses 5 free entries)');

  // Check balances after registration
  await sleep(1000);
  const treasuryAfterReg = await connection.getBalance(TREASURY);
  const poolAfterReg = await connection.getBalance(poolPda);
  console.log(`Treasury after reg: ${treasuryAfterReg / LAMPORTS_PER_SOL} SOL (+${treasuryAfterReg - treasuryBefore})`);
  console.log(`Pool after reg: ${poolAfterReg / LAMPORTS_PER_SOL} SOL (+${poolAfterReg - poolBefore})`);

  // Use up all 5 free entries by setting to 0 (admin function)
  console.log('\n--- USING FREE ENTRIES ---');
  try {
    const setFreeEntriesDisc = crypto.createHash('sha256')
      .update('global:set_free_entries')
      .digest()
      .slice(0, 8);
    
    const freeEntriesData = Buffer.concat([setFreeEntriesDisc, Buffer.from([0])]);
    
    const setEntriesIx = new TransactionInstruction({
      programId: CQ_POKER_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: playerPda, isSigner: false, isWritable: true },
      ],
      data: freeEntriesData,
    });

    const setTx = new Transaction().add(setEntriesIx);
    await sendAndConfirmTransaction(connection, setTx, [authority]);
    console.log('Set free entries to 0');
  } catch (e: any) {
    console.log('Could not set free entries:', e.message);
  }

  // Create a Sit & Go table
  console.log('\n--- CREATING SIT & GO TABLE ---');
  const tableId = new Uint8Array(32);
  crypto.randomFillSync(tableId);
  const [tablePda] = getTablePDA(tableId);
  
  try {
    // GameType::SitAndGoHeadsUp = 0
    const createTableDisc = crypto.createHash('sha256')
      .update('global:create_table')
      .digest()
      .slice(0, 8);
    
    // TableConfig: max_players(1), small_blind(8), big_blind(8), game_type(1)
    const configData = Buffer.alloc(18);
    configData.writeUInt8(2, 0); // max_players = 2 (heads up)
    configData.writeBigUInt64LE(BigInt(10), 1); // small_blind
    configData.writeBigUInt64LE(BigInt(20), 9); // big_blind
    configData.writeUInt8(0, 17); // game_type = SitAndGoHeadsUp
    
    const createData = Buffer.concat([createTableDisc, tableId, configData]);
    
    const createTableIx = new TransactionInstruction({
      programId: CQ_POKER_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: createData,
    });

    const createTx = new Transaction().add(createTableIx);
    await sendAndConfirmTransaction(connection, createTx, [authority]);
    console.log(`Table created: ${tablePda.toBase58()}`);
  } catch (e: any) {
    console.log('Create table error:', e.message);
  }

  // Join table (should charge entry fee since free_entries = 0)
  console.log('\n--- JOINING SIT & GO (PAID ENTRY) ---');
  const treasuryBeforeJoin = await connection.getBalance(TREASURY);
  const poolBeforeJoin = await connection.getBalance(poolPda);
  
  try {
    const [seatPda] = getSeatPDA(tablePda, 0);
    
    const joinDisc = crypto.createHash('sha256')
      .update('global:join_table')
      .digest()
      .slice(0, 8);
    
    // buy_in (8 bytes) - for SnG this is ignored but required
    const buyInData = Buffer.alloc(8);
    buyInData.writeBigUInt64LE(BigInt(0));
    
    const joinData = Buffer.concat([joinDisc, buyInData]);
    
    const joinIx = new TransactionInstruction({
      programId: CQ_POKER_PROGRAM_ID,
      keys: [
        { pubkey: testPlayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: playerPda, isSigner: false, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: seatPda, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: joinData,
    });

    const joinTx = new Transaction().add(joinIx);
    joinTx.feePayer = testPlayer.publicKey;
    joinTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    joinTx.sign(testPlayer);
    
    const sig = await connection.sendRawTransaction(joinTx.serialize());
    await connection.confirmTransaction(sig, 'confirmed');
    console.log('Join table tx:', sig);

    // Check balances after join
    await sleep(1000);
    const treasuryAfterJoin = await connection.getBalance(TREASURY);
    const poolAfterJoin = await connection.getBalance(poolPda);
    
    const treasuryIncrease = treasuryAfterJoin - treasuryBeforeJoin;
    const poolIncrease = poolAfterJoin - poolBeforeJoin;
    
    console.log(`\nTreasury increase: ${treasuryIncrease} lamports`);
    console.log(`Pool increase: ${poolIncrease} lamports`);
    
    const expectedShare = SNG_ENTRY_FEE / 2;
    if (treasuryIncrease === expectedShare && poolIncrease === expectedShare) {
      console.log('\n✅ PASS: Sit & Go entry fee split 50/50!');
    } else if (treasuryIncrease === 0 && poolIncrease === 0) {
      console.log('\n⚠️ Free entry was used (player still had free entries)');
    } else {
      console.log('\n❌ FAIL: Unexpected split');
    }

  } catch (e: any) {
    console.log('Join table error:', e.message);
    if (e.logs) {
      console.log('Logs:', e.logs.slice(-5));
    }
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  const finalTreasury = await connection.getBalance(TREASURY);
  const finalPool = await connection.getBalance(poolPda);
  console.log(`Treasury: ${treasuryBefore / LAMPORTS_PER_SOL} → ${finalTreasury / LAMPORTS_PER_SOL} SOL`);
  console.log(`Pool PDA: ${poolBefore / LAMPORTS_PER_SOL} → ${finalPool / LAMPORTS_PER_SOL} SOL`);
}

main().catch(console.error);
