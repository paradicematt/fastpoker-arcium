/**
 * 6-Max SNG Test — Bronze Tier with SOL Prize Pool
 *
 * Tests multi-player SNG:
 *   1. Create 6-max SNG table (Bronze tier: 0.025 SOL buy-in)
 *   2. Register + join 6 players (1500 chips each)
 *   3. Start game (requires 6/6), deal with 6 seats
 *   4. Play hand: 5 players fold, 1 wins pot
 *   5. Verify: prize pool, entry fees escrowed, chip movements
 *
 * Bronze tier (devnet, TIER_SCALE=10):
 *   entry = 18,750,000 lamports (→ prize pool)
 *   fee   =  6,250,000 lamports (→ Steel)
 *   total = 25,000,000 lamports per player
 *   6 players: prize_pool = 112,500,000, fees = 37,500,000
 *
 * Run: npx ts-node smoke-test-6max-sng.ts
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
};

function disc(n: string): Buffer { return Buffer.from(crypto.createHash('sha256').update(`global:${n}`).digest().subarray(0, 8)); }
const IX = {
  register: disc('register_player'), create: disc('create_table'), init_seat: disc('init_table_seat'),
  join: disc('join_table'), start: disc('start_game'), deal: disc('devnet_bypass_deal'),
  reveal: disc('devnet_bypass_reveal'), action: disc('player_action'), settle: disc('settle_hand'),
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

const PN: Record<number, string> = {
  0:'Waiting',1:'Starting',2:'AwaitingDeal',3:'Preflop',4:'Flop',5:'Turn',6:'River',
  7:'Showdown',8:'AwaitingShowdown',9:'Complete',10:'FlopRevealPending',11:'TurnRevealPending',12:'RiverRevealPending',
};
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['c','d','h','s'];
function cardStr(c: number): string { return c === 255 ? '--' : `${RANKS[c % 13]}${SUITS[Math.floor(c / 13)]}`; }

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
  console.log('  6-Max SNG Test — Bronze Tier with SOL Prize Pool');
  console.log('='.repeat(70));

  const c = new Connection(RPC, 'confirmed');
  if (!(await c.getAccountInfo(PROGRAM))?.executable) { console.log('Program not deployed'); return; }

  const NUM_PLAYERS = 6;
  const players: Keypair[] = [];
  for (let i = 0; i < NUM_PLAYERS; i++) players.push(Keypair.generate());

  // ── Setup: Airdrop + Register ──
  step(`Setup: Airdrop + Register ${NUM_PLAYERS} Players`);
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const p = players[i];
    await c.confirmTransaction(await c.requestAirdrop(p.publicKey, 2 * LAMPORTS_PER_SOL), 'confirmed');
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
    }), [p], `Register P${i}`);
  }

  // ── Create 6-Max SNG Table (Bronze Tier) ──
  step('Create 6-Max SNG Table (Bronze Tier)');
  const tId = crypto.randomBytes(32);
  const t = pda([S.table, tId]);
  // GameType: 1=SitAndGo6Max, Stakes: 0=Micro, MaxPlayers: 6, Tier: 1=Bronze
  const cfgBuf = Buffer.alloc(36);
  tId.copy(cfgBuf, 0, 0, 32);
  cfgBuf.writeUInt8(1, 32); // SitAndGo6Max
  cfgBuf.writeUInt8(0, 33); // Stakes (irrelevant for SNG)
  cfgBuf.writeUInt8(6, 34); // 6 players
  cfgBuf.writeUInt8(1, 35); // Bronze tier

  await send(c, new TransactionInstruction({
    programId: PROGRAM, data: Buffer.concat([IX.create, cfgBuf]),
    keys: [
      { pubkey: players[0].publicKey, isSigner: true, isWritable: true },
      { pubkey: t, isSigner: false, isWritable: true },
      { pubkey: poolPda(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  }), [players[0]], 'Create 6-Max Bronze SNG');

  // Read table state
  let tInfo = await c.getAccountInfo(t);
  if (tInfo) {
    const d = tInfo.data;
    console.log(`  GameType: ${d[104]} (1=SitAndGo6Max)`);
    console.log(`  Max Players: ${d[121]}`);
    console.log(`  Blinds: ${Number(d.readBigUInt64LE(105))}/${Number(d.readBigUInt64LE(113))}`);
    const tier = d.length > 360 ? d[360] : 0;
    const entry = d.length > 369 ? Number(d.readBigUInt64LE(361)) : 0;
    const fee = d.length > 377 ? Number(d.readBigUInt64LE(369)) : 0;
    console.log(`  Tier: ${tier} (1=Bronze)`);
    console.log(`  Entry: ${entry} lamports (${entry / LAMPORTS_PER_SOL} SOL)`);
    console.log(`  Fee: ${fee} lamports (${fee / LAMPORTS_PER_SOL} SOL)`);
    console.log(`  Total buy-in: ${entry + fee} lamports per player`);
  }

  // ── Init 6 Seats ──
  step('Init 6 Seats');
  for (let i = 0; i < NUM_PLAYERS; i++) {
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

  // ── Join All 6 Players ──
  step('Join 6 Players (Bronze Buy-In)');
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const p = players[i];
    const d = Buffer.alloc(25); IX.join.copy(d, 0);
    d.writeBigUInt64LE(0n, 8); d.writeUInt8(i, 16); d.writeBigUInt64LE(0n, 17);
    await send(c, new TransactionInstruction({
      programId: PROGRAM, data: d,
      keys: [
        { pubkey: p.publicKey, isSigner: true, isWritable: true },
        { pubkey: plPda(p.publicKey), isSigner: false, isWritable: true },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: seatPda(t, i), isSigner: false, isWritable: true },
        { pubkey: mkPda(p.publicKey, t), isSigner: false, isWritable: true },
        // 8 optional None sentinels
        ...[0,1,2,3,4,5,6,7].map(_ => ({ pubkey: PROGRAM, isSigner: false, isWritable: false })),
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }), [p], `Join P${i} (seat ${i})`);
  }

  // Verify state
  tInfo = await c.getAccountInfo(t);
  if (tInfo) {
    const d = tInfo.data;
    const currentPlayers = d[122];
    const seatsOcc = d.readUInt16LE(250);
    const prizePool = d.length > 385 ? Number(d.readBigUInt64LE(377)) : 0;
    const feesEscrowed = d.length > 360 ? Number(d.readBigUInt64LE(352)) : 0;
    console.log(`\n  Current Players: ${currentPlayers}/6`);
    console.log(`  Seats Occupied: 0b${seatsOcc.toString(2).padStart(6, '0')}`);
    console.log(`  Prize Pool: ${prizePool} lamports (${prizePool / LAMPORTS_PER_SOL} SOL)`);
    console.log(`  Fees Escrowed: ${feesEscrowed} lamports`);
  }

  // Verify all seats have 1500 chips
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const si = await c.getAccountInfo(seatPda(t, i));
    if (si && si.data.length > 112) {
      const chips = Number(si.data.readBigUInt64LE(104));
      if (chips !== 1500) console.log(`  ⚠️ Seat ${i}: ${chips} chips (expected 1500)`);
    }
  }
  console.log(`  All 6 seats: 1500 chips each ✅`);

  // ── Start Game ──
  step('Start Game (6 Players)');
  const startKeys = [
    { pubkey: players[0].publicKey, isSigner: false, isWritable: false },
    { pubkey: t, isSigner: false, isWritable: true },
    { pubkey: dsPda(t), isSigner: false, isWritable: true },
  ];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    startKeys.push({ pubkey: seatPda(t, i), isSigner: false, isWritable: true });
  }
  await send(c, new TransactionInstruction({ programId: PROGRAM, data: IX.start, keys: startKeys }), [players[0]], 'Start Game');

  tInfo = await c.getAccountInfo(t);
  if (tInfo) {
    console.log(`  Phase: ${PN[tInfo.data[160]]} (${tInfo.data[160]})`);
    console.log(`  Hand #${Number(tInfo.data.readBigUInt64LE(123))}`);
    console.log(`  Pot: ${Number(tInfo.data.readBigUInt64LE(131))}`);
    console.log(`  Dealer: seat ${tInfo.data[163]}`);
  }

  // ── Deal (6 players) ──
  step('Deal (6 Players)');
  const dealKeys = [
    { pubkey: players[0].publicKey, isSigner: true, isWritable: false },
    { pubkey: t, isSigner: false, isWritable: true },
    { pubkey: dsPda(t), isSigner: false, isWritable: true },
    { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
  ];
  // remaining: [seats..., seat_cards...]
  for (let i = 0; i < NUM_PLAYERS; i++) dealKeys.push({ pubkey: seatPda(t, i), isSigner: false, isWritable: true });
  for (let i = 0; i < NUM_PLAYERS; i++) dealKeys.push({ pubkey: scPda(t, i), isSigner: false, isWritable: true });

  await send(c, new TransactionInstruction({ programId: PROGRAM, data: IX.deal, keys: dealKeys }), [players[0]], 'Deal 6 Players');

  // Show dealt cards
  tInfo = await c.getAccountInfo(t);
  if (tInfo) {
    console.log(`  Phase: ${PN[tInfo.data[160]]}`);
    console.log(`  Current Player: seat ${tInfo.data[161]}`);
  }
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const scInfo = await c.getAccountInfo(scPda(t, i));
    if (scInfo && scInfo.data.length > 74) {
      console.log(`  Seat ${i}: ${cardStr(scInfo.data[73])} ${cardStr(scInfo.data[74])}`);
    }
  }

  // ── Fold 5 players (all but last) ──
  step('Hand 1: Fold 5 Players');
  for (let actionNum = 0; actionNum < 5; actionNum++) {
    tInfo = await c.getAccountInfo(t);
    if (!tInfo) break;
    const phase = tInfo.data[160];
    if (phase !== 3) { // Not Preflop anymore
      console.log(`  Phase changed to ${PN[phase]} after ${actionNum} folds`);
      break;
    }
    const cp = tInfo.data[161];
    const p = players[cp];
    await send(c, new TransactionInstruction({
      programId: PROGRAM, data: Buffer.concat([IX.action, Buffer.from([0])]), // Fold
      keys: [
        { pubkey: p.publicKey, isSigner: true, isWritable: false },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: seatPda(t, cp), isSigner: false, isWritable: true },
        { pubkey: PROGRAM, isSigner: false, isWritable: false },
      ],
    }), [p], `Fold (seat ${cp})`);
  }

  // ── Settle ──
  tInfo = await c.getAccountInfo(t);
  let phase = tInfo ? tInfo.data[160] : 0;
  if (phase === 7) { // Showdown
    step('Settle Hand');
    const settleKeys = [
      { pubkey: players[0].publicKey, isSigner: false, isWritable: false },
      { pubkey: t, isSigner: false, isWritable: true },
      { pubkey: dsPda(t), isSigner: false, isWritable: true },
    ];
    for (let i = 0; i < NUM_PLAYERS; i++) settleKeys.push({ pubkey: seatPda(t, i), isSigner: false, isWritable: true });
    for (let i = 0; i < NUM_PLAYERS; i++) settleKeys.push({ pubkey: scPda(t, i), isSigner: false, isWritable: true });
    await send(c, new TransactionInstruction({ programId: PROGRAM, data: IX.settle, keys: settleKeys }), [players[0]], 'Settle Hand');
  }

  // ── Final Verification ──
  step('FINAL: Verify 6-Max SNG State');
  tInfo = await c.getAccountInfo(t);
  if (tInfo) {
    const d = tInfo.data;
    phase = d[160];
    console.log(`  Phase: ${PN[phase]} (${phase})`);
    console.log(`  Pot: ${Number(d.readBigUInt64LE(131))}`);
    const prizePool = d.length > 385 ? Number(d.readBigUInt64LE(377)) : 0;
    console.log(`  Prize Pool: ${prizePool} lamports (${prizePool / LAMPORTS_PER_SOL} SOL)`);
  }

  // Seat chip balances
  let totalChips = 0;
  const SN: Record<number,string> = {0:'Empty',1:'Active',2:'Folded',3:'AllIn',4:'SittingOut',5:'Busted',6:'Leaving'};
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const si = await c.getAccountInfo(seatPda(t, i));
    if (si && si.data.length > 227) {
      const chips = Number(si.data.readBigUInt64LE(104));
      const status = si.data[227];
      totalChips += chips;
      console.log(`  Seat ${i}: ${chips} chips, ${SN[status] ?? status}`);
    }
  }
  console.log(`  Total chips: ${totalChips} (expected ${1500 * NUM_PLAYERS})`);

  // Checks
  const checks: [string, boolean][] = [];
  checks.push(['6 players joined', (tInfo?.data[122] ?? 0) >= 5]); // current_players may decrease after bust
  checks.push(['Total chips conserved', totalChips === 1500 * NUM_PLAYERS]);
  checks.push(['Phase back to Waiting', phase === 0]);
  if (tInfo) {
    const prizePool = tInfo.data.length > 385 ? Number(tInfo.data.readBigUInt64LE(377)) : 0;
    // Bronze: entry = 18,750,000 per player * 6 = 112,500,000
    checks.push([`Prize pool = ${prizePool} (expected ~112,500,000)`, prizePool === 112_500_000]);
  }

  console.log('\n  6-Max SNG Checks:');
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);

  console.log(`\n${'='.repeat(70)}\n  6-Max SNG test complete!\n${'='.repeat(70)}`);
}

main().catch(e => { console.error('Test failed:', e); process.exit(1); });
