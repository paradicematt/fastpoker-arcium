/**
 * useSoundEffects — React hook that monitors game state and plays poker sounds.
 * 
 * Detects phase transitions, player actions, turn changes, and timer events
 * to trigger the appropriate sound from poker-sounds.ts.
 */
import { useEffect, useRef, useCallback } from 'react';
import { playSound, initAudio, setSoundEnabled, getSoundEnabled, setMasterVolume } from '@/lib/poker-sounds';

interface PlayerInfo {
  pubkey: string;
  chips: number;
  bet: number;
  folded: boolean;
  isActive: boolean;
  seatIndex: number;
}

interface SoundEffectsState {
  phase: string;
  pot: number;
  currentPlayer: number;
  communityCards: number[];
  players: PlayerInfo[];
  isMyTurn: boolean;
  myCards?: [number, number];
  timeLeft?: number;
  handNumber?: number;
}

export function useSoundEffects(state: SoundEffectsState | null) {
  const prevStateRef = useRef<SoundEffectsState | null>(null);
  const initializedRef = useRef(false);
  const lastDealSoundRef = useRef(0);
  const lastTurnSoundRef = useRef(0);

  // Initialize audio context on mount
  useEffect(() => {
    if (!initializedRef.current) {
      initAudio();
      initializedRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!state) return;
    const prev = prevStateRef.current;
    prevStateRef.current = state;

    // Skip on first render (no previous state to compare)
    if (!prev) return;

    const prevPhase = prev.phase;
    const currPhase = state.phase;

    // ─── Phase transitions ───

    // New hand started (Waiting → PreFlop)
    if (prevPhase === 'Waiting' && currPhase === 'PreFlop') {
      playSound('newHand');
      // Deal cards after shuffle sound
      setTimeout(() => {
        playSound('cardDeal');
        setTimeout(() => playSound('cardDeal'), 150);
      }, 400);
    }

    // Flop dealt (PreFlop → Flop: 3 community cards)
    if (prevPhase === 'PreFlop' && currPhase === 'Flop') {
      playSound('cardFlip');
      setTimeout(() => playSound('cardFlip'), 120);
      setTimeout(() => playSound('cardFlip'), 240);
    }

    // Turn dealt (Flop → Turn: 1 card)
    if (prevPhase === 'Flop' && currPhase === 'Turn') {
      playSound('cardFlip');
    }

    // River dealt (Turn → River: 1 card)
    if (prevPhase === 'Turn' && currPhase === 'River') {
      playSound('cardFlip');
    }

    // Showdown
    if (prevPhase !== 'Showdown' && prevPhase !== 'Complete' &&
        (currPhase === 'Showdown' || currPhase === 'Complete')) {
      // Play card flip for revealing hole cards
      playSound('cardFlip');
      setTimeout(() => playSound('cardFlip'), 200);
    }

    // ─── Player action sounds ───
    // Detect based on state changes between renders

    if (currPhase !== 'Waiting' && currPhase !== 'Showdown' && currPhase !== 'Complete' &&
        prevPhase === currPhase) {

      // Current player changed → someone acted
      if (prev.currentPlayer !== state.currentPlayer && prev.currentPlayer >= 0) {
        const actingPlayer = prev.players.find(p => p.seatIndex === prev.currentPlayer);
        const actingPlayerNow = state.players.find(p => p.seatIndex === prev.currentPlayer);

        if (actingPlayer && actingPlayerNow) {
          // Player folded
          if (!actingPlayer.folded && actingPlayerNow.folded) {
            playSound('fold');
          }
          // Player bet/raised/called (bet increased)
          else if (actingPlayerNow.bet > actingPlayer.bet) {
            const increase = actingPlayerNow.bet - actingPlayer.bet;
            // All-in detection: chips went to 0
            if (actingPlayerNow.chips === 0 && actingPlayer.chips > 0) {
              playSound('allIn');
            } else {
              playSound('chipBet');
            }
          }
          // Check (player changed but no bet/fold change)
          else if (!actingPlayerNow.folded && actingPlayerNow.bet === actingPlayer.bet) {
            playSound('check');
          }
        }
      }
    }

    // ─── Pot collected (win) ───
    if ((currPhase === 'Showdown' || currPhase === 'Complete') &&
        (prevPhase === 'Showdown' || prevPhase === 'Complete')) {
      // Detect chip redistribution: pot decreased significantly
      if (prev.pot > 0 && state.pot === 0) {
        playSound('chipCollect');
      }
    }

    // ─── My turn notification ───
    if (state.isMyTurn && !prev.isMyTurn) {
      const now = Date.now();
      if (now - lastTurnSoundRef.current > 2000) { // Debounce
        playSound('yourTurn');
        lastTurnSoundRef.current = now;
      }
    }

  }, [state]);

  // ─── Timer warning sounds ───
  useEffect(() => {
    if (!state?.isMyTurn || state.timeLeft === undefined) return;
    if (state.timeLeft <= 5 && state.timeLeft > 0) {
      playSound('timerWarning');
    } else if (state.timeLeft <= 10 && state.timeLeft > 5) {
      playSound('timerTick');
    }
  }, [state?.timeLeft, state?.isMyTurn]);

  return {
    playSound,
    setSoundEnabled,
    getSoundEnabled,
    setMasterVolume,
  };
}
