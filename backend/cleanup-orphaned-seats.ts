/**
 * Cleanup script: undelegate orphaned seat PDAs from ER back to L1,
 * then close them on L1 to recover rent.
 *
 * Step 1: Call admin_undelegate_er on ER (batches of ~8 seats per TX)
 * Step 2: Close the returned seats on L1 via admin_close_table (reusing its close logic)
 *
 * Run: npx ts-node cleanup-orphaned-seats.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import * as crypto from 'crypto';
import * as fs from 'fs';
import bs58 from 'bs58';

const PROGRAM_ID = new PublicKey('4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB');
const ER_RPC = 'https://devnet-us.magicblock.app';
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';

// Discriminators
const SEAT_DISC = crypto.createHash('sha256').update('account:PlayerSeat').digest().slice(0, 8);
const ADMIN_UNDELEGATE_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:admin_undelegate_er').digest().slice(0, 8),
);

// Load deployer keypair (super-admin)
const keyPath = process.env.DEPLOYER_KEYPAIR || 'j:/critters/mini-game/deployer-keypair.json';
const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
const authority = Keypair.fromSecretKey(new Uint8Array(keyData));

const BATCH_SIZE = 8; // seats per TX (stay within TX size limits)

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const er = new Connection(ER_RPC, 'confirmed');
  const l1 = new Connection(L1_RPC, 'confirmed');

  console.log(`Authority: ${authority.publicKey.toBase58()}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);

  // Step 1: Find all orphaned seats on ER
  console.log('\n=== Step 1: Find orphaned seat PDAs on ER ===');
  const erSeats = await er.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(SEAT_DISC) } }],
  });
  console.log(`Found ${erSeats.length} seat PDAs on ER`);

  if (erSeats.length === 0) {
    console.log('Nothing to clean up!');
    return;
  }

  // Show summary
  const walletCounts: Record<string, number> = {};
  let totalLamports = 0;
  for (const { account } of erSeats) {
    const wallet = new PublicKey(account.data.slice(8, 40)).toBase58().slice(0, 12);
    walletCounts[wallet] = (walletCounts[wallet] || 0) + 1;
    totalLamports += account.lamports;
  }
  console.log(`Total rent locked: ${totalLamports} lamports (~${(totalLamports / 1e9).toFixed(4)} SOL)`);
  for (const [w, c] of Object.entries(walletCounts)) {
    console.log(`  ${w}... = ${c} seats`);
  }

  // Step 2: Batch undelegate from ER
  console.log('\n=== Step 2: Undelegate seats from ER (batches of ' + BATCH_SIZE + ') ===');
  const seatPubkeys = erSeats.map(s => s.pubkey);

  for (let i = 0; i < seatPubkeys.length; i += BATCH_SIZE) {
    const batch = seatPubkeys.slice(i, i + BATCH_SIZE);
    console.log(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} seats`);

    const keys = [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
    ];
    for (const seat of batch) {
      keys.push({ pubkey: seat, isSigner: false, isWritable: true });
    }

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys,
      data: ADMIN_UNDELEGATE_DISC,
    });

    try {
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(er, tx, [authority], {
        skipPreflight: true,
        commitment: 'confirmed',
      });
      console.log(`  ✅ Batch undelegated: ${sig.slice(0, 20)}...`);
    } catch (e: any) {
      console.error(`  ❌ Batch failed: ${e?.message?.slice(0, 100)}`);
      // Try individual seats in this batch
      for (const seat of batch) {
        try {
          const singleKeys = [
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },
            { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
            { pubkey: seat, isSigner: false, isWritable: true },
          ];
          const singleIx = new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: singleKeys,
            data: ADMIN_UNDELEGATE_DISC,
          });
          const tx = new Transaction().add(singleIx);
          const sig = await sendAndConfirmTransaction(er, tx, [authority], {
            skipPreflight: true,
            commitment: 'confirmed',
          });
          console.log(`    ✅ ${seat.toBase58().slice(0, 16)}... undelegated: ${sig.slice(0, 16)}...`);
        } catch (e2: any) {
          console.error(`    ❌ ${seat.toBase58().slice(0, 16)}... failed: ${e2?.message?.slice(0, 80)}`);
        }
      }
    }

    await sleep(500); // rate limit
  }

  // Step 3: Wait for L1 propagation, then close seats on L1
  console.log('\n=== Step 3: Waiting 15s for L1 propagation... ===');
  await sleep(15000);

  // Check which seats now exist on L1
  const l1Seats = await l1.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(SEAT_DISC) } }],
  });
  console.log(`Found ${l1Seats.length} seat PDAs on L1 (after undelegation)`);

  if (l1Seats.length === 0) {
    console.log('No seats on L1 to close. They may still be propagating or undelegation failed.');
    return;
  }

  // Close seats on L1 via admin_close_accounts (no discriminator check)
  console.log(`\n=== Step 4: Closing ${l1Seats.length} seat PDAs on L1 (batches of ${BATCH_SIZE}) ===`);
  const ADMIN_CLOSE_ACCTS_DISC = Buffer.from(
    crypto.createHash('sha256').update('global:admin_close_accounts').digest().slice(0, 8),
  );

  let recovered = 0;
  const l1SeatPubkeys = l1Seats.map(s => s.pubkey);

  for (let i = 0; i < l1SeatPubkeys.length; i += BATCH_SIZE) {
    const batch = l1SeatPubkeys.slice(i, i + BATCH_SIZE);
    console.log(`\nClose batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} seats`);

    const keys = [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    ];
    for (const seat of batch) {
      keys.push({ pubkey: seat, isSigner: false, isWritable: true });
    }

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys,
      data: ADMIN_CLOSE_ACCTS_DISC,
    });

    try {
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(l1, tx, [authority], {
        commitment: 'confirmed',
      });
      const batchLamports = batch.reduce((sum, pk) => {
        const found = l1Seats.find(s => s.pubkey.equals(pk));
        return sum + (found ? found.account.lamports : 0);
      }, 0);
      recovered += batchLamports;
      console.log(`  ✅ Batch closed (+${batchLamports} lam): ${sig.slice(0, 20)}...`);
    } catch (e: any) {
      console.error(`  ❌ Batch close failed: ${e?.message?.slice(0, 100)}`);
      // Fall back to individual closes
      for (const seat of batch) {
        try {
          const singleKeys = [
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },
            { pubkey: seat, isSigner: false, isWritable: true },
          ];
          const singleIx = new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: singleKeys,
            data: ADMIN_CLOSE_ACCTS_DISC,
          });
          const tx = new Transaction().add(singleIx);
          const sig = await sendAndConfirmTransaction(l1, tx, [authority], {
            commitment: 'confirmed',
          });
          const found = l1Seats.find(s => s.pubkey.equals(seat));
          const lam = found ? found.account.lamports : 0;
          recovered += lam;
          console.log(`    ✅ ${seat.toBase58().slice(0, 16)}... closed (+${lam} lam) ${sig.slice(0, 16)}...`);
        } catch (e2: any) {
          console.error(`    ❌ ${seat.toBase58().slice(0, 16)}... failed: ${e2?.message?.slice(0, 80)}`);
        }
      }
    }
    await sleep(500);
  }

  console.log(`\n=== Done! Recovered ${recovered} lamports (~${(recovered / 1e9).toFixed(4)} SOL) ===`);
}

main().catch(console.error);
