/**
 * Diagnostic: manually send handle_timeout on a stuck table to see the exact error.
 * Usage: npx ts-node scripts/test-timeout.ts <TABLE_PUBKEY>
 */
import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import * as fs from 'fs';
import * as crypto from 'crypto';

const TEE_RPC_BASE = 'https://tee.magicblock.app';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const TABLE = new PublicKey(process.argv[2] || 'FiEZUNSa26x41rEUefS25z7qXQw3bNnrJT1NQmLdp3ri');
const KP_PATH = 'j:/Poker/contracts/auth/deployers/crank-keypair.json';

const PHASE_NAMES: Record<number,string> = {0:'Waiting',1:'Starting',2:'Preflop',3:'Flop',4:'Turn',5:'River',6:'Showdown',7:'Complete',8:'FlopRevPend',9:'TurnRevPend',10:'RiverRevPend'};
const DISC_TIMEOUT = Buffer.from(crypto.createHash('sha256').update('global:handle_timeout').digest().slice(0, 8));

function getSeatPda(table: PublicKey, idx: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('seat'), table.toBuffer(), Buffer.from([idx])], PROGRAM_ID)[0];
}

async function getTeeConnection(kp: Keypair): Promise<Connection> {
  const nacl = await import('tweetnacl');
  const pub = kp.publicKey.toBase58();
  const cr = await (await fetch(`${TEE_RPC_BASE}/auth/challenge?pubkey=${pub}`)).json() as any;
  const sig = nacl.sign.detached(Buffer.from(cr.challenge, 'utf-8'), kp.secretKey);
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + Buffer.from(sig).toString('hex')); let r = '';
  while (n > 0n) { r = A[Number(n % 58n)] + r; n = n / 58n; }
  for (let i = 0; i < sig.length && sig[i] === 0; i++) r = '1' + r;
  const lr = await (await fetch(`${TEE_RPC_BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey: pub, challenge: cr.challenge, signature: r }),
  })).json() as any;
  return new Connection(`${TEE_RPC_BASE}?token=${lr.token}`, 'confirmed');
}

async function main() {
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KP_PATH, 'utf-8'))));
  console.log(`Crank key: ${kp.publicKey.toBase58()}`);
  const tee = await getTeeConnection(kp);
  console.log('TEE authenticated\n');

  // Read table state
  const ti = await tee.getAccountInfo(TABLE);
  if (!ti) { console.log('Table not on TEE'); return; }
  const d = Buffer.from(ti.data);
  const phase = d[160];
  const currentPlayer = d[161];
  const handNum = Number(d.readBigUInt64LE(123));
  const lastActionSlot = Number(d.readBigUInt64LE(166));
  console.log(`Table: ${TABLE.toBase58()}`);
  console.log(`  phase=${PHASE_NAMES[phase]} (${phase}), currentPlayer=${currentPlayer}, hand#=${handNum}`);
  console.log(`  last_action_slot=${lastActionSlot} (unix timestamp)`);
  console.log(`  now=${Math.floor(Date.now()/1000)}, elapsed=${Math.floor(Date.now()/1000) - lastActionSlot}s`);

  if (currentPlayer === 255) {
    console.log('\n  currentPlayer=255 — no one to timeout');
    return;
  }

  const seatPda = getSeatPda(TABLE, currentPlayer);
  console.log(`\n  Sending handle_timeout for seat ${currentPlayer} (${seatPda.toBase58().slice(0,12)}...)`);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: kp.publicKey, isSigner: true, isWritable: false },
      { pubkey: TABLE, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
    ],
    data: DISC_TIMEOUT,
  });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));
  tx.add(ix);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
  tx.sign(kp);

  try {
    // First simulate
    console.log('  Simulating...');
    const sim = await tee.simulateTransaction(tx);
    if (sim.value.err) {
      console.log(`  ❌ Simulation error: ${JSON.stringify(sim.value.err)}`);
      if (sim.value.logs) {
        console.log('  Logs:');
        for (const log of sim.value.logs) {
          console.log(`    ${log}`);
        }
      }
    } else {
      console.log('  ✅ Simulation OK — sending TX...');
      const sig = await tee.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      console.log(`  TX sent: ${sig}`);
      // Wait for confirmation
      const result = await tee.confirmTransaction(sig, 'confirmed');
      if (result.value.err) {
        console.log(`  ❌ TX error: ${JSON.stringify(result.value.err)}`);
      } else {
        console.log('  ✅ handle_timeout succeeded!');
      }
    }
  } catch (e: any) {
    console.log(`  ❌ Error: ${e.message?.slice(0, 200)}`);
  }
}
main().catch(console.error);
