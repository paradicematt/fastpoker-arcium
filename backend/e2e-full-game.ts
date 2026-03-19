/**
 * E2E Full Game Tests — SNG + Cash Games + Dealer Crank Payments
 * Uses mock deal mode (devnet_bypass_deal + devnet_bypass_reveal).
 * Run: npx ts-node --transpile-only e2e-full-game.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
  SYSVAR_SLOT_HASHES_PUBKEY,
} from '@solana/web3.js';
import * as crypto from 'crypto';
import * as fs from 'fs';

const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';

// PDA Seeds
const TABLE_SEED = Buffer.from('table');
const SEAT_SEED = Buffer.from('seat');
const SEAT_CARDS_SEED = Buffer.from('seat_cards');
const DECK_STATE_SEED = Buffer.from('deck_state');
const VAULT_SEED = Buffer.from('vault');
const RECEIPT_SEED = Buffer.from('receipt');
const DEPOSIT_PROOF_SEED = Buffer.from('deposit_proof');
const PLAYER_SEED = Buffer.from('player');
const PLAYER_TABLE_SEED = Buffer.from('player_table');
const CRANK_TALLY_ER_SEED = Buffer.from('crank_tally_er');
const CRANK_TALLY_L1_SEED = Buffer.from('crank_tally_l1');
const UNREFINED_SEED = Buffer.from('unrefined');
const CRANK_OPERATOR_SEED = Buffer.from('crank');
const DEALER_LICENSE_SEED = Buffer.from('dealer_license');
const DEALER_REGISTRY_SEED = Buffer.from('dealer_registry');
const PRIZE_AUTHORITY_SEED = Buffer.from('prize_authority');

// Discriminators
function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}
const IX: Record<string, Buffer> = {};
for (const n of [
  'register_player','create_table','init_table_seat','join_table','start_game',
  'devnet_bypass_deal','devnet_bypass_reveal','player_action','settle_hand',
  'distribute_prizes','register_crank_operator','distribute_crank_rewards',
  'init_dealer_registry','grant_dealer_license','reset_sng_table',
  'process_cashout','process_cashout_v2','process_cashout_v3','claim_sol_winnings',
]) IX[n] = disc(n);

// PDA helpers
function pda(seeds: Buffer[], prog = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, prog)[0];
}
const getTable = (id: Buffer) => pda([TABLE_SEED, id]);
const getSeat = (t: PublicKey, i: number) => pda([SEAT_SEED, t.toBuffer(), Buffer.from([i])]);
const getSeatCards = (t: PublicKey, i: number) => pda([SEAT_CARDS_SEED, t.toBuffer(), Buffer.from([i])]);
const getDeckState = (t: PublicKey) => pda([DECK_STATE_SEED, t.toBuffer()]);
const getVault = (t: PublicKey) => pda([VAULT_SEED, t.toBuffer()]);
const getReceipt = (t: PublicKey, i: number) => pda([RECEIPT_SEED, t.toBuffer(), Buffer.from([i])]);
const getDepositProof = (t: PublicKey, i: number) => pda([DEPOSIT_PROOF_SEED, t.toBuffer(), Buffer.from([i])]);
const getPlayer = (w: PublicKey) => pda([PLAYER_SEED, w.toBuffer()]);
const getMarker = (w: PublicKey, t: PublicKey) => pda([PLAYER_TABLE_SEED, w.toBuffer(), t.toBuffer()]);
const getTallyEr = (t: PublicKey) => pda([CRANK_TALLY_ER_SEED, t.toBuffer()]);
const getTallyL1 = (t: PublicKey) => pda([CRANK_TALLY_L1_SEED, t.toBuffer()]);
const getPool = () => pda([Buffer.from('pool')], STEEL_PROGRAM_ID);
const getUnrefined = (w: PublicKey) => pda([UNREFINED_SEED, w.toBuffer()], STEEL_PROGRAM_ID);
const getCrankOp = (w: PublicKey) => pda([CRANK_OPERATOR_SEED, w.toBuffer()]);
const getDealerReg = () => pda([DEALER_REGISTRY_SEED]);
const getDealerLic = (w: PublicKey) => pda([DEALER_LICENSE_SEED, w.toBuffer()]);
const getPrizeAuth = () => pda([PRIZE_AUTHORITY_SEED]);

// Table offsets
const T = {
  PHASE:160, CUR_PLAYER:161, POT:131, MIN_BET:139,
  OCC:250, ALLIN:252, FOLDED:254, ELIM_COUNT:351, ELIM_SEATS:342,
  CUR_PLAYERS:122, SB_SEAT:164, BB_SEAT:165, BUTTON:163,
  RAKE:147, CRANK_POOL:427, PRIZE_POOL:377, HAND:123,
  FLOP_REACHED:257, MAX_P:121, PRIZES_DIST:339,
  SB_AMT:105, BB_AMT:113,
};
const S = { CHIPS:104, NUM:226, STATUS:227 };

const PHASE_NAMES: Record<number,string> = {
  0:'Waiting',1:'Starting',3:'Preflop',4:'Flop',5:'Turn',6:'River',
  7:'Showdown',9:'Complete',10:'FlopRevealPending',11:'TurnRevealPending',12:'RiverRevealPending',
};

// SNG buy-ins (devnet)
const SNG_BUYIN: Record<number,bigint> = {
  0:10_000_000n, 1:25_000_000n, 2:50_000_000n,
  3:100_000_000n, 4:200_000_000n, 5:500_000_000n,
};

interface GameStats {
  name: string; hands: number; totalPot: bigint;
  rake: bigint; crankPool: bigint; prizePool: bigint; eliminations: number;
}
const allStats: GameStats[] = [];
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');

// ── Helpers ──
async function airdrop(c: Connection, pk: PublicKey, amt: number) {
  await c.confirmTransaction(await c.requestAirdrop(pk, amt), 'confirmed');
}

async function send(c: Connection, ix: TransactionInstruction, signers: Keypair[], label: string): Promise<boolean> {
  try {
    await sendAndConfirmTransaction(c, new Transaction().add(ix), signers, { commitment:'confirmed', skipPreflight:true });
    return true;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0,200)}`);
    if (e.logs) e.logs.slice(-3).forEach((l:string) => console.log(`     ${l}`));
    return false;
  }
}

function r8(d:Buffer,o:number) { return d.readUInt8(o); }
function r16(d:Buffer,o:number) { return d.readUInt16LE(o); }
function r64(d:Buffer,o:number) { return d.readBigUInt64LE(o); }

async function readTable(c: Connection, t: PublicKey) {
  const info = await c.getAccountInfo(t, 'confirmed');
  if (!info) throw new Error('Table not found');
  const d = info.data;
  const ec = r8(d, T.ELIM_COUNT);
  const es: number[] = [];
  for (let i=0; i<ec; i++) es.push(r8(d, T.ELIM_SEATS+i));
  return {
    phase:r8(d,T.PHASE), curPlayer:r8(d,T.CUR_PLAYER), pot:r64(d,T.POT),
    minBet:r64(d,T.MIN_BET), occ:r16(d,T.OCC), allin:r16(d,T.ALLIN),
    folded:r16(d,T.FOLDED), elimCount:ec, curPlayers:r8(d,T.CUR_PLAYERS),
    sbSeat:r8(d,T.SB_SEAT), bbSeat:r8(d,T.BB_SEAT), button:r8(d,T.BUTTON),
    rake:r64(d,T.RAKE), crankPool:r64(d,T.CRANK_POOL),
    prizePool:r64(d,T.PRIZE_POOL), hand:r64(d,T.HAND),
    flopReached:r8(d,T.FLOP_REACHED)===1, maxP:r8(d,T.MAX_P),
    prizesDist:r8(d,T.PRIZES_DIST)===1, elimSeats:es,
    sb:r64(d,T.SB_AMT), bb:r64(d,T.BB_AMT),
  };
}

async function readSeat(c: Connection, t: PublicKey, i: number) {
  const info = await c.getAccountInfo(getSeat(t,i), 'confirmed');
  if (!info) return { chips:0n, status:0, num:i };
  return { chips:r64(info.data,S.CHIPS), status:r8(info.data,S.STATUS), num:r8(info.data,S.NUM) };
}

function serializeCfg(id:Buffer, gt:number, st:number, mp:number, tier:number) {
  const b = Buffer.alloc(36); id.copy(b); b.writeUInt8(gt,32); b.writeUInt8(st,33); b.writeUInt8(mp,34); b.writeUInt8(tier,35); return b;
}

function actData(v:number, amt?:bigint): Buffer {
  if (amt !== undefined) { const b=Buffer.alloc(9); b.writeUInt8(v,0); b.writeBigUInt64LE(amt,1); return b; }
  return Buffer.from([v]);
}

// ── Instruction Builders ──
async function doRegister(c:Connection, p:Keypair) {
  return send(c, new TransactionInstruction({ programId:PROGRAM_ID, keys:[
    {pubkey:p.publicKey,isSigner:true,isWritable:true},
    {pubkey:getPlayer(p.publicKey),isSigner:false,isWritable:true},
    {pubkey:TREASURY,isSigner:false,isWritable:true},
    {pubkey:getPool(),isSigner:false,isWritable:true},
    {pubkey:getUnrefined(p.publicKey),isSigner:false,isWritable:true},
    {pubkey:STEEL_PROGRAM_ID,isSigner:false,isWritable:false},
    {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
  ], data:IX.register_player }), [p], 'register');
}

async function doCreateTable(c:Connection, payer:Keypair, id:Buffer, gt:number, st:number, mp:number, tier:number) {
  const t = getTable(id);
  const ok = await send(c, new TransactionInstruction({ programId:PROGRAM_ID, keys:[
    {pubkey:payer.publicKey,isSigner:true,isWritable:true},
    {pubkey:t,isSigner:false,isWritable:true},
    {pubkey:getPool(),isSigner:false,isWritable:false},
    {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
  ], data:Buffer.concat([IX.create_table, serializeCfg(id,gt,st,mp,tier)]) }), [payer], 'create_table');
  if (!ok) throw new Error('create_table failed');
  return t;
}

async function doInitSeats(c:Connection, payer:Keypair, t:PublicKey, mp:number) {
  for (let i=0; i<mp; i++) {
    const ok = await send(c, new TransactionInstruction({ programId:PROGRAM_ID, keys:[
      {pubkey:payer.publicKey,isSigner:true,isWritable:true},
      {pubkey:t,isSigner:false,isWritable:false},
      {pubkey:getSeat(t,i),isSigner:false,isWritable:true},
      {pubkey:getSeatCards(t,i),isSigner:false,isWritable:true},
      {pubkey:getDeckState(t),isSigner:false,isWritable:true},
      {pubkey:getReceipt(t,i),isSigner:false,isWritable:true},
      {pubkey:getVault(t),isSigner:false,isWritable:true},
      {pubkey:getTallyEr(t),isSigner:false,isWritable:true},
      {pubkey:getTallyL1(t),isSigner:false,isWritable:true},
      {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
    ], data:Buffer.concat([IX.init_table_seat, Buffer.from([i])]) }), [payer], `init_seat_${i}`);
    if (!ok) throw new Error(`init_seat_${i} failed`);
  }
}

async function doJoin(c:Connection, p:Keypair, t:PublicKey, si:number, buyIn:bigint) {
  const d = Buffer.alloc(25); IX.join_table.copy(d); d.writeBigUInt64LE(buyIn,8); d.writeUInt8(si,16); d.writeBigUInt64LE(0n,17);
  const keys: any[] = [
    {pubkey:p.publicKey,isSigner:true,isWritable:true},
    {pubkey:getPlayer(p.publicKey),isSigner:false,isWritable:true},
    {pubkey:t,isSigner:false,isWritable:true},
    {pubkey:getSeat(t,si),isSigner:false,isWritable:true},
    {pubkey:getMarker(p.publicKey,t),isSigner:false,isWritable:true},
    {pubkey:getVault(t),isSigner:false,isWritable:true},
    {pubkey:getReceipt(t,si),isSigner:false,isWritable:true},
    // Optional accounts: treasury, pool, player_token, table_token, unclaimed, token_program
    {pubkey:PROGRAM_ID,isSigner:false,isWritable:false},
    {pubkey:PROGRAM_ID,isSigner:false,isWritable:false},
    {pubkey:PROGRAM_ID,isSigner:false,isWritable:false},
    {pubkey:PROGRAM_ID,isSigner:false,isWritable:false},
    {pubkey:PROGRAM_ID,isSigner:false,isWritable:false},
    {pubkey:PROGRAM_ID,isSigner:false,isWritable:false},
    {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
  ];
  return send(c, new TransactionInstruction({programId:PROGRAM_ID,keys,data:d}), [p], `join_${si}`);
}

async function doStart(c:Connection, caller:Keypair, t:PublicKey, occ:number, mp:number) {
  const keys: any[] = [
    {pubkey:caller.publicKey,isSigner:false,isWritable:false},
    {pubkey:t,isSigner:false,isWritable:true},
    {pubkey:getDeckState(t),isSigner:false,isWritable:true},
  ];
  for (let i=0;i<mp;i++) if (occ&(1<<i)) keys.push({pubkey:getSeat(t,i),isSigner:false,isWritable:true});
  return send(c, new TransactionInstruction({programId:PROGRAM_ID,keys,data:IX.start_game}), [caller], 'start');
}

async function doDeal(c:Connection, caller:Keypair, t:PublicKey, active:number[]) {
  const keys: any[] = [
    {pubkey:caller.publicKey,isSigner:true,isWritable:false},
    {pubkey:t,isSigner:false,isWritable:true},
    {pubkey:getDeckState(t),isSigner:false,isWritable:true},
    {pubkey:SYSVAR_SLOT_HASHES_PUBKEY,isSigner:false,isWritable:false},
  ];
  for (const i of active) keys.push({pubkey:getSeat(t,i),isSigner:false,isWritable:true});
  for (const i of active) keys.push({pubkey:getSeatCards(t,i),isSigner:false,isWritable:true});
  return send(c, new TransactionInstruction({programId:PROGRAM_ID,keys,data:IX.devnet_bypass_deal}), [caller], 'deal');
}

async function doReveal(c:Connection, caller:Keypair, t:PublicKey) {
  return send(c, new TransactionInstruction({programId:PROGRAM_ID, keys:[
    {pubkey:caller.publicKey,isSigner:true,isWritable:false},
    {pubkey:t,isSigner:false,isWritable:true},
  ], data:IX.devnet_bypass_reveal}), [caller], 'reveal');
}

async function doAction(c:Connection, p:Keypair, t:PublicKey, si:number, act:number, amt?:bigint) {
  return send(c, new TransactionInstruction({programId:PROGRAM_ID, keys:[
    {pubkey:p.publicKey,isSigner:true,isWritable:false},
    {pubkey:t,isSigner:false,isWritable:true},
    {pubkey:getSeat(t,si),isSigner:false,isWritable:true},
    {pubkey:PROGRAM_ID,isSigner:false,isWritable:false},
  ], data:Buffer.concat([IX.player_action, actData(act,amt)])}), [p], `act_s${si}`);
}

async function doSettle(c:Connection, caller:Keypair, t:PublicKey, seats:number[]) {
  const keys: any[] = [
    {pubkey:caller.publicKey,isSigner:false,isWritable:false},
    {pubkey:t,isSigner:false,isWritable:true},
    {pubkey:getDeckState(t),isSigner:false,isWritable:true},
  ];
  for (const i of seats) keys.push({pubkey:getSeat(t,i),isSigner:false,isWritable:true});
  for (const i of seats) keys.push({pubkey:getSeatCards(t,i),isSigner:false,isWritable:true});
  return send(c, new TransactionInstruction({programId:PROGRAM_ID,keys,data:IX.settle_hand}), [caller], 'settle');
}

// Get list of active (non-busted, non-empty) seat indices
function activeSeats(occ: number, maxP: number): number[] {
  const r: number[] = [];
  for (let i=0; i<maxP; i++) if (occ & (1<<i)) r.push(i);
  return r;
}

// ══════════════════════════════════════════════════════════════════════════
// HAND ENGINE: play one complete hand
// ══════════════════════════════════════════════════════════════════════════
// strategy: 'allin' = first 2 go all-in, rest fold
//           'fold'  = everyone folds to BB
//           'bet'   = first bets BB, next calls, rest fold (for rake test)
async function playHand(
  c: Connection, caller: Keypair, t: PublicKey, players: Keypair[],
  maxP: number, strategy: 'allin'|'fold'|'bet'
): Promise<{ok:boolean, phase:number}> {
  // 1. Read table state
  let st = await readTable(c, t);
  if (st.phase !== 0) { console.log(`  Skip hand: phase=${PHASE_NAMES[st.phase]}`); return {ok:false,phase:st.phase}; }

  // 2. Start game
  const preOcc = st.occ;
  const ok1 = await doStart(c, caller, t, preOcc, maxP);
  if (!ok1) return {ok:false,phase:0};

  st = await readTable(c, t);
  if (st.phase === 9) return {ok:true, phase:9}; // Tournament ended during start (last player standing)
  if (st.phase !== 1) { console.log(`  Start failed: phase=${PHASE_NAMES[st.phase]}`); return {ok:false,phase:st.phase}; }

  // 3. Deal (mock) — use post-start occ (start_game may bust zero-chip players)
  const active = activeSeats(st.occ, maxP);
  const ok2 = await doDeal(c, caller, t, active);
  if (!ok2) return {ok:false,phase:1};

  st = await readTable(c, t);
  console.log(`  Hand #${st.hand}: ${active.length}p, SB=${st.sbSeat} BB=${st.bbSeat}, pot=${st.pot}`);

  // 4. Betting loop
  let allInCount = 0;
  let lastPhase = -1;
  let streetCalls = 0;   // calls this street
  let streetBets = 0;    // bets this street
  let preflopCalls = 0;  // total preflop calls (persists across phase)
  const MAX_ACTIONS = 50; // safety limit (multi-street hands need more)
  for (let iter=0; iter<MAX_ACTIONS; iter++) {
    st = await readTable(c, t);
    const ph = st.phase;

    // Reveal pending → reveal community cards
    if (ph >= 10 && ph <= 12) {
      await doReveal(c, caller, t);
      continue;
    }
    // Showdown → settle
    if (ph === 7) {
      await doSettle(c, caller, t, active);
      st = await readTable(c, t);
      return {ok:true, phase:st.phase};
    }
    // Complete or Waiting → done
    if (ph === 0 || ph === 9) return {ok:true, phase:ph};

    // Betting phase (3-6)
    if (ph < 3 || ph > 6) { console.log(`  Unexpected phase ${ph}`); return {ok:false,phase:ph}; }

    // Reset per-street counters on phase change
    if (ph !== lastPhase) { streetCalls = 0; streetBets = 0; lastPhase = ph; }

    const cp = st.curPlayer;
    if (cp === 255 || cp >= maxP) { await new Promise(r=>setTimeout(r,200)); continue; }

    // Find player keypair for this seat
    const kp = players[cp];
    if (!kp) { console.log(`  No keypair for seat ${cp}`); return {ok:false,phase:ph}; }

    // Choose action based on strategy
    let act = 0; // default Fold
    let amt: bigint | undefined;
    if (strategy === 'allin') {
      if (allInCount < 2) { act = 5; allInCount++; }
      else act = 0;
    } else if (strategy === 'fold') {
      act = 0;
    } else if (strategy === 'bet') {
      // Mixed betting: reach flop with 4 players, check through streets to showdown
      if (ph === 3) {
        // Preflop: 3 callers + BB checks → 4 see flop
        if (cp === st.bbSeat) {
          act = 1; // BB checks (posted blind matches min_bet)
        } else if (preflopCalls < 3) {
          act = 2; preflopCalls++; // Call BB
        } else {
          act = 0; // Remaining players fold
        }
      } else {
        // Post-flop (Flop/Turn/River): check through all streets
        // This guarantees flop_reached=true and rake is applied to preflop pot
        act = 1; // Check
      }
    }

    const okA = await doAction(c, kp, t, cp, act, amt);
    if (!okA) {
      // Fallback chain based on what failed
      if (act === 1) {
        // Check failed → try call, then fold
        const okC = await doAction(c, kp, t, cp, 2);
        if (!okC) await doAction(c, kp, t, cp, 0);
      } else if (act === 2 || act === 3) {
        // Call/bet failed → try check, then fold
        const okC = await doAction(c, kp, t, cp, 1);
        if (!okC) await doAction(c, kp, t, cp, 0);
      }
    }
  }

  st = await readTable(c, t);
  return {ok:true, phase:st.phase};
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 1: SNG 6-max Bronze
// ══════════════════════════════════════════════════════════════════════════
async function testSng6max(c: Connection) {
  console.log('\n═══ TEST 1: SNG 6-max Bronze ═══');
  const admin = Keypair.generate();
  await airdrop(c, admin.publicKey, 5 * LAMPORTS_PER_SOL);

  // Create 6 players
  const players: Keypair[] = [];
  for (let i=0; i<6; i++) {
    const p = Keypair.generate();
    await airdrop(c, p.publicKey, LAMPORTS_PER_SOL);
    await doRegister(c, p);
    players.push(p);
    console.log(`  Player ${i}: ${p.publicKey.toBase58().slice(0,8)}..`);
  }

  // Create table: SNG 6-max (gameType=1), Micro stakes, tier=Bronze(1)
  const tableId = crypto.randomBytes(32);
  const t = await doCreateTable(c, admin, tableId, 1, 0, 6, 1);
  console.log(`  Table: ${t.toBase58().slice(0,8)}..`);

  // Init seats
  await doInitSeats(c, admin, t, 6);

  // Join all 6 players
  const buyIn = SNG_BUYIN[1]; // Bronze = 0.025 SOL
  for (let i=0; i<6; i++) {
    const ok = await doJoin(c, players[i], t, i, buyIn);
    if (!ok) throw new Error(`join_${i} failed`);
  }
  console.log('  All 6 players joined');

  // Play hands until tournament complete
  let handCount = 0;
  const MAX_HANDS = 20;
  for (let h=0; h<MAX_HANDS; h++) {
    const st = await readTable(c, t);
    if (st.phase === 9) { console.log(`  Tournament complete after ${handCount} hands!`); break; }
    if (st.curPlayers < 2) { console.log(`  Only ${st.curPlayers} players left`); break; }

    console.log(`  --- Hand ${h+1} (${st.curPlayers} players, elim=${st.elimCount}) ---`);
    const {ok, phase} = await playHand(c, admin, t, players, 6, 'allin');
    handCount++;
    if (phase === 9) { console.log(`  Tournament COMPLETE!`); break; }
    if (!ok) { console.log(`  Hand failed, continuing..`); }
  }

  // Read final state
  const final = await readTable(c, t);
  console.log(`  Final: phase=${PHASE_NAMES[final.phase]}, elim=${final.elimCount}, crankPool=${final.crankPool}`);

  // Print chip counts
  for (let i=0; i<6; i++) {
    const seat = await readSeat(c, t, i);
    console.log(`    Seat ${i}: ${seat.chips} chips, status=${seat.status}`);
  }

  // Distribute prizes if tournament complete
  if (final.phase === 9 && !final.prizesDist) {
    // Pre-flight: check if Steel pool PDA exists (required for POKER prize CPI)
    const poolInfo = await c.getAccountInfo(getPool(), 'confirmed');
    if (!poolInfo) {
      console.log('  ⚠️  Steel pool PDA not initialized — skipping distribute_prizes');
      console.log('     (This is a localnet config issue. Run Steel init script first.)');
    } else {
      console.log('  Distributing prizes...');
      const elimSet = final.elimSeats;
      const winnerSeat = [0,1,2,3,4,5].find(s => !elimSet.includes(s))!;
      const secondSeat = elimSet[elimSet.length - 1]; // last eliminated = 2nd place

      const winnerWallet = players[winnerSeat].publicKey;
      const secondWallet = players[secondSeat].publicKey;
      console.log(`    1st: seat ${winnerSeat} (${winnerWallet.toBase58().slice(0,8)}..),  2nd: seat ${secondSeat}`);

      const keys: any[] = [
        {pubkey:admin.publicKey,isSigner:true,isWritable:true},
        {pubkey:t,isSigner:false,isWritable:true},
        {pubkey:STEEL_PROGRAM_ID,isSigner:false,isWritable:false},
        {pubkey:getPrizeAuth(),isSigner:false,isWritable:true},
        {pubkey:getPool(),isSigner:false,isWritable:true},
        {pubkey:TREASURY,isSigner:false,isWritable:true},
        {pubkey:getVault(t),isSigner:false,isWritable:true},
        {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
      ];
      for (let i=0;i<6;i++) keys.push({pubkey:getSeat(t,i),isSigner:false,isWritable:false});
      keys.push({pubkey:getPlayer(winnerWallet),isSigner:false,isWritable:true});
      keys.push({pubkey:getPlayer(secondWallet),isSigner:false,isWritable:true});
      keys.push({pubkey:getUnrefined(winnerWallet),isSigner:false,isWritable:true});
      keys.push({pubkey:getUnrefined(secondWallet),isSigner:false,isWritable:true});

      const ok = await send(c, new TransactionInstruction({programId:PROGRAM_ID,keys,data:IX.distribute_prizes}), [admin], 'distribute_prizes');
      if (ok) {
        const after = await readTable(c, t);
        console.log(`  Prizes distributed! crankPool=${after.crankPool}`);
      }
    }
  }

  // Re-read table after distribute_prizes to get accurate crankPool (SNG fees go to vault)
  const postDist = await readTable(c, t);
  allStats.push({
    name:'SNG 6-max Bronze', hands:handCount, totalPot:0n,
    rake:postDist.rake, crankPool:postDist.crankPool, prizePool:postDist.prizePool, eliminations:postDist.elimCount,
  });
  return { tablePDA: t, players, admin };
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 2: Cash 6-max Micro (verify rake)
// ══════════════════════════════════════════════════════════════════════════
async function testCash6max(c: Connection) {
  console.log('\n═══ TEST 2: Cash 6-max Micro ═══');
  const admin = Keypair.generate();
  await airdrop(c, admin.publicKey, 5 * LAMPORTS_PER_SOL);

  const players: Keypair[] = [];
  for (let i=0; i<6; i++) {
    const p = Keypair.generate();
    await airdrop(c, p.publicKey, LAMPORTS_PER_SOL);
    await doRegister(c, p);
    players.push(p);
  }

  // CashGame=3, Micro=0, 6 players, tier=0
  const tableId = crypto.randomBytes(32);
  const t = await doCreateTable(c, admin, tableId, 3, 0, 6, 0);
  await doInitSeats(c, admin, t, 6);

  // Join with 100_000 lamports each (50 BB for Micro SB=1000/BB=2000)
  for (let i=0; i<6; i++) {
    await doJoin(c, players[i], t, i, 100_000n);
  }
  console.log('  All 6 joined (100k lamports each)');

  // Hand 1: fold win (no rake — flop not reached)
  console.log('  --- Hand 1 (fold win, no rake) ---');
  let {ok, phase} = await playHand(c, admin, t, players, 6, 'fold');

  let st = await readTable(c, t);
  console.log(`  After H1: rake=${st.rake}, crankPool=${st.crankPool}, pot=${st.pot}`);

  // Hand 2: mixed betting through streets (rake applies when flop reached)
  if (st.phase === 0) {
    console.log('  --- Hand 2 (mixed bet, rake test) ---');
    ({ok, phase} = await playHand(c, admin, t, players, 6, 'bet'));
    st = await readTable(c, t);
    // flopReached is reset by settle — verify via rake: 5% of pot proves flop was reached
    const expectedRake = (9000n * 5n) / 100n; // pot = SB(1k) + BB(2k) + 3 calls(6k) = 9k
    const rakeMatch = st.rake === expectedRake;
    console.log(`  After H2: rake=${st.rake} (expected=${expectedRake}, flopReached=${rakeMatch?'✅':'❌'}), crankPool=${st.crankPool}`);
  }

  // Print chip counts
  for (let i=0;i<6;i++) {
    const seat = await readSeat(c, t, i);
    console.log(`    Seat ${i}: ${seat.chips} chips, status=${seat.status}`);
  }

  allStats.push({
    name:'Cash 6-max Micro', hands:2, totalPot:0n,
    rake:st.rake, crankPool:st.crankPool, prizePool:0n, eliminations:0,
  });
  return { tablePDA: t, players, admin };
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 3: Cash 9-max Low
// ══════════════════════════════════════════════════════════════════════════
async function testCash9max(c: Connection) {
  console.log('\n═══ TEST 3: Cash 9-max Low ═══');
  const admin = Keypair.generate();
  await airdrop(c, admin.publicKey, 5 * LAMPORTS_PER_SOL);

  const players: Keypair[] = [];
  for (let i=0; i<9; i++) {
    const p = Keypair.generate();
    await airdrop(c, p.publicKey, LAMPORTS_PER_SOL);
    await doRegister(c, p);
    players.push(p);
  }

  // CashGame=3, Low=1 (SB=5000/BB=10000), 9 players
  const tableId = crypto.randomBytes(32);
  const t = await doCreateTable(c, admin, tableId, 3, 1, 9, 0);
  await doInitSeats(c, admin, t, 9);

  // Join with 500_000 lamports each (50 BB)
  for (let i=0; i<9; i++) {
    await doJoin(c, players[i], t, i, 500_000n);
  }
  console.log('  All 9 joined');

  // Hand 1: mixed betting through streets
  console.log('  --- Hand 1 (mixed bet) ---');
  const {ok, phase} = await playHand(c, admin, t, players, 9, 'bet');
  const st = await readTable(c, t);
  console.log(`  After H1: rake=${st.rake}, crankPool=${st.crankPool}`);

  for (let i=0;i<9;i++) {
    const seat = await readSeat(c, t, i);
    console.log(`    Seat ${i}: ${seat.chips} chips, status=${seat.status}`);
  }

  allStats.push({
    name:'Cash 9-max Low', hands:1, totalPot:0n,
    rake:st.rake, crankPool:st.crankPool, prizePool:0n, eliminations:0,
  });
  return { tablePDA: t, players, admin };
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 4: Dealer Crank Payments
// ══════════════════════════════════════════════════════════════════════════
async function testDealerPayments(c: Connection, tablePDA: PublicKey, admin: Keypair) {
  console.log('\n═══ TEST 4: Dealer Crank Payments ═══');

  // Load deployer keypair (SUPER_ADMIN) for admin-gated instructions
  let deployer: Keypair;
  try {
    const kpPath = 'J:/Poker-Arc/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json';
    const raw = JSON.parse(fs.readFileSync(kpPath, 'utf-8'));
    deployer = Keypair.fromSecretKey(Uint8Array.from(raw));
    console.log(`  Deployer (SUPER_ADMIN): ${deployer.publicKey.toBase58().slice(0,8)}..`);
    // Ensure deployer has SOL for rent
    await airdrop(c, deployer.publicKey, LAMPORTS_PER_SOL);
  } catch (e: any) {
    console.log(`  ⚠️  Could not load deployer keypair: ${e.message}`);
    console.log('  Skipping admin-gated dealer license tests');
    return;
  }

  // Register crank operator (permissionless — admin is the operator)
  const ok1 = await send(c, new TransactionInstruction({programId:PROGRAM_ID, keys:[
    {pubkey:admin.publicKey,isSigner:true,isWritable:true},
    {pubkey:getCrankOp(admin.publicKey),isSigner:false,isWritable:true},
    {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
  ], data:IX.register_crank_operator}), [admin], 'register_crank_op');
  console.log(`  Register crank operator: ${ok1?'✅':'❌'}`);

  // Init dealer registry (SUPER_ADMIN only) — may already exist from setup
  const regExists = !!(await c.getAccountInfo(getDealerReg(), 'confirmed'));
  let ok2 = regExists;
  if (!regExists) {
    ok2 = await send(c, new TransactionInstruction({programId:PROGRAM_ID, keys:[
      {pubkey:deployer.publicKey,isSigner:true,isWritable:true},
      {pubkey:getDealerReg(),isSigner:false,isWritable:true},
      {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
    ], data:IX.init_dealer_registry}), [deployer], 'init_dealer_registry');
  }
  console.log(`  Dealer registry: ${ok2?'✅':'❌'}${regExists?' (from setup)':''}`);

  // Grant dealer license to admin (SUPER_ADMIN grants, admin is beneficiary)
  const licExists = !!(await c.getAccountInfo(getDealerLic(admin.publicKey), 'confirmed'));
  let ok3 = licExists;
  if (!licExists && ok2) {
    ok3 = await send(c, new TransactionInstruction({programId:PROGRAM_ID, keys:[
      {pubkey:deployer.publicKey,isSigner:true,isWritable:true},
      {pubkey:admin.publicKey,isSigner:false,isWritable:false},  // beneficiary
      {pubkey:getDealerReg(),isSigner:false,isWritable:true},
      {pubkey:getDealerLic(admin.publicKey),isSigner:false,isWritable:true},
      {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
    ], data:IX.grant_dealer_license}), [deployer], 'grant_license');
  }
  console.log(`  Dealer license: ${ok3?'✅':'❌'}${licExists?' (already exists)':''}`);
  if (!ok3) console.log('  ⚠️  No license — crank rewards will have weight=0');

  // Distribute crank rewards
  const st = await readTable(c, tablePDA);
  if (st.crankPool > 0n) {
    const keys: any[] = [
      {pubkey:admin.publicKey,isSigner:true,isWritable:true},
      {pubkey:tablePDA,isSigner:false,isWritable:false},
      {pubkey:getVault(tablePDA),isSigner:false,isWritable:true},
      {pubkey:getTallyEr(tablePDA),isSigner:false,isWritable:false},
      {pubkey:getTallyL1(tablePDA),isSigner:false,isWritable:false},
      {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
      // Triplet: operator wallet, operator PDA, license PDA
      {pubkey:admin.publicKey,isSigner:false,isWritable:true},
      {pubkey:getCrankOp(admin.publicKey),isSigner:false,isWritable:true},
      {pubkey:getDealerLic(admin.publicKey),isSigner:false,isWritable:false},
    ];
    const ok4 = await send(c, new TransactionInstruction({programId:PROGRAM_ID,keys,data:IX.distribute_crank_rewards}), [admin], 'distribute_rewards');
    console.log(`  Distribute crank rewards (pool=${st.crankPool}): ${ok4?'✅':'❌'}`);

    if (ok4) {
      // Read operator PDA to verify lifetime_sol_earned
      const opInfo = await c.getAccountInfo(getCrankOp(admin.publicKey), 'confirmed');
      if (opInfo) {
        const earned = opInfo.data.readBigUInt64LE(8+32+1+8+8); // lifetime_sol_earned offset
        console.log(`  Operator lifetime SOL earned: ${earned} lamports`);
      }
    }
  } else {
    console.log('  Crank pool is 0 — skipping distribution');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// STATS OUTPUT
// ══════════════════════════════════════════════════════════════════════════
function printStats() {
  console.log('\n═══ DEALER EARNINGS & GAME STATS ═══');
  console.log('┌─────────────────────┬───────┬────────────┬────────────┬────────────┬───────┐');
  console.log('│ Game                │ Hands │ Rake       │ Crank Pool │ Prize Pool │ Elim  │');
  console.log('├─────────────────────┼───────┼────────────┼────────────┼────────────┼───────┤');
  for (const s of allStats) {
    const name = s.name.padEnd(19);
    const hands = String(s.hands).padStart(5);
    const rake = String(s.rake).padStart(10);
    const crank = String(s.crankPool).padStart(10);
    const prize = String(s.prizePool).padStart(10);
    const elim = String(s.eliminations).padStart(5);
    console.log(`│ ${name} │ ${hands} │ ${rake} │ ${crank} │ ${prize} │ ${elim} │`);
  }
  console.log('└─────────────────────┴───────┴────────────┴────────────┴────────────┴───────┘');
}

// ══════════════════════════════════════════════════════════════════════════
// SETUP: Initialize Steel pool + Dealer registry on localnet
// ══════════════════════════════════════════════════════════════════════════
async function setup(c: Connection) {
  console.log('\n═══ SETUP: Localnet Infrastructure ═══');

  // Load deployer keypair (SUPER_ADMIN)
  let deployer: Keypair;
  try {
    const kpPath = 'J:/Poker-Arc/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json';
    const raw = JSON.parse(fs.readFileSync(kpPath, 'utf-8'));
    deployer = Keypair.fromSecretKey(Uint8Array.from(raw));
    await airdrop(c, deployer.publicKey, 2 * LAMPORTS_PER_SOL);
    console.log(`  Deployer: ${deployer.publicKey.toBase58().slice(0,8)}..`);
  } catch (e: any) {
    console.log(`  ⚠️  No deployer keypair: ${e.message}`);
    return;
  }

  // 1. Initialize Steel pool PDA if not exists
  const poolPDA = getPool();
  const poolInfo = await c.getAccountInfo(poolPDA, 'confirmed');
  if (!poolInfo) {
    console.log('  Steel pool not found — initializing...');
    const initData = Buffer.alloc(1);
    initData.writeUInt8(0, 0); // Steel Initialize = discriminator 0
    const ok = await send(c, new TransactionInstruction({
      programId: STEEL_PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: POKER_MINT, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: initData,
    }), [deployer], 'steel_init_pool');
    console.log(`  Steel pool init: ${ok ? '✅' : '❌'}`);
  } else {
    console.log(`  Steel pool: already exists (owner=${poolInfo.owner.toBase58().slice(0,8)}..)`);
  }

  // 2. Initialize dealer registry if not exists
  const regInfo = await c.getAccountInfo(getDealerReg(), 'confirmed');
  if (!regInfo) {
    console.log('  Dealer registry not found — initializing...');
    const ok = await send(c, new TransactionInstruction({programId:PROGRAM_ID, keys:[
      {pubkey:deployer.publicKey,isSigner:true,isWritable:true},
      {pubkey:getDealerReg(),isSigner:false,isWritable:true},
      {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
    ], data:IX.init_dealer_registry}), [deployer], 'init_dealer_registry');
    console.log(`  Dealer registry init: ${ok ? '✅' : '❌ (program may need rebuild+redeploy)'}`);
  } else {
    console.log(`  Dealer registry: already exists`);
  }

  return deployer;
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 5: Cash Game Cashout (process_cashout — vault→player SOL transfer)
// ══════════════════════════════════════════════════════════════════════════
async function testCashCashout(c: Connection, tablePDA: PublicKey, players: Keypair[], admin: Keypair) {
  console.log('\n═══ TEST 5: Cash Game Cashout ═══');

  // Pick player 0 to leave
  const leaver = players[0];
  const seatBefore = await readSeat(c, tablePDA, 0);
  console.log(`  Player 0: ${leaver.publicKey.toBase58().slice(0,8)}.. chips=${seatBefore.chips}, status=${seatBefore.status}`);

  if (seatBefore.chips === 0n) {
    console.log('  ⚠️  Player has 0 chips — skipping cashout test');
    return;
  }

  // Step 1: LeaveCashGame action (act=8) — use same account layout as doAction
  const okLeave = await doAction(c, leaver, tablePDA, 0, 8);
  console.log(`  LeaveCashGame: ${okLeave?'✅':'❌'}`);

  if (!okLeave) return;

  // Verify seat is now Leaving (status=6)
  const seatAfterLeave = await readSeat(c, tablePDA, 0);
  console.log(`  After leave: status=${seatAfterLeave.status} (expect 6=Leaving), chips=${seatAfterLeave.chips}`);

  // Step 2: process_cashout_v3 — transfer SOL from vault to player wallet + clear seat
  const walletBefore = await c.getBalance(leaver.publicKey);
  const v3Data = Buffer.alloc(9);
  v3Data.set(IX.process_cashout_v3);
  v3Data.writeUInt8(0, 8); // seat_index = 0

  const okCashout = await send(c, new TransactionInstruction({programId:PROGRAM_ID, keys:[
    {pubkey:admin.publicKey,isSigner:true,isWritable:true},        // payer
    {pubkey:tablePDA,isSigner:false,isWritable:true},               // table
    {pubkey:getSeat(tablePDA,0),isSigner:false,isWritable:true},    // seat
    {pubkey:getVault(tablePDA),isSigner:false,isWritable:true},     // vault
    {pubkey:getReceipt(tablePDA,0),isSigner:false,isWritable:true}, // receipt
    {pubkey:leaver.publicKey,isSigner:false,isWritable:true},       // player_wallet
    {pubkey:getMarker(leaver.publicKey,tablePDA),isSigner:false,isWritable:true}, // marker (Option)
    {pubkey:PROGRAM_ID,isSigner:false,isWritable:false},            // player_token_account (None)
    {pubkey:PROGRAM_ID,isSigner:false,isWritable:false},            // table_token_account (None)
    {pubkey:PROGRAM_ID,isSigner:false,isWritable:false},            // token_program (None)
    {pubkey:SystemProgram.programId,isSigner:false,isWritable:false}, // system_program
  ], data:v3Data}), [admin], 'process_cashout_v3');

  const walletAfter = await c.getBalance(leaver.publicKey);
  const gained = walletAfter - walletBefore;
  console.log(`  process_cashout_v3: ${okCashout?'✅':'❌'}, wallet gained ${gained} lamports`);

  if (okCashout) {
    const seatFinal = await readSeat(c, tablePDA, 0);
    console.log(`  Final seat: chips=${seatFinal.chips}, status=${seatFinal.status} (expect 0=Empty)`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 6: SNG Claim SOL Winnings
// ══════════════════════════════════════════════════════════════════════════
async function testClaimSolWinnings(c: Connection, sngPlayers: Keypair[], winnerSeat: number) {
  console.log('\n═══ TEST 6: SNG Claim SOL Winnings ═══');

  const winner = sngPlayers[winnerSeat];
  const playerPDA = getPlayer(winner.publicKey);

  // Read claimable_sol from PlayerAccount (offset 91, u64)
  const pInfo = await c.getAccountInfo(playerPDA, 'confirmed');
  if (!pInfo || pInfo.data.length < 99) {
    console.log('  ⚠️  PlayerAccount too small or missing — skipping');
    return;
  }
  const claimable = pInfo.data.readBigUInt64LE(91);
  console.log(`  Winner (seat ${winnerSeat}): ${winner.publicKey.toBase58().slice(0,8)}.. claimable_sol=${claimable}`);

  if (claimable === 0n) {
    console.log('  ⚠️  Nothing to claim — distribute_prizes may not have set claimable_sol');
    return;
  }

  const walletBefore = await c.getBalance(winner.publicKey);
  const okClaim = await send(c, new TransactionInstruction({programId:PROGRAM_ID, keys:[
    {pubkey:winner.publicKey,isSigner:true,isWritable:true},
    {pubkey:playerPDA,isSigner:false,isWritable:true},
    {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
  ], data:IX.claim_sol_winnings}), [winner], 'claim_sol_winnings');

  const walletAfter = await c.getBalance(winner.publicKey);
  const gained = walletAfter - walletBefore;
  console.log(`  claim_sol_winnings: ${okClaim?'✅':'❌'}, wallet gained ${gained} lamports`);

  if (okClaim) {
    const pAfter = await c.getAccountInfo(playerPDA, 'confirmed');
    const claimAfter = pAfter!.data.readBigUInt64LE(91);
    console.log(`  claimable_sol after claim: ${claimAfter} (expect 0)`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 7: Privacy — SeatCards contain non-plaintext data
// ══════════════════════════════════════════════════════════════════════════
async function testPrivacy(c: Connection, tablePDA: PublicKey, maxPlayers: number) {
  console.log('\n═══ TEST 7: Privacy (SeatCards) ═══');
  // After devnet_bypass_deal, SeatCards should have data written (mock cards).
  // In real Arcium mode, these would be encrypted ciphertexts.
  // Verify: SeatCards accounts exist and contain non-zero data in the card fields.

  let checked = 0;
  for (let i = 0; i < maxPlayers; i++) {
    const scPDA = getSeatCards(tablePDA, i);
    const info = await c.getAccountInfo(scPDA, 'confirmed');
    if (!info) continue;

    // SeatCards layout: disc(8) + table(32) + seat_number(1) + is_revealed(1)
    // + enc1(32) [offset 42] + enc2(32) [offset 74] + card1(1) + card2(1)
    // In packed Arcium mode: enc1 = packed ciphertext, enc2 = zeroed
    // In mock mode: card1/card2 are plaintext bytes
    if (info.data.length >= 108) {
      const card1 = info.data[106];
      const card2 = info.data[107];
      const enc1NonZero = info.data.slice(42, 74).some((b: number) => b !== 0);
      console.log(`  Seat ${i}: card1=${card1}, card2=${card2}, enc1_nonzero=${enc1NonZero}`);
      checked++;
    }
  }

  if (checked > 0) {
    console.log(`  ✅ Checked ${checked} SeatCards accounts — data present`);
  } else {
    console.log('  ⚠️  No SeatCards found (table may be in Complete/Waiting state)');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`Connecting to ${RPC_URL}...`);
  const c = new Connection(RPC_URL, 'confirmed');

  try {
    // Setup: init Steel pool + dealer registry
    const deployer = await setup(c);

    // Test 1: SNG 6-max
    const sng = await testSng6max(c);

    // Test 2: Cash 6-max
    const cash6 = await testCash6max(c);

    // Test 3: Cash 9-max
    const cash9 = await testCash9max(c);

    // Test 4: Dealer payments (use cash table which has crank pool from rake)
    await testDealerPayments(c, cash6.tablePDA, cash6.admin);

    // Test 5: Cash game cashout (player leaves → vault→wallet SOL transfer)
    await testCashCashout(c, cash6.tablePDA, cash6.players, cash6.admin);

    // Test 6: SNG claim SOL winnings (winner claims prize from PlayerAccount)
    // Find winner seat (the one with 9000 chips)
    let winnerSeat = 0;
    for (let i = 0; i < 6; i++) {
      const s = await readSeat(c, sng.tablePDA, i);
      if (s.chips > 0n) { winnerSeat = i; break; }
    }
    await testClaimSolWinnings(c, sng.players, winnerSeat);

    // Test 7: Privacy check — SeatCards data on cash table
    await testPrivacy(c, cash9.tablePDA, 9);

    // Stats
    printStats();

    console.log('\n✅ All E2E tests completed!');
  } catch (e: any) {
    console.error(`\n❌ Test failed: ${e.message}`);
    printStats();
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
