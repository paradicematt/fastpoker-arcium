import { Connection, PublicKey } from '@solana/web3.js';
import { getCompDefAccAddress, getCompDefAccOffset } from '@arcium-hq/client';
import * as fs from 'fs';
import * as crypto from 'crypto';

const PROG = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const ARCIUM = new PublicKey('Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ');

async function main() {
  const c = new Connection('http://localhost:8899', 'confirmed');
  
  // Get raw circuit accounts for shuffle_and_deal
  const offsetBuf = getCompDefAccOffset('shuffle_and_deal');
  const offset = Buffer.from(offsetBuf).readUInt32LE(0);
  const compDef = getCompDefAccAddress(PROG, offset);
  console.log(`CompDef: ${compDef.toBase58()}`);
  
  // Find raw circuit accounts (owned by Arcium, large accounts)
  const allAccs = await c.getProgramAccounts(ARCIUM);
  const largeAccs = allAccs
    .filter((a: any) => a.account.data.length > 50000)
    .sort((a: any, b: any) => b.account.data.length - a.account.data.length);
  
  console.log(`\nLarge Arcium accounts (raw circuit data):`);
  let onchainData = Buffer.alloc(0);
  
  for (const acc of largeAccs) {
    const len = acc.account.data.length;
    // Skip 9-byte prefix (8 discriminator + 1 bump)
    const circuitData = acc.account.data.subarray(9);
    console.log(`  ${acc.pubkey.toBase58().padEnd(48)} total=${len} circuit=${circuitData.length}`);
    
    // Read first 16 bytes of circuit data
    console.log(`    First 16 bytes: ${Buffer.from(circuitData.subarray(0, 16)).toString('hex')}`);
  }
  
  // Read local .arcis file
  const localFile = fs.readFileSync('../build/shuffle_and_deal.arcis');
  console.log(`\nLocal .arcis file: ${localFile.length} bytes`);
  console.log(`  First 16 bytes: ${localFile.subarray(0, 16).toString('hex')}`);
  console.log(`  SHA256: ${crypto.createHash('sha256').update(localFile).digest('hex')}`);
  
  // Reconstruct on-chain circuit data
  // raw_circuit_0 has first chunk, raw_circuit_1 has second chunk
  const MAX_ACCOUNT_SIZE = 10_485_760;
  const CIRCUIT_CHUNK = MAX_ACCOUNT_SIZE - 9;
  
  // Find accounts by size (largest first = raw_circuit_0)
  if (largeAccs.length >= 2) {
    const chunk0 = largeAccs[0].account.data.subarray(9);
    const chunk1 = largeAccs[1].account.data.subarray(9);
    const reconstructed = Buffer.concat([chunk0, chunk1]);
    console.log(`\nReconstructed: ${reconstructed.length} bytes`);
    console.log(`  First 16 bytes: ${Buffer.from(reconstructed.subarray(0, 16)).toString('hex')}`);
    console.log(`  SHA256: ${crypto.createHash('sha256').update(reconstructed).digest('hex')}`);
    
    // Compare
    const match = localFile.equals(reconstructed.subarray(0, localFile.length));
    console.log(`\n  LOCAL vs ON-CHAIN match: ${match}`);
    if (!match) {
      // Find first difference
      for (let i = 0; i < Math.min(localFile.length, reconstructed.length); i++) {
        if (localFile[i] !== reconstructed[i]) {
          console.log(`  First difference at byte ${i}: local=0x${localFile[i].toString(16)} onchain=0x${reconstructed[i].toString(16)}`);
          break;
        }
      }
    }
  }
}
main().catch(console.error);
