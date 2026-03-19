import { Connection, PublicKey } from '@solana/web3.js';
const RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');

const getSeatPda = (t: PublicKey, s: number) =>
  PublicKey.findProgramAddressSync([Buffer.from('seat'), t.toBuffer(), Buffer.from([s])], PROGRAM_ID)[0];

(async () => {
  const conn = new Connection(RPC, 'confirmed');
  const tablePda = new PublicKey(process.argv[2] || '7L9zoBBk9YToZ8goCDaAX68xnXucVGFgMVCjQr6qSxCY');
  
  for (let i = 0; i < 2; i++) {
    const seatPda = getSeatPda(tablePda, i);
    const info = await conn.getAccountInfo(seatPda);
    if (info) {
      const chips = info.data.readBigUInt64LE(104);
      const status = info.data[227];
      console.log(`Seat ${i}: chips=${chips}, status=${status}`);
    }
  }
})();
