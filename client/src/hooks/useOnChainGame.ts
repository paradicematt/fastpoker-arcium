import { useCallback, useEffect, useState, useRef } from 'react';
import { Connection, PublicKey, Transaction, Keypair } from '@solana/web3.js';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PLAYER_ACCOUNT_OFFSETS, levelFromXp } from '@/lib/constants';
import {
  TableState,
  SeatState,
  parseTableState,
  parseSeatState,
  buildPlayerActionInstruction,
  buildUseTimeBankInstruction,
  buildSitOutInstruction,
  buildSitInInstruction,
  getSeatPda,
  getSeatCardsPda,
  getPlayerPda,
  ActionType,
  OnChainPhase,
  SeatStatus,
  phaseToString,
  TABLE_OFFSETS,
} from '@/lib/onchain-game';
import { ANCHOR_PROGRAM_ID } from '@/lib/constants';

// XP cache (60s TTL) to avoid L1 reads every poll
const _xpCache = new Map<string, { level: number; fetchedAt: number }>();
const XP_CACHE_TTL = 60_000;

// Phase-aware polling delay
function getPhaseDelay(phase: string): number {
  switch (phase) {
    case 'Waiting': return 4000;
    case 'Complete': return 5000;
    case 'Showdown': return 2000;
    case 'AwaitingDeal': return 2000;     // MPC pending — poll faster
    case 'AwaitingShowdown': return 2000; // MPC pending — poll faster
    default: return 1500; // Active play phases
  }
}

export interface GamePlayer {
  pubkey: string;
  chips: number;
  bet: number;
  folded: boolean;
  isActive: boolean;
  isSittingOut: boolean;
  isLeaving: boolean;
  seatIndex: number;
  position?: 'SB' | 'BB' | 'BTN';
  holeCards?: [number, number]; // Revealed at showdown
  level?: number;
  sitOutButtonCount?: number;
  handsSinceBust?: number;
  sitOutTimestamp?: number;
  timeBankSeconds?: number;
  timeBankActive?: boolean;
}

export interface OnChainGameState {
  tablePda: string;
  phase: string;
  pot: number;
  currentPlayer: number;
  communityCards: number[];
  players: GamePlayer[];
  myCards?: [number, number];
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  blinds: { small: number; big: number };
  currentBet: number;
  handNumber: number;
  mySeatIndex: number;
  tier: number;
  prizePool: number;
  maxPlayers: number;
  lastActionSlot: number;
  blindLevel: number;
  tournamentStartTime: number;
  tokenMint: string;
  isCashGame: boolean;
  isMyLeaving: boolean;
}

interface UseOnChainGameReturn {
  gameState: OnChainGameState | null;
  isLoading: boolean;
  error: string | null;
  isConnected: boolean;
  sendAction: (action: 'fold' | 'check' | 'call' | 'raise' | 'allin' | 'sit_out' | 'return_to_play' | 'leave_cash_game' | 'use_time_bank', amount?: number) => Promise<string | null>;
  isPendingAction: boolean;
  refreshState: () => Promise<void>;
}

/**
 * Arcium L1-only game state hook.
 * All game state is read from Solana L1 — no TEE, no ER delegation.
 * Card privacy is handled by MPC encryption, not access control.
 */
