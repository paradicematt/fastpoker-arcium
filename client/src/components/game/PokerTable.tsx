'use client';

import { useState, useMemo, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { cn } from '@/lib/utils';
import { evaluateHand, compareHands, HandResult } from '@/lib/hand-evaluator';
import { useSoundEffects } from '@/hooks/useSoundEffects';
import { getAvatarById } from '@/lib/avatars';
import { useTokenLogo } from '@/hooks/useTokenLogo';

// ─── Types ───

interface Player {
  pubkey: string;
  chips: number;
  bet: number;
  folded: boolean;
  isActive: boolean;
  isSittingOut?: boolean;
  isLeaving?: boolean;
  isDealer?: boolean;
  timeBankSeconds?: number;
  timeBankActive?: boolean;
  position?: 'SB' | 'BB' | 'BTN' | 'UTG' | 'MP' | 'CO';
  holeCards?: [number, number];
  seatIndex: number;
  level?: number;
}

interface HandAction {
  player: string;
  action: string;
  amount?: number;
  phase: string;
}

interface PlayerAction {
  seatIndex: number;
  action: string;
  timestamp: number;
}

interface PokerTableProps {
  tablePda: string;
  phase: string;
  pot: number;
  currentPlayer: number;
  communityCards: number[];
  players: Player[];
  myCards?: [number, number];
  onAction?: (action: string, amount?: number) => void;
  isMyTurn?: boolean;
  blinds?: { small: number; big: number };
  dealerSeat?: number;
  maxSeats?: number;
  handHistory?: HandAction[];
  actionPending?: boolean;
  playerActions?: PlayerAction[];
  showdownPot?: number;
  pastHands?: HandAction[][];
  viewingPastHand?: number | null;
  onHandNav?: (index: number | null) => void;
  tier?: number;
  prizePool?: number;
  maxPlayers?: number;
  lastActionSlot?: number;
  blindLevel?: number;
  tournamentStartTime?: number;
  currentBet?: number;
  tokenMint?: string;
  onSeatClick?: (seatIndex: number) => void;
  isCashGame?: boolean;
  handNumber?: number;
}

// ─── Card Helpers ───

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

const POKER_MINT_B58 = 'DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX';
const SOL_DEFAULT_B58 = '11111111111111111111111111111111';

// Cash game values are in lamports (1e9 = 1 SOL). SNG values are virtual chips (5/10).
// Use isCashGame flag directly for reliable detection.
function makeValueFormatter(bigBlind: number, mint?: string, isCashGame?: boolean) {
  const isLamports = isCashGame === true || bigBlind >= 10000; // explicit flag or heuristic fallback
  if (!isLamports) return (v: number) => v.toLocaleString();
  const decimals = 9; // SOL and most SPL tokens use 9 decimals
  const symbol = (!mint || mint === SOL_DEFAULT_B58) ? 'SOL' : (mint === POKER_MINT_B58 ? 'POKER' : '');
  return (v: number) => {
    const val = v / Math.pow(10, decimals);
    if (val === 0) return '0';
    // Use enough precision then strip trailing zeros
    const raw = val >= 1 ? val.toFixed(4) : val >= 0.01 ? val.toFixed(4) : val >= 0.0001 ? val.toFixed(6) : val.toFixed(9);
    return parseFloat(raw).toString();
  };
}

function getTokenImageUrl(mint?: string): string {
  if (!mint || mint === SOL_DEFAULT_B58) return '/tokens/sol.svg';
  if (mint === POKER_MINT_B58) return '/tokens/poker.svg';
  return '/tokens/sol.svg';
}


const TIER_NAMES = ['Micro', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];
const TIER_COLORS = ['text-gray-400', 'text-amber-400', 'text-slate-300', 'text-yellow-400', 'text-cyan-300', 'text-purple-300'];
// HU=100%, 6max=65/35, 9max=50/30/20 (basis points)
const PAYOUT_BPS: Record<number, number[]> = {
  2: [10000],
  6: [6500, 3500],
  9: [5000, 3000, 2000],
};

function cardToString(cardNum: number) {
  if (cardNum < 0 || cardNum > 51 || cardNum === 255) return null;
  const rankIdx = cardNum % 13;
  const suitIdx = Math.floor(cardNum / 13);
  return { rank: RANKS[rankIdx], suit: SUITS[suitIdx], isRed: suitIdx === 1 || suitIdx === 2 };
}

function TableCard({ cardNum, size = 'md', hidden = false, outline = false }: {
  cardNum: number; size?: 'sm' | 'md' | 'lg'; hidden?: boolean; outline?: boolean;
}) {
  const sz = {
    sm: 'w-8 h-11 text-[10px] sm:w-10 sm:h-14 sm:text-xs md:w-12 md:h-[68px] md:text-sm',
    md: 'w-11 h-[62px] text-sm sm:w-14 sm:h-[80px] sm:text-base md:w-16 md:h-[92px]',
    lg: 'w-14 h-[80px] text-base sm:w-18 sm:h-[104px] sm:text-lg md:w-[88px] md:h-[126px] md:text-xl',
  }[size];

  if (outline) return <div className={`${sz} rounded-lg border border-white/[0.06] bg-white/[0.02]`} />;

  if (hidden) {
    return (
      <div className={`${sz} rounded-lg bg-gradient-to-br from-cyan-900 via-gray-900 to-cyan-900 border border-cyan-500/20 card-shadow flex items-center justify-center`}>
        <div className="w-3/4 h-3/4 rounded border border-cyan-500/10 bg-[repeating-linear-gradient(45deg,transparent,transparent_3px,rgba(6,182,212,0.04)_3px,rgba(6,182,212,0.04)_6px)]" />
      </div>
    );
  }

  const card = cardToString(cardNum);
  if (!card) return null;

  return (
    <div className={`${sz} rounded-lg bg-gray-100 border border-gray-300 card-shadow flex flex-col items-center justify-center ${card.isRed ? 'text-red-600' : 'text-gray-900'}`}>
      <span className="font-bold leading-none">{card.rank}</span>
      <span className="text-base sm:text-lg md:text-xl leading-none">{card.suit}</span>
    </div>
  );
}

// ─── Player Avatar ───

// Deterministic color from pubkey
const AVATAR_GRADIENTS = [
  'from-cyan-400 to-blue-600',
  'from-emerald-400 to-teal-600',
  'from-violet-400 to-purple-600',
  'from-amber-400 to-orange-600',
  'from-rose-400 to-pink-600',
  'from-sky-400 to-indigo-600',
  'from-lime-400 to-green-600',
  'from-fuchsia-400 to-pink-600',
  'from-yellow-400 to-amber-600',
  'from-red-400 to-rose-600',
];

function getAvatarStyle(pubkey: string) {
  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) hash = ((hash << 5) - hash + pubkey.charCodeAt(i)) | 0;
  const idx = Math.abs(hash) % AVATAR_GRADIENTS.length;
  const initials = pubkey.slice(0, 2).toUpperCase();
  return { gradient: AVATAR_GRADIENTS[idx], initials };
}

