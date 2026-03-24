'use client';

import { useEffect, useState, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { L1_RPC_DIRECT, POKER_MINT } from '@/lib/constants';
import { getPlayerPda, getSeatPda } from '@/lib/pda';
import { useSession } from '@/hooks/useSession';
import {
  buildPlayerActionInstruction, ActionType, TABLE_OFFSETS,
  buildStartGameInstruction, buildCrankRemovePlayerInstruction,
  buildJoinTableInstruction,
  buildLeaveTableInstruction,
} from '@/lib/onchain-game';

// ─── Constants ───
const DISC = {
  register: Buffer.from([242, 146, 194, 234, 234, 145, 228, 42]),
};
const PHASE_NAMES = ['Waiting','Starting','Preflop','Flop','Turn','River','Showdown','Complete',
  'FlopReveal','TurnReveal','RiverReveal'];
const STATUS_NAMES = ['Empty','Active','Folded','AllIn','SitOut','Busted','Leaving'];
const GAME_TYPES: Record<number, string> = { 0: 'HU SNG', 1: '6-Max SNG', 2: '9-Max SNG', 3: 'Cash' };
const CARD_NAMES = ['2c','3c','4c','5c','6c','7c','8c','9c','Tc','Jc','Qc','Kc','Ac',
  '2d','3d','4d','5d','6d','7d','8d','9d','Td','Jd','Qd','Kd','Ad',
  '2h','3h','4h','5h','6h','7h','8h','9h','Th','Jh','Qh','Kh','Ah',
  '2s','3s','4s','5s','6s','7s','8s','9s','Ts','Js','Qs','Ks','As'];
const fmtCard = (c: number) => c < 52 ? CARD_NAMES[c] : '??';
const short = (s: string) => s.length > 16 ? s.slice(0, 8) + '..' + s.slice(-4) : s;

type LogEntry = { time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string };

// ─── Seat offsets (matching crank-service.ts byte layout) ───
// disc(8)+wallet(32)+session(32)+table(32)+chips(8)+bet(8)+total_bet(8)+encrypted_cards(64)+commit_hash(32)+hole_cards(2)+seat_num(1)=status@227
const SEAT_OFF = { WALLET: 8, CHIPS: 104, BET: 112, CARDS: 224, STATUS: 227 };
// Extended offsets for crank debug
const SEAT_EXT = {
  SIT_OUT_COUNT: 240,
  HANDS_SINCE_BUST: 241,
  CASHOUT_CHIPS: 246,
  CASHOUT_NONCE: 254,
  SIT_OUT_TIMESTAMP: 270,
};

interface TableState {
  phase: number; phaseName: string; handNumber: number; currentPlayers: number;
  maxPlayers: number; gameType: number; pot: number; minBet: number;
  currentPlayer: number; board: number[]; seatsOccupied: number;
  isDelegated: boolean; buyInChips: number;
}

interface SeatState {
  index: number; status: number; statusName: string;
  wallet: string; chips: number; bet: number; cards: number[]; handRank: number;
  // Crank debug fields
  sitOutCount: number; handsSinceBust: number;
  cashoutChips: number; cashoutNonce: number; sitOutTimestamp: number;
}

function parseTableState(data: Buffer): TableState {
  const O = TABLE_OFFSETS;
  return {
    phase: data[O.PHASE],
    phaseName: PHASE_NAMES[data[O.PHASE]] || `Unknown(${data[O.PHASE]})`,
    handNumber: Number(data.readBigUInt64LE(O.HAND_NUMBER)),
    currentPlayers: data[O.CURRENT_PLAYERS],
    maxPlayers: data[O.MAX_PLAYERS],
    gameType: data[O.GAME_TYPE],
    pot: Number(data.readBigUInt64LE(O.POT)),
    minBet: Number(data.readBigUInt64LE(O.MIN_BET)),
    currentPlayer: data[O.CURRENT_PLAYER],
    board: Array.from(data.slice(O.COMMUNITY_CARDS, O.COMMUNITY_CARDS + 5)),
    seatsOccupied: data.readUInt16LE(O.SEATS_OCCUPIED),
    isDelegated: data[O.IS_DELEGATED] !== 0,
    buyInChips: data.length >= O.ENTRY_AMOUNT + 8 ? Number(data.readBigUInt64LE(O.ENTRY_AMOUNT)) : 0,
  };
}

function parseSeat(data: Buffer, index: number): SeatState {
  const len = data.length;
  const status = len > SEAT_OFF.STATUS ? data[SEAT_OFF.STATUS] : 0;
  return {
    index, status, statusName: STATUS_NAMES[status] || `Unknown(${status})`,
    wallet: len >= SEAT_OFF.WALLET + 32 ? new PublicKey(data.slice(SEAT_OFF.WALLET, SEAT_OFF.WALLET + 32)).toBase58() : '',
    chips: len >= SEAT_OFF.CHIPS + 8 ? Number(data.readBigUInt64LE(SEAT_OFF.CHIPS)) : 0,
    bet: len >= SEAT_OFF.BET + 8 ? Number(data.readBigUInt64LE(SEAT_OFF.BET)) : 0,
    cards: len >= SEAT_OFF.CARDS + 2 ? [data[SEAT_OFF.CARDS], data[SEAT_OFF.CARDS + 1]] : [255, 255],
    handRank: 0,
    sitOutCount: len > SEAT_EXT.SIT_OUT_COUNT ? data[SEAT_EXT.SIT_OUT_COUNT] : 0,
    handsSinceBust: len > SEAT_EXT.HANDS_SINCE_BUST ? data[SEAT_EXT.HANDS_SINCE_BUST] : 0,
    cashoutChips: len >= SEAT_EXT.CASHOUT_CHIPS + 8 ? Number(data.readBigUInt64LE(SEAT_EXT.CASHOUT_CHIPS)) : 0,
    cashoutNonce: len >= SEAT_EXT.CASHOUT_NONCE + 8 ? Number(data.readBigUInt64LE(SEAT_EXT.CASHOUT_NONCE)) : 0,
    sitOutTimestamp: len >= SEAT_EXT.SIT_OUT_TIMESTAMP + 8 ? Number(data.readBigInt64LE(SEAT_EXT.SIT_OUT_TIMESTAMP)) : 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

function TestConsole() {
  const { connected, publicKey, sendTransaction } = useWallet();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tablePda, setTablePda] = useState('');
  const [tableState, setTableState] = useState<TableState | null>(null);
  const [seats, setSeats] = useState<SeatState[]>([]);
  const sessionCtx = useSession();
  const [autoRefresh, setAutoRefresh] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const log = useCallback((level: LogEntry['level'], msg: string) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs(prev => [...prev.slice(-500), { time, level, msg }]);
  }, []);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs]);

  const l1 = useCallback(() => new Connection(L1_RPC_DIRECT, 'confirmed'), []);
  const er = useCallback(() => new Connection(L1_RPC_DIRECT, 'confirmed'), []);

  // ─── ACCOUNT CHECKS ───

  const checkAccount = useCallback(async () => {
    if (!publicKey) return;
    log('info', '── Account Status ──');
    const c = l1();

    // Player PDA
    const [playerPda] = getPlayerPda(publicKey);
    const playerInfo = await c.getAccountInfo(playerPda);
    if (playerInfo) {
      const hands = Number(playerInfo.data.readBigUInt64LE(42));
      const tourns = playerInfo.data.readUInt32LE(74);
      log('ok', `Player: ${short(playerPda.toBase58())} | hands=${hands} tourneys=${tourns}`);
    } else {
      log('warn', `Player: NOT REGISTERED (${short(playerPda.toBase58())})`);
    }

    // Gum-SDK Session
    if (sessionCtx.session.status === 'active' && sessionCtx.session.sessionKey) {
      const bal = (sessionCtx.session.balance / 1e9).toFixed(4);
      const txLeft = Math.floor(sessionCtx.session.balance / 5000);
      log('ok', `Session: ${short(sessionCtx.session.sessionKey.publicKey.toBase58())} | ${sessionCtx.session.status} | ${bal} SOL (~${txLeft} txs)`);
    } else {
      log('warn', `Session: ${sessionCtx.session.status || 'NONE'}`);
    }

    // Balances
    const solBal = await c.getBalance(publicKey);
    log('info', `SOL: ${(solBal / 1e9).toFixed(4)}`);
    try {
      const ata = await getAssociatedTokenAddress(POKER_MINT, publicKey);
      const acct = await getAccount(c, ata);
      log('info', `POKER: ${Number(acct.amount) / 1e9}`);
    } catch { log('info', 'POKER: 0 (no ATA)'); }
  }, [publicKey, l1, log, sessionCtx]);

  const registerPlayer = useCallback(async () => {
    if (!publicKey || !sendTransaction) return;
    const c = l1();
    const [playerPda] = getPlayerPda(publicKey);
    const existing = await c.getAccountInfo(playerPda);
    if (existing) { log('warn', 'Already registered'); return; }
    log('info', 'Registering...');
    try {
      const resp = await fetch('/api/registration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: publicKey.toBase58() }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Registration failed');
      log('ok', `Registered! ${data.signature ? 'Sig: ' + short(data.signature) : ''}`);
    } catch (e: any) {
      log('err', `Register: ${e.message?.slice(0, 120)}`);
    }
  }, [publicKey, sendTransaction, l1, log]);

  const createSession = useCallback(async () => {
    if (!publicKey) return;
    log('info', 'Creating gum-sdk session...');
    try {
      await sessionCtx.createSession();
      log('ok', `Session created: ${sessionCtx.session.sessionKey ? short(sessionCtx.session.sessionKey.publicKey.toBase58()) : 'pending'}`);
    } catch (e: any) {
      log('err', `Session: ${e.message?.slice(0, 100)}`);
    }
  }, [publicKey, sessionCtx, log]);

  // ─── TABLE INSPECTOR ───

  const readTableState = useCallback(async (pda?: string): Promise<TableState | null> => {
    const addr = pda || tablePda;
    if (!addr) { log('warn', 'Enter a table PDA'); return null; }
    try {
      const pubkey = new PublicKey(addr);
      // Try TEE first (delegated tables), fallback to L1
      let data: Buffer | null = null;
      try {
        const teeInfo = await er().getAccountInfo(pubkey);
        if (teeInfo) data = Buffer.from(teeInfo.data);
      } catch {}
      if (!data) {
        const l1Info = await l1().getAccountInfo(pubkey);
        if (!l1Info) { log('err', 'Table not found on TEE or L1'); return null; }
        data = Buffer.from(l1Info.data);
      }
      if (data.length < 200) { log('err', `Table data too small: ${data.length} bytes`); return null; }

      const state = parseTableState(data);
      setTableState(state);

      // Read seats
      const seatResults: SeatState[] = [];
      const conn = er();
      for (let i = 0; i < state.maxPlayers; i++) {
        const [seatPda] = getSeatPda(pubkey, i);
        try {
          let seatInfo = await conn.getAccountInfo(seatPda);
          if (!seatInfo) seatInfo = await l1().getAccountInfo(seatPda);
          if (seatInfo && seatInfo.data.length >= 80) {
            seatResults.push(parseSeat(Buffer.from(seatInfo.data), i));
          }
        } catch {}
      }
      setSeats(seatResults);
      return state;
    } catch (e: any) {
      log('err', `Read table: ${e.message?.slice(0, 100)}`);
      return null;
    }
  }, [tablePda, er, l1, log]);

  const inspectTable = useCallback(async () => {
    log('info', `── Reading ${short(tablePda)} ──`);
    const state = await readTableState();
    if (!state) return;

    log('ok', `Phase: ${state.phaseName} | Hand #${state.handNumber} | Players: ${state.currentPlayers}/${state.maxPlayers}`);
    log('info', `Type: ${GAME_TYPES[state.gameType] || state.gameType} | Pot: ${state.pot} | MinBet: ${state.minBet} | Turn: Seat ${state.currentPlayer}`);
    const board = state.board.filter(c => c < 52).map(fmtCard).join(' ');
    if (board) log('info', `Board: ${board}`);
    log('info', `Delegated: ${state.isDelegated} | BuyIn: ${state.buyInChips} | OccMask: ${state.seatsOccupied.toString(2).padStart(state.maxPlayers, '0')}`);

    for (const s of seats) {
      if (s.status === 0) continue;
      const cards = s.cards.filter(c => c < 52).map(fmtCard).join(' ') || '--';
      log(s.status === 1 ? 'ok' : 'warn',
        `  Seat ${s.index}: ${s.statusName} | ${short(s.wallet)} | chips=${s.chips} bet=${s.bet} cards=[${cards}]`);
    }
  }, [tablePda, readTableState, seats, log]);

  // ─── Auto-refresh ───
  useEffect(() => {
    if (!autoRefresh || !tablePda) return;
    const id = setInterval(() => { readTableState(); }, 3000);
    return () => clearInterval(id);
  }, [autoRefresh, tablePda, readTableState]);

  // ─── GAME ACTIONS (via session key on ER) ───

  const doAction = useCallback(async (action: number, amount?: number) => {
    const actionNames = ['FOLD','CHECK','CALL','BET','RAISE','ALL_IN'];
    if (!tablePda) { log('err', 'No table'); return; }
    const state = await readTableState();
    if (!state) return;

    // Find which seat is ours
    const mySeat = seats.find(s =>
      s.wallet === publicKey?.toBase58() && s.status > 0 && s.status !== 5
    );
    if (!mySeat) { log('err', 'You are not seated at this table'); return; }

    if (state.currentPlayer !== mySeat.index) {
      log('warn', `Not your turn (current=Seat ${state.currentPlayer}, you=Seat ${mySeat.index})`);
      return;
    }

    log('info', `${actionNames[action] || 'ACTION'} (seat ${mySeat.index}${amount ? `, amount=${amount}` : ''})`);

    try {
      const sk = sessionCtx.session.sessionKey;
      // Try session key first (gasless on ER)
      if (sk) {
        const tablePubkey = new PublicKey(tablePda);
        const ix = buildPlayerActionInstruction(
          sk.publicKey, tablePubkey, mySeat.index,
          action as ActionType, amount || 0
        );
        const tx = new Transaction().add(ix);
        const conn = er();
        tx.feePayer = sk.publicKey;
        tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
        tx.sign(sk);
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        log('ok', `Sent via session key: ${short(sig)}`);
      } else {
        // Fallback: API route
        const resp = await fetch('/api/sitngos/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table: tablePda, seatIndex: mySeat.index, action, amount: amount || 0 }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Action failed');
        log('ok', `Action sent: ${short(data.signature || 'ok')}`);
      }

      // Re-read state after action
      await new Promise(r => setTimeout(r, 1500));
      await readTableState();
    } catch (e: any) {
      log('err', `Action failed: ${e.message?.slice(0, 120)}`);
    }
  }, [tablePda, readTableState, seats, publicKey, sessionCtx, er, log]);

  // ─── QUICK START (via API) ───

  const quickStart = useCallback(async () => {
    log('info', '══ QUICK START ══');
    try {
      const resp = await fetch('/api/sitngos/quick-start', { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Quick start failed');
      log('ok', `Table created: ${data.table || data.tablePda || 'unknown'}`);
      if (data.table || data.tablePda) {
        setTablePda(data.table || data.tablePda);
      }
      // Log game state after short delay
      await new Promise(r => setTimeout(r, 2000));
      await readTableState(data.table || data.tablePda);
    } catch (e: any) {
      log('err', `Quick start: ${e.message?.slice(0, 120)}`);
    }
  }, [log, readTableState]);

  const settleHand = useCallback(async () => {
    if (!tablePda) { log('warn', 'No table'); return; }
    log('info', '══ SETTLE HAND ══');
    try {
      const resp = await fetch('/api/sitngos/settle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: tablePda }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Settle failed');
      log('ok', `Settled: ${JSON.stringify(data).slice(0, 100)}`);
      await new Promise(r => setTimeout(r, 1500));
      await readTableState();
    } catch (e: any) {
      log('err', `Settle: ${e.message?.slice(0, 120)}`);
    }
  }, [tablePda, log, readTableState]);

  const nextHand = useCallback(async () => {
    if (!tablePda) { log('warn', 'No table'); return; }
    log('info', '══ NEXT HAND ══');
    try {
      const resp = await fetch('/api/sitngos/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: tablePda }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Next hand failed');
      log('ok', `Started: ${JSON.stringify(data).slice(0, 100)}`);
      await new Promise(r => setTimeout(r, 2000));
      await readTableState();
    } catch (e: any) {
      log('err', `Next hand: ${e.message?.slice(0, 120)}`);
    }
  }, [tablePda, log, readTableState]);

  // ─── CRANK DEBUG ───

  const [crankInfo, setCrankInfo] = useState<any>(null);

  const fetchCrankStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/admin/status?skipSeats=true');
      const data = await resp.json();
      setCrankInfo(data.crankStatus || null);
      if (data.crankStatus) {
        const cs = data.crankStatus;
        log(cs.status === 'online' ? 'ok' : 'err',
          `Crank: ${cs.status.toUpperCase()} | PID ${cs.pid} | Uptime ${cs.uptime} | Tracked ${cs.tablesTracked} | Processing ${cs.tablesProcessing}`);
        if (cs.recentErrors?.length > 0) {
          log('warn', `  ${cs.recentErrors.length} recent errors:`);
          cs.recentErrors.slice(-5).forEach((e: string) => log('err', `  ${e}`));
        }
      } else {
        log('warn', 'Crank: No heartbeat file found');
      }
    } catch (e: any) {
      log('err', `Crank status: ${e.message?.slice(0, 80)}`);
    }
  }, [log]);

  const crankDiagnose = useCallback(async () => {
    if (!tablePda) { log('warn', 'Load a table first'); return; }
    log('info', '══ CRANK DIAGNOSTICS ══');
    const state = await readTableState();
    if (!state) return;

    const nowUnix = Math.floor(Date.now() / 1000);

    // Diagnose phase
    log('info', `Phase: ${state.phaseName} | GameType: ${GAME_TYPES[state.gameType]} | Players: ${state.currentPlayers}/${state.maxPlayers}`);

    // Check what crank would do
    const isCash = state.gameType === 3;
    const isSNG = state.gameType !== 3;

    if (state.phase === 7) { // Complete
      if (isSNG) {
        log('ok', 'CRANK ACTION: SNG complete → commit_and_undelegate → distribute_prizes → close_table');
      } else {
        log('ok', 'CRANK ACTION: Cash game hand complete → should not reach here (cash stays Waiting)');
      }
    } else if (state.phase === 6) { // Showdown
      log('ok', 'CRANK ACTION: settle_hand (resolve showdown, determine winner)');
    } else if (state.phase === 0) { // Waiting
      // Analyze seats for crank-relevant conditions
      let activeCount = 0;
      let sittingOutCount = 0;
      let leavingCount = 0;
      let bustCount = 0;

      for (const s of seats) {
        if (s.status === 0) continue;
        if (s.status === 1 || s.status === 3) activeCount++; // Active or AllIn
        if (s.status === 4) { // SittingOut
          sittingOutCount++;
          const sitOutSecs = s.sitOutTimestamp > 0 ? nowUnix - s.sitOutTimestamp : 0;
          const timedOut = sitOutSecs >= 300; // 5min
          const bust = s.chips === 0 && s.handsSinceBust >= 3;
          log(timedOut || bust ? 'err' : 'warn',
            `  Seat ${s.index}: SittingOut | chips=${s.chips} | sitOutTime=${sitOutSecs > 0 ? Math.floor(sitOutSecs / 60) + 'm' + (sitOutSecs % 60) + 's' : 'no-ts'} | sitOutCount=${s.sitOutCount} | bustHands=${s.handsSinceBust}${timedOut ? ' ← SHOULD BE KICKED (>5min)' : ''}${bust ? ' ← SHOULD BE KICKED (bust)' : ''}`);
        }
        if (s.status === 5) bustCount++; // Busted
        if (s.status === 6) { // Leaving
          leavingCount++;
          log('warn', `  Seat ${s.index}: LEAVING | cashoutChips=${s.cashoutChips} | cashoutNonce=${s.cashoutNonce} ← NEEDS VAULT CASHOUT`);
        }
      }

      log('info', `  Seat analysis: ${activeCount} active, ${sittingOutCount} sitting-out, ${leavingCount} leaving, ${bustCount} busted`);

      if (leavingCount > 0) {
        log('ok', `CRANK ACTION: process_cashout for ${leavingCount} leaving player(s) → then check if enough players to start`);
      }

      if (isCash && sittingOutCount > 0) {
        log('info', 'CRANK ACTION: sweepCashGameRemovals should kick timed-out/bust sitting-out players');
      }

      if (state.currentPlayers >= 2) {
        if (isSNG && state.handNumber === 0) {
          if (state.currentPlayers === state.maxPlayers) {
            log('ok', 'CRANK ACTION: start_game (SNG first hand, table full)');
          } else {
            log('warn', `WAITING: SNG needs ${state.maxPlayers} players for first hand (has ${state.currentPlayers})`);
          }
        } else {
          log('ok', 'CRANK ACTION: start_game → tee_deal');
        }
      } else {
        log('warn', 'WAITING: Not enough players (<2) to start a hand');
      }

      if (!state.isDelegated && isCash) {
        log('err', 'WARNING: Cash table NOT delegated — ER crank cannot process it. L1 stuck sweep needed.');
      }
    } else if (state.phase >= 2 && state.phase <= 5) { // Preflop-River (betting)
      log('info', `Betting phase (${state.phaseName}) — crank waits for player action or timeout`);
      log('info', `  Current turn: Seat ${state.currentPlayer}`);
    } else if (state.phase === 1) { // Starting
      log('ok', 'CRANK ACTION: tee_deal (game starting, needs TEE deal)');
    } else if (state.phase >= 8) { // Reveal pending
      log('ok', `CRANK ACTION: tee_reveal pending (${state.phaseName})`);
    }

    // Fetch crank status too
    await fetchCrankStatus();
  }, [tablePda, readTableState, seats, fetchCrankStatus, log]);

  // ─── INDEPENDENT CRANK ACTION CALLS ───

  const [seatIdx, setSeatIdx] = useState('0');

  const joinTable = useCallback(async () => {
    if (!publicKey || !sendTransaction || !tablePda) { log('warn', 'Need wallet + table PDA'); return; }
    const idx = parseInt(seatIdx);
    if (isNaN(idx) || idx < 0) { log('warn', 'Invalid seat index'); return; }
    log('info', `── JOIN TABLE seat ${idx} ──`);
    try {
      // Use cash-game seat API for cash games, or build join instruction directly for SNG
      const state = await readTableState();
      if (!state) return;

      if (state.gameType === 3) {
        // Cash game — use API
        const resp = await fetch('/api/cash-game/seat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table: tablePda, seatIndex: idx, wallet: publicKey.toBase58() }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Join failed');
        log('ok', `Cash join initiated: ${JSON.stringify(data).slice(0, 150)}`);
      } else {
        // SNG — build join instruction directly
        const c = l1();
        const tablePubkey = new PublicKey(tablePda);
        const ix = buildJoinTableInstruction(publicKey, tablePubkey, idx, state.buyInChips);
        const tx = new Transaction().add(ix);
        const sig = await sendTransaction(tx, c);
        await c.confirmTransaction(sig, 'confirmed');
        log('ok', `SNG join confirmed: ${short(sig)}`);
      }
      await new Promise(r => setTimeout(r, 2000));
      await readTableState();
    } catch (e: any) {
      log('err', `Join failed: ${e.message?.slice(0, 150)}`);
    }
  }, [publicKey, sendTransaction, tablePda, seatIdx, readTableState, l1, log]);

  const leaveTable = useCallback(async () => {
    if (!publicKey || !sendTransaction || !tablePda) { log('warn', 'Need wallet + table'); return; }
    const idx = parseInt(seatIdx);
    log('info', `── LEAVE TABLE seat ${idx} ──`);
    try {
      const resp = await fetch('/api/cash-game/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: tablePda, seatIndex: idx, wallet: publicKey.toBase58() }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Leave failed');
      log('ok', `Leave: ${JSON.stringify(data).slice(0, 120)}`);
      await new Promise(r => setTimeout(r, 2000));
      await readTableState();
    } catch (e: any) {
      log('err', `Leave failed: ${e.message?.slice(0, 120)}`);
    }
  }, [publicKey, sendTransaction, tablePda, seatIdx, readTableState, log]);

  const crankStartGame = useCallback(async () => {
    if (!publicKey || !sendTransaction || !tablePda) return;
    log('info', '── CRANK: start_game ──');
    try {
      // Try API route first (uses server-side crank payer)
      const resp = await fetch('/api/cash-game/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: tablePda }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        // Fallback: try SNG ready route
        const resp2 = await fetch('/api/sitngos/ready', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table: tablePda }),
        });
        const data2 = await resp2.json();
        if (!resp2.ok) throw new Error(data2.error || data.error || 'Start game failed');
        log('ok', `Start game (SNG): ${JSON.stringify(data2).slice(0, 100)}`);
      } else {
        log('ok', `Start game (cash): ${JSON.stringify(data).slice(0, 100)}`);
      }
      await new Promise(r => setTimeout(r, 2000));
      await readTableState();
    } catch (e: any) {
      log('err', `Start game: ${e.message?.slice(0, 120)}`);
    }
  }, [publicKey, sendTransaction, tablePda, readTableState, log]);

  const crankSettle = useCallback(async () => {
    if (!tablePda) return;
    log('info', '── CRANK: settle_hand ──');
    try {
      const resp = await fetch('/api/sitngos/settle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: tablePda }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Settle failed');
      log('ok', `Settle: ${JSON.stringify(data).slice(0, 100)}`);
      await new Promise(r => setTimeout(r, 1500));
      await readTableState();
    } catch (e: any) {
      log('err', `Settle: ${e.message?.slice(0, 120)}`);
    }
  }, [tablePda, readTableState, log]);

  const crankRemovePlayer = useCallback(async () => {
    if (!publicKey || !sendTransaction || !tablePda) return;
    const idx = parseInt(seatIdx);
    log('info', `── CRANK: remove_player seat ${idx} (permissionless) ──`);
    try {
      const c = er();
      const tablePubkey = new PublicKey(tablePda);
      // Need the player wallet from the seat data
      const targetSeat = seats.find(s => s.index === idx);
      if (!targetSeat || targetSeat.status === 0) { log('err', `Seat ${idx} is empty`); return; }
      const playerWallet = new PublicKey(targetSeat.wallet);
      const ix = buildCrankRemovePlayerInstruction(publicKey, tablePubkey, idx, playerWallet);
      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
      const sig = await sendTransaction(tx, c);
      log('ok', `Remove player TX sent: ${short(sig)}`);
      await new Promise(r => setTimeout(r, 2000));
      await readTableState();
    } catch (e: any) {
      log('err', `Remove player: ${e.message?.slice(0, 150)}`);
    }
  }, [publicKey, sendTransaction, tablePda, seatIdx, readTableState, er, log]);

  const crankTimeout = useCallback(async () => {
    if (!tablePda) return;
    log('info', '── CRANK: handle_timeout ──');
    try {
      // Use action API with timeout action type (action=6 if supported, or fold as surrogate)
      const resp = await fetch('/api/sitngos/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: tablePda, action: 'timeout' }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Timeout failed');
      log('ok', `Timeout: ${JSON.stringify(data).slice(0, 100)}`);
      await new Promise(r => setTimeout(r, 1500));
      await readTableState();
    } catch (e: any) {
      log('err', `Timeout: ${e.message?.slice(0, 120)}`);
    }
  }, [tablePda, readTableState, log]);

  // ─── TABLE LIST (from admin API) ───
  const [tables, setTables] = useState<any[]>([]);

  const loadTables = useCallback(async () => {
    log('info', 'Loading table list...');
    try {
      const resp = await fetch('/api/admin/status?skipSeats=true');
      const data = await resp.json();
      const all = [...(data.tables?.er || []), ...(data.tables?.l1 || [])];
      setTables(all);
      log('ok', `Found ${all.length} tables`);
    } catch (e: any) {
      log('err', `Load tables: ${e.message?.slice(0, 80)}`);
    }
  }, [log]);

  // ─── Auto-load on wallet connect ───
  useEffect(() => {
    if (connected && publicKey) {
      log('ok', `Wallet: ${short(publicKey.toBase58())}`);
    }
  }, [connected, publicKey, log]);

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════

  const levelColor: Record<string, string> = {
    info: 'text-cyan-400', ok: 'text-emerald-400', err: 'text-red-400', warn: 'text-amber-400',
  };
  const levelIcon: Record<string, string> = { info: '◆', ok: '✓', err: '✗', warn: '⚠' };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      {/* ─── Left: Controls ─── */}
      <div className="lg:col-span-4 xl:col-span-3 space-y-3">

        {/* Account */}
        <Panel title="Account">
          <div className="flex gap-1.5">
            <Btn onClick={checkAccount} c="cyan" className="flex-1">Check Status</Btn>
            <Btn onClick={registerPlayer} c="emerald">Register</Btn>
            <Btn onClick={createSession} c="purple">Session</Btn>
          </div>
          {sessionCtx.session.sessionKey && (
            <div className="text-[10px] text-emerald-400/60 font-mono mt-1 truncate">
              Session: {sessionCtx.session.sessionKey.publicKey.toBase58().slice(0, 20)}... ({sessionCtx.session.status})
            </div>
          )}
        </Panel>

        {/* Table Selector */}
        <Panel title="Table Inspector">
          <input
            value={tablePda}
            onChange={e => setTablePda(e.target.value)}
            placeholder="Paste table PDA or pick from list..."
            className="w-full bg-gray-800/60 border border-gray-700/60 rounded-lg px-3 py-2 text-xs font-mono text-gray-300 placeholder:text-gray-600 focus:border-cyan-500/50 focus:outline-none"
          />
          <div className="flex gap-1.5">
            <Btn onClick={inspectTable} c="cyan" className="flex-1">Read State</Btn>
            <Btn onClick={() => setAutoRefresh(!autoRefresh)} c={autoRefresh ? 'red' : 'blue'}>
              {autoRefresh ? 'Stop' : 'Auto'}
            </Btn>
            <Btn onClick={loadTables} c="purple">List</Btn>
          </div>

          {/* Table list dropdown */}
          {tables.length > 0 && (
            <div className="max-h-40 overflow-y-auto space-y-0.5 mt-1 border border-gray-800/50 rounded-lg p-1">
              {tables.map(t => (
                <button
                  key={t.pubkey}
                  onClick={() => { setTablePda(t.pubkey); log('info', `Selected: ${short(t.pubkey)}`); }}
                  className={`w-full text-left px-2 py-1 rounded text-[10px] font-mono transition-colors hover:bg-gray-800/60 ${
                    tablePda === t.pubkey ? 'bg-cyan-500/10 text-cyan-300' : 'text-gray-400'
                  }`}
                >
                  <span className="text-gray-500">{short(t.pubkey)}</span>
                  {' '}
                  <span className={t.currentPlayers > 0 ? 'text-emerald-400' : 'text-gray-600'}>
                    {t.phaseName} {t.currentPlayers}/{t.maxPlayers}
                  </span>
                  {' '}
                  <span className="text-gray-600">{t.gameTypeName}</span>
                </button>
              ))}
            </div>
          )}
        </Panel>

        {/* Live Table State */}
        {tableState && (
          <Panel title={`State: ${tableState.phaseName}`}>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono">
              <Stat label="Phase" value={tableState.phaseName} color="cyan" />
              <Stat label="Hand" value={`#${tableState.handNumber}`} color="gray" />
              <Stat label="Players" value={`${tableState.currentPlayers}/${tableState.maxPlayers}`} color="emerald" />
              <Stat label="Type" value={GAME_TYPES[tableState.gameType] || '?'} color="purple" />
              <Stat label="Pot" value={`${(tableState.pot / 1e9).toFixed(4)} SOL`} color="amber" />
              <Stat label="MinBet" value={`${(tableState.minBet / 1e9).toFixed(4)} SOL`} color="amber" />
              <Stat label="Turn" value={`Seat ${tableState.currentPlayer}`} color="cyan" />
              <Stat label="Delegated" value={tableState.isDelegated ? 'Yes' : 'No'} color={tableState.isDelegated ? 'emerald' : 'red'} />
            </div>
            {/* Board cards */}
            {tableState.board.some(c => c < 52) && (
              <div className="flex gap-1.5 mt-2">
                {tableState.board.map((c, i) => (
                  <div key={i} className={`w-8 h-10 rounded border text-center text-xs font-bold leading-10 ${
                    c < 52 ? 'bg-white/10 border-white/20 text-white' : 'bg-gray-800/40 border-gray-700/30 text-gray-700'
                  }`}>
                    {fmtCard(c)}
                  </div>
                ))}
              </div>
            )}
            {/* Seats */}
            <div className="space-y-1 mt-2">
              {seats.filter(s => s.status > 0).map(s => (
                <div key={s.index} className={`flex items-center gap-2 text-[10px] font-mono px-1.5 py-1 rounded ${
                  tableState.currentPlayer === s.index ? 'bg-cyan-500/10 border border-cyan-500/20' : 'bg-gray-800/30'
                }`}>
                  <span className={`font-bold ${s.status === 1 ? 'text-emerald-400' : s.status === 2 ? 'text-gray-500' : 'text-amber-400'}`}>
                    S{s.index}
                  </span>
                  <span className="text-gray-400">{s.statusName}</span>
                  <span className="text-gray-500 truncate max-w-[80px]">{short(s.wallet)}</span>
                  <span className="text-amber-300 ml-auto">{s.chips}</span>
                  {s.bet > 0 && <span className="text-red-300">bet:{s.bet}</span>}
                  {s.cards.some(c => c < 52) && (
                    <span className="text-white">[{s.cards.filter(c => c < 52).map(fmtCard).join(' ')}]</span>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        )}

        {/* Seat / Join */}
        <Panel title="Seat Management">
          <div className="flex gap-1.5 items-center">
            <span className="text-[10px] text-gray-500 shrink-0">Seat #</span>
            <input
              value={seatIdx}
              onChange={e => setSeatIdx(e.target.value)}
              className="w-12 bg-gray-800/60 border border-gray-700/60 rounded px-2 py-1 text-xs font-mono text-gray-300 text-center focus:border-cyan-500/50 focus:outline-none"
            />
            <Btn onClick={joinTable} c="emerald" className="flex-1">Join</Btn>
            <Btn onClick={leaveTable} c="red" className="flex-1">Leave</Btn>
          </div>
        </Panel>

        {/* Player Actions */}
        <Panel title="Player Actions">
          <div className="grid grid-cols-3 gap-1.5">
            <Btn onClick={() => doAction(0)} c="red">Fold</Btn>
            <Btn onClick={() => doAction(1)} c="blue">Check</Btn>
            <Btn onClick={() => doAction(2)} c="blue">Call</Btn>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Btn onClick={() => doAction(4, 100)} c="amber">Raise 100</Btn>
            <Btn onClick={() => doAction(5)} c="purple">All-In</Btn>
          </div>
        </Panel>

        {/* Crank Actions (Independent) */}
        <Panel title="Crank Actions">
          <div className="grid grid-cols-2 gap-1.5">
            <Btn onClick={crankStartGame} c="emerald">Start Game</Btn>
            <Btn onClick={crankSettle} c="cyan">Settle Hand</Btn>
            <Btn onClick={crankTimeout} c="amber">Handle Timeout</Btn>
            <Btn onClick={crankRemovePlayer} c="red">Remove Player</Btn>
          </div>
          <div className="grid grid-cols-2 gap-1.5 border-t border-gray-800/50 pt-1.5">
            <Btn onClick={settleHand} c="blue">Next Hand</Btn>
            <Btn onClick={quickStart} c="purple">Quick Start</Btn>
          </div>
          <div className="flex gap-1.5 border-t border-gray-800/50 pt-1.5">
            <Btn onClick={crankDiagnose} c="amber" className="flex-1">Diagnose</Btn>
            <Btn onClick={fetchCrankStatus} c="cyan">Status</Btn>
          </div>
          {crankInfo && (
            <div className="flex items-center gap-1.5 mt-1">
              <div className={`w-1.5 h-1.5 rounded-full ${crankInfo.status === 'online' ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'}`} />
              <span className={`text-[9px] font-mono ${crankInfo.status === 'online' ? 'text-emerald-400' : 'text-red-400'}`}>
                {crankInfo.status === 'online' ? 'Online' : 'Offline'} | {crankInfo.uptime} | {crankInfo.tablesTracked} tracked
              </span>
            </div>
          )}
          <div className="text-[8px] text-gray-600">
            Independent calls — does not require crank running.
          </div>
        </Panel>
      </div>

      {/* ─── Right: Log Output ─── */}
      <div className="lg:col-span-8 xl:col-span-9">
        <div className="bg-gray-900/50 border border-gray-800/60 rounded-xl overflow-hidden h-full flex flex-col">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800/40 bg-gray-900/30">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">Output</span>
            <div className="flex gap-2">
              <span className="text-[10px] text-gray-600">{logs.length} entries</span>
              <button onClick={() => setLogs([])} className="text-[10px] font-mono text-gray-600 hover:text-gray-400">
                Clear
              </button>
            </div>
          </div>
          <div className="flex-1 p-3 overflow-y-auto font-mono text-[11px] leading-relaxed space-y-0.5 min-h-[400px] max-h-[calc(100vh-200px)]">
            {logs.length === 0 && <div className="text-gray-600">Connect wallet and run commands...</div>}
            {logs.map((entry, i) => (
              <div key={i} className="flex gap-1.5">
                <span className="text-gray-600 shrink-0 w-[60px]">{entry.time}</span>
                <span className={`${levelColor[entry.level]} shrink-0 w-3`}>{levelIcon[entry.level]}</span>
                <span className={entry.level === 'err' ? 'text-red-300' : 'text-gray-300'}>{entry.msg}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// PAGE WRAPPER (standalone /test route)
// ═══════════════════════════════════════════════════════════════

function TestPageInner() {
  const searchParams = useSearchParams();
  const isEmbed = searchParams.get('embed') === '1';

  return (
    <div className={`min-h-screen bg-gray-950 text-gray-100 ${isEmbed ? 'pt-2' : ''}`}>
      {!isEmbed && (
        <header className="border-b border-cyan-500/20 bg-gray-950/90 backdrop-blur sticky top-0 z-50">
          <div className="max-w-[1600px] mx-auto px-4 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 bg-cyan-500/15 rounded-lg flex items-center justify-center border border-cyan-500/25">
                <span className="text-cyan-400 text-xs font-mono">&gt;_</span>
              </div>
              <h1 className="text-sm font-mono font-bold text-cyan-400 tracking-wide">FAST POKER // Test Console</h1>
            </div>
            <WalletMultiButton />
          </div>
        </header>
      )}
      <div className={`max-w-[1600px] mx-auto ${isEmbed ? 'px-3 py-2' : 'px-4 py-4'}`}>
        <TestConsole />
      </div>
    </div>
  );
}

export default function TestPage() {
  return <Suspense><TestPageInner /></Suspense>;
}

// ═══════════════════════════════════════════════════════════════
// HELPER COMPONENTS
// ═══════════════════════════════════════════════════════════════

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900/40 border border-gray-800/50 rounded-xl p-3 space-y-2">
      <h3 className="text-[10px] font-mono font-bold text-gray-500 uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  );
}

function Btn({ onClick, c, children, className = '' }: {
  onClick: () => void;
  c: 'cyan' | 'emerald' | 'red' | 'blue' | 'amber' | 'purple';
  children: React.ReactNode;
  className?: string;
}) {
  const colors: Record<string, string> = {
    cyan: 'bg-cyan-500/8 border-cyan-500/25 text-cyan-400 hover:bg-cyan-500/15',
    emerald: 'bg-emerald-500/8 border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/15',
    red: 'bg-red-500/8 border-red-500/25 text-red-400 hover:bg-red-500/15',
    blue: 'bg-blue-500/8 border-blue-500/25 text-blue-400 hover:bg-blue-500/15',
    amber: 'bg-amber-500/8 border-amber-500/25 text-amber-400 hover:bg-amber-500/15',
    purple: 'bg-purple-500/8 border-purple-500/25 text-purple-400 hover:bg-purple-500/15',
  };
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-mono font-medium transition-colors ${colors[c]} ${className}`}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  const colorMap: Record<string, string> = {
    cyan: 'text-cyan-400', emerald: 'text-emerald-400', amber: 'text-amber-400',
    purple: 'text-purple-400', red: 'text-red-400', gray: 'text-gray-400',
  };
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className={colorMap[color] || 'text-gray-300'}>{value}</span>
    </div>
  );
}
