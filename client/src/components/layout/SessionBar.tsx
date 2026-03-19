'use client';

import { SessionState } from '@/hooks/useSession';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

interface SessionBarProps {
  session: SessionState;
  isLoading: boolean;
  onCreateSession: () => void;
  onExtendSession: () => void;
  onTopUp: () => void;
  onReclaim: () => void;
  connected: boolean;
  timeRemainingSecs: number | null;
}

function formatCountdown(secs: number): string {
  if (secs <= 0) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}:${s.toString().padStart(2, '0')}`;
  return `${s}s`;
}

export function SessionBar({
  session,
  isLoading,
  onCreateSession,
  onExtendSession,
  onTopUp,
  onReclaim,
  connected,
  timeRemainingSecs,
}: SessionBarProps) {
  if (!connected) return null;

  const balanceSol = (session.balance / LAMPORTS_PER_SOL).toFixed(4);
  const isUrgent = timeRemainingSecs !== null && timeRemainingSecs < 3600 && timeRemainingSecs > 0;

  const statusConfig: Record<SessionState['status'], { color: string; bg: string; border: string; label: string; dot: string }> = {
    disconnected: { color: 'text-gray-500', bg: 'bg-gray-500/5', border: 'border-gray-500/10', label: 'Disconnected', dot: 'bg-gray-500' },
    loading:      { color: 'text-gray-400', bg: 'bg-gray-500/5', border: 'border-gray-500/10', label: 'Loading...', dot: 'bg-gray-400 animate-pulse' },
    active:       { color: 'text-emerald-400', bg: 'bg-emerald-500/5', border: 'border-emerald-500/15', label: 'Active', dot: 'bg-emerald-400' },
    no_session:   { color: 'text-red-400', bg: 'bg-red-500/5', border: 'border-red-500/15', label: 'No Session', dot: 'bg-red-400' },
    low_balance:  { color: 'text-amber-400', bg: 'bg-amber-500/5', border: 'border-amber-500/15', label: 'Low Balance', dot: 'bg-amber-400 animate-pulse' },
  };

  const cfg = statusConfig[session.status];

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-50 border-t border-white/[0.06] bg-gray-950/90 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-2 sm:px-4 h-8 sm:h-10 flex items-center justify-between gap-2 sm:gap-4 overflow-x-auto">
        {/* Left: Session status */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md ${cfg.bg} border ${cfg.border}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
            <span className={`text-[10px] sm:text-xs font-medium ${cfg.color}`}><span className="hidden sm:inline">Session: </span>{cfg.label}</span>
          </div>

          {session.status === 'active' || session.status === 'low_balance' ? (
            <>
              <div className="flex items-center gap-1.5 text-[10px] sm:text-xs text-gray-400">
                <span className={session.isLowBalance ? 'text-amber-400' : 'text-gray-300'}>{balanceSol} SOL</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] sm:text-xs text-gray-400">
                <span className="text-gray-600">~{session.estimatedTxsRemaining} txs</span>
              </div>
              {timeRemainingSecs !== null && (
                <div className={`flex items-center gap-1 text-[10px] sm:text-xs font-mono ${isUrgent ? 'text-amber-400' : 'text-gray-500'}`}>
                  <span className={isUrgent ? 'animate-pulse' : ''}>{formatCountdown(timeRemainingSecs)}</span>
                </div>
              )}
            </>
          ) : session.status === 'no_session' ? (
            <span className="text-xs text-gray-500 hidden sm:inline">
              {session.balance > 5000 
                ? `Session expired — ${balanceSol} SOL will be recovered`
                : 'Join a game to auto-create'}
            </span>
          ) : null}
        </div>

        {/* Right: Action buttons */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {(session.status === 'low_balance') && (
            <button
              onClick={onTopUp}
              disabled={isLoading}
              className="px-2 sm:px-3 py-1 rounded-md text-[11px] sm:text-xs font-medium bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 hover:bg-cyan-500/20 transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              Top Up
            </button>
          )}

          {session.status === 'no_session' && (
            <button
              onClick={onCreateSession}
              disabled={isLoading}
              className="px-2 sm:px-3 py-1 rounded-md text-[11px] sm:text-xs font-medium bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 hover:bg-cyan-500/20 transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {isLoading ? '...' : session.balance > 5000 ? 'Resume Session' : 'Create Session'}
            </button>
          )}
          {session.status === 'no_session' && session.balance > 5000 && (
            <button
              onClick={onReclaim}
              disabled={isLoading}
              className="px-1.5 py-0.5 rounded text-[10px] text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {isLoading ? '...' : 'Reclaim SOL'}
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}
