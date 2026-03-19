'use client';

import { cn } from '@/lib/utils';

interface CardProps {
  value: number; // 0-51 or 255 for hidden
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  faceDown?: boolean;
}

const SUITS = ['♠', '♥', '♦', '♣'] as const;
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;

function parseCard(value: number): { rank: string; suit: string; color: 'red' | 'black' } | null {
  if (value < 0 || value > 51) return null;
  const suitIndex = Math.floor(value / 13);
  const rankIndex = value % 13;
  return {
    rank: RANKS[rankIndex],
    suit: SUITS[suitIndex],
    color: suitIndex === 1 || suitIndex === 2 ? 'red' : 'black',
  };
}

const sizeClasses = {
  sm: 'w-10 h-14 text-xs',
  md: 'w-14 h-20 text-sm',
  lg: 'w-20 h-28 text-base',
};

export function Card({ value, size = 'md', className, faceDown }: CardProps) {
  const isHidden = value === 255 || faceDown;
  const card = !isHidden ? parseCard(value) : null;

  if (isHidden) {
    return (
      <div
        className={cn(
          sizeClasses[size],
          'rounded-lg border-2 border-gray-600 bg-gradient-to-br from-blue-900 via-blue-800 to-blue-900',
          'flex items-center justify-center shadow-lg',
          'relative overflow-hidden',
          className
        )}
      >
        {/* Card back pattern */}
        <div className="absolute inset-1 rounded border border-blue-500/30 bg-[radial-gradient(circle_at_center,_transparent_30%,_rgba(59,130,246,0.1)_70%)]">
          <div className="absolute inset-0 opacity-20">
            <div className="h-full w-full bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(255,255,255,0.05)_4px,rgba(255,255,255,0.05)_8px)]" />
          </div>
        </div>
        <span className="text-2xl text-blue-400/60">♠</span>
      </div>
    );
  }

  if (!card) return null;

  return (
    <div
      className={cn(
        sizeClasses[size],
        'rounded-lg border border-gray-300 bg-white',
        'flex flex-col items-center justify-between p-1 shadow-lg',
        'transition-transform hover:scale-105',
        className
      )}
    >
      {/* Top rank and suit */}
      <div className={cn('flex flex-col items-center leading-none', card.color === 'red' ? 'text-red-600' : 'text-gray-900')}>
        <span className="font-bold">{card.rank}</span>
        <span className="text-[0.6em]">{card.suit}</span>
      </div>

      {/* Center suit */}
      <span className={cn('text-2xl', card.color === 'red' ? 'text-red-600' : 'text-gray-900')}>
        {card.suit}
      </span>

      {/* Bottom rank and suit (inverted) */}
      <div className={cn('flex flex-col items-center leading-none rotate-180', card.color === 'red' ? 'text-red-600' : 'text-gray-900')}>
        <span className="font-bold">{card.rank}</span>
        <span className="text-[0.6em]">{card.suit}</span>
      </div>
    </div>
  );
}

export function CardPair({ card1, card2, size = 'md' }: { card1: number; card2: number; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <div className="flex gap-1">
      <Card value={card1} size={size} />
      <Card value={card2} size={size} />
    </div>
  );
}

export function CommunityCards({ cards, size = 'md' }: { cards: number[]; size?: 'sm' | 'md' | 'lg' }) {
  const dealt = cards.filter(c => c !== 255 && c >= 0 && c <= 51);
  if (dealt.length === 0) return null;
  return (
    <div className="flex gap-2">
      {dealt.map((card, i) => (
        <Card key={i} value={card} size={size} />
      ))}
    </div>
  );
}
