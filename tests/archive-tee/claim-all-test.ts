/**
 * Test claim_all instruction (unrefined + refined together)
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
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import * as fs from 'fs';

const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
const RPC_URL = 'https://devnet.helius-rpc.com/?api-key=8801f9b3-fe0b-42b5-ba5c-67f0fed31c5e';

const POOL_SEED = Buffer.from('pool');
const UNREFINED_SEED = Buffer.from('unrefined');

function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_SEED], STEEL_PROGRAM_ID);
}

function getUnrefinedPDA(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([UNREFINED_SEED, owner.toBuffer()], STEEL_PROGRAM_ID);
}

async function main() {
  console.log('='.repeat(60));
  console.log('CLAIM ALL TEST (Unrefined + Refined)');
  console.log('='.repeat(60));

  const connection = new Connection(RPC_URL, 'confirmed');

  // Load authority (has unrefined tokens from mint_unrefined test)
  const winner = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync('J:/Poker/tests/keys/player1.json', 'utf-8')))
  );
  console.log(`\nWinner: ${winner.publicKey.toBase58()}`);

  const [poolPda] = getPoolPDA();
  const [unrefinedPda] = getUnrefinedPDA(winner.publicKey);
  console.log(`Pool PDA: ${poolPda.toBase58()}`);
  console.log(`Unrefined PDA: ${unrefinedPda.toBase58()}`);

  // Check unrefined account
  const unrefinedInfo = await connection.getAccountInfo(unrefinedPda);
  if (!unrefinedInfo) {
    console.log('\n❌ No unrefined account - need to mint_unrefined first');
    return;
  }

  // Parse unrefined account
  // Unrefined struct: owner(32) + unrefined_amount(8) + refined_amount(8) + refined_debt(16)
  const data = unrefinedInfo.data;
  const unrefinedAmount = data.readBigUInt64LE(8 + 32); // After discriminator + owner
  const refinedAmount = data.readBigUInt64LE(8 + 32 + 8);
  console.log(`\nUnrefined balance: ${Number(unrefinedAmount) / 1e9} POKER`);
  console.log(`Refined balance: ${Number(refinedAmount) / 1e9} POKER`);

  if (unrefinedAmount === 0n && refinedAmount === 0n) {
    console.log('\n⚠️ Nothing to claim - need to mint_unrefined first');
    return;
  }

  // Get token account
  const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, winner.publicKey);
  
  // Check if token account exists
  let tokenBalBefore = 0n;
  try {
    const account = await getAccount(connection, tokenAccount);
    tokenBalBefore = account.amount;
    console.log(`Token balance before: ${Number(tokenBalBefore) / 1e9} POKER`);
  } catch {
    console.log('Creating token account...');
    const createAtaIx = createAssociatedTokenAccountInstruction(
      winner.publicKey,
      tokenAccount,
      winner.publicKey,
      POKER_MINT
    );
    await sendAndConfirmTransaction(connection, new Transaction().add(createAtaIx), [winner]);
    console.log('Token account created');
  }

  // Build claim_all instruction
  // ClaimAll = 6
  const claimData = Buffer.alloc(1);
  claimData.writeUInt8(6, 0);

  const claimIx = new TransactionInstruction({
    programId: STEEL_PROGRAM_ID,
    keys: [
      { pubkey: winner.publicKey, isSigner: true, isWritable: true },     // winner
      { pubkey: unrefinedPda, isSigner: false, isWritable: true },        // unrefined
      { pubkey: poolPda, isSigner: false, isWritable: true },             // pool
      { pubkey: tokenAccount, isSigner: false, isWritable: true },        // token_account
      { pubkey: POKER_MINT, isSigner: false, isWritable: true },          // mint
      { pubkey: poolPda, isSigner: false, isWritable: false },            // mint_authority (pool PDA)
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },   // token_program
    ],
    data: claimData,
  });

  console.log('\nClaiming all (unrefined + refined)...');
  
  try {
    const tx = new Transaction().add(claimIx);
    const sig = await sendAndConfirmTransaction(connection, tx, [winner]);
    console.log(`✅ Claim TX: ${sig}`);

    // Check new balances
    const account = await getAccount(connection, tokenAccount);
    const tokenBalAfter = account.amount;
    const claimed = tokenBalAfter - tokenBalBefore;
    console.log(`\nToken balance after: ${Number(tokenBalAfter) / 1e9} POKER`);
    console.log(`Claimed: ${Number(claimed) / 1e9} POKER`);

    // Calculate expected (90% of unrefined + 100% of refined)
    const expectedNet = (unrefinedAmount * 90n / 100n) + refinedAmount;
    console.log(`Expected (90% unrefined + refined): ${Number(expectedNet) / 1e9} POKER`);
    
    // Verify unrefined account is cleared
    const newUnrefinedInfo = await connection.getAccountInfo(unrefinedPda);
    if (newUnrefinedInfo) {
      const newData = newUnrefinedInfo.data;
      const newUnrefined = newData.readBigUInt64LE(8 + 32);
      const newRefined = newData.readBigUInt64LE(8 + 32 + 8);
      console.log(`\nUnrefined after: ${Number(newUnrefined) / 1e9} POKER`);
      console.log(`Refined after: ${Number(newRefined) / 1e9} POKER`);
    }
  } catch (e: any) {
    console.log(`\n❌ Claim failed: ${e.message}`);
    if (e.logs) console.log('Logs:', e.logs.slice(-5).join('\n'));
  }

  console.log('\n' + '='.repeat(60));
}

main().catch(console.error);
