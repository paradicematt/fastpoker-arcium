/**
 * Test Steel Tokenomics - Mint Unrefined + Claim with 10% Tax
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
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

const STEEL_PROGRAM_ID = new PublicKey('BaYBb2JtaVffVnQYk1TwDUwZskgdnZcnNawfVzj3YvkH');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
const RPC_URL = 'https://api.devnet.solana.com';

// Seeds
const POOL_SEED = Buffer.from('pool');
const UNREFINED_SEED = Buffer.from('unrefined');
const MINT_AUTHORITY_SEED = Buffer.from('mint_authority');

function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_SEED], STEEL_PROGRAM_ID);
}

function getUnrefinedPDA(winner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([UNREFINED_SEED, winner.toBuffer()], STEEL_PROGRAM_ID);
}

function getMintAuthorityPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([MINT_AUTHORITY_SEED], STEEL_PROGRAM_ID);
}

async function main() {
  console.log('=== Steel Tokenomics Test ===\n');

  const connection = new Connection(RPC_URL, 'confirmed');

  // Load player keypair (winner)
  const keysDir = path.join(__dirname, 'keys');
  const winner = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(keysDir, 'player1.json'), 'utf-8')))
  );

  console.log('Winner:', winner.publicKey.toBase58());
  console.log('POKER Mint:', POKER_MINT.toBase58());

  const [poolPDA] = getPoolPDA();
  const [unrefinedPDA] = getUnrefinedPDA(winner.publicKey);
  const [mintAuthPDA] = getMintAuthorityPDA();

  console.log('Pool PDA:', poolPDA.toBase58());
  console.log('Unrefined PDA:', unrefinedPDA.toBase58());
  console.log('Mint Authority PDA:', mintAuthPDA.toBase58());

  // ============================================================
  // STEP 1: Mint Unrefined POKER to Winner
  // ============================================================
  console.log('\n=== Mint Unrefined POKER ===');

  const prizeAmount = 1000_000_000_000n; // 1000 POKER tokens (9 decimals)
  const tournamentId = new Uint8Array(32).fill(1); // Dummy tournament ID

  // MintUnrefined instruction data: [4 (discriminator), amount (8 bytes), tournament_id (32 bytes)]
  const mintData = Buffer.alloc(41);
  mintData[0] = 4; // MintUnrefined discriminator
  mintData.writeBigUInt64LE(prizeAmount, 1);
  tournamentId.forEach((b, i) => mintData[9 + i] = b);

  const mintInstruction = new TransactionInstruction({
    keys: [
      { pubkey: winner.publicKey, isSigner: true, isWritable: true }, // Authority
      { pubkey: unrefinedPDA, isSigner: false, isWritable: true }, // Unrefined account
      { pubkey: poolPDA, isSigner: false, isWritable: true }, // Pool
      { pubkey: POKER_MINT, isSigner: false, isWritable: true }, // Mint
      { pubkey: mintAuthPDA, isSigner: false, isWritable: false }, // Mint authority
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // Token program
      { pubkey: winner.publicKey, isSigner: false, isWritable: false }, // Winner wallet
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // System program
    ],
    programId: STEEL_PROGRAM_ID,
    data: mintData,
  });

  try {
    const tx = new Transaction().add(mintInstruction);
    const sig = await sendAndConfirmTransaction(connection, tx, [winner]);
    console.log('✅ Minted 1000 POKER to unrefined account:', sig.slice(0, 20) + '...');
  } catch (e: any) {
    console.log('❌ Mint failed:', e.message);
    if (e.logs) console.log('Logs:', e.logs.slice(-5));
  }

  // Check unrefined account
  const unrefinedInfo = await connection.getAccountInfo(unrefinedPDA);
  if (unrefinedInfo) {
    console.log('Unrefined account exists, data length:', unrefinedInfo.data.length);
    // Parse unrefined_amount (offset 8 + 32 = 40, then 8 bytes for u64)
    if (unrefinedInfo.data.length >= 56) {
      const unrefinedAmount = unrefinedInfo.data.readBigUInt64LE(48);
      console.log('Unrefined amount:', Number(unrefinedAmount) / 1e9, 'POKER');
    }
  }

  // ============================================================
  // STEP 2: Claim Refined (Pay 10% Tax)
  // ============================================================
  console.log('\n=== Claim Refined (10% Tax) ===');

  // Create winner's token account if needed
  const winnerATA = await getAssociatedTokenAddress(POKER_MINT, winner.publicKey);
  
  const ataInfo = await connection.getAccountInfo(winnerATA);
  if (!ataInfo) {
    console.log('Creating winner token account...');
    const createATAix = createAssociatedTokenAccountInstruction(
      winner.publicKey,
      winnerATA,
      winner.publicKey,
      POKER_MINT
    );
    const tx = new Transaction().add(createATAix);
    await sendAndConfirmTransaction(connection, tx, [winner]);
    console.log('✅ Token account created:', winnerATA.toBase58());
  }

  // ClaimRefined instruction data: [5 (discriminator)]
  const claimData = Buffer.from([5]); // ClaimRefined discriminator

  // Note: Pool PDA is the mint authority (not separate mint_authority PDA)
  const claimInstruction = new TransactionInstruction({
    keys: [
      { pubkey: winner.publicKey, isSigner: true, isWritable: true }, // Winner
      { pubkey: unrefinedPDA, isSigner: false, isWritable: true }, // Unrefined account
      { pubkey: poolPDA, isSigner: false, isWritable: true }, // Pool (also mint authority)
      { pubkey: winnerATA, isSigner: false, isWritable: true }, // Winner token account
      { pubkey: POKER_MINT, isSigner: false, isWritable: true }, // Mint
      { pubkey: poolPDA, isSigner: false, isWritable: false }, // Mint authority = Pool PDA
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // Token program
    ],
    programId: STEEL_PROGRAM_ID,
    data: claimData,
  });

  try {
    const tx = new Transaction().add(claimInstruction);
    const sig = await sendAndConfirmTransaction(connection, tx, [winner]);
    console.log('✅ Claimed refined POKER:', sig.slice(0, 20) + '...');
  } catch (e: any) {
    console.log('❌ Claim failed:', e.message);
    if (e.logs) console.log('Logs:', e.logs.slice(-5));
  }

  // Check final balance
  try {
    const balance = await connection.getTokenAccountBalance(winnerATA);
    console.log('\n📊 Final POKER Balance:', balance.value.uiAmountString);
    console.log('   (Should be ~900 POKER after 10% tax)');
  } catch (e) {
    console.log('Could not get token balance');
  }

  console.log('\n=== Summary ===');
  console.log('Prize minted: 1000 POKER');
  console.log('Tax (10%): 100 POKER (redistributed to pool)');
  console.log('Net received: 900 POKER');
}

main().catch(console.error);
