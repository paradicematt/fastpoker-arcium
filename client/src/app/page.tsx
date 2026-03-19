'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { useGameStore } from '@/store/gameStore';
import { GamePhase, L1_RPC_DIRECT, POKER_MINT, STEEL_PROGRAM_ID, POOL_PDA, ANCHOR_PROGRAM_ID, SnGTier } from '@/lib/constants';
import { usePlayer, getRegistrationCost, getFreeEntriesOnRegister } from '@/hooks/usePlayer';
import { useSession } from '@/hooks/useSession';
import { useOnChainGame } from '@/hooks/useOnChainGame';
import { useJoinTable } from '@/hooks/useJoinTable';
import { getQueues, joinQueue, leaveQueue } from '@/lib/api';
import { buildLeaveTableInstruction } from '@/lib/onchain-game';
import PokerTable from '@/components/game/PokerTable';

import { Lobby } from '@/components/lobby/Lobby';
import { addActiveGame, removeActiveGame } from '@/components/layout/ActiveTableBar';
import { useSearchParams } from 'next/navigation';
import { getPlayerPda } from '@/lib/pda';

// claim_sol_winnings Anchor discriminator
const CLAIM_SOL_DISC = Buffer.from([47, 206, 17, 43, 28, 213, 74, 12]);

interface TokenBalances {
  sol: number;
  poker: number;
  refined: number;
  unrefined: number;
  staked: number;
  pendingSolRewards: number;
}

interface PoolState {
  totalStaked: number;
  totalUnrefined: number;
  solDistributed: number;
  circulatingSupply: number;
}

interface SitNGoQueue {
  id: string;
  type: 'heads_up' | '6max' | '9max';
  currentPlayers: number;
  maxPlayers: number;
  buyIn: number;
  tier: number;  // SnGTier enum: 0=Micro,...5=Diamond
  status: 'waiting' | 'starting' | 'in_progress';
  tablePda?: string;
  players?: string[];
  onChainPlayers?: number;
  emptySeats?: number[];
}

