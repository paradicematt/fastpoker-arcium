/**
 * Steel V2 Test - Fresh Pool with ORE Pattern
 * 
 * New Program ID: 2pvsnV8MubfdztbxdcLi1u1dYC9XxWrQmEUTB2K8HLw9
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
import { 
  TOKEN_PROGRAM_ID, 
  createMint, 
  getAssociatedTokenAddress, 
  createAssociatedTokenAccountInstruction,
  setAuthority,
  AuthorityType,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

const STEEL_V2_PROGRAM_ID = new PublicKey('2pvsnV8MubfdztbxdcLi1u1dYC9XxWrQmEUTB2K8HLw9');
const RPC_URL = 'https://api.devnet.solana.com';

const POOL_SEED = Buffer.from('pool');
const UNREFINED_SEED = Buffer.from('unrefined');

function loadKeypair(filePath: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filePath, 'utf-8'))));
}

function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_SEED], STEEL_V2_PROGRAM_ID);
}

function getUnrefinedPDA(winner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([UNREFINED_SEED, winner.toBuffer()], STEEL_V2_PROGRAM_ID);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('='.repeat(70));
  console.log('Steel V2 - Fresh Pool Test (ORE Pattern)');
  console.log('='.repeat(70));
  console.log(`Program ID: ${STEEL_V2_PROGRAM_ID.toBase58()}`);

  const connection = new Connection(RPC_URL, 'confirmed');
  const keysDir = path.join(__dirname, 'keys');

  const deployer = loadKeypair(path.join(keysDir, 'player1.json'));
  const playerA = loadKeypair(path.join(keysDir, 'player1.json'));
  const playerB = loadKeypair(path.join(keysDir, 'player2.json'));
  
  const [poolPDA, poolBump] = getPoolPDA();

  console.log(`\nDeployer: ${deployer.publicKey.toBase58().slice(0, 12)}...`);
  console.log(`Pool PDA: ${poolPDA.toBase58()}`);
  console.log(`Pool Bump: ${poolBump}`);

  // ============================================================
  // STEP 1: Initialize Pool
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 1: Initialize Pool');
  console.log('='.repeat(70));

  // Check if pool exists
  let poolInfo = await connection.getAccountInfo(poolPDA);
  let pokerMint: PublicKey;

  if (poolInfo) {
    console.log('✅ Pool already initialized');
    // Read poker mint from pool data (offset 40)
    pokerMint = new PublicKey(poolInfo.data.slice(40, 72));
    console.log(`   POKER Mint: ${pokerMint.toBase58()}`);
  } else {
    // Create new POKER token mint
    console.log('Creating POKER token mint...');
    pokerMint = await createMint(
      connection,
      deployer,
      deployer.publicKey, // mint authority (will transfer to pool)
      null, // freeze authority
      9, // decimals
    );
    console.log(`✅ POKER Mint created: ${pokerMint.toBase58()}`);

    await sleep(1000);

    // Initialize pool
    console.log('Initializing pool...');
    const initIx = new TransactionInstruction({
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: pokerMint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: STEEL_V2_PROGRAM_ID,
      data: Buffer.from([0]), // Initialize instruction
    });

    try {
      await sendAndConfirmTransaction(connection, new Transaction().add(initIx), [deployer]);
      console.log('✅ Pool initialized');
    } catch (e: any) {
      console.log(`❌ Init failed: ${e.message}`);
      if (e.logs) console.log('Logs:', e.logs.slice(-3));
      return;
    }

    await sleep(1000);

    // Transfer mint authority to pool PDA
    console.log('Transferring mint authority to pool PDA...');
    try {
      await setAuthority(
        connection,
        deployer,
        pokerMint,
        deployer.publicKey,
        AuthorityType.MintTokens,
        poolPDA,
      );
      console.log('✅ Mint authority transferred to pool');
    } catch (e: any) {
      console.log(`❌ Transfer authority failed: ${e.message}`);
    }
  }

  await sleep(1000);

  // Verify pool state
  poolInfo = await connection.getAccountInfo(poolPDA);
  if (poolInfo) {
    console.log(`\n📊 Pool State (fresh):`);
    console.log(`   Size: ${poolInfo.data.length} bytes`);
    console.log(`   Owner: ${poolInfo.owner.toBase58()}`);
    
    // Read pool fields (new layout)
    const totalBurned = poolInfo.data.readBigUInt64LE(72);
    const totalUnrefined = poolInfo.data.readBigUInt64LE(104);
    console.log(`   Total Burned: ${Number(totalBurned) / 1e9} POKER`);
    console.log(`   Total Unrefined: ${Number(totalUnrefined) / 1e9} POKER`);
  }

  // ============================================================
  // STEP 2: Mint 1000 POKER to A, B, C (unrefined)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 2: Mint 1000 POKER each to A and B (unrefined)');
  console.log('='.repeat(70));

  const prizeAmount = 1000_000_000_000n; // 1000 POKER

  // Mint to A
  const [unrefinedA] = getUnrefinedPDA(playerA.publicKey);
  const mintDataA = Buffer.alloc(41);
  mintDataA[0] = 4; // MintUnrefined
  mintDataA.writeBigUInt64LE(prizeAmount, 1);

  const mintIxA = new TransactionInstruction({
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
      { pubkey: unrefinedA, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: pokerMint, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: playerA.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: STEEL_V2_PROGRAM_ID,
    data: mintDataA,
  });

  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(mintIxA), [deployer]);
    console.log('✅ Player A: 1000 POKER unrefined');
  } catch (e: any) {
    console.log(`❌ A mint failed: ${e.message}`);
    if (e.logs) console.log('Logs:', e.logs.slice(-3));
  }

  await sleep(1000);

  // Mint to B
  const [unrefinedB] = getUnrefinedPDA(playerB.publicKey);
  const mintDataB = Buffer.alloc(41);
  mintDataB[0] = 4;
  mintDataB.writeBigUInt64LE(prizeAmount, 1);

  const mintIxB = new TransactionInstruction({
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
      { pubkey: unrefinedB, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: pokerMint, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: playerB.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: STEEL_V2_PROGRAM_ID,
    data: mintDataB,
  });

  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(mintIxB), [deployer]);
    console.log('✅ Player B: 1000 POKER unrefined');
  } catch (e: any) {
    console.log(`❌ B mint failed: ${e.message}`);
    if (e.logs) console.log('Logs:', e.logs.slice(-3));
  }

  await sleep(1000);

  // Check pool state
  poolInfo = await connection.getAccountInfo(poolPDA);
  if (poolInfo) {
    const totalUnrefined = poolInfo.data.readBigUInt64LE(104);
    console.log(`\n📊 Pool total_unrefined: ${Number(totalUnrefined) / 1e9} POKER`);
  }

  // ============================================================
  // STEP 3: Player A Claims (pays 10% tax)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 3: Player A Claims (pays 100 POKER tax, B should benefit)');
  console.log('='.repeat(70));

  const playerAATA = await getAssociatedTokenAddress(pokerMint, playerA.publicKey);
  const ataInfoA = await connection.getAccountInfo(playerAATA);
  if (!ataInfoA) {
    const createATAix = createAssociatedTokenAccountInstruction(
      playerA.publicKey, playerAATA, playerA.publicKey, pokerMint
    );
    await sendAndConfirmTransaction(connection, new Transaction().add(createATAix), [playerA]);
  }

  const claimDataA = Buffer.from([5]); // ClaimRefined
  const claimIxA = new TransactionInstruction({
    keys: [
      { pubkey: playerA.publicKey, isSigner: true, isWritable: true },
      { pubkey: unrefinedA, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: playerAATA, isSigner: false, isWritable: true },
      { pubkey: pokerMint, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: STEEL_V2_PROGRAM_ID,
    data: claimDataA,
  });

  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(claimIxA), [playerA]);
    const balanceA = await connection.getTokenAccountBalance(playerAATA);
    console.log(`✅ Player A claimed: ${balanceA.value.uiAmountString} POKER`);
    console.log(`   Expected: 900 POKER (90% of 1000)`);
  } catch (e: any) {
    console.log(`❌ A claim failed: ${e.message}`);
    if (e.logs) console.log('Logs:', e.logs.slice(-3));
  }

  await sleep(1000);

  // Check pool accumulated_refined_per_token
  poolInfo = await connection.getAccountInfo(poolPDA);
  if (poolInfo && poolInfo.data.length >= 120) {
    // New layout: offset 104 is total_unrefined, offset 112 is accumulated_refined_per_token (u128)
    const totalUnrefined = poolInfo.data.readBigUInt64LE(104);
    console.log(`\n📊 Pool after A claims:`);
    console.log(`   Total Unrefined: ${Number(totalUnrefined) / 1e9} POKER (B still holding)`);
  }

  // ============================================================
  // STEP 4: Player B Claims (should get refined bonus)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 4: Player B Claims (should get 900 + ~50 refined bonus)');
  console.log('='.repeat(70));

  const playerBATA = await getAssociatedTokenAddress(pokerMint, playerB.publicKey);
  const ataInfoB = await connection.getAccountInfo(playerBATA);
  if (!ataInfoB) {
    const createATAix = createAssociatedTokenAccountInstruction(
      playerB.publicKey, playerBATA, playerB.publicKey, pokerMint
    );
    await sendAndConfirmTransaction(connection, new Transaction().add(createATAix), [playerB]);
  }

  const balanceBBefore = await connection.getTokenAccountBalance(playerBATA).catch(() => ({ value: { amount: '0' } }));

  // Use ClaimAll (instruction 6) to get both unrefined and refined
  const claimDataB = Buffer.from([6]); // ClaimAll
  const claimIxB = new TransactionInstruction({
    keys: [
      { pubkey: playerB.publicKey, isSigner: true, isWritable: true },
      { pubkey: unrefinedB, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: playerBATA, isSigner: false, isWritable: true },
      { pubkey: pokerMint, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: STEEL_V2_PROGRAM_ID,
    data: claimDataB,
  });

  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(claimIxB), [playerB]);
    const balanceBAfter = await connection.getTokenAccountBalance(playerBATA);
    const received = Number(balanceBAfter.value.amount) - Number(balanceBBefore.value.amount);
    console.log(`\n✅ Player B claimed: ${balanceBAfter.value.uiAmountString} POKER`);
    console.log(`   Received this claim: ${received / 1e9} POKER`);
    console.log(`\n   🎯 Expected with ORE pattern: ~950 POKER`);
    console.log(`      (900 from unrefined + 50 refined bonus from A's tax)`);
    
    if (received >= 945_000_000_000) {
      console.log(`\n   ✅ ORE PATTERN WORKING! B got refined bonus from A's tax!`);
    } else if (received >= 895_000_000_000 && received < 905_000_000_000) {
      console.log(`\n   ❌ OLD BUG: B only got 900, no refined bonus`);
    }
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

  try {
    const balA = await connection.getTokenAccountBalance(playerAATA);
    const balB = await connection.getTokenAccountBalance(playerBATA);
    console.log(`\n💰 Final Balances:`);
    console.log(`   Player A: ${balA.value.uiAmountString} POKER (expected: 900)`);
    console.log(`   Player B: ${balB.value.uiAmountString} POKER (expected: ~950)`);
    console.log(`   Total: ${Number(balA.value.amount) / 1e9 + Number(balB.value.amount) / 1e9} POKER`);
  } catch (e) {}

  console.log('\n' + '='.repeat(70));
}

main().catch(console.error);
