const anchor = require('@coral-xyz/anchor');
const { getMXEPublicKey } = require('@arcium-hq/client');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const fs = require('fs');

(async () => {
  const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('.localnet-keypair.json', 'utf8'))));
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  anchor.setProvider(provider);
  const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
  const pk = await getMXEPublicKey(provider, PROGRAM_ID);
  if (pk) {
    console.log(Buffer.from(pk).toString('hex'));
  } else {
    console.log('NULL');
  }
})().catch(e => console.error(e.message));
