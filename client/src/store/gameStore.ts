import { create } from 'zustand';
import { PublicKey } from '@solana/web3.js';
import { GamePhase, PlayerAction } from '../lib/constants';

// Map phase strings from useOnChainGame (phaseToString) to store GamePhase enum.
// "Starting" and "Complete" don't exist in GamePhase — map to closest equivalent.
const PHASE_MAP: Record<string, GamePhase> = {
  'Waiting': GamePhase.Waiting,
  'Starting': GamePhase.Waiting,         // Starting is pre-deal, treat as Waiting for UI
  'AwaitingDeal': GamePhase.Waiting,     // MPC shuffle queued — show "Dealing..." in UI
  'PreFlop': GamePhase.Preflop,
  'FlopRevealPending': GamePhase.Flop,
  'Flop': GamePhase.Flop,
  'TurnRevealPending': GamePhase.Turn,
  'Turn': GamePhase.Turn,
  'RiverRevealPending': GamePhase.River,
  'River': GamePhase.River,
  'Showdown': GamePhase.Showdown,
  'AwaitingShowdown': GamePhase.Showdown, // MPC reveal queued — show showdown UI
  'Complete': GamePhase.Showdown,         // Complete follows showdown, keep showing results
};

// Player at table
export interface TablePlayer {
  pubkey: PublicKey;
  seatIndex: number;
  chips: number;
  currentBet: number;
  isFolded: boolean;
  isAllIn: boolean;
  isSittingOut: boolean;
  cards: [number, number]; // 255 = hidden
}

// Table state
export interface TableState {
  tablePda: PublicKey | null;
  tableId: Uint8Array | null;
  gameType: string;
  stakes: string;
  maxPlayers: number;
  phase: GamePhase;
  pot: number;
  minBet: number;
  dealerButton: number;
  currentPlayer: number;
  communityCards: [number, number, number, number, number];
  players: TablePlayer[];
  myCards: [number, number];
  mySeatIndex: number | null;
}

// Actions
interface GameActions {
  // Table management
  setTable: (tablePda: PublicKey, tableId: Uint8Array) => void;
  clearTable: () => void;
  
  // State updates
  updatePhase: (phase: GamePhase) => void;
  updatePot: (pot: number) => void;
  updateCommunityCards: (cards: [number, number, number, number, number]) => void;
  updateCurrentPlayer: (seatIndex: number) => void;
  
  // Player updates
  setPlayers: (players: TablePlayer[]) => void;
  updatePlayer: (seatIndex: number, updates: Partial<TablePlayer>) => void;
  
  // My state
  setMyCards: (cards: [number, number]) => void;
  setMySeatIndex: (seatIndex: number | null) => void;
  
  // Full state update from chain
  syncFromChain: (tableData: any, seatCardsData?: any) => void;
}

const initialState: TableState = {
  tablePda: null,
  tableId: null,
  gameType: '',
  stakes: '',
  maxPlayers: 0,
  phase: GamePhase.Waiting,
  pot: 0,
  minBet: 0,
  dealerButton: 0,
  currentPlayer: 0,
  communityCards: [255, 255, 255, 255, 255],
  players: [],
  myCards: [255, 255],
  mySeatIndex: null,
};

export const useGameStore = create<TableState & GameActions>((set, get) => ({
  ...initialState,

  setTable: (tablePda, tableId) => set({ tablePda, tableId }),
  
  clearTable: () => set(initialState),

  updatePhase: (phase) => set({ phase }),
  
  updatePot: (pot) => set({ pot }),
  
  updateCommunityCards: (cards) => set({ communityCards: cards }),
  
  updateCurrentPlayer: (seatIndex) => set({ currentPlayer: seatIndex }),

  setPlayers: (players) => set({ players }),
  
  updatePlayer: (seatIndex, updates) => set((state) => ({
    players: state.players.map(p => 
      p.seatIndex === seatIndex ? { ...p, ...updates } : p
    ),
  })),

  setMyCards: (cards) => set({ myCards: cards }),
  
  setMySeatIndex: (seatIndex) => set({ mySeatIndex: seatIndex }),

  syncFromChain: (gameState) => {
    if (!gameState) {
      set(initialState);
      return;
    }

    // Map phase string to GamePhase enum
    const phase = PHASE_MAP[gameState.phase] ?? GamePhase.Waiting;

    // Pad community cards to 5 elements (255 = hidden)
    const cc = gameState.communityCards || [];
    const communityCards: [number, number, number, number, number] = [
      cc[0] ?? 255, cc[1] ?? 255, cc[2] ?? 255, cc[3] ?? 255, cc[4] ?? 255,
    ];

    // Map players from OnChainGameState.GamePlayer → TablePlayer
    const players: TablePlayer[] = (gameState.players || []).map((p: any) => ({
      pubkey: typeof p.pubkey === 'string' ? new PublicKey(p.pubkey) : p.pubkey,
      seatIndex: p.seatIndex,
      chips: p.chips,
      currentBet: p.bet,
      isFolded: p.folded,
      isAllIn: !p.folded && !p.isActive && p.chips === 0,
      isSittingOut: p.isSittingOut ?? false,
      cards: p.holeCards ?? [255, 255],
    }));

    set({
      tablePda: new PublicKey(gameState.tablePda),
      phase,
      pot: gameState.pot,
      minBet: gameState.currentBet,
      dealerButton: gameState.dealerSeat,
      currentPlayer: gameState.currentPlayer,
      communityCards,
      players,
      myCards: gameState.myCards ?? [255, 255],
      mySeatIndex: gameState.mySeatIndex >= 0 ? gameState.mySeatIndex : null,
      maxPlayers: gameState.players?.length || 0,
    });
  },
}));

// Selectors
export const selectIsMyTurn = (state: TableState) => 
  state.mySeatIndex !== null && state.currentPlayer === state.mySeatIndex;

export const selectCanCheck = (state: TableState) => {
  if (state.mySeatIndex === null) return false;
  const myPlayer = state.players.find(p => p.seatIndex === state.mySeatIndex);
  if (!myPlayer) return false;
  return myPlayer.currentBet >= state.minBet;
};

export const selectCallAmount = (state: TableState) => {
  if (state.mySeatIndex === null) return 0;
  const myPlayer = state.players.find(p => p.seatIndex === state.mySeatIndex);
  if (!myPlayer) return 0;
  return Math.max(0, state.minBet - myPlayer.currentBet);
};

export const selectMinRaise = (state: TableState) => {
  // Minimum raise is typically 2x the current bet or big blind
  return state.minBet * 2;
};
