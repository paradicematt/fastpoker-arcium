import { Connection, PublicKey } from '@solana/web3.js';
const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const conn = new Connection('http://127.0.0.1:8899');
(async () => {
  // Find table accounts (size=437)
  const tables = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 437 }] });
  console.log(`Found ${tables.length} tables`);
  for (const t of tables) {
    const [ds] = PublicKey.findProgramAddressSync(
      [Buffer.from('deck_state'), t.pubkey.toBuffer()], PROGRAM_ID
    );
    const info = await conn.getAccountInfo(ds);
    console.log(`Table: ${t.pubkey.toBase58()}`);
    console.log(`  DeckState PDA: ${ds.toBase58()}`);
    console.log(`  DeckState data length: ${info ? info.data.length : 'NOT FOUND'}`);
    console.log(`  Expected SIZE: 877`);
    if (info) {
      // Check phase from table
      const phase = t.account.data[160];
      console.log(`  Table phase: ${phase}`);
      // Check shuffle_complete from deck_state
      const shuffleComplete = info.data[8 + 32 + 1]; // after disc + table + bump
      console.log(`  DeckState shuffle_complete: ${shuffleComplete}`);
    }
  }
})();
