/**
 * Close a specific stuck SNG table using admin_close_table.
 * Usage: npx ts-node close-sng-table.ts <TABLE_PUBKEY>
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram,
} from '@solana/web3.js';
import * as crypto from 'crypto';
import * as fs from 'fs';

const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const DEPLOYER_KEY_PATH = 'j:/Poker/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json';

function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

async function main() {
  const tablePubkey = process.argv[2];
  if (!tablePubkey) {
    console.log('Usage: npx ts-node close-sng-table.ts <TABLE_PUBKEY>');
    process.exit(1);
  }

  const table = new PublicKey(tablePubkey);
  const raw = JSON.parse(fs.readFileSync(DEPLOYER_KEY_PATH, 'utf-8'));
  const deployer = Keypair.fromSecretKey(new Uint8Array(raw));
  const conn = new Connection(L1_RPC, 'confirmed');

  console.log(`Authority (SUPER_ADMIN): ${deployer.publicKey.toBase58()}`);
  console.log(`Target table: ${table.toBase58()}`);
  console.log(`Balance: ${(await conn.getBalance(deployer.publicKey) / 1e9).toFixed(4)} SOL\n`);

  // Verify account exists and is owned by our program
  const info = await conn.getAccountInfo(table);
  if (!info) {
    console.log('❌ Table account not found on L1!');
    return;
  }
  console.log(`Owner: ${info.owner.toBase58()}`);
  console.log(`Lamports: ${info.lamports} (${(info.lamports / 1e9).toFixed(6)} SOL)`);
  console.log(`Data length: ${info.data.length}`);

  if (!info.owner.equals(PROGRAM_ID)) {
    console.log(`❌ Table not owned by our program (owned by ${info.owner.toBase58().slice(0, 12)}...)`);
    console.log('   Cannot admin_close — may need MagicBlock admin UndelegateConfinedAccount first.');
    return;
  }

  const data = Buffer.from(info.data);
  const gameType = data[104];
  const phase = data[131];
  const players = data[122];
  const maxPlayers = data[121];
  const GT: Record<number, string> = { 0: 'SNG-HU', 1: 'SNG-6max', 2: 'SNG-9max', 3: 'Cash' };
  const PH: Record<number, string> = { 0: 'Waiting', 1: 'Starting', 7: 'Complete' };

  console.log(`\nGame: ${GT[gameType] || gameType} | Phase: ${PH[phase] || phase} | Players: ${players}/${maxPlayers}`);

  // Send admin_close_table
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc('admin_close_table'),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = deployer.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(deployer);

  console.log('\nSending admin_close_table...');
  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    console.log(`TX: ${sig}`);

    const confirmation = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (confirmation.value.err) {
      console.log(`❌ TX failed: ${JSON.stringify(confirmation.value.err)}`);
    } else {
      console.log('✅ admin_close_table succeeded!');
    }
  } catch (e: any) {
    console.log(`❌ TX error: ${e.message}`);
    if (e.logs) e.logs.forEach((l: string) => console.log(`  ${l}`));
    return;
  }

  // Verify
  const after = await conn.getAccountInfo(table);
  if (!after) {
    console.log('\n✅ Table account CLOSED — rent recovered!');
    console.log(`Post balance: ${(await conn.getBalance(deployer.publicKey) / 1e9).toFixed(4)} SOL`);
  } else {
    console.log(`\n❌ Table still exists (owner: ${after.owner.toBase58().slice(0, 12)}..., lamports: ${after.lamports})`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
