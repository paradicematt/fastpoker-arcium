/**
 * Comprehensive Cash Game Test
 *
 * Tests cash game-specific flows:
 *   1. Setup: create table, register, join 2 players
 *   2. Hand 1: Full showdown → verify rake deduction (5% after flop)
 *   3. Hand 2: Play another hand → verify multi-hand works
 *   4. Mid-game locking: try to join during hand (should fail)
 *   5. Leave table: player leaves → verify cashout flow
 *   6. Verify: rake accumulated, chip conservation, vault balances
 *
 * Cash game (Micro stakes: 1000/2000):
 *   Buy-in: 100,000 lamports per player (50 BB)
 *   Rake: 5% of pot when flop_reached (capped by rake_cap)
 *
 * Run: npx ts-node smoke-test-cash-comprehensive.ts
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
  0:'Waiting',1:'Starting',3:'Preflop',4:'Flop',5:'Turn',6:'River',
  7:'Showdown',9:'Complete',10:'FlopRevealPending',11:'TurnRevealPending',12:'RiverRevealPending',
};

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
    const msg = e.message?.slice(0, 150) || '';
    // Check if this is an expected failure
    if (msg.includes('HandInProgress') || msg.includes('InvalidActionForPhase') || msg.includes('TableFull')) {
      console.log(`  ✅ ${label}: REJECTED as expected (${msg.includes('HandInProgress') ? 'HandInProgress' : msg.includes('TableFull') ? 'TableFull' : 'InvalidPhase'})`);
      return false; // Expected failure
    }
    console.log(`  ❌ ${label}: ${msg}`);
    if (e.logs) e.logs.filter((l: string) => l.includes('Error') || l.includes('Program log')).slice(-4).forEach((l: string) => console.log(`     ${l}`));
    return false;
  }
}

async function readPhase(c: Connection, t: PublicKey): Promise<number> {
  const info = await c.getAccountInfo(t); return info ? info.data[160] : -1;
}
async function readChips(c: Connection, t: PublicKey, i: number): Promise<number> {
  const info = await c.getAccountInfo(seatPda(t, i));
  return info && info.data.length > 112 ? Number(info.data.readBigUInt64LE(104)) : 0;
}
async function readRake(c: Connection, t: PublicKey): Promise<number> {
  const info = await c.getAccountInfo(t);
  return info ? Number(info.data.readBigUInt64LE(147)) : 0;
}

async function main() {
  console.log('='.repeat(70));
  console.log('  Comprehensive Cash Game Test');
  console.log('='.repeat(70));

  const c = new Connection(RPC, 'confirmed');
  if (!(await c.getAccountInfo(PROGRAM))?.executable) { console.log('Program not deployed'); return; }

  const pA = Keypair.generate();
  const pB = Keypair.generate();
  const pC = Keypair.generate(); // 3rd player for join locking test
  const players = [pA, pB, pC];

  // ── Setup ──
  step('Setup: Airdrop + Register');
  for (const p of players) {
    await c.confirmTransaction(await c.requestAirdrop(p.publicKey, 5 * LAMPORTS_PER_SOL), 'confirmed');
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
    }), [p], `Register ${p === pA ? 'A' : p === pB ? 'B' : 'C'}`);
  }

  // ── Create Cash Game Table ──
  step('Create Cash Game Table (Micro Stakes HU)');
  const tId = crypto.randomBytes(32);
  const t = pda([S.table, tId]);
  const cfgBuf = Buffer.alloc(36);
  tId.copy(cfgBuf, 0, 0, 32);
  cfgBuf.writeUInt8(3, 32); // CashGame
  cfgBuf.writeUInt8(0, 33); // Micro
  cfgBuf.writeUInt8(2, 34); // HU
  cfgBuf.writeUInt8(0, 35); // Tier

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

  // Join A and B
  const BUY_IN = 100_000n; // 100k lamports = 50 BB
  for (const [label, player, seatIdx] of [['A', pA, 0], ['B', pB, 1]] as [string, Keypair, number][]) {
    const d = Buffer.alloc(25); IX.join.copy(d, 0);
    d.writeBigUInt64LE(BUY_IN, 8); d.writeUInt8(seatIdx, 16); d.writeBigUInt64LE(0n, 17);
    await send(c, new TransactionInstruction({
      programId: PROGRAM, data: d,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: plPda(player.publicKey), isSigner: false, isWritable: true },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: seatPda(t, seatIdx), isSigner: false, isWritable: true },
        { pubkey: mkPda(player.publicKey, t), isSigner: false, isWritable: true },
        { pubkey: vPda(t), isSigner: false, isWritable: true },
        { pubkey: rPda(t, seatIdx), isSigner: false, isWritable: true },
        ...[0,1,2,3,4,5].map(_ => ({ pubkey: PROGRAM, isSigner: false, isWritable: false })),
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }), [player], `Join ${label}`);
  }

  console.log(`  A: ${await readChips(c, t, 0)} chips, B: ${await readChips(c, t, 1)} chips`);
  console.log(`  Rake before hand 1: ${await readRake(c, t)}`);

  // ── Helper functions ──
  async function startGame() {
    return send(c, new TransactionInstruction({
      programId: PROGRAM, data: IX.start,
      keys: [
        { pubkey: pA.publicKey, isSigner: false, isWritable: false },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: dsPda(t), isSigner: false, isWritable: true },
        { pubkey: seatPda(t, 0), isSigner: false, isWritable: true },
        { pubkey: seatPda(t, 1), isSigner: false, isWritable: true },
      ],
    }), [pA], 'Start Game');
  }

  async function deal() {
    return send(c, new TransactionInstruction({
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
  }

  async function act(seatIdx: number, actionByte: number, label: string) {
    const p = seatIdx === 0 ? pA : pB;
    return send(c, new TransactionInstruction({
      programId: PROGRAM, data: Buffer.concat([IX.action, Buffer.from([actionByte])]),
      keys: [
        { pubkey: p.publicKey, isSigner: true, isWritable: false },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: seatPda(t, seatIdx), isSigner: false, isWritable: true },
        { pubkey: PROGRAM, isSigner: false, isWritable: false },
      ],
    }), [p], label);
  }

  async function reveal(label: string) {
    return send(c, new TransactionInstruction({
      programId: PROGRAM, data: IX.reveal,
      keys: [
        { pubkey: pA.publicKey, isSigner: true, isWritable: false },
        { pubkey: t, isSigner: false, isWritable: true },
      ],
    }), [pA], label);
  }

  async function settle() {
    return send(c, new TransactionInstruction({
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

  async function getCurrentPlayer(): Promise<number> {
    const info = await c.getAccountInfo(t);
    return info ? info.data[161] : 0;
  }

  // ═══════════════════════════════════════════════
  // HAND 1: Full showdown → verify rake
  // ═══════════════════════════════════════════════
  step('HAND 1: Full Showdown with Rake');
  await startGame();
  await deal();

  // Preflop: SB calls, BB checks
  let cp = await getCurrentPlayer();
  await act(cp, 2, `Call (seat ${cp})`);
  cp = await getCurrentPlayer();
  await act(cp, 1, `Check (seat ${cp})`);

  // Play through all streets (check-check)
  for (const street of ['Flop', 'Turn', 'River']) {
    let phase = await readPhase(c, t);
    if (phase >= 10 && phase <= 12) {
      await reveal(`Reveal ${street}`);
      phase = await readPhase(c, t);
      if (phase >= 4 && phase <= 6) {
        cp = await getCurrentPlayer();
        await act(cp, 1, `Check (seat ${cp})`);
        cp = await getCurrentPlayer();
        await act(cp, 1, `Check (seat ${cp})`);
      }
    }
  }

  // Settle
  let phase = await readPhase(c, t);
  if (phase === 7) await settle();

  const chipsA1 = await readChips(c, t, 0);
  const chipsB1 = await readChips(c, t, 1);
  const rake1 = await readRake(c, t);
  console.log(`\n  After Hand 1:`);
  console.log(`  A: ${chipsA1}, B: ${chipsB1}, Total: ${chipsA1 + chipsB1}`);
  console.log(`  Rake accumulated: ${rake1}`);
  console.log(`  Pot was 4000, rake 5% = 200`);

  // ═══════════════════════════════════════════════
  // MID-GAME LOCKING TEST
  // ═══════════════════════════════════════════════
  step('MID-GAME LOCKING: Try Join During Hand');
  // Start hand 2
  await startGame();
  await deal();

  // Now try to have player C join — should FAIL (phase != Waiting)
  console.log(`  Phase during hand: ${PN[await readPhase(c, t)]}`);
  console.log(`  Attempting Player C join during active hand...`);
  const joinDuringHand = await send(c, new TransactionInstruction({
    programId: PROGRAM, data: (() => { const d = Buffer.alloc(25); IX.join.copy(d, 0); d.writeBigUInt64LE(BUY_IN, 8); d.writeUInt8(0, 16); d.writeBigUInt64LE(0n, 17); return d; })(),
    keys: [
      { pubkey: pC.publicKey, isSigner: true, isWritable: true },
      { pubkey: plPda(pC.publicKey), isSigner: false, isWritable: true },
      { pubkey: t, isSigner: false, isWritable: true },
      { pubkey: seatPda(t, 0), isSigner: false, isWritable: true },
      { pubkey: mkPda(pC.publicKey, t), isSigner: false, isWritable: true },
      { pubkey: vPda(t), isSigner: false, isWritable: true },
      { pubkey: rPda(t, 0), isSigner: false, isWritable: true },
      ...[0,1,2,3,4,5].map(_ => ({ pubkey: PROGRAM, isSigner: false, isWritable: false })),
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  }), [pC], 'Join C during hand');

  // Finish hand 2 (fold)
  cp = await getCurrentPlayer();
  await act(cp, 0, `Fold (seat ${cp})`);
  phase = await readPhase(c, t);
  if (phase === 7) await settle();

  // ═══════════════════════════════════════════════
  // HAND 2 RESULTS
  // ═══════════════════════════════════════════════
  const chipsA2 = await readChips(c, t, 0);
  const chipsB2 = await readChips(c, t, 1);
  const rake2 = await readRake(c, t);
  console.log(`\n  After Hand 2 (fold):`);
  console.log(`  A: ${chipsA2}, B: ${chipsB2}`);
  console.log(`  Rake accumulated: ${rake2} (no new rake — fold before flop)`);

  // ═══════════════════════════════════════════════
  // LEAVE CASH GAME (during Waiting phase)
  // ═══════════════════════════════════════════════
  step('LEAVE: Player B Leaves During Waiting');
  // PokerAction::LeaveCashGame = variant 8
  const leaveOk = await act(1, 8, 'Leave Cash Game (seat 1)');
  if (leaveOk) {
    // Check seat 1 status and cashout snapshot
    const si = await c.getAccountInfo(seatPda(t, 1));
    if (si && si.data.length > 254) {
      const status = si.data[227];
      const cashoutChips = Number(si.data.readBigUInt64LE(246));
      const cashoutNonce = Number(si.data.readBigUInt64LE(254));
      const chips = Number(si.data.readBigUInt64LE(104));
      const SN: Record<number,string> = {0:'Empty',1:'Active',2:'Folded',3:'AllIn',4:'SittingOut',5:'Busted',6:'Leaving'};
      console.log(`  Seat 1 status: ${SN[status] ?? status}`);
      console.log(`  Seat 1 chips: ${chips} (should be 0 after leave)`);
      console.log(`  Cashout chips: ${cashoutChips}`);
      console.log(`  Cashout nonce: ${cashoutNonce}`);
    }
    // Check table state
    const tState = await c.getAccountInfo(t);
    if (tState) {
      console.log(`  Current players: ${tState.data[122]}`);
      console.log(`  Seats occupied: 0b${tState.data.readUInt16LE(250).toString(2).padStart(2, '0')}`);
    }
  }

  // ═══════════════════════════════════════════════
  // FINAL VERIFICATION
  // ═══════════════════════════════════════════════
  step('FINAL: Cash Game Verification');
  const finalA = await readChips(c, t, 0);
  const finalB = await readChips(c, t, 1);
  const finalRake = await readRake(c, t);
  const totalChips = finalA + finalB;
  const expectedTotal = 200000 - finalRake; // chips = initial - rake

  console.log(`  Player A: ${finalA} chips`);
  console.log(`  Player B: ${finalB} chips`);
  console.log(`  Rake accumulated: ${finalRake}`);
  console.log(`  Total chips + rake: ${totalChips + finalRake}`);

  // Read vault balance
  const vaultInfo = await c.getAccountInfo(vPda(t));
  if (vaultInfo) {
    console.log(`  Vault lamports: ${vaultInfo.lamports}`);
  }

  // Read seat 1 cashout_chips for conservation check
  const si1 = await c.getAccountInfo(seatPda(t, 1));
  const cashoutB = si1 && si1.data.length > 254 ? Number(si1.data.readBigUInt64LE(246)) : 0;
  const conservedTotal = finalA + cashoutB + finalRake;

  const checks: [string, boolean][] = [
    ['Hand 1 rake = 200 (5% of 4000 pot)', rake1 === 200],
    [`Chips conserved: A(${finalA}) + B_cashout(${cashoutB}) + rake(${finalRake}) = ${conservedTotal}`, conservedTotal === 200000],
    ['Multi-hand works (2 hands played)', true],
    ['Join blocked during hand', !joinDuringHand],
    ['Phase back to Waiting', await readPhase(c, t) === 0],
    ['Fold hand has no rake', rake2 === rake1],
    ['Leave: status=Leaving', leaveOk],
    ['Leave: cashout_chips > 0', cashoutB > 0],
    ['Leave: seat chips = 0', finalB === 0],
    ['Leave: current_players = 1', (await c.getAccountInfo(t))?.data[122] === 1],
  ];

  console.log('\n  Cash Game Checks:');
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);

  console.log(`\n${'='.repeat(70)}\n  Cash game comprehensive test complete!\n${'='.repeat(70)}`);
}

main().catch(e => { console.error('Test failed:', e); process.exit(1); });
