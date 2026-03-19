import { Connection, PublicKey } from '@solana/web3.js';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const TABLE = new PublicKey(process.argv[2] || '5eoL7zwwTpwWH5Yu6GrKVMKRh8jQiZKvV5w2yiE7UEHA');
const l1 = new Connection('https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df', 'confirmed');

async function main() {
  const maxSeats = parseInt(process.argv[3] || '2');
  for (let i = 0; i < maxSeats; i++) {
    const [dp] = PublicKey.findProgramAddressSync([Buffer.from('deposit_proof'), TABLE.toBuffer(), Buffer.from([i])], PROGRAM_ID);
    const info = await l1.getAccountInfo(dp);
    console.log(`Seat ${i} deposit_proof (${dp.toBase58().slice(0,12)}...): ${info ? 'EXISTS owner=' + info.owner.toBase58().slice(0,12) + '... size=' + info.data.length : 'NULL'}`);

    const [receipt] = PublicKey.findProgramAddressSync([Buffer.from('receipt'), TABLE.toBuffer(), Buffer.from([i])], PROGRAM_ID);
    const ri = await l1.getAccountInfo(receipt);
    if (ri) {
      const d = Buffer.from(ri.data);
      const depositor = new PublicKey(d.subarray(8, 40));
      const nonce = d.length >= 48 ? Number(d.readBigUInt64LE(40)) : 0;
      console.log(`Seat ${i} receipt: depositor=${depositor.equals(PublicKey.default) ? '(cleared)' : depositor.toBase58().slice(0,12)+'...'} nonce=${nonce}`);
    } else {
      console.log(`Seat ${i} receipt: NULL`);
    }
  }
}
main().catch(console.error);
