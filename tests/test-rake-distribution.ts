/**
 * Test Rake Distribution Logic
 * 
 * Tests the Steel program deposit_rake instruction:
 * - 50% to treasury (team wallet)
 * - 50% to stakers
 * - If no stakers (total_burned == 0), 100% to treasury
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

const STEEL_PROGRAM_ID = new PublicKey('BaYBb2JtaVffVnQYk1TwDUwZskgdnZcnNawfVzj3YvkH');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
const RPC_URL = 'https://api.devnet.solana.com';

const POOL_SEED = Buffer.from('pool');
const STAKE_SEED = Buffer.from('stake');

function loadKeypair(filePath: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filePath, 'utf-8'))));
}

function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_SEED], STEEL_PROGRAM_ID);
}

function getStakePDA(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([STAKE_SEED, owner.toBuffer()], STEEL_PROGRAM_ID);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('='.repeat(70));
  console.log('Rake Distribution Test');
  console.log('='.repeat(70));

  const connection = new Connection(RPC_URL, 'confirmed');
  const keysDir = path.join(__dirname, 'keys');

  const authority = loadKeypair(path.join(keysDir, 'player1.json'));
  const treasury = loadKeypair(path.join(keysDir, 'treasury.json'));
  const [poolPDA] = getPoolPDA();
  const [stakePDA] = getStakePDA(authority.publicKey);

  console.log(`\nAuthority: ${authority.publicKey.toBase58().slice(0, 12)}...`);
  console.log(`Treasury: ${treasury.publicKey.toBase58().slice(0, 12)}...`);
  console.log(`Pool: ${poolPDA.toBase58()}`);

  // ============================================================
  // Check Initial State
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('Initial State');
  console.log('='.repeat(70));

  const treasuryBefore = await connection.getBalance(treasury.publicKey);
  const poolBefore = await connection.getBalance(poolPDA);
  const authorityBefore = await connection.getBalance(authority.publicKey);

  console.log(`Treasury: ${treasuryBefore / LAMPORTS_PER_SOL} SOL`);
  console.log(`Pool: ${poolBefore / LAMPORTS_PER_SOL} SOL`);
  console.log(`Authority: ${authorityBefore / LAMPORTS_PER_SOL} SOL`);

  // Check pool state
  const poolInfo = await connection.getAccountInfo(poolPDA);
  let totalBurned = 0n;
  let solRewardsAvailable = 0n;
  
  if (poolInfo) {
    totalBurned = poolInfo.data.readBigUInt64LE(72);
    solRewardsAvailable = poolInfo.data.readBigUInt64LE(80);
    console.log(`\nPool total_burned (staked): ${Number(totalBurned) / 1e9} POKER`);
    console.log(`Pool sol_rewards_available: ${Number(solRewardsAvailable) / LAMPORTS_PER_SOL} SOL`);
  }

  const hasStakers = Number(totalBurned) > 0;
  console.log(`\n${hasStakers ? '✅ Has stakers - rake will split 50/50' : '⚠️ No stakers - rake will go 100% to treasury'}`);

  // ============================================================
  // Test Deposit Revenue (simpler instruction)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('Test: Deposit Revenue (0.05 SOL)');
  console.log('='.repeat(70));

  const depositAmount = BigInt(0.05 * LAMPORTS_PER_SOL);
  
  // Use DepositRevenue (instruction 2)
  const depositData = Buffer.alloc(10);
  depositData[0] = 2; // DepositRevenue discriminator
  depositData.writeBigUInt64LE(depositAmount, 1);
  depositData[9] = 1; // source_type = rake

  // Updated: now requires treasury account for 50/50 split
  const depositIx = new TransactionInstruction({
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: treasury.publicKey, isSigner: false, isWritable: true }, // treasury gets 50%
      { pubkey: authority.publicKey, isSigner: false, isWritable: true }, // source
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: STEEL_PROGRAM_ID,
    data: depositData,
  });

  const poolBeforeDeposit = await connection.getBalance(poolPDA);

  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(depositIx), [authority]);
    console.log(`✅ Deposited ${Number(depositAmount) / LAMPORTS_PER_SOL} SOL`);
  } catch (e: any) {
    console.log(`❌ Deposit failed: ${e.message}`);
    if (e.logs) console.log('Logs:', e.logs.slice(-3));
  }

  await sleep(500);

  const poolAfterDeposit = await connection.getBalance(poolPDA);
  const expectedStakerShare = hasStakers ? Number(depositAmount) / 2 : 0;
  
  console.log(`\n📊 Results:`);
  console.log(`   Pool received: ${(poolAfterDeposit - poolBeforeDeposit) / LAMPORTS_PER_SOL} SOL`);
  console.log(`   Expected (50% of deposit): ${expectedStakerShare / LAMPORTS_PER_SOL} SOL`);

  // ============================================================
  // Test Claim Staking Rewards
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('Test: Claim Staking Rewards');
  console.log('='.repeat(70));

  const stakeInfo = await connection.getAccountInfo(stakePDA);
  if (stakeInfo) {
    const burnedAmount = stakeInfo.data.readBigUInt64LE(40);
    const pendingRewards = stakeInfo.data.readBigUInt64LE(64);
    console.log(`Staked POKER: ${Number(burnedAmount) / 1e9}`);
    console.log(`Pending rewards (stored): ${Number(pendingRewards) / LAMPORTS_PER_SOL} SOL`);

    if (Number(burnedAmount) > 0) {
      const claimData = Buffer.from([3]); // ClaimStakeRewards
      const claimIx = new TransactionInstruction({
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: stakePDA, isSigner: false, isWritable: true },
          { pubkey: poolPDA, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: STEEL_PROGRAM_ID,
        data: claimData,
      });

      const balanceBefore = await connection.getBalance(authority.publicKey);
      try {
        await sendAndConfirmTransaction(connection, new Transaction().add(claimIx), [authority]);
        const balanceAfter = await connection.getBalance(authority.publicKey);
        const received = balanceAfter - balanceBefore;
        console.log(`\n✅ Claimed: ${received / LAMPORTS_PER_SOL} SOL`);
      } catch (e: any) {
        console.log(`❌ Claim failed: ${e.message.slice(0, 60)}`);
        if (e.logs) console.log('Logs:', e.logs.slice(-3));
      }
    }
  } else {
    console.log('⚠️ No stake account exists');
  }

  // ============================================================
  // Test POKER Token Balance
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('POKER Token Balances');
  console.log('='.repeat(70));

  try {
    const authorityATA = await getAssociatedTokenAddress(POKER_MINT, authority.publicKey);
    const balance = await connection.getTokenAccountBalance(authorityATA);
    console.log(`Authority POKER: ${balance.value.uiAmountString}`);
  } catch (e) {
    console.log('Authority has no POKER token account');
  }

  // ============================================================
  // Final Summary
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('Final State');
  console.log('='.repeat(70));

  const treasuryAfter = await connection.getBalance(treasury.publicKey);
  const poolAfter = await connection.getBalance(poolPDA);
  const authorityAfter = await connection.getBalance(authority.publicKey);

  console.log(`Treasury: ${treasuryAfter / LAMPORTS_PER_SOL} SOL (${(treasuryAfter - treasuryBefore) / LAMPORTS_PER_SOL > 0 ? '+' : ''}${(treasuryAfter - treasuryBefore) / LAMPORTS_PER_SOL})`);
  console.log(`Pool: ${poolAfter / LAMPORTS_PER_SOL} SOL`);
  console.log(`Authority: ${authorityAfter / LAMPORTS_PER_SOL} SOL`);

  // Check updated pool state
  const poolInfoFinal = await connection.getAccountInfo(poolPDA);
  if (poolInfoFinal) {
    const finalTotalBurned = poolInfoFinal.data.readBigUInt64LE(72);
    const finalSolRewards = poolInfoFinal.data.readBigUInt64LE(80);
    console.log(`\n📊 Pool State:`);
    console.log(`   Total Staked: ${Number(finalTotalBurned) / 1e9} POKER`);
    console.log(`   SOL Rewards Available: ${Number(finalSolRewards) / LAMPORTS_PER_SOL} SOL`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('Rake Distribution Rules:');
  console.log('  • 5% rake taken from cash game pots (only after flop)');
  console.log('  • 50% of rake → Treasury (team revenue)');
  console.log('  • 50% of rake → Stakers (POKER burners)');
  console.log('  • If no stakers → 100% to Treasury');
  console.log('='.repeat(70));
}

main().catch(console.error);
