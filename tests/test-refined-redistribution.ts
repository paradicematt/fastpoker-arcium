/**
 * Test Refined Redistribution (ORE-style weighted)
 * 
 * Flow:
 * 1. Player A wins 1000 POKER (unrefined)
 * 2. Player B wins 1000 POKER (unrefined)  
 * 3. Player A claims → pays 100 tax (10%) → refined_pool = 100
 * 4. Player B should receive ~50 POKER refined (proportional to their unrefined weight)
 * 5. Player B claims → gets 900 (90% of their 1000) + 50 refined = 950 total
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

const STEEL_PROGRAM_ID = new PublicKey('BaYBb2JtaVffVnQYk1TwDUwZskgdnZcnNawfVzj3YvkH');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
const RPC_URL = 'https://api.devnet.solana.com';

const POOL_SEED = Buffer.from('pool');
const UNREFINED_SEED = Buffer.from('unrefined');

function loadKeypair(filePath: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filePath, 'utf-8'))));
}

function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_SEED], STEEL_PROGRAM_ID);
}

function getUnrefinedPDA(winner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([UNREFINED_SEED, winner.toBuffer()], STEEL_PROGRAM_ID);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('='.repeat(70));
  console.log('Refined Redistribution Test (ORE-style Weighted)');
  console.log('='.repeat(70));

  const connection = new Connection(RPC_URL, 'confirmed');
  const keysDir = path.join(__dirname, 'keys');

  const playerA = loadKeypair(path.join(keysDir, 'player1.json'));
  const playerB = loadKeypair(path.join(keysDir, 'player2.json'));
  const [poolPDA] = getPoolPDA();

  console.log(`\nPlayer A: ${playerA.publicKey.toBase58().slice(0, 12)}...`);
  console.log(`Player B: ${playerB.publicKey.toBase58().slice(0, 12)}...`);
  console.log(`Pool: ${poolPDA.toBase58()}`);

  // Get initial pool state
  const poolInfoBefore = await connection.getAccountInfo(poolPDA);
  const refinedPoolBefore = poolInfoBefore ? poolInfoBefore.data.readBigUInt64LE(120) : 0n;
  const totalUnrefinedBefore = poolInfoBefore ? poolInfoBefore.data.readBigUInt64LE(112) : 0n;
  console.log(`\n📊 Initial Pool State:`);
  console.log(`   Refined Pool: ${Number(refinedPoolBefore) / 1e9} POKER`);
  console.log(`   Total Unrefined: ${Number(totalUnrefinedBefore) / 1e9} POKER`);

  // ============================================================
  // STEP 1: Mint 1000 POKER to Player A
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 1: Mint 1000 POKER to Player A (unrefined)');
  console.log('='.repeat(70));

  const prizeAmount = 1000_000_000_000n; // 1000 POKER
  const [unrefinedA] = getUnrefinedPDA(playerA.publicKey);

  const mintDataA = Buffer.alloc(41);
  mintDataA[0] = 4; // MintUnrefined
  mintDataA.writeBigUInt64LE(prizeAmount, 1);

  const mintIxA = new TransactionInstruction({
    keys: [
      { pubkey: playerA.publicKey, isSigner: true, isWritable: true },
      { pubkey: unrefinedA, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: POKER_MINT, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: playerA.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: STEEL_PROGRAM_ID,
    data: mintDataA,
  });

  await sendAndConfirmTransaction(connection, new Transaction().add(mintIxA), [playerA]);
  console.log('✅ Player A: Minted 1000 POKER unrefined');

  // Check A's unrefined state
  const unrefinedAInfo = await connection.getAccountInfo(unrefinedA);
  if (unrefinedAInfo) {
    const unrefinedAmountA = unrefinedAInfo.data.readBigUInt64LE(40);
    const refinedAmountA = unrefinedAInfo.data.readBigUInt64LE(48);
    console.log(`   A's unrefined: ${Number(unrefinedAmountA) / 1e9}, refined: ${Number(refinedAmountA) / 1e9}`);
  }

  await sleep(1000);

  // ============================================================
  // STEP 2: Mint 1000 POKER to Player B
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 2: Mint 1000 POKER to Player B (unrefined)');
  console.log('='.repeat(70));

  const [unrefinedB] = getUnrefinedPDA(playerB.publicKey);

  const mintDataB = Buffer.alloc(41);
  mintDataB[0] = 4;
  mintDataB.writeBigUInt64LE(prizeAmount, 1);

  const mintIxB = new TransactionInstruction({
    keys: [
      { pubkey: playerA.publicKey, isSigner: true, isWritable: true }, // Authority
      { pubkey: unrefinedB, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: POKER_MINT, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: playerB.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: STEEL_PROGRAM_ID,
    data: mintDataB,
  });

  await sendAndConfirmTransaction(connection, new Transaction().add(mintIxB), [playerA]);
  console.log('✅ Player B: Minted 1000 POKER unrefined');

  // Check pool state
  const poolInfoMid = await connection.getAccountInfo(poolPDA);
  const totalUnrefinedMid = poolInfoMid ? poolInfoMid.data.readBigUInt64LE(112) : 0n;
  console.log(`\n📊 Pool after both mints: Total Unrefined = ${Number(totalUnrefinedMid) / 1e9} POKER`);

  // Check B's unrefined state
  const unrefinedBInfo1 = await connection.getAccountInfo(unrefinedB);
  if (unrefinedBInfo1) {
    const unrefinedAmountB = unrefinedBInfo1.data.readBigUInt64LE(40);
    const refinedAmountB = unrefinedBInfo1.data.readBigUInt64LE(48);
    console.log(`   B's unrefined: ${Number(unrefinedAmountB) / 1e9}, refined: ${Number(refinedAmountB) / 1e9}`);
  }

  await sleep(1000);

  // ============================================================
  // STEP 3: Player A Claims (pays 10% tax)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 3: Player A Claims (10% tax → refined pool)');
  console.log('='.repeat(70));

  const playerAATA = await getAssociatedTokenAddress(POKER_MINT, playerA.publicKey);
  const ataInfoA = await connection.getAccountInfo(playerAATA);
  if (!ataInfoA) {
    const createATAix = createAssociatedTokenAccountInstruction(playerA.publicKey, playerAATA, playerA.publicKey, POKER_MINT);
    await sendAndConfirmTransaction(connection, new Transaction().add(createATAix), [playerA]);
  }

  const claimDataA = Buffer.from([5]); // ClaimRefined
  const claimIxA = new TransactionInstruction({
    keys: [
      { pubkey: playerA.publicKey, isSigner: true, isWritable: true },
      { pubkey: unrefinedA, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: playerAATA, isSigner: false, isWritable: true },
      { pubkey: POKER_MINT, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: STEEL_PROGRAM_ID,
    data: claimDataA,
  });

  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(claimIxA), [playerA]);
    const balanceA = await connection.getTokenAccountBalance(playerAATA);
    console.log(`✅ Player A claimed: ${balanceA.value.uiAmountString} POKER`);
  } catch (e: any) {
    console.log(`❌ A claim failed: ${e.message}`);
  }

  // Check pool state after A claims
  const poolInfoAfterA = await connection.getAccountInfo(poolPDA);
  const refinedPoolAfterA = poolInfoAfterA ? poolInfoAfterA.data.readBigUInt64LE(120) : 0n;
  const totalUnrefinedAfterA = poolInfoAfterA ? poolInfoAfterA.data.readBigUInt64LE(112) : 0n;
  console.log(`\n📊 Pool after A claims:`);
  console.log(`   Refined Pool: ${Number(refinedPoolAfterA) / 1e9} POKER (10% tax from A)`);
  console.log(`   Total Unrefined: ${Number(totalUnrefinedAfterA) / 1e9} POKER (B still holding)`);

  await sleep(1000);

  // ============================================================
  // STEP 4: Check Player B's Refined Rewards (should get share of tax)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 4: Check Player B Refined Rewards');
  console.log('='.repeat(70));

  // Re-fetch B's unrefined account to see if refined increased
  const unrefinedBInfo2 = await connection.getAccountInfo(unrefinedB);
  if (unrefinedBInfo2) {
    const unrefinedAmountB = unrefinedBInfo2.data.readBigUInt64LE(40);
    const refinedAmountB = unrefinedBInfo2.data.readBigUInt64LE(48);
    const lastTotalUnrefined = unrefinedBInfo2.data.readBigUInt64LE(56);
    const lastRefinedPool = unrefinedBInfo2.data.readBigUInt64LE(64);
    
    console.log(`   B's unrefined: ${Number(unrefinedAmountB) / 1e9} POKER`);
    console.log(`   B's refined (stored): ${Number(refinedAmountB) / 1e9} POKER`);
    console.log(`   B's lastTotalUnrefined: ${Number(lastTotalUnrefined) / 1e9}`);
    console.log(`   B's lastRefinedPool: ${Number(lastRefinedPool) / 1e9}`);
    
    // Calculate what B should get
    const newRefined = Number(refinedPoolAfterA) - Number(lastRefinedPool);
    const bShare = (newRefined * Number(unrefinedAmountB)) / Number(lastTotalUnrefined);
    console.log(`\n   📐 Calculated B's share of new refined:`);
    console.log(`      New refined since B's snapshot: ${newRefined / 1e9} POKER`);
    console.log(`      B's weight: ${Number(unrefinedAmountB) / 1e9} / ${Number(lastTotalUnrefined) / 1e9}`);
    console.log(`      B's share: ${bShare / 1e9} POKER`);
  }

  // ============================================================
  // STEP 5: Player B Claims (should get unrefined + refined bonus)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 5: Player B Claims (unrefined + refined bonus)');
  console.log('='.repeat(70));

  const playerBATA = await getAssociatedTokenAddress(POKER_MINT, playerB.publicKey);
  const ataInfoB = await connection.getAccountInfo(playerBATA);
  if (!ataInfoB) {
    const createATAix = createAssociatedTokenAccountInstruction(playerB.publicKey, playerBATA, playerB.publicKey, POKER_MINT);
    await sendAndConfirmTransaction(connection, new Transaction().add(createATAix), [playerB]);
  }

  const balanceBefore = await connection.getTokenAccountBalance(playerBATA);
  console.log(`B's POKER before claim: ${balanceBefore.value.uiAmountString}`);

  // Use ClaimAll (instruction 6) to get both unrefined and refined
  const claimDataB = Buffer.from([6]); // ClaimAll
  const claimIxB = new TransactionInstruction({
    keys: [
      { pubkey: playerB.publicKey, isSigner: true, isWritable: true },
      { pubkey: unrefinedB, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: playerBATA, isSigner: false, isWritable: true },
      { pubkey: POKER_MINT, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: STEEL_PROGRAM_ID,
    data: claimDataB,
  });

  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(claimIxB), [playerB]);
    const balanceAfter = await connection.getTokenAccountBalance(playerBATA);
    const received = Number(balanceAfter.value.amount) - Number(balanceBefore.value.amount);
    console.log(`\n✅ Player B claimed: ${balanceAfter.value.uiAmountString} POKER`);
    console.log(`   Received this claim: ${received / 1e9} POKER`);
    console.log(`\n   Expected: 900 (90% of 1000) + ~50 (refined bonus) = ~950 POKER`);
  } catch (e: any) {
    console.log(`❌ B claim failed: ${e.message}`);
    if (e.logs) console.log('Logs:', e.logs.slice(-3));
  }

  // ============================================================
  // Final Summary
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('FINAL SUMMARY');
  console.log('='.repeat(70));

  const poolInfoFinal = await connection.getAccountInfo(poolPDA);
  const refinedPoolFinal = poolInfoFinal ? poolInfoFinal.data.readBigUInt64LE(120) : 0n;
  const totalUnrefinedFinal = poolInfoFinal ? poolInfoFinal.data.readBigUInt64LE(112) : 0n;

  console.log(`\n📊 Final Pool State:`);
  console.log(`   Refined Pool: ${Number(refinedPoolFinal) / 1e9} POKER`);
  console.log(`   Total Unrefined: ${Number(totalUnrefinedFinal) / 1e9} POKER`);

  try {
    const balA = await connection.getTokenAccountBalance(playerAATA);
    const balB = await connection.getTokenAccountBalance(playerBATA);
    console.log(`\n💰 Final Balances:`);
    console.log(`   Player A: ${balA.value.uiAmountString} POKER`);
    console.log(`   Player B: ${balB.value.uiAmountString} POKER`);
  } catch (e) {}

  console.log('\n' + '='.repeat(70));
}

main().catch(console.error);
