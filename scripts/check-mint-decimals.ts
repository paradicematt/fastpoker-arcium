import { Connection, PublicKey } from '@solana/web3.js';

const conn = new Connection('https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');

async function main() {
  const info = await conn.getAccountInfo(POKER_MINT);
  if (!info) { console.log('Mint not found'); return; }
  const d = Buffer.from(info.data);
  console.log('Mint decimals:', d[44]);
  console.log('Supply (raw):', d.readBigUInt64LE(36).toString());
  const decimals = d[44];
  console.log('Supply (human):', Number(d.readBigUInt64LE(36)) / Math.pow(10, decimals));
}
main();
