// Shared types between frontend and backend

// API Response wrapper
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

// Card representation
export type Suit = 'h' | 'd' | 'c' | 's'; // hearts, diamonds, clubs, spades
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type Card = `${Rank}${Suit}`;

// Player action types
export type ActionType = 'fold' | 'check' | 'call' | 'raise' | 'allin';

// Hand phases
export type HandPhase = 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

// Stakes level for rake cap
export type StakesLevel = 'micro' | 'low' | 'mid' | 'high';

// User interface
export interface IUserPublic {
  id: string;
  walletAddress: string;
  username?: string;
  avatarUrl?: string;
  balance: number;
  ticketBalance: number;
  stats: {
    handsPlayed: number;
    handsWon: number;
    totalWinnings: number;
    biggestPot: number;
    tournamentsPlayed: number;
    tournamentsWon: number;
    totalPoints: number;
  };
  createdAt: Date;
}

// Player at table
export interface TablePlayer {
  odlaerId: string;
  odla: string;
  odlaerName?: string;
  seatNumber: number;
  chipStack: number;
  isActive: boolean;
  isSittingOut: boolean;
  isDisconnected: boolean;
  currentBet: number;
  holeCards?: [Card, Card];
  hasActed: boolean;
  isAllIn: boolean;
  lastAction?: ActionType;
}

// Cash table info
export interface ICashTablePublic {
  id: string;
  name: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxPlayers: number;
  stakesLevel: StakesLevel;
  isActive: boolean;
  playerCount: number;
}

// Full table state for game
export interface TableState {
  tableId: string;
  tableName: string;
  smallBlind: number;
  bigBlind: number;
  players: TablePlayer[];
  communityCards: Card[];
  pot: number;
  sidePots: { amount: number; eligiblePlayers: string[] }[];
  currentBet: number;
  minRaise: number;
  dealerSeat: number;
  currentPlayerSeat: number | null;
  phase: HandPhase;
  handNumber: number;
  actionTimeout: number;
  actionStartedAt: number | null;
}

// Game action from client
export interface GameAction {
  id: string;
  tableId: string;
  action: ActionType;
  amount?: number;
  timestamp: number;
}

// Action result
export interface ActionResult {
  success: boolean;
  id: string;
  error?: string;
  newState?: Partial<TableState>;
}

// Join table result
export interface JoinResult {
  success: boolean;
  error?: string;
  seatNumber?: number;
  tableState?: TableState;
}

// Hand start info
export interface HandStart {
  handNumber: number;
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  players: {
    odlaerId: string;
    seatNumber: number;
    chipStack: number;
  }[];
}

// Hand result
export interface HandResult {
  winners: {
    odlaerId: string;
    odla: string;
    amount: number;
    hand?: string;
    cards?: Card[];
  }[];
  pot: number;
  rake: number;
  showdown: {
    odlaerId: string;
    cards: [Card, Card];
    handName: string;
  }[];
}

// Socket events - Server to Client
export interface ServerToClientEvents {
  table_state: (state: TableState) => void;
  full_state_sync: (state: TableState) => void;
  player_joined: (data: { seatNumber: number; player: TablePlayer }) => void;
  player_left: (data: { seatNumber: number; odlaerId: string }) => void;
  hand_start: (data: HandStart & { cards?: [Card, Card] }) => void;
  deal_flop: (cards: [Card, Card, Card]) => void;
  deal_turn: (card: Card) => void;
  deal_river: (card: Card) => void;
  player_turn: (data: { odlaerId: string; seatNumber: number; timeRemaining: number; validActions: ActionType[] }) => void;
  player_acted: (data: { odlaerId: string; seatNumber: number; action: ActionType; amount: number; newPot: number; newStack: number }) => void;
  hand_end: (result: HandResult) => void;
  chat: (data: { from: string; message: string; timestamp: number }) => void;
  error: (error: { code: string; message: string }) => void;
  ping: () => void;
  player_disconnected: (data: { odlaerId: string; seatNumber: number }) => void;
  player_reconnected: (data: { odlaerId: string; seatNumber: number }) => void;
}

// Socket events - Client to Server
export interface ClientToServerEvents {
  join_table: (data: { tableId: string; seatNumber: number; buyIn: number }, callback: (res: JoinResult) => void) => void;
  leave_table: (data: { tableId: string }, callback: (res: { success: boolean; error?: string }) => void) => void;
  player_action: (action: GameAction, callback: (res: ActionResult) => void) => void;
  sit_out: (data: { tableId: string; sitOut: boolean }, callback: (res: { success: boolean }) => void) => void;
  rebuy_request: (data: { tableId: string; amount: number }, callback: (res: { success: boolean; error?: string }) => void) => void;
  request_sync: (tableId: string) => void;
  pong: () => void;
  chat_message: (data: { tableId: string; message: string }) => void;
}

// Tournament types
export type TournamentStatus = 'waiting' | 'running' | 'finished' | 'cancelled';
export type TournamentType = 'turbo' | 'normal';

export interface BlindLevel {
  level: number;
  sb: number;
  bb: number;
  duration: number; // seconds
}

export interface PayoutStructure {
  place: number;
  percentage: number;
}

export interface TournamentEntry {
  odlaerId: string;
  odla: string;
  odlaerName?: string;
  chipStack: number;
  seatNumber?: number;
  tableNumber?: number;
  finishPlace?: number;
  pointsEarned: number;
  rebuyCount: number;
  addOnUsed: boolean;
  isEliminated: boolean;
  eliminatedAt?: Date;
  registeredAt: Date;
}

export interface ITournamentPublic {
  id: string;
  name: string;
  type: TournamentType;
  maxPlayers: number;
  startingStack: number;
  blindStructure: BlindLevel[];
  payoutStructure: PayoutStructure[];
  ticketCost: number;
  pokerCost: number;
  prizePool: number;
  rebuyAllowed: boolean;
  rebuyLevels: number;
  status: TournamentStatus;
  currentLevel: number;
  entryCount: number;
  startedAt?: Date;
}

// Transaction types
export type TransactionType = 'deposit' | 'withdrawal' | 'tournament_entry' | 'tournament_payout' | 'spin_reward' | 'ticket_claim' | 'table_buyin' | 'table_cashout' | 'rake';
export type TransactionStatus = 'pending' | 'confirmed' | 'failed';

export interface ITransaction {
  id: string;
  userId: string;
  type: TransactionType;
  amount: number;
  txSignature?: string;
  status: TransactionStatus;
  createdAt: Date;
}

// Leaderboard
export type LeaderboardPeriod = 'daily' | 'weekly' | 'monthly' | 'alltime';

export interface LeaderboardEntry {
  rank: number;
  odlaerId: string;
  odla: string;
  odlaerName?: string;
  points: number;
  tournamentsPlayed: number;
  tournamentsWon: number;
}

// Auth
export interface AuthPayload {
  walletAddress: string;
  message: string;
  signature: string;
}

export interface AuthResponse {
  token: string;
  user: IUserPublic;
}

// Spin wheel
export interface SpinResult {
  tickets: number;
  nftMint: string;
}
