'use client';

import { cn } from '@/lib/utils';
import { CardPair } from './Card';
import { formatChips, shortenAddress } from '@/lib/utils';
import type { TablePlayer } from '@/store/gameStore';

interface SeatProps {
  seatIndex: number;
  player?: TablePlayer;
  isDealer?: boolean;
  isCurrentPlayer?: boolean;
  isHero?: boolean;
}

export function Seat({ seatIndex, player, isDealer, isCurrentPlayer, isHero }: SeatProps) {
  const isEmpty = !player;

  if (isEmpty) {
    return (
      <div className="w-32 h-24 rounded-lg border-2 border-dashed border-white/20 flex items-center justify-center">
        <span className="text-white/40 text-sm">Empty</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative w-36 rounded-lg p-2 transition-all',
        isCurrentPlayer && 'ring-2 ring-yellow-400 ring-offset-2 ring-offset-green-800',
        player.isFolded && 'opacity-50'
      )}
    >
      {/* Dealer button */}
      {isDealer && (
        <div className="absolute -top-2 -left-2 w-6 h-6 bg-white rounded-full flex items-center justify-center text-xs font-bold shadow-lg">
          D
        </div>
      )}

      {/* Cards */}
      <div className="flex justify-center mb-2">
        <CardPair
          card1={isHero ? player.cards[0] : 255}
          card2={isHero ? player.cards[1] : 255}
          size="sm"
        />
      </div>

      {/* Player info */}
      <div className={cn(
        'bg-gray-900/90 rounded-lg p-2 text-center',
        isHero && 'bg-blue-900/90'
      )}>
        <div className="text-white text-xs truncate">
          {isHero ? 'You' : shortenAddress(player.pubkey.toBase58())}
        </div>
        <div className="text-yellow-400 font-bold">
          {formatChips(player.chips)}
        </div>
        {player.currentBet > 0 && (
          <div className="text-green-400 text-xs">
            Bet: {formatChips(player.currentBet)}
          </div>
        )}
      </div>

      {/* Status indicators */}
      {player.isAllIn && (
        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-red-600 text-white text-xs px-2 py-0.5 rounded-full">
          ALL IN
        </div>
      )}
      {player.isFolded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-red-500 font-bold text-lg rotate-[-15deg]">FOLDED</span>
        </div>
      )}
    </div>
  );
}
