'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useGameStore, selectIsMyTurn, selectCanCheck, selectCallAmount, selectMinRaise } from '@/store/gameStore';
import { formatChips } from '@/lib/utils';

interface BettingControlsProps {
  onAction: (action: 'fold' | 'check' | 'call' | 'raise', amount?: number) => void;
  disabled?: boolean;
}

export function BettingControls({ onAction, disabled }: BettingControlsProps) {
  const state = useGameStore();
  const isMyTurn = selectIsMyTurn(state);
  const canCheck = selectCanCheck(state);
  const callAmount = selectCallAmount(state);
  const minRaise = selectMinRaise(state);

  const [raiseAmount, setRaiseAmount] = useState(minRaise);
  const [showRaiseSlider, setShowRaiseSlider] = useState(false);

  const myPlayer = state.players.find(p => p.seatIndex === state.mySeatIndex);
  const maxBet = myPlayer?.chips || 0;

  if (!isMyTurn || disabled) {
    return (
      <div className="flex items-center justify-center h-20 bg-gray-900/80 rounded-lg">
        <span className="text-gray-400">
          {disabled ? 'Waiting...' : 'Not your turn'}
        </span>
      </div>
    );
  }

  return (
    <div className="bg-gray-900/90 rounded-lg p-4 space-y-4">
      {/* Main action buttons */}
      <div className="flex gap-2 justify-center">
        {/* Fold */}
        <button
          onClick={() => onAction('fold')}
          className={cn(
            'px-6 py-3 rounded-lg font-bold text-white transition-all',
            'bg-red-600 hover:bg-red-700 active:scale-95'
          )}
        >
          Fold
        </button>

        {/* Check/Call */}
        {canCheck ? (
          <button
            onClick={() => onAction('check')}
            className={cn(
              'px-6 py-3 rounded-lg font-bold text-white transition-all',
              'bg-green-600 hover:bg-green-700 active:scale-95'
            )}
          >
            Check
          </button>
        ) : (
          <button
            onClick={() => onAction('call', callAmount)}
            className={cn(
              'px-6 py-3 rounded-lg font-bold text-white transition-all',
              'bg-blue-600 hover:bg-blue-700 active:scale-95'
            )}
          >
            Call {formatChips(callAmount)}
          </button>
        )}

        {/* Raise */}
        <button
          onClick={() => setShowRaiseSlider(!showRaiseSlider)}
          className={cn(
            'px-6 py-3 rounded-lg font-bold text-white transition-all',
            'bg-yellow-600 hover:bg-yellow-700 active:scale-95',
            showRaiseSlider && 'ring-2 ring-yellow-400'
          )}
        >
          Raise
        </button>

        {/* All In */}
        <button
          onClick={() => onAction('raise', maxBet)}
          className={cn(
            'px-6 py-3 rounded-lg font-bold text-white transition-all',
            'bg-purple-600 hover:bg-purple-700 active:scale-95'
          )}
        >
          All In
        </button>
      </div>

      {/* Raise slider */}
      {showRaiseSlider && (
        <div className="space-y-2">
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={minRaise}
              max={maxBet}
              value={raiseAmount}
              onChange={(e) => setRaiseAmount(Number(e.target.value))}
              className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
            />
            <input
              type="number"
              value={raiseAmount}
              onChange={(e) => setRaiseAmount(Math.min(maxBet, Math.max(minRaise, Number(e.target.value))))}
              className="w-24 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-center"
            />
          </div>
          
          {/* Quick bet buttons */}
          <div className="flex gap-2 justify-center">
            {[0.5, 0.75, 1, 1.5].map((multiplier) => {
              const amount = Math.min(maxBet, Math.floor(state.pot * multiplier));
              return (
                <button
                  key={multiplier}
                  onClick={() => setRaiseAmount(Math.max(minRaise, amount))}
                  className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm text-white"
                >
                  {multiplier === 1 ? 'Pot' : `${multiplier * 100}%`}
                </button>
              );
            })}
          </div>

          {/* Confirm raise */}
          <button
            onClick={() => {
              onAction('raise', raiseAmount);
              setShowRaiseSlider(false);
            }}
            className="w-full py-2 bg-yellow-600 hover:bg-yellow-700 rounded-lg font-bold text-white"
          >
            Raise to {formatChips(raiseAmount)}
          </button>
        </div>
      )}
    </div>
  );
}
