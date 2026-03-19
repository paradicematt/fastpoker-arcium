const { Connection, PublicKey } = require('@solana/web3.js');
const crypto = require('crypto');
const bs58 = require('bs58').default || require('bs58');

const PROG = new PublicKey('4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB');
const disc = crypto.createHash('sha256').update('account:Table').digest().slice(0, 8);
const phases = ['Waiting','Starting','Preflop','Flop','Turn','River','Showdown','Complete'];

(async () => {
  const er = new Connection('https://devnet.magicblock.app', 'confirmed');
  const l1 = new Connection('https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df', 'confirmed');

  // Check ER
  console.log('=== ER Tables ===');
  const erAccts = await er.getProgramAccounts(PROG, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
  });
  console.log(`Found ${erAccts.length} table(s) on ER`);
  for (const {pubkey, account} of erAccts) {
    const d = Buffer.from(account.data);
    console.log(`  ${pubkey.toBase58()} phase=${phases[d[160]]||d[160]} players=${d[122]}/${d[121]} delegated=${d[174]} hand=${Number(d.readBigUInt64LE(123))}`);
  }

  // Check L1
  console.log('\n=== L1 Tables ===');
  const l1Accts = await l1.getProgramAccounts(PROG, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
  });
  console.log(`Found ${l1Accts.length} table(s) on L1`);
  for (const {pubkey, account} of l1Accts) {
    const d = Buffer.from(account.data);
    console.log(`  ${pubkey.toBase58()} phase=${phases[d[160]]||d[160]} players=${d[122]}/${d[121]} delegated=${d[174]} prizes_dist=${d[339]} hand=${Number(d.readBigUInt64LE(123))}`);
  }

  // Cross-check: ER tables on L1
  console.log('\n=== Cross-check ER→L1 ===');
  for (const {pubkey} of erAccts) {
    const l1Info = await l1.getAccountInfo(pubkey);
    if (l1Info) {
      console.log(`  ${pubkey.toBase58().slice(0,16)}... L1 owner=${l1Info.owner.toBase58().slice(0,16)} len=${l1Info.data.length}`);
      if (l1Info.data.length > 160) {
        const d = Buffer.from(l1Info.data);
        console.log(`    L1 phase=${phases[d[160]]||d[160]} delegated=${d[174]}`);
      }
    } else {
      console.log(`  ${pubkey.toBase58().slice(0,16)}... NOT on L1`);
    }
  }
})();
