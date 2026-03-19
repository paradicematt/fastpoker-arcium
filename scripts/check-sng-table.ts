import { Connection, PublicKey } from '@solana/web3.js';

const PROG = new PublicKey('4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB');
const DELEG = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const TABLE = new PublicKey('GdsSc2dsPNoPzRXBvVS8NWjwfaxf8xCKPTH3pzGXWY2v');

(async () => {
  const c = new Connection('https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df', 'confirmed');
  const i = await c.getAccountInfo(TABLE);
  if (!i) { console.log('TABLE: NULL'); return; }
  const d = Buffer.from(i.data);
  console.log('owner:', i.owner.toBase58().slice(0, 12));
  console.log('size:', d.length);
  console.log('gameType:', d[104]);
  console.log('maxPlayers:', d[121]);
  console.log('curPlayers:', d[122]);
  console.log('hand#:', Number(d.readBigUInt64LE(123)));
  console.log('phase:', d[160]);
  console.log('tier:', d.length > 385 ? d[385] : '-');
  console.log('tableId:', d.slice(8, 40).toString('hex').slice(0, 32) + '...');

  const [ds] = PublicKey.findProgramAddressSync([Buffer.from('deck_state'), TABLE.toBuffer()], PROG);
  const di = await c.getAccountInfo(ds);
  console.log('deckState:', di ? `owner=${di.owner.toBase58().slice(0, 12)} size=${di.data.length}` : 'NULL');

  const maxP = d[121];
  for (let s = 0; s < maxP; s++) {
    const [sp] = PublicKey.findProgramAddressSync([Buffer.from('seat'), TABLE.toBuffer(), Buffer.from([s])], PROG);
    const si = await c.getAccountInfo(sp);
    const [sc] = PublicKey.findProgramAddressSync([Buffer.from('seat_cards'), TABLE.toBuffer(), Buffer.from([s])], PROG);
    const sci = await c.getAccountInfo(sc);
    console.log(`seat[${s}]: ${si ? 'owner=' + si.owner.toBase58().slice(0, 12) : 'NULL'}  seatCards[${s}]: ${sci ? 'owner=' + sci.owner.toBase58().slice(0, 12) : 'NULL'}`);
  }
})();
