'use client';

import { useEffect, useState, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

const ACTIVE_GAMES_KEY = 'fastpoker_active_games';

export interface ActiveGameInfo {
  tablePda: string;
  type: 'cash' | 'sng';
  blinds?: string;
  label?: string;
  maxPlayers?: number;
  timestamp: number;
}

// ── Helpers ──

function loadGames(): ActiveGameInfo[] {
  try {
    const raw = localStorage.getItem(ACTIVE_GAMES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveGames(games: ActiveGameInfo[]) {
  localStorage.setItem(ACTIVE_GAMES_KEY, JSON.stringify(games));
}

/** Add or update an active game entry */
export function addActiveGame(info: Omit<ActiveGameInfo, 'timestamp'>) {
  const games = loadGames().filter(g => g.tablePda !== info.tablePda);
  games.push({ ...info, timestamp: Date.now() });
  saveGames(games);
}

/** Remove an active game entry */
export function removeActiveGame(tablePda: string) {
  saveGames(loadGames().filter(g => g.tablePda !== tablePda));
}

/** Get all active games */
export function getActiveGames(): ActiveGameInfo[] {
  return loadGames();
}

// ── Backward-compatible single-table API (used by cash game page) ──

export interface ActiveTableInfo {
  tablePda: string;
  blinds?: string;
  maxPlayers?: number;
}

export function setActiveTable(info: ActiveTableInfo | null) {
  if (info) {
    addActiveGame({ tablePda: info.tablePda, type: 'cash', blinds: info.blinds, maxPlayers: info.maxPlayers, label: info.blinds ? `Cash ${info.blinds}` : 'Cash Game' });
  } else {
    // Remove the most recent cash game (called on leave)
    const games = loadGames();
    const cashIdx = games.findIndex(g => g.type === 'cash');
    if (cashIdx >= 0) {
      games.splice(cashIdx, 1);
      saveGames(games);
    }
  }
}

export function getActiveTable(): ActiveTableInfo | null {
  const games = loadGames();
  const cash = games.find(g => g.type === 'cash');
  return cash ? { tablePda: cash.tablePda, blinds: cash.blinds, maxPlayers: cash.maxPlayers } : null;
}

// ── Component ──

export function ActiveTableBar() {
  const pathname = usePathname();
  const [games, setGames] = useState<ActiveGameInfo[]>([]);
  const [collapsed, setCollapsed] = useState(true);

  const refresh = useCallback(() => setGames(loadGames()), []);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    const onStorage = (e: StorageEvent) => { if (e.key === ACTIVE_GAMES_KEY) refresh(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener('focus', onFocus); window.removeEventListener('storage', onStorage); };
  }, [pathname, refresh]);

  // Filter out the game we're currently viewing
  const currentTablePda = pathname?.startsWith('/game/') ? pathname.split('/game/')[1] : null;
  const visible = games.filter(g => g.tablePda !== currentTablePda);

  if (visible.length === 0) return null;

  return (
    <div className="bg-gradient-to-r from-cyan-500/[0.07] to-emerald-500/[0.07] border-b border-cyan-500/20">
      <div className="max-w-6xl mx-auto px-4">
        {/* Header row — always visible */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full py-1.5 flex items-center justify-between text-xs"
        >
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-gray-400">
              {visible.length} active game{visible.length !== 1 ? 's' : ''}
            </span>
          </div>
          <svg
            className={`w-3 h-3 text-gray-500 transition-transform ${collapsed ? '' : 'rotate-180'}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Game entries — collapsible */}
        {!collapsed && (
          <div className="pb-2 space-y-1">
            {visible.map(g => (
              <div key={g.tablePda} className="flex items-center justify-between py-1 px-2 rounded-lg bg-white/[0.03]">
                <div className="flex items-center gap-2 text-xs min-w-0">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                    g.type === 'sng' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/20' : 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/20'
                  }`}>
                    {g.type === 'sng' ? 'SNG' : 'Cash'}
                  </span>
                  <span className="text-gray-300 truncate">
                    {g.label || g.tablePda.slice(0, 8) + '...'}
                  </span>
                  {g.blinds && <span className="text-gray-500">{g.blinds}</span>}
                </div>
                <Link
                  href={g.type === 'cash' ? `/game/${g.tablePda}` : `/?table=${g.tablePda}`}
                  className="shrink-0 ml-2 px-2.5 py-1 rounded-md bg-cyan-500/15 border border-cyan-500/25 text-cyan-300 text-[11px] font-bold hover:bg-cyan-500/25 transition-colors"
                >
                  Go to →
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
