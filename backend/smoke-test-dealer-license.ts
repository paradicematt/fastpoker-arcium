/**
 * Smoke test: Dealer License System
 *
 * Tests:
 * 1. init_dealer_registry (admin only)
 * 2. grant_dealer_license (admin grants free license)
 * 3. purchase_dealer_license (bonding curve purchase)
 * 4. Verify bonding curve pricing
 * 5. Verify license PDA derivation
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ─── Config ───
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// Bonding curve constants (must match constants.rs)
const BASE_PRICE = 1_000_000;   // 0.001 SOL
const INCREMENT = 1_000_000;     // 0.001 SOL per license
const MAX_PRICE = 9_900_000_000; // 9.9 SOL

// ─── Discriminators ───
const INIT_DEALER_REGISTRY_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:init_dealer_registry').digest().subarray(0, 8),
);
const GRANT_DEALER_LICENSE_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:grant_dealer_license').digest().subarray(0, 8),
);
const PURCHASE_DEALER_LICENSE_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:purchase_dealer_license').digest().subarray(0, 8),
);

// ─── PDA helpers ───
function getDealerRegistryPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dealer_registry')],
    PROGRAM_ID,
  )[0];
}

function getDealerLicensePda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dealer_license'), wallet.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function calculatePrice(totalSold: number): number {
  const price = BASE_PRICE + totalSold * INCREMENT;
  return Math.min(price, MAX_PRICE);
}

// ─── Helpers ───
function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function sendTx(
  conn: Connection,
  ix: TransactionInstruction,
  signers: Keypair[],
  label: string,
): Promise<string> {
  const tx = new Transaction().add(ix);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
  return sig;
}

async function getBalance(conn: Connection, pk: PublicKey): Promise<number> {
  return conn.getBalance(pk);
}

// ─── Main ───
async function main() {
  console.log('🎰 Dealer License Smoke Test');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);

  const conn = new Connection(RPC_URL, 'confirmed');

  // Load admin keypair (SUPER_ADMIN)
  const keypairPath = process.env.SOLANA_KEYPAIR
    || path.resolve(__dirname, '..', 'contracts', 'auth', 'deployers', 'anchor-mini-game-deployer-keypair.json');
  const admin = loadKeypair(keypairPath);
  // Fund admin
  const fundAdmin = await conn.requestAirdrop(admin.publicKey, 2 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(fundAdmin, 'confirmed');
  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  // Generate test wallets
  const buyer = Keypair.generate();
  const beneficiary1 = Keypair.generate();
  const beneficiary2 = Keypair.generate();

  // Fund buyer
  const airdropSig = await conn.requestAirdrop(buyer.publicKey, 2 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(airdropSig, 'confirmed');
  console.log(`  💰 Funded buyer: ${buyer.publicKey.toBase58().slice(0, 12)}...`);

  // Also fund treasury so it has rent-exempt balance
  const treasuryInfo = await conn.getAccountInfo(TREASURY);
  if (!treasuryInfo) {
    const fundTreasury = await conn.requestAirdrop(TREASURY, LAMPORTS_PER_SOL);
    await conn.confirmTransaction(fundTreasury, 'confirmed');
    console.log(`  💰 Funded treasury`);
  }

  const registryPda = getDealerRegistryPda();
  console.log(`\nDealerRegistry PDA: ${registryPda.toBase58()}`);

  // ─── Test 1: init_dealer_registry ───
  console.log('\n--- Test 1: init_dealer_registry ---');
  {
    // Check if already initialized (e.g., from e2e-full-game.ts setup)
    const existing = await conn.getAccountInfo(registryPda);
    if (!existing) {
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: registryPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: INIT_DEALER_REGISTRY_DISC,
      });
      await sendTx(conn, ix, [admin], 'init_dealer_registry');
    } else {
      console.log('  ℹ️  Registry already exists — skipping init');
    }

    // Verify registry account
    const info = await conn.getAccountInfo(registryPda);
    if (!info) throw new Error('Registry PDA not found');
    const data = Buffer.from(info.data);
    const initialTotalSold = data.readUInt32LE(8);
    const initialRevenue = Number(data.readBigUInt64LE(12));
    const authority = new PublicKey(data.subarray(20, 52));
    console.log(`  Registry: total_sold=${initialTotalSold}, revenue=${initialRevenue}, authority=${authority.toBase58().slice(0, 12)}...`);
    if (!authority.equals(admin.publicKey)) throw new Error('Authority mismatch');
    console.log(`  ✅ Registry OK (starting total_sold=${initialTotalSold})`);
    // Store baseline for relative assertions
    (global as any).__initialTotalSold = initialTotalSold;
    (global as any).__initialRevenue = initialRevenue;
  }

  // ─── Test 2: grant_dealer_license (admin grants free license to beneficiary1) ───
  console.log('\n--- Test 2: grant_dealer_license ---');
  {
    const licensePda = getDealerLicensePda(beneficiary1.publicKey);
    console.log(`  Beneficiary: ${beneficiary1.publicKey.toBase58().slice(0, 12)}...`);
    console.log(`  License PDA: ${licensePda.toBase58().slice(0, 12)}...`);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: beneficiary1.publicKey, isSigner: false, isWritable: false },
        { pubkey: registryPda, isSigner: false, isWritable: true },
        { pubkey: licensePda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: GRANT_DEALER_LICENSE_DISC,
    });
    await sendTx(conn, ix, [admin], 'grant_dealer_license');

    // Verify license account
    const info = await conn.getAccountInfo(licensePda);
    if (!info) throw new Error('License PDA not found');
    const data = Buffer.from(info.data);
    const wallet = new PublicKey(data.subarray(8, 40));
    const licenseNum = data.readUInt32LE(40);
    const pricePaid = Number(data.readBigUInt64LE(52));
    console.log(`  License: wallet=${wallet.toBase58().slice(0, 12)}..., number=${licenseNum}, price_paid=${pricePaid}`);
    if (!wallet.equals(beneficiary1.publicKey)) throw new Error('Wallet mismatch');
    // license_number = initialTotalSold (since it's the next one after existing)
    const expectedLicNum = (global as any).__initialTotalSold;
    if (licenseNum !== expectedLicNum) throw new Error(`Expected license_number=${expectedLicNum}, got ${licenseNum}`);
    if (pricePaid !== 0) throw new Error(`Expected price_paid=0 (granted), got ${pricePaid}`);

    // Verify registry updated
    const regInfo = await conn.getAccountInfo(registryPda);
    const regData = Buffer.from(regInfo!.data);
    const totalSold = regData.readUInt32LE(8);
    const expectedSold = (global as any).__initialTotalSold + 1;
    if (totalSold !== expectedSold) throw new Error(`Expected total_sold=${expectedSold}, got ${totalSold}`);
    console.log(`  ✅ Free license granted correctly (license #${licenseNum})`);
  }

  // ─── Test 3: purchase_dealer_license (buyer purchases for beneficiary2) ───
  console.log('\n--- Test 3: purchase_dealer_license ---');
  {
    const licensePda = getDealerLicensePda(beneficiary2.publicKey);
    console.log(`  Buyer: ${buyer.publicKey.toBase58().slice(0, 12)}...`);
    console.log(`  Beneficiary: ${beneficiary2.publicKey.toBase58().slice(0, 12)}...`);

    // Expected price: BASE + 1 * INCREMENT = 0.002 SOL (license #1, since #0 was granted)
    const currentSold = (global as any).__initialTotalSold + 1; // after grant
    const expectedPrice = calculatePrice(currentSold);
    console.log(`  Expected price: ${expectedPrice} lamports (${expectedPrice / LAMPORTS_PER_SOL} SOL)`);

    // Use Steel pool PDA as staker pool (matches program expectation)
    const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
    const stakerPool = PublicKey.findProgramAddressSync([Buffer.from('pool')], STEEL_PROGRAM_ID)[0];
    // Ensure it exists (should be initialized by e2e setup)
    const poolInfo = await conn.getAccountInfo(stakerPool);
    if (!poolInfo) {
      console.log('  ⚠️  Steel pool not found — skipping purchase test');
      return;
    }

    const buyerBalBefore = await getBalance(conn, buyer.publicKey);
    const treasuryBalBefore = await getBalance(conn, TREASURY);
    const stakerBalBefore = await getBalance(conn, stakerPool);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
        { pubkey: beneficiary2.publicKey, isSigner: false, isWritable: false },
        { pubkey: registryPda, isSigner: false, isWritable: true },
        { pubkey: licensePda, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: stakerPool, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: PURCHASE_DEALER_LICENSE_DISC,
    });
    await sendTx(conn, ix, [buyer], 'purchase_dealer_license');

    // Verify license
    const info = await conn.getAccountInfo(licensePda);
    if (!info) throw new Error('License PDA not found');
    const data = Buffer.from(info.data);
    const wallet = new PublicKey(data.subarray(8, 40));
    const licenseNum = data.readUInt32LE(40);
    const pricePaid = Number(data.readBigUInt64LE(52));
    console.log(`  License: wallet=${wallet.toBase58().slice(0, 12)}..., number=${licenseNum}, price_paid=${pricePaid}`);
    if (!wallet.equals(beneficiary2.publicKey)) throw new Error('Wallet mismatch');
    const expectedLicNum2 = (global as any).__initialTotalSold + 1;
    if (licenseNum !== expectedLicNum2) throw new Error(`Expected license_number=${expectedLicNum2}, got ${licenseNum}`);
    if (pricePaid !== expectedPrice) throw new Error(`Expected price=${expectedPrice}, got ${pricePaid}`);

    // Verify SOL transfers
    const treasuryBalAfter = await getBalance(conn, TREASURY);
    const stakerBalAfter = await getBalance(conn, stakerPool);
    const treasuryGain = treasuryBalAfter - treasuryBalBefore;
    const stakerGain = stakerBalAfter - stakerBalBefore;
    const expectedTreasury = Math.floor(expectedPrice * 5000 / 10000);
    const expectedStaker = expectedPrice - expectedTreasury;

    console.log(`  Treasury gained: ${treasuryGain} lamports (expected ${expectedTreasury})`);
    console.log(`  Staker gained: ${stakerGain} lamports (expected ${expectedStaker})`);
    if (treasuryGain !== expectedTreasury) throw new Error(`Treasury share mismatch: ${treasuryGain} != ${expectedTreasury}`);
    if (stakerGain !== expectedStaker) throw new Error(`Staker share mismatch: ${stakerGain} != ${expectedStaker}`);

    // Verify registry
    const regInfo = await conn.getAccountInfo(registryPda);
    const regData = Buffer.from(regInfo!.data);
    const totalSold = regData.readUInt32LE(8);
    const totalRevenue = Number(regData.readBigUInt64LE(12));
    const expectedSold2 = (global as any).__initialTotalSold + 2;
    const expectedRevTotal = (global as any).__initialRevenue + expectedPrice;
    if (totalSold !== expectedSold2) throw new Error(`Expected total_sold=${expectedSold2}, got ${totalSold}`);
    if (totalRevenue !== expectedRevTotal) throw new Error(`Expected revenue=${expectedRevTotal}, got ${totalRevenue}`);

    console.log('  ✅ Purchase succeeded: correct price, correct splits, registry updated');
  }

  // ─── Test 4: Verify bonding curve pricing ───
  console.log('\n--- Test 4: Bonding curve pricing verification ---');
  {
    console.log('  License #0: FREE (granted)');
    for (let i = 0; i <= 10; i++) {
      const p = calculatePrice(i);
      console.log(`  License #${i}: ${p} lamports (${(p / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
    }
    console.log(`  License #9900: ${calculatePrice(9900)} lamports (${(calculatePrice(9900) / LAMPORTS_PER_SOL).toFixed(4)} SOL) — MAX`);
    console.log(`  License #10000: ${calculatePrice(10000)} lamports (capped at MAX)`);
    if (calculatePrice(9900) !== MAX_PRICE) throw new Error('Max price mismatch');
    if (calculatePrice(10000) !== MAX_PRICE) throw new Error('Cap not working');
    console.log('  ✅ Bonding curve pricing correct');
  }

  // ─── Test 5: Duplicate license should fail ───
  console.log('\n--- Test 5: Duplicate license prevention ---');
  {
    const licensePda = getDealerLicensePda(beneficiary1.publicKey);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: beneficiary1.publicKey, isSigner: false, isWritable: false },
        { pubkey: registryPda, isSigner: false, isWritable: true },
        { pubkey: licensePda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: GRANT_DEALER_LICENSE_DISC,
    });
    try {
      await sendTx(conn, ix, [admin], 'grant_dealer_license (duplicate)');
      throw new Error('Should have failed — duplicate license');
    } catch (e: any) {
      if (e.message.includes('Should have failed')) throw e;
      console.log(`  ✅ Duplicate correctly rejected: ${e.message.slice(0, 60)}...`);
    }
  }

  console.log('\n🎉 All Dealer License tests passed!');
}

main().catch((e) => {
  console.error('❌ Test failed:', e);
  process.exit(1);
});
