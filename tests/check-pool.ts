import { Connection, PublicKey } from '@solana/web3.js';

const STEEL_PROGRAM_ID = new PublicKey('BaYBb2JtaVffVnQYk1TwDUwZskgdnZcnNawfVzj3YvkH');
const POOL_SEED = Buffer.from('pool');

async function main() {
  const [poolPDA] = PublicKey.findProgramAddressSync([POOL_SEED], STEEL_PROGRAM_ID);
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

  console.log('Pool PDA:', poolPDA.toBase58());
  const info = await connection.getAccountInfo(poolPDA);
  if (info) {
    console.log('Pool exists! Size:', info.data.length, 'bytes');
    console.log('Owner:', info.owner.toBase58());
    
    // Parse pool data
    if (info.data.length >= 128) {
      const pokerMint = new PublicKey(info.data.slice(40, 72));
      const totalBurned = info.data.readBigUInt64LE(72);
      const solRewardsAvailable = info.data.readBigUInt64LE(80);
      console.log('\nPool Data:');
      console.log('  POKER Mint:', pokerMint.toBase58());
      console.log('  Total Burned:', Number(totalBurned) / 1e9, 'POKER');
      console.log('  SOL Available:', Number(solRewardsAvailable) / 1e9, 'SOL');
    }
  } else {
    console.log('Pool NOT FOUND');
  }
}

main().catch(console.error);
