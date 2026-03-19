/**
 * Test: Full Crank Rewards Pipeline
 *
 * Tests the complete chain: CommitState → process_rake_distribution → distribute_crank_rewards
 *
 * Pipeline:
 *   1. Finds a cash game table with rake_accumulated > 0 (via admin status API)
 *   2. CommitState on TEE to push table data to L1
 *   3. Calls resize_vault + process_rake_distribution on L1 (splits rake 45/25/25/5)
 *   4. Reads CrankTallyER/L1 to discover operators
 *   5. Calls distribute_crank_rewards on L1 (pays operators from crank pool)
 *   6. Verifies CrankOperator.lifetime_sol_earned increased
 *
 * Usage:
 *   npx ts-node scripts/test-distribute-crank-rewards.ts
 *   npx ts-node scripts/test-distribute-crank-rewards.ts <tablePubkey>
 *
 * Prerequisites: Crank service running, at least one cash table with rake > 0
 */
import {
  Connection, PublicKey, Keypair, SystemProgram,
  TransactionInstruction, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const TEE_RPC = 'https://tee.magicblock.app';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

const CRANK_KP_PATH = 'j:/Poker/contracts/auth/deployers/crank-keypair.json';
const DEPLOYER_KP_PATH = 'j:/Poker/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json';

// Table byte offsets
const OFF = {
  GAME_TYPE: 120,
  RAKE_ACCUMULATED: 147,
  PHASE: 160,
  IS_DELEGATED: 174,
  IS_USER_CREATED: 322,
  CREATOR: 290,
  CRANK_POOL_ACCUMULATED: 427,
};

// Vault byte offsets (113 bytes total)
const VAULT_OFF = {
  TABLE: 8,
  TOTAL_DEPOSITED: 40,
  TOTAL_WITHDRAWN: 48,
  BUMP: 56,
  RAKE_NONCE: 57,
  TOTAL_RAKE_DISTRIBUTED: 65,
  TOKEN_MINT: 73,
  TOTAL_CRANK_DISTRIBUTED: 105,
};

// CrankTally layout (197 bytes)
const TALLY_OFF = {
  TABLE: 8,
  OPERATORS_START: 40,
  ACTION_COUNT_START: 168,
  TOTAL_ACTIONS: 184,
  LAST_HAND: 188,
};
const MAX_CRANK_OPERATORS = 4;

// CrankOperator offsets (82 bytes)
const OPERATOR_OFF = {
  LIFETIME_SOL_EARNED: 57,
};

// ═══════════════════════════════════════════════════════════════════
// DISCRIMINATORS
// ═══════════════════════════════════════════════════════════════════
function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

const COMMIT_STATE_DISC = disc('commit_state');
const RESIZE_VAULT_DISC = disc('resize_vault');
const PROCESS_RAKE_DIST_DISC = disc('process_rake_distribution');
const DISTRIBUTE_CRANK_REWARDS_DISC = disc('distribute_crank_rewards');

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path, 'utf-8'))));
}
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

const getVaultPda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('vault'), t.toBuffer()], PROGRAM_ID);
const getCrankTallyErPda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('crank_tally_er'), t.toBuffer()], PROGRAM_ID);
const getCrankTallyL1Pda = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('crank_tally_l1'), t.toBuffer()], PROGRAM_ID);
const getCrankOperatorPda = (w: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('crank'), w.toBuffer()], PROGRAM_ID);

interface OperatorInfo {
  pubkey: PublicKey;
  erActions: number;
  l1Actions: number;
  weight: number;
  operatorPda: PublicKey;
}

function parseTallyOperators(data: Buffer, weightMul: number): { pubkey: PublicKey; actions: number; weight: number }[] {
  const result: { pubkey: PublicKey; actions: number; weight: number }[] = [];
  if (data.length < 197) return result;
  for (let i = 0; i < MAX_CRANK_OPERATORS; i++) {
    const pkStart = TALLY_OFF.OPERATORS_START + i * 32;
    const countStart = TALLY_OFF.ACTION_COUNT_START + i * 4;
    const pk = new PublicKey(data.subarray(pkStart, pkStart + 32));
    if (pk.equals(PublicKey.default)) continue;
    const count = data.readUInt32LE(countStart);
    if (count === 0) continue;
    result.push({ pubkey: pk, actions: count, weight: count * weightMul });
  }
  return result;
}

function buildCommitInstruction(payer: PublicKey, accounts: PublicKey[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: COMMIT_STATE_DISC,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      ...accounts.map(a => ({ pubkey: a, isSigner: false, isWritable: true })),
    ],
  });
}

