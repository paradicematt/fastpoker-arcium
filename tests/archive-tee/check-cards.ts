import { Connection, PublicKey } from '@solana/web3.js';

const RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');

async function main() {
  const tablePda = new PublicKey(process.argv[2]);
  const connection = new Connection(RPC, 'confirmed');
  
  for (let i = 0; i < 2; i++) {
    const [seatCards] = PublicKey.findProgramAddressSync(
      [Buffer.from('seat_cards'), tablePda.toBuffer(), Buffer.from([i])],
      PROGRAM_ID
    );
    const data = await connection.getAccountInfo(seatCards);
    if (data) {
      console.log(`Seat ${i} cards: [${data.data[8]}, ${data.data[9]}]`);
    } else {
      console.log(`Seat ${i}: no seat_cards account`);
    }
  }
}

main();