function PlayerAvatar({ pubkey, isMe, isWinner, level, size = 'md', profileAvatarId, profileName }: {
  pubkey: string; isMe: boolean; isWinner?: boolean; level?: number; size?: 'sm' | 'md';
  profileAvatarId?: string; profileName?: string;
}) {
  const { gradient: defaultGrad, initials } = getAvatarStyle(pubkey);
  const avatar = profileAvatarId ? getAvatarById(profileAvatarId) : null;
  const hasImage = avatar?.image;
  const gradient = hasImage ? 'from-gray-800 to-gray-900' : (avatar ? defaultGrad : defaultGrad);
  const sz = size === 'sm' ? 'w-6 h-6 text-[7px] sm:w-7 sm:h-7 sm:text-[8px]' : 'w-7 h-7 text-[8px] sm:w-8 sm:h-8 sm:text-[9px] md:w-9 md:h-9';
  return (
    <div className="relative flex-shrink-0">
      <div className={cn(
        sz, 'rounded-full flex items-center justify-center font-bold text-white shadow-md overflow-hidden',
        `bg-gradient-to-br ${gradient}`,
        isMe && 'ring-[1.5px] ring-cyan-400/60',
        isWinner && 'ring-[1.5px] ring-amber-400/80 shadow-[0_0_10px_rgba(251,191,36,0.3)]',
      )}>
        {hasImage ? (
          <img src={avatar.image} alt={avatar.label} className="w-full h-full object-cover" />
        ) : avatar ? (
          <span className={size === 'sm' ? 'text-sm' : 'text-base'}>{avatar.fallbackEmoji}</span>
        ) : (
          <span>{initials}</span>
        )}
      </div>
      {level !== undefined && level > 0 && (
        <div className={cn(
          'absolute -bottom-1.5 left-1/2 -translate-x-1/2 min-w-[14px] h-3.5 rounded-full flex items-center justify-center text-[7px] font-black border px-0.5',
          level >= 10 ? 'bg-amber-500 border-amber-300 text-gray-900' :
          level >= 7 ? 'bg-purple-500 border-purple-300 text-white' :
          level >= 4 ? 'bg-cyan-500 border-cyan-300 text-gray-900' :
          'bg-gray-600 border-gray-400 text-white'
        )}>
          {level}
        </div>
      )}
    </div>
  );
}

// ─── Seat Layout Configs ───

// Desktop layouts (aspect 16:9) — seats near edges
const SEAT_LAYOUTS: Record<number, { top: string; left: string }[]> = {
  2: [
    { top: '86%', left: '50%' },
    { top: '10%', left: '50%' },
  ],
  6: [
    { top: '88%', left: '50%' },
    { top: '72%', left: '8%' },
    { top: '18%', left: '8%' },
    { top: '8%', left: '50%' },
    { top: '18%', left: '92%' },
    { top: '72%', left: '92%' },
  ],
  9: [
    { top: '90%', left: '50%' },
    { top: '82%', left: '18%' },
    { top: '55%', left: '4%' },
    { top: '22%', left: '6%' },
    { top: '6%', left: '28%' },
    { top: '6%', left: '72%' },
    { top: '22%', left: '94%' },
    { top: '55%', left: '96%' },
    { top: '82%', left: '82%' },
  ],
};

// Mobile layouts (aspect 4:3) — taller table, seats pushed to edges
const SEAT_LAYOUTS_MOBILE: Record<number, { top: string; left: string }[]> = {
  2: [
    { top: '85%', left: '50%' },
    { top: '10%', left: '50%' },
  ],
  6: [
    { top: '88%', left: '50%' },
    { top: '72%', left: '8%' },
    { top: '22%', left: '8%' },
    { top: '8%', left: '50%' },
    { top: '22%', left: '92%' },
    { top: '72%', left: '92%' },
  ],
  9: [
    { top: '90%', left: '50%' },
    { top: '82%', left: '14%' },
    { top: '58%', left: '2%' },
    { top: '30%', left: '2%' },
    { top: '8%', left: '25%' },
    { top: '8%', left: '75%' },
    { top: '30%', left: '98%' },
    { top: '58%', left: '98%' },
    { top: '82%', left: '86%' },
  ],
};

// ─── PlayerSeat Component ───

