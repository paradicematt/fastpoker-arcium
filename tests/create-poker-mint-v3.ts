/**
 * Create new POKER mint with Pool v3 as authority
 */
import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createInitializeMint2Instruction,
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
} from '@solana/spl-token';
import { SystemProgram, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';

const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const RPC_URL = 'https://devnet.helius-rpc.com/?api-key=8801f9b3-fe0b-42b5-ba5c-67f0fed31c5e';

const POOL_SEED = Buffer.from('pool');

function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_SEED], STEEL_PROGRAM_ID);
}

async function main() {
  console.log('='.repeat(60));
  console.log('CREATE POKER MINT v3');
  console.log('='.repeat(60));

  const connection = new Connection(RPC_URL, 'confirmed');

  // Load payer
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync('J:/Poker/tests/keys/player1.json', 'utf-8')))
  );
  console.log(`\nPayer: ${payer.publicKey.toBase58()}`);

  const [poolPda] = getPoolPDA();
  console.log(`Pool PDA (mint authority): ${poolPda.toBase58()}`);

  // Generate new mint keypair
  const mintKeypair = Keypair.generate();
  console.log(`\nNew POKER Mint: ${mintKeypair.publicKey.toBase58()}`);

  // Save mint keypair
  fs.writeFileSync(
    'J:/Poker/tests/keys/poker-mint-v3.json',
    JSON.stringify(Array.from(mintKeypair.secretKey))
  );
  console.log('Saved mint keypair to tests/keys/poker-mint-v3.json');

  // Create mint
  const lamports = await getMinimumBalanceForRentExemptMint(connection);
  
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(
      mintKeypair.publicKey,
      9, // decimals
      poolPda, // mint authority = Pool PDA
      null, // freeze authority
      TOKEN_PROGRAM_ID
    )
  );

  console.log('\nCreating mint...');
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, mintKeypair]);
  console.log(`✅ TX: ${sig}`);

  console.log('\n' + '='.repeat(60));
  console.log('NEW POKER MINT CREATED');
  console.log('='.repeat(60));
  console.log(`Mint: ${mintKeypair.publicKey.toBase58()}`);
  console.log(`Authority: ${poolPda.toBase58()}`);
  console.log('\nUpdate these files with new mint:');
  console.log('- contracts/api/src/state.rs (POKER_MINT constant if any)');
  console.log('- client/src/lib/tokenomics.ts');
  console.log('- tests/*.ts');
}

main().catch(console.error);
