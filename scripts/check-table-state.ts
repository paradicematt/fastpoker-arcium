import { Connection, PublicKey } from '@solana/web3.js';
const l1 = new Connection('https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df', 'confirmed');
const PROG = new PublicKey('4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB');
const DEL = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const PHASE: Record<number,string> = {0:'Waiting',1:'Starting',2:'Preflop',3:'Flop',4:'Turn',5:'River',6:'Showdown',7:'Complete'};
async function main() {
  const t = new PublicKey(process.argv[2] || '35uu4CWdRSBXWpXLG1sBy22y2E32i8ayFqv8QPuMM33e');
  const info = await l1.getAccountInfo(t);
  if (!info) { console.log('Table NOT on L1'); return; }
  const d = Buffer.from(info.data);
  console.log('Owner:', info.owner.toBase58().slice(0, 12) + '...');
  console.log('Phase:', PHASE[d[160]] || d[160]);
  console.log('Players:', d[122] + '/' + d[121]);
  console.log('Prizes distributed:', d[339]);
  console.log('Is PROG-owned:', info.owner.equals(PROG));
  console.log('Is DEL-owned:', info.owner.equals(DEL));
}
main().catch(console.error);
