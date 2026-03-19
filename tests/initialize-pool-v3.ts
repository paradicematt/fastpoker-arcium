/**
 * Initialize Steel Pool v3 (fresh start)
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as fs from 'fs';

const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
const RPC_URL = 'https://devnet.helius-rpc.com/?api-key=8801f9b3-fe0b-42b5-ba5c-67f0fed31c5e';

const POOL_SEED = Buffer.from('pool');

function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_SEED], STEEL_PROGRAM_ID);
}

async function main() {
  console.log('='.repeat(60));
  console.log('INITIALIZE STEEL POOL V3');
  console.log('='.repeat(60));

  const connection = new Connection(RPC_URL, 'confirmed');

  // Load authority (will be pool authority)
  const authority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync('J:/Poker/tests/keys/player1.json', 'utf-8')))
  );
  console.log(`\nAuthority: ${authority.publicKey.toBase58()}`);
  console.log(`Steel Program: ${STEEL_PROGRAM_ID.toBase58()}`);
  console.log(`POKER Mint: ${POKER_MINT.toBase58()}`);

  const [poolPda, bump] = getPoolPDA();
  console.log(`Pool PDA: ${poolPda.toBase58()} (bump: ${bump})`);

  // Check if pool already exists
  const poolInfo = await connection.getAccountInfo(poolPda);
  if (poolInfo) {
    console.log(`\n⚠️ Pool already exists with ${poolInfo.data.length} bytes`);
    console.log('   Owner:', poolInfo.owner.toBase58());
    return;
  }

  console.log('\nPool does not exist. Initializing...');

  // Build initialize instruction
  // Steel format: discriminator(1) only for Initialize
  const instructionData = Buffer.alloc(1);
  instructionData.writeUInt8(0, 0); // Initialize = 0

  const initIx = new TransactionInstruction({
    programId: STEEL_PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: POKER_MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: instructionData,
  });

  try {
    const tx = new Transaction().add(initIx);
    const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
    console.log(`\n✅ Pool initialized!`);
    console.log(`   TX: ${sig}`);

    // Verify pool
    const newPoolInfo = await connection.getAccountInfo(poolPda);
    if (newPoolInfo) {
      console.log(`   Pool size: ${newPoolInfo.data.length} bytes`);
      console.log(`   Owner: ${newPoolInfo.owner.toBase58()}`);
    }
  } catch (e: any) {
    console.log(`\n❌ Initialize failed: ${e.message}`);
    if (e.logs) {
      console.log('Logs:', e.logs.join('\n'));
    }
  }

  console.log('\n' + '='.repeat(60));
}

main().catch(console.error);