export default function Home() {
  const { connected, publicKey, sendTransaction } = useWallet();
  const searchParams = useSearchParams();
  const { phase, tablePda, setMySeatIndex, syncFromChain } = useGameStore();
  const { player, isLoading: playerLoading, register, refresh: refreshPlayer } = usePlayer();
  const { session, createSession, topUpSession, reclaimSession, reloadSession, isLoading: sessionLoading } = useSession();
  const [view, setView] = useState<'lobby' | 'game'>('lobby');
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [waitingQueueId, setWaitingQueueId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'error' | 'success' | 'info' } | null>(null);
  const [handHistory, setHandHistory] = useState<{ player: string; action: string; amount?: number; phase: string }[]>([]);
  const [pastHands, setPastHands] = useState<{ player: string; action: string; amount?: number; phase: string }[][]>([]);
  const [viewingPastHand, setViewingPastHand] = useState<number | null>(null); // null = current hand

  // Deep-link support for admin "port out" links: /?table=<tablePda>
  useEffect(() => {
    const tableFromQuery = searchParams.get('table');
    if (!tableFromQuery) return;

    try {
      // Validate pubkey shape before switching UI state
      new PublicKey(tableFromQuery);
      setActiveTable(tableFromQuery);
      setView('game');
    } catch {
      // Ignore malformed deep-link values
    }
  }, [searchParams]);

  // Show toast notification
  const showToast = useCallback((message: string, type: 'error' | 'success' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 5000);
  }, []);
  
  // On-chain game state hook - pass session key for gasless play
  const { 
    gameState: onChainGameState, 
    isLoading: gameLoading, 
    isConnected: gameConnected,
    sendAction: sendOnChainAction,
    isPendingAction,
    error: gameError,
    refreshState: refreshGameState
  } = useOnChainGame(activeTable, session.sessionKey);

  // Sync on-chain game state → Zustand store for selectors (isMyTurn, etc.)
  useEffect(() => {
    syncFromChain(onChainGameState);
  }, [onChainGameState, syncFromChain]);
  
  // Hook for joining on-chain tables with retry support
  const { 
    joinTable: joinOnChainTable, 
    retryJoin, 
    isPending: isJoiningOnChain, 
    error: joinError,
    pendingJoin,
    clearError: clearJoinError 
  } = useJoinTable();
  
  // Showdown delay: hold UI in Showdown briefly after on-chain settles
  // Captures ALL visual state so cards/players aren't lost when on-chain resets
  const [showdownHold, setShowdownHold] = useState(false);
  const [showdownPot, setShowdownPot] = useState(0);
  const [showdownSnapshot, setShowdownSnapshot] = useState<{
    communityCards: number[];
    players: any[];
    myCards?: [number, number];
  } | null>(null);
  // Preserve final game state when tournament ends (Complete) so it survives undelegate
  const [gameCompleteState, setGameCompleteState] = useState<any>(null);
  const [playerActions, setPlayerActions] = useState<{ seatIndex: number; action: string; timestamp: number }[]>([]);
  const prevPhaseForDelayRef = useRef<string | null>(null);
  
  // Track last known on-chain state for game-over detection
  const lastOnChainRef = useRef<typeof onChainGameState>(null);
  // Track last VALID community cards (settle resets them to [255;5] before frontend can snapshot)
  const lastValidCommunityRef = useRef<number[]>([]);
  // IMPORTANT: Use a ref for the showdown timer so React's effect cleanup doesn't kill it.
  // Previously the timer was returned as the cleanup function, but since showdownHold is
  // in the effect's triggers, setting showdownHold=true would re-run the effect, and
  // React would call the previous cleanup (clearTimeout) before the timer could fire.
  const showdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear gameCompleteState when joining a new table (prevents stale data from previous game)
  const prevActiveTableRef = useRef(activeTable);
  useEffect(() => {
    if (activeTable && activeTable !== prevActiveTableRef.current) {
      setGameCompleteState(null);
      setShowdownHold(false);
      setShowdownPot(0);
      setShowdownSnapshot(null);
      lastValidCommunityRef.current = [];
      if (showdownTimerRef.current) {
        clearTimeout(showdownTimerRef.current);
        showdownTimerRef.current = null;
      }
    }
    prevActiveTableRef.current = activeTable;
  }, [activeTable]);

  useEffect(() => {
    const currPhase = onChainGameState?.phase;
    const prevPhase = prevPhaseForDelayRef.current;
    prevPhaseForDelayRef.current = currPhase || null;
    
    // Track last valid community cards (settle resets them to [255;5] atomically)
    // Only update during betting phases when cards are actually dealt
    const cc = onChainGameState?.communityCards;
    if (cc && cc.some((c: number) => c !== 255 && c >= 0 && c <= 51)) {
      lastValidCommunityRef.current = [...cc];
    }

    // Capture full state when entering showdown or any end phase (Complete/Waiting after a hand)
    // The crank is often fast enough to skip Showdown entirely (betting → Complete in one update)
    const isEndPhase = currPhase === 'Showdown' || currPhase === 'Complete' || currPhase === 'Waiting';
    const wasPlayingPhase = prevPhase && prevPhase !== 'Showdown' && prevPhase !== 'Complete' && prevPhase !== 'Waiting';
    
    if (isEndPhase && wasPlayingPhase) {
      // Compute actual winnings from chip deltas (handles side pots / all-in correctly)
      // After settle: onChainGameState has post-settle chips, lastOnChainRef has pre-settle chips
      const prevPlayers = lastOnChainRef.current?.players;
      const currPlayers = onChainGameState?.players;
      let computedPot = 0;
      if (prevPlayers?.length && currPlayers?.length) {
        for (const cp of currPlayers) {
          const pp = prevPlayers.find((p: any) => p.pubkey === cp.pubkey);
          if (pp) {
            const gain = cp.chips - pp.chips;
            if (gain > computedPot) computedPot = gain;
          }
        }
      }
      // Fall back to raw pot if chip delta not available (e.g. first poll)
      if (computedPot <= 0) {
        computedPot = onChainGameState?.pot || lastOnChainRef.current?.pot || 0;
      }
      if (computedPot > 0) {
        setShowdownPot(computedPot);
      }
      // Capture snapshot from last known state (before settle reset cards/bets)
      // Use lastValidCommunityRef for community cards since settle clears them atomically
      const snapSource = lastOnChainRef.current || onChainGameState;
      if (snapSource && !showdownSnapshot) {
        const snapshotCommunity = lastValidCommunityRef.current.length > 0
          ? [...lastValidCommunityRef.current]
          : [...(snapSource.communityCards || [])];
        setShowdownSnapshot({
          communityCards: snapshotCommunity,
          players: JSON.parse(JSON.stringify(snapSource.players || [])),
          myCards: snapSource.myCards ? [...snapSource.myCards] as [number, number] : undefined,
        });
      }
    }
    
    // Preserve game state when Complete is detected (survives undelegate)
    if (currPhase === 'Complete' && onChainGameState) {
      setGameCompleteState(JSON.parse(JSON.stringify(onChainGameState)));
    }

    // Game-over detection: on-chain state vanished while in Showdown
    // This happens when crank undelegates before frontend sees Complete phase
    if (!onChainGameState && lastOnChainRef.current) {
      const lastPhase = lastOnChainRef.current.phase;
      if (lastPhase === 'Showdown' || lastPhase === 'Complete' || showdownHold) {
        console.log('Table vanished during showdown — synthesizing Complete state');
        const synthetic = JSON.parse(JSON.stringify(lastOnChainRef.current));
        synthetic.phase = 'Complete';
        setGameCompleteState(synthetic);
        // Release showdown hold so Complete overlay shows
        setShowdownHold(false);
        setShowdownPot(0);
        setShowdownSnapshot(null);
        lastValidCommunityRef.current = [];
        if (showdownTimerRef.current) {
          clearTimeout(showdownTimerRef.current);
          showdownTimerRef.current = null;
        }
      }
    }

    // Keep ref updated
    if (onChainGameState) {
      lastOnChainRef.current = onChainGameState;
    }
    
    // Trigger hold on phase transition to end states
    // Handles: Showdown→Complete, Showdown→Waiting, AND skipped-Showdown (PreFlop→Complete, etc.)
    const triggerHold = (
      (prevPhase === 'Showdown' && (currPhase === 'Complete' || currPhase === 'Waiting')) ||
      (wasPlayingPhase && (currPhase === 'Complete' || currPhase === 'Waiting'))
    );
    if (triggerHold) {
      // Ensure showdownPot is captured even if we missed it above
      if (!showdownPot) {
        // Compute from chip deltas (handles side pots / all-in)
        const prevPlayers = lastOnChainRef.current?.players;
        const currPlayers = onChainGameState?.players;
        let computedPot = 0;
        if (prevPlayers?.length && currPlayers?.length) {
          for (const cp of currPlayers) {
            const pp = prevPlayers.find((p: any) => p.pubkey === cp.pubkey);
            if (pp) {
              const gain = cp.chips - pp.chips;
              if (gain > computedPot) computedPot = gain;
            }
          }
        }
        if (computedPot <= 0) {
          computedPot = onChainGameState?.pot || lastOnChainRef.current?.pot || 0;
        }
        if (computedPot > 0) setShowdownPot(computedPot);
      }
      // Re-capture snapshot if we missed it
      if (!showdownSnapshot) {
        const snapSource = lastOnChainRef.current || onChainGameState;
        if (snapSource) {
          const snapshotCommunity = lastValidCommunityRef.current.length > 0
            ? [...lastValidCommunityRef.current]
            : [...(snapSource.communityCards || [])];
          setShowdownSnapshot({
            communityCards: snapshotCommunity,
            players: JSON.parse(JSON.stringify(snapSource.players || [])),
            myCards: snapSource.myCards ? [...snapSource.myCards] as [number, number] : undefined,
          });
        }
      }
      setShowdownHold(true);
      // Clear any previous timer before setting a new one
      if (showdownTimerRef.current) clearTimeout(showdownTimerRef.current);
      // Hold showdown display so players can see revealed cards and hand names
      // Stage 3 (winner + chips) fires at 2.5s, so hold long enough to see it
      const holdMs = currPhase === 'Complete' ? 8000 : 10000;
      showdownTimerRef.current = setTimeout(() => {
        setShowdownHold(false);
        setShowdownPot(0);
        setShowdownSnapshot(null);
        lastValidCommunityRef.current = [];
        showdownTimerRef.current = null;
      }, holdMs);
    }

    // Early release: if showdownHold is active but new hand started (PreFlop+), release immediately
    if (showdownHold && currPhase && currPhase !== 'Showdown' && currPhase !== 'Waiting' && currPhase !== 'Complete') {
      setShowdownHold(false);
      setShowdownPot(0);
      setShowdownSnapshot(null);
      lastValidCommunityRef.current = [];
      if (showdownTimerRef.current) {
        clearTimeout(showdownTimerRef.current);
        showdownTimerRef.current = null;
      }
    }
  }, [onChainGameState, showdownHold]);

  // On-chain game state only (no demo/local fallback)
  const gameState: {
    phase: string;
    pot: number;
    currentPlayer: number;
    communityCards: number[];
    players: any[];
    myCards?: [number, number];
    dealerSeat: number;
    blinds: { small: number; big: number };
    mySeatIndex: number;
    tier: number;
    prizePool: number;
    maxPlayers: number;
    lastActionSlot: number;
    blindLevel: number;
    tournamentStartTime: number;
    currentBet: number;
    tokenMint: string;
  } | null = (() => {
    // Use live on-chain state, or fall back to preserved Complete state after undelegate
    const source = onChainGameState || gameCompleteState;
    if (!source) return null;
    
    const isLive = !!onChainGameState;
    return {
      phase: showdownHold ? 'Showdown' : (isLive ? source.phase : 'Complete'),
      pot: showdownHold ? (showdownPot || source.pot) : source.pot,
      currentPlayer: source.currentPlayer,
      communityCards: showdownHold && showdownSnapshot ? showdownSnapshot.communityCards : source.communityCards,
      players: showdownHold && showdownSnapshot ? showdownSnapshot.players.map((sp: any) => {
        // Merge revealed hole cards from live on-chain data OR gameCompleteState
        // (settle populates revealed_hands; after undelegate, live data is gone)
        const mergeSource = isLive ? onChainGameState!.players : source.players;
        const mergePlayer = mergeSource?.find((lp: any) => lp.pubkey === sp.pubkey);
        if (mergePlayer?.holeCards && mergePlayer.holeCards[0] !== 255 && (!sp.holeCards || sp.holeCards[0] === 255)) {
          return { ...sp, holeCards: mergePlayer.holeCards };
        }
        return sp;
      }) : source.players,
      myCards: showdownHold && showdownSnapshot ? showdownSnapshot.myCards : source.myCards,
      dealerSeat: source.dealerSeat,
      blinds: source.blinds,
      mySeatIndex: source.mySeatIndex,
      tier: source.tier,
      prizePool: source.prizePool,
      maxPlayers: source.maxPlayers,
      lastActionSlot: source.lastActionSlot,
      blindLevel: source.blindLevel || 0,
      tournamentStartTime: source.tournamentStartTime || 0,
      currentBet: source.currentBet || 0,
      tokenMint: source.tokenMint || '11111111111111111111111111111111',
    };
  })();
  
  // Track previous game state for opponent action detection
  const prevGameStateRef = useRef<typeof onChainGameState>(null);
  
  // Track opponent actions by detecting state changes
  useEffect(() => {
    const prev = prevGameStateRef.current;
    if (!onChainGameState || !prev) {
      prevGameStateRef.current = onChainGameState;
      return;
    }
    
    const prevPhase = prev.phase;
    const currPhase = onChainGameState.phase;
    const prevPlayer = prev.currentPlayer;
    const currPlayer = onChainGameState.currentPlayer;
    const myIdx = onChainGameState.mySeatIndex;
    const blinds = onChainGameState.blinds;
    
    // Detect blind posting: Waiting → Starting/PreFlop transition (new hand starting)
    // On-chain: start_game posts blinds in Starting phase, tee_deal moves to PreFlop
    if (prevPhase === 'Waiting' && (currPhase === 'PreFlop' || currPhase === 'Starting')) {
      // Archive previous hand if it has entries
      setHandHistory(prev => {
        if (prev.length > 0) {
          setPastHands(past => [...past, prev]);
        }
        return [];
      });
      setViewingPastHand(null); // Reset to current hand view
      const now = Date.now();
      for (const p of onChainGameState.players) {
        if (!p.isActive) continue;
        const label = p.pubkey === publicKey?.toBase58() ? 'You' : (p.pubkey?.slice(0, 6) + '...');
        if (p.bet === blinds.small) {
          setHandHistory(h => [...h, { player: label, action: `SB ${blinds.small}`, phase: 'PreFlop' }]);
          setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== p.seatIndex), { seatIndex: p.seatIndex, action: `SB ${blinds.small}`, timestamp: now }]);
        } else if (p.bet === blinds.big) {
          setHandHistory(h => [...h, { player: label, action: `BB ${blinds.big}`, phase: 'PreFlop' }]);
          setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== p.seatIndex), { seatIndex: p.seatIndex, action: `BB ${blinds.big}`, timestamp: now + 1 }]);
        }
      }
      prevGameStateRef.current = onChainGameState;
      return;
    }
    
    // Detect if current player changed (opponent acted)
    if ((prevPlayer !== currPlayer || prevPhase !== currPhase) && prevPlayer !== myIdx && prevPlayer >= 0) {
      const prevOpp = prev.players.find((p: { seatIndex: number }) => p.seatIndex === prevPlayer);
      const currOpp = onChainGameState.players.find((p: { seatIndex: number }) => p.seatIndex === prevPlayer);
      
      if (prevOpp && currOpp) {
        const label = currOpp.pubkey === publicKey?.toBase58() ? 'You' : (currOpp.pubkey?.slice(0, 6) + '...');
        let action = 'CHECK';
        if (currOpp.folded && !prevOpp.folded) {
          action = 'FOLD';
        } else if (currOpp.chips === 0 && prevOpp.chips > 0) {
          action = `ALL-IN ${currOpp.bet}`;
        } else if (currOpp.bet > prevOpp.bet) {
          const betDiff = currOpp.bet - prevOpp.bet;
          const prevMaxBet = Math.max(...prev.players.map((p: { bet: number }) => p.bet), 0);
          action = currOpp.bet > prevMaxBet ? `RAISE ${currOpp.bet}` : `CALL ${betDiff}`;
        }
        
        setHandHistory(h => [...h, { player: label, action, phase: prevPhase }]);
        setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== currOpp.seatIndex), { seatIndex: currOpp.seatIndex, action, timestamp: Date.now() }]);
      }
    }

    // Log results when transitioning to Showdown or Complete
    if (prevPhase !== 'Complete' && prevPhase !== 'Showdown' && (currPhase === 'Showdown' || currPhase === 'Complete')) {
      const SUITS = ['s', 'h', 'd', 'c'];
      const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
      const cardStr = (c: number) => c >= 0 && c <= 51 ? `${RANKS[c % 13]}${SUITS[Math.floor(c / 13)]}` : '?';

      // Log community cards (board)
      const board = (onChainGameState.communityCards || []).filter((c: number) => c !== 255 && c >= 0 && c <= 51);
      if (board.length >= 3) {
        setHandHistory(h => [...h, { player: '', action: `Board: ${board.map(cardStr).join(' ')}`, phase: 'Summary' }]);
      }

      // Log each player's hand
      const isFoldWin = onChainGameState.players.filter((p: any) => !p.folded && p.isActive).length <= 1;
      for (const p of onChainGameState.players) {
        if (!p.isActive && !p.folded) continue;
        const isMe = p.pubkey === publicKey?.toBase58();
        const label = isMe ? 'You' : (p.pubkey?.slice(0, 6) + '...');
        const cards = isMe ? onChainGameState.myCards : p.holeCards;
        if (p.folded) {
          setHandHistory(h => [...h, { player: label, action: 'folded', phase: 'Summary' }]);
        } else if (cards && cards[0] !== 255 && cards[1] !== 255) {
          setHandHistory(h => [...h, { player: label, action: `${cardStr(cards[0])} ${cardStr(cards[1])}`, phase: 'Summary' }]);
        } else if (!isFoldWin) {
          // Showdown but cards not revealed yet (will update on next state change)
          setHandHistory(h => [...h, { player: label, action: 'cards hidden', phase: 'Summary' }]);
        }
      }

      // Find winner — player who gained chips
      for (const curr of onChainGameState.players) {
        if (!curr.isActive && !curr.folded) continue;
        const prevP = prev.players.find((p: { pubkey: string }) => p.pubkey === curr.pubkey);
        if (!prevP) continue;
        const chipDelta = curr.chips - prevP.chips;
        const label = curr.pubkey === publicKey?.toBase58() ? 'You' : (curr.pubkey?.slice(0, 6) + '...');
        if (chipDelta > 0) {
          const winType = isFoldWin ? 'WON (fold)' : 'WON';
          setHandHistory(h => [...h, { player: label, action: `${winType} +${chipDelta.toLocaleString()}`, phase: 'Result' }]);
        }
      }
    }
    
    prevGameStateRef.current = onChainGameState;
  }, [onChainGameState]);

  const [refreshCounter, setRefreshCounter] = useState(0);
  const [balances, setBalances] = useState<TokenBalances>({ sol: 0, poker: 0, refined: 0, unrefined: 0, staked: 0, pendingSolRewards: 0 });
  const [poolState, setPoolState] = useState<PoolState>({ totalStaked: 0, totalUnrefined: 0, solDistributed: 0, circulatingSupply: 0 });
  const [sitNGoQueues, setSitNGoQueues] = useState<SitNGoQueue[]>([]);
  const [registering, setRegistering] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [joiningQueue, setJoiningQueue] = useState<string | null>(null);
  const [leavingQueue, setLeavingQueue] = useState<string | null>(null);
  const [selectedTier, setSelectedTier] = useState<SnGTier>(SnGTier.Micro);
  const [claimingSol, setClaimingSol] = useState(false);

  // Fetch real token balances and pool state
  useEffect(() => {
    if (!connected || !publicKey) {
      setBalances({ sol: 0, poker: 0, refined: 0, unrefined: 0, staked: 0, pendingSolRewards: 0 });
      setPoolState({ totalStaked: 0, totalUnrefined: 0, solDistributed: 0, circulatingSupply: 0 });
      return;
    }

    const fetchData = async () => {
      try {
        const connection = new Connection(L1_RPC_DIRECT, 'confirmed');
        
        // Collect all balance values locally, then update state once at the end
        const newBalances: Partial<TokenBalances> = {};

        // Get SOL balance
        try {
          const solLamports = await connection.getBalance(publicKey);
          newBalances.sol = solLamports / 1e9;
        } catch {
          // Failed to get SOL balance
        }

        // Get POKER token balance
        const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, publicKey);
        try {
          const account = await getAccount(connection, tokenAccount);
          newBalances.poker = Number(account.amount) / 1e9;
        } catch {
          // No token account
        }

        // Get stake account for staked amount + pending SOL rewards
        // Stake layout: disc(8) + owner(32) + burned_amount(8) + sol_reward_debt(u128@48) + pending_sol(u64@64)
        const [stakePda] = PublicKey.findProgramAddressSync(
          [Buffer.from('stake'), publicKey.toBuffer()],
          STEEL_PROGRAM_ID
        );
        let burnedRaw = BigInt(0);
        let solRewardDebt = BigInt(0);
        let storedPendingSol = BigInt(0);
        try {
          const stakeData = await connection.getAccountInfo(stakePda);
          if (stakeData && stakeData.data.length >= 48) {
            burnedRaw = stakeData.data.readBigUInt64LE(40);
            newBalances.staked = Number(burnedRaw) / 1e9;
            if (stakeData.data.length >= 72) {
              const debtLo = stakeData.data.readBigUInt64LE(48);
              const debtHi = stakeData.data.readBigUInt64LE(56);
              solRewardDebt = (debtHi << BigInt(64)) | debtLo;
              storedPendingSol = stakeData.data.readBigUInt64LE(64);
            }
          }
        } catch {
          // No stake account
        }

        // Get unrefined account for tournament winnings
        // Unrefined layout: disc(8) + owner(32) + unrefined_amount(8) + refined_amount(8) + refined_debt(16) + bump(1) + pad(7)
        const [unrefinedPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('unrefined'), publicKey.toBuffer()],
          STEEL_PROGRAM_ID
        );
        let unrefinedRaw = BigInt(0);
        let storedRefined = BigInt(0);
        let refinedDebt = BigInt(0);
        try {
          const unrefinedData = await connection.getAccountInfo(unrefinedPda);
          if (unrefinedData && unrefinedData.data.length >= 72) {
            unrefinedRaw = unrefinedData.data.readBigUInt64LE(40);
            storedRefined = unrefinedData.data.readBigUInt64LE(48);
            // refined_debt is u128 at offset 56
            const debtLo = unrefinedData.data.readBigUInt64LE(56);
            const debtHi = unrefinedData.data.readBigUInt64LE(64);
            refinedDebt = (debtHi << BigInt(64)) | debtLo;
            newBalances.unrefined = Number(unrefinedRaw) / 1e6;
          }
        } catch {
          // No unrefined account (no tournament wins yet)
        }

        // Get pool state for total staked
        try {
          const poolData = await connection.getAccountInfo(POOL_PDA);
          if (poolData && poolData.data.length >= 168) {
            // Pool layout: disc(8) + authority(32) + poker_mint(32) + total_burned(8) +
            //   sol_rewards_available(8) + sol_rewards_distributed(8) + accumulated_sol_per_token(16) +
            //   poker_rewards_available(8) + poker_rewards_distributed(8) + accumulated_poker_per_token(16) +
            //   total_unrefined(8) + accumulated_refined_per_token(16) + current_epoch(8) + bump(1) + pad(7)
            const totalStaked = Number(poolData.data.readBigUInt64LE(72)) / 1e9;    // total_burned @ 8+32+32=72
            const solAvailable = Number(poolData.data.readBigUInt64LE(80));          // sol_rewards_available @ 72+8=80
            const solClaimed = Number(poolData.data.readBigUInt64LE(88));            // sol_rewards_distributed @ 80+8=88
            const solDistributed = (solAvailable + solClaimed) / 1e9;               // total ever deposited for stakers
            const totalUnrefined = Number(poolData.data.readBigUInt64LE(144)) / 1e6; // total_unrefined @ 8+32+32+8+8+8+16+8+8+16=144

            // Compute refined on-the-fly (ORE pattern: lazy calculation)
            // accumulated_refined_per_token is u128 at offset 152
            const accLo = poolData.data.readBigUInt64LE(152);
            const accHi = poolData.data.readBigUInt64LE(160);
            const accRefined = (accHi << BigInt(64)) | accLo;
            let computedRefined = Number(storedRefined);
            if (unrefinedRaw > BigInt(0)) {
              const pending = Number((unrefinedRaw * accRefined - refinedDebt) / BigInt(1_000_000_000_000));
              computedRefined += pending;
            }
            newBalances.refined = computedRefined / 1e6;

            // Compute pending SOL staking rewards (lazy calculation)
            // accumulated_sol_per_token is u128 at pool offset 96
            const accSolLo = poolData.data.readBigUInt64LE(96);
            const accSolHi = poolData.data.readBigUInt64LE(104);
            const accSolPerToken = (accSolHi << BigInt(64)) | accSolLo;
            if (burnedRaw > BigInt(0)) {
              const accumulated = burnedRaw * accSolPerToken;
              const lazyPending = accumulated > solRewardDebt
                ? (accumulated - solRewardDebt) / BigInt(1_000_000_000_000)
                : BigInt(0);
              newBalances.pendingSolRewards = Number(storedPendingSol + lazyPending) / 1e9;
            } else {
              newBalances.pendingSolRewards = Number(storedPendingSol) / 1e9;
            }

            // Get circulating supply from POKER mint
            let circulatingSupply = 0;
            try {
              const mintInfo = await connection.getAccountInfo(POKER_MINT);
              if (mintInfo && mintInfo.data.length >= 44) {
                // SPL Mint layout: mintAuthority(36) + supply(8) at offset 36
                circulatingSupply = Number(mintInfo.data.readBigUInt64LE(36)) / 1e9;
              }
            } catch {}
            setPoolState(prev => {
              const next = { totalStaked, totalUnrefined, solDistributed, circulatingSupply };
              if (prev.totalStaked === next.totalStaked && prev.totalUnrefined === next.totalUnrefined &&
                  prev.solDistributed === next.solDistributed && prev.circulatingSupply === next.circulatingSupply) return prev;
              return next;
            });
          }
        } catch (e) {
          console.error('Failed to fetch pool:', e);
        }

        // Single batched balance update — skip if nothing changed
        setBalances(prev => {
          const merged = { ...prev, ...newBalances };
          // Skip re-render if values are identical
          if (JSON.stringify(prev) === JSON.stringify(merged)) return prev;
          return merged;
        });

        // Fetch queues from backend API
        try {
          const queues = await getQueues();
          setSitNGoQueues(prev => {
            const newJson = JSON.stringify(queues);
            if (JSON.stringify(prev) === newJson) return prev; // skip if unchanged
            return queues;
          });
        } catch {
          // Fallback to default queues (only if empty)
          setSitNGoQueues(prev => prev.length > 0 ? prev : [
            { id: 'hu-1', type: 'heads_up', currentPlayers: 0, maxPlayers: 2, buyIn: 0.01, tier: 0, status: 'waiting' },
            { id: '6max-1', type: '6max', currentPlayers: 0, maxPlayers: 6, buyIn: 0.01, tier: 0, status: 'waiting' },
            { id: '9max-1', type: '9max', currentPlayers: 0, maxPlayers: 9, buyIn: 0.01, tier: 0, status: 'waiting' },
          ]);
        }
      } catch (e) {
        console.error('Failed to fetch data:', e);
      }
    };

    fetchData();
    refreshPlayer(); // Initial player PDA fetch (claimableSol, stats)
    // Poll balances/queues only — refreshPlayer is on-demand (after claims, after game)
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [connected, publicKey, refreshCounter]);

  // Set seat index when connected
  useEffect(() => {
    if (connected) {
      setMySeatIndex(0);
    }
  }, [connected, setMySeatIndex]);

  // Poll for queue updates when waiting for opponent
  useEffect(() => {
    if (!waitingQueueId || !publicKey) return;
    
    console.log('Polling for queue updates:', waitingQueueId);
    
    const checkQueue = async () => {
      try {
        const queues = await getQueues();
        const myQueue = queues.find((q: SitNGoQueue) => q.id === waitingQueueId);
        console.log('Queue check:', myQueue?.id, 'tablePda:', myQueue?.tablePda);
        
        if (myQueue?.tablePda) {
          console.log('Table ready!', myQueue.tablePda);
          setActiveTable(myQueue.tablePda);
          setWaitingQueueId(null);
          setHandHistory([]); // Clear history for new game
          
          // Find my position and join on-chain
          const players = myQueue.players || [];
          const myPosition = players.indexOf(publicKey.toBase58());
          const mySeatIndex = myPosition >= 0 ? myPosition : 0;
          
          try {
            const joinSig = await joinOnChainTable(myQueue.tablePda, mySeatIndex);
            if (joinSig) {
              console.log('Joined table on-chain:', joinSig);
              addActiveGame({ tablePda: myQueue.tablePda, type: 'sng', label: `SNG ${myQueue.type === 'heads_up' ? 'HU' : myQueue.type}` });
            } else {
              console.log('On-chain join returned null (may already be joined)');
            }
          } catch (e: any) {
            console.warn('On-chain join failed (may already be joined):', e.message);
          }
          
          // Always try ready flow regardless of join result
          try {
            const readyRes = await fetch('/api/sitngos/ready', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                tablePda: myQueue.tablePda, 
                playerCount: myQueue.maxPlayers 
              }),
            });
            const readyData = await readyRes.json();
            if (readyData.success) {
              console.log('TEE/ER ready! Delegated and started:', readyData);
            } else {
              console.log('Ready pending (waiting for other players):', readyData.error);
            }
          } catch (readyErr: any) {
            console.log('Ready pending:', readyErr.message);
          }
        }
      } catch (e) {
        console.error('Queue poll error:', e);
      }
    };
    
    // Poll every 2 seconds
    const interval = setInterval(checkQueue, 2000);
    checkQueue(); // Check immediately too
    
    return () => clearInterval(interval);
  }, [waitingQueueId, publicKey, joinOnChainTable]);

  // Handle on-chain registration
  const handleRegister = async () => {
    if (!publicKey) return;
    setRegistering(true);
    try {
      await register();
      // Session key is auto-created bundled with first joinTable TX (see useJoinTable)
    } catch (e: any) {
      console.error('Registration failed:', e);
      alert('Registration failed: ' + e.message);
    } finally {
      setRegistering(false);
    }
  };

  // 1-click join Sit N Go (handles registration if needed)
  const handleJoinSitNGo = async (queueId: string) => {
    if (!publicKey) return;
    setJoiningQueue(queueId);
    try {
      // If not registered on-chain, try to register
      if (!player?.isRegistered) {
        try {
          await register();
        } catch (regError: any) {
          console.warn('On-chain registration failed, continuing anyway:', regError);
        }
      }
      
      // Resolve virtual queue IDs: prefer in_progress tables with empty seats, then waiting queues
      let resolvedQueueId = queueId;
      if (queueId.startsWith('virtual-')) {
        const vType = queueId.replace('virtual-', '');
        // First: look for an existing table with empty seats (in_progress queue)
        const joinableQueue = sitNGoQueues.find(q => q.type === vType && q.status === 'in_progress' && q.tablePda && q.emptySeats && q.emptySeats.length > 0);
        if (joinableQueue) {
          resolvedQueueId = joinableQueue.id;
        } else {
          // Fall back to a waiting queue (will create a new table)
          const realQueue = sitNGoQueues.find(q => q.type === vType && q.status === 'waiting');
          if (realQueue) {
            resolvedQueueId = realQueue.id;
          } else {
            // Refresh queues from backend
            const freshQueues = await getQueues();
            const freshJoinable = freshQueues.find(q => q.type === vType && q.status === 'in_progress' && q.tablePda && q.emptySeats && q.emptySeats.length > 0);
            const freshReal = freshJoinable || freshQueues.find(q => q.type === vType && q.status === 'waiting');
            if (freshReal) {
              resolvedQueueId = freshReal.id;
            } else {
              throw new Error('No available queue for this game type. Please try again.');
            }
          }
        }
      }
      
      // Join queue via backend API
      const result = await joinQueue(resolvedQueueId, publicKey.toBase58(), selectedTier);
      console.log('Joined queue:', result);
      
      // If table is ready (on-chain table created), join it on-chain
      if (result.queue.tablePda) {
        console.log('On-chain table ready:', result.queue.tablePda);
        
        // Use explicit emptySeat from backend if available, otherwise position - 1
        const mySeatIndex = result.queue.emptySeat ?? (result.queue.position - 1);
        console.log('Joining on-chain table at seat:', mySeatIndex);
        
        let joinedOnChain = false;
        let userRejected = false;
        try {
          const joinSig = await joinOnChainTable(result.queue.tablePda, mySeatIndex);
          if (joinSig) {
            console.log('Joined table on-chain:', joinSig);
            joinedOnChain = true;
            addActiveGame({ tablePda: result.queue.tablePda, type: 'sng', label: `SNG ${result.queue.type === 'heads_up' ? 'HU' : result.queue.type}` });
            reloadSession();
          }
        } catch (joinError: any) {
          console.error('On-chain join failed:', joinError.message);
          // Only roll back if user explicitly rejected/cancelled the TX
          const msg = joinError.message?.toLowerCase() || '';
          userRejected = msg.includes('user rejected') || msg.includes('cancelled') || msg.includes('user denied');
          if (userRejected) {
            try {
              await leaveQueue(result.queue.id, publicKey.toBase58());
              console.log('Rolled back backend queue entry after user rejection');
            } catch (rollbackErr: any) {
              console.warn('Failed to roll back queue entry:', rollbackErr.message);
            }
            throw new Error('Transaction cancelled.');
          }
          // For other failures (timing, table not ready yet), continue to game view
          console.log('Join TX failed but not user rejection — navigating to game view for retry');
        }
        
        setActiveTable(result.queue.tablePda);
        setView('game');
        
        // Trigger TEE/ER ready flow in background (don't block navigation)
        fetch('/api/sitngos/ready', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            tablePda: result.queue.tablePda, 
            playerCount: result.queue.maxPlayers 
          }),
        }).then(r => r.json()).then(d => {
          if (d.success) console.log('TEE/ER ready! Game delegated and started:', d);
          else console.log('Ready flow pending (waiting for other players):', d.error);
        }).catch(e => console.warn('Ready flow not triggered yet:', e.message));
      } else {
        // Queue not full yet - poll until table is created (no DEMO mode)
        setWaitingQueueId(result.queue.id);
        setView('game');
      }
    } catch (e: any) {
      console.error('Join failed:', e);
      alert('Failed to join: ' + e.message);
    } finally {
      setJoiningQueue(null);
    }
  };

  // Leave a SNG queue before it fills
  const handleLeaveQueue = async (queueId: string) => {
    if (!publicKey) return;
    setLeavingQueue(queueId);
    try {
      const { leaveQueue } = await import('@/lib/api');
      await leaveQueue(queueId, publicKey.toBase58());
      // Refresh queue list
      const { getQueues } = await import('@/lib/api');
      const queues = await getQueues();
      setSitNGoQueues(queues);
    } catch (e: any) {
      console.error('Leave queue failed:', e);
      alert('Failed to leave queue: ' + e.message);
    } finally {
      setLeavingQueue(null);
    }
  };

  // Handle player action - send to on-chain
  const [actionPending, setActionPending] = useState(false);
  const handleGameAction = async (action: string, amount?: number) => {
    console.log('Player action:', action, amount);
    setActionPending(true);
    
    try {
      // Handle showdown settlement separately
      if (action === 'showdown' && activeTable) {
        try {
          showToast('Settling showdown...', 'info');
          const response = await fetch('/api/showdown', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tablePda: activeTable }),
          });
          const result = await response.json();
          if (result.success) {
            showToast('Showdown settled!', 'success');
          } else {
            showToast(`Settlement failed: ${result.error}`, 'error');
          }
        } catch (e: any) {
          showToast(`Settlement failed: ${e.message}`, 'error');
        }
        return;
      }
      
      // Use on-chain action if table exists
      if (activeTable && sendOnChainAction) {
        try {
          const actionType = action as 'fold' | 'check' | 'call' | 'raise' | 'allin';
          const sig = await sendOnChainAction(actionType, amount);
          if (sig) {
            console.log('On-chain action confirmed:', sig);
            showToast(`${action.toUpperCase()} confirmed!`, 'success');
            // Track action in hand history + seat overlay
            const actionLabel = amount ? `${action.toUpperCase()} ${amount}` : action.toUpperCase();
            setHandHistory(prev => [...prev, {
              player: 'You',
              action: actionLabel,
              amount: amount,
              phase: gameState?.phase || 'Unknown'
            }]);
            if (gameState?.mySeatIndex !== undefined && gameState.mySeatIndex >= 0) {
              setPlayerActions(prev => [...prev.filter(a => a.seatIndex !== gameState.mySeatIndex), { seatIndex: gameState.mySeatIndex, action: actionLabel, timestamp: Date.now() }]);
            }
          }
        } catch (e: any) {
          console.error('On-chain action failed:', e.message);
          // Session expired — try auto-extend then retry the action once
          if (e.message?.includes('Session expired') || e.message?.includes('Reconnecting session') || e.message?.includes('InvalidSessionKey')) {
            showToast('Session expired — extending automatically...', 'info');
            try {
              await topUpSession();
              reloadSession();
              showToast('Session extended! Retrying action...', 'success');
              // Retry the action once after extending
              try {
                const retrySig = await sendOnChainAction(action as any, amount);
                if (retrySig) {
                  showToast(`${action.toUpperCase()} confirmed!`, 'success');
                  const actionLabel = amount ? `${action.toUpperCase()} ${amount}` : action.toUpperCase();
                  setHandHistory(prev => [...prev, { player: 'You', action: actionLabel, amount, phase: gameState?.phase || 'Unknown' }]);
                }
              } catch (retryErr: any) {
                showToast(`Retry failed: ${retryErr.message?.slice(0, 80)}`, 'error');
              }
            } catch (extendErr: any) {
              showToast('Auto-extend failed — click "Extend Session" in the footer bar below.', 'error');
              reloadSession();
            }
            return;
          }
          // Parse error message for user-friendly display
          let errorMsg = e.message;
          if (errorMsg.includes('NotPlayersTurn')) {
            errorMsg = "Not your turn";
          } else if (errorMsg.includes('InvalidActionForPhase')) {
            errorMsg = "Invalid action for current phase";
          } else if (errorMsg.includes('InsufficientChips')) {
            errorMsg = "Insufficient chips";
          } else if (errorMsg.includes('User rejected')) {
            errorMsg = "Transaction cancelled";
          } else if (errorMsg.length > 100) {
            errorMsg = errorMsg.slice(0, 100) + '...';
          }
          showToast(`Action failed: ${errorMsg}`, 'error');
        }
      }
    } finally {
      setActionPending(false);
    }
  };

  // Leave table (on-chain leave_table TX + backend queue update)
  const [leavingTable, setLeavingTable] = useState(false);
  const handleLeaveTable = async () => {
    // For SNGs in Waiting phase: send leave_table on L1 (undelegated SNG leave flow)
    // For cash games: skip — leave_cash_game is sent via onLeaveCashGame on ER
    const isCashGame = onChainGameState?.isCashGame;
    if (!isCashGame && activeTable && publicKey && onChainGameState && onChainGameState.mySeatIndex >= 0 && onChainGameState.phase === 'Waiting') {
      setLeavingTable(true);
      try {
        const connection = new Connection(L1_RPC_DIRECT, 'confirmed');
        const tablePubkey = new PublicKey(activeTable);
        const ix = buildLeaveTableInstruction(publicKey, tablePubkey, onChainGameState.mySeatIndex);
        const tx = new Transaction().add(ix);
        tx.feePayer = publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        const sig = await sendTransaction(tx, connection);
        await connection.confirmTransaction(sig, 'confirmed');
        console.log('Left table on-chain:', sig);

        // Also remove from backend queue state
        try {
          // Find which queue tracks this table
          const queues = await getQueues();
          const matchingQueue = queues.find(q => q.tablePda === activeTable);
          if (matchingQueue) {
            await leaveQueue(matchingQueue.id, publicKey.toBase58());
          }
        } catch (e) {
          console.warn('Backend queue leave failed (non-critical):', e);
        }
      } catch (e: any) {
        console.error('Leave table TX failed:', e);
        showToast('Failed to leave table: ' + (e.message || 'Unknown error'), 'error');
        setLeavingTable(false);
        return; // Don't navigate away if TX failed
      }
      setLeavingTable(false);
    }

    if (activeTable) removeActiveGame(activeTable);
    setActiveTable(null);
    setGameCompleteState(null);
    setView('lobby');
    // Refresh queues and player data so lobby reflects the change
    try {
      const queues = await getQueues();
      setSitNGoQueues(queues);
    } catch (e) {}
    refreshPlayer(); // Refresh claimableSol after game
    setRefreshCounter(c => c + 1); // Also refresh balances
  };

  const handleClaimUnrefined = async () => {
    if (!publicKey || !sendTransaction || balances.unrefined <= 0) return;
    setClaiming(true);
    try {
      const connection = new Connection(L1_RPC_DIRECT, 'confirmed');
      const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, publicKey);
      const [unrefinedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('unrefined'), publicKey.toBuffer()],
        STEEL_PROGRAM_ID
      );
      const [mintAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool')],
        STEEL_PROGRAM_ID
      );

      // ClaimAll discriminator = 6 (claims unrefined @ 90% + all refined in one TX)
      // Accounts: winner(signer), unrefined(mut), pool(mut), token_account(mut), mint(mut), mint_authority, token_program
      const data = Buffer.alloc(1);
      data.writeUInt8(6, 0);

      const ix = new TransactionInstruction({
        programId: STEEL_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: unrefinedPda, isSigner: false, isWritable: true },
          { pubkey: POOL_PDA, isSigner: false, isWritable: true },
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: POKER_MINT, isSigner: false, isWritable: true },
          { pubkey: mintAuthority, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });

      const tx = new Transaction();

      // Create ATA if it doesn't exist (first time receiving POKER)
      try {
        await getAccount(connection, tokenAccount);
      } catch {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, tokenAccount, publicKey, POKER_MINT));
      }

      tx.add(ix);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig);
      // Refresh all data immediately (balances, pool state, circulating supply)
      setRefreshCounter(c => c + 1);
    } catch (e: any) {
      console.error('Claim failed:', e);
      alert('Claim failed: ' + e.message);
    } finally {
      setClaiming(false);
    }
  };

  const handleClaimSolWinnings = async () => {
    if (!publicKey || !sendTransaction || !player?.claimableSol) return;
    setClaimingSol(true);
    try {
      const connection = new Connection(L1_RPC_DIRECT, 'confirmed');
      const [playerPda] = getPlayerPda(publicKey);

      // claim_sol_winnings: player(signer,mut), player_account(mut), system_program
      const ix = new TransactionInstruction({
        programId: ANCHOR_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: playerPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: CLAIM_SOL_DISC,
      });

      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
      showToast(`Claimed ${(player.claimableSol / 1e9).toFixed(4)} SOL!`, 'success');
      setRefreshCounter(c => c + 1);
    } catch (e: any) {
      console.error('Claim SOL failed:', e);
      showToast('Claim SOL failed: ' + e.message, 'error');
    } finally {
      setClaimingSol(false);
    }
  };

  return (
    <main className="min-h-screen">
      {/* Toast Notification */}
      {toast && (
        <div 
          className={`fixed top-16 right-4 z-[100] px-5 py-3 rounded-xl shadow-2xl max-w-md border backdrop-blur-xl ${
            toast.type === 'error' ? 'bg-red-500/10 border-red-500/30 text-red-300' : 
            toast.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 
            'bg-cyan-500/10 border-cyan-500/30 text-cyan-300'
          }`}
        >
          <div className="flex items-center gap-3">
            <span className="text-sm shrink-0">{toast.type === 'error' ? '✗' : toast.type === 'success' ? '✓' : '◆'}</span>
            <span className="text-sm font-medium flex-1">{toast.message}</span>
            <button onClick={() => setToast(null)} className="text-white/40 hover:text-white/70 text-lg">×</button>
          </div>
        </div>
      )}

      {/* Retry Join Modal */}
      {pendingJoin && joinError && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[200]">
          <div className="glass-card p-6 max-w-md border-red-500/20">
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-3">
                <span className="text-red-400 text-lg">!</span>
              </div>
              <h3 className="text-lg font-bold text-white mb-2">Transaction Failed</h3>
              <p className="text-gray-400 text-sm mb-5">
                {joinError.includes('insufficient') ? 'Not enough SOL for transaction fees.' : joinError.slice(0, 100)}
              </p>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={clearJoinError}
                  className="px-4 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-gray-300 hover:bg-white/[0.08] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    const sig = await retryJoin();
                    if (sig) {
                      showToast('Joined successfully!', 'success');
                    }
                  }}
                  disabled={isJoiningOnChain}
                  className="px-4 py-2 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-bold hover:bg-cyan-500/20 transition-colors disabled:opacity-50"
                >
                  {isJoiningOnChain ? 'Retrying...' : 'Retry Join'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 py-8">
        {!connected ? (
          /* ─── Landing Screen ─── */
          <div className="text-center py-24">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 mb-6">
              <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse" />
              <span className="text-cyan-400 text-xs font-medium">Live on Solana Devnet</span>
            </div>
            <h2 className="text-5xl font-bold text-white mb-3 tracking-tight">
              <span className="text-cyan-400 text-glow-cyan">FAST</span> POKER
            </h2>
            <p className="text-lg text-gray-400 mb-2">Lightning-fast Texas Hold'em on Solana</p>
            <p className="text-gray-500 mb-10 max-w-lg mx-auto">
              Win Sit & Go tournaments to mint $POKER tokens. MPC-powered card privacy.
              Your hole cards are encrypted and only visible to you.
            </p>
            <div className="flex flex-col items-center gap-5">
              <WalletMultiButton />
              <p className="text-emerald-400/70 text-sm">New players get {getFreeEntriesOnRegister()} FREE Sit & Go entries</p>
            </div>

            {/* Feature cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-16 max-w-3xl mx-auto">
              <div className="glass-card p-5 text-left">
                <div className="text-cyan-400 text-lg mb-2">&#9813;</div>
                <h3 className="text-white font-medium text-sm mb-1">MPC Privacy</h3>
                <p className="text-gray-500 text-xs">Hole cards encrypted via Arcium MPC — only you can decrypt</p>
              </div>
              <div className="glass-card p-5 text-left">
                <div className="text-emerald-400 text-lg mb-2">&#9830;</div>
                <h3 className="text-white font-medium text-sm mb-1">Win to Mint</h3>
                <p className="text-gray-500 text-xs">Win tournaments to mint new $POKER tokens</p>
              </div>
              <div className="glass-card p-5 text-left">
                <div className="text-amber-400 text-lg mb-2">&#9827;</div>
                <h3 className="text-white font-medium text-sm mb-1">Burn to Earn</h3>
                <p className="text-gray-500 text-xs">Stake $POKER to earn from every game played</p>
              </div>
            </div>
          </div>
        ) : playerLoading && !player ? (
          <div className="text-center py-24">
            <div className="w-8 h-8 border-2 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin mx-auto mb-4" />
            <div className="text-gray-500 text-sm">Loading player data...</div>
          </div>
        ) : !player?.isRegistered ? (
          /* ─── Registration Screen ─── */
          <div className="text-center py-20">
            <div className="glass-card inline-block p-8 max-w-md">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-emerald-500/20 border border-cyan-500/20 flex items-center justify-center mx-auto mb-5">
                <span className="text-cyan-400 text-2xl">&#9824;</span>
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">Welcome to FAST POKER</h2>
              <p className="text-gray-400 text-sm mb-1">Register on-chain to start playing</p>
              {getFreeEntriesOnRegister() > 0 && <p className="text-emerald-400/70 text-sm mb-6">{getFreeEntriesOnRegister()} FREE Sit & Go entries on signup</p>}
              <button
                onClick={handleRegister}
                disabled={registering}
                className="w-full px-6 py-3 rounded-xl bg-gradient-to-r from-cyan-500/15 to-emerald-500/15 border border-cyan-500/30 text-cyan-300 font-bold hover:from-cyan-500/25 hover:to-emerald-500/25 transition-all disabled:opacity-50"
              >
                {registering ? 'Registering...' : 'Register & Play'}
              </button>
              <p className="text-gray-600 text-xs mt-3">{getRegistrationCost() > 0 ? `One-time cost: ${getRegistrationCost()} SOL` : 'Free — only pays network rent'}</p>
            </div>
          </div>
        ) : view === 'lobby' ? (
          <Lobby 
            onJoinTable={handleJoinSitNGo}
            onLeaveQueue={handleLeaveQueue}
            leavingQueue={leavingQueue}
            onResumeGame={(tablePda) => {
              // Ensure session is loaded before entering game view
              reloadSession();
              setActiveTable(tablePda);
              setView('game');
              // Re-trigger ready flow in case it didn't complete previously
              const queue = sitNGoQueues.find(q => q.tablePda === tablePda);
              if (queue) {
                fetch('/api/sitngos/ready', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ tablePda, playerCount: queue.maxPlayers }),
                }).then(r => r.json()).then(d => {
                  if (d.success) console.log('Ready flow triggered on resume:', d);
                  else console.log('Ready on resume pending:', d.error);
                }).catch(() => {});
              }
            }}
            balances={balances} 
            poolState={poolState}
            player={player}
            sitNGoQueues={sitNGoQueues}
            onClaimUnrefined={handleClaimUnrefined}
            claiming={claiming}
            joiningQueue={joiningQueue}
            session={session}
            onTopUp={() => topUpSession().catch(() => {})}
            selectedTier={selectedTier}
            onTierChange={setSelectedTier}
            onClaimSol={handleClaimSolWinnings}
            claimingSol={claimingSol}
          />
        ) : (
          <GameView 
            gameState={gameState}
            gameError={gameError}
            onAction={handleGameAction}
            onLeave={handleLeaveTable}
            onLeaveCashGame={async () => {
              if (sendOnChainAction) {
                try {
                  await sendOnChainAction('leave_cash_game');
                  showToast('Marked as leaving — cashing out after this hand', 'info');
                } catch (e: any) {
                  showToast('Leave failed: ' + (e.message || 'Unknown error'), 'error');
                }
              }
            }}
            leavingTable={leavingTable}
            wsConnected={gameConnected}
            activeTable={activeTable}
            isPending={isPendingAction}
            handHistory={handHistory}
            sessionActive={session.isActive && !!session.sessionKey}
            sessionStatus={session.status}
            sessionBalance={session.balance}
            onCreateSession={async () => {
              try {
                await createSession();
                showToast('Session created! You can now play.', 'success');
              } catch (e: any) {
                showToast('Failed to create session: ' + (e.message || 'Unknown error'), 'error');
              }
            }}
            onReclaimSession={async () => {
              try {
                const sig = await reclaimSession();
                showToast(`Session SOL reclaimed back to wallet (${(session.balance / 1e9).toFixed(4)} SOL)`, 'success');
              } catch (e: any) {
                showToast('Reclaim failed: ' + (e.message || 'Unknown error'), 'error');
              }
            }}
            sessionLoading={sessionLoading}
            waitingForPlayers={!!waitingQueueId}
            actionPending={actionPending}
            showdownPot={showdownPot}
            playerActions={playerActions}
            pastHands={pastHands}
            viewingPastHand={viewingPastHand}
            onHandNav={setViewingPastHand}
          />
        )}
      </div>

      {/* Spacer for fixed footer */}
      <div className="h-10" />
    </main>
  );
}

