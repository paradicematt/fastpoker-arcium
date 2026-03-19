'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useWallet } from '@solana/wallet-adapter-react';
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import Link from 'next/link';
import { L1_RPC, ANCHOR_PROGRAM_ID, TABLE_OFFSETS, POKER_MINT, STEEL_PROGRAM_ID, POOL_PDA, TREASURY } from '@/lib/constants';
import { useOnChainGame } from '@/hooks/useOnChainGame';
import { useSession } from '@/hooks/useSession';
import PokerTable from '@/components/game/PokerTable';
import {
  buildCrankRemovePlayerInstruction,
  buildLeaveTableInstruction,
  buildClaimUnclaimedSolInstruction,
  buildJoinTableInstruction,
  buildSetX25519KeyInstruction,
  getUnclaimedBalancePda,
  getDepositProofPda,
  getSeatPda,
  parseTableState,
  TABLE_OFFSETS as OG_TABLE_OFFSETS,
} from '@/lib/onchain-game';
import { deriveX25519Keypair, getCachedX25519Keypair, getMxeX25519Pubkey, type X25519Keypair } from '@/lib/arcium-keys';
import { useArciumCards } from '@/hooks/useArciumCards';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { getPlayerPda } from '@/lib/pda';
import { setActiveTable, removeActiveGame, addActiveGame } from '@/components/layout/ActiveTableBar';
import { useJoinTable } from '@/hooks/useJoinTable';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const REGISTER_DISCRIMINATOR = Buffer.from([242, 146, 194, 234, 234, 145, 228, 42]);
const INIT_UNREFINED_DISC = Buffer.from([24]);
function getUnrefinedPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('unrefined'), owner.toBuffer()], STEEL_PROGRAM_ID);
}

const SIT_OUT_KICK_TIMEOUT_SECS = 5 * 60;

// ─── Main Component ───

