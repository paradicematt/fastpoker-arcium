/**
 * Crank Stress Test — Creates multiple tables with various scenarios for the crank to handle.
 *
 * Scenarios:
 *   1. HU cash — players join, start, fold preflop (crank settles)
 *   2. HU cash — players join, start, both idle (crank timeouts + settles)
 *   3. 6-max cash — 3 players join, one leaves mid-hand (crank cashout)
 *   4. HU cash — player leaves between hands (crank cashout in Waiting)
 *   5. Multiple HU tables simultaneously (parallel crank processing)
 *
 * Run while crank is running:
 *   npx ts-node --transpile-only backend/stress-test-crank.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL, SYSVAR_SLOT_HASHES_PUBKEY,
} from '@solana/web3.js';
import * as crypto from 'crypto';
import * as fs from 'fs';

const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const RPC_URL = 'http://127.0.0.1:8899';
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}
const IX = {
  register_player: disc('register_player'),
  create_table: disc('create_table'),
  init_table_seat: disc('init_table_seat'),
  join_table: disc('join_table'),
  player_action: disc('player_action'),
  start_game: disc('start_game'),
  devnet_bypass_deal: disc('devnet_bypass_deal'),
  settle_hand: disc('settle_hand'),
};

function pda(seeds: Buffer[], prog = PROGRAM_ID) { return PublicKey.findProgramAddressSync(seeds, prog)[0]; }
const getTable = (id: Buffer) => pda([Buffer.from('table'), id]);
const getSeat = (t: PublicKey, i: number) => pda([Buffer.from('seat'), t.toBuffer(), Buffer.from([i])]);
const getSeatCards = (t: PublicKey, i: number) => pda([Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])]);
const getDeckState = (t: PublicKey) => pda([Buffer.from('deck_state'), t.toBuffer()]);
const getVault = (t: PublicKey) => pda([Buffer.from('vault'), t.toBuffer()]);
const getReceipt = (t: PublicKey, i: number) => pda([Buffer.from('receipt'), t.toBuffer(), Buffer.from([i])]);
const getPlayer = (w: PublicKey) => pda([Buffer.from('player'), w.toBuffer()]);
const getMarker = (w: PublicKey, t: PublicKey) => pda([Buffer.from('player_table'), w.toBuffer(), t.toBuffer()]);
const getCrankEr = (t: PublicKey) => pda([Buffer.from('crank_tally_er'), t.toBuffer()]);
const getCrankL1 = (t: PublicKey) => pda([Buffer.from('crank_tally_l1'), t.toBuffer()]);
const getPool = () => pda([Buffer.from('pool')], STEEL_PROGRAM_ID);
const getUnrefined = (w: PublicKey) => pda([Buffer.from('unrefined'), w.toBuffer()], STEEL_PROGRAM_ID);

const T = {
  PHASE: 160, CUR_PLAYER: 161, POT: 131, MIN_BET: 139,
  OCC: 250, ALLIN: 252, FOLDED: 254, CUR_PLAYERS: 122, MAX_P: 121,
  HAND: 123, SB_SEAT: 164, BB_SEAT: 165, BUTTON: 163,
};
const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop',
  4: 'Flop', 5: 'Turn', 6: 'River', 7: 'Showdown', 8: 'AwaitingShowdown', 9: 'Complete',
  10: 'FlopRevealPending', 11: 'TurnRevealPending', 12: 'RiverRevealPending',
};

function serializeAction(action: string, amount?: bigint): Buffer {
  switch (action) {
    case 'Fold': return Buffer.from([0]);
    case 'Check': return Buffer.from([1]);
    case 'Call': return Buffer.from([2]);
    case 'Bet': { const b = Buffer.alloc(9); b[0] = 3; b.writeBigUInt64LE(amount || 0n, 1); return b; }
    case 'AllIn': return Buffer.from([5]);
    case 'LeaveCashGame': return Buffer.from([8]);
    case 'SitOut': return Buffer.from([6]);
    default: throw new Error(`Unknown action: ${action}`);
  }
}

async function send(conn: Connection, ix: TransactionInstruction, signers: Keypair[], label: string): Promise<boolean> {
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), signers, { commitment: 'confirmed', skipPreflight: true });
    console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
    return true;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0, 100)}`);
    return false;
  }
}

function readTable(data: Buffer) {
  return {
    phase: data[T.PHASE],
    curPlayer: data[T.CUR_PLAYER],
    pot: Number(data.readBigUInt64LE(T.POT)),
    occ: data.readUInt16LE(T.OCC),
    curP: data[T.CUR_PLAYERS],
    maxP: data[T.MAX_P],
    hand: Number(data.readBigUInt64LE(T.HAND)),
    sbSeat: data[T.SB_SEAT],
    bbSeat: data[T.BB_SEAT],
  };
}

async function ensureRegistered(conn: Connection, kp: Keypair) {
  const playerPda = getPlayer(kp.publicKey);
  const info = await conn.getAccountInfo(playerPda);
  if (info) return;
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: playerPda, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: getPool(), isSigner: false, isWritable: true },
      { pubkey: getUnrefined(kp.publicKey), isSigner: false, isWritable: true },
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX.register_player,
  });
  await send(conn, ix, [kp], `register ${kp.publicKey.toBase58().slice(0, 8)}`);
}

async function createTable(conn: Connection, creator: Keypair, label: string, maxPlayers: number, gameType: number = 3): Promise<PublicKey> {
  const tableId = crypto.randomBytes(32);
  const tablePda = getTable(tableId);
  const pool = getPool();

  // create_table data: disc(8) + cfg(36) where cfg = tableId(32) + gameType(1) + subType(1) + maxPlayers(1) + tier(1)
  const cfg = Buffer.alloc(36);
  tableId.copy(cfg);
  cfg[32] = gameType; // 3=CashGame
  cfg[33] = 0; // subType=Micro
  cfg[34] = maxPlayers;
  cfg[35] = 0; // tier=Micro

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.create_table, cfg]),
  });
  await send(conn, ix, [creator], `create_table ${label}`);

  // Init seats — matches e2e-mock-streets account list
  for (let i = 0; i < maxPlayers; i++) {
    const seatIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: false },
        { pubkey: getSeat(tablePda, i), isSigner: false, isWritable: true },
        { pubkey: getSeatCards(tablePda, i), isSigner: false, isWritable: true },
        { pubkey: getDeckState(tablePda), isSigner: false, isWritable: true },
        { pubkey: getReceipt(tablePda, i), isSigner: false, isWritable: true },
        { pubkey: getVault(tablePda), isSigner: false, isWritable: true },
        { pubkey: getCrankEr(tablePda), isSigner: false, isWritable: true },
        { pubkey: getCrankL1(tablePda), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([IX.init_table_seat, Buffer.from([i])]),
    });
    await send(conn, seatIx, [creator], `init_seat[${i}] ${label}`);
  }

  console.log(`  📋 Table ${label}: ${tablePda.toBase58().slice(0, 12)}... (${maxPlayers}-max, type=${gameType === 3 ? 'Cash' : 'SNG'})`);
  return tablePda;
}

function joinIx(player: PublicKey, tbl: PublicKey, seat: number, buyIn: bigint): TransactionInstruction {
  const d = Buffer.alloc(25);
  IX.join_table.copy(d);
  d.writeBigUInt64LE(buyIn, 8);
  d[16] = seat;
  // reserve = 0
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: getPlayer(player), isSigner: false, isWritable: true },
      { pubkey: tbl, isSigner: false, isWritable: true },
      { pubkey: getSeat(tbl, seat), isSigner: false, isWritable: true },
      { pubkey: getMarker(player, tbl), isSigner: false, isWritable: true },
      { pubkey: getVault(tbl), isSigner: false, isWritable: true },
      { pubkey: getReceipt(tbl, seat), isSigner: false, isWritable: true },
      ...Array(6).fill({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false }),
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: d,
  });
}

function actionIx(player: PublicKey, tbl: PublicKey, seatNum: number, action: string, amount?: bigint): TransactionInstruction {
  const actionBuf = serializeAction(action, amount);
  const d = Buffer.alloc(8 + 1 + actionBuf.length);
  IX.player_action.copy(d);
  d[8] = seatNum;
  actionBuf.copy(d, 9);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: tbl, isSigner: false, isWritable: true },
      { pubkey: getSeat(tbl, seatNum), isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // session_token sentinel
    ],
    data: d,
  });
}

async function waitForPhase(conn: Connection, tbl: PublicKey, targetPhase: number, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await conn.getAccountInfo(tbl);
    if (info) {
      const phase = Buffer.from(info.data)[T.PHASE];
      if (phase === targetPhase) return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  console.log('═'.repeat(60));
  console.log('🃏 CRANK STRESS TEST — Creating scenarios for crank to handle');
  console.log('═'.repeat(60));

  // Load or create players
  const players: Keypair[] = [];
  for (let i = 0; i < 8; i++) {
    const kp = Keypair.generate();
    const sig = await conn.requestAirdrop(kp.publicKey, 100 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    await ensureRegistered(conn, kp);
    players.push(kp);
  }
  console.log(`\n👥 Created ${players.length} funded players\n`);

  const creator = players[0];
  const buyIn = 100000n; // 100k lamports = 100 BB (BB=1000)
  const results: { label: string; table: string; scenario: string }[] = [];

  // ═══════════════════════════════════════════════════════
  // SCENARIO 1: HU — both idle after deal → crank timeouts
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('SCENARIO 1: HU idle — crank should timeout both players');
  console.log('━'.repeat(60));
  {
    const t = await createTable(conn, creator, 'HU-idle', 2);
    await send(conn, joinIx(players[1].publicKey, t, 0, buyIn), [players[1]], 'P1 join');
    await send(conn, joinIx(players[2].publicKey, t, 1, buyIn), [players[2]], 'P2 join');
    results.push({ label: 'HU-idle', table: t.toBase58().slice(0, 12), scenario: 'Both idle → crank timeout + settle' });
    // Crank will: start_game → deal → timeout → settle
  }

  // ═══════════════════════════════════════════════════════
  // SCENARIO 2: HU — one player folds → crank settles
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('SCENARIO 2: HU fold — crank should settle after fold');
  console.log('━'.repeat(60));
  {
    const t = await createTable(conn, creator, 'HU-fold', 2);
    await send(conn, joinIx(players[3].publicKey, t, 0, buyIn), [players[3]], 'P1 join');
    await send(conn, joinIx(players[4].publicKey, t, 1, buyIn), [players[4]], 'P2 join');
    // Wait for crank to start + deal
    console.log('  ⏳ Waiting for crank to start & deal...');
    const dealt = await waitForPhase(conn, t, 3, 60000); // Preflop
    if (dealt) {
      const info = await conn.getAccountInfo(t);
      const s = readTable(Buffer.from(info!.data));
      const cp = s.curPlayer;
      const folder = cp === 0 ? players[3] : players[4];
      await send(conn, actionIx(folder.publicKey, t, cp, 'Fold'), [folder], `P${cp + 1} fold`);
      results.push({ label: 'HU-fold', table: t.toBase58().slice(0, 12), scenario: 'Fold → Showdown → crank settle' });
    } else {
      console.log('  ⚠️  Crank did not deal in time — leaving for crank to handle');
      results.push({ label: 'HU-fold', table: t.toBase58().slice(0, 12), scenario: 'Waiting for crank' });
    }
  }

  // ═══════════════════════════════════════════════════════
  // SCENARIO 3: HU — player leaves in Waiting (cashout)
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('SCENARIO 3: HU leave — crank should cashout leaving player');
  console.log('━'.repeat(60));
  {
    const t = await createTable(conn, creator, 'HU-leave', 2);
    await send(conn, joinIx(players[5].publicKey, t, 0, buyIn), [players[5]], 'P1 join');
    await send(conn, joinIx(players[6].publicKey, t, 1, buyIn), [players[6]], 'P2 join');
    // Wait for crank to start, deal, play through one hand
    console.log('  ⏳ Waiting for crank to handle first hand...');
    // Wait for hand #1 to complete (Waiting with hand >= 1)
    const start = Date.now();
    let settled = false;
    while (Date.now() - start < 90000) {
      const info = await conn.getAccountInfo(t);
      if (info) {
        const s = readTable(Buffer.from(info.data));
        if (s.hand >= 1 && s.phase === 0) { settled = true; break; }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (settled) {
      // Now leave
      await send(conn, actionIx(players[6].publicKey, t, 1, 'LeaveCashGame'), [players[6]], 'P2 leave');
      results.push({ label: 'HU-leave', table: t.toBase58().slice(0, 12), scenario: 'Leave in Waiting → crank cashout V3' });
    } else {
      console.log('  ⚠️  Hand not settled in time');
      results.push({ label: 'HU-leave', table: t.toBase58().slice(0, 12), scenario: 'Still in progress' });
    }
  }

  // ═══════════════════════════════════════════════════════
  // SCENARIO 4: 3 HU tables at once (parallel stress)
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('SCENARIO 4: 3 parallel HU idle tables — crank handles all');
  console.log('━'.repeat(60));
  {
    const tables: PublicKey[] = [];
    // Reuse players by creating tables with different pairs
    for (let i = 0; i < 3; i++) {
      const p1 = Keypair.generate();
      const p2 = Keypair.generate();
      await conn.confirmTransaction(await conn.requestAirdrop(p1.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
      await conn.confirmTransaction(await conn.requestAirdrop(p2.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
      await ensureRegistered(conn, p1);
      await ensureRegistered(conn, p2);

      const t = await createTable(conn, creator, `parallel-${i}`, 2);
      await send(conn, joinIx(p1.publicKey, t, 0, buyIn), [p1], `P1 join T${i}`);
      await send(conn, joinIx(p2.publicKey, t, 1, buyIn), [p2], `P2 join T${i}`);
      tables.push(t);
    }
    for (let i = 0; i < tables.length; i++) {
      results.push({ label: `parallel-${i}`, table: tables[i].toBase58().slice(0, 12), scenario: 'Idle → crank timeout + settle (parallel)' });
    }
  }

  // ═══════════════════════════════════════════════════════
  // SCENARIO 5: 6-max with sit-out player (kick test)
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '━'.repeat(60));
  console.log('SCENARIO 5: 6-max with player sitting out → crank kicks');
  console.log('━'.repeat(60));
  {
    const sixPlayers: Keypair[] = [];
    for (let i = 0; i < 3; i++) {
      const kp = Keypair.generate();
      await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
      await ensureRegistered(conn, kp);
      sixPlayers.push(kp);
    }
    const t = await createTable(conn, creator, '6max-sitout', 6);
    for (let i = 0; i < 3; i++) {
      await send(conn, joinIx(sixPlayers[i].publicKey, t, i, buyIn), [sixPlayers[i]], `P${i + 1} join`);
    }
    // Wait for crank to start + deal
    console.log('  ⏳ Waiting for crank to deal...');
    const dealt = await waitForPhase(conn, t, 3, 60000);
    if (dealt) {
      // Player 2 sits out
      await send(conn, actionIx(sixPlayers[2].publicKey, t, 2, 'SitOut'), [sixPlayers[2]], 'P3 sit-out');
      results.push({ label: '6max-sitout', table: t.toBase58().slice(0, 12), scenario: 'SitOut → crank eventually kicks after orbits' });
    } else {
      results.push({ label: '6max-sitout', table: t.toBase58().slice(0, 12), scenario: 'Waiting for crank to start' });
    }
  }

  // ═══════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('📊 STRESS TEST SCENARIOS CREATED');
  console.log('═'.repeat(60));
  for (const r of results) {
    console.log(`  ${r.label.padEnd(15)} ${r.table}  ${r.scenario}`);
  }
  console.log(`\n  Total: ${results.length} tables — crank should process all autonomously`);
  console.log('  Monitor crank output for timeout/settle/cashout/kick actions\n');

  // Monitor for 60s
  console.log('⏳ Monitoring table states for 60 seconds...\n');
  const allTables = results.map(r => r.table);
  for (let tick = 0; tick < 12; tick++) {
    await new Promise(r => setTimeout(r, 5000));
    const accs = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 437 }] });
    let active = 0;
    let waiting = 0;
    for (const { pubkey, account } of accs) {
      const key = pubkey.toBase58().slice(0, 12);
      if (!allTables.includes(key)) continue;
      const d = Buffer.from(account.data);
      const s = readTable(d);
      const pName = PHASE_NAMES[s.phase] ?? s.phase;
      if (s.phase !== 0) active++;
      else waiting++;
    }
    console.log(`  [${tick * 5 + 5}s] Active: ${active}, Waiting: ${waiting}/${results.length}`);
    if (active === 0 && waiting === results.length) {
      console.log('  ✅ All tables returned to Waiting — crank handled everything!');
      break;
    }
  }

  console.log('\n✅ Stress test complete');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
