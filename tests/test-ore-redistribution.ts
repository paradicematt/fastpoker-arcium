/**
 * Test ORE-style Refined Redistribution (Fixed)
 * 
 * Flow:
 * 1. A, B, C each get 1000 POKER unrefined
 * 2. A claims → pays 100 tax → accumulated_refined_per_token increases
 * 3. B claims → pays 100 tax → gets their share of A's tax
 * 4. C claims last → gets their share of A and B's tax
 * 
 * Expected: Each gets ~33% of taxes from earlier claimers
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

async function mintUnrefined(
  connection: Connection,
  authority: Keypair,
  winner: PublicKey,
  amount: bigint,
  poolPDA: PublicKey
): Promise<void> {
  const [unrefinedPDA] = getUnrefinedPDA(winner);
  
  const mintData = Buffer.alloc(41);
  mintData[0] = 4; // MintUnrefined
  mintData.writeBigUInt64LE(amount, 1);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: unrefinedPDA, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: POKER_MINT, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: winner, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: STEEL_PROGRAM_ID,
    data: mintData,
  });

  await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority]);
}

async function claimRefined(
  connection: Connection,
  winner: Keypair,
  poolPDA: PublicKey
): Promise<number> {
  const [unrefinedPDA] = getUnrefinedPDA(winner.publicKey);
  const winnerATA = await getAssociatedTokenAddress(POKER_MINT, winner.publicKey);

  // Create ATA if needed
  const ataInfo = await connection.getAccountInfo(winnerATA);
  if (!ataInfo) {
    const createATAix = createAssociatedTokenAccountInstruction(
      winner.publicKey, winnerATA, winner.publicKey, POKER_MINT
    );
    await sendAndConfirmTransaction(connection, new Transaction().add(createATAix), [winner]);
  }

  const balanceBefore = await connection.getTokenAccountBalance(winnerATA).catch(() => ({ value: { amount: '0' } }));

  const claimData = Buffer.from([5]); // ClaimRefined
  const claimIx = new TransactionInstruction({
    keys: [
      { pubkey: winner.publicKey, isSigner: true, isWritable: true },
      { pubkey: unrefinedPDA, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: winnerATA, isSigner: false, isWritable: true },
      { pubkey: POKER_MINT, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: STEEL_PROGRAM_ID,
    data: claimData,
  });

  await sendAndConfirmTransaction(connection, new Transaction().add(claimIx), [winner]);

  const balanceAfter = await connection.getTokenAccountBalance(winnerATA);
  return Number(balanceAfter.value.amount) - Number(balanceBefore.value.amount);
}

async function main() {
  console.log('='.repeat(70));
  console.log('ORE-style Refined Redistribution Test (Fixed)');
  console.log('='.repeat(70));

  const connection = new Connection(RPC_URL, 'confirmed');
  const keysDir = path.join(__dirname, 'keys');

  // Load 3 players (use existing funded accounts)
  const playerA = loadKeypair(path.join(keysDir, 'player1.json'));
  const playerB = loadKeypair(path.join(keysDir, 'player2.json'));
  // Create player C if not exists
  const playerCPath = path.join(keysDir, 'player3.json');
  let playerC: Keypair;
  if (fs.existsSync(playerCPath)) {
    playerC = loadKeypair(playerCPath);
  } else {
    playerC = Keypair.generate();
    fs.writeFileSync(playerCPath, JSON.stringify(Array.from(playerC.secretKey)));
  }

  const [poolPDA] = getPoolPDA();

  console.log(`\nPlayer A: ${playerA.publicKey.toBase58().slice(0, 12)}...`);
  console.log(`Player B: ${playerB.publicKey.toBase58().slice(0, 12)}...`);
  console.log(`Player C: ${playerC.publicKey.toBase58().slice(0, 12)}...`);
  console.log(`Pool: ${poolPDA.toBase58()}`);

  // Check pool state
  const poolInfo = await connection.getAccountInfo(poolPDA);
  if (!poolInfo) {
    console.log('\n⚠️  Pool not initialized. The existing pool has old layout.');
    console.log('   Need to use a fresh pool for testing.');
    return;
  }

  console.log(`\nPool account size: ${poolInfo.data.length} bytes`);

  // Read accumulated_refined_per_token (offset 112-128 with new layout)
  // New layout: discriminator(8) + authority(32) + poker_mint(32) + total_burned(8) + 
  //             sol_rewards_available(8) + sol_rewards_distributed(8) + accumulated_rewards_per_token(16) +
  //             total_unrefined(8) + accumulated_refined_per_token(16) + current_epoch(8) + bump(1) + padding(7)
  
  const prizeAmount = 1000_000_000_000n; // 1000 POKER

  // ============================================================
  // STEP 1: Mint 1000 POKER to each player
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 1: Mint 1000 POKER to A, B, C (unrefined)');
  console.log('='.repeat(70));

  try {
    await mintUnrefined(connection, playerA, playerA.publicKey, prizeAmount, poolPDA);
    console.log('✅ Player A: 1000 POKER unrefined');
  } catch (e: any) {
    console.log(`❌ A mint failed: ${e.message.slice(0, 50)}`);
  }
  await sleep(1000);

  try {
    await mintUnrefined(connection, playerA, playerB.publicKey, prizeAmount, poolPDA);
    console.log('✅ Player B: 1000 POKER unrefined');
  } catch (e: any) {
    console.log(`❌ B mint failed: ${e.message.slice(0, 50)}`);
  }
  await sleep(1000);

  try {
    await mintUnrefined(connection, playerA, playerC.publicKey, prizeAmount, poolPDA);
    console.log('✅ Player C: 1000 POKER unrefined');
  } catch (e: any) {
    console.log(`❌ C mint failed: ${e.message.slice(0, 50)}`);
  }
  await sleep(1000);

  // Check pool state
  const poolInfo2 = await connection.getAccountInfo(poolPDA);
  if (poolInfo2) {
    const totalUnrefined = poolInfo2.data.readBigUInt64LE(112);
    console.log(`\n📊 Pool total_unrefined: ${Number(totalUnrefined) / 1e9} POKER`);
  }

  // ============================================================
  // STEP 2: Player A claims (pays 100 tax)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 2: Player A claims (pays 100 tax, B & C should benefit)');
  console.log('='.repeat(70));

  try {
    const received = await claimRefined(connection, playerA, poolPDA);
    console.log(`✅ Player A received: ${received / 1e9} POKER`);
    console.log(`   Expected: 900 POKER (90% of 1000, 100 goes to tax)`);
  } catch (e: any) {
    console.log(`❌ A claim failed: ${e.message}`);
    if (e.logs) console.log('Logs:', e.logs.slice(-3));
  }
  await sleep(1000);

  // ============================================================
  // STEP 3: Player B claims (pays 100 tax + gets share of A's tax)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 3: Player B claims (pays 100 tax, gets share of A\'s 100 tax)');
  console.log('='.repeat(70));

  try {
    const received = await claimRefined(connection, playerB, poolPDA);
    console.log(`✅ Player B received: ${received / 1e9} POKER`);
    console.log(`   Expected: 900 + ~50 refined = ~950 POKER`);
    console.log(`   (50 = 100 tax from A × 1000/2000 weight)`);
  } catch (e: any) {
    console.log(`❌ B claim failed: ${e.message}`);
    if (e.logs) console.log('Logs:', e.logs.slice(-3));
  }
  await sleep(1000);

  // ============================================================
  // STEP 4: Player C claims (gets share of A and B's tax)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 4: Player C claims (gets share of A and B\'s tax)');
  console.log('='.repeat(70));

  try {
    const received = await claimRefined(connection, playerC, poolPDA);
    console.log(`✅ Player C received: ${received / 1e9} POKER`);
    console.log(`   Expected: 900 + ~100 refined = ~1000 POKER`);
    console.log(`   (50 from A's tax + 50 from B's tax)`);
  } catch (e: any) {
    console.log(`❌ C claim failed: ${e.message}`);
    if (e.logs) console.log('Logs:', e.logs.slice(-3));
  }

  // ============================================================
  // Final Summary
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('FINAL SUMMARY');
  console.log('='.repeat(70));

  const players = [
    { name: 'A', kp: playerA },
    { name: 'B', kp: playerB },
    { name: 'C', kp: playerC },
  ];

  console.log('\n💰 Final POKER Balances:');
  for (const p of players) {
    try {
      const ata = await getAssociatedTokenAddress(POKER_MINT, p.kp.publicKey);
      const balance = await connection.getTokenAccountBalance(ata);
      console.log(`   Player ${p.name}: ${balance.value.uiAmountString} POKER`);
    } catch (e) {
      console.log(`   Player ${p.name}: 0 POKER`);
    }
  }

  console.log('\n📋 Expected with ORE pattern:');
  console.log('   A claims first: 900 (no refined bonus)');
  console.log('   B claims second: 900 + 50 = 950 (gets 50% of A\'s 100 tax)');
  console.log('   C claims last: 900 + 50 + 50 = 1000 (gets 50% of A + 100% of B\'s remaining share)');
  console.log('   Total minted: 2850 POKER');
  console.log('   Tax collected: 300 POKER (redistributed)');

  console.log('\n' + '='.repeat(70));
}

main().catch(console.error);
