import { Connection, PublicKey } from '@solana/web3.js';
import { getCompDefAccAddress, getCompDefAccOffset } from '@arcium-hq/client';

const PROG = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');

async function main() {
  const c = new Connection('http://localhost:8899', 'confirmed');
  
  const circuits = ['shuffle_and_deal', 'reveal_community', 'reveal_showdown'];
  
  for (const name of circuits) {
    const offsetBuf = getCompDefAccOffset(name);
    const offset = Buffer.from(offsetBuf).readUInt32LE(0);
    const pda = getCompDefAccAddress(PROG, offset);
    const info = await c.getAccountInfo(pda);
    
    console.log(`\n=== ${name} (offset=${offset}) ===`);
    console.log(`  PDA: ${pda.toBase58()}`);
    if (!info) { console.log('  NOT FOUND'); continue; }
    console.log(`  Data len: ${info.data.length}`);
    console.log(`  Hex: ${Buffer.from(info.data).toString('hex')}`);
  }
}
main().catch(console.error);