interface GameViewProps {
  gameState: {
    phase: string;
    pot: number;
    currentPlayer: number;
    communityCards: number[];
    players: any[];
    myCards?: [number, number];
    blinds?: { small: number; big: number };
    dealerSeat?: number;
    mySeatIndex?: number;
    tier?: number;
    prizePool?: number;
    maxPlayers?: number;
    lastActionSlot?: number;
    blindLevel?: number;
    tournamentStartTime?: number;
    currentBet?: number;
    tokenMint?: string;
    isCashGame?: boolean;
    isMyLeaving?: boolean;
  } | null;
  onAction: (action: string, amount?: number) => void;
  onLeave: () => void;
  onLeaveCashGame?: () => void;
  leavingTable?: boolean;
  wsConnected: boolean;
  activeTable: string | null;
  handHistory?: { player: string; action: string; amount?: number; phase: string }[];
  waitingForPlayers?: boolean;
  actionPending?: boolean;
  showdownPot?: number;
  playerActions?: { seatIndex: number; action: string; timestamp: number }[];
  pastHands?: { player: string; action: string; amount?: number; phase: string }[][];
  viewingPastHand?: number | null;
  onHandNav?: (index: number | null) => void;
  sessionStatus?: string;
  sessionBalance?: number;
  onCreateSession?: () => void;
  onReclaimSession?: () => void;
  sessionLoading?: boolean;
  gameError?: string | null;
}

