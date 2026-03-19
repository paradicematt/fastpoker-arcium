/**
 * Test staking flow with Steel v3
 * 1. Burn $POKER to stake
 * 2. Deposit revenue (SOL)
 * 3. Claim stake rewards
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
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
  createBurnInstruction,
} from '@solana/spl-token';
import * as fs from 'fs';

const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
const TREASURY = new PublicKey('4eLLKrNf3KTj8s3cxhGGJDU8mGHPDCFEkNi1TyM5qfQB');
const RPC_URL = 'https://devnet.helius-rpc.com/?api-key=8801f9b3-fe0b-42b5-ba5c-67f0fed31c5e';

const POOL_SEED = Buffer.from('pool');
const STAKE_SEED = Buffer.from('stake');

function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_SEED], STEEL_PROGRAM_ID);
}

function getStakePDA(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([STAKE_SEED, owner.toBuffer()], STEEL_PROGRAM_ID);
}

async function main() {
  console.log('='.repeat(60));
  console.log('STAKING FLOW TEST (Steel v3)');
  console.log('='.repeat(60));

  const connection = new Connection(RPC_URL, 'confirmed');

  // Load authority (pool authority and test staker)
  const authority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync('J:/Poker/tests/keys/player1.json', 'utf-8')))
  );
  console.log(`\nAuthority/Staker: ${authority.publicKey.toBase58()}`);

  const [poolPda] = getPoolPDA();
  const [stakePda] = getStakePDA(authority.publicKey);
  console.log(`Pool PDA: ${poolPda.toBase58()}`);
  console.log(`Stake PDA: ${stakePda.toBase58()}`);

  // Get token account
  const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, authority.publicKey);
  console.log(`Token Account: ${tokenAccount.toBase58()}`);

  // Check if we have POKER tokens
  let tokenBalance = 0n;
  try {
    const account = await getAccount(connection, tokenAccount);
    tokenBalance = account.amount;
    console.log(`POKER Balance: ${Number(tokenBalance) / 1e9} tokens`);
  } catch {
    console.log('No POKER token account - need to mint first');
  }

  // 1. Test burn_stake (stake POKER tokens)
  console.log('\n--- 1. BURN STAKE ---');
  if (tokenBalance > 0n) {
    const stakeAmount = 100n * 1_000_000_000n; // 100 POKER
    console.log(`Staking: ${Number(stakeAmount) / 1e9} POKER`);

    // BurnStake = 1
    // Data: discriminator(1) + amount(8)
    const burnStakeData = Buffer.alloc(9);
    burnStakeData.writeUInt8(1, 0);
    burnStakeData.writeBigUInt64LE(stakeAmount, 1);

    const burnStakeIx = new TransactionInstruction({
      programId: STEEL_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: stakePda, isSigner: false, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: POKER_MINT, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: burnStakeData,
    });

    try {
      const tx = new Transaction().add(burnStakeIx);
      const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
      console.log(`✅ Staked! TX: ${sig}`);
    } catch (e: any) {
      console.log(`❌ Stake failed: ${e.message}`);
      if (e.logs) console.log('Logs:', e.logs.slice(-5).join('\n'));
    }
  } else {
    console.log('⚠️ Need POKER tokens to stake - run mint first');
  }

  // 2. Test deposit_revenue (SOL revenue)
  console.log('\n--- 2. DEPOSIT REVENUE ---');
  const depositAmount = 0.01 * LAMPORTS_PER_SOL; // 0.01 SOL
  console.log(`Depositing: ${depositAmount / LAMPORTS_PER_SOL} SOL`);

  // DepositRevenue = 2
  // Data: discriminator(1) + amount(8) + source_type(1)
  const depositData = Buffer.alloc(10);
  depositData.writeUInt8(2, 0);
  depositData.writeBigUInt64LE(BigInt(Math.floor(depositAmount)), 1);
  depositData.writeUInt8(0, 9); // source_type: 0 = buy-in

  const depositIx = new TransactionInstruction({
    programId: STEEL_PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },  // authority
      { pubkey: poolPda, isSigner: false, isWritable: true },              // pool
      { pubkey: TREASURY, isSigner: false, isWritable: true },             // treasury
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },   // source (authority pays)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: depositData,
  });

  try {
    const tx = new Transaction().add(depositIx);
    const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
    console.log(`✅ Deposited! TX: ${sig}`);
  } catch (e: any) {
    console.log(`❌ Deposit failed: ${e.message}`);
    if (e.logs) console.log('Logs:', e.logs.slice(-5).join('\n'));
  }

  // 3. Test claim_stake_rewards
  console.log('\n--- 3. CLAIM STAKE REWARDS ---');
  
  // Check if stake account exists
  const stakeInfo = await connection.getAccountInfo(stakePda);
  if (stakeInfo) {
    console.log(`Stake account exists: ${stakeInfo.data.length} bytes`);

    // ClaimStakeRewards = 3
    const claimData = Buffer.alloc(1);
    claimData.writeUInt8(3, 0);

    const claimIx = new TransactionInstruction({
      programId: STEEL_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: stakePda, isSigner: false, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: POKER_MINT, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: claimData,
    });

    const balBefore = await connection.getBalance(authority.publicKey);
    
    try {
      const tx = new Transaction().add(claimIx);
      const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
      
      const balAfter = await connection.getBalance(authority.publicKey);
      const reward = balAfter - balBefore + 5000; // Add back tx fee
      console.log(`✅ Claimed! TX: ${sig}`);
      console.log(`   Reward: ${reward} lamports (${reward / LAMPORTS_PER_SOL} SOL)`);
    } catch (e: any) {
      if (e.message.includes('NoRewardsToClaim') || e.message.includes('6010')) {
        console.log('⚠️ No rewards to claim (need stake + revenue deposit first)');
      } else {
        console.log(`❌ Claim failed: ${e.message}`);
        if (e.logs) console.log('Logs:', e.logs.slice(-5).join('\n'));
      }
    }
  } else {
    console.log('⚠️ Stake account does not exist - need to stake first');
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  
  const poolInfo = await connection.getAccountInfo(poolPda);
  if (poolInfo) {
    // Parse pool data
    const data = poolInfo.data;
    const totalBurned = data.readBigUInt64LE(8 + 32 + 32); // After disc + authority + mint
    const solAvailable = data.readBigUInt64LE(8 + 32 + 32 + 8);
    console.log(`Pool total_burned: ${Number(totalBurned) / 1e9} POKER`);
    console.log(`Pool sol_rewards_available: ${Number(solAvailable)} lamports`);
  }
}

main().catch(console.error);
