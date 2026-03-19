import { Connection, PublicKey } from '@solana/web3.js';

const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');

async function main() {
  const c = new Connection('http://localhost:8899', 'confirmed');
  const sigs = await c.getSignaturesForAddress(PROGRAM_ID, { limit: 20 });
  
  const failed = sigs.filter(s => s.err);
  console.log(`Found ${failed.length} failed TXs out of ${sigs.length} total`);
  
  if (failed.length === 0) return;
  
  // Get logs for first failed TX
  const sig = failed[0].signature;
  console.log(`\nFailed TX: ${sig.slice(0, 40)}...`);
  console.log(`Error: ${JSON.stringify(failed[0].err)}`);
  
  const tx = await c.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (tx?.meta?.logMessages) {
    console.log('\nProgram Logs:');
    for (const log of tx.meta.logMessages) {
      console.log('  ', log);
    }
  }
  
  // Also check if table is still in AwaitingDeal
  const table = new PublicKey('C3kU2bYPGbzeKrUUd6KKJ6DjzJANbZDMTCiU6q4nDdsh');
  const info = await c.getAccountInfo(table);
  if (info) {
    console.log(`\nTable phase byte @160: ${info.data[160]}`);
  }
}

main().catch(console.error);
