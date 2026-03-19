/**
 * Test SOL Distribution Flow
 * 
 * 1. Read pool state (before)
 * 2. Register a fresh player (pays 0.01 SOL → CPI into Steel → 50/50 split)
 * 3. Read pool state (after)
 * 4. Verify sol_rewards_available increased by 0.005 SOL
 * 5. If a staker exists, check their claimable rewards
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction
} from '@solana/web3.js';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ─── Config ───
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const ANCHOR_PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// Anchor register discriminator: sha256("global:register_player")[0..8]
const REGISTER_DISC = Buffer.from([242, 146, 194, 234, 234, 145, 228, 42]);
// Steel init_unrefined discriminator
const INIT_UNREFINED_DISC = Buffer.from([24]);

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function getPlayerPda(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('player'), wallet.toBuffer()],
    ANCHOR_PROGRAM_ID,
  );
}

function getUnrefinedPda(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('unrefined'), wallet.toBuffer()],
    STEEL_PROGRAM_ID,
  );
}

function parsePoolData(data: Buffer) {
  // Pool: repr(C), 8-byte disc
  // authority(32@8) poker_mint(32@40) total_burned(u64@72) sol_avail(u64@80)
  // sol_distributed(u64@88) acc_sol_per_token(u128@96) poker_avail(u64@112)
  // poker_distributed(u64@120) acc_poker(u128@128) total_unrefined(u64@144)
  return {
    totalBurned: Number(data.readBigUInt64LE(72)),
    solRewardsAvailable: Number(data.readBigUInt64LE(80)),
    solRewardsDistributed: Number(data.readBigUInt64LE(88)),
    totalUnrefined: Number(data.readBigUInt64LE(144)),
  };
}

async function main() {
  const conn = new Connection(L1_RPC, 'confirmed');

  // ─── 1. Read pool state BEFORE ───
  console.log('═══════════════════════════════════════');
  console.log('  SOL DISTRIBUTION TEST');
  console.log('═══════════════════════════════════════\n');

  const poolBefore = await conn.getAccountInfo(POOL_PDA);
  if (!poolBefore) throw new Error('Pool PDA not found');
  const before = parsePoolData(Buffer.from(poolBefore.data));
  const poolLamportsBefore = poolBefore.lamports;

  console.log('POOL STATE (BEFORE):');
  console.log(`  Total staked (burned): ${before.totalBurned / 1e9} POKER`);
  console.log(`  SOL rewards available: ${before.solRewardsAvailable / LAMPORTS_PER_SOL} SOL (${before.solRewardsAvailable} lamports)`);
  console.log(`  SOL rewards distributed: ${before.solRewardsDistributed / LAMPORTS_PER_SOL} SOL`);
  console.log(`  Pool lamports: ${poolLamportsBefore / LAMPORTS_PER_SOL} SOL`);
  console.log(`  Total unrefined: ${before.totalUnrefined / 1e6} POKER\n`);

  // Check treasury before
  const treasuryBefore = await conn.getAccountInfo(TREASURY);
  const treasuryLamportsBefore = treasuryBefore?.lamports || 0;
  console.log(`  Treasury balance: ${treasuryLamportsBefore / LAMPORTS_PER_SOL} SOL\n`);

  // ─── 2. Pick a fresh player keypair ───
  // Use player3 through player9 (find one that isn't registered yet)
  const playerFiles = ['player3', 'player4', 'player5', 'player6', 'player7', 'player8', 'player9'];
  let playerKp: Keypair | null = null;
  let playerName = '';

  for (const name of playerFiles) {
    const kp = loadKeypair(`tests/keys/${name}.json`);
    const [pda] = getPlayerPda(kp.publicKey);
    const info = await conn.getAccountInfo(pda);
    if (!info) {
      playerKp = kp;
      playerName = name;
      break;
    }
    console.log(`  ${name} (${kp.publicKey.toBase58().slice(0, 12)}...) already registered, skipping`);
  }

  if (!playerKp) {
    console.log('\n⚠ All test players already registered. Generate a new keypair...');
    playerKp = Keypair.generate();
    playerName = 'fresh-keypair';
  }

  console.log(`\nUsing player: ${playerName} (${playerKp.publicKey.toBase58()})`);

  // Check SOL balance
  const balance = await conn.getBalance(playerKp.publicKey);
  console.log(`  SOL balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 20_000_000) { // need at least 0.02 SOL (0.01 fee + rent)
    console.log('  ⚠ Insufficient SOL. Requesting airdrop...');
    const sig = await conn.requestAirdrop(playerKp.publicKey, LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig);
    console.log(`  Airdrop confirmed: ${sig.slice(0, 20)}...`);
  }

  // ─── 3. Register player ───
  console.log('\nRegistering player (0.01 SOL → CPI to Steel DepositPublicRevenue)...');

  const [playerPda] = getPlayerPda(playerKp.publicKey);
  const [unrefinedPda] = getUnrefinedPda(playerKp.publicKey);

  const tx = new Transaction();

  // IX 1: Anchor register_player (CPI into Steel for 50/50 split)
  tx.add(new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: playerKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: playerPda, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: REGISTER_DISC,
  }));

  // IX 2: Steel init_unrefined
  tx.add(new TransactionInstruction({
    programId: STEEL_PROGRAM_ID,
    keys: [
      { pubkey: playerKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: unrefinedPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: INIT_UNREFINED_DISC,
  }));

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [playerKp], {
      commitment: 'confirmed',
      skipPreflight: false,
    });
    console.log(`  ✅ Registration TX: ${sig}`);
  } catch (e: any) {
    console.error(`  ❌ Registration failed: ${e.message}`);
    if (e.logs) e.logs.forEach((l: string) => console.log(`    ${l}`));
    process.exit(1);
  }

  // ─── 4. Read pool state AFTER ───
  await new Promise(r => setTimeout(r, 2000)); // wait for confirmation

  const poolAfter = await conn.getAccountInfo(POOL_PDA);
  if (!poolAfter) throw new Error('Pool PDA not found after');
  const after = parsePoolData(Buffer.from(poolAfter.data));
  const poolLamportsAfter = poolAfter.lamports;

  const treasuryAfter = await conn.getAccountInfo(TREASURY);
  const treasuryLamportsAfter = treasuryAfter?.lamports || 0;

  console.log('\nPOOL STATE (AFTER):');
  console.log(`  Total staked (burned): ${after.totalBurned / 1e9} POKER`);
  console.log(`  SOL rewards available: ${after.solRewardsAvailable / LAMPORTS_PER_SOL} SOL (${after.solRewardsAvailable} lamports)`);
  console.log(`  SOL rewards distributed: ${after.solRewardsDistributed / LAMPORTS_PER_SOL} SOL`);
  console.log(`  Pool lamports: ${poolLamportsAfter / LAMPORTS_PER_SOL} SOL`);
  console.log(`  Treasury balance: ${treasuryLamportsAfter / LAMPORTS_PER_SOL} SOL\n`);

  // ─── 5. Verify ───
  const solAvailDiff = after.solRewardsAvailable - before.solRewardsAvailable;
  const poolLamportsDiff = poolLamportsAfter - poolLamportsBefore;
  const treasuryDiff = treasuryLamportsAfter - treasuryLamportsBefore;
  const expectedStakerShare = 5_000_000; // 50% of 0.01 SOL = 0.005 SOL

  console.log('═══════════════════════════════════════');
  console.log('  VERIFICATION');
  console.log('═══════════════════════════════════════');
  console.log(`  SOL rewards available change: +${solAvailDiff} lamports (expected: +${expectedStakerShare})`);
  console.log(`  Pool lamports change: +${poolLamportsDiff} lamports (expected: +${expectedStakerShare})`);
  console.log(`  Treasury change: +${treasuryDiff} lamports (expected: +${expectedStakerShare})`);

  if (before.totalBurned === 0) {
    console.log('\n  ⚠ No stakers! 100% went to treasury (expected behavior).');
    console.log(`  Treasury got: +${treasuryDiff} lamports (should be ~10,000,000 = 0.01 SOL)`);
    if (treasuryDiff >= 10_000_000) {
      console.log('  ✅ PASS: Full amount went to treasury (no stakers)');
    } else {
      console.log('  ❌ FAIL: Treasury did not receive expected amount');
    }
  } else {
    if (solAvailDiff === expectedStakerShare) {
      console.log('  ✅ PASS: Staker rewards accounting correctly updated!');
    } else if (solAvailDiff > 0) {
      console.log(`  ⚠ Partial: Got ${solAvailDiff}, expected ${expectedStakerShare}`);
    } else {
      console.log('  ❌ FAIL: SOL rewards available did not increase');
    }

    if (treasuryDiff === expectedStakerShare) {
      console.log('  ✅ PASS: Treasury received correct 50% share');
    } else {
      console.log(`  ⚠ Treasury got ${treasuryDiff} lamports`);
    }
  }

  console.log('\nDone!');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
