'use client';

import { cn } from '@/lib/utils';
import { Card, CommunityCards } from './Card';
import { Seat } from './Seat';
import { useGameStore } from '@/store/gameStore';
import { GamePhase } from '@/lib/constants';

interface TableProps {
  className?: string;
}

// Seat positions around an oval table (for 2-9 players)
const SEAT_POSITIONS: Record<number, { top: string; left: string; transform?: string }[]> = {
  2: [
    { top: '85%', left: '50%', transform: 'translateX(-50%)' }, // Bottom center (hero)
    { top: '5%', left: '50%', transform: 'translateX(-50%)' },  // Top center (villain)
  ],
  6: [
    { top: '85%', left: '50%', transform: 'translateX(-50%)' },
    { top: '70%', left: '10%' },
    { top: '20%', left: '10%' },
    { top: '5%', left: '50%', transform: 'translateX(-50%)' },
    { top: '20%', left: '90%', transform: 'translateX(-100%)' },
    { top: '70%', left: '90%', transform: 'translateX(-100%)' },
  ],
  9: [
    { top: '85%', left: '50%', transform: 'translateX(-50%)' },
    { top: '80%', left: '20%' },
    { top: '55%', left: '5%' },
    { top: '25%', left: '10%' },
    { top: '5%', left: '30%' },
    { top: '5%', left: '70%', transform: 'translateX(-100%)' },
    { top: '25%', left: '90%', transform: 'translateX(-100%)' },
    { top: '55%', left: '95%', transform: 'translateX(-100%)' },
    { top: '80%', left: '80%', transform: 'translateX(-100%)' },
  ],
};

export function Table({ className }: TableProps) {
  const { 
    phase, pot, communityCards, players, maxPlayers, 
    mySeatIndex, dealerButton, currentPlayer 
  } = useGameStore();

  const positions = SEAT_POSITIONS[maxPlayers] || SEAT_POSITIONS[6];

  return (
    <div className={cn('relative w-full aspect-[16/10] max-w-4xl mx-auto', className)}>
      {/* Table felt */}
      <div className="absolute inset-[10%] rounded-[50%] bg-gradient-to-br from-green-800 via-green-700 to-green-800 border-8 border-amber-900 shadow-2xl">
        {/* Inner rail */}
        <div className="absolute inset-2 rounded-[50%] border-4 border-amber-800/50" />
        
        {/* Center area */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
          {/* Pot display */}
          {pot > 0 && (
            <div className="bg-black/40 px-4 py-2 rounded-full">
              <span className="text-yellow-400 font-bold text-lg">
                Pot: {(pot / 1e9).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 })} SOL
              </span>
            </div>
          )}

          {/* Community cards */}
          {phase !== GamePhase.Waiting && (
            <CommunityCards cards={communityCards as number[]} size="md" />
          )}

          {/* Phase indicator */}
          <div className="text-white/60 text-sm uppercase tracking-wider">
            {phase}
          </div>
        </div>
      </div>

      {/* Player seats */}
      {positions.map((pos, index) => {
        const player = players.find(p => p.seatIndex === index);
        const isDealer = dealerButton === index;
        const isCurrentPlayer = currentPlayer === index;
        const isHero = mySeatIndex === index;

        return (
          <div
            key={index}
            className="absolute"
            style={{
              top: pos.top,
              left: pos.left,
              transform: pos.transform || 'none',
            }}
          >
            <Seat
              seatIndex={index}
              player={player}
              isDealer={isDealer}
              isCurrentPlayer={isCurrentPlayer}
              isHero={isHero}
            />
          </div>
        );
      })}
    </div>
  );
}
