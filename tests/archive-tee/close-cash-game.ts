/**
 * Close the stuck GTG93f cash game table.
 * Step 1: Undelegate from ER using MagicBlock SDK's Permission Program
 * Step 2: Close everything on L1 via admin_close_table + admin_close_accounts
 * 
 * Run: npx ts-node tests/close-cash-game.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as crypto from 'crypto';
import {
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  PERMISSION_PROGRAM_ID,
  createCommitAndUndelegatePermissionInstruction,
} from '@magicblock-labs/ephemeral-rollups-sdk';

const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const ER_RPC = 'https://devnet.magicblock.app';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const KEYPAIR_PATH = 'j:/critters/mini-game/deployer-keypair.json';

const TABLE_PDA = new PublicKey('GTG93fecfhxunTRvFwapp48F4LJihz3PHKrPwfCvi2kw');
const MAX_PLAYERS = 6;

const disc = (name: string) => Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
const ADMIN_CLOSE_TABLE_DISC = disc('admin_close_table');
const ADMIN_CLOSE_ACCOUNTS_DISC = disc('admin_close_accounts');

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function sendTx(conn: Connection, deployer: Keypair, ixs: TransactionInstruction[], label: string): Promise<boolean> {
  try {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = deployer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(deployer);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const conf = await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (conf.value.err) {
      console.log(`  ✗ ${label}: ${JSON.stringify(conf.value.err)}`);
      return false;
    }
    console.log(`  ✓ ${label}: ${sig.slice(0, 24)}...`);
    return true;
  } catch (e: any) {
    console.log(`  ✗ ${label}: ${e.message?.slice(0, 120)}`);
    return false;
  }
}

async function main() {
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf-8'))));
  const er = new Connection(ER_RPC, 'confirmed');
  const l1 = new Connection(L1_RPC, 'confirmed');

  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
  console.log(`Table:    ${TABLE_PDA.toBase58()}\n`);

  // Find all associated accounts on ER (only those that actually exist)
  const delegatedAccounts: PublicKey[] = [];
  const allAccounts: PublicKey[] = [TABLE_PDA];

  // Check table on ER
  const tableErInfo = await er.getAccountInfo(TABLE_PDA);
  if (tableErInfo) {
    console.log(`  Table on ER: ${(tableErInfo.lamports / 1e9).toFixed(4)} SOL, owner=${tableErInfo.owner.toBase58().slice(0, 8)}...`);
    delegatedAccounts.push(TABLE_PDA);
  }

  for (let i = 0; i < MAX_PLAYERS; i++) {
    const [seatPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('seat'), TABLE_PDA.toBuffer(), Buffer.from([i])],
      PROGRAM_ID,
    );
    const [scPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('seat_cards'), TABLE_PDA.toBuffer(), Buffer.from([i])],
      PROGRAM_ID,
    );

    const seatInfo = await er.getAccountInfo(seatPda);
    if (seatInfo && seatInfo.lamports > 0) {
      console.log(`  Seat ${i}: ${seatPda.toBase58().slice(0, 16)}... (${(seatInfo.lamports / 1e9).toFixed(4)} SOL)`);
      delegatedAccounts.push(seatPda);
      allAccounts.push(seatPda);

      // Check for player_table marker
      if (seatInfo.data.length >= 40) {
        const wallet = new PublicKey(seatInfo.data.slice(8, 40));
        const [markerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('player_table'), wallet.toBuffer(), TABLE_PDA.toBuffer()],
          PROGRAM_ID,
        );
        const markerInfo = await er.getAccountInfo(markerPda);
        if (markerInfo && markerInfo.lamports > 0) {
          console.log(`  Marker ${wallet.toBase58().slice(0, 8)}...: ${markerPda.toBase58().slice(0, 16)}...`);
          delegatedAccounts.push(markerPda);
          allAccounts.push(markerPda);
        }
      }
    }

    const scInfo = await er.getAccountInfo(scPda);
    if (scInfo && scInfo.lamports > 0) {
      console.log(`  SeatCards ${i}: ${scPda.toBase58().slice(0, 16)}...`);
      delegatedAccounts.push(scPda);
      allAccounts.push(scPda);
    }
  }

  console.log(`\nDelegated accounts found: ${delegatedAccounts.length}`);

  // === STEP 1: Undelegate from ER using Permission Program SDK ===
  console.log('\n═══ Step 1: Undelegate from ER ═══');
  
  let undelegated = 0;
  for (const pubkey of delegatedAccounts) {
    try {
      const ix = createCommitAndUndelegatePermissionInstruction({
        authority: [deployer.publicKey, true],
        permissionedAccount: [pubkey, false],
      });
      const ok = await sendTx(er, deployer, [ix], `undelegate ${pubkey.toBase58().slice(0, 12)}...`);
      if (ok) undelegated++;
    } catch (e: any) {
      console.log(`  ✗ undelegate ${pubkey.toBase58().slice(0, 12)}...: ${e.message?.slice(0, 100)}`);
    }
    await sleep(500);
  }
  console.log(`\n  Undelegated: ${undelegated}/${delegatedAccounts.length}`);

  // === STEP 2: Wait for L1 propagation ===
  console.log('\n  ⏳ Waiting 15s for L1 propagation...');
  await sleep(15000);

  // === STEP 3: Close on L1 ===
  console.log('\n═══ Step 2: Close on L1 ═══');

  // Close sub-accounts first (seats, seat_cards, markers)
  const subAccounts = allAccounts.filter(pk => !pk.equals(TABLE_PDA));
  const existingSubAccounts: PublicKey[] = [];
  
  for (const pk of subAccounts) {
    const info = await l1.getAccountInfo(pk);
    if (info && info.owner.equals(PROGRAM_ID)) {
      existingSubAccounts.push(pk);
      console.log(`  L1 ready: ${pk.toBase58().slice(0, 12)}... (${(info.lamports / 1e9).toFixed(4)} SOL)`);
    } else if (info) {
      console.log(`  L1 skip:  ${pk.toBase58().slice(0, 12)}... (owner=${info.owner.toBase58().slice(0, 8)}...)`);
    } else {
      console.log(`  L1 gone:  ${pk.toBase58().slice(0, 12)}...`);
    }
  }

  if (existingSubAccounts.length > 0) {
    console.log(`\n  Closing ${existingSubAccounts.length} sub-accounts...`);
    // Batch in groups of 8 to avoid tx size limits
    for (let i = 0; i < existingSubAccounts.length; i += 8) {
      const batch = existingSubAccounts.slice(i, i + 8);
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          ...batch.map(pk => ({ pubkey: pk, isSigner: false, isWritable: true })),
        ],
        data: ADMIN_CLOSE_ACCOUNTS_DISC,
      });
      await sendTx(l1, deployer, [ix], `admin_close_accounts (${batch.length})`);
    }
  }

  // Close table
  const tableInfo = await l1.getAccountInfo(TABLE_PDA);
  if (tableInfo && tableInfo.owner.equals(PROGRAM_ID)) {
    console.log(`\n  Closing table (${(tableInfo.lamports / 1e9).toFixed(4)} SOL)...`);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: TABLE_PDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: ADMIN_CLOSE_TABLE_DISC,
    });
    await sendTx(l1, deployer, [ix], 'admin_close_table');
  } else if (tableInfo) {
    console.log(`\n  ⚠ Table still owned by ${tableInfo.owner.toBase58()} (undelegation may still be propagating)`);
    console.log('  Run this script again in 30 seconds.');
  } else {
    console.log('\n  Table already gone from L1.');
  }

  // Final
  const bal = await l1.getBalance(deployer.publicKey);
  console.log(`\n  Deployer balance: ${(bal / 1e9).toFixed(4)} SOL`);
  console.log('Done!');
}

main().catch(console.error);
