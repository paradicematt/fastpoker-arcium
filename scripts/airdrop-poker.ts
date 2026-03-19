/**
 * Airdrop POKER tokens to a wallet
 * Run: npx ts-node airdrop-poker.ts <WALLET_ADDRESS> <AMOUNT>
 * Example: npx ts-node airdrop-poker.ts 2KskcmUNXDoL2nD1T7DcgVYmxUYUtTyP4RTmPcJRc9xP 10000
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  transfer,
  getAccount,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

const HELIUS_RPC = 'https://devnet.helius-rpc.com/?api-key=8801f9b3-fe0b-42b5-ba5c-67f0fed31c5e';

interface DevnetConfig {
  treasuryWallet: {
    publicKey: string;
    privateKey: number[];
  };
  pokerToken: {
    mint: string;
    decimals: number;
    treasuryAccount: string;
  };
}

async function airdropPoker() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('Usage: npx ts-node airdrop-poker.ts <WALLET_ADDRESS> <AMOUNT>');
    console.log('Example: npx ts-node airdrop-poker.ts 2KskcmUNXDoL2nD1T7DcgVYmxUYUtTyP4RTmPcJRc9xP 10000');
    process.exit(1);
  }

  const recipientAddress = args[0];
  const amount = parseInt(args[1], 10);

  if (isNaN(amount) || amount <= 0) {
    console.error('❌ Invalid amount');
    process.exit(1);
  }

  // Load config
  const configPath = path.join(__dirname, 'devnet-config.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ devnet-config.json not found. Run setup-devnet.ts first.');
    process.exit(1);
  }

  const config: DevnetConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const connection = new Connection(HELIUS_RPC, 'confirmed');

  // Load treasury wallet
  const treasuryWallet = Keypair.fromSecretKey(
    Uint8Array.from(config.treasuryWallet.privateKey)
  );

  const pokerMint = new PublicKey(config.pokerToken.mint);
  const recipientPubkey = new PublicKey(recipientAddress);
  const decimals = config.pokerToken.decimals;

  console.log(`\n🎰 POKER Token Airdrop`);
  console.log(`   Mint: ${pokerMint.toBase58()}`);
  console.log(`   Recipient: ${recipientAddress}`);
  console.log(`   Amount: ${amount.toLocaleString()} POKER\n`);

  // Get or create recipient token account
  console.log('📦 Getting/creating recipient token account...');
  const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    treasuryWallet,
    pokerMint,
    recipientPubkey
  );
  console.log(`   Token Account: ${recipientTokenAccount.address.toBase58()}`);

  // Get treasury token account
  const treasuryTokenAccount = new PublicKey(config.pokerToken.treasuryAccount);

  // Check treasury balance
  const treasuryAccountInfo = await getAccount(connection, treasuryTokenAccount);
  const treasuryBalance = Number(treasuryAccountInfo.amount) / Math.pow(10, decimals);
  console.log(`   Treasury Balance: ${treasuryBalance.toLocaleString()} POKER`);

  if (treasuryBalance < amount) {
    console.error(`❌ Insufficient treasury balance`);
    process.exit(1);
  }

  // Transfer tokens
  console.log('\n💸 Transferring tokens...');
  const transferAmount = amount * Math.pow(10, decimals);
  
  const signature = await transfer(
    connection,
    treasuryWallet,
    treasuryTokenAccount,
    recipientTokenAccount.address,
    treasuryWallet,
    transferAmount
  );

  console.log(`   Transaction: ${signature}`);
  console.log(`   Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

  // Verify recipient balance
  const recipientAccountInfo = await getAccount(connection, recipientTokenAccount.address);
  const recipientBalance = Number(recipientAccountInfo.amount) / Math.pow(10, decimals);
  console.log(`\n✅ Airdrop complete!`);
  console.log(`   Recipient new balance: ${recipientBalance.toLocaleString()} POKER`);
}

airdropPoker().catch(console.error);
