import { useState, useEffect, useCallback } from 'react';
import { OnChainPhase, OnChainGameType } from '@/lib/onchain-game';

export interface LobbyTable {
  pubkey: string;
  phase: OnChainPhase;
  phaseLabel: string;
  currentPlayers: number;
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  gameType: OnChainGameType;
  gameTypeLabel: string;
  pot: number;
  handNumber: number;
  authority: string;
}

interface UseTableListReturn {
  tables: LobbyTable[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const PHASE_LABELS: Record<number, string> = {
  0: 'Waiting',
  1: 'Starting',
  2: 'PreFlop',
  3: 'Flop',
  4: 'Turn',
  5: 'River',
  6: 'Showdown',
  7: 'Complete',
};

const GAME_TYPE_LABELS: Record<number, string> = {
  0: 'Heads Up',
  1: '6-Max',
  2: '9-Max',
  3: 'Cash Game',
};

/**
 * Hook that lists all active poker tables.
 *
 * Fetches from /api/tables/list (server-side proxy that authenticates
 * with TEE for ER reads + merges L1 tables).
 */
export function useTableList(autoRefreshMs: number = 0): UseTableListReturn {
  const [tables, setTables] = useState<LobbyTable[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/tables/list');
      const data = await res.json();
      if (data.error) {
        console.warn('Table list API error:', data.error);
      }

      const rawTables: any[] = data.tables || [];
      const mapped: LobbyTable[] = rawTables.map((t: any) => ({
        pubkey: t.pubkey,
        phase: t.phase as OnChainPhase,
        phaseLabel: PHASE_LABELS[t.phase] ?? 'Unknown',
        currentPlayers: t.currentPlayers,
        maxPlayers: t.maxPlayers,
        smallBlind: t.smallBlind,
        bigBlind: t.bigBlind,
        gameType: t.gameType as OnChainGameType,
        gameTypeLabel: GAME_TYPE_LABELS[t.gameType] ?? 'Unknown',
        pot: t.pot,
        handNumber: t.handNumber,
        authority: t.authority,
      }));

      // Sort: active games first, then by player count desc
      mapped.sort((a, b) => {
        const aActive = a.phase > 0 && a.phase < 7 ? 1 : 0;
        const bActive = b.phase > 0 && b.phase < 7 ? 1 : 0;
        if (bActive !== aActive) return bActive - aActive;
        if (b.currentPlayers !== a.currentPlayers) return b.currentPlayers - a.currentPlayers;
        return a.phase - b.phase;
      });

      setTables(mapped);
    } catch (err: any) {
      console.error('Failed to fetch table list:', err);
      setError(err.message || 'Failed to load tables');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Optional auto-refresh
  useEffect(() => {
    if (autoRefreshMs <= 0) return;
    const interval = setInterval(refresh, autoRefreshMs);
    return () => clearInterval(interval);
  }, [autoRefreshMs, refresh]);

  return { tables, isLoading, error, refresh };
}
