/**
 * Refund players from the stuck GTG93f cash game table.
 * Reads chip balances from ER, sends equivalent SOL from deployer to each player on L1.
 * 
 * Run: npx ts-node tests/refund-players.ts
 */
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as fs from 'fs';

const ER_RPC = 'https://devnet.magicblock.app';
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const KEYPAIR_PATH = 'j:/critters/mini-game/deployer-keypair.json';
const TABLE_PDA = new PublicKey('GTG93fecfhxunTRvFwapp48F4LJihz3PHKrPwfCvi2kw');
const MAX_PLAYERS = 6;

async function main() {
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf-8'))));
  const er = new Connection(ER_RPC, 'confirmed');
  const l1 = new Connection(L1_RPC, 'confirmed');

  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
  const bal = await l1.getBalance(deployer.publicKey);
  console.log(`L1 Balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  // Settled chip balances from ER (after schedule_settle):
  // Seat 0: 8bigAdyc... — busted, 0 chips
  // Seat 3: 2KskcmUN... — won, 1.0 SOL (1000000000 lamports)
  const refunds = [
    { wallet: new PublicKey('2KskcmUNXDoL2nD1T7DcgVYmxUYUtTyP4RTmPcJRc9xP'), chips: 1000000000, seat: 3 },
  ];

  for (const r of refunds) {
    console.log(`  Seat ${r.seat}: ${r.wallet.toBase58()} — ${(r.chips / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  }

  const totalRefund = refunds.reduce((sum, r) => sum + r.chips, 0);
  console.log(`\nTotal to refund: ${(totalRefund / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  if (totalRefund > bal) {
    console.log('ERROR: Deployer doesn\'t have enough SOL!');
    return;
  }

  // Send refunds on L1
  const tx = new Transaction();
  for (const r of refunds) {
    tx.add(SystemProgram.transfer({
      fromPubkey: deployer.publicKey,
      toPubkey: r.wallet,
      lamports: r.chips,
    }));
    console.log(`  Transfer ${(r.chips / LAMPORTS_PER_SOL).toFixed(4)} SOL → ${r.wallet.toBase58().slice(0, 12)}...`);
  }

  const sig = await sendAndConfirmTransaction(l1, tx, [deployer], { commitment: 'confirmed' });
  console.log(`\n✅ Refunds sent: ${sig}`);

  const newBal = await l1.getBalance(deployer.publicKey);
  console.log(`Deployer balance: ${(newBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log('Done!');
}

main().catch(console.error);
