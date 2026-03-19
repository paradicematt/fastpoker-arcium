/**
 * SNG Elimination Test — Full Tournament to Completion
 *
 * Tests the complete SNG lifecycle:
 *   1. Setup HU SNG (Micro tier, 1500 chips, 10/20 blinds)
 *   2. Hand 1: Seat 0 all-in, Seat 1 calls → all-in runout → showdown → settle
 *   3. Loser busted (0 chips) → start_game detects → phase=Complete
 *   4. distribute_prizes → POKER credits + SOL prizes + fee split
 *   5. Verify winner chips, prizes_distributed flag
 *
 * Run: npx ts-node smoke-test-sng-elimination.ts
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
  prize_authority: Buffer.from('prize_authority'),
};

function disc(n: string): Buffer { return Buffer.from(crypto.createHash('sha256').update(`global:${n}`).digest().subarray(0, 8)); }
const IX = {
  register: disc('register_player'), create: disc('create_table'), init_seat: disc('init_table_seat'),
  join: disc('join_table'), start: disc('start_game'), deal: disc('devnet_bypass_deal'),
  reveal: disc('devnet_bypass_reveal'), action: disc('player_action'), settle: disc('settle_hand'),
  distribute: disc('distribute_prizes'),
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
const prizeAuthPda = () => pda([S.prize_authority]);

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

async function readPhase(c: Connection, t: PublicKey): Promise<number> {
  const info = await c.getAccountInfo(t); return info ? info.data[160] : -1;
}

async function readSeatChips(c: Connection, t: PublicKey, i: number): Promise<number> {
  const info = await c.getAccountInfo(seatPda(t, i));
  return info && info.data.length > 112 ? Number(info.data.readBigUInt64LE(104)) : 0;
}

async function main() {
  console.log('='.repeat(70));
  console.log('  SNG Elimination Test — Full Tournament to Completion');
  console.log('='.repeat(70));

  const c = new Connection(RPC, 'confirmed');
  if (!(await c.getAccountInfo(PROGRAM))?.executable) { console.log('Program not deployed'); return; }

  const pA = Keypair.generate();
  const pB = Keypair.generate();
  const players = [pA, pB];

  // ── Setup ──
  step('Setup: Airdrop + Register');
  for (const p of players) {
    await c.confirmTransaction(await c.requestAirdrop(p.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
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
    }), [p], `Register ${p === pA ? 'A' : 'B'}`);
  }

  // ── Create SNG Table ──
  step('Create SNG Table (HU Micro)');
  const tId = crypto.randomBytes(32);
  const t = pda([S.table, tId]);
  const cfgBuf = Buffer.alloc(36);
  tId.copy(cfgBuf, 0, 0, 32);
  cfgBuf.writeUInt8(0, 32); // SitAndGoHeadsUp
  cfgBuf.writeUInt8(0, 33); // Micro stakes
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
  }), [pA], 'Create SNG Table');

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
    d.writeBigUInt64LE(0n, 8); d.writeUInt8(i, 16); d.writeBigUInt64LE(0n, 17);
    await send(c, new TransactionInstruction({
      programId: PROGRAM, data: d,
      keys: [
        { pubkey: p.publicKey, isSigner: true, isWritable: true },
        { pubkey: plPda(p.publicKey), isSigner: false, isWritable: true },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: seatPda(t, i), isSigner: false, isWritable: true },
        { pubkey: mkPda(p.publicKey, t), isSigner: false, isWritable: true },
        // 8 optional None sentinels: vault, receipt, treasury, pool, player_token, table_token, unclaimed, token_program
        ...[0,1,2,3,4,5,6,7].map(_ => ({ pubkey: PROGRAM, isSigner: false, isWritable: false })),
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }), [p], `Join ${l}`);
  }

  console.log(`  Seat 0: ${await readSeatChips(c, t, 0)} chips`);
  console.log(`  Seat 1: ${await readSeatChips(c, t, 1)} chips`);

  // ── Hand 1: All-in battle ──
  step('Hand 1: Start + Deal');
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

  // Read cards
  for (let i = 0; i < 2; i++) {
    const scInfo = await c.getAccountInfo(scPda(t, i));
    if (scInfo && scInfo.data.length > 74) {
      console.log(`  Seat ${i}: ${cardStr(scInfo.data[73])} ${cardStr(scInfo.data[74])}`);
    }
  }

  step('Hand 1: All-In Battle');
  // SB (seat 0) goes all-in
  let tInfo = await c.getAccountInfo(t);
  let cp = tInfo ? tInfo.data[161] : 0;
  console.log(`  Current player: seat ${cp} (SB goes all-in)`);
  await send(c, new TransactionInstruction({
    programId: PROGRAM, data: Buffer.concat([IX.action, Buffer.from([5])]), // AllIn
    keys: [
      { pubkey: players[cp].publicKey, isSigner: true, isWritable: false },
      { pubkey: t, isSigner: false, isWritable: true },
      { pubkey: seatPda(t, cp), isSigner: false, isWritable: true },
      { pubkey: PROGRAM, isSigner: false, isWritable: false },
    ],
  }), [players[cp]], `All-In (seat ${cp})`);

  // BB calls the all-in
  tInfo = await c.getAccountInfo(t);
  cp = tInfo ? tInfo.data[161] : 1;
  console.log(`  Current player: seat ${cp} (BB calls all-in)`);
  await send(c, new TransactionInstruction({
    programId: PROGRAM, data: Buffer.concat([IX.action, Buffer.from([2])]), // Call
    keys: [
      { pubkey: players[cp].publicKey, isSigner: true, isWritable: false },
      { pubkey: t, isSigner: false, isWritable: true },
      { pubkey: seatPda(t, cp), isSigner: false, isWritable: true },
      { pubkey: PROGRAM, isSigner: false, isWritable: false },
    ],
  }), [players[cp]], `Call All-In (seat ${cp})`);

  let phase = await readPhase(c, t);
  console.log(`  Phase after all-in: ${PN[phase]} (${phase})`);

  // All-in runout: 3 reveals (flop→turn→river)
  step('All-In Runout: 3 Reveals');
  for (let i = 0; i < 3; i++) {
    phase = await readPhase(c, t);
    if (phase === 10 || phase === 11 || phase === 12) {
      await send(c, new TransactionInstruction({
        programId: PROGRAM, data: IX.reveal,
        keys: [
          { pubkey: pA.publicKey, isSigner: true, isWritable: false },
          { pubkey: t, isSigner: false, isWritable: true },
        ],
      }), [pA], `Reveal ${i + 1}`);
    } else {
      console.log(`  Phase ${PN[phase]} — no more reveals needed`);
      break;
    }
  }

  phase = await readPhase(c, t);
  console.log(`  Phase after runout: ${PN[phase]} (${phase})`);

  // Settle
  if (phase === 7) {
    step('Settle Hand (Showdown)');
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
    }), [pA], 'Settle Hand');
  }

  // Check chips after settle
  const chips0 = await readSeatChips(c, t, 0);
  const chips1 = await readSeatChips(c, t, 1);
  console.log(`\n  After settle:`);
  console.log(`  Seat 0: ${chips0} chips`);
  console.log(`  Seat 1: ${chips1} chips`);
  const winnerSeat = chips0 > chips1 ? 0 : 1;
  const loserSeat = 1 - winnerSeat;
  console.log(`  Winner: seat ${winnerSeat} (${winnerSeat === 0 ? 'A' : 'B'})`);

  // ── start_game → should detect bust → Complete ──
  step('Start Game → Bust Detection → Complete');
  phase = await readPhase(c, t);
  console.log(`  Phase before start: ${PN[phase]} (${phase})`);

  if (phase === 0) {
    await send(c, new TransactionInstruction({
      programId: PROGRAM, data: IX.start,
      keys: [
        { pubkey: pA.publicKey, isSigner: false, isWritable: false },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: dsPda(t), isSigner: false, isWritable: true },
        { pubkey: seatPda(t, 0), isSigner: false, isWritable: true },
        { pubkey: seatPda(t, 1), isSigner: false, isWritable: true },
      ],
    }), [pA], 'Start Game (bust detect)');
  }

  phase = await readPhase(c, t);
  console.log(`  Phase after start: ${PN[phase]} (${phase})`);

  // ── Initialize STEEL Pool (required for distribute_prizes CPI) ──
  if (phase === 9) {
    step('Initialize STEEL Pool');
    const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
    // STEEL initialize: disc=0, accounts=[authority, pool, poker_mint, system_program]
    const initPoolIx = new TransactionInstruction({
      programId: STEEL, data: Buffer.from([0]),
      keys: [
        { pubkey: pA.publicKey, isSigner: true, isWritable: true },
        { pubkey: poolPda(), isSigner: false, isWritable: true },
        { pubkey: POKER_MINT, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });
    const poolOk = await send(c, initPoolIx, [pA], 'Init STEEL Pool');
    if (poolOk) console.log(`  Pool PDA: ${poolPda().toBase58()}`);
  }

  // ── distribute_prizes ──
  if (phase === 9) { // Complete
    step('Distribute Prizes');
    const winnerWallet = players[winnerSeat].publicKey;

    // remaining_accounts: [seat_0, seat_1, winner_player_pda, winner_unrefined_pda]
    const distOk = await send(c, new TransactionInstruction({
      programId: PROGRAM, data: IX.distribute,
      keys: [
        { pubkey: pA.publicKey, isSigner: true, isWritable: true },   // caller
        { pubkey: t, isSigner: false, isWritable: true },              // table
        { pubkey: STEEL, isSigner: false, isWritable: false },         // steel_program
        { pubkey: prizeAuthPda(), isSigner: false, isWritable: true }, // prize_authority
        { pubkey: poolPda(), isSigner: false, isWritable: true },      // steel_pool
        { pubkey: TREASURY, isSigner: false, isWritable: true },       // treasury
        { pubkey: vPda(t), isSigner: false, isWritable: true },        // vault
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        // remaining: [seat_0, seat_1, winner_player_pda, winner_unrefined_pda]
        { pubkey: seatPda(t, 0), isSigner: false, isWritable: true },
        { pubkey: seatPda(t, 1), isSigner: false, isWritable: true },
        { pubkey: plPda(winnerWallet), isSigner: false, isWritable: true },
        { pubkey: unrPda(winnerWallet), isSigner: false, isWritable: true },
      ],
    }), [pA], 'Distribute Prizes');

    if (distOk) {
      console.log(`  Winner (seat ${winnerSeat}): prizes distributed`);
    }
  } else {
    console.log(`  ⚠️  Expected Complete (9) but got ${PN[phase]} (${phase})`);
  }

  // ── Final Verification ──
  step('FINAL: Verify Tournament Results');
  tInfo = await c.getAccountInfo(t);
  if (tInfo) {
    const d = tInfo.data;
    const prizesDistributed = d.length > 339 ? d[339] === 1 : false;
    console.log(`  Phase: ${PN[d[160]]} (${d[160]})`);
    console.log(`  Prizes Distributed: ${prizesDistributed}`);
    console.log(`  Eliminated Count: ${d.length > 351 ? d[351] : '?'}`);
  }

  // Read seat statuses
  for (let i = 0; i < 2; i++) {
    const si = await c.getAccountInfo(seatPda(t, i));
    if (si && si.data.length > 227) {
      const chips = Number(si.data.readBigUInt64LE(104));
      const status = si.data[227];
      const SN: Record<number,string> = {0:'Empty',1:'Active',2:'Folded',3:'AllIn',4:'SittingOut',5:'Busted',6:'Leaving'};
      console.log(`  Seat ${i}: ${chips} chips, ${SN[status] ?? status}`);
    }
  }

  // Checks
  const checks: [string, boolean][] = [];
  if (tInfo) {
    const d = tInfo.data;
    checks.push(['Phase = Complete', d[160] === 9]);
    checks.push(['Prizes distributed', d.length > 339 && d[339] === 1]);
    checks.push(['Winner has 3000 chips', (chips0 === 3000 || chips1 === 3000)]);
    checks.push(['Loser has 0 chips', (chips0 === 0 || chips1 === 0)]);
  }
  console.log('\n  Tournament Checks:');
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);

  console.log(`\n${'='.repeat(70)}\n  SNG Elimination test complete!\n${'='.repeat(70)}`);
}

main().catch(e => { console.error('Test failed:', e); process.exit(1); });
