import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import * as crypto from 'crypto';
import * as fs from 'fs';

const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const REGISTER_DISC = crypto.createHash('sha256').update('global:register_crank_operator').digest().slice(0, 8);

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('j:/Poker/contracts/auth/deployers/crank-keypair.json', 'utf-8'))));
const [pda] = PublicKey.findProgramAddressSync([Buffer.from('crank'), kp.publicKey.toBuffer()], PROGRAM_ID);

console.log('Crank pubkey:', kp.publicKey.toBase58());
console.log('CrankOperator PDA:', pda.toBase58());

(async () => {
  const conn = new Connection(L1_RPC, 'confirmed');
  const existing = await conn.getAccountInfo(pda);
  if (existing) {
    console.log('Already registered!');
    const d = Buffer.from(existing.data);
    console.log('  authority:', new PublicKey(d.subarray(8, 40)).toBase58());
    console.log('  mode:', d[40]);
    console.log('  lifetime_actions:', Number(d.readBigUInt64LE(49)));
    console.log('  lifetime_sol_earned:', Number(d.readBigUInt64LE(57)));
    return;
  }

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: REGISTER_DISC,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  console.log('Registered! sig:', sig);

  const info = await conn.getAccountInfo(pda);
  console.log('PDA size:', info?.data.length, 'bytes');
})();
