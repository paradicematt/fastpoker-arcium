const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const crypto = require('crypto');
const fs = require('fs');

const PROGRAM_ID = new PublicKey('4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB');
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';

const TABLE = new PublicKey(process.argv[2] || '3wZJ1aKkFHvkcTb4PgpFmkKEWPGDTWDNSZBNKr1YageT');

const DISC = crypto.createHash('sha256').update('global:admin_close_table').digest().slice(0, 8);

const keyPath = 'j:/Poker/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json';
const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
const authority = Keypair.fromSecretKey(new Uint8Array(keyData));

async function main() {
  const conn = new Connection(L1_RPC, 'confirmed');
  console.log(`Authority: ${authority.publicKey.toBase58()}`);
  console.log(`Table:     ${TABLE.toBase58()}`);

  // Verify table exists
  const info = await conn.getAccountInfo(TABLE);
  if (!info) { console.log('Table not found on L1'); return; }
  console.log(`Owner: ${info.owner.toBase58()}, size: ${info.data.length}, lamports: ${info.lamports}`);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: TABLE, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISC),
  });

  const tx = new Transaction().add(ix);
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: 'confirmed' });
    console.log(`✅ Table admin-closed! sig: ${sig}`);
  } catch (e) {
    console.error('❌ Failed:', e.message?.slice(0, 200));
  }
}

main();