async function getTeeAuthToken(baseUrl: string, kp: Keypair): Promise<string> {
  const nacl = require('tweetnacl');
  const pub = kp.publicKey.toBase58();
  const cr: any = await (await globalThis.fetch(`${baseUrl}/auth/challenge?pubkey=${pub}`)).json();
  if (!cr.challenge) throw new Error(`TEE challenge failed: ${JSON.stringify(cr)}`);
  const sig = nacl.sign.detached(Buffer.from(cr.challenge, 'utf-8'), kp.secretKey);
  const bs58 = require('bs58');
  const lr: any = await (await globalThis.fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey: pub, challenge: cr.challenge, signature: bs58.encode(Buffer.from(sig)) }),
  })).json();
  if (!lr.token) throw new Error(`TEE login failed: ${JSON.stringify(lr)}`);
  return lr.token;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const l1 = new Connection(L1_RPC, 'confirmed');

  // Load keypair first (needed for TEE auth)
  const caller = fs.existsSync(CRANK_KP_PATH) ? loadKeypair(CRANK_KP_PATH) : loadKeypair(DEPLOYER_KP_PATH);
  console.log(`Caller: ${caller.publicKey.toBase58()}`);
  console.log(`Balance: ${((await l1.getBalance(caller.publicKey)) / 1e9).toFixed(4)} SOL\n`);

  // Authenticate with TEE for reads
  let tee: Connection;
  try {
    console.log('Authenticating with TEE...');
    const token = await getTeeAuthToken(TEE_RPC, caller);
    tee = new Connection(`${TEE_RPC}?token=${token}`, 'confirmed');
    console.log('✅ TEE authenticated\n');
  } catch (e: any) {
    console.warn(`⚠️  TEE auth failed: ${e?.message?.slice(0, 80)}`);
    console.warn('Using unauthenticated TEE connection (writes only)\n');
    tee = new Connection(TEE_RPC, 'confirmed');
  }

  // ─── Step 1: Find target table with rake > 0 ───
  let targetTable: PublicKey;
  const cliArg = process.argv[2];

  if (cliArg) {
    targetTable = new PublicKey(cliArg);
    console.log(`Using provided table: ${targetTable.toBase58()}`);
  } else {
    console.log('Querying admin status API for tables with rake > 0...');
    let statusData: any;
    try {
      const resp = await fetch('http://localhost:3000/api/admin/status');
      statusData = await resp.json();
    } catch {
      console.error('❌ Cannot reach admin status API at localhost:3000. Is the frontend running?');
      process.exit(1);
    }

    const allTables = [...(statusData.tables?.er || []), ...(statusData.tables?.l1 || [])];
    const cashWithRake = allTables
      .filter((t: any) => t.gameType === 3 && t.rakeAccumulated > 0)
      .sort((a: any, b: any) => b.rakeAccumulated - a.rakeAccumulated);

    console.log(`Found ${cashWithRake.length} cash tables with rake > 0`);
    for (const t of cashWithRake) {
      console.log(`  ${t.pubkey.slice(0, 16)}... rake=${t.rakeAccumulated} pool=${t.crankPoolAccumulated} loc=${t.location} hands=${t.handNumber}`);
    }

    if (cashWithRake.length === 0) {
      console.error('\n❌ No cash tables with rake found. Play some hands first.');
      process.exit(1);
    }

    targetTable = new PublicKey(cashWithRake[0].pubkey);
    console.log(`\n✅ Target: ${targetTable.toBase58()} (rake=${cashWithRake[0].rakeAccumulated})`);
  }

  // ─── Step 2: CommitState on TEE → push table data to L1 ───
  console.log('\n═══ Step 2: CommitState (TEE → L1) ═══');
  try {
    const commitIx = buildCommitInstruction(caller.publicKey, [targetTable]);
    const commitTx = new Transaction().add(commitIx);
    commitTx.feePayer = caller.publicKey;
    commitTx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
    commitTx.sign(caller);
    const commitSig = await tee.sendRawTransaction(commitTx.serialize(), { skipPreflight: true });
    console.log(`  Sent: ${commitSig.slice(0, 30)}...`);
    // Poll for confirmation
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const status = await tee.getSignatureStatuses([commitSig]);
      if (status.value[0]?.confirmationStatus === 'confirmed' || status.value[0]?.confirmationStatus === 'finalized') {
        console.log(`  ✅ CommitState confirmed`);
        break;
      }
      if (i === 14) console.log(`  ⚠️  CommitState timeout — continuing anyway`);
    }
    // Wait for L1 propagation
    console.log('  Waiting 5s for L1 propagation...');
    await sleep(5000);
  } catch (e: any) {
    console.warn(`  ⚠️  CommitState failed: ${e?.message?.slice(0, 100)}`);
    console.warn('  Continuing — table data may already be on L1...');
  }

  // ─── Step 3: Read L1 table + vault state ───
  console.log('\n═══ Step 3: Read L1 state ═══');
  const l1TableInfo = await l1.getAccountInfo(targetTable);
  if (!l1TableInfo || l1TableInfo.data.length < 435) {
    console.error(`❌ Table not readable on L1 (size: ${l1TableInfo?.data.length || 0}). May still be delegation-owned.`);
    process.exit(1);
  }
  const tableData = Buffer.from(l1TableInfo.data);
  const rakeAccum = Number(tableData.readBigUInt64LE(OFF.RAKE_ACCUMULATED));
  const crankPoolAccum = Number(tableData.readBigUInt64LE(OFF.CRANK_POOL_ACCUMULATED));
  const isUserCreated = tableData.readUInt8(OFF.IS_USER_CREATED) === 1;
  const creator = new PublicKey(tableData.subarray(OFF.CREATOR, OFF.CREATOR + 32));

  const [vaultPda] = getVaultPda(targetTable);
  const vaultInfo = await l1.getAccountInfo(vaultPda);
  if (!vaultInfo) throw new Error('Vault not found');
  const vaultData = Buffer.from(vaultInfo.data);
  const totalRakeDistributed = vaultData.length >= 73 ? Number(vaultData.readBigUInt64LE(65)) : 0;
  const totalCrankDistributed = vaultData.length >= 113 ? Number(vaultData.readBigUInt64LE(105)) : 0;

  console.log(`  rake_accumulated:        ${rakeAccum}`);
  console.log(`  crank_pool_accumulated:  ${crankPoolAccum}`);
  console.log(`  vault.total_rake_distributed:  ${totalRakeDistributed}`);
  console.log(`  vault.total_crank_distributed: ${totalCrankDistributed}`);
  console.log(`  vault.lamports: ${vaultInfo.lamports}`);
  console.log(`  isUserCreated: ${isUserCreated}, creator: ${creator.toBase58().slice(0, 12)}...`);

  const rakeDelta = rakeAccum - totalRakeDistributed;
  if (rakeDelta <= 0) {
    console.log('\n⚠️  No new rake to distribute (rakeDelta=0). Already distributed.');
    // Check if crank pool has undistributed funds
    if (crankPoolAccum > totalCrankDistributed) {
      console.log(`  But crank pool has undistributed funds: ${crankPoolAccum - totalCrankDistributed}. Skipping to Step 5.`);
    } else {
      console.log('  Nothing to do.');
      process.exit(0);
    }
  }

  // ─── Step 4: process_rake_distribution on L1 ───
  if (rakeDelta > 0) {
    console.log(`\n═══ Step 4: process_rake_distribution (delta=${rakeDelta}) ═══`);
    const creatorAccount = isUserCreated ? creator : TREASURY;

    const resizeIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: caller.publicKey, isSigner: true, isWritable: true },
        { pubkey: targetTable, isSigner: false, isWritable: false },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: RESIZE_VAULT_DISC,
    });

    const distIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: caller.publicKey, isSigner: true, isWritable: true },
        { pubkey: targetTable, isSigner: false, isWritable: false },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: POOL_PDA, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: creatorAccount, isSigner: false, isWritable: true },
        { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: PROCESS_RAKE_DIST_DISC,
    });

    try {
      const sig = await sendAndConfirmTransaction(l1, new Transaction().add(resizeIx).add(distIx), [caller], {
        commitment: 'confirmed',
      });
      console.log(`  ✅ process_rake_distribution confirmed: ${sig.slice(0, 30)}...`);
    } catch (e: any) {
      console.error(`  ❌ process_rake_distribution FAILED: ${e?.message?.slice(0, 200)}`);
      // Check if it's an already-distributed scenario
      if (e?.message?.includes('already') || crankPoolAccum > totalCrankDistributed) {
        console.log('  Continuing to distribute_crank_rewards anyway...');
      } else {
        process.exit(1);
      }
    }

    // Re-read vault after distribution
    await sleep(2000);
    const vaultAfterDist = await l1.getAccountInfo(vaultPda);
    if (vaultAfterDist) {
      const vd = Buffer.from(vaultAfterDist.data);
      const newRakeDist = vd.length >= 73 ? Number(vd.readBigUInt64LE(65)) : 0;
      const newCrankPool = vd.length >= 113 ? Number(vd.readBigUInt64LE(105)) : 0;
      console.log(`  After: vault.total_rake_distributed=${newRakeDist}, vault.total_crank_distributed=${newCrankPool}`);
    }
  }

  // Re-read table on L1 for updated crank_pool_accumulated
  const l1TableAfter = await l1.getAccountInfo(targetTable);
  const tableDataAfter = l1TableAfter ? Buffer.from(l1TableAfter.data) : tableData;
  const crankPoolAfter = Number(tableDataAfter.readBigUInt64LE(OFF.CRANK_POOL_ACCUMULATED));
  const vaultAfter = await l1.getAccountInfo(vaultPda);
  const vaultDataAfter = vaultAfter ? Buffer.from(vaultAfter.data) : vaultData;
  const crankDistAfter = vaultDataAfter.length >= 113 ? Number(vaultDataAfter.readBigUInt64LE(105)) : 0;
  const crankDelta = crankPoolAfter - crankDistAfter;

  console.log(`\n  crank_pool_accumulated (after rake dist): ${crankPoolAfter}`);
  console.log(`  vault.total_crank_distributed:            ${crankDistAfter}`);
  console.log(`  Crank delta to distribute:                ${crankDelta}`);

  if (crankDelta <= 0) {
    console.log('\n⚠️  No crank pool funds to distribute. process_rake_distribution may not have set crank pool.');
    process.exit(0);
  }

  // ─── Step 5: Read CrankTallies + distribute_crank_rewards ───
  console.log('\n═══ Step 5: distribute_crank_rewards ═══');

  const [erTallyPda] = getCrankTallyErPda(targetTable);
  const [l1TallyPda] = getCrankTallyL1Pda(targetTable);
  // Read tallies from BOTH L1 and TEE (ER tally might be delegation-owned)
  let erTallyData: Buffer | null = null;
  let l1TallyData: Buffer | null = null;

  // CrankTallyER — try L1 first (may have been committed), then TEE
  const erL1 = await l1.getAccountInfo(erTallyPda);
  if (erL1 && erL1.data.length >= 197) {
    erTallyData = Buffer.from(erL1.data);
    console.log(`  CrankTallyER: read from L1 (${erL1.data.length} bytes)`);
  } else {
    // Try TEE
    try {
      const erTee = await tee.getAccountInfo(erTallyPda);
      if (erTee && erTee.data.length >= 197) {
        erTallyData = Buffer.from(erTee.data);
        console.log(`  CrankTallyER: read from TEE (${erTee.data.length} bytes)`);
        // Need to commit this to L1 too for the instruction to read it
        console.log('  CommitState CrankTallyER...');
        try {
          const cix = buildCommitInstruction(caller.publicKey, [erTallyPda]);
          const ctx = new Transaction().add(cix);
          ctx.feePayer = caller.publicKey;
          ctx.recentBlockhash = (await l1.getLatestBlockhash()).blockhash;
          ctx.sign(caller);
          await tee.sendRawTransaction(ctx.serialize(), { skipPreflight: true });
          console.log('  Waiting 5s...');
          await sleep(5000);
        } catch (e: any) {
          console.warn(`  ⚠️  CommitState CrankTallyER failed: ${e?.message?.slice(0, 80)}`);
        }
      }
    } catch {}
  }

  // CrankTallyL1 — always on L1
  const l1TallyInfo = await l1.getAccountInfo(l1TallyPda);
  if (l1TallyInfo && l1TallyInfo.data.length >= 197) {
    l1TallyData = Buffer.from(l1TallyInfo.data);
    console.log(`  CrankTallyL1: read from L1 (${l1TallyInfo.data.length} bytes)`);
  }

  if (!erTallyData && !l1TallyData) {
    console.error('  ❌ No tally data found. CrankTally PDAs may not be initialized for this table.');
    process.exit(1);
  }

  const erOps = erTallyData ? parseTallyOperators(erTallyData, 1) : [];
  const l1Ops = l1TallyData ? parseTallyOperators(l1TallyData, 2) : [];

  // Merge operators
  const merged = new Map<string, OperatorInfo>();
  for (const op of [...erOps, ...l1Ops]) {
    const key = op.pubkey.toBase58();
    const existing = merged.get(key);
    if (existing) {
      if (op.weight === op.actions) existing.erActions += op.actions; // weight=1x means ER
      else existing.l1Actions += op.actions;
      existing.weight += op.weight;
    } else {
      const [opPda] = getCrankOperatorPda(op.pubkey);
      merged.set(key, {
        pubkey: op.pubkey,
        erActions: op.weight === op.actions ? op.actions : 0,
        l1Actions: op.weight === op.actions * 2 ? op.actions : 0,
        weight: op.weight,
        operatorPda: opPda,
      });
    }
  }

  const operators = Array.from(merged.values());
  const totalWeight = operators.reduce((s, o) => s + o.weight, 0);

  console.log(`\n  Operators found: ${operators.length}, total weight: ${totalWeight}`);
  for (const op of operators) {
    const share = totalWeight > 0 ? Math.floor((crankDelta * op.weight) / totalWeight) : 0;
    console.log(`    ${op.pubkey.toBase58().slice(0, 16)}... weight=${op.weight} expected_share=${share} lamports`);
  }

  if (operators.length === 0) {
    console.error('  ❌ No operators found in tallies.');
    process.exit(1);
  }

  // Read BEFORE state
  const beforeEarned = new Map<string, bigint>();
  for (const op of operators) {
    const opInfo = await l1.getAccountInfo(op.operatorPda);
    if (opInfo && opInfo.data.length >= OPERATOR_OFF.LIFETIME_SOL_EARNED + 8) {
      const earned = Buffer.from(opInfo.data).readBigUInt64LE(OPERATOR_OFF.LIFETIME_SOL_EARNED);
      beforeEarned.set(op.pubkey.toBase58(), earned);
      console.log(`    BEFORE lifetime_sol_earned = ${earned}`);
    } else {
      console.warn(`    ⚠️  CrankOperator PDA not found for ${op.pubkey.toBase58().slice(0, 12)}...`);
      beforeEarned.set(op.pubkey.toBase58(), 0n);
    }
  }

  // Build distribute_crank_rewards TX
  const remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  for (const op of operators) {
    remainingAccounts.push({ pubkey: op.pubkey, isSigner: false, isWritable: true });
    remainingAccounts.push({ pubkey: op.operatorPda, isSigner: false, isWritable: true });
  }

  const distributeIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: caller.publicKey, isSigner: true, isWritable: true },
      { pubkey: targetTable, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: erTallyPda, isSigner: false, isWritable: false },
      { pubkey: l1TallyPda, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...remainingAccounts,
    ],
    data: DISTRIBUTE_CRANK_REWARDS_DISC,
  });

  try {
    const sig = await sendAndConfirmTransaction(l1, new Transaction().add(distributeIx), [caller], {
      commitment: 'confirmed',
    });
    console.log(`\n  ✅ distribute_crank_rewards confirmed: ${sig}`);
  } catch (e: any) {
    console.error(`\n  ❌ distribute_crank_rewards FAILED: ${e?.message?.slice(0, 200)}`);
    process.exit(1);
  }

  // ─── Step 6: Verify results ───
  console.log('\n═══ Step 6: Verify Results ═══');

  const vaultFinal = await l1.getAccountInfo(vaultPda);
  if (vaultFinal && vaultFinal.data.length >= 113) {
    const finalDist = Number(Buffer.from(vaultFinal.data).readBigUInt64LE(105));
    console.log(`  vault.total_crank_distributed: ${crankDistAfter} → ${finalDist} (+${finalDist - crankDistAfter})`);
  }

  let allPass = true;
  for (const op of operators) {
    const opInfo = await l1.getAccountInfo(op.operatorPda);
    if (opInfo && opInfo.data.length >= OPERATOR_OFF.LIFETIME_SOL_EARNED + 8) {
      const after = Buffer.from(opInfo.data).readBigUInt64LE(OPERATOR_OFF.LIFETIME_SOL_EARNED);
      const before = beforeEarned.get(op.pubkey.toBase58()) || 0n;
      const gain = after - before;
      console.log(`  ${op.pubkey.toBase58().slice(0, 16)}... earned: ${before} → ${after} (+${gain}) ${gain > 0n ? '✅' : '❌'}`);
      if (gain <= 0n) allPass = false;
    }
  }

  if (allPass) {
    console.log('\n🎉 FULL PIPELINE PASSED — CommitState → process_rake_distribution → distribute_crank_rewards');
  } else {
    console.log('\n⚠️  Some operators did not receive expected payouts.');
  }

  // ─── Step 7: Double-call test ───
  console.log('\n═══ Step 7: Double-call test (should fail) ═══');
  try {
    await sendAndConfirmTransaction(l1, new Transaction().add(distributeIx), [caller], {
      commitment: 'confirmed',
      skipPreflight: false,
    });
    console.log('  ❌ UNEXPECTED: Second call succeeded');
  } catch (e: any) {
    console.log(`  ✅ Double-call correctly rejected: ${e?.message?.slice(0, 100)}`);
  }
}

main().catch((e) => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
