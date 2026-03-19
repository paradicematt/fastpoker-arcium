import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { AuthorityType, setAuthority } from '@solana/spl-token';
import * as fs from 'fs';

const PROGRAM_ID = new PublicKey('HGmQ1CEdxTBBwafj87HRQrUHS3BvQp2tr5fKZLc8Awaw');
const TOKEN_MINT = new PublicKey('PHFU61zVDiqVREWqBZiWQ76vwteYSvTbP6mAVfDiv2n');
const RPC_URL = 'https://api.devnet.solana.com';

// PDA seeds
const POOL_SEED = Buffer.from('pool');

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  
  // Load deployer keypair
  const deployerPath = process.argv[2] || './deployer-keypair.json';
  const deployerData = JSON.parse(fs.readFileSync(deployerPath, 'utf-8'));
  const deployer = Keypair.fromSecretKey(new Uint8Array(deployerData));
  
  console.log('=== Pool Initialization ===');
  console.log('Program ID:', PROGRAM_ID.toBase58());
  console.log('Token Mint:', TOKEN_MINT.toBase58());
  console.log('Deployer:', deployer.publicKey.toBase58());
  
  // Calculate Pool PDA
  const [poolPDA, poolBump] = PublicKey.findProgramAddressSync([POOL_SEED], PROGRAM_ID);
  console.log('Pool PDA:', poolPDA.toBase58());
  console.log('Pool Bump:', poolBump);
  
  // Check if pool already exists
  const poolAccount = await connection.getAccountInfo(poolPDA);
  if (poolAccount) {
    console.log('\nPool already initialized!');
  } else {
    console.log('\nInitializing pool...');
    
    // Create initialize instruction
    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: TOKEN_MINT, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: Buffer.from([0]), // Initialize instruction discriminator
    });
    
    const transaction = new Transaction().add(instruction);
    
    try {
      const txSignature = await sendAndConfirmTransaction(connection, transaction, [deployer]);
      console.log('Pool initialized! TX:', txSignature);
    } catch (err) {
      console.error('Failed to initialize pool:', err);
      return;
    }
  }
  
  // Check current mint authority
  console.log('\n=== Mint Authority Transfer ===');
  const mintInfo = await connection.getParsedAccountInfo(TOKEN_MINT);
  const mintData = (mintInfo.value?.data as any)?.parsed?.info;
  
  if (mintData) {
    console.log('Current mint authority:', mintData.mintAuthority);
    
    if (mintData.mintAuthority === poolPDA.toBase58()) {
      console.log('Mint authority already set to Pool PDA!');
    } else if (mintData.mintAuthority === deployer.publicKey.toBase58()) {
      console.log('Transferring mint authority to Pool PDA...');
      
      try {
        const txSig = await setAuthority(
          connection,
          deployer,
          TOKEN_MINT,
          deployer,
          AuthorityType.MintTokens,
          poolPDA
        );
        console.log('Mint authority transferred! TX:', txSig);
      } catch (err) {
        console.error('Failed to transfer mint authority:', err);
      }
    } else {
      console.log('WARNING: Mint authority is set to an unknown address!');
    }
  }
  
  console.log('\n=== Summary ===');
  console.log('Program ID:', PROGRAM_ID.toBase58());
  console.log('Token Mint:', TOKEN_MINT.toBase58());
  console.log('Pool PDA:', poolPDA.toBase58());
  console.log('\nAdd these to your .env files:');
  console.log(`POKER_PROGRAM_ID=${PROGRAM_ID.toBase58()}`);
  console.log(`POKER_TOKEN_MINT=${TOKEN_MINT.toBase58()}`);
  console.log(`POKER_POOL_PDA=${poolPDA.toBase58()}`);
}

main().catch(console.error);
