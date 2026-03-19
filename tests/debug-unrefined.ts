import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as crypto from 'crypto';

const PROG = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

async function main() {
  const c = new Connection('http://127.0.0.1:8899', 'confirmed');
  const p = Keypair.generate();
  await c.confirmTransaction(await c.requestAirdrop(p.publicKey, 2 * LAMPORTS_PER_SOL), 'confirmed');

  const [plPda] = PublicKey.findProgramAddressSync([Buffer.from('player'), p.publicKey.toBuffer()], PROG);
  const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from('pool')], STEEL);
  const [unrPda] = PublicKey.findProgramAddressSync([Buffer.from('unrefined'), p.publicKey.toBuffer()], STEEL);

  console.log('Unrefined PDA:', unrPda.toBase58());
  console.log('Before registration:', await c.getAccountInfo(unrPda));

  const disc = Buffer.from(crypto.createHash('sha256').update('global:register_player').digest().subarray(0, 8));
  const ix = new TransactionInstruction({
    programId: PROG, data: disc,
    keys: [
      { pubkey: p.publicKey, isSigner: true, isWritable: true },
      { pubkey: plPda, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: unrPda, isSigner: false, isWritable: true },
      { pubkey: STEEL, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  tx.feePayer = p.publicKey;
  const sig = await sendAndConfirmTransaction(c, tx, [p], { commitment: 'confirmed' });
  console.log('Registered:', sig.slice(0, 20));

  const unrInfo = await c.getAccountInfo(unrPda);
  console.log('After registration:');
  console.log('  Owner:', unrInfo?.owner?.toBase58());
  console.log('  Lamports:', unrInfo?.lamports);
  console.log('  Data length:', unrInfo?.data?.length);
  console.log('  Expected owner:', STEEL.toBase58());
  console.log('  Owner matches STEEL:', unrInfo?.owner?.equals(STEEL));
}

main().catch(e => console.error('Error:', e.message?.slice(0, 200)));
