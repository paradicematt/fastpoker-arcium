const { Connection, PublicKey } = require('@solana/web3.js');
const TABLE_KEY = process.argv[2];
if (!TABLE_KEY) { console.log('Usage: node check-seatcards-offsets.js <table_pubkey>'); process.exit(1); }

(async () => {
  const c = new Connection('http://127.0.0.1:8899');
  const t = new PublicKey(TABLE_KEY);
  const PID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
  
  for (let i = 0; i < 2; i++) {
    const [sc] = PublicKey.findProgramAddressSync(
      [Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])], PID
    );
    const info = await c.getAccountInfo(sc);
    if (!info) { console.log(`SeatCards[${i}]: not found`); continue; }
    const d = info.data;
    console.log(`\nSeatCards[${i}] (${d.length} bytes):`);
    console.log(`  offset 42 (old enc1): ${d.slice(42, 74).toString('hex').slice(0, 40)}...`);
    console.log(`  offset 74 (old enc2): ${d.slice(74, 106).toString('hex').slice(0, 40)}...`);
    console.log(`  offset 76 (new enc1): ${d.slice(76, 108).toString('hex').slice(0, 40)}...`);
    console.log(`  offset 108(new enc2): ${d.slice(108, 140).toString('hex').slice(0, 40)}...`);
    console.log(`  card1 (offset 73):    ${d[73]}`);
    console.log(`  card2 (offset 74):    ${d[74]}`);
    // Check if ANY 32-byte range has non-zero data (find where ciphertext actually landed)
    for (let off = 40; off <= 140; off++) {
      if (d[off] !== 0 && off >= 42 && off < 74) {
        console.log(`  ** Non-zero at offset ${off}: 0x${d[off].toString(16)}`);
        break;
      }
    }
  }
  
  // Also check table phase
  const tInfo = await c.getAccountInfo(t);
  if (tInfo) {
    console.log(`\nTable phase: ${tInfo.data[160]}`);
  }
})();
