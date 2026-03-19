import { Connection, PublicKey } from '@solana/web3.js';

async function main() {
  const conn = new Connection('https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df');
  const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
  
  // Browser wallet from 'Dies..j93r'
  const wallet = new PublicKey('DiesxVfBjoxKwH11KRtHqCdxfHuZfyPjkij3VfQVj93r');
  
  const [sessionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('session'), wallet.toBuffer()],
    PROGRAM_ID
  );
  
  console.log('Wallet:', wallet.toBase58());
  console.log('Session PDA:', sessionPda.toBase58());
  
  const sessionInfo = await conn.getAccountInfo(sessionPda);
  if (sessionInfo) {
    console.log('Session exists! Size:', sessionInfo.data.length);
    const data = sessionInfo.data;
    const owner = new PublicKey(data.slice(8, 40));
    const sessionKey = new PublicKey(data.slice(40, 72));
    const validUntil = data.readBigInt64LE(104);
    const isActive = data[113] !== 0;
    
    console.log('Owner:', owner.toBase58());
    console.log('Session Key:', sessionKey.toBase58());
    console.log('Valid Until:', new Date(Number(validUntil) * 1000).toISOString());
    console.log('Is Active:', isActive);
  } else {
    console.log('Session does NOT exist on-chain!');
  }
}

main().catch(console.error);
