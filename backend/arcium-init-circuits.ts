/**
 * Initialize Arcium computation definitions + upload circuit bytecode.
 * 
 * Run after arcium localnet is up:
 *   cd backend && npx ts-node ../scripts/arcium-init-circuits.ts
 * 
 * Steps:
 *   1. Call initShuffleCompDef, initRevealCompDef, initShowdownCompDef on FastPoker
 *   2. Upload raw circuit bytecode via @arcium-hq/client uploadCircuit()
 */

import * as anchor from '@coral-xyz/anchor';
import { PublicKey, Keypair, Connection } from '@solana/web3.js';
import * as fs from 'fs';
import * as os from 'os';
import {
  getArciumProgramId,
  getArciumAccountBaseSeed,
  getCompDefAccOffset,
  getCompDefAccAddress,
  getMXEAccAddress,
  getLookupTableAddress,
  getArciumProgram,
  uploadCircuit,
  buildFinalizeCompDefTx,
} from '@arcium-hq/client';

// ── Constants ──
const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const RPC_URL = process.env.SOLANA_RPC_URL || 'http://localhost:8899';
const LUT_PROGRAM_ID = new PublicKey('AddressLookupTab1e1111111111111111111111111');
const CIRCUITS = ['shuffle_and_deal', 'reveal_community', 'reveal_all_showdown'] as const;
const CIRCUIT_BUILD_DIR = process.env.CIRCUIT_BUILD_DIR || '../build';
// When run from backend/, resolve relative to project root

// Discriminators for our init instructions (SHA256("global:<name>")[0..8])
import * as crypto from 'crypto';
function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

const DISC_INIT_SHUFFLE = disc('init_shuffle_comp_def');
const DISC_INIT_REVEAL = disc('init_reveal_comp_def');
const DISC_INIT_SHOWDOWN = disc('init_showdown_comp_def');

function readKpJson(path: string): Keypair {
  const file = fs.readFileSync(path);
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(file.toString())));
}

async function main() {
  // Setup provider
  const connection = new Connection(RPC_URL, 'confirmed');
  // Use local copy of WSL keypair (WSL path not accessible from Windows Node.js)
  const kpPath = process.env.KEYPAIR_PATH || `${__dirname}/.localnet-keypair.json`;
  const payer = readKpJson(kpPath);
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  anchor.setProvider(provider);

  console.log('=== Arcium Circuit Initialization ===');
  console.log(`  RPC: ${RPC_URL}`);
  console.log(`  Payer: ${payer.publicKey.toBase58()}`);
  console.log(`  FastPoker: ${PROGRAM_ID.toBase58()}`);
  console.log(`  Arcium: ${getArciumProgramId().toBase58()}`);

  // Get MXE account for LUT address
  const arciumProgram = getArciumProgram(provider);
  const mxeAddress = getMXEAccAddress(PROGRAM_ID);
  console.log(`  MXE Account: ${mxeAddress.toBase58()}`);

  const mxeAccount = await arciumProgram.account.mxeAccount.fetch(mxeAddress);
  const lutAddress = getLookupTableAddress(PROGRAM_ID, mxeAccount.lutOffsetSlot);
  console.log(`  LUT Address: ${lutAddress.toBase58()}`);

  // ── Step 1: Initialize computation definitions ──
  const circuits: { name: typeof CIRCUITS[number]; disc: Buffer }[] = [
    { name: 'shuffle_and_deal', disc: DISC_INIT_SHUFFLE },
    { name: 'reveal_community', disc: DISC_INIT_REVEAL },
    { name: 'reveal_all_showdown', disc: DISC_INIT_SHOWDOWN },
  ];

  for (const circuit of circuits) {
    const offset = Buffer.from(getCompDefAccOffset(circuit.name)).readUInt32LE(0);
    const compDefPda = getCompDefAccAddress(PROGRAM_ID, offset);
    console.log(`\n--- ${circuit.name} (offset=${offset}) ---`);
    console.log(`  CompDef PDA: ${compDefPda.toBase58()}`);

    // Check if already initialized
    const existing = await connection.getAccountInfo(compDefPda);
    if (existing && existing.data.length > 0) {
      console.log(`  Already initialized (${existing.data.length} bytes). Skipping init.`);
    } else {
      console.log('  Initializing computation definition...');
      const ix = new anchor.web3.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },   // payer
          { pubkey: mxeAddress, isSigner: false, isWritable: true },       // mxe_account
          { pubkey: compDefPda, isSigner: false, isWritable: true },       // comp_def_account
          { pubkey: lutAddress, isSigner: false, isWritable: true },       // address_lookup_table
          { pubkey: LUT_PROGRAM_ID, isSigner: false, isWritable: false },  // lut_program
          { pubkey: getArciumProgramId(), isSigner: false, isWritable: false }, // arcium_program
          { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        ],
        data: circuit.disc,
      });

      try {
        const tx = new anchor.web3.Transaction().add(ix);
        const sig = await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer], {
          commitment: 'confirmed',
        });
        console.log(`  Init TX: ${sig}`);
      } catch (e: any) {
        console.error(`  Init failed: ${e.message?.slice(0, 200)}`);
        // Continue — might already be initialized or have a different error
      }
    }

    // ── Step 2: Upload circuit bytecode ──
    const arcisPath = `${CIRCUIT_BUILD_DIR}/${circuit.name}.arcis`;
    if (!fs.existsSync(arcisPath)) {
      console.log(`  Circuit file not found: ${arcisPath}. Skipping upload (genesis pre-seeded).`);
    } else {
      console.log(`  Uploading circuit bytecode from ${arcisPath}...`);
      const rawCircuit = fs.readFileSync(arcisPath);
      console.log(`  Circuit size: ${rawCircuit.length} bytes`);

      const MAX_UPLOAD_RETRIES = 5;
      let uploadSuccess = false;
      for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
        try {
          const sigs = await uploadCircuit(
            provider,
            circuit.name,
            PROGRAM_ID,
            rawCircuit,
            true,  // logging
          );
          console.log(`  Upload complete! ${sigs.length} transaction(s)`);
          uploadSuccess = true;
          break;
        } catch (e: any) {
          console.error(`  Upload attempt ${attempt}/${MAX_UPLOAD_RETRIES} failed: ${e.message?.slice(0, 200)}`);
          if (attempt < MAX_UPLOAD_RETRIES) {
            console.log(`  Retrying upload in 5s...`);
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }
      if (!uploadSuccess) {
        console.error(`  ❌ Upload FAILED after ${MAX_UPLOAD_RETRIES} attempts — circuit bytecode may be incomplete!`);
      }
    }

    // ── Step 3: Finalize computation definition ──
    // Without finalization, circuit state = OnchainPending → nodes skip execution!
    console.log(`  Finalizing computation definition...`);
    try {
      const finalizeTx = await buildFinalizeCompDefTx(provider, offset, PROGRAM_ID);
      const finalizeSig = await provider.sendAndConfirm(finalizeTx, [], { commitment: 'confirmed' });
      console.log(`  Finalized! TX: ${finalizeSig.slice(0, 24)}...`);
    } catch (e: any) {
      // May already be finalized
      console.log(`  Finalize: ${e.message?.slice(0, 120)}`);
    }
  }

  console.log('\n=== Circuit initialization complete ===');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