function GameView({ gameState, onAction, onLeave, onLeaveCashGame, leavingTable, wsConnected, activeTable, isPending, handHistory = [], sessionActive, sessionStatus, sessionBalance = 0, onCreateSession, onReclaimSession, sessionLoading, waitingForPlayers, actionPending, showdownPot, playerActions = [], pastHands = [], viewingPastHand = null, onHandNav, gameError }: GameViewProps & { isPending?: boolean; sessionActive?: boolean }) {
  const { publicKey } = useWallet();

  if (gameError === 'TABLE_NOT_FOUND') {
    return (
      <div className="text-center py-20">
        <div className="w-16 h-16 mx-auto rounded-full bg-gray-800 border border-white/10 flex items-center justify-center mb-5">
          <svg className="w-8 h-8 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
        </div>
        <h3 className="text-lg font-bold text-white mb-2">Table Not Found</h3>
        <p className="text-gray-500 text-sm mb-6">This table has been closed or no longer exists.</p>
        <button
          onClick={onLeave}
          className="px-5 py-2 rounded-xl bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 text-sm hover:bg-cyan-500/20 transition-colors"
        >
          Back to Lobby
        </button>
      </div>
    );
  }

  if (!gameState) {
    return (
      <div className="text-center py-20">
        <div className="w-10 h-10 border-2 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin mx-auto mb-5" />
        {waitingForPlayers ? (
          <>
            <h3 className="text-lg font-bold text-white mb-2">Waiting for Players...</h3>
            <p className="text-gray-500 text-sm mb-6">Searching for opponents. Table will be created once all seats are filled.</p>
          </>
        ) : (
          <>
            <h3 className="text-lg font-bold text-white mb-2">Connecting to Table...</h3>
            <p className="text-gray-500 text-sm mb-6">Loading on-chain game state</p>
          </>
        )}
        <button
          onClick={onLeave}
          className="px-5 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-gray-300 text-sm hover:bg-white/[0.08] transition-colors"
        >
          Back to Lobby
        </button>
      </div>
    );
  }

  const isMyTurn = gameState.currentPlayer >= 0 && 
    gameState.mySeatIndex != null &&
    gameState.mySeatIndex === gameState.currentPlayer;

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold text-white">{gameState.isCashGame ? 'Cash Game' : 'Sit & Go'}</h2>
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
            <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-emerald-400' : 'bg-amber-400'} animate-pulse`} />
            <span className="text-emerald-400 text-[10px] font-bold">ON-CHAIN</span>
          </div>
          {isPending && (
            <div className="px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/20">
              <span className="text-cyan-400 text-[10px] font-bold animate-pulse">TX PENDING</span>
            </div>
          )}
        </div>
        {/* Cash game: leave anytime. SNG: only during Waiting */}
        {gameState.isCashGame ? (
          gameState.isMyLeaving ? (
            <span className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400/60 text-xs font-bold">
              Leaving...
            </span>
          ) : gameState.phase === 'Waiting' ? (
            <button
              onClick={async () => {
                if (onLeaveCashGame) {
                  await onLeaveCashGame();
                }
                onLeave();
              }}
              disabled={leavingTable}
              className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400 text-xs font-bold hover:bg-red-500/20 transition-colors disabled:opacity-30"
            >
              {leavingTable ? 'Leaving...' : 'Leave Table'}
            </button>
          ) : (
            <button
              onClick={onLeaveCashGame}
              disabled={leavingTable}
              className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400 text-xs font-bold hover:bg-red-500/20 transition-colors disabled:opacity-30"
            >
              Leave After This Hand
            </button>
          )
        ) : gameState.phase === 'Waiting' ? (
          <button
            onClick={onLeave}
            disabled={leavingTable}
            className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400 text-xs font-bold hover:bg-red-500/20 transition-colors disabled:opacity-30"
          >
            {leavingTable ? 'Leaving...' : 'Leave Table'}
          </button>
        ) : null}
      </div>

      {/* Table info pills — blinds · phase (no rake for SNG) */}
      <div className="flex items-center gap-2 flex-wrap">
        {gameState.blinds && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.08]">
            <span className="text-gray-500 text-[10px] font-medium">BLINDS</span>
            <span className="text-white text-xs font-bold tabular-nums">
              {gameState.blinds.small}/{gameState.blinds.big}
            </span>
          </div>
        )}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.08]">
          <span className="text-gray-500 text-[10px] font-medium">PHASE</span>
          <span className="text-cyan-400 text-xs font-bold">{gameState.phase}</span>
        </div>
        {gameState.blindLevel !== undefined && gameState.blindLevel > 0 && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.08]">
            <span className="text-gray-500 text-[10px] font-medium">LEVEL</span>
            <span className="text-amber-400 text-xs font-bold">{gameState.blindLevel}</span>
          </div>
        )}
      </div>

      {/* Poker table */}
      <PokerTable
        tablePda={activeTable || ''}
        phase={gameState.phase}
        pot={gameState.pot}
        currentPlayer={gameState.currentPlayer}
        communityCards={gameState.communityCards}
        players={gameState.players}
        myCards={gameState.myCards}
        onAction={onAction}
        isMyTurn={isMyTurn}
        blinds={gameState.blinds}
        dealerSeat={(gameState as any).dealerSeat ?? 0}
        maxSeats={gameState.maxPlayers || 2}
        handHistory={handHistory}
        actionPending={actionPending}
        showdownPot={showdownPot}
        tier={gameState.tier}
        prizePool={gameState.prizePool}
        maxPlayers={gameState.maxPlayers}
        lastActionSlot={gameState.lastActionSlot}
        playerActions={playerActions}
        pastHands={pastHands}
        viewingPastHand={viewingPastHand}
        onHandNav={onHandNav}
        blindLevel={gameState.blindLevel}
        tournamentStartTime={gameState.tournamentStartTime}
        currentBet={gameState.currentBet}
        tokenMint={gameState.tokenMint}
      />
    </div>
  );
}
