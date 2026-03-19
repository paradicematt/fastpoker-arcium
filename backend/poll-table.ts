import { Connection, PublicKey } from '@solana/web3.js';

const TABLE = process.argv[2];
if (!TABLE) { console.error('Usage: poll-table.ts <table-pubkey>'); process.exit(1); }

const c = new Connection('http://localhost:8899', 'confirmed');

async function poll() {
  const start = Date.now();
  const tablePk = new PublicKey(TABLE);
  
  for (let i = 0; i < 120; i++) {
    const info = await c.getAccountInfo(tablePk);
    if (!info) { console.log('Table not found'); return; }
    
    // Phase is at offset 8 (discriminator) + depends on struct layout
    // Let's just read a few key bytes
    const data = info.data;
    const phase = data[8]; // First byte after discriminator
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    
    const phaseNames: Record<number, string> = {
      0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop',
      4: 'Flop', 5: 'Turn', 6: 'River', 7: 'Showdown', 8: 'Settled'
    };
    const phaseName = phaseNames[phase] || `Unknown(${phase})`;
    
    if (phase !== 2) { // Not AwaitingDeal anymore
      console.log(`[${elapsed}s] Phase changed to: ${phaseName} (${phase})`);
      if (phase === 3) {
        console.log('✅ MPC CALLBACK SUCCESS — Phase is Preflop!');
      } else {
        console.log(`⚠️ Unexpected phase: ${phaseName}`);
      }
      return;
    }
    
    if (i % 5 === 0) {
      console.log(`[${elapsed}s] Still AwaitingDeal...`);
    }
    
    await new Promise(r => setTimeout(r, 2000));
  }
  
  console.log('❌ TIMEOUT — Still AwaitingDeal after 240s');
}

poll().catch(console.error);