export default function CashGamePage() {
  const params = useParams();
  const router = useRouter();
  const tablePubkey = params.id as string;
  const { publicKey, sendTransaction, signTransaction, signMessage, connected } = useWallet();
  const { session, reloadSession, topUpSession } = useSession();

  // Arcium L1: all game state on L1, no TEE delegation
  const {
    gameState,
    isLoading: gameLoading,
    isConnected: gameConnected,
    sendAction,
    isPendingAction,
    error: gameError,
    refreshState,
  } = useOnChainGame(tablePubkey, session.sessionKey);

  // Cash-game-specific state
  const [actionPending, setActionPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // SNG direct join from table view
  const { joinTable: joinOnChainTable, isPending: isJoiningOnChain } = useJoinTable();

  const handleSngSeatClick = useCallback(async (seatIndex: number) => {
    if (!publicKey || !gameState) return;
    setStatus('Joining table...');
    try {
      const sig = await joinOnChainTable(tablePubkey, seatIndex, gameState.maxPlayers);
      if (sig) {
        addActiveGame({ tablePda: tablePubkey, type: 'sng', label: 'Sit & Go' });
        setStatus(null);
        // Trigger ready flow
        fetch('/api/sitngos/ready', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tablePda: tablePubkey, playerCount: gameState.maxPlayers }),
        }).catch(() => {});
      } else {
        setStatus('Join returned null — you may already be seated.');
      }
    } catch (e: any) {
      const msg = e.message?.toLowerCase() || '';
      if (msg.includes('user rejected') || msg.includes('cancelled')) {
        setStatus(null);
      } else {
        setStatus(`Join error: ${e.message?.slice(0, 80)}`);
      }
    }
  }, [publicKey, gameState, tablePubkey, joinOnChainTable]);
  const [leavingTable, setLeavingTable] = useState(false);
  const [shareTooltip, setShareTooltip] = useState(false);

  // Buy-in modal state
  const [buyInModal, setBuyInModal] = useState<{ seatIndex: number } | null>(null);
  const [buyInBBs, setBuyInBBs] = useState(50);
  const [buyInLoading, setBuyInLoading] = useState(false);

  // Sit-out / auto-post-blinds
  const [autoPostBlinds, setAutoPostBlinds] = useState(true);
  const [sittingOutPending, setSittingOutPending] = useState(false);
  const sittingOutPendingRef = useRef(false);
  const [kickPendingSeat, setKickPendingSeat] = useState<number | null>(null);

  // Rake info (read from L1 directly — these fields aren't in useOnChainGame)
  const [rakeAccum, setRakeAccum] = useState(0);
  const [creatorRake, setCreatorRake] = useState(0);
  const [tokenMint, setTokenMint] = useState(PublicKey.default.toBase58());
  const [isCreator, setIsCreator] = useState(false);
  const [buyInType, setBuyInType] = useState(0); // 0=Normal(20-100BB), 1=Deep(50-250BB)
  const [rakeCap, setRakeCap] = useState(0); // rake cap in token units (0=no cap)
  // Dealer rake is mandatory: 45% creator, 5% dealer, 25% stakers, 25% treasury
  const [unclaimedSol, setUnclaimedSol] = useState(0); // lamports of unclaimed SOL
  const [claimPending, setClaimPending] = useState(false);
  // Tip Jar
  const [tipJarBalance, setTipJarBalance] = useState(0);
  const [tipJarHands, setTipJarHands] = useState(0);
  const [tipJarTotal, setTipJarTotal] = useState(0);
  const [showTipModal, setShowTipModal] = useState(false);
  const [tipAmount, setTipAmount] = useState('0.01');
  const [tipHands, setTipHands] = useState('10');
  const [tipPending, setTipPending] = useState(false);
  const [handHistory, setHandHistory] = useState<{ player: string; action: string; amount?: number; phase: string }[]>([]);
  const [pastHands, setPastHands] = useState<{ player: string; action: string; amount?: number; phase: string }[][]>([]);
  const [viewingPastHand, setViewingPastHand] = useState<number | null>(null);
  const [playerActions, setPlayerActions] = useState<{ seatIndex: number; action: string; timestamp: number }[]>([]);

  // Showdown state tracking — snapshot + hold so cards/results stay visible
  const [showdownHold, setShowdownHold] = useState(false);
  const [showdownPot, setShowdownPot] = useState<number | undefined>();
  const [showdownSnapshot, setShowdownSnapshot] = useState<{
    communityCards: number[];
    players: any[];
    myCards?: [number, number];
  } | null>(null);
  const lastValidCommunityRef = useRef<number[]>([]);
  const showdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPhaseRef = useRef<string | null>(null);
  const lastOnChainRef = useRef<typeof gameState>(null);

  // Arcium card decryption: x25519 keypair + MXE pubkey → Rescue cipher decrypt
  const [x25519Kp, setX25519Kp] = useState<X25519Keypair | null>(null);
  const [mxePubkey, setMxePubkey] = useState<Uint8Array | null>(null);

  // Auto-load cached x25519 keypair + MXE pubkey on mount
  useEffect(() => {
    if (!publicKey) return;
    getCachedX25519Keypair(publicKey.toBase58()).then(kp => {
      if (kp) setX25519Kp(kp);
    }).catch(() => {});
    // MXE pubkey from env var (static per Arcium deployment)
    const envHex = process.env.NEXT_PUBLIC_MXE_X25519_PUBKEY;
    if (envHex && envHex.length === 64) {
      setMxePubkey(Uint8Array.from(envHex.match(/.{2}/g)!.map(b => parseInt(b, 16))));
    }
  }, [publicKey?.toBase58()]);

  // Decrypt encrypted hole cards during active play
  const arciumSeatIndex = gameState?.mySeatIndex ?? null;
  const arciumTablePda = tablePubkey ? (() => { try { return new PublicKey(tablePubkey); } catch { return null; } })() : null;
  const { holeCards: arciumCards } = useArciumCards(
    arciumTablePda,
    arciumSeatIndex !== null && arciumSeatIndex >= 0 ? arciumSeatIndex : null,
    x25519Kp,
    mxePubkey,
  );

  // Track active table in localStorage for the ActiveTableBar component
  useEffect(() => {
    if (gameState && gameState.mySeatIndex >= 0) {
      const isCash = gameState.isCashGame !== false;
      const blindsText = gameState.blinds
        ? isCash
          ? `${(gameState.blinds.small / 1e9).toPrecision(1)}/${(gameState.blinds.big / 1e9).toPrecision(1)}`
          : `${gameState.blinds.small}/${gameState.blinds.big}`
        : '';
      setActiveTable({ tablePda: tablePubkey, blinds: blindsText, maxPlayers: gameState.maxPlayers });
    }
  }, [gameState?.mySeatIndex, tablePubkey]);

  // Clear active table on unmount (navigating away) only if no longer seated
  useEffect(() => {
    return () => {
      // Don't clear immediately — let the bar persist briefly for back-navigation.
      // It will be overwritten when re-entering a game page, or cleared on leave.
    };
  }, []);

  // Fetch rake info separately (not part of useOnChainGame)
  useEffect(() => {
    if (!tablePubkey) return;
    const fetchRake = async () => {
      try {
        const conn = new Connection(L1_RPC, 'confirmed');
        let pda: PublicKey;
        try { pda = new PublicKey(tablePubkey); } catch { return; }
        const acct = await conn.getAccountInfo(pda);
        if (!acct) return;
        const data = Buffer.from(acct.data);
        const O = TABLE_OFFSETS;
        if (data.length >= O.RAKE_ACCUMULATED + 8) setRakeAccum(Number(data.readBigUInt64LE(O.RAKE_ACCUMULATED)));
        if (data.length >= O.CREATOR_RAKE_TOTAL + 8) setCreatorRake(Number(data.readBigUInt64LE(O.CREATOR_RAKE_TOTAL)));
        if (data.length >= O.TOKEN_MINT + 32) setTokenMint(new PublicKey(data.subarray(O.TOKEN_MINT, O.TOKEN_MINT + 32)).toBase58());
        if (data.length > O.BUY_IN_TYPE) setBuyInType(data[O.BUY_IN_TYPE]);
        if (data.length >= O.RAKE_CAP + 8) setRakeCap(Number(data.readBigUInt64LE(O.RAKE_CAP)));
        // dealer rake is mandatory — no crank_rake_enabled flag needed
        if (data.length >= O.CREATOR + 32 && publicKey) {
          const creator = new PublicKey(data.subarray(O.CREATOR, O.CREATOR + 32));
          setIsCreator(creator.equals(publicKey));
        }
        // Check for unclaimed SOL balance
        if (publicKey) {
          try {
            const [unclaimedPda] = getUnclaimedBalancePda(pda, publicKey);
            const unclaimedAcct = await conn.getAccountInfo(unclaimedPda);
            if (unclaimedAcct && unclaimedAcct.data.length >= 80) {
              const ud = Buffer.from(unclaimedAcct.data);
              const amount = Number(ud.readBigUInt64LE(72)); // offset: 8 disc + 32 player + 32 table = 72
              setUnclaimedSol(amount);
            } else {
              setUnclaimedSol(0);
            }
          } catch { setUnclaimedSol(0); }
        }
        // Fetch TipJar PDA
        try {
          const [tipJarPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('tip_jar'), pda.toBuffer()],
            new PublicKey(ANCHOR_PROGRAM_ID),
          );
          const tjAcct = await conn.getAccountInfo(tipJarPda);
          if (tjAcct && tjAcct.data.length >= 67) {
            const tjd = Buffer.from(tjAcct.data);
            setTipJarBalance(Number(tjd.readBigUInt64LE(40))); // balance at offset 8+32=40
            setTipJarHands(tjd.readUInt16LE(48)); // hands_remaining at offset 40+8=48
            setTipJarTotal(Number(tjd.readBigUInt64LE(50))); // total_deposited at 48+2=50
          }
        } catch {}
      } catch (e) {
        console.error('Failed to fetch rake info:', e);
      }
    };
    fetchRake();
    const id = setInterval(fetchRake, 5000);
    return () => clearInterval(id);
  }, [tablePubkey, publicKey]);

  // Track opponent actions + hand history (same logic as SNG page)
  useEffect(() => {
    const prev = lastOnChainRef.current;
    if (!gameState || !prev) {
      lastOnChainRef.current = gameState;
      return;
    }
    const prevPhase = prev.phase;
    const currPhase = gameState.phase;
    const prevPlayer = prev.currentPlayer;
    const currPlayer = gameState.currentPlayer;
    const myIdx = gameState.mySeatIndex;
    const blinds = gameState.blinds;

    // Formatter for hand log — chip values for SNG, lamports→SOL for cash
    const isCash = gameState.isCashGame !== false;
    const fmtVal = (v: number) => {
      if (!isCash) return v.toLocaleString();
      const val = v / 1e9;
      if (val === 0) return '0';
      return parseFloat(val >= 1 ? val.toFixed(4) : val >= 0.001 ? val.toFixed(6) : val.toFixed(9)).toString();
    };

    // New hand detection: Waiting/Complete → Starting/PreFlop
    if ((prevPhase === 'Waiting' || prevPhase === 'Complete') && (currPhase === 'Starting' || currPhase === 'PreFlop')) {
      // Archive previous hand
      setHandHistory(h => {
        if (h.length > 0) setPastHands(past => [...past, h]);
        return [];
      });
      setViewingPastHand(null);
      setPlayerActions([]);
      setShowdownPot(undefined);

      // Log blinds
      const now = Date.now();
      for (const p of gameState.players) {
        if (!p.isActive) continue;
        const label = p.pubkey === publicKey?.toBase58() ? 'You' : (p.pubkey?.slice(0, 6) + '...');
        if (p.bet === blinds.small) {
          setHandHistory(h => [...h, { player: label, action: `SB ${fmtVal(blinds.small)}`, phase: 'PreFlop' }]);
          setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== p.seatIndex), { seatIndex: p.seatIndex, action: `SB ${fmtVal(blinds.small)}`, timestamp: now }]);
        } else if (p.bet === blinds.big) {
          setHandHistory(h => [...h, { player: label, action: `BB ${fmtVal(blinds.big)}`, phase: 'PreFlop' }]);
          setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== p.seatIndex), { seatIndex: p.seatIndex, action: `BB ${fmtVal(blinds.big)}`, timestamp: now + 1 }]);
        }
      }
      lastOnChainRef.current = gameState;
      return;
    }

    // Detect opponent action (current player changed or phase changed)
    if ((prevPlayer !== currPlayer || prevPhase !== currPhase) && prevPlayer !== myIdx && prevPlayer >= 0) {
      const prevOpp = prev.players.find((p: { seatIndex: number }) => p.seatIndex === prevPlayer);
      const currOpp = gameState.players.find((p: { seatIndex: number }) => p.seatIndex === prevPlayer);
      if (prevOpp && currOpp) {
        const label = currOpp.pubkey === publicKey?.toBase58() ? 'You' : (currOpp.pubkey?.slice(0, 6) + '...');
        let action = 'CHECK';
        if (currOpp.folded && !prevOpp.folded) {
          action = 'FOLD';
        } else if (currOpp.chips === 0 && prevOpp.chips > 0) {
          action = `ALL-IN ${fmtVal(currOpp.bet)}`;
        } else if (currOpp.bet > prevOpp.bet) {
          const betDiff = currOpp.bet - prevOpp.bet;
          const prevMaxBet = Math.max(...prev.players.map((p: { bet: number }) => p.bet), 0);
          action = currOpp.bet > prevMaxBet ? `RAISE ${fmtVal(currOpp.bet)}` : `CALL ${fmtVal(betDiff)}`;
        }
        setHandHistory(h => [...h, { player: label, action, phase: prevPhase }]);
        setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== currOpp.seatIndex), { seatIndex: currOpp.seatIndex, action, timestamp: Date.now() }]);
      }
    }

    // Track valid community cards (settle resets them before frontend can read)
    const validComm = (gameState.communityCards || []).filter((c: number) => c !== 255 && c >= 0 && c <= 51);
    if (validComm.length > 0) {
      lastValidCommunityRef.current = [...gameState.communityCards];
    }

    // Showdown/Complete detection — snapshot + hold + hand log
    if ((currPhase === 'Showdown' || currPhase === 'Complete') && prevPhase !== 'Showdown' && prevPhase !== 'Complete') {
      // Compute pot before settle resets it
      const computedPot = gameState.pot || prev.pot || gameState.players.reduce((s: number, p: any) => s + (p.bet || 0), 0);
      if (computedPot > 0) setShowdownPot(computedPot);

      // Snapshot the game state for display hold
      if (!showdownSnapshot) {
        const snapSource = lastOnChainRef.current || gameState;
        const snapshotCommunity = lastValidCommunityRef.current.length > 0
          ? [...lastValidCommunityRef.current]
          : [...(snapSource.communityCards || [])];
        setShowdownSnapshot({
          communityCards: snapshotCommunity,
          players: JSON.parse(JSON.stringify(snapSource.players || [])),
          myCards: snapSource.myCards ? [...snapSource.myCards] as [number, number] : undefined,
        });
      }
      setShowdownHold(true);

      // Hold showdown display so players can see revealed cards and hand names
      if (showdownTimerRef.current) clearTimeout(showdownTimerRef.current);
      const holdMs = currPhase === 'Complete' ? 8000 : 10000;
      showdownTimerRef.current = setTimeout(() => {
        setShowdownHold(false);
        setShowdownPot(undefined);
        setShowdownSnapshot(null);
        lastValidCommunityRef.current = [];
        showdownTimerRef.current = null;
      }, holdMs);

      // Log board + hands + results
      const SUITS = ['s', 'h', 'd', 'c'];
      const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
      const cardStr = (c: number) => c >= 0 && c <= 51 ? `${RANKS[c % 13]}${SUITS[Math.floor(c / 13)]}` : '?';

      const board = (gameState.communityCards || []).filter((c: number) => c !== 255 && c >= 0 && c <= 51);
      if (board.length >= 3) {
        setHandHistory(h => [...h, { player: '', action: `Board: ${board.map(cardStr).join(' ')}`, phase: 'Summary' }]);
      }

      const isFoldWin = gameState.players.filter((p: any) => !p.folded && p.isActive).length <= 1;
      for (const p of gameState.players) {
        if (!p.isActive && !p.folded) continue;
        const isMe = p.pubkey === publicKey?.toBase58();
        const label = isMe ? 'You' : (p.pubkey?.slice(0, 6) + '...');
        const cards = isMe ? gameState.myCards : p.holeCards;
        if (p.folded) {
          setHandHistory(h => [...h, { player: label, action: 'folded', phase: 'Summary' }]);
        } else if (cards && cards[0] !== 255 && cards[1] !== 255) {
          setHandHistory(h => [...h, { player: label, action: `${cardStr(cards[0])} ${cardStr(cards[1])}`, phase: 'Summary' }]);
        } else if (!isFoldWin) {
          setHandHistory(h => [...h, { player: label, action: 'cards hidden', phase: 'Summary' }]);
        }
      }

      // Winner detection
      for (const curr of gameState.players) {
        if (!curr.isActive && !curr.folded) continue;
        const prevP = prev.players.find((p: { pubkey: string }) => p.pubkey === curr.pubkey);
        if (!prevP) continue;
        const chipDelta = curr.chips - prevP.chips;
        if (chipDelta > 0) {
          const label = curr.pubkey === publicKey?.toBase58() ? 'You' : (curr.pubkey?.slice(0, 6) + '...');
          const winType = isFoldWin ? 'WON (fold)' : 'WON';
          setHandHistory(h => [...h, { player: label, action: `${winType} +${fmtVal(chipDelta)}`, phase: 'Result' }]);
        }
      }
    }

    // Re-capture snapshot if showdown hold is active and we get new data with revealed cards
    if (showdownHold && (currPhase === 'Showdown' || currPhase === 'Complete') && showdownSnapshot) {
      // Merge revealed hole cards from live data into snapshot
      const updated = { ...showdownSnapshot };
      let changed = false;
      for (const liveP of gameState.players) {
        if (liveP.holeCards && liveP.holeCards[0] !== 255) {
          const snapP = updated.players.find((sp: any) => sp.pubkey === liveP.pubkey);
          if (snapP && (!snapP.holeCards || snapP.holeCards[0] === 255)) {
            snapP.holeCards = [...liveP.holeCards];
            changed = true;
          }
        }
      }
      if (changed) setShowdownSnapshot(updated);
    }

    // Early release: only if a new hand has ADVANCED past preflop (Flop/Turn/River)
    // Let the timer handle the normal hold duration so players can see showdown results
    if (showdownHold && currPhase && currPhase !== 'Showdown' && currPhase !== 'Waiting' && currPhase !== 'Complete' && currPhase !== 'PreFlop' && currPhase !== 'Starting') {
      setShowdownHold(false);
      setShowdownPot(undefined);
      setShowdownSnapshot(null);
      lastValidCommunityRef.current = [];
      if (showdownTimerRef.current) {
        clearTimeout(showdownTimerRef.current);
        showdownTimerRef.current = null;
      }
    }

    lastOnChainRef.current = gameState;
  }, [gameState, showdownHold]);

  const isSol = tokenMint === PublicKey.default.toBase58();
  const getTokenSymbol = (mint: string) => {
    if (mint === PublicKey.default.toBase58()) return 'SOL';
    if (mint === POKER_MINT.toBase58()) return 'POKER';
    return mint.slice(0, 4) + '...';
  };

  // ─── Auto-start cash game when 2+ players in Waiting ───
  const startingRef = useRef(false);
  const lastStartRef = useRef(0);
  const startFailsRef = useRef(0);

  useEffect(() => {
    if (!tablePubkey || !publicKey || !sendTransaction) return;
    startFailsRef.current = 0; // Reset on phase/player change

    const tryStart = async () => {
      if (!gameState || !publicKey || !sendTransaction) return;
      const phase = gameState.phase;
      const activePlayers = gameState.players?.filter(p => !p.isSittingOut)?.length || 0;
      if (phase !== 'Waiting' || activePlayers < 2) return;
      if (startingRef.current) return;
      if (sittingOutPendingRef.current) return;
      if (startFailsRef.current >= 3) return;
      if (Date.now() - lastStartRef.current < 5000) return;

      startingRef.current = true;
      lastStartRef.current = Date.now();
      console.log(`[CashGame] Auto-starting: ${activePlayers} active players, phase=${phase}`);
      try {
        const conn = new Connection(L1_RPC, 'confirmed');
        const tablePda = new PublicKey(tablePubkey);
        // Build occupied seats bitmask from seated players
        let seatsOccupied = 0;
        for (const p of gameState.players) {
          if (p.seatIndex >= 0 && !p.isSittingOut) seatsOccupied |= (1 << p.seatIndex);
        }
        const { buildStartGameInstruction } = await import('@/lib/onchain-game');
        const ix = buildStartGameInstruction(publicKey, tablePda, gameState.maxPlayers, seatsOccupied);
        const tx = new Transaction().add(ix);
        tx.feePayer = publicKey;
        tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
        const sig = await sendTransaction(tx, conn, { skipPreflight: true });
        await conn.confirmTransaction(sig, 'confirmed');
        console.log('[CashGame] Started!', sig);
        startFailsRef.current = 0;
        refreshState();
      } catch (err: any) {
        console.log('[CashGame] Start failed:', err?.message?.slice(0, 120));
        startFailsRef.current++;
      } finally {
        startingRef.current = false;
      }
    };

    tryStart();
    const interval = setInterval(tryStart, 4000);
    return () => clearInterval(interval);
  }, [gameState?.phase, gameState?.players?.length, gameState?.players?.filter(p => !p.isSittingOut)?.length, tablePubkey, publicKey, sendTransaction]);

  // ─── Actions (gasless via session key, same as SNG) ───

  const handleGameAction = useCallback(async (action: string, amount?: number) => {
    setActionPending(true);
    setStatus(null);
    try {
      await sendAction(action as any, amount);
      // Log own action in hand history
      const isCash = gameState?.isCashGame !== false;
      const fmtAmt = (v: number) => isCash ? parseFloat((v / 1e9).toFixed(6)).toString() : v.toLocaleString();
      const actionLabel = amount ? `${action.toUpperCase()} ${fmtAmt(amount)}` : action.toUpperCase();
      setHandHistory(prev => [...prev, { player: 'You', action: actionLabel, amount, phase: gameState?.phase || 'Unknown' }]);
      setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== (gameState?.mySeatIndex ?? -1)), { seatIndex: gameState?.mySeatIndex ?? -1, action: actionLabel, timestamp: Date.now() }]);
    } catch (e: any) {
      // Auto-extend session if expired
      if (e.message?.includes('Session expired') || e.message?.includes('Reconnecting session') || e.message?.includes('InvalidSessionKey')) {
        setStatus('Session expired — extending...');
        try {
          await topUpSession();
          reloadSession();
          setStatus('Session extended! Retrying...');
          await sendAction(action as any, amount);
          setStatus(null);
        } catch {
          setStatus('Session extend failed. Please recreate session.');
        }
      } else {
        setStatus(`Error: ${e?.message?.slice(0, 80)}`);
      }
    } finally {
      setActionPending(false);
    }
  }, [sendAction, topUpSession, reloadSession]);

  // ─── Join table with buy-in modal ───

  // Buy-in ranges per type: 0=Normal(20-100BB), 1=Deep(50-250BB)
  const buyInMin = buyInType === 1 ? 50 : 20;
  const buyInMax = buyInType === 1 ? 250 : 100;
  const buyInQuickPicks = buyInType === 1 ? [50, 100, 175, 250] : [20, 50, 75, 100];

  const openBuyInModal = async (seatIndex: number) => {
    setBuyInModal({ seatIndex });
    setBuyInBBs(buyInType === 1 ? 100 : 50);
  };

  const confirmBuyIn = async () => {
    if (!publicKey || !sendTransaction || !buyInModal || !gameState) return;
    setBuyInLoading(true);
    setStatus(null);
    try {
      const conn = new Connection(L1_RPC, 'confirmed');
      const tablePda = new PublicKey(tablePubkey);
      const buyIn = BigInt(gameState.blinds.big) * BigInt(buyInBBs);

      // Arcium L1: direct join_cash_game on L1 — no deposit/delegation flow
      setStatus('Joining table...');
      const tx = new Transaction();

      // Auto-register if PlayerAccount PDA doesn't exist
      const [playerPda] = getPlayerPda(publicKey);
      const [unrefinedPda] = getUnrefinedPda(publicKey);
      const [playerInfo, unrefinedInfo] = await Promise.all([
        conn.getAccountInfo(playerPda),
        conn.getAccountInfo(unrefinedPda),
      ]);
      if (!playerInfo) {
        tx.add(new TransactionInstruction({
          programId: ANCHOR_PROGRAM_ID,
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: playerPda, isSigner: false, isWritable: true },
            { pubkey: TREASURY, isSigner: false, isWritable: true },
            { pubkey: POOL_PDA, isSigner: false, isWritable: true },
            { pubkey: unrefinedPda, isSigner: false, isWritable: true },
            { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: REGISTER_DISCRIMINATOR,
        }));
      } else if (!unrefinedInfo) {
        tx.add(new TransactionInstruction({
          programId: STEEL_PROGRAM_ID,
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: unrefinedPda, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: INIT_UNREFINED_DISC,
        }));
      }

      // Determine if SPL token table
      const mint = new PublicKey(tokenMint);
      const isSplTable = tokenMint !== PublicKey.default.toBase58();

      // For SPL tables: ensure table's escrow ATA exists (first depositor creates it)
      if (isSplTable) {
        const tableAta = await getAssociatedTokenAddress(mint, tablePda, true);
        const tableAtaInfo = await conn.getAccountInfo(tableAta);
        if (!tableAtaInfo) {
          tx.add(createAssociatedTokenAccountInstruction(publicKey, tableAta, tablePda, mint));
        }
      }

      // Build join_table instruction for cash game
      const [unclaimedPda] = getUnclaimedBalancePda(tablePda, publicKey);
      const unclaimedInfo = await conn.getAccountInfo(unclaimedPda);

      const joinOpts: {
        isCashGame: boolean;
        playerTokenAccount?: PublicKey;
        tableTokenAccount?: PublicKey;
        unclaimedBalancePda?: PublicKey;
        tokenProgram?: PublicKey;
      } = {
        isCashGame: true,
        unclaimedBalancePda: unclaimedInfo ? unclaimedPda : undefined,
      };

      // For SPL token tables: add token accounts
      if (isSplTable) {
        const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
        const playerAta = await getAssociatedTokenAddress(mint, publicKey);
        const tableAta = await getAssociatedTokenAddress(mint, tablePda, true);
        joinOpts.playerTokenAccount = playerAta;
        joinOpts.tableTokenAccount = tableAta;
        joinOpts.tokenProgram = TOKEN_PROGRAM_ID;
      }

      tx.add(buildJoinTableInstruction(
        publicKey,
        tablePda,
        buyInModal.seatIndex,
        buyIn,
        joinOpts,
      ));
      console.log(`[confirmBuyIn] Buy-in: ${buyIn} lamports, seat: ${buyInModal.seatIndex}`);

      tx.feePayer = publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
      const signature = await sendTransaction(tx, conn, { skipPreflight: true });
      await conn.confirmTransaction(signature, 'confirmed');

      // Set x25519 key for Arcium MPC card encryption (separate TX after join confirms)
      try {
        if (signMessage) {
          setStatus('Setting encryption key...');
          const x25519Kp = await deriveX25519Keypair(publicKey.toBase58(), signMessage);
          const setKeyIx = buildSetX25519KeyInstruction(
            publicKey, tablePda, buyInModal.seatIndex, x25519Kp.publicKey,
          );
          const keyTx = new Transaction().add(setKeyIx);
          keyTx.feePayer = publicKey;
          keyTx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
          const keySig = await sendTransaction(keyTx, conn, { skipPreflight: true });
          await conn.confirmTransaction(keySig, 'confirmed');
          setX25519Kp(x25519Kp);
          console.log('[confirmBuyIn] x25519 key set:', keySig);
        }
      } catch (keyErr: any) {
        console.warn('[confirmBuyIn] Failed to set x25519 key (cards may not decrypt):', keyErr.message?.slice(0, 100));
      }

      setStatus(`Seated at #${buyInModal.seatIndex}`);
      setBuyInModal(null);
      reloadSession();
      refreshState();
      setTimeout(() => setStatus(null), 3000);
    } catch (e: any) {
      setBuyInModal(null);
      console.error('[confirmBuyIn] Full error:', e);
      setStatus(`Error: ${String(e?.message || 'Unknown error').slice(0, 120)}`);
    } finally {
      setBuyInLoading(false);
    }
  };

  // ─── Sit Out / Sit In state (needed by leave handler) ───

  const myPlayer = gameState?.players?.find(p => p.pubkey === publicKey?.toBase58());
  const isMeSittingOut = myPlayer?.isSittingOut ?? false;

  // ─── Leave table ───

  const handleLeaveTable = useCallback(async () => {
    if (!publicKey || !sendTransaction || !gameState || gameState.mySeatIndex < 0) return;
    setLeavingTable(true);
    setStatus(null);
    try {
      const phase = gameState.phase;
      if (phase === 'Waiting' || phase === 'Complete') {
        // Table not in active hand — send leave_table directly (closes seat + marker, returns SOL)
        setStatus('Leaving table...');
        const conn = new Connection(L1_RPC, 'confirmed');
        const tablePda = new PublicKey(tablePubkey);
        const ix = buildLeaveTableInstruction(publicKey, tablePda, gameState.mySeatIndex);
        const tx = new Transaction().add(ix);
        tx.feePayer = publicKey;
        tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
        const sig = await sendTransaction(tx, conn, { skipPreflight: true });
        await conn.confirmTransaction(sig, 'confirmed');
        console.log('[LeaveTable] Left table:', sig);
        setAutoPostBlinds(false);
        removeActiveGame(tablePubkey);
        setStatus('Left table — SOL returned to wallet.');
        setTimeout(() => router.push('/'), 2000);
      } else {
        // Hand in progress — flag for end-of-hand removal via player_action(LeaveCashGame)
        setStatus('Requesting leave after hand...');
        await sendAction('leave_cash_game');
        setAutoPostBlinds(false);
        removeActiveGame(tablePubkey);
        setStatus('Leaving after current hand — SOL will be returned.');
        setTimeout(() => router.push('/'), 4000);
      }
    } catch (e: any) {
      console.error('Leave table error:', e.message?.slice(0, 80));
      setStatus(`Error: ${e?.message?.slice(0, 80)}`);
    } finally {
      setLeavingTable(false);
    }
  }, [publicKey, sendTransaction, gameState, tablePubkey, sendAction, router]);

  // ─── Distribute rake ───

  const distributeRake = async () => {
    if (!publicKey) return;
    setActionPending(true);
    setStatus(null);
    try {
      // Server-side atomic: L1 distribute + ER clear (nonce-guarded)
      // API auto-detects SOL vs SPL from table data
      const res = await fetch('/api/cash-game/clear-rake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tablePda: tablePubkey }),
      });
      const result = await res.json();
      if (!result.success && result.error) {
        throw new Error(result.error);
      }
      setStatus(`Rake distributed! ${result.distributed || 0} ${isSol ? 'lamports' : 'tokens'}`);
      refreshState();
    } catch (e: any) {
      setStatus(`Error: ${e?.message?.slice(0, 80)}`);
    } finally {
      setActionPending(false);
    }
  };

  // ─── Deposit Tip ───

  const depositTip = async () => {
    if (!publicKey || !signTransaction) return;
    setTipPending(true);
    setStatus(null);
    try {
      const conn = new Connection(L1_RPC, 'confirmed');
      const tablePda = new PublicKey(tablePubkey);
      const [tipJarPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('tip_jar'), tablePda.toBuffer()],
        new PublicKey(ANCHOR_PROGRAM_ID),
      );
      const lamports = Math.floor(parseFloat(tipAmount) * 1e9);
      const hands = parseInt(tipHands);
      if (lamports < 1000 || hands < 1 || hands > 100) {
        setStatus('Invalid tip: min 0.000001 SOL, 1-100 hands');
        return;
      }
      // deposit_tip discriminator: [15, 27, 172, 40, 63, 77, 240, 207]
      const disc = Buffer.from([15, 27, 172, 40, 63, 77, 240, 207]);
      const data = Buffer.alloc(8 + 8 + 2);
      disc.copy(data, 0);
      data.writeBigUInt64LE(BigInt(lamports), 8);
      data.writeUInt16LE(hands, 16);
      const ix = new TransactionInstruction({
        programId: new PublicKey(ANCHOR_PROGRAM_ID),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: tipJarPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const signed = await signTransaction(tx);
      await conn.sendRawTransaction(signed.serialize());
      setStatus(`Tipped ${tipAmount} SOL for ${hands} hands!`);
      setShowTipModal(false);
    } catch (e: any) {
      const msg = e?.message || 'Unknown error';
      // Wallet adapters sometimes embed base64 tx data in errors — show clean message
      const clean = msg.length > 120 || /^[A-Za-z0-9+/=]{60,}/.test(msg)
        ? 'Transaction failed — please try again'
        : msg.slice(0, 80);
      setStatus(`Tip failed: ${clean}`);
    } finally {
      setTipPending(false);
    }
  };

  // ─── Sit Out / Sit In ───

  const handleSitOut = useCallback(async () => {
    if (!gameState || gameState.mySeatIndex < 0) return;
    setSittingOutPending(true);
    sittingOutPendingRef.current = true;
    setStatus(null);
    try {
      await sendAction('sit_out');
      setStatus('Sitting out — you will skip the next hand');
    } catch (e: any) {
      if (e.message?.includes('Session expired') || e.message?.includes('Reconnecting session') || e.message?.includes('InvalidSessionKey')) {
        setStatus('Session expired — extending...');
        try {
          await topUpSession();
          reloadSession();
          await sendAction('sit_out');
          setStatus('Sitting out — you will skip the next hand');
        } catch {
          setStatus('Session extend failed. Please recreate session.');
        }
      } else {
        setStatus(`Error: ${e?.message?.slice(0, 80)}`);
      }
    } finally {
      setSittingOutPending(false);
      sittingOutPendingRef.current = false;
    }
  }, [gameState, sendAction, topUpSession, reloadSession]);

  const handleKickInactiveSeat = useCallback(async (seatIndex: number, playerWallet: string) => {
    if (!publicKey || !sendTransaction || !tablePubkey) return;

    setKickPendingSeat(seatIndex);
    setStatus(null);

    try {
      const l1Conn = new Connection(L1_RPC, 'confirmed');
      const tablePda = new PublicKey(tablePubkey);
      const walletPk = new PublicKey(playerWallet);
      const ix = buildCrankRemovePlayerInstruction(publicKey, tablePda, seatIndex, walletPk);

      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      // TEE requires its own blockhash — L1 blockhash causes "Blockhash not found"
      try {
        tx.recentBlockhash = (await l1Conn.getLatestBlockhash('confirmed')).blockhash;
      } catch {
        tx.recentBlockhash = (await l1Conn.getLatestBlockhash('confirmed')).blockhash;
      }

      const sig = await sendTransaction(tx, l1Conn, { skipPreflight: true });
      // Poll for confirmation (TEE doesn't support WS-based confirmTransaction)
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const s = await l1Conn.getSignatureStatuses([sig]);
        if (s?.value?.[0]?.confirmationStatus === 'confirmed' || s?.value?.[0]?.confirmationStatus === 'finalized') break;
      }

      setStatus(`Seat ${seatIndex} removed — chips moved to unclaimed balance.`);
      await refreshState();
    } catch (e: any) {
      setStatus(`Kick failed: ${e?.message?.slice(0, 80) || 'Unknown error'}`);
    } finally {
      setKickPendingSeat(null);
    }
  }, [publicKey, sendTransaction, tablePubkey, refreshState]);

  const handleSitIn = useCallback(async () => {
    if (!gameState || gameState.mySeatIndex < 0) return;
    setSittingOutPending(true);
    sittingOutPendingRef.current = true;
    setStatus(null);
    try {
      await sendAction('return_to_play');
      setAutoPostBlinds(true);
      // Refresh state then try to start immediately — don't wait for next interval tick
      await refreshState();
      setStatus('Back in! Starting hand...');
      try {
        const res = await fetch('/api/cash-game/ready', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tablePda: tablePubkey }),
        });
        const data = await res.json();
        if (data.success) {
          setStatus(null);
          refreshState();
        } else {
          setStatus('Back in! You will be dealt into the next hand');
        }
      } catch {
        setStatus('Back in! You will be dealt into the next hand');
      }
    } catch (e: any) {
      if (e.message?.includes('Session expired') || e.message?.includes('Reconnecting session') || e.message?.includes('InvalidSessionKey')) {
        setStatus('Session expired — extending...');
        try {
          await topUpSession();
          reloadSession();
          await sendAction('return_to_play');
          setAutoPostBlinds(true);
          await refreshState();
          setStatus('Back in! Starting hand...');
          try {
            const res = await fetch('/api/cash-game/ready', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tablePda: tablePubkey }),
            });
            const data = await res.json();
            if (data.success) {
              setStatus(null);
              refreshState();
            } else {
              setStatus('Back in! You will be dealt into the next hand');
            }
          } catch {
            setStatus('Back in! You will be dealt into the next hand');
          }
        } catch {
          setStatus('Session extend failed. Please recreate session.');
        }
      } else {
        setStatus(`Error: ${e?.message?.slice(0, 80)}`);
      }
    } finally {
      setSittingOutPending(false);
      sittingOutPendingRef.current = false;
    }
  }, [gameState, sendAction, topUpSession, reloadSession]);

  // Auto sit-out when autoPostBlinds is toggled off (between hands)
  useEffect(() => {
    if (!autoPostBlinds && gameState && gameState.mySeatIndex >= 0 && !isMeSittingOut) {
      const phase = gameState.phase;
      if (phase === 'Waiting' || phase === 'Complete') {
        handleSitOut();
      }
    }
  }, [autoPostBlinds, gameState?.phase, isMeSittingOut]);

  // ─── Claim unclaimed SOL ───
  const claimUnclaimedSol = useCallback(async () => {
    if (!publicKey || !sendTransaction || !tablePubkey || unclaimedSol <= 0) return;
    setClaimPending(true);
    setStatus(null);
    try {
      const conn = new Connection(L1_RPC, 'confirmed');
      const tablePda = new PublicKey(tablePubkey);
      const ix = buildClaimUnclaimedSolInstruction(publicKey, tablePda);
      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: publicKey });
      tx.add(ix);
      const sig = await sendTransaction(tx, conn);
      await conn.confirmTransaction(sig, 'confirmed');
      setUnclaimedSol(0);
      setStatus(`Claimed ${(unclaimedSol / 1e9).toFixed(4)} SOL!`);
    } catch (e: any) {
      setStatus(`Claim error: ${e?.message?.slice(0, 80)}`);
    } finally {
      setClaimPending(false);
    }
  }, [publicKey, sendTransaction, tablePubkey, unclaimedSol]);

  // ─── Merge Arcium-decrypted cards into myCards ───
  // During active play, gameState.myCards is undefined (plaintext 255).
  // arciumCards has the Rescue cipher decrypted values.
  const effectiveMyCards: [number, number] | undefined = (() => {
    if (gameState?.myCards) return gameState.myCards;
    if (arciumCards[0] && arciumCards[1]) return [arciumCards[0].value, arciumCards[1].value] as [number, number];
    return undefined;
  })();

  // ─── Derive display state (showdown hold overrides live state) ───
  const displayState = (() => {
    if (!gameState) return null;
    if (!showdownHold || !showdownSnapshot) return { ...gameState, myCards: effectiveMyCards };

    // During showdown hold, override phase/pot/cards with snapshot
    // but merge revealed hole cards from live on-chain data
    const heldPlayers = showdownSnapshot.players.map((sp: any) => {
      // Try to get revealed hole cards from live data
      const liveP = gameState.players.find((lp: any) => lp.pubkey === sp.pubkey);
      if (liveP?.holeCards && liveP.holeCards[0] !== 255 && (!sp.holeCards || sp.holeCards[0] === 255)) {
        return { ...sp, holeCards: [...liveP.holeCards] };
      }
      return sp;
    });

    return {
      ...gameState,
      phase: 'Showdown' as const,
      pot: showdownPot || gameState.pot,
      communityCards: showdownSnapshot.communityCards,
      players: heldPlayers,
      myCards: showdownSnapshot.myCards || gameState.myCards,
    };
  })();

  // ─── Helpers ───
  const isSeated = gameState && gameState.mySeatIndex >= 0;
  const isMyTurn = displayState && !showdownHold && gameState && gameState.mySeatIndex >= 0 && gameState.currentPlayer === gameState.mySeatIndex;
  const maxPlayers = gameState?.maxPlayers || 6;
  const myWallet = publicKey?.toBase58();
  const canKickBetweenHands = gameState?.phase === 'Waiting' || gameState?.phase === 'Complete';

  const kickCandidates = !canKickBetweenHands ? [] : (gameState?.players || [])
    .filter((p) => p.isSittingOut && !p.isLeaving)
    .filter((p) => p.pubkey !== myWallet)
    .map((p) => {
      const sitOutTimestamp = p.sitOutTimestamp || 0;
      const nowUnix = Math.floor(Date.now() / 1000);
      const sitOutSecs = sitOutTimestamp > 0 ? Math.max(0, nowUnix - sitOutTimestamp) : 0;
      const timeExpired = sitOutSecs >= SIT_OUT_KICK_TIMEOUT_SECS;
      const bustExpired = p.chips === 0 && (p.handsSinceBust || 0) >= 3;
      const legacyExpired = sitOutTimestamp <= 0 && (p.sitOutButtonCount || 0) >= 3;
      const eligible = timeExpired || bustExpired || legacyExpired;

      const reason = timeExpired
        ? `sat out ${Math.floor(sitOutSecs / 60)}m ${sitOutSecs % 60}s`
        : bustExpired
          ? `bust ${(p.handsSinceBust || 0)} hands`
          : `legacy sit-out ${(p.sitOutButtonCount || 0)} passes`;

      return { player: p, eligible, reason };
    })
    .filter((entry) => entry.eligible);

  // Count empty seats for showing join prompt
  const occupiedSeats = new Set(gameState?.players?.map(p => p.seatIndex) || []);
  const emptySeats: number[] = [];
  for (let i = 0; i < maxPlayers; i++) {
    if (!occupiedSeats.has(i)) emptySeats.push(i);
  }

  // ─── Render ───

  // Table not found — show clear message instead of infinite loading
  if (gameError === 'TABLE_NOT_FOUND') {
    return (
      <div className="bg-gray-950 text-white min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4 max-w-sm mx-auto px-4">
          <div className="w-16 h-16 mx-auto rounded-full bg-gray-800 border border-white/10 flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-white">Table Not Found</h2>
          <p className="text-sm text-gray-400">This table has been closed or no longer exists. It may have finished while you were away.</p>
          <div className="flex gap-3 justify-center pt-2">
            <Link href="/" className="px-4 py-2 rounded-lg text-sm font-medium bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 hover:bg-cyan-500/20 transition-colors">
              Back to Lobby
            </Link>
            <Link href="/my-tables" className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-800 border border-white/10 text-gray-300 hover:bg-gray-700 transition-colors">
              My Tables
            </Link>
          </div>
          <p className="text-[10px] text-gray-600 font-mono pt-2">{tablePubkey.slice(0, 8)}...{tablePubkey.slice(-4)}</p>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
    <div className="bg-gray-950 text-white">
      <main className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        {/* Header bar — same style as SNG GameView */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/my-tables" className="text-gray-500 hover:text-gray-300 text-xs mr-2">← Tables</Link>
            <h2 className="text-sm font-bold text-white">{!gameState ? 'Loading...' : gameState.isCashGame === false ? 'Sit & Go' : 'Cash Game'}</h2>
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <span className={`w-1.5 h-1.5 rounded-full ${gameConnected ? 'bg-emerald-400' : 'bg-amber-400'} animate-pulse`} />
              <span className="text-emerald-400 text-[10px] font-bold">ON-CHAIN</span>
            </div>
            {isPendingAction && (
              <div className="px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/20">
                <span className="text-cyan-400 text-[10px] font-bold animate-pulse">TX PENDING</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                onClick={async () => {
                  const url = window.location.href;
                  const blindsText = gameState ? `${(gameState.blinds.small / 1e9).toPrecision(1)}/${(gameState.blinds.big / 1e9).toPrecision(1)} ${isSol ? 'SOL' : 'POKER'}` : '';
                  const playersText = gameState ? `${gameState.players?.filter(p => !p.isLeaving).length || 0}/${gameState.maxPlayers}` : '';
                  const shareText = blindsText ? `Join my poker table! ${blindsText} blinds (${playersText} players)` : 'Join my poker table!';
                  if (navigator.share) {
                    try { await navigator.share({ title: 'Fast Poker', text: shareText, url }); } catch {}
                  } else {
                    await navigator.clipboard.writeText(url);
                    setShareTooltip(true);
                    setTimeout(() => setShareTooltip(false), 2000);
                  }
                }}
                className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-gray-400 text-xs font-bold hover:bg-white/[0.08] hover:text-white transition-colors"
                title="Share table link"
              >
                <span className="flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
                  Share
                </span>
              </button>
              {shareTooltip && (
                <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 px-2 py-1 rounded bg-emerald-500/90 text-white text-[10px] font-bold whitespace-nowrap">
                  Link copied!
                </div>
              )}
            </div>
            {isSeated && (gameState?.isCashGame !== false || gameState?.phase === 'Waiting') && (
              <button
                onClick={handleLeaveTable}
                disabled={leavingTable}
                className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400 text-xs font-bold hover:bg-red-500/20 transition-colors disabled:opacity-30"
              >
                {leavingTable ? 'Leaving...' : 'Leave Table'}
              </button>
            )}
          </div>
        </div>

        {/* Loading / Not found */}
        {gameLoading && !gameState ? (
          <div className="text-center py-20">
            <div className="w-10 h-10 border-2 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin mx-auto mb-5" />
            <h3 className="text-lg font-bold text-white mb-2">Loading Table...</h3>
            <p className="text-gray-500 text-sm">Connecting to on-chain game state</p>
          </div>
        ) : !gameState ? (
          <div className="text-center py-20">
            <h3 className="text-lg font-bold text-white mb-2">Table Not Found</h3>
            <p className="text-gray-500 text-sm mb-4">This table may not exist or may have been closed.</p>
            <Link href="/my-tables" className="px-5 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-gray-300 text-sm hover:bg-white/[0.08] transition-colors">
              Back to Tables
            </Link>
          </div>
        ) : (
          <>
            {/* Sit-out / Auto-post-blinds controls (cash game only, when seated) */}
            {isSeated && gameState.isCashGame !== false && (
              <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <div className="flex items-center gap-4">
                  {/* Auto-post blinds toggle */}
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={autoPostBlinds}
                        onChange={() => setAutoPostBlinds(!autoPostBlinds)}
                        className="sr-only"
                        disabled={sittingOutPending}
                      />
                      <div className={`w-8 h-4 rounded-full transition-colors ${autoPostBlinds ? 'bg-emerald-500' : 'bg-gray-600'}`} />
                      <div className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${autoPostBlinds ? 'translate-x-4' : ''}`} />
                    </div>
                    <span className="text-xs text-gray-400">Auto Post Blinds</span>
                  </label>

                  {/* Sitting out indicator */}
                  {isMeSittingOut && (
                    <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/25 text-amber-400 text-[10px] font-bold">
                      SITTING OUT
                    </span>
                  )}
                </div>

                {/* Sit out / Post Blind / Sit in buttons */}
                {isMeSittingOut ? (
                  <button
                    onClick={handleSitIn}
                    disabled={sittingOutPending}
                    className="px-4 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-xs font-bold hover:bg-cyan-500/25 transition-colors disabled:opacity-30 animate-pulse"
                  >
                    {sittingOutPending ? 'Posting...' : 'Post Blind'}
                  </button>
                ) : (
                  <button
                    onClick={handleSitOut}
                    disabled={sittingOutPending || (gameState?.phase !== 'Waiting' && gameState?.phase !== 'Complete')}
                    className="px-3 py-1 rounded-lg bg-gray-500/10 border border-gray-500/20 text-gray-400 text-xs font-bold hover:bg-gray-500/20 transition-colors disabled:opacity-30"
                    title={gameState?.phase !== 'Waiting' && gameState?.phase !== 'Complete' ? 'Wait for hand to finish' : 'Sit out next hand'}
                  >
                    {sittingOutPending ? 'Sitting out...' : 'Sit Out'}
                  </button>
                )}
              </div>
            )}

            {kickCandidates.length > 0 && (
              <div className="px-3 py-2 rounded-lg bg-red-500/8 border border-red-500/20 space-y-2">
                <div className="text-[11px] text-red-300 font-semibold tracking-wide">INACTIVE SEATS ELIGIBLE FOR KICK</div>
                <div className="flex flex-wrap gap-2">
                  {kickCandidates.map(({ player, reason }) => (
                    <button
                      key={`kick-${player.seatIndex}-${player.pubkey}`}
                      onClick={() => handleKickInactiveSeat(player.seatIndex, player.pubkey)}
                      disabled={!connected || kickPendingSeat !== null}
                      className="px-2.5 py-1 rounded-md bg-red-500/15 border border-red-500/30 text-red-300 text-[11px] font-bold hover:bg-red-500/25 transition-colors disabled:opacity-40"
                      title={`Seat ${player.seatIndex}: ${reason}`}
                    >
                      {kickPendingSeat === player.seatIndex ? 'Kicking...' : `Kick Seat ${player.seatIndex}`}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Unclaimed SOL banner */}
            {unclaimedSol > 0 && connected && (
              <div className="flex items-center justify-between px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/25">
                <div className="text-sm">
                  <span className="text-amber-400 font-bold">{(unclaimedSol / 1e9).toFixed(4)} SOL</span>
                  <span className="text-gray-400 ml-2">unclaimed from a previous session</span>
                </div>
                <button
                  onClick={claimUnclaimedSol}
                  disabled={claimPending}
                  className="px-4 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold hover:bg-amber-500/30 transition-colors disabled:opacity-40"
                >
                  {claimPending ? 'Claiming...' : 'Claim SOL'}
                </button>
              </div>
            )}

            {/* Table info pills — blinds · rake (cash only) · hand# · phase */}
            <div className="flex items-center gap-2 flex-wrap">
              {gameState.blinds && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.08]">
                  <span className="text-gray-500 text-[10px] font-medium">BLINDS</span>
                  <span className="text-white text-xs font-bold tabular-nums">
                    {gameState.isCashGame !== false
                      ? `${parseFloat((gameState.blinds.small / 1e9).toPrecision(2))}/${parseFloat((gameState.blinds.big / 1e9).toPrecision(2))}`
                      : `${gameState.blinds.small}/${gameState.blinds.big}`}
                  </span>
                  {gameState.isCashGame !== false && (
                    <span className="text-gray-500 text-[10px]">{isSol ? 'SOL' : getTokenSymbol(tokenMint)}</span>
                  )}
                </div>
              )}
              {gameState.isCashGame !== false && (() => {
                const bb = gameState.blinds?.big || 0;
                const capBB = rakeCap > 0 && bb > 0 ? (rakeCap / bb).toFixed(1) : null;
                const creatorPct = '45%';
                const dealerPct = '5%';
                return (
                  <div className="relative group">
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/8 border border-emerald-500/15 cursor-help">
                      <span className="text-emerald-400 text-xs font-bold">
                        5% Rake{capBB ? ` · Cap ${capBB} BB` : ''}
                      </span>
                    </div>
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2.5 rounded-lg bg-gray-900 border border-white/10 text-[10px] leading-relaxed w-56 text-left z-50 shadow-xl whitespace-normal hidden group-hover:block">
                      <div className="text-gray-300 font-medium mb-1">Rake: 5% of pot (post-flop only)</div>
                      {capBB ? (
                        <div className="text-gray-400 mb-1.5">Cap: {capBB} BB per hand</div>
                      ) : (
                        <div className="text-gray-400 mb-1.5">Cap: None (Micro stakes)</div>
                      )}
                      <div className="border-t border-white/[0.06] pt-1.5 space-y-0.5">
                        <div className="text-gray-500 font-medium mb-0.5">Distribution:</div>
                        <div className="flex justify-between"><span className="text-gray-400">Creator</span><span className="text-emerald-400">{creatorPct}{isCreator ? ' ← you' : ''}</span></div>
                        {dealerPct && <div className="flex justify-between"><span className="text-gray-400">Dealer</span><span className="text-cyan-400">{dealerPct}</span></div>}
                        <div className="flex justify-between"><span className="text-gray-400">Stakers</span><span className="text-amber-400">25%</span></div>
                        <div className="flex justify-between"><span className="text-gray-400">Treasury</span><span className="text-gray-400">25%</span></div>
                      </div>
                    </div>
                  </div>
                );
              })()}
              {/* Tip Jar pill */}
              {gameState.isCashGame !== false && (
                <div className="relative group">
                  <button
                    onClick={() => setShowTipModal(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-purple-500/8 border border-purple-500/15 cursor-pointer hover:bg-purple-500/15 transition-colors"
                  >
                    <span className="text-purple-400 text-xs font-bold">
                      Tip Jar{tipJarHands > 0 ? ` · ${tipJarHands}h` : ''}
                    </span>
                  </button>
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-lg bg-gray-900 border border-white/10 text-[10px] leading-relaxed w-48 text-left z-50 shadow-xl whitespace-normal hidden group-hover:block">
                    <div className="text-gray-300 font-medium mb-1">Dealer Tip Jar</div>
                    <div className="flex justify-between"><span className="text-gray-400">Balance</span><span className="text-purple-400">{(tipJarBalance / 1e9).toFixed(4)} SOL</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Hands Left</span><span className="text-purple-400">{tipJarHands}</span></div>
                    {tipJarHands > 0 && <div className="flex justify-between"><span className="text-gray-400">Per Hand</span><span className="text-purple-400">{(tipJarBalance / tipJarHands / 1e9).toFixed(6)} SOL</span></div>}
                    <div className="flex justify-between mt-1 pt-1 border-t border-white/[0.06]"><span className="text-gray-500">Total Tipped</span><span className="text-gray-400">{(tipJarTotal / 1e9).toFixed(4)} SOL</span></div>
                    <div className="text-gray-600 mt-1">Click to deposit a tip</div>
                  </div>
                </div>
              )}
              {gameState.handNumber > 0 && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.08]">
                  <span className="text-gray-500 text-[10px] font-medium">HAND</span>
                  <span className="text-gray-300 text-xs font-bold tabular-nums">#{gameState.handNumber}</span>
                </div>
              )}
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.08]">
                <span className="text-gray-500 text-[10px] font-medium">PHASE</span>
                <span className="text-cyan-400 text-xs font-bold">{gameState.phase}</span>
              </div>
            </div>

            {/* Poker table — uses displayState (showdown-held) for visual rendering */}
            <PokerTable
              tablePda={tablePubkey}
              phase={displayState!.phase}
              pot={displayState!.pot}
              currentPlayer={displayState!.currentPlayer}
              communityCards={displayState!.communityCards}
              players={displayState!.players}
              myCards={displayState!.myCards}
              onAction={isSeated && !showdownHold ? handleGameAction : undefined}
              isMyTurn={!!isMyTurn}
              blinds={displayState!.blinds}
              dealerSeat={displayState!.dealerSeat}
              maxSeats={displayState!.maxPlayers}
              handHistory={handHistory}
              pastHands={pastHands}
              viewingPastHand={viewingPastHand}
              onHandNav={setViewingPastHand}
              actionPending={actionPending}
              showdownPot={showdownPot}
              maxPlayers={gameState.maxPlayers}
              lastActionSlot={gameState.lastActionSlot}
              playerActions={playerActions}
              currentBet={gameState.currentBet}
              tokenMint={gameState.tokenMint}
              isCashGame={gameState?.isCashGame ?? true}
              handNumber={gameState.handNumber}
              tier={gameState.tier}
              prizePool={gameState.prizePool}
              onSeatClick={connected && !isSeated ? (gameState?.isCashGame !== false ? openBuyInModal : handleSngSeatClick) : undefined}
            />


            {/* Status messages */}
            {(status || gameError) && (
              <div className={`text-sm px-3 py-2 rounded-lg ${
                (status || '').startsWith('Error') || gameError ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'
              }`}>
                {status || gameError}
              </div>
            )}
          </>
        )}

        {/* Buy-in Modal */}
        {buyInModal && gameState && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !buyInLoading && setBuyInModal(null)}>
            <div className="bg-gray-900 border border-white/[0.1] rounded-2xl p-6 w-full max-w-sm space-y-4 shadow-2xl" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-white">Buy In — Seat {buyInModal.seatIndex}</h3>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>Blinds: {(gameState.blinds.small / 1e9).toPrecision(1)}/{(gameState.blinds.big / 1e9).toPrecision(1)} {isSol ? 'SOL' : 'POKER'}</span>
                  <span>Min {buyInMin} BB · Max {buyInMax} BB</span>
                </div>

                {/* BB amount slider */}
                <div className="space-y-1">
                  <label className="text-xs text-gray-400">Buy-in amount (Big Blinds)</label>
                  <input
                    type="range"
                    min={buyInMin}
                    max={buyInMax}
                    step={5}
                    value={buyInBBs}
                    onChange={e => setBuyInBBs(Number(e.target.value))}
                    className="w-full accent-cyan-500"
                  />
                  <div className="flex justify-between text-xs text-gray-600">
                    <span>{buyInMin} BB</span>
                    <span className="text-cyan-400 font-bold">{buyInBBs} BB{buyInType === 1 ? ' (Deep)' : ''}</span>
                    <span>{buyInMax} BB</span>
                  </div>
                </div>

                {/* Quick select */}
                <div className="flex gap-2 justify-center">
                  {buyInQuickPicks.map(bb => (
                    <button
                      key={bb}
                      onClick={() => setBuyInBBs(bb)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                        buyInBBs === bb
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                          : 'bg-white/[0.04] text-gray-500 border border-white/[0.06] hover:bg-white/[0.08]'
                      }`}
                    >
                      {bb} BB
                    </button>
                  ))}
                </div>

                {/* Token amount display */}
                <div className="text-center py-2">
                  <div className="text-2xl font-bold text-white tabular-nums">
                    {(() => { const v = (gameState.blinds.big * buyInBBs) / 1e9; return parseFloat(v >= 1 ? v.toFixed(4) : v >= 0.01 ? v.toFixed(4) : v >= 0.0001 ? v.toFixed(6) : v.toFixed(9)).toString(); })()}
                  </div>
                  <div className="text-xs text-gray-500">{isSol ? 'SOL' : 'POKER tokens'}</div>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setBuyInModal(null)}
                  disabled={buyInLoading}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-gray-400 text-sm font-bold hover:bg-white/[0.08] transition-colors disabled:opacity-30"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmBuyIn}
                  disabled={buyInLoading}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 text-gray-950 text-sm font-bold transition-all disabled:opacity-50"
                >
                  {buyInLoading ? 'Joining...' : 'Confirm & Sit'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tip Jar Deposit Modal */}
        {showTipModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowTipModal(false)}>
            <div className="bg-gray-900 border border-white/10 rounded-2xl p-6 w-80 shadow-2xl" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-purple-400 mb-1">Tip Your Dealer</h3>
              <p className="text-xs text-gray-500 mb-4">SOL tips are paid to the dealer (crank operator) each hand.</p>

              <div className="space-y-3 mb-4">
                <div>
                  <label className="text-[10px] text-gray-500 uppercase block mb-1">Amount (SOL)</label>
                  <input
                    type="number"
                    value={tipAmount}
                    onChange={e => setTipAmount(e.target.value)}
                    min="0.000001"
                    step="0.001"
                    className="w-full bg-black/30 border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white focus:border-purple-500/50 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 uppercase block mb-1">Hands (1-100)</label>
                  <input
                    type="number"
                    value={tipHands}
                    onChange={e => setTipHands(e.target.value)}
                    min="1"
                    max="100"
                    className="w-full bg-black/30 border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white focus:border-purple-500/50 focus:outline-none"
                  />
                </div>
                <div className="bg-purple-500/[0.06] border border-purple-500/[0.12] rounded-lg px-3 py-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">Per Hand</span>
                    <span className="text-purple-400 font-bold">
                      {parseFloat(tipHands) > 0 ? (parseFloat(tipAmount) / parseFloat(tipHands)).toFixed(6) : '0'} SOL
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setShowTipModal(false)}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-gray-400 text-sm font-bold hover:bg-white/[0.08] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={depositTip}
                  disabled={tipPending}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-purple-500 hover:bg-purple-400 text-white text-sm font-bold transition-colors disabled:opacity-50"
                >
                  {tipPending ? 'Sending...' : 'Deposit Tip'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Spacer for fixed footer */}
        <div className="h-10" />
      </main>
    </div>
    </ErrorBoundary>
  );
}
