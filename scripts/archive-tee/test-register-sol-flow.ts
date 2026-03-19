/**
 * Test: Register a dummy player and verify SOL flows to treasury + pool (staker rewards).
 * This confirms the Steel deposit_public_revenue CPI works end-to-end.
 */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as fs from 'fs';

const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// register_player discriminator: SHA256("global:register_player")[0..8]
const crypto = require('crypto');
const REGISTER_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:register_player').digest().slice(0, 8)
);

// Pool account offsets (Steel program)
// Pool struct: authority(32) + mint(32) + total_burned(u64) + total_unrefined(u64) + total_refined(u64) +
//              sol_rewards_available(u64) + acc_sol_per_token(u128) + ...
const POOL_OFFSETS = {
  DISCRIMINATOR: 0,       // 8 bytes
  AUTHORITY: 8,           // 32 bytes
  MINT: 40,               // 32 bytes (not used here)
  TOTAL_BURNED: 72,       // u64
  TOTAL_UNREFINED: 80,    // u64
  TOTAL_REFINED: 88,      // u64
  SOL_REWARDS_AVAILABLE: 96, // u64
  ACC_SOL_PER_TOKEN: 104, // u128
};

async function readPoolState(conn: Connection) {
  const info = await conn.getAccountInfo(POOL_PDA);
  if (!info) throw new Error('Pool PDA not found');
  const data = info.data;
  
  const totalBurned = data.readBigUInt64LE(POOL_OFFSETS.TOTAL_BURNED);
  const totalUnrefined = data.readBigUInt64LE(POOL_OFFSETS.TOTAL_UNREFINED);
  const solRewardsAvailable = data.readBigUInt64LE(POOL_OFFSETS.SOL_REWARDS_AVAILABLE);
  // acc_sol_per_token is u128 (16 bytes)
  const accLow = data.readBigUInt64LE(POOL_OFFSETS.ACC_SOL_PER_TOKEN);
  const accHigh = data.readBigUInt64LE(POOL_OFFSETS.ACC_SOL_PER_TOKEN + 8);
  const accSolPerToken = accLow + (accHigh << 64n);
  
  return {
    totalBurned,
    totalUnrefined,
    solRewardsAvailable,
    accSolPerToken,
    poolLamports: BigInt(info.lamports),
  };
}

async function main() {
  const conn = new Connection(L1_RPC, 'confirmed');
  
  // Load player4 keypair
  const player = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync('tests/keys/player4.json', 'utf-8')))
  );
  console.log(`Player: ${player.publicKey.toBase58()}`);
  
  // Check player balance
  const playerBal = await conn.getBalance(player.publicKey);
  console.log(`Player SOL: ${playerBal / LAMPORTS_PER_SOL}`);
  
  // Check if already registered
  const [playerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('player'), player.publicKey.toBuffer()],
    PROGRAM_ID
  );
  const existing = await conn.getAccountInfo(playerPda);
  if (existing) {
    console.log('Player already registered! Use a different keypair.');
    return;
  }
  
  // Read pool state BEFORE
  const treasuryBalBefore = await conn.getBalance(TREASURY);
  const poolBefore = await readPoolState(conn);
  console.log('\n=== BEFORE REGISTER ===');
  console.log(`Treasury SOL: ${treasuryBalBefore / LAMPORTS_PER_SOL}`);
  console.log(`Pool lamports: ${poolBefore.poolLamports}`);
  console.log(`Pool sol_rewards_available: ${poolBefore.solRewardsAvailable}`);
  console.log(`Pool acc_sol_per_token: ${poolBefore.accSolPerToken}`);
  console.log(`Pool total_burned (staked): ${poolBefore.totalBurned}`);
  
  // Build register_player instruction
  // Accounts: player(signer,mut), player_account(mut), treasury(mut), pool(mut), steel_program, system_program
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player.publicKey, isSigner: true, isWritable: true },
      { pubkey: playerPda, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: REGISTER_DISC,
  });
  
  console.log('\nSending register_player TX...');
  const tx = new Transaction().add(ix);
  tx.feePayer = player.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(player);
  
  try {
    const sig = await conn.sendRawTransaction(tx.serialize());
    console.log(`TX: ${sig}`);
    const result = await conn.confirmTransaction(sig, 'confirmed');
    if (result.value.err) {
      console.log(`TX ERROR: ${JSON.stringify(result.value.err)}`);
      return;
    }
    console.log('TX confirmed!');
  } catch (e: any) {
    console.error('TX failed:', e.message?.slice(0, 200));
    // Try to get logs
    if (e.logs) {
      console.log('Logs:', e.logs.slice(-10).join('\n'));
    }
    return;
  }
  
  // Wait a moment for state to settle
  await new Promise(r => setTimeout(r, 2000));
  
  // Read pool state AFTER
  const treasuryBalAfter = await conn.getBalance(TREASURY);
  const poolAfter = await readPoolState(conn);
  console.log('\n=== AFTER REGISTER ===');
  console.log(`Treasury SOL: ${treasuryBalAfter / LAMPORTS_PER_SOL}`);
  console.log(`Pool lamports: ${poolAfter.poolLamports}`);
  console.log(`Pool sol_rewards_available: ${poolAfter.solRewardsAvailable}`);
  console.log(`Pool acc_sol_per_token: ${poolAfter.accSolPerToken}`);
  
  // Calculate deltas
  console.log('\n=== DELTAS ===');
  const treasuryDelta = treasuryBalAfter - treasuryBalBefore;
  const poolLamportsDelta = poolAfter.poolLamports - poolBefore.poolLamports;
  const solRewardsDelta = poolAfter.solRewardsAvailable - poolBefore.solRewardsAvailable;
  const accDelta = poolAfter.accSolPerToken - poolBefore.accSolPerToken;
  
  console.log(`Treasury: +${treasuryDelta} lamports (+${treasuryDelta / LAMPORTS_PER_SOL} SOL)`);
  console.log(`Pool lamports: +${poolLamportsDelta} lamports`);
  console.log(`sol_rewards_available: +${solRewardsDelta} lamports`);
  console.log(`acc_sol_per_token: +${accDelta}`);
  
  // Registration cost is 0.01 SOL = 10_000_000 lamports
  // Expected: 50% to treasury (5_000_000), 50% to pool (5_000_000)
  console.log('\nExpected: treasury +5,000,000 lamports, pool +5,000,000 lamports');
  console.log(`Match: treasury=${treasuryDelta === 5_000_000 ? '✅' : '❌'} pool=${poolLamportsDelta === 5000000n ? '✅' : '❌'}`);
}

main().catch(console.error);