export function useOnChainGame(
  tablePdaString: string | null,
  sessionKey?: Keypair | null,
): UseOnChainGameReturn {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [gameState, setGameState] = useState<OnChainGameState | null>(null);
  const [isLoading, setIsLoading] = useState(!!tablePdaString);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isPendingAction, setIsPendingAction] = useState(false);

  const tablePdaRef = useRef<PublicKey | null>(null);
  // Nonce tracking — skip seat re-reads if table unchanged
  const lastNonceRef = useRef<string>('');
  const lastPlayersRef = useRef<GamePlayer[]>([]);

  // Fetch and parse all game state from L1
  const fetchGameState = useCallback(async (tablePda: PublicKey): Promise<OnChainGameState | null> => {
    if (!publicKey) return null;

    try {
      // Read table account from L1
      const tableInfo = await connection.getAccountInfo(tablePda);
      if (!tableInfo) {
        throw new Error('TABLE_NOT_FOUND');
      }

      const tableState = parseTableState(tableInfo.data as Buffer);
      if (!tableState) {
        console.error('Failed to parse table state');
        return null;
      }

      const players: GamePlayer[] = [];
      let mySeatIndex = -1;
      let myCards: [number, number] | undefined;

      // Nonce check — skip seat re-reads if table state unchanged
      const nonce = `${tableState.handNumber}:${tableState.phase}:${tableState.currentPlayer}:${tableState.pot}:${tableState.seatsOccupied}`;
      const nonceUnchanged = nonce === lastNonceRef.current && lastPlayersRef.current.length > 0;

      // Skip empty seats — only read occupied seats via bitmask
      const occupiedIndices: number[] = [];
      for (let i = 0; i < tableState.maxPlayers; i++) {
        if (tableState.seatsOccupied & (1 << i)) occupiedIndices.push(i);
      }

      const seatPdas: { index: number; pda: PublicKey }[] = occupiedIndices.map(i => ({
        index: i, pda: getSeatPda(tablePda, i)[0],
      }));

      // If nonce unchanged, reuse last seat data (skip RPC entirely)
      if (nonceUnchanged) {
        players.push(...lastPlayersRef.current);
        mySeatIndex = lastPlayersRef.current.find(p => {
          const pk = new PublicKey(p.pubkey);
          return (sessionKey && pk.equals(sessionKey.publicKey)) || pk.equals(publicKey);
        })?.seatIndex ?? -1;
      } else {
        // Batch-fetch seat accounts from L1
        const seatAccounts = await Promise.all(
          seatPdas.map(({ pda }) => connection.getAccountInfo(pda).catch(() => null))
        );

        for (let j = 0; j < seatPdas.length; j++) {
          const i = seatPdas[j].index;
          const seatInfo = seatAccounts[j];
          if (!seatInfo) continue;

          const seatState = parseSeatState(seatInfo.data as Buffer);
          if (!seatState || seatState.status === SeatStatus.Empty) continue;
          if (seatState.status === SeatStatus.Busted) continue;
          if (seatState.player.equals(PublicKey.default)) continue;

          const isMe = (sessionKey && seatState.player.equals(sessionKey.publicKey)) ||
                       seatState.player.equals(publicKey);
          if (isMe) mySeatIndex = i;

          let position: 'SB' | 'BB' | 'BTN' | undefined;
          if (i === tableState.smallBlindSeat) position = 'SB';
          else if (i === tableState.bigBlindSeat) position = 'BB';

          // Opponent hole cards: only from table.revealed_hands (showdown)
          let holeCards: [number, number] | undefined;
          if (!isMe) {
            const tableData = tableInfo.data as Buffer;
            const rhOff = TABLE_OFFSETS.REVEALED_HANDS + i * 2;
            if (tableData.length > rhOff + 1) {
              const rc1 = tableData[rhOff];
              const rc2 = tableData[rhOff + 1];
              if (rc1 !== 255 && rc2 !== 255) {
                holeCards = [rc1, rc2];
              }
            }
          }

          players.push({
            pubkey: seatState.player.toBase58(),
            chips: seatState.chips,
            bet: seatState.betThisRound,
            folded: seatState.status === SeatStatus.Folded,
            isActive: seatState.status === SeatStatus.Active || seatState.status === SeatStatus.AllIn || seatState.status === SeatStatus.Leaving,
            isSittingOut: seatState.status === SeatStatus.SittingOut,
            isLeaving: seatState.status === SeatStatus.Leaving,
            seatIndex: i,
            position,
            holeCards,
            sitOutButtonCount: seatState.sitOutButtonCount,
            handsSinceBust: seatState.handsSinceBust,
            sitOutTimestamp: seatState.sitOutTimestamp,
            timeBankSeconds: seatState.timeBankSeconds,
            timeBankActive: seatState.timeBankActive,
          });
        }
      }

      // Batch-fetch PlayerAccount PDAs from L1 — with 60s XP cache
      if (players.length > 0) {
        const now = Date.now();
        const uncachedPlayers: { idx: number; pubkey: string }[] = [];
        for (let idx = 0; idx < players.length; idx++) {
          const cached = _xpCache.get(players[idx].pubkey);
          if (cached && (now - cached.fetchedAt) < XP_CACHE_TTL) {
            players[idx].level = cached.level;
          } else {
            uncachedPlayers.push({ idx, pubkey: players[idx].pubkey });
          }
        }
        if (uncachedPlayers.length > 0) {
          try {
            const playerPdas = uncachedPlayers.map(p => getPlayerPda(new PublicKey(p.pubkey))[0]);
            const playerAccounts = await connection.getMultipleAccountsInfo(playerPdas);
            for (let j = 0; j < uncachedPlayers.length; j++) {
              const acctInfo = playerAccounts[j];
              if (acctInfo && acctInfo.data.length > PLAYER_ACCOUNT_OFFSETS.XP + 8) {
                const data = acctInfo.data as Buffer;
                const xp = Number(data.readBigUInt64LE(PLAYER_ACCOUNT_OFFSETS.XP));
                const level = levelFromXp(xp);
                players[uncachedPlayers[j].idx].level = level;
                _xpCache.set(uncachedPlayers[j].pubkey, { level, fetchedAt: now });
              }
            }
          } catch {
            // PlayerAccount may not exist for unregistered players
          }
        }
      }

      // Own hole cards: read plaintext card1/card2 from SeatCards (written at showdown reveal)
      // During active play, these are 255 — encrypted cards require ArciumCardDecryptor (separate hook)
      if (mySeatIndex >= 0 && tableState.phase >= OnChainPhase.Preflop) {
        const [mySeatCardsPda] = getSeatCardsPda(tablePda, mySeatIndex);
        try {
          const seatCardsInfo = await connection.getAccountInfo(mySeatCardsPda);
          if (seatCardsInfo && seatCardsInfo.data.length >= 75) {
            const card1 = seatCardsInfo.data[73];
            const card2 = seatCardsInfo.data[74];
            if (card1 !== 255 && card2 !== 255) {
              myCards = [card1, card2];
            }
          }
        } catch (e: any) {
          console.warn('[cards] seat_cards read failed:', e.message?.slice(0, 100));
        }
      }

      // Update nonce cache
      lastNonceRef.current = nonce;
      lastPlayersRef.current = players;

      return {
        tablePda: tablePda.toBase58(),
        phase: phaseToString(tableState.phase),
        pot: tableState.pot,
        currentPlayer: tableState.currentPlayer,
        communityCards: tableState.communityCards,
        players,
        myCards,
        dealerSeat: tableState.dealerButton,
        smallBlindSeat: tableState.smallBlindSeat,
        bigBlindSeat: tableState.bigBlindSeat,
        blinds: { small: tableState.smallBlind, big: tableState.bigBlind },
        currentBet: tableState.currentBet,
        handNumber: tableState.handNumber,
        mySeatIndex,
        isCashGame: tableState.gameType === 3,
        isMyLeaving: mySeatIndex >= 0 && players.find(p => p.seatIndex === mySeatIndex)?.isLeaving === true,
        tier: tableState.tier,
        prizePool: tableState.prizePool,
        maxPlayers: tableState.maxPlayers,
        lastActionSlot: tableState.lastActionTime,
        blindLevel: tableState.blindLevel,
        tournamentStartTime: tableState.tournamentStartTime,
        tokenMint: tableState.tokenMint,
      };
    } catch (err: any) {
      if (err?.message === 'TABLE_NOT_FOUND') throw err;
      console.error('Error fetching game state:', err);
      return null;
    }
  }, [publicKey, sessionKey, connection]);

  // Refresh state manually
  const refreshState = useCallback(async () => {
    if (!tablePdaRef.current) return;
    setIsLoading(true);
    const state = await fetchGameState(tablePdaRef.current);
    if (state) {
      setGameState(state);
      setError(null);
    }
    setIsLoading(false);
  }, [fetchGameState]);

  // Subscribe to table account changes (L1 polling)
  useEffect(() => {
    if (!tablePdaString || !publicKey) {
      setGameState(null);
      setIsConnected(false);
      return;
    }

    let tablePda: PublicKey;
    try {
      tablePda = new PublicKey(tablePdaString);
      tablePdaRef.current = tablePda;
    } catch {
      setError('Invalid table PDA');
      return;
    }

    setIsLoading(true);

    let active = true;
    let lastPhase = '';
    let errorCount = 0;
    let tableNotFound = false;

    // Initial fetch
    fetchGameState(tablePda).then((state) => {
      if (state) {
        setGameState(state);
        setIsConnected(true);
        setError(null);
        setIsLoading(false);
      }
    }).catch((err: any) => {
      if (err?.message === 'TABLE_NOT_FOUND') {
        tableNotFound = true;
        setError('TABLE_NOT_FOUND');
        setIsLoading(false);
        setIsConnected(false);
      }
    });

    // L1 polling loop
    const poll = async () => {
      if (!active || tableNotFound) return;
      try {
        const state = await fetchGameState(tablePda);
        if (state) {
          setGameState(state);
          setIsConnected(true);
          setIsLoading(false);
          setError(null);
          errorCount = 0;
          if (state.phase !== lastPhase) {
            lastPhase = state.phase;
          }
        } else {
          errorCount++;
        }
      } catch (err: any) {
        if (err?.message === 'TABLE_NOT_FOUND') {
          tableNotFound = true;
          setError('TABLE_NOT_FOUND');
          setIsLoading(false);
          setIsConnected(false);
          return;
        }
        errorCount++;
      }
      if (!active || tableNotFound) return;
      const baseDelay = errorCount === 0 ? getPhaseDelay(lastPhase) : 2000;
      const delay = Math.min(baseDelay * Math.pow(2, errorCount), 30000);
      setTimeout(poll, delay);
    };
    poll();

    return () => {
      active = false;
      setIsConnected(false);
    };
  }, [tablePdaString, fetchGameState, publicKey]);

  // Send player action — uses session key for gasless L1 transactions
  const sendAction = useCallback(async (
    action: 'fold' | 'check' | 'call' | 'raise' | 'allin' | 'sit_out' | 'return_to_play' | 'leave_cash_game' | 'use_time_bank',
    amount?: number
  ): Promise<string | null> => {
    if (!publicKey || !sendTransaction || !gameState) {
      setError('Wallet not connected or no active game');
      return null;
    }

    if (gameState.mySeatIndex < 0) {
      setError('Not seated at table');
      return null;
    }

    const tablePda = new PublicKey(gameState.tablePda);

    const actionMap: Record<string, ActionType> = {
      fold: ActionType.Fold,
      check: ActionType.Check,
      call: ActionType.Call,
      raise: ActionType.Raise,
      allin: ActionType.AllIn,
      sit_out: ActionType.SitOut,
      return_to_play: ActionType.ReturnToPlay,
      leave_cash_game: ActionType.LeaveCashGame,
    };

    setIsPendingAction(true);
    setError(null);

    try {
      const isNonGameplayAction = action === 'sit_out' || action === 'return_to_play' || action === 'leave_cash_game' || action === 'use_time_bank';

      let signature: string;

      // Session key path (gasless on L1)
      if (sessionKey) {
        const instruction = action === 'use_time_bank'
          ? buildUseTimeBankInstruction(sessionKey.publicKey, tablePda, gameState.mySeatIndex)
          : buildPlayerActionInstruction(
              sessionKey.publicKey,
              tablePda,
              gameState.mySeatIndex,
              actionMap[action],
              amount,
            );

        const tx = new Transaction().add(instruction);
        try {
          tx.feePayer = sessionKey.publicKey;
          tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
          tx.sign(sessionKey);
          signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
          // Poll for confirmation
          for (let p = 0; p < 10; p++) {
            await new Promise(r => setTimeout(r, 1000));
            const statuses = await connection.getSignatureStatuses([signature]);
            if (statuses?.value?.[0]?.confirmationStatus === 'confirmed' || statuses?.value?.[0]?.confirmationStatus === 'finalized') break;
          }
          console.log(`Action ${action} confirmed (session key on L1):`, signature);
        } catch (sessionErr: any) {
          console.error('Session key failed:', sessionErr.message?.slice(0, 200));
          if (!isNonGameplayAction) {
            throw new Error('Session expired or insufficient balance. Please top up your session.');
          }
          console.log(`Falling back to wallet-signed ${action}...`);
          signature = '';
        }

        if (signature) {
          await refreshState();
          return signature;
        }
      }

      // Wallet-signing fallback (requires user approval popup)
      let ix;
      if (action === 'sit_out') {
        ix = buildSitOutInstruction(publicKey, tablePda, gameState.mySeatIndex);
      } else if (action === 'return_to_play') {
        ix = buildSitInInstruction(publicKey, tablePda, gameState.mySeatIndex);
      } else if (action === 'use_time_bank') {
        ix = buildUseTimeBankInstruction(publicKey, tablePda, gameState.mySeatIndex);
      } else {
        ix = buildPlayerActionInstruction(publicKey, tablePda, gameState.mySeatIndex, actionMap[action], amount);
      }

      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      signature = await sendTransaction(tx, connection, { skipPreflight: true });
      console.log(`Action ${action} confirmed (wallet-signed on L1):`, signature);
      await refreshState();
      return signature;
    } catch (err: any) {
      console.error('Action failed:', err);
      setError(err.message || 'Action failed');
      throw err;
    } finally {
      setIsPendingAction(false);
    }
  }, [publicKey, sendTransaction, gameState, refreshState, sessionKey, connection]);

  return {
    gameState,
    isLoading,
    error,
    isConnected,
    sendAction,
    isPendingAction,
    refreshState,
  };
}
