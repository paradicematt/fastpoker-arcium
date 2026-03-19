/**
 * Smoke Test: Full Showdown with Hand Evaluation
 *
 * Tests the COMPLETE hand flow through all streets to showdown:
 *   1. Setup (register, create, init, join, start, deal)
 *   2. Preflop: SB calls, BB checks → FlopRevealPending
 *   3. devnet_bypass_reveal → Flop (verify 3 community cards)
 *   4. Flop: both check → TurnRevealPending
 *   5. devnet_bypass_reveal → Turn (verify 4 community cards)
 *   6. Turn: both check → RiverRevealPending
 *   7. devnet_bypass_reveal → River (verify 5 community cards)
 *   8. River: both check → Showdown
 *   9. settle_hand → verify hand eval, revealed_hands, winner
 *
 * Verifies: hole cards dealt to SeatCards, community cards visible,
 *           on-chain hand evaluation, correct pot distribution.
 *
 * Run: npx ts-node smoke-test-showdown.ts
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

// Seeds
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
const tablePda = (id: Buffer) => pda([S.table, id]);
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

// Phase names
const PN: Record<number, string> = {
  0:'Waiting',1:'Starting',2:'AwaitingDeal',3:'Preflop',4:'Flop',5:'Turn',6:'River',
  7:'Showdown',8:'AwaitingShowdown',9:'Complete',10:'FlopRevealPending',11:'TurnRevealPending',12:'RiverRevealPending',
};

// Card decoding
// Card encoding matches hand_eval.rs: rank = card % 13, suit = card / 13
// Rank: 0=2, 1=3, ..., 8=T, 9=J, 10=Q, 11=K, 12=A
// Suit: 0=clubs, 1=diamonds, 2=hearts, 3=spades
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
  console.log('  FastPoker Showdown Test — Full Hand with Hand Evaluation');
  console.log('='.repeat(70));

  const c = new Connection(RPC, 'confirmed');
  if (!(await c.getAccountInfo(PROGRAM))?.executable) { console.log('Program not deployed'); return; }

  const pA = Keypair.generate();
  const pB = Keypair.generate();

  // ── Setup: Airdrop + Register ──
  step('Setup: Airdrop + Register');
  await c.confirmTransaction(await c.requestAirdrop(pA.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
  await c.confirmTransaction(await c.requestAirdrop(pB.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');

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

  // ── Create Table (HU Cash, Micro) ──
  step('Create Table + Init Seats + Join');
  const tId = crypto.randomBytes(32);
  const t = tablePda(tId);
  const cfgBuf = Buffer.alloc(36);
  tId.copy(cfgBuf, 0, 0, 32);
  cfgBuf.writeUInt8(3, 32); // CashGame
  cfgBuf.writeUInt8(0, 33); // Micro
  cfgBuf.writeUInt8(2, 34); // HU
  cfgBuf.writeUInt8(0, 35); // Micro tier

  await send(c, new TransactionInstruction({
    programId: PROGRAM, data: Buffer.concat([IX.create, cfgBuf]),
    keys: [
      { pubkey: pA.publicKey, isSigner: true, isWritable: true },
      { pubkey: t, isSigner: false, isWritable: true },
      { pubkey: poolPda(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  }), [pA], 'Create Table');

  // Init seats
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

  // Join both players
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

  // ── Start Game ──
  step('Start Game + Deal');
  await send(c, new TransactionInstruction({
    programId: PROGRAM, data: IX.start,
    keys: [
      { pubkey: pA.publicKey, isSigner: false, isWritable: false },
      { pubkey: t, isSigner: false, isWritable: true },
      { pubkey: dsPda(t), isSigner: false, isWritable: true },
      { pubkey: seatPda(t, 0), isSigner: false, isWritable: true },
      { pubkey: seatPda(t, 1), isSigner: false, isWritable: true },
    ],
  }), [pA], 'Start Game');

  // Deal (seats + seat_cards)
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

  // Read dealt cards from SeatCards
  step('Verify Dealt Cards');
  for (let i = 0; i < 2; i++) {
    const scInfo = await c.getAccountInfo(scPda(t, i));
    if (scInfo && scInfo.data.length > 74) {
      const c1 = scInfo.data[73], c2 = scInfo.data[74];
      console.log(`  Seat ${i} hole cards: ${cardStr(c1)} ${cardStr(c2)} (raw: ${c1}, ${c2})`);
    }
  }
  // Read community cards from table
  let tInfo = await c.getAccountInfo(t);
  if (tInfo) {
    const cc = Array.from(tInfo.data.subarray(155, 160));
    console.log(`  Community cards: ${cc.map(cardStr).join(' ')}`);
    console.log(`  Phase: ${PN[tInfo.data[160]]}`);
  }

  // ── Helper: send player action ──
  async function act(player: Keypair, seatIdx: number, actionByte: number, label: string) {
    return send(c, new TransactionInstruction({
      programId: PROGRAM, data: Buffer.concat([IX.action, Buffer.from([actionByte])]),
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: false },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: seatPda(t, seatIdx), isSigner: false, isWritable: true },
        { pubkey: PROGRAM, isSigner: false, isWritable: false }, // session_token: None
      ],
    }), [player], label);
  }

  // Helper: send reveal
  async function reveal(label: string) {
    return send(c, new TransactionInstruction({
      programId: PROGRAM, data: IX.reveal,
      keys: [
        { pubkey: pA.publicKey, isSigner: true, isWritable: false },
        { pubkey: t, isSigner: false, isWritable: true },
      ],
    }), [pA], label);
  }

  // Helper: read phase
  async function readPhase(): Promise<number> {
    const info = await c.getAccountInfo(t);
    return info ? info.data[160] : -1;
  }

  // ── Preflop Betting ──
  step('Preflop: SB calls, BB checks');
  // In HU preflop: SB (seat 0, dealer) acts first
  tInfo = await c.getAccountInfo(t);
  let cp = tInfo ? tInfo.data[161] : 0;
  console.log(`  Current player: seat ${cp}`);

  // SB calls (seat 0) — needs to match BB
  await act(cp === 0 ? pA : pB, cp, 2, `Call (seat ${cp})`); // 2 = Call

  // BB checks (seat 1)
  cp = (await c.getAccountInfo(t))!.data[161];
  console.log(`  Current player: seat ${cp}`);
  await act(cp === 0 ? pA : pB, cp, 1, `Check (seat ${cp})`); // 1 = Check

  let phase = await readPhase();
  console.log(`  Phase after preflop: ${PN[phase]} (${phase})`);

  // ── Flop ──
  if (phase === 10) { // FlopRevealPending
    // Verify community cards HIDDEN before flop reveal
    tInfo = await c.getAccountInfo(t);
    if (tInfo) {
      const cc = Array.from(tInfo.data.subarray(155, 160));
      const allHidden = cc.every(v => v === 255);
      console.log(`  Community before flop: ${cc.map(cardStr).join(' ')} (${allHidden ? 'HIDDEN ✅' : 'EXPOSED ❌'})`);
    }

    step('Reveal Flop');
    await reveal('Flop Reveal');
    phase = await readPhase();
    console.log(`  Phase: ${PN[phase]} (${phase})`);

    // Verify flop cards VISIBLE, turn+river HIDDEN
    tInfo = await c.getAccountInfo(t);
    if (tInfo) {
      const cc = Array.from(tInfo.data.subarray(155, 160));
      const flopVisible = cc[0] !== 255 && cc[1] !== 255 && cc[2] !== 255;
      const turnHidden = cc[3] === 255;
      const riverHidden = cc[4] === 255;
      console.log(`  Community after flop: ${cc.map(cardStr).join(' ')}`);
      console.log(`  Flop visible: ${flopVisible ? '✅' : '❌'}, Turn hidden: ${turnHidden ? '✅' : '❌'}, River hidden: ${riverHidden ? '✅' : '❌'}`);
    }

    if (phase === 4) { // Flop
      step('Flop: both check');
      cp = (await c.getAccountInfo(t))!.data[161];
      await act(cp === 0 ? pA : pB, cp, 1, `Check (seat ${cp})`);
      cp = (await c.getAccountInfo(t))!.data[161];
      await act(cp === 0 ? pA : pB, cp, 1, `Check (seat ${cp})`);
      phase = await readPhase();
      console.log(`  Phase after flop: ${PN[phase]} (${phase})`);
    }
  }

  // ── Turn ──
  if (phase === 11) { // TurnRevealPending
    step('Reveal Turn');
    await reveal('Turn Reveal');
    phase = await readPhase();

    // Verify turn card VISIBLE, river HIDDEN
    tInfo = await c.getAccountInfo(t);
    if (tInfo) {
      const cc = Array.from(tInfo.data.subarray(155, 160));
      const turnVisible = cc[3] !== 255;
      const riverHidden = cc[4] === 255;
      console.log(`  Community after turn: ${cc.map(cardStr).join(' ')}`);
      console.log(`  Turn visible: ${turnVisible ? '✅' : '❌'}, River hidden: ${riverHidden ? '✅' : '❌'}`);
    }

    if (phase === 5) { // Turn
      step('Turn: both check');
      cp = (await c.getAccountInfo(t))!.data[161];
      await act(cp === 0 ? pA : pB, cp, 1, `Check (seat ${cp})`);
      cp = (await c.getAccountInfo(t))!.data[161];
      await act(cp === 0 ? pA : pB, cp, 1, `Check (seat ${cp})`);
      phase = await readPhase();
      console.log(`  Phase after turn: ${PN[phase]} (${phase})`);
    }
  }

  // ── River ──
  if (phase === 12) { // RiverRevealPending
    step('Reveal River');
    await reveal('River Reveal');
    phase = await readPhase();

    // Verify ALL 5 community cards VISIBLE
    tInfo = await c.getAccountInfo(t);
    if (tInfo) {
      const cc = Array.from(tInfo.data.subarray(155, 160));
      const allVisible = cc.every(v => v !== 255);
      console.log(`  Community after river: ${cc.map(cardStr).join(' ')}`);
      console.log(`  All 5 visible: ${allVisible ? '✅' : '❌'}`);
    }

    if (phase === 6) { // River
      step('River: both check');
      cp = (await c.getAccountInfo(t))!.data[161];
      await act(cp === 0 ? pA : pB, cp, 1, `Check (seat ${cp})`);
      cp = (await c.getAccountInfo(t))!.data[161];
      await act(cp === 0 ? pA : pB, cp, 1, `Check (seat ${cp})`);
      phase = await readPhase();
      console.log(`  Phase after river: ${PN[phase]} (${phase})`);
    }
  }

  // ── Showdown + Settle ──
  if (phase === 7) { // Showdown
    step('Settle Hand (Showdown)');
    const ok = await send(c, new TransactionInstruction({
      programId: PROGRAM, data: IX.settle,
      keys: [
        { pubkey: pA.publicKey, isSigner: false, isWritable: false },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: dsPda(t), isSigner: false, isWritable: true },
        // remaining: [seats..., seat_cards...]
        { pubkey: seatPda(t, 0), isSigner: false, isWritable: true },
        { pubkey: seatPda(t, 1), isSigner: false, isWritable: true },
        { pubkey: scPda(t, 0), isSigner: false, isWritable: true },
        { pubkey: scPda(t, 1), isSigner: false, isWritable: true },
      ],
    }), [pA], 'Settle Hand');

    if (!ok) {
      console.log('  ❌ Settle failed — check logs above');
    }
  } else {
    console.log(`  ⚠️  Expected Showdown but got ${PN[phase]} (${phase})`);
  }

  // ── Final Verification ──
  step('FINAL: Verify Results');
  tInfo = await c.getAccountInfo(t);
  if (tInfo) {
    const d = tInfo.data;
    console.log(`  Phase: ${PN[d[160]]} (${d[160]})`);
    console.log(`  Pot: ${Number(d.readBigUInt64LE(131))}`);

    // Community cards
    const cc = Array.from(d.subarray(155, 160));
    console.log(`  Community: ${cc.map(cardStr).join(' ')}`);

    // Revealed hands (at showdown, settle writes these)
    const rh = Array.from(d.subarray(175, 193));
    for (let i = 0; i < 2; i++) {
      const c1 = rh[i * 2], c2 = rh[i * 2 + 1];
      if (c1 !== 255 && c2 !== 255) {
        console.log(`  Seat ${i} revealed: ${cardStr(c1)} ${cardStr(c2)}`);
      } else {
        console.log(`  Seat ${i} revealed: (not shown)`);
      }
    }

    // Hand results (rank enum values)
    const hr = Array.from(d.subarray(193, 202));
    const RANK_NAMES = ['HighCard','Pair','TwoPair','ThreeOfAKind','Straight','Flush','FullHouse','FourOfAKind','StraightFlush','RoyalFlush'];
    for (let i = 0; i < 2; i++) {
      if (hr[i] > 0 || rh[i*2] !== 255) {
        console.log(`  Seat ${i} hand rank: ${RANK_NAMES[hr[i]] ?? hr[i]}`);
      }
    }
  }

  // Seat chip balances
  for (let i = 0; i < 2; i++) {
    const si = await c.getAccountInfo(seatPda(t, i));
    if (si && si.data.length > 227) {
      const chips = Number(si.data.readBigUInt64LE(104));
      const status = si.data[227];
      const SN: Record<number,string> = {0:'Empty',1:'Active',2:'Folded',3:'AllIn',4:'SittingOut',5:'Busted',6:'Leaving'};
      console.log(`  Seat ${i}: ${chips} chips, ${SN[status] ?? status}`);
    }
  }

  // Verification checks
  const checks: [string, boolean][] = [];
  if (tInfo) {
    const d = tInfo.data;
    checks.push(['Phase back to Waiting', d[160] === 0]);
    checks.push(['Pot cleared', Number(d.readBigUInt64LE(131)) === 0]);
    // At least one player should have revealed hands (non-255)
    const rh = Array.from(d.subarray(175, 193));
    const anyRevealed = rh.some((v, i) => i < 4 && v !== 255);
    checks.push(['Hands revealed at showdown', anyRevealed]);
    // Total chips should be conserved (200k)
    const s0 = await c.getAccountInfo(seatPda(t, 0));
    const s1 = await c.getAccountInfo(seatPda(t, 1));
    if (s0 && s1) {
      const total = Number(s0.data.readBigUInt64LE(104)) + Number(s1.data.readBigUInt64LE(104));
      // Cash game rake = 5% of pot when flop_reached. Pot=4000 → rake=200.
      // So total chips = 200000 - rake.
      const rakeApplied = total < 200000;
      checks.push([`Chips conserved (${total} + rake = 200000)`, total <= 200000 && total >= 199000]);
      if (rakeApplied) console.log(`  Rake deducted: ${200000 - total} lamports`);
    }
  }
  console.log('\n  Showdown Checks:');
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);

  console.log(`\n${'='.repeat(70)}\n  Showdown test complete!\n${'='.repeat(70)}`);
}

main().catch(e => { console.error('Test failed:', e); process.exit(1); });