function PlayerSeat({
  player, pos, isCurrentPlayer, seatIndex, isMe, isDealer, cardsDealt, isShowdown,
  handName, isWinner, showdownStage, timeLeft, timeoutSecs, lastAction, showdownPot, fmtVal, onSeatClick,
  profileAvatarId, profileName,
}: {
  player: Player | null; pos: { top: string; left: string };
  isCurrentPlayer: boolean; seatIndex: number; isMe: boolean;
  isDealer: boolean; cardsDealt: boolean; isShowdown: boolean;
  handName?: string; isWinner?: boolean; showdownStage?: number;
  timeLeft?: number; timeoutSecs?: number;
  lastAction?: { action: string; timestamp: number } | null;
  showdownPot?: number;
  fmtVal: (v: number) => string;
  onSeatClick?: (seatIndex: number) => void;
  profileAvatarId?: string; profileName?: string;
}) {
  // Show action overlay for 2s after action
  const [showAction, setShowAction] = useState<string | null>(null);
  useEffect(() => {
    if (lastAction) {
      setShowAction(lastAction.action);
      const t = setTimeout(() => setShowAction(null), 2000);
      return () => clearTimeout(t);
    }
  }, [lastAction?.timestamp]);
  if (!player) {
    return (
      <div className="absolute -translate-x-1/2 -translate-y-1/2" style={{ top: pos.top, left: pos.left }}>
        {onSeatClick ? (
          <button
            onClick={() => onSeatClick(seatIndex)}
            className="w-14 h-10 sm:w-18 sm:h-12 md:w-20 md:h-14 rounded-xl border border-dashed border-cyan-500/20 bg-cyan-500/[0.04] hover:bg-cyan-500/[0.1] hover:border-cyan-500/40 flex items-center justify-center transition-all cursor-pointer group"
          >
            <span className="text-cyan-400/60 group-hover:text-cyan-300 text-[10px] sm:text-xs font-bold">SIT</span>
          </button>
        ) : (
          <div className="w-14 h-10 sm:w-18 sm:h-12 md:w-20 md:h-14 rounded-xl border border-dashed border-white/[0.08] flex items-center justify-center">
            <span className="text-white/20 text-[10px] sm:text-xs font-mono">OPEN</span>
          </div>
        )}
      </div>
    );
  }

  const posLabel = player.position;

  return (
    <div className="absolute -translate-x-1/2 -translate-y-1/2 z-10" style={{ top: pos.top, left: pos.left }}>
      <div className="relative flex flex-col items-center gap-1">
        {/* Opponent cards */}
        {!isMe && cardsDealt && !player.folded && (
          <div className="flex gap-0.5 mb-0.5">
            {isShowdown && player.holeCards && (showdownStage ?? 0) >= 1 ? (
              <>
                <div className="animate-cardReveal" style={{ animationDelay: '0ms' }}>
                  <TableCard cardNum={player.holeCards[0]} size="sm" />
                </div>
                <div className="animate-cardReveal" style={{ animationDelay: '200ms' }}>
                  <TableCard cardNum={player.holeCards[1]} size="sm" />
                </div>
              </>
            ) : (
              <>
                <TableCard cardNum={0} hidden size="sm" />
                <TableCard cardNum={0} hidden size="sm" />
              </>
            )}
          </div>
        )}

        {/* Hand name badge */}
        {isShowdown && handName && (showdownStage ?? 0) >= 2 && !player.folded && (
          <div className={cn(
            'animate-fadeIn text-[9px] font-bold tracking-wide px-2 py-0.5 rounded-full mb-0.5',
            isWinner
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
              : 'bg-white/[0.06] text-gray-400 border border-white/[0.08]'
          )}>
            {handName}
          </div>
        )}

        {/* Avatar + Info box row */}
        <div className={cn('flex items-center gap-0', player.folded && 'opacity-40')}>
          {/* Avatar circle */}
          <div className="-mr-2 z-10">
            <PlayerAvatar pubkey={player.pubkey} isMe={isMe} isWinner={!!(isWinner && (showdownStage ?? 0) >= 3)} level={player.level} profileAvatarId={profileAvatarId} profileName={profileName} />
          </div>

          {/* Info box */}
          <div className={cn(
            'relative pl-2 pr-2 py-1 sm:pl-3 sm:pr-3 sm:py-1.5 rounded-xl min-w-[60px] sm:min-w-[76px] transition-all duration-300',
            isMe
              ? 'bg-gradient-to-b from-cyan-500/15 to-cyan-500/5 border border-cyan-500/30'
              : 'bg-white/[0.05] border border-white/[0.1]',
            isCurrentPlayer && !player.folded && !isShowdown && 'ring-2 ring-cyan-400/70 glow-cyan',
            isWinner && (showdownStage ?? 0) >= 3 && 'ring-2 ring-amber-400/80 shadow-[0_0_20px_rgba(251,191,36,0.3)]',
          )}>
            {/* Position badge */}
            {posLabel && (
              <div className={cn(
                'absolute -top-2 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wider',
                posLabel === 'BTN' ? 'bg-white text-gray-900' :
                posLabel === 'SB' ? 'bg-amber-500/80 text-gray-900' :
                posLabel === 'BB' ? 'bg-orange-500/80 text-white' :
                'bg-gray-600/80 text-gray-200'
              )}>
                {posLabel}
              </div>
            )}

            {/* Dealer chip */}
            {isDealer && (
              <div className="absolute -right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white border-2 border-gray-800 flex items-center justify-center shadow-lg">
                <span className="text-[8px] font-black text-gray-900">D</span>
              </div>
            )}

            <div className="text-center">
              <div className={cn('text-[9px] sm:text-[10px] font-medium truncate max-w-[50px] sm:max-w-[70px]', isMe ? 'text-cyan-300' : 'text-gray-400')}>
                {isMe ? 'YOU' : (profileName || player.pubkey.slice(0, 4) + '...')}
              </div>
              {showAction && !player.folded ? (
                <div className={cn('text-sm font-bold tabular-nums animate-fadeIn',
                  showAction.startsWith('FOLD') ? 'text-red-400' :
                  showAction.startsWith('RAISE') || showAction.startsWith('ALL') ? 'text-emerald-400' :
                  showAction.startsWith('CALL') ? 'text-cyan-400' :
                  showAction.startsWith('SB') || showAction.startsWith('BB') ? 'text-amber-400' :
                  'text-gray-300'
                )}>
                  {showAction}
                </div>
              ) : (
                <div className={cn('text-sm font-bold tabular-nums', player.folded ? 'text-gray-500' : 'text-white')}>
                  {fmtVal(player.chips)}
                </div>
              )}
            </div>

            {player.folded && !player.isSittingOut && (
              <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/40">
                <span className="text-red-400/80 font-bold text-[10px] tracking-widest">FOLD</span>
              </div>
            )}
            {player.isSittingOut && (
              <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/40">
                <span className="text-amber-400/80 font-bold text-[10px] tracking-widest">SITTING OUT</span>
              </div>
            )}
            {player.isLeaving && !player.folded && (
              <div className="absolute -top-5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-red-500/80 whitespace-nowrap">
                <span className="text-white font-bold text-[8px] tracking-wider">LEAVING</span>
              </div>
            )}

            {isCurrentPlayer && !player.folded && !isShowdown && timeLeft !== undefined && timeoutSecs && (
              <div className="absolute -bottom-0.5 left-1 right-1 h-1 rounded-full overflow-hidden bg-gray-700">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-1000 ease-linear',
                    timeLeft > 5 ? 'bg-cyan-400' : timeLeft > 2 ? 'bg-amber-400' : 'bg-red-400'
                  )}
                  style={{ width: `${Math.max(0, (timeLeft / timeoutSecs) * 100)}%` }}
                />
              </div>
            )}
          </div>
        </div>

        {/* Bet chips */}
        {player.bet > 0 && (
          <div className="flex items-center gap-1 mt-0.5">
            <div className="w-3.5 h-3.5 rounded-full bg-gradient-to-b from-amber-400 to-amber-600 border border-amber-300 shadow-sm" />
            <span className="text-amber-400 text-xs font-bold tabular-nums">{fmtVal(player.bet)}</span>
          </div>
        )}

        {/* Winner chip overlay — only on winner's seat */}
        {isWinner && (showdownStage ?? 0) >= 3 && showdownPot && showdownPot > 0 && (
          <div className="absolute -top-10 left-1/2 -translate-x-1/2 z-20 animate-fadeIn">
            <div className="px-3 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-center whitespace-nowrap">
              <div className="text-amber-400 text-sm font-black tabular-nums">+{fmtVal(showdownPot)}</div>
              {handName && <div className="text-amber-300/70 text-[8px] font-bold">{handName}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Verify Hand Component ───

function VerifyHand({ tablePda, communityCards, players, showdownResults, publicKey }: {
  tablePda: string;
  communityCards: number[];
  players: Player[];
  showdownResults: { results: Record<string, { hand: { name: string; score: number }; isWinner: boolean }>; winnerKey: string };
  publicKey?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const explorerUrl = `https://explorer.solana.com/address/${tablePda}?cluster=devnet`;

  return (
    <div className="mt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.06] text-gray-500 text-[10px] font-bold uppercase tracking-wider hover:bg-white/[0.04] hover:text-gray-400 transition-colors"
      >
        <span>{expanded ? '▾' : '▸'}</span>
        Verify Hand On-Chain
      </button>
      {expanded && (
        <div className="mt-2 glass-card p-3 space-y-2.5 animate-fadeIn">
          {/* Table PDA */}
          <div>
            <div className="text-[9px] text-gray-600 uppercase tracking-wider font-bold mb-0.5">Table Account</div>
            <a href={explorerUrl} target="_blank" rel="noopener noreferrer"
              className="text-[11px] font-mono text-cyan-400 hover:text-cyan-300 underline decoration-cyan-500/30 break-all">
              {tablePda}
            </a>
          </div>

          {/* Community Cards */}
          <div>
            <div className="text-[9px] text-gray-600 uppercase tracking-wider font-bold mb-0.5">Community Cards</div>
            <div className="flex gap-1">
              {communityCards.filter(c => c !== 255 && c >= 0 && c <= 51).map((c, i) => {
                const card = cardToString(c);
                if (!card) return null;
                return (
                  <span key={i} className={cn('text-xs font-bold font-mono px-1.5 py-0.5 rounded bg-white/[0.06]', card.isRed ? 'text-red-400' : 'text-gray-200')}>
                    {card.rank}{card.suit}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Player Hands */}
          <div>
            <div className="text-[9px] text-gray-600 uppercase tracking-wider font-bold mb-0.5">Revealed Hands</div>
            <div className="space-y-1">
              {players.filter(p => p.isActive || p.folded).map(p => {
                const result = showdownResults.results[p.pubkey];
                const isMe = p.pubkey === publicKey;
                const isWinner = result?.isWinner;
                const cards = p.holeCards;
                return (
                  <div key={p.pubkey} className={cn('flex items-center gap-2 text-[11px] font-mono',
                    isWinner ? 'text-amber-400' : p.folded ? 'text-gray-600' : 'text-gray-400'
                  )}>
                    <span className={cn('w-16 truncate', isMe && 'text-cyan-400')}>
                      {isMe ? 'YOU' : p.pubkey.slice(0, 6) + '...'}
                    </span>
                    {p.folded ? (
                      <span className="text-red-400/50 text-[10px]">FOLDED</span>
                    ) : cards ? (
                      <>
                        <span className="flex gap-0.5">
                          {cards.map((c, i) => {
                            const card = cardToString(c);
                            if (!card) return null;
                            return (
                              <span key={i} className={cn('px-1 py-0.5 rounded bg-white/[0.06] text-[10px] font-bold', card.isRed ? 'text-red-400' : 'text-gray-200')}>
                                {card.rank}{card.suit}
                              </span>
                            );
                          })}
                        </span>
                        {result && (
                          <span className={cn('text-[10px]', isWinner ? 'text-amber-400 font-bold' : 'text-gray-500')}>
                            {result.hand.name}
                          </span>
                        )}
                        {isWinner && <span className="text-amber-400 text-[10px]">★</span>}
                      </>
                    ) : (
                      <span className="text-gray-600 text-[10px]">no cards</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* MPC Note */}
          <div className="pt-1.5 border-t border-white/[0.04]">
            <div className="text-[9px] text-gray-600 leading-relaxed">
              <span className="text-emerald-400/70 font-bold">MPC Verified:</span> Cards dealt via Arcium MPC — encrypted to each player's unique key.
              Only you can decrypt your hole cards. All showdown results are evaluated and stored on-chain in the table account's{' '}
              <span className="text-gray-400 font-mono">revealed_hands</span> and{' '}
              <span className="text-gray-400 font-mono">hand_results</span> fields.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Mobile Detection (matches sm: breakpoint at 640px) ───

function useIsMobile() {
  const subscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia('(max-width: 639px)');
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  }, []);
  const getSnapshot = useCallback(() => window.innerWidth < 640, []);
  const getServerSnapshot = useCallback(() => false, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ─── Main PokerTable ───

export default function PokerTable({
  tablePda, phase, pot, currentPlayer, communityCards, players,
  myCards, onAction, isMyTurn, blinds = { small: 5, big: 10 },
  dealerSeat = 0, maxSeats = 2, handHistory = [], actionPending = false,
  showdownPot, tier = 0, prizePool = 0, maxPlayers = 2, lastActionSlot = 0,
  playerActions = [], pastHands = [], viewingPastHand = null, onHandNav,
  blindLevel = 0, tournamentStartTime = 0,
  currentBet = 0, tokenMint, onSeatClick, isCashGame = false, handNumber = 0,
}: PokerTableProps) {
  const { publicKey } = useWallet();
  const isMobile = useIsMobile();
  const tokenLogo = useTokenLogo(tokenMint);
  const fmtVal = useMemo(() => makeValueFormatter(blinds.big, tokenMint, isCashGame), [blinds.big, tokenMint, isCashGame]);
  const [betAmount, setBetAmount] = useState(blinds.big * 2);

  const layouts = isMobile ? SEAT_LAYOUTS_MOBILE : SEAT_LAYOUTS;
  const layout = layouts[maxSeats] || layouts[2];
  const myPlayer = players.find(p => p.pubkey === publicKey?.toBase58());
  const handLogRef = useRef<HTMLDivElement>(null);
  // Use table.min_bet (currentBet) for raise/call calculations — NOT player bets.
  // seat.bet_this_round accumulates across the whole hand and is never reset between
  // betting rounds, so deriving maxBet from player bets gives inflated values.
  const callAmountRaw = Math.max(currentBet - (myPlayer?.bet || 0), 0);
  const callAmount = Math.min(callAmountRaw, myPlayer?.chips || 0);
  const minRaise = Math.max(currentBet + blinds.big, blinds.big);
  const cardsDealt = phase !== 'Waiting' && phase !== 'Starting' && phase !== 'AwaitingDeal';
  const isShowdown = phase === 'Showdown' || phase === 'Complete' || phase === 'AwaitingShowdown';

  // Buffer community cards per-position to prevent flicker during phase transitions.
  // On-chain data briefly resets cards to 255 between phases (e.g. Flop→Turn).
  // We keep each position's last known valid card and only update when a new valid card arrives.
  const lastValidCardsRef = useRef<number[]>([255, 255, 255, 255, 255]);
  const bufferedCommunityCards = useMemo(() => {
    // Reset on new hand
    if (phase === 'Waiting' || phase === 'PreFlop' || phase === 'Starting' || phase === 'AwaitingDeal') {
      lastValidCardsRef.current = [255, 255, 255, 255, 255];
      return [255, 255, 255, 255, 255];
    }
    // Per-position merge: keep old valid card if new data is 255
    const merged = [255, 255, 255, 255, 255];
    for (let i = 0; i < 5; i++) {
      const incoming = communityCards[i];
      const cached = lastValidCardsRef.current[i];
      if (incoming !== undefined && incoming !== 255 && incoming >= 0 && incoming <= 51) {
        merged[i] = incoming;
      } else if (cached !== 255) {
        merged[i] = cached; // keep old valid card during brief gap
      }
    }
    lastValidCardsRef.current = [...merged];
    return merged;
  }, [communityCards, phase]);

  // ─── Player profiles (fetched from MongoDB) ───
  const [profiles, setProfiles] = useState<Record<string, { username: string; avatarUrl: string }>>({});
  const playerPubkeys = useMemo(() => players.map(p => p.pubkey).sort().join(','), [players]);
  useEffect(() => {
    if (!players.length) return;
    const wallets = players.map(p => p.pubkey);
    fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallets }),
    })
      .then(r => r.json())
      .then(data => { if (data.profiles) setProfiles(data.profiles); })
      .catch(() => {});
  }, [playerPubkeys]);

  // ─── Sound effects ───
  const [soundOn, setSoundOn] = useState(true);
  const { setSoundEnabled } = useSoundEffects(soundOn ? {
    phase,
    pot,
    currentPlayer,
    communityCards,
    players,
    isMyTurn: !!isMyTurn,
    myCards,
    timeLeft: undefined, // set below after timeLeft is declared
    handNumber: undefined,
  } : null);

  // Auto-action state
  const [autoAction, setAutoAction] = useState<'check-fold' | 'check' | 'call-any' | null>(null);

  // Reset betAmount to minRaise when phase changes (new betting round)
  // or when minRaise drops (e.g., new hand with lower bets)
  const prevPhaseRef = useRef(phase);
  const prevMinRaiseRef = useRef(minRaise);
  useEffect(() => {
    if (phase !== prevPhaseRef.current) {
      // New round — reset to minimum
      setBetAmount(minRaise);
      prevPhaseRef.current = phase;
    } else if (minRaise < prevMinRaiseRef.current) {
      // minRaise decreased (new hand, bets reset) — reset down
      setBetAmount(minRaise);
    } else if (minRaise > prevMinRaiseRef.current) {
      // minRaise increased (opponent raised) — clamp up
      setBetAmount(prev => Math.max(prev, minRaise));
    }
    prevMinRaiseRef.current = minRaise;
  }, [phase, minRaise]);

  // Execute auto-action when it becomes our turn
  useEffect(() => {
    if (!isMyTurn || !onAction || !autoAction || actionPending) return;
    if (autoAction === 'check-fold') {
      if (callAmount === 0) {
        onAction('check');
      } else {
        onAction('fold');
      }
      setAutoAction(null);
    } else if (autoAction === 'check') {
      if (callAmount === 0) {
        onAction('check');
        setAutoAction(null);
      } else {
        setAutoAction(null); // Can't auto-check when there's a bet — clear it
      }
    } else if (autoAction === 'call-any') {
      if (callAmount === 0) {
        onAction('check');
      } else {
        onAction('call');
      }
      setAutoAction(null);
    }
  }, [isMyTurn, autoAction, callAmount, onAction, actionPending]);

  // Blind countdown timer (5-minute levels = 300 seconds)
  const BLIND_INTERVAL = 300; // seconds
  const [blindCountdown, setBlindCountdown] = useState<number | null>(null);
  useEffect(() => {
    if (!tournamentStartTime || tournamentStartTime === 0 || blindLevel >= 13) {
      setBlindCountdown(null);
      return;
    }
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      const nextLevelAt = tournamentStartTime + (blindLevel + 1) * BLIND_INTERVAL;
      const remaining = nextLevelAt - now;
      setBlindCountdown(remaining > 0 ? remaining : 0);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [tournamentStartTime, blindLevel]);

  // Auto-scroll hand log to bottom on new entries
  useEffect(() => {
    if (handLogRef.current && viewingPastHand === null) {
      handLogRef.current.scrollTop = handLogRef.current.scrollHeight;
    }
  }, [handHistory.length, viewingPastHand]);

  const revealedCount = useMemo(() => {
    if (phase === 'Flop' || phase === 'TurnRevealPending') return 3;
    if (phase === 'Turn' || phase === 'RiverRevealPending') return 4;
    if (phase === 'River' || phase === 'Showdown' || phase === 'AwaitingShowdown' || phase === 'Complete') return 5;
    if (phase === 'FlopRevealPending') return 0; // flop not yet dealt
    return 0;
  }, [phase]);

  // ─── Action timeout countdown (resets when lastActionSlot changes) ───
  const TIMEOUT_SECS = 15;
  const TIMEBANK_EXTENSION = 15;
  const [timeLeft, setTimeLeft] = useState(TIMEOUT_SECS);
  const lastSlotRef = useRef(lastActionSlot);
  const timeBankWasActiveRef = useRef(false);
  const currentPlayerObj = players.find(p => p.seatIndex === currentPlayer);
  const isTimeBankActive = currentPlayerObj?.timeBankActive ?? false;

  // When timebank transitions from inactive → active, extend the timer
  useEffect(() => {
    if (isTimeBankActive && !timeBankWasActiveRef.current) {
      setTimeLeft(prev => prev + TIMEBANK_EXTENSION);
    }
    timeBankWasActiveRef.current = isTimeBankActive;
  }, [isTimeBankActive]);

  // Reset timer when action slot changes (new player's turn)
  useEffect(() => {
    if (lastActionSlot !== lastSlotRef.current) {
      lastSlotRef.current = lastActionSlot;
      timeBankWasActiveRef.current = false;
      setTimeLeft(TIMEOUT_SECS);
    }
  }, [lastActionSlot]);
  useEffect(() => {
    const isActive = phase === 'PreFlop' || phase === 'Flop' || phase === 'Turn' || phase === 'River'
      || phase === 'FlopRevealPending' || phase === 'TurnRevealPending' || phase === 'RiverRevealPending';
    if (!isActive) return;
    const t = setInterval(() => setTimeLeft(prev => Math.max(0, prev - 1)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Timer warning sounds (separate from main hook since timeLeft is local)
  useEffect(() => {
    if (!soundOn || !isMyTurn) return;
    if (timeLeft <= 5 && timeLeft > 0) {
      import('@/lib/poker-sounds').then(m => m.playSound('timerWarning'));
    } else if (timeLeft <= 10 && timeLeft > 5) {
      import('@/lib/poker-sounds').then(m => m.playSound('timerTick'));
    }
  }, [timeLeft, isMyTurn, soundOn]);

  // ─── Prize distribution status ───
  // Do not claim success from a client-only timer; finalization is confirmed on-chain.

  // ─── Showdown staged reveal ───
  const [showdownStage, setShowdownStage] = useState(0);
  const showdownTimerRef = useRef<NodeJS.Timeout[]>([]);

  useEffect(() => {
    // Clear previous timers
    showdownTimerRef.current.forEach(t => clearTimeout(t));
    showdownTimerRef.current = [];

    if (isShowdown) {
      // Stage 1: reveal cards (800ms)
      const t1 = setTimeout(() => setShowdownStage(1), 800);
      // Stage 2: show hand names (2500ms)
      const t2 = setTimeout(() => setShowdownStage(2), 2500);
      // Stage 3: highlight winner + chips (4000ms)
      const t3 = setTimeout(() => setShowdownStage(3), 4000);
      showdownTimerRef.current = [t1, t2, t3];
    } else {
      setShowdownStage(0);
    }

    return () => {
      showdownTimerRef.current.forEach(t => clearTimeout(t));
    };
  }, [isShowdown]);

  // ─── Showdown hand evaluation ───
  const showdownResults = useMemo(() => {
    if (!isShowdown) return null;

    const validCommunity = communityCards.filter(c => c !== 255 && c >= 0 && c <= 51);
    if (validCommunity.length < 3) return null;

    const results: Record<string, { hand: HandResult; isWinner: boolean }> = {};
    let bestScore = -1;

    for (const p of players) {
      if (p.folded || !p.isActive) continue;
      const hole = p.holeCards || (p.pubkey === publicKey?.toBase58() ? myCards : undefined);
      if (!hole) continue;
      // Skip unrevealed cards (255 = hidden)
      if (hole[0] === 255 || hole[1] === 255 || hole[0] > 51 || hole[1] > 51) continue;

      const hand = evaluateHand(hole, validCommunity);
      if (!hand) continue;

      results[p.pubkey] = { hand, isWinner: false };
      if (hand.score > bestScore) {
        bestScore = hand.score;
      }
    }

    // Mark ALL players with the best score as winners (handles split pots)
    const evaluatedCount = Object.keys(results).length;
    let winnerKey = '';
    if (evaluatedCount >= 2 && bestScore >= 0) {
      for (const [key, r] of Object.entries(results)) {
        if (r.hand.score === bestScore) {
          r.isWinner = true;
          if (!winnerKey) winnerKey = key; // first winner for backward compat
        }
      }
    } else if (evaluatedCount === 1) {
      // Only 1 hand visible — don't declare winner (opponent cards hidden)
      winnerKey = '';
    }

    return { results, winnerKey };
  }, [isShowdown, players, communityCards, myCards, publicKey]);

  const phaseColor: Record<string, string> = {
    Waiting: 'text-gray-400 bg-white/[0.04] border-white/[0.06]',
    Starting: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
    AwaitingDeal: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
    PreFlop: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
    Flop: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    FlopRevealPending: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    Turn: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    TurnRevealPending: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    River: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
    RiverRevealPending: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
    Showdown: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
    AwaitingShowdown: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
    Complete: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  };
  const phaseColorClass = phaseColor[phase] || 'text-gray-400 bg-white/[0.04] border-white/[0.06]';

  return (
    <div className="relative w-full max-w-4xl mx-auto">
      {/* Minimal top-right controls (sound + table ID) — info pills are rendered by parent page */}
      <div className="flex justify-end items-center mb-2 px-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setSoundOn(v => !v); setSoundEnabled(!soundOn); }}
            className={cn(
              "px-2 py-1 rounded-lg text-xs font-bold border transition-colors",
              soundOn
                ? "text-cyan-400 bg-cyan-500/10 border-cyan-500/20 hover:bg-cyan-500/20"
                : "text-gray-500 bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.06]"
            )}
            title={soundOn ? 'Mute sounds' : 'Enable sounds'}
          >
            {soundOn ? '🔊' : '🔇'}
          </button>
          <span className="text-gray-600 text-xs font-mono">{tablePda?.slice(0, 8)}...</span>
        </div>
      </div>

      {/* Payout Structure Bar (SNG only — not shown for cash games) */}
      {!isCashGame && tier !== undefined && (
        <div className="flex items-center justify-between mb-3 px-2 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-bold ${TIER_COLORS[tier] || 'text-gray-400'}`}>
              {TIER_NAMES[tier] || 'Unknown'}
            </span>
            {prizePool > 0 && (
              <span className="text-emerald-400/80 text-xs font-mono">
                Pool: {(prizePool / 1e9).toFixed(4)} SOL
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {(PAYOUT_BPS[maxPlayers] || PAYOUT_BPS[2]).map((bps, i) => {
              const solAmt = prizePool > 0 ? ((prizePool / 1e9) * bps / 10000) : 0;
              const pokerAmt = (100 * maxPlayers * bps / 10000);
              return (
                <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.06]">
                  <span className="text-gray-500">{i === 0 ? '1st' : i === 1 ? '2nd' : '3rd'}</span>
                  {' '}
                  {solAmt > 0 && (
                    <span className={i === 0 ? 'text-emerald-400' : 'text-emerald-400/70'}>{solAmt.toFixed(4)} </span>
                  )}
                  <span className={i === 0 ? 'text-purple-400' : 'text-purple-400/70'}>{pokerAmt.toFixed(0)} POKER</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Table Surface */}
      <div className="relative aspect-[4/3] sm:aspect-[16/9] poker-table-gradient rounded-[40px] sm:rounded-[80px] border-[6px] sm:border-[10px] border-gray-800/80">
        {/* Inner rail */}
        <div className="absolute inset-2 sm:inset-3 rounded-[30px] sm:rounded-[66px] border border-emerald-500/10" />

        {/* Token watermark */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
          <img src={tokenLogo} alt="" className="w-16 h-16 sm:w-20 sm:h-20 md:w-24 md:h-24 opacity-[0.06]" />
        </div>

        {/* Waiting overlay — centered on table */}
        {phase === 'Waiting' && (() => {
          const seatedCount = players.filter(p => p.pubkey && p.pubkey !== '11111111111111111111111111111111').length;
          const needed = Math.max(0, 2 - seatedCount);
          const isActive = isCashGame && handNumber > 0 && needed <= 0;
          if (needed > 0 || (!isActive && seatedCount === 0)) {
            const msg = seatedCount === 0
              ? 'Take a seat to join'
              : needed > 0
                ? `Waiting for ${needed} more player${needed > 1 ? 's' : ''}...`
                : 'Starting...';
            return (
              <div className="absolute inset-0 flex items-center justify-center z-30 pointer-events-none">
                <div className="px-6 py-3 rounded-2xl bg-black/50 backdrop-blur-sm border border-white/10">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                    <span className="text-white/90 text-sm font-bold">{msg}</span>
                  </div>
                </div>
              </div>
            );
          }
          if (isActive) return (
            <div className="absolute inset-0 flex items-center justify-center z-30 pointer-events-none">
              <div className="px-6 py-3 rounded-2xl bg-black/50 backdrop-blur-sm border border-emerald-500/20">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  <span className="text-emerald-400 text-sm font-bold">Dealing next hand...</span>
                </div>
              </div>
            </div>
          );
          return null;
        })()}

        {/* MPC processing overlay — shows during Arcium MPC computation */}
        {(phase === 'AwaitingDeal' || phase === 'Starting' || phase === 'FlopRevealPending' || phase === 'TurnRevealPending' || phase === 'RiverRevealPending' || phase === 'AwaitingShowdown') && (
          <div className="absolute inset-0 flex items-center justify-center z-30 pointer-events-none">
            <div className="px-6 py-3 rounded-2xl bg-black/50 backdrop-blur-sm border border-cyan-500/20">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
                <span className="text-cyan-300 text-sm font-bold">
                  {phase === 'AwaitingDeal' || phase === 'Starting' ? 'Shuffling & Dealing...' :
                   phase === 'FlopRevealPending' ? 'Revealing Flop...' :
                   phase === 'TurnRevealPending' ? 'Revealing Turn...' :
                   phase === 'RiverRevealPending' ? 'Revealing River...' :
                   'Revealing Hands...'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Pot */}
        {pot > 0 && (
          <div className="absolute top-[30%] left-1/2 -translate-x-1/2 z-20">
            <div className="glass rounded-full px-4 py-1 border-amber-500/20">
              <span className="text-amber-400 text-sm font-bold tabular-nums">{fmtVal(pot)}</span>
            </div>
          </div>
        )}

        {/* Winner chips shown on seat — no separate banner needed */}

        {/* Community Cards (buffered to prevent flicker during phase transitions) */}
        <div className="absolute top-[46%] left-1/2 -translate-x-1/2 -translate-y-1/2 flex gap-0.5 sm:gap-1 md:gap-1.5 z-10">
          {[0, 1, 2, 3, 4].map(i => {
            const card = bufferedCommunityCards[i];
            const revealed = i < revealedCount && card !== undefined && card !== 255;
            if (revealed) return <TableCard key={i} cardNum={card} size="md" />;
            if (revealedCount > 0) return <TableCard key={i} cardNum={0} size="md" outline />;
            return <div key={i} />;
          })}
        </div>

        {/* Seats — rotated so hero is always at the bottom */}
        {(() => {
          // Build seatIndex → Player lookup
          const seatMap = new Map<number, Player>();
          players.forEach(p => { if (p) seatMap.set(p.seatIndex, p); });

          // Find hero's seat for rotation (hero renders at layout position 0 = bottom)
          const myPubkeyStr = publicKey?.toBase58();
          const heroSeatIdx = myPubkeyStr
            ? players.find(p => p.pubkey === myPubkeyStr)?.seatIndex ?? 0
            : 0;

          // Determine fold winner when showdownResults is null (no community cards)
          const foldWinner = isShowdown && !showdownResults?.winnerKey
            ? players.find(p => p && !p.folded && p.isActive)?.pubkey || ''
            : '';
          // Count winners for split pot display
          const winnerCount = showdownResults
            ? Object.values(showdownResults.results).filter(r => r.isWinner).length
            : (foldWinner ? 1 : 0);
          const isSplitPot = winnerCount > 1;
          const splitPotShare = isSplitPot ? Math.floor((showdownPot || pot) / winnerCount) : (showdownPot || pot);
          return layout.map((pos, visualIdx) => {
            // Map visual position back to actual seat index
            const i = (visualIdx + heroSeatIdx) % maxPlayers;
            const p = seatMap.get(i) || null;
            const pKey = p?.pubkey;
            const playerResult = pKey && showdownResults?.results[pKey];
            const seatAction = p ? playerActions.find(a => a.seatIndex === i) : undefined;
            // Winner: from hand evaluation OR fold winner
            const isWinnerSeat = playerResult ? playerResult.isWinner : (foldWinner && pKey === foldWinner);
            return (
              <PlayerSeat
                key={i}
                player={p}
                pos={pos}
                isCurrentPlayer={i === currentPlayer}
                seatIndex={i}
                isMe={p?.pubkey === publicKey?.toBase58()}
                isDealer={i === dealerSeat}
                cardsDealt={cardsDealt}
                isShowdown={isShowdown}
                showdownStage={showdownStage}
                handName={playerResult ? (isSplitPot && playerResult.isWinner ? `${playerResult.hand.name} (SPLIT)` : playerResult.hand.name) : undefined}
                isWinner={!!isWinnerSeat}
                lastAction={seatAction ? { action: seatAction.action, timestamp: seatAction.timestamp } : null}
                timeLeft={i === currentPlayer ? timeLeft : undefined}
                timeoutSecs={isTimeBankActive ? TIMEOUT_SECS + TIMEBANK_EXTENSION : TIMEOUT_SECS}
                showdownPot={isWinnerSeat ? splitPotShare : (showdownPot || pot)}
                fmtVal={fmtVal}
                onSeatClick={onSeatClick}
                profileAvatarId={pKey ? profiles[pKey]?.avatarUrl : undefined}
                profileName={pKey ? profiles[pKey]?.username : undefined}
              />
            );
          });
        })()}
      </div>

      {/* Hero Cards */}
      {myCards && cardsDealt && (
        <div className="flex justify-center gap-1.5 sm:gap-2 mt-2 sm:mt-4">
          <TableCard cardNum={myCards[0]} size="lg" />
          <TableCard cardNum={myCards[1]} size="lg" />
        </div>
      )}

      {/* ─── Action Panel ─── */}
      {isMyTurn && onAction && phase !== 'Waiting' && phase !== 'Complete' && phase !== 'Showdown' && (
        <div className="mt-4 glass-card p-4">
          {actionPending && (
            <div className="text-center text-xs text-yellow-400/80 mb-2 animate-pulse">Confirming transaction...</div>
          )}
          <div className={cn("grid grid-cols-4 sm:flex sm:items-center sm:justify-center gap-1.5 sm:gap-2.5 sm:flex-wrap", actionPending && "opacity-50 pointer-events-none")}>
            {/* Fold */}
            <button
              onClick={() => onAction('fold')}
              disabled={actionPending}
              className="px-3 py-3 sm:px-5 sm:py-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 font-bold text-xs sm:text-sm hover:bg-red-500/20 active:bg-red-500/30 transition-colors disabled:opacity-30"
            >
              Fold
            </button>

            {/* Check / Call */}
            {callAmount > 0 ? (
              <button
                onClick={() => onAction('call')}
                disabled={actionPending}
                className="px-3 py-3 sm:px-5 sm:py-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-bold text-xs sm:text-sm hover:bg-cyan-500/20 active:bg-cyan-500/30 transition-colors disabled:opacity-30"
              >
                Call {fmtVal(callAmount)}
              </button>
            ) : (
              <button
                onClick={() => onAction('check')}
                disabled={actionPending}
                className="px-3 py-3 sm:px-5 sm:py-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-bold text-xs sm:text-sm hover:bg-cyan-500/20 active:bg-cyan-500/30 transition-colors disabled:opacity-30"
              >
                Check
              </button>
            )}

            {/* Raise / Bet */}
            <button
              onClick={() => onAction('raise', betAmount)}
              disabled={betAmount < minRaise || actionPending}
              className="px-3 py-3 sm:px-5 sm:py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-bold text-xs sm:text-sm hover:bg-emerald-500/20 active:bg-emerald-500/30 transition-colors disabled:opacity-30"
            >
              {callAmount === 0 ? 'Bet' : 'Raise'}
            </button>

            {/* All-In */}
            <button
              onClick={() => onAction('allin')}
              disabled={actionPending}
              className="px-3 py-3 sm:px-5 sm:py-2.5 rounded-xl bg-gradient-to-r from-amber-500/20 to-orange-500/20 border border-amber-500/30 text-amber-400 font-bold text-xs sm:text-sm hover:from-amber-500/30 hover:to-orange-500/30 active:from-amber-500/40 active:to-orange-500/40 transition-colors disabled:opacity-30"
            >
              All-In
            </button>
          </div>

          {/* Time Bank */}
          {myPlayer?.timeBankSeconds !== undefined && myPlayer.timeBankSeconds > 0 && (
            <div className="flex items-center justify-center gap-2 mt-2">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-purple-500/10 border border-purple-500/20">
                <span className="text-purple-400 text-[10px] font-bold">⏱ {myPlayer.timeBankSeconds}s</span>
              </div>
              {!myPlayer.timeBankActive && (
                <button
                  onClick={() => onAction('use_time_bank')}
                  disabled={actionPending}
                  className="px-3 py-1.5 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-400 font-bold text-xs hover:bg-purple-500/25 active:bg-purple-500/35 transition-colors disabled:opacity-30"
                >
                  Use Time Bank (+15s)
                </button>
              )}
              {myPlayer.timeBankActive && (
                <span className="text-purple-400/60 text-[10px] font-medium">Time bank active</span>
              )}
            </div>
          )}

          {/* Raise slider + input (separate row on mobile for more space) */}
          <div className="flex items-center gap-2 mt-2 px-2 sm:px-3 py-1.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
            <input
              type="range"
              min={minRaise}
              max={myPlayer?.chips || 1500}
              step={blinds.big}
              value={betAmount}
              onChange={(e) => setBetAmount(Number(e.target.value))}
              className="flex-1 min-w-0 accent-emerald-500"
              disabled={actionPending}
            />
            <input
              type="text"
              inputMode="decimal"
              value={fmtVal(betAmount)}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9.]/g, '');
                if (!raw) return;
                const isLamports = isCashGame || blinds.big >= 10000;
                const parsed = isLamports ? Math.round(parseFloat(raw) * 1e9) : parseInt(raw);
                if (!isNaN(parsed) && parsed > 0) setBetAmount(parsed);
              }}
              onBlur={() => {
                const max = myPlayer?.chips || 1500;
                setBetAmount(prev => Math.max(minRaise, Math.min(prev, max)));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && onAction && betAmount >= minRaise) {
                  onAction('raise', betAmount);
                }
              }}
              className="w-16 sm:w-20 bg-white/[0.05] border border-white/[0.1] rounded-lg px-2 py-1.5 text-white text-xs sm:text-sm font-mono tabular-nums text-center focus:border-emerald-500/50 focus:outline-none"
              disabled={actionPending}
            />
          </div>

          {/* Quick bet row */}
          <div className="flex justify-center gap-2 mt-2">
            {[0.33, 0.5, 0.75, 1].map(pct => {
              const amt = Math.max(minRaise, Math.floor(pot * pct));
              return (
                <button
                  key={pct}
                  onClick={() => setBetAmount(Math.min(amt, myPlayer?.chips || 1500))}
                  className="px-2 py-0.5 rounded text-[10px] font-mono text-gray-400 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] transition-colors"
                >
                  {pct === 1 ? 'POT' : `${Math.round(pct * 100)}%`}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Auto-action checkboxes (visible when NOT my turn) */}
      {!isMyTurn && onAction && phase !== 'Waiting' && phase !== 'Complete' && phase !== 'Showdown' && !isShowdown && (
        <div className="mt-3 flex justify-center gap-3">
          {[
            { key: 'check-fold' as const, label: 'Check/Fold' },
            { key: 'check' as const, label: 'Auto Check' },
            { key: 'call-any' as const, label: 'Call Any' },
          ].map(opt => (
            <label
              key={opt.key}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg cursor-pointer text-xs font-bold transition-all select-none',
                autoAction === opt.key
                  ? 'bg-cyan-500/15 border border-cyan-500/40 text-cyan-300'
                  : 'bg-white/[0.03] border border-white/[0.06] text-gray-500 hover:text-gray-400 hover:bg-white/[0.05]'
              )}
            >
              <input
                type="checkbox"
                checked={autoAction === opt.key}
                onChange={() => setAutoAction(autoAction === opt.key ? null : opt.key)}
                className="hidden"
              />
              <div className={cn(
                'w-3 h-3 rounded-sm border flex items-center justify-center',
                autoAction === opt.key ? 'bg-cyan-500 border-cyan-400' : 'border-gray-600'
              )}>
                {autoAction === opt.key && <span className="text-[8px] text-white">✓</span>}
              </div>
              {opt.label}
            </label>
          ))}
        </div>
      )}


      {/* Showdown */}
      {isShowdown && (() => {
        const nonFoldedCount = players.filter(p => !p.folded && p.isActive).length;
        const hasCommunity = communityCards.some(c => c !== 255 && c >= 0 && c <= 51);
        const isFoldWin = nonFoldedCount <= 1 && !hasCommunity;

        if (isFoldWin) {
          // Fold win — minimal banner, +CHIPS shown on winner's seat
          return (
            <div className="mt-4 text-center">
              <div className="inline-block glass-card px-5 py-2 border-emerald-500/20">
                <div className="text-xs font-bold text-emerald-400 tracking-wide">Won by fold</div>
              </div>
            </div>
          );
        }

        // Minimal showdown status — winner chips shown on their seat above
        return (
          <div className="mt-4 text-center">
            <div className="inline-block glass-card px-5 py-2 border-purple-500/20">
              {showdownStage < 2 && (
                <div className="text-xs font-bold text-purple-400 tracking-wider animate-pulse">SHOWDOWN</div>
              )}
              {showdownStage === 2 && (
                <div className="text-xs font-bold text-purple-400 tracking-wider">Evaluating...</div>
              )}
              {showdownStage >= 3 && (
                <div className="text-xs font-bold text-gray-400">Settling hand...</div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Tournament Complete */}
      {phase === 'Complete' && (() => {
        const winner = players.find(p => p.chips > 0);
        const isWin = winner?.pubkey === publicKey?.toBase58();
        const payouts = PAYOUT_BPS[maxPlayers] || PAYOUT_BPS[2];
        const pokerPool = 100_000_000 * maxPlayers; // 100 POKER per player (6 dec)
        const myPlacement = isWin ? 1 : maxPlayers; // simplified for HU; extend for multi-player
        const ordinal = (n: number) => n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
        return (
          <div className="mt-4 text-center">
            <div className={cn(
              'inline-block glass-card px-8 py-6 transition-all duration-1000 min-w-[320px]',
              isWin
                ? 'border-amber-500/30 shadow-[0_0_30px_rgba(251,191,36,0.2)]'
                : 'border-red-500/20 shadow-[0_0_20px_rgba(239,68,68,0.1)]'
            )}>
              <div className="text-3xl mb-2">{isWin ? '🏆' : '💀'}</div>
              <div className={`text-xl font-bold mb-1 ${isWin ? 'text-amber-300' : 'text-red-400'}`}>
                {isWin ? 'YOU WIN!' : 'YOU WERE ELIMINATED'}
              </div>
              <p className="text-gray-500 text-xs mb-4">
                You finished <span className={isWin ? 'text-amber-400 font-bold' : 'text-gray-300 font-bold'}>{ordinal(myPlacement)}</span> of {maxPlayers}
              </p>

              {/* Prize table with wallet addresses */}
              <div className="space-y-2 mb-4">
                {payouts.map((bps, i) => {
                  const solAmt = prizePool > 0 ? (prizePool / 1e9) * bps / 10000 : 0;
                  const pokerAmt = (pokerPool * bps / 10000) / 1_000_000;
                  // For HU: 1st = winner, 2nd = loser
                  const placementPlayer = i === 0 ? winner : players.find(p => p.pubkey !== winner?.pubkey);
                  const isMe = placementPlayer?.pubkey === publicKey?.toBase58();
                  return (
                    <div key={i} className={cn(
                      'flex items-center justify-between gap-4 text-xs px-3 py-1.5 rounded-lg',
                      isMe ? 'bg-white/[0.06] border border-white/[0.1]' : 'bg-white/[0.02]'
                    )}>
                      <div className="flex items-center gap-2">
                        <span className={cn('font-bold', i === 0 ? 'text-amber-400' : 'text-gray-500')}>
                          {ordinal(i + 1)}
                        </span>
                        <span className={cn('font-mono', isMe ? 'text-cyan-400' : 'text-gray-400')}>
                          {isMe ? 'YOU' : (placementPlayer?.pubkey?.slice(0, 8) || '???') + '...'}
                        </span>
                      </div>
                      <span className="text-gray-300 font-mono">
                        <span className="text-purple-400">{pokerAmt.toFixed(0)} POKER</span>
                        {solAmt > 0 && <span className="text-emerald-400 ml-1">+ {solAmt.toFixed(4)} SOL</span>}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center justify-center gap-2 text-xs text-cyan-400/70">
                <div className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse" />
                Finalizing prizes on L1...
              </div>
            </div>
          </div>
        );
      })()}

      {/* Verify Hand (after showdown) */}
      {isShowdown && showdownStage >= 3 && showdownResults && (
        <VerifyHand
          tablePda={tablePda}
          communityCards={communityCards}
          players={players}
          showdownResults={showdownResults}
          publicKey={publicKey?.toBase58()}
        />
      )}

      {/* Hand History with Navigation */}
      {(() => {
        const isViewingPast = viewingPastHand !== null;
        const viewedHand = isViewingPast ? (pastHands[viewingPastHand] || []) : handHistory;
        const totalPast = pastHands.length;
        const hasHistory = viewedHand.length > 0 || totalPast > 0;

        if (!hasHistory) return null;

        return (
          <div className="mt-4 glass-card p-3">
            {/* Navigation header */}
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] font-mono font-bold text-gray-500 uppercase tracking-wider">
                {isViewingPast ? `Hand ${viewingPastHand! + 1} of ${totalPast}` : `Current Hand`}
                {totalPast > 0 && !isViewingPast && ` (${totalPast} prev)`}
              </div>
              {totalPast > 0 && onHandNav && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onHandNav(isViewingPast && viewingPastHand! > 0 ? viewingPastHand! - 1 : isViewingPast ? null : totalPast - 1)}
                    disabled={isViewingPast && viewingPastHand === 0}
                    className="px-1.5 py-0.5 rounded text-[9px] font-bold text-gray-400 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] disabled:opacity-30 transition-colors"
                  >
                    ◀
                  </button>
                  {isViewingPast && (
                    <button
                      onClick={() => onHandNav(null)}
                      className="px-1.5 py-0.5 rounded text-[9px] font-bold text-cyan-400 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 transition-colors"
                    >
                      LIVE
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (!isViewingPast) return;
                      if (viewingPastHand! < totalPast - 1) onHandNav(viewingPastHand! + 1);
                      else onHandNav(null);
                    }}
                    disabled={!isViewingPast}
                    className="px-1.5 py-0.5 rounded text-[9px] font-bold text-gray-400 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] disabled:opacity-30 transition-colors"
                  >
                    ▶
                  </button>
                </div>
              )}
            </div>
            {/* Hand entries */}
            <div ref={handLogRef} className="space-y-0.5 max-h-24 overflow-y-auto scrollbar-thin">
              {viewedHand.length === 0 ? (
                <div className="text-[10px] text-gray-600 font-mono">Waiting for actions...</div>
              ) : viewedHand.map((a, i) => {
                const isResult = a.phase === 'Result';
                const isSummary = a.phase === 'Summary';
                const isMyAction = a.player === 'You';
                const actionUpper = a.action.toUpperCase();

                // Summary entries (board, player hands) get a distinct look
                if (isSummary) {
                  const isBoard = a.action.startsWith('Board:');
                  return (
                    <div key={i} className={cn('text-[11px] font-mono flex items-center gap-1.5',
                      isBoard && 'mt-1 pt-1 border-t border-white/[0.06]'
                    )}>
                      {isBoard ? (
                        <span className="text-purple-400">{a.action}</span>
                      ) : (
                        <>
                          <span className={isMyAction ? 'text-cyan-400' : 'text-gray-400'}>{a.player}</span>
                          <span className={a.action === 'folded' ? 'text-red-400/70 italic' : 'text-amber-300'}>{a.action}</span>
                        </>
                      )}
                    </div>
                  );
                }

                return (
                  <div key={i} className={cn('text-[11px] font-mono flex items-center gap-1.5', isResult && 'mt-1 pt-1 border-t border-white/[0.06]')}>
                    <span className={isResult ? 'text-amber-500 font-bold' : 'text-gray-600'}>{a.phase}</span>
                    <span className={isMyAction ? 'text-cyan-400' : 'text-gray-400'}>{a.player}</span>
                    <span className={cn('font-medium',
                      actionUpper.startsWith('WON') ? 'text-amber-400 font-bold' :
                      actionUpper.startsWith('LOST') ? 'text-red-400/70' :
                      actionUpper.startsWith('FOLD') ? 'text-red-400/70' :
                      actionUpper.startsWith('RAISE') || actionUpper.startsWith('ALL') ? 'text-emerald-400' :
                      actionUpper.startsWith('CALL') ? 'text-cyan-400' :
                      actionUpper.startsWith('SB') || actionUpper.startsWith('BB') ? 'text-amber-400/70' :
                      actionUpper.startsWith('CHECK') ? 'text-gray-300' : 'text-gray-400'
                    )}>
                      {a.action}{a.amount && !a.action.includes(String(a.amount)) ? ` ${a.amount}` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
