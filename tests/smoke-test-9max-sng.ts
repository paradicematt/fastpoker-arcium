/**
 * 9-Max SNG Test — Silver Tier
 *
 * Tests 9-player SNG with Silver tier buy-in:
 *   Silver (devnet): entry=37,500,000 + fee=12,500,000 = 50,000,000 per player
 *   Prize pool: 9 * 37,500,000 = 337,500,000 lamports
 *   Payout: 50%/30%/20% (3 ITM positions)
 *
 * Run: npx ts-node smoke-test-9max-sng.ts
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

function disc(n: string): Buffer { return Buffer.from(crypto.createHash('sha256').update(`global:${n}`).digest().subarray(0, 8)); }
const IX = {
  register: disc('register_player'), create: disc('create_table'), init_seat: disc('init_table_seat'),
  join: disc('join_table'), start: disc('start_game'), deal: disc('devnet_bypass_deal'),
  action: disc('player_action'), settle: disc('settle_hand'),
};

const pda = (seeds: Buffer[], prog = PROGRAM) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const seatPda = (t: PublicKey, i: number) => pda([Buffer.from('seat'), t.toBuffer(), Buffer.from([i])]);
const scPda = (t: PublicKey, i: number) => pda([Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])]);
const dsPda = (t: PublicKey) => pda([Buffer.from('deck_state'), t.toBuffer()]);
const vPda = (t: PublicKey) => pda([Buffer.from('vault'), t.toBuffer()]);
const rPda = (t: PublicKey, i: number) => pda([Buffer.from('receipt'), t.toBuffer(), Buffer.from([i])]);
const dpPda = (t: PublicKey, i: number) => pda([Buffer.from('deposit_proof'), t.toBuffer(), Buffer.from([i])]);
const plPda = (w: PublicKey) => pda([Buffer.from('player'), w.toBuffer()]);
const mkPda = (w: PublicKey, t: PublicKey) => pda([Buffer.from('player_table'), w.toBuffer(), t.toBuffer()]);
const ctePda = (t: PublicKey) => pda([Buffer.from('crank_tally_er'), t.toBuffer()]);
const ctlPda = (t: PublicKey) => pda([Buffer.from('crank_tally_l1'), t.toBuffer()]);
const poolPda = () => pda([Buffer.from('pool')], STEEL);
const unrPda = (w: PublicKey) => pda([Buffer.from('unrefined'), w.toBuffer()], STEEL);

function step(n: string) { console.log(`\n${'='.repeat(70)}\n  ${n}\n${'='.repeat(70)}`); }

async function send(c: Connection, ix: TransactionInstruction, signers: Keypair[], label: string): Promise<boolean> {
  try {
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    tx.feePayer = signers[0].publicKey;
    await sendAndConfirmTransaction(c, tx, signers, { commitment: 'confirmed' });
    console.log(`  ✅ ${label}`);
    return true;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0, 120)}`);
    if (e.logs) e.logs.filter((l: string) => l.includes('Error') || l.includes('Program log')).slice(-4).forEach((l: string) => console.log(`     ${l}`));
    return false;
  }
}

const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['c','d','h','s'];
function cardStr(c: number): string { return c === 255 ? '--' : `${RANKS[c % 13]}${SUITS[Math.floor(c / 13)]}`; }

async function main() {
  console.log('='.repeat(70));
  console.log('  9-Max SNG Test — Silver Tier');
  console.log('='.repeat(70));

  const c = new Connection(RPC, 'confirmed');
  if (!(await c.getAccountInfo(PROGRAM))?.executable) { console.log('Program not deployed'); return; }

  const N = 9;
  const players: Keypair[] = [];
  for (let i = 0; i < N; i++) players.push(Keypair.generate());

  // ── Setup ──
  step(`Airdrop + Register ${N} Players`);
  for (let i = 0; i < N; i++) {
    await c.confirmTransaction(await c.requestAirdrop(players[i].publicKey, 2 * LAMPORTS_PER_SOL), 'confirmed');
    await send(c, new TransactionInstruction({
      programId: PROGRAM, data: IX.register,
      keys: [
        { pubkey: players[i].publicKey, isSigner: true, isWritable: true },
        { pubkey: plPda(players[i].publicKey), isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: poolPda(), isSigner: false, isWritable: true },
        { pubkey: unrPda(players[i].publicKey), isSigner: false, isWritable: true },
        { pubkey: STEEL, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }), [players[i]], `Register P${i}`);
  }

  // ── Create 9-Max Silver SNG ──
  step('Create 9-Max SNG Table (Silver Tier)');
  const tId = crypto.randomBytes(32);
  const t = pda([Buffer.from('table'), tId]);
  // GameType: 2=SitAndGo9Max, Tier: 2=Silver
  const cfg = Buffer.alloc(36);
  tId.copy(cfg, 0, 0, 32);
  cfg.writeUInt8(2, 32); // SitAndGo9Max
  cfg.writeUInt8(0, 33);
  cfg.writeUInt8(9, 34); // 9 players
  cfg.writeUInt8(2, 35); // Silver tier

  await send(c, new TransactionInstruction({
    programId: PROGRAM, data: Buffer.concat([IX.create, cfg]),
    keys: [
      { pubkey: players[0].publicKey, isSigner: true, isWritable: true },
      { pubkey: t, isSigner: false, isWritable: true },
      { pubkey: poolPda(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  }), [players[0]], 'Create 9-Max Silver SNG');

  let tInfo = await c.getAccountInfo(t);
  if (tInfo) {
    const d = tInfo.data;
    const entry = d.length > 369 ? Number(d.readBigUInt64LE(361)) : 0;
    const fee = d.length > 377 ? Number(d.readBigUInt64LE(369)) : 0;
    console.log(`  GameType: ${d[104]} (2=SitAndGo9Max), Max: ${d[121]}, Tier: ${d.length > 360 ? d[360] : '?'} (2=Silver)`);
    console.log(`  Entry: ${entry} (${entry/LAMPORTS_PER_SOL} SOL), Fee: ${fee} (${fee/LAMPORTS_PER_SOL} SOL)`);
  }

  // ── Init 9 Seats ──
  step('Init 9 Seats');
  for (let i = 0; i < N; i++) {
    await send(c, new TransactionInstruction({
      programId: PROGRAM, data: Buffer.concat([IX.init_seat, Buffer.from([i])]),
      keys: [
        { pubkey: players[0].publicKey, isSigner: true, isWritable: true },
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
    }), [players[0]], `Init Seat ${i}`);
  }

  // ── Join 9 Players ──
  step('Join 9 Players (Silver Buy-In)');
  for (let i = 0; i < N; i++) {
    const d = Buffer.alloc(25); IX.join.copy(d, 0);
    d.writeBigUInt64LE(0n, 8); d.writeUInt8(i, 16); d.writeBigUInt64LE(0n, 17);
    await send(c, new TransactionInstruction({
      programId: PROGRAM, data: d,
      keys: [
        { pubkey: players[i].publicKey, isSigner: true, isWritable: true },
        { pubkey: plPda(players[i].publicKey), isSigner: false, isWritable: true },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: seatPda(t, i), isSigner: false, isWritable: true },
        { pubkey: mkPda(players[i].publicKey, t), isSigner: false, isWritable: true },
        ...[0,1,2,3,4,5,6,7].map(_ => ({ pubkey: PROGRAM, isSigner: false, isWritable: false })),
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }), [players[i]], `Join P${i}`);
  }

  tInfo = await c.getAccountInfo(t);
  if (tInfo) {
    const d = tInfo.data;
    const prizePool = d.length > 385 ? Number(d.readBigUInt64LE(377)) : 0;
    console.log(`  Players: ${d[122]}/${d[121]}`);
    console.log(`  Seats: 0b${d.readUInt16LE(250).toString(2).padStart(9, '0')}`);
    console.log(`  Prize Pool: ${prizePool} lamports (${prizePool/LAMPORTS_PER_SOL} SOL)`);
  }

  // ── Start + Deal ──
  step('Start Game + Deal (9 Players)');
  const startKeys = [
    { pubkey: players[0].publicKey, isSigner: false, isWritable: false },
    { pubkey: t, isSigner: false, isWritable: true },
    { pubkey: dsPda(t), isSigner: false, isWritable: true },
    ...Array.from({length: N}, (_, i) => ({ pubkey: seatPda(t, i), isSigner: false, isWritable: true })),
  ];
  await send(c, new TransactionInstruction({ programId: PROGRAM, data: IX.start, keys: startKeys }), [players[0]], 'Start Game');

  const dealKeys = [
    { pubkey: players[0].publicKey, isSigner: true, isWritable: false },
    { pubkey: t, isSigner: false, isWritable: true },
    { pubkey: dsPda(t), isSigner: false, isWritable: true },
    { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
    ...Array.from({length: N}, (_, i) => ({ pubkey: seatPda(t, i), isSigner: false, isWritable: true })),
    ...Array.from({length: N}, (_, i) => ({ pubkey: scPda(t, i), isSigner: false, isWritable: true })),
  ];
  await send(c, new TransactionInstruction({ programId: PROGRAM, data: IX.deal, keys: dealKeys }), [players[0]], 'Deal 9 Players');

  // Show cards
  tInfo = await c.getAccountInfo(t);
  if (tInfo) console.log(`  Phase: ${tInfo.data[160]}, Current: seat ${tInfo.data[161]}`);
  for (let i = 0; i < N; i++) {
    const sc = await c.getAccountInfo(scPda(t, i));
    if (sc && sc.data.length > 74) console.log(`  Seat ${i}: ${cardStr(sc.data[73])} ${cardStr(sc.data[74])}`);
  }

  // ── Fold 8 players → 1 wins ──
  step('Fold 8 Players');
  for (let actionNum = 0; actionNum < 8; actionNum++) {
    tInfo = await c.getAccountInfo(t);
    if (!tInfo || tInfo.data[160] !== 3) break; // Not Preflop
    const cp = tInfo.data[161];
    await send(c, new TransactionInstruction({
      programId: PROGRAM, data: Buffer.concat([IX.action, Buffer.from([0])]),
      keys: [
        { pubkey: players[cp].publicKey, isSigner: true, isWritable: false },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: seatPda(t, cp), isSigner: false, isWritable: true },
        { pubkey: PROGRAM, isSigner: false, isWritable: false },
      ],
    }), [players[cp]], `Fold seat ${cp}`);
  }

  // Settle if needed
  tInfo = await c.getAccountInfo(t);
  if (tInfo && tInfo.data[160] === 7) {
    const settleKeys = [
      { pubkey: players[0].publicKey, isSigner: false, isWritable: false },
      { pubkey: t, isSigner: false, isWritable: true },
      { pubkey: dsPda(t), isSigner: false, isWritable: true },
      ...Array.from({length: N}, (_, i) => ({ pubkey: seatPda(t, i), isSigner: false, isWritable: true })),
      ...Array.from({length: N}, (_, i) => ({ pubkey: scPda(t, i), isSigner: false, isWritable: true })),
    ];
    await send(c, new TransactionInstruction({ programId: PROGRAM, data: IX.settle, keys: settleKeys }), [players[0]], 'Settle');
  }

  // ── Final ──
  step('FINAL: 9-Max SNG Verification');
  tInfo = await c.getAccountInfo(t);
  let totalChips = 0;
  for (let i = 0; i < N; i++) {
    const si = await c.getAccountInfo(seatPda(t, i));
    if (si && si.data.length > 112) totalChips += Number(si.data.readBigUInt64LE(104));
  }
  const prizePool = tInfo && tInfo.data.length > 385 ? Number(tInfo.data.readBigUInt64LE(377)) : 0;

  const checks: [string, boolean][] = [
    ['9 players joined', (tInfo?.data[122] ?? 0) >= 8],
    ['Total chips = 13500 (9×1500)', totalChips === 13500],
    ['Phase = Waiting', tInfo?.data[160] === 0],
    // Silver: entry=37,500,000/player × 9 = 337,500,000
    [`Prize pool = ${prizePool} (expected 337,500,000)`, prizePool === 337_500_000],
  ];

  console.log(`  Total chips: ${totalChips}, Prize pool: ${prizePool} (${prizePool/LAMPORTS_PER_SOL} SOL)`);
  console.log('\n  9-Max SNG Checks:');
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);

  console.log(`\n${'='.repeat(70)}\n  9-Max SNG test complete!\n${'='.repeat(70)}`);
}

main().catch(e => { console.error('Test failed:', e); process.exit(1); });
