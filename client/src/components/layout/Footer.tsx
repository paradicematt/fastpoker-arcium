'use client';

import { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { useSession } from '@/hooks/useSession';
import { SessionModal } from './SessionModal';

export function Footer() {
  const { connected } = useWallet();
  const { session, isLoading: sessionLoading } = useSession();
  const [solPrice, setSolPrice] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    const fetchPrices = async () => {
      try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        if (res.ok) {
          const data = await res.json();
          if (mounted && data?.solana?.usd) setSolPrice(data.solana.usd);
        }
      } catch { /* non-critical */ }
    };
    fetchPrices();
    const interval = setInterval(fetchPrices, 60_000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  const balanceSol = (session.balance / LAMPORTS_PER_SOL).toFixed(4);

  // Status pill config based on session state
  const pillConfig: Record<string, { color: string; bg: string; border: string; label: string; dot: string }> = {
    active:       { color: 'text-emerald-400', bg: 'bg-emerald-500/5', border: 'border-emerald-500/15', label: 'Ready', dot: 'bg-emerald-400' },
    low_balance:  { color: 'text-amber-400', bg: 'bg-amber-500/5', border: 'border-amber-500/15', label: 'Low Balance', dot: 'bg-amber-400 animate-pulse' },
    no_session:   { color: 'text-gray-400', bg: 'bg-gray-500/5', border: 'border-gray-500/10', label: 'No Session', dot: 'bg-gray-400' },
    loading:      { color: 'text-gray-400', bg: 'bg-gray-500/5', border: 'border-gray-500/10', label: 'Connecting', dot: 'bg-gray-400 animate-pulse' },
    disconnected: { color: 'text-gray-500', bg: 'bg-gray-500/5', border: 'border-gray-500/10', label: 'Offline', dot: 'bg-gray-600' },
  };
  const pill = pillConfig[session.status] || pillConfig.disconnected;

  const sessionLabel =
    session.status === 'active' || session.status === 'low_balance'
      ? `${balanceSol} SOL · ~${session.estimatedTxsRemaining} txs`
      : session.status === 'no_session'
      ? 'No Session'
      : '';

  return (
    <>
      <footer className="fixed bottom-0 left-0 right-0 z-50 border-t border-white/[0.06] bg-gray-950/90 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 h-10 flex items-center justify-between gap-4">
          {/* Left: Session status pill */}
          <div className="flex items-center gap-3">
            {connected ? (
              <button
                onClick={() => setModalOpen(true)}
                className={`flex items-center gap-2 px-2.5 py-1 rounded-md ${pill.bg} border ${pill.border} hover:brightness-125 transition-all cursor-pointer group`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${pill.dot}`} />
                <span className={`text-xs font-medium ${pill.color}`}>{pill.label}</span>
                {sessionLabel && (
                  <>
                    <span className="text-gray-600 text-xs">·</span>
                    <span className="text-xs text-gray-400 group-hover:text-gray-300 transition-colors">{sessionLabel}</span>
                  </>
                )}
                <svg className="w-3 h-3 text-gray-600 group-hover:text-gray-400 transition-colors ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            ) : (
              <span className="text-gray-600 text-xs font-bold">FAST POKER</span>
            )}
          </div>

          {/* Right: Prices */}
          <div className="flex items-center gap-3">
            {solPrice !== null && (
              <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-white/[0.03] border border-white/[0.06]">
                <span className="text-gray-500 text-xs">SOL</span>
                <span className="text-gray-300 text-xs font-mono font-bold tabular-nums">${solPrice.toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>
      </footer>

      <SessionModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </>
  );
}
