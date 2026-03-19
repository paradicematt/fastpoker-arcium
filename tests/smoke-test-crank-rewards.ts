/**
 * Crank Rewards Distribution Test
 *
 * Tests the crank operator reward flow:
 *   1. Play a cash game hand to showdown (generates rake)
 *   2. Verify crank_pool_accumulated > 0 (45% of rake for system tables)
 *   3. Register a crank operator
 *   4. Call distribute_crank_rewards
 *   5. Verify operator received SOL from vault
 *
 * Cash game rake: 5% of pot after flop. System table crank cut: 45%.
 * Pot=4000, rake=200, crank_cut=200*4500/10000=90 lamports.
 *
 * Run: npx ts-node smoke-test-crank-rewards.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL, SYSVAR_SLOT_HASHES_PUBKEY,
} from '@solana/web3.js';
import * as crypto from 'crypto';

const PROGRAM = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const RPC = 'http://127.0.0.1:8899';
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

const S = {
  table: Buffer.from('table'), seat: Buffer.from('seat'), seat_cards: Buffer.from('seat_cards'),
  deck_state: Buffer.from('deck_state'), vault: Buffer.from('vault'), receipt: Buffer.from('receipt'),
  deposit_proof: Buffer.from('deposit_proof'), player: Buffer.from('player'),
  player_table: Buffer.from('player_table'), crank_tally_er: Buffer.from('crank_tally_er'),
  crank_tally_l1: Buffer.from('crank_tally_l1'), unrefined: Buffer.from('unrefined'),
  crank_operator: Buffer.from('crank'),
};

function disc(n: string): Buffer { return Buffer.from(crypto.createHash('sha256').update(`global:${n}`).digest().subarray(0, 8)); }
const IX = {
  register: disc('register_player'), create: disc('create_table'), init_seat: disc('init_table_seat'),
  join: disc('join_table'), start: disc('start_game'), deal: disc('devnet_bypass_deal'),
  reveal: disc('devnet_bypass_reveal'), action: disc('player_action'), settle: disc('settle_hand'),
  register_crank: disc('register_crank_operator'), distribute_crank: disc('distribute_crank_rewards'),
};

const pda = (seeds: Buffer[], prog = PROGRAM) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const seatPda = (t: PublicKey, i: number) => pda([S.seat, t.toBuffer(), Buffer.from([i])]);
const scPda = (t: PublicKey, i: number) => pda([S.seat_cards, t.toBuffer(), Buffer.from([i])]);
const dsPda = (t: PublicKey) => pda([S.deck_state, t.toBuffer()]);
const vPda = (t: PublicKey) => pda([S.vault, t.toBuffer()]);
const rPda = (t: PublicKey, i: number) => pda([S.receipt, t.toBuffer(), Buffer.from([i])]);
const dpPda = (t: PublicKey, i: number) => pda([S.deposit_proof, t.toBuffer(), Buffer.from([i])]);
const plPda = (w: PublicKey) => pda([S.player, w.toBuffer()]);
const mkPda = (w: PublicKey, t: PublicKey) => pda([S.player_table, w.toBuffer(), t.toBuffer()]);
const ctePda = (t: PublicKey) => pda([S.crank_tally_er, t.toBuffer()]);
const ctlPda = (t: PublicKey) => pda([S.crank_tally_l1, t.toBuffer()]);
const poolPda = () => pda([Buffer.from('pool')], STEEL);
const unrPda = (w: PublicKey) => pda([S.unrefined, w.toBuffer()], STEEL);
const crankOpPda = (w: PublicKey) => pda([S.crank_operator, w.toBuffer()]);

function step(n: string) { console.log(`\n${'='.repeat(70)}\n  ${n}\n${'='.repeat(70)}`); }

async function send(c: Connection, ix: TransactionInstruction, signers: Keypair[], label: string): Promise<boolean> {
  try {
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    tx.feePayer = signers[0].publicKey;
    const sig = await sendAndConfirmTransaction(c, tx, signers, { commitment: 'confirmed' });
    console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
    return true;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0, 150)}`);
    if (e.logs) e.logs.filter((l: string) => l.includes('Error') || l.includes('Program log')).slice(-6).forEach((l: string) => console.log(`     ${l}`));
    return false;
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('  Crank Rewards Distribution Test');
  console.log('='.repeat(70));

  const c = new Connection(RPC, 'confirmed');
  if (!(await c.getAccountInfo(PROGRAM))?.executable) { console.log('Program not deployed'); return; }

  const pA = Keypair.generate();
  const pB = Keypair.generate();
  const crankWallet = Keypair.generate(); // The crank operator

  // ── Setup: Airdrop + Register ──
  step('Setup');
  for (const p of [pA, pB, crankWallet]) {
    await c.confirmTransaction(await c.requestAirdrop(p.publicKey, 5 * LAMPORTS_PER_SOL), 'confirmed');
  }
  for (const [l, p] of [['A', pA], ['B', pB]] as [string, Keypair][]) {
    await send(c, new TransactionInstruction({
      programId: PROGRAM, data: IX.register,
      keys: [
        { pubkey: p.publicKey, isSigner: true, isWritable: true },
        { pubkey: plPda(p.publicKey), isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: poolPda(), isSigner: false, isWritable: true },
        { pubkey: unrPda(p.publicKey), isSigner: false, isWritable: true },
        { pubkey: STEEL, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }), [p], `Register ${l}`);
  }

  // Create table, init seats, join
  const tId = crypto.randomBytes(32);
  const t = pda([S.table, tId]);
  const cfgBuf = Buffer.alloc(36);
  tId.copy(cfgBuf, 0, 0, 32);
  cfgBuf.writeUInt8(3, 32); cfgBuf.writeUInt8(0, 33); cfgBuf.writeUInt8(2, 34); cfgBuf.writeUInt8(0, 35);

  await send(c, new TransactionInstruction({
    programId: PROGRAM, data: Buffer.concat([IX.create, cfgBuf]),
    keys: [
      { pubkey: pA.publicKey, isSigner: true, isWritable: true },
      { pubkey: t, isSigner: false, isWritable: true },
      { pubkey: poolPda(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  }), [pA], 'Create Table');

  for (let i = 0; i < 2; i++) {
    await send(c, new TransactionInstruction({
      programId: PROGRAM, data: Buffer.concat([IX.init_seat, Buffer.from([i])]),
      keys: [
        { pubkey: pA.publicKey, isSigner: true, isWritable: true },
        { pubkey: t, isSigner: false, isWritable: false },
        { pubkey: seatPda(t, i), isSigner: false, isWritable: true },
        { pubkey: scPda(t, i), isSigner: false, isWritable: true },
        { pubkey: dsPda(t), isSigner: false, isWritable: true },
        { pubkey: rPda(t, i), isSigner: false, isWritable: true },
        { pubkey: dpPda(t, i), isSigner: false, isWritable: true },
        { pubkey: vPda(t), isSigner: false, isWritable: true },
        { pubkey: ctePda(t), isSigner: false, isWritable: true },
        { pubkey: ctlPda(t), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }), [pA], `Init Seat ${i}`);
  }

  for (const [l, p, i] of [['A', pA, 0], ['B', pB, 1]] as [string, Keypair, number][]) {
    const d = Buffer.alloc(25); IX.join.copy(d, 0);
    d.writeBigUInt64LE(100_000n, 8); d.writeUInt8(i, 16); d.writeBigUInt64LE(0n, 17);
    await send(c, new TransactionInstruction({
      programId: PROGRAM, data: d,
      keys: [
        { pubkey: p.publicKey, isSigner: true, isWritable: true },
        { pubkey: plPda(p.publicKey), isSigner: false, isWritable: true },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: seatPda(t, i), isSigner: false, isWritable: true },
        { pubkey: mkPda(p.publicKey, t), isSigner: false, isWritable: true },
        { pubkey: vPda(t), isSigner: false, isWritable: true },
        { pubkey: rPda(t, i), isSigner: false, isWritable: true },
        ...[0,1,2,3,4,5].map(_ => ({ pubkey: PROGRAM, isSigner: false, isWritable: false })),
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }), [p], `Join ${l}`);
  }

  // ── Play a showdown hand to generate rake ──
  step('Play Showdown Hand (generates rake)');
  // Start
  await send(c, new TransactionInstruction({
    programId: PROGRAM, data: IX.start,
    keys: [
      { pubkey: pA.publicKey, isSigner: false, isWritable: false },
      { pubkey: t, isSigner: false, isWritable: true },
      { pubkey: dsPda(t), isSigner: false, isWritable: true },
      { pubkey: seatPda(t, 0), isSigner: false, isWritable: true },
      { pubkey: seatPda(t, 1), isSigner: false, isWritable: true },
    ],
  }), [pA], 'Start');

  // Deal
  await send(c, new TransactionInstruction({
    programId: PROGRAM, data: IX.deal,
    keys: [
      { pubkey: pA.publicKey, isSigner: true, isWritable: false },
      { pubkey: t, isSigner: false, isWritable: true },
      { pubkey: dsPda(t), isSigner: false, isWritable: true },
      { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: seatPda(t, 0), isSigner: false, isWritable: true },
      { pubkey: seatPda(t, 1), isSigner: false, isWritable: true },
      { pubkey: scPda(t, 0), isSigner: false, isWritable: true },
      { pubkey: scPda(t, 1), isSigner: false, isWritable: true },
    ],
  }), [pA], 'Deal');

  // Preflop: SB calls, BB checks
  const actFn = async (seat: number, actionByte: number, label: string) => {
    const p = seat === 0 ? pA : pB;
    return send(c, new TransactionInstruction({
      programId: PROGRAM, data: Buffer.concat([IX.action, Buffer.from([actionByte])]),
      keys: [
        { pubkey: p.publicKey, isSigner: true, isWritable: false },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: seatPda(t, seat), isSigner: false, isWritable: true },
        { pubkey: PROGRAM, isSigner: false, isWritable: false },
      ],
    }), [p], label);
  };

  const revealFn = async (label: string) => send(c, new TransactionInstruction({
    programId: PROGRAM, data: IX.reveal,
    keys: [
      { pubkey: pA.publicKey, isSigner: true, isWritable: false },
      { pubkey: t, isSigner: false, isWritable: true },
    ],
  }), [pA], label);

  const getCP = async () => (await c.getAccountInfo(t))!.data[161];
  const getPhase = async () => (await c.getAccountInfo(t))!.data[160];

  // Play through all streets (check-check)
  let cp = await getCP();
  await actFn(cp, 2, `Call (seat ${cp})`);
  cp = await getCP();
  await actFn(cp, 1, `Check (seat ${cp})`);

  for (const street of ['Flop', 'Turn', 'River']) {
    let phase = await getPhase();
    if (phase >= 10 && phase <= 12) {
      await revealFn(`Reveal ${street}`);
      phase = await getPhase();
      if (phase >= 4 && phase <= 6) {
        cp = await getCP(); await actFn(cp, 1, `Check`);
        cp = await getCP(); await actFn(cp, 1, `Check`);
      }
    }
  }

  // Settle
  if (await getPhase() === 7) {
    await send(c, new TransactionInstruction({
      programId: PROGRAM, data: IX.settle,
      keys: [
        { pubkey: pA.publicKey, isSigner: false, isWritable: false },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: dsPda(t), isSigner: false, isWritable: true },
        { pubkey: seatPda(t, 0), isSigner: false, isWritable: true },
        { pubkey: seatPda(t, 1), isSigner: false, isWritable: true },
        { pubkey: scPda(t, 0), isSigner: false, isWritable: true },
        { pubkey: scPda(t, 1), isSigner: false, isWritable: true },
      ],
    }), [pA], 'Settle');
  }

  // ── Verify rake and crank pool ──
  step('Verify Rake + Crank Pool');
  const tInfo = await c.getAccountInfo(t);
  const rake = tInfo ? Number(tInfo.data.readBigUInt64LE(147)) : 0;
  const crankPool = tInfo && tInfo.data.length > 435 ? Number(tInfo.data.readBigUInt64LE(427)) : 0;
  console.log(`  Rake accumulated: ${rake}`);
  console.log(`  Crank pool accumulated: ${crankPool}`);
  console.log(`  Expected crank pool: ${Math.floor(rake * 4500 / 10000)} (45% of rake for system table)`);

  // ── Register Crank Operator ──
  step('Register Crank Operator');
  await send(c, new TransactionInstruction({
    programId: PROGRAM, data: IX.register_crank,
    keys: [
      { pubkey: crankWallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: crankOpPda(crankWallet.publicKey), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  }), [crankWallet], 'Register Crank Operator');

  // ── Distribute Crank Rewards ──
  step('Distribute Crank Rewards');
  const crankBalBefore = await c.getBalance(crankWallet.publicKey);

  const distOk = await send(c, new TransactionInstruction({
    programId: PROGRAM, data: IX.distribute_crank,
    keys: [
      { pubkey: crankWallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: t, isSigner: false, isWritable: false },
      { pubkey: vPda(t), isSigner: false, isWritable: true },
      { pubkey: ctePda(t), isSigner: false, isWritable: false },
      { pubkey: ctlPda(t), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // remaining: [operator_wallet, crank_operator_pda]
      { pubkey: crankWallet.publicKey, isSigner: false, isWritable: true },
      { pubkey: crankOpPda(crankWallet.publicKey), isSigner: false, isWritable: true },
    ],
  }), [crankWallet], 'Distribute Crank Rewards');

  const crankBalAfter = await c.getBalance(crankWallet.publicKey);
  const crankEarned = crankBalAfter - crankBalBefore;

  // ── Final Verification ──
  step('FINAL: Crank Rewards Verification');
  console.log(`  Crank operator balance before: ${crankBalBefore}`);
  console.log(`  Crank operator balance after: ${crankBalAfter}`);
  console.log(`  Crank earned (including tx fee): ${crankEarned}`);
  console.log(`  Expected crank payout: ${crankPool} lamports`);

  // Read vault
  const vaultInfo = await c.getAccountInfo(vPda(t));
  if (vaultInfo && vaultInfo.data.length > 80) {
    const totalCrankDist = Number(vaultInfo.data.readBigUInt64LE(72)); // total_crank_distributed offset
    console.log(`  Vault total_crank_distributed: ${totalCrankDist}`);
  }

  const checks: [string, boolean][] = [
    ['Rake accumulated > 0', rake > 0],
    ['Crank pool > 0', crankPool > 0],
    ['Crank pool = 45% of rake', crankPool === Math.floor(rake * 4500 / 10000)],
    ['Distribute succeeded', distOk],
  ];

  console.log('\n  Crank Rewards Checks:');
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);

  console.log(`\n${'='.repeat(70)}\n  Crank rewards test complete!\n${'='.repeat(70)}`);
}

main().catch(e => { console.error('Test failed:', e); process.exit(1); });
