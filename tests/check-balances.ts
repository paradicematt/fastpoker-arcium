import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';

async function main() {
  const c = new Connection(L1_RPC, 'confirmed');
  
  const wallets = [
    ['Player1', '2snSN5GJdVjVqJUjVZQKKKjyLnrukdJZnsCpbHKghweV'],
    ['Player2', '94T22BUkpiCUXZK6y6guf7WCRXdnkeZ6oubcDZncpTiQ'],
    ['Deployer', 'GkfdM1vqRYrU2LJ4ipwCJ3vsr2PGYLpdtdKK121ZkQZg'],
  ];
  
  console.log('=== Wallet Balances ===');
  for (const [name, addr] of wallets) {
    const balance = await c.getBalance(new PublicKey(addr));
    console.log(`${name}: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  }
}

main().catch(console.error);
