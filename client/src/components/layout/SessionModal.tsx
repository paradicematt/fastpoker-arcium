'use client';

import { useState, useEffect } from 'react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { useSession, RECOMMENDED_TOPUP_LAMPORTS } from '@/hooks/useSession';
import { useWallet } from '@solana/wallet-adapter-react';

interface SessionModalProps {
  open: boolean;
  onClose: () => void;
}

export function SessionModal({ open, onClose }: SessionModalProps) {
  const { connected } = useWallet();
  const { session, isLoading: sessionLoading, createSession, topUpSession, reclaimSession } = useSession();

  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [topUpAmount, setTopUpAmount] = useState(RECOMMENDED_TOPUP_LAMPORTS / LAMPORTS_PER_SOL);
  const [showTopUp, setShowTopUp] = useState(false);

  if (!open) return null;

  const balanceSol = (session.balance / LAMPORTS_PER_SOL).toFixed(4);

  const doAction = async (label: string, fn: () => Promise<any>) => {
    setActionLoading(label);
    setActionError(null);
    try {
      await fn();
    } catch (e: any) {
      const msg = e.message?.toLowerCase() || '';
      if (msg.includes('user rejected') || msg.includes('cancelled')) {
        // User cancelled — not an error
      } else {
        setActionError(e.message?.slice(0, 100) || 'Unknown error');
      }
    } finally {
      setActionLoading(null);
    }
  };

  const sessionStatusConfig: Record<string, { color: string; dot: string; label: string }> = {
    disconnected: { color: 'text-gray-500', dot: 'bg-gray-600', label: 'Disconnected' },
    loading:      { color: 'text-gray-400', dot: 'bg-gray-400 animate-pulse', label: 'Loading...' },
    active:       { color: 'text-emerald-400', dot: 'bg-emerald-400', label: 'Active' },
    no_session:   { color: 'text-red-400', dot: 'bg-red-400', label: 'No Session' },
    low_balance:  { color: 'text-amber-400', dot: 'bg-amber-400 animate-pulse', label: 'Low Balance' },
  };
  const sessionCfg = sessionStatusConfig[session.status] || sessionStatusConfig.disconnected;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-md mx-4 bg-gray-900 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-bold text-white">Session Management</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors text-lg leading-none">&times;</button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* Session Key Section */}
          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Session Key</h3>
            <div className="bg-gray-800/50 rounded-lg border border-white/[0.06] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${sessionCfg.dot}`} />
                  <span className={`text-xs font-medium ${sessionCfg.color}`}>{sessionCfg.label}</span>
                </div>
              </div>

              {(session.status === 'active' || session.status === 'low_balance') && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                  <div className="text-gray-500">Balance</div>
                  <div className={`text-right font-mono ${session.isLowBalance ? 'text-amber-400' : 'text-gray-300'}`}>{balanceSol} SOL</div>
                  <div className="text-gray-500">Txs Remaining</div>
                  <div className="text-gray-300 text-right font-mono">~{session.estimatedTxsRemaining}</div>
                  {session.sessionKey && (
                    <>
                      <div className="text-gray-500">Key</div>
                      <div className="text-gray-400 text-right font-mono text-[10px] truncate">{session.sessionKey.publicKey.toBase58().slice(0, 8)}...</div>
                    </>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                {session.status === 'no_session' && (
                  <button
                    onClick={() => doAction('create', createSession)}
                    disabled={sessionLoading || !!actionLoading}
                    className="flex-1 min-w-[100px] px-3 py-1.5 rounded-md text-xs font-medium bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 hover:bg-cyan-500/20 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === 'create' ? 'Creating...' : 'Create Session'}
                  </button>
                )}
                {(session.status === 'active' || session.status === 'low_balance') && (
                  <button
                    onClick={() => setShowTopUp(!showTopUp)}
                    className="flex-1 min-w-[80px] px-3 py-1.5 rounded-md text-xs font-medium bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 hover:bg-cyan-500/20 transition-colors"
                  >
                    Top Up
                  </button>
                )}
                {(session.status === 'active' || session.status === 'low_balance') && (
                  <button
                    onClick={() => doAction('reclaim', reclaimSession)}
                    disabled={sessionLoading || !!actionLoading}
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-500/10 border border-red-500/25 text-red-300 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === 'reclaim' ? 'Closing...' : 'Close & Refund'}
                  </button>
                )}
              </div>

              {showTopUp && (
                <div className="pt-2 border-t border-white/[0.04] space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0.001}
                      max={1}
                      step={0.001}
                      value={topUpAmount}
                      onChange={e => setTopUpAmount(Number(e.target.value))}
                      className="flex-1 bg-gray-800 border border-white/10 rounded-md px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-cyan-500/50"
                    />
                    <span className="text-xs text-gray-500">SOL</span>
                    <button
                      onClick={() => doAction('topup', () => topUpSession(topUpAmount * LAMPORTS_PER_SOL))}
                      disabled={sessionLoading || !!actionLoading || topUpAmount <= 0}
                      className="px-3 py-1 rounded-md text-xs font-medium bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 hover:bg-cyan-500/20 transition-colors disabled:opacity-50"
                    >
                      {actionLoading === 'topup' ? 'Sending...' : 'Send'}
                    </button>
                  </div>
                  <div className="flex gap-1.5">
                    {[0.005, 0.01, 0.05].map(amt => (
                      <button
                        key={amt}
                        onClick={() => setTopUpAmount(amt)}
                        className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                          topUpAmount === amt
                            ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300'
                            : 'bg-gray-800/50 border-white/[0.06] text-gray-400 hover:text-gray-300'
                        }`}
                      >
                        {amt} SOL
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Info */}
          <div className="text-[11px] text-gray-500 px-1">
            Session keys allow gasless gameplay on Solana L1. Your session key balance pays for transaction fees (~0.000005 SOL each).
          </div>

          {actionError && (
            <div className="px-3 py-2 rounded-md bg-red-500/10 border border-red-500/20 text-red-300 text-xs">
              {actionError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
