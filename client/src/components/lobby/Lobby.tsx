'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

import { TIERS, SnGTier, lamportsToSol, POKER_MINT, getRakeCapTier } from '@/lib/constants';
import { useTokenLogo } from '@/hooks/useTokenLogo';
import { PublicKey } from '@solana/web3.js';

// ─── Types ───
interface TokenBalances {
  sol: number;
  poker: number;
  refined: number;
  unrefined: number;
  staked: number;
  pendingSolRewards: number;
}

interface PoolState {
  totalStaked: number;
  totalUnrefined: number;
  solDistributed: number;
  circulatingSupply: number;
}

interface SitNGoQueue {
  id: string;
  type: 'heads_up' | '6max' | '9max';
  currentPlayers: number;
  maxPlayers: number;
  buyIn: number;
  tier: number;
  status: 'waiting' | 'starting' | 'in_progress';
  tablePda?: string;
  players?: string[];
  onChainPlayers?: number;
  emptySeats?: number[];
}

interface CashTable {
  pubkey: string;
  phase: number;
  currentPlayers: number;
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  gameType: number;
  pot: number;
  handNumber: number;
  isUserCreated: boolean;
  tokenMint: string;
  location: string;
  rakeCap?: number;
  isPrivate?: boolean;
  creator?: string;
}

export interface LobbyProps {
  onJoinTable: (queueId: string) => void;
  onLeaveQueue: (queueId: string) => void;
  onResumeGame: (tablePda: string) => void;
  balances: TokenBalances;
  poolState: PoolState;
  player: { isRegistered: boolean; freeEntries: number; tournamentsPlayed: number; tournamentsWon: number; claimableSol: number };
  sitNGoQueues: SitNGoQueue[];
  onClaimUnrefined: () => void;
  claiming: boolean;
  joiningQueue: string | null;
  leavingQueue: string | null;
  session: { isActive: boolean; balance: number; estimatedTxsRemaining: number; isLowBalance: boolean };
  onTopUp: () => void;
  selectedTier: SnGTier;
  onTierChange: (tier: SnGTier) => void;
  onClaimSol: () => void;
  claimingSol: boolean;
}

// ─── Helpers ───
const PHASE_LABELS = ['Waiting', 'Starting', 'Preflop', 'Flop', 'Turn', 'River', 'Showdown', 'Complete'];
const GAME_TYPE_ICONS: Record<string, string> = {
  heads_up: '⚔',
  '6max': '⬡',
  '9max': '◉',
};

function getTokenSymbol(mint: string): string {
  if (!mint) return 'SOL';
  if (mint === PublicKey.default.toBase58()) return 'SOL';
  if (mint === POKER_MINT.toBase58()) return 'POKER';
  return mint.slice(0, 4) + '...';
}

function getTokenImage(mint: string): string {
  if (!mint || mint === PublicKey.default.toBase58()) return '/tokens/sol.svg';
  if (mint === POKER_MINT.toBase58()) return '/tokens/poker.svg';
  return '/tokens/sol.svg';
}

function formatBlinds(sb: number, bb: number, mint: string): string {
  const decimals = mint === POKER_MINT.toBase58() ? 9 : 9;
  const sbVal = sb / 10 ** decimals;
  const bbVal = bb / 10 ** decimals;
  const fmt = (v: number) => v >= 1 ? v.toFixed(v % 1 === 0 ? 0 : 2) : parseFloat(v.toPrecision(3)).toString();
  return `${fmt(sbVal)} / ${fmt(bbVal)}`;
}

// ─── Main Component ───
export function Lobby({
  onJoinTable, onLeaveQueue, onResumeGame, balances, poolState, player,
  sitNGoQueues, onClaimUnrefined, claiming, joiningQueue, leavingQueue,
  session, onTopUp, selectedTier, onTierChange, onClaimSol, claimingSol,
}: LobbyProps) {
  const { publicKey } = useWallet();
  const [tab, setTab] = useState<'tournaments' | 'cash'>('tournaments');
  const [cashTables, setCashTables] = useState<CashTable[]>([]);
  const [cashLoading, setCashLoading] = useState(false);
  const [hideFullTables, setHideFullTables] = useState(true);
  const [balanceExpanded, setBalanceExpanded] = useState(false);

  // Pending cashouts state
  const [pendingCashouts, setPendingCashouts] = useState<{ tablePda: string; seatIndex: number; cashoutChips: number; smallBlind: number; bigBlind: number }[]>([]);
  const [claimingCashout, setClaimingCashout] = useState<string | null>(null); // tablePda+seatIndex key
  const [cashoutError, setCashoutError] = useState<string | null>(null);

  // Fetch pending cashouts for connected wallet
  useEffect(() => {
    if (!publicKey) { setPendingCashouts([]); return; }
    const fetchPending = () => {
      fetch(`/api/cash-game/pending-cashouts?wallet=${publicKey.toBase58()}`)
        .then(r => r.json())
        .then(data => setPendingCashouts(data.pendingCashouts || []))
        .catch(() => {});
    };
    fetchPending();
    const interval = setInterval(fetchPending, 30000);
    return () => clearInterval(interval);
  }, [publicKey]);

  const handleClaimCashout = async (tablePda: string, seatIndex: number) => {
    const key = `${tablePda}-${seatIndex}`;
    setClaimingCashout(key);
    setCashoutError(null);
    try {
      const res = await fetch('/api/cash-game/claim-cashout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tablePda, seatIndex }),
      });
      const data = await res.json();
      if (data.success) {
        setPendingCashouts(prev => prev.filter(p => !(p.tablePda === tablePda && p.seatIndex === seatIndex)));
      } else {
        setCashoutError(data.error || 'Claim failed');
      }
    } catch (e: any) {
      setCashoutError(e.message || 'Network error');
    } finally {
      setClaimingCashout(null);
    }
  };

  // Fetch cash game tables when tab switches
  useEffect(() => {
    if (tab !== 'cash') return;
    setCashLoading(true);
    fetch('/api/tables/list?gameType=3')
      .then(r => r.json())
      .then(data => setCashTables(data.tables || []))
      .catch(() => setCashTables([]))
      .finally(() => setCashLoading(false));
    const interval = setInterval(() => {
      fetch('/api/tables/list?gameType=3')
        .then(r => r.json())
        .then(data => setCashTables(data.tables || []))
        .catch(() => {});
    }, 20000);
    return () => clearInterval(interval);
  }, [tab]);

  const canPlayFree = player.freeEntries > 0;
  const myActiveGames = sitNGoQueues.filter(q => q.status === 'in_progress' && q.players?.includes(publicKey?.toBase58() || ''));
  const myActiveIds = new Set(myActiveGames.map(q => q.id));

  // SNG filtered queues (one per type for selected tier)
  const filteredQueues = (() => {
    const candidates = sitNGoQueues.filter(q => {
      if (myActiveIds.has(q.id)) return false;
      if (hideFullTables && q.status === 'in_progress') {
        // Filter full tables: use emptySeats if available, otherwise fall back to player count
        const hasRoom = q.emptySeats?.length ? true : (q.onChainPlayers ?? q.currentPlayers) < q.maxPlayers;
        if (!hasRoom) return false;
      }
      if (q.status === 'waiting' && q.currentPlayers === 0 && q.tablePda) return false;
      if (q.status === 'starting') return false;
      const qTier = q.tier ?? 0;
      const isGenericWaiting = q.status === 'waiting' && q.currentPlayers === 0;
      if (!isGenericWaiting && qTier !== selectedTier) return false;
      return true;
    });
    // Sort by player count descending so bestPerType always picks most populated first
    candidates.sort((a, b) => (b.onChainPlayers ?? b.currentPlayers) - (a.onChainPlayers ?? a.currentPlayers));
    const bestPerType = new Map<string, typeof candidates[0]>();
    for (const q of candidates) {
      const existing = bestPerType.get(q.type);
      if (!existing) { bestPerType.set(q.type, q); continue; }
      const qPlayers = q.onChainPlayers ?? q.currentPlayers;
      const ePlayers = existing.onChainPlayers ?? existing.currentPlayers;
      if (qPlayers > ePlayers) bestPerType.set(q.type, q);
      else if (qPlayers === ePlayers && q.status === 'in_progress' && q.tablePda && q.emptySeats?.length && existing.status === 'waiting') {
        bestPerType.set(q.type, q);
      }
    }
    const allTypes: Array<{ type: 'heads_up' | '6max' | '9max'; max: number }> = [
      { type: 'heads_up', max: 2 },
      { type: '6max', max: 6 },
      { type: '9max', max: 9 },
    ];
    for (const { type, max } of allTypes) {
      if (!bestPerType.has(type)) {
        bestPerType.set(type, {
          id: `virtual-${type}`, type, tier: selectedTier,
          currentPlayers: 0, maxPlayers: max, buyIn: 0, status: 'waiting',
        });
      }
    }
    return Array.from(bestPerType.values());
  })();

  const hasClaimable = player.claimableSol > 0 || balances.unrefined > 0 || balances.refined > 0;

  return (
    <div className="space-y-4">
      {/* ─── Compact Balance Bar ─── */}
      <div className="glass-card overflow-hidden">
        <button
          onClick={() => setBalanceExpanded(!balanceExpanded)}
          className="w-full px-5 py-3 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
        >
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500 text-xs">SOL</span>
              <span className="text-white font-bold text-sm tabular-nums">{balances.sol.toFixed(3)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500 text-xs">$POKER</span>
              <span className="text-cyan-400 font-bold text-sm tabular-nums">{balances.poker.toFixed(2)}</span>
            </div>
            {balances.staked > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-gray-500 text-xs">Staked</span>
                <span className="text-emerald-400 font-bold text-sm tabular-nums">{balances.staked.toFixed(2)}</span>
              </div>
            )}
            {hasClaimable && (
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
                <span className="text-amber-400 text-xs font-medium">Claimable</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {session.isActive && (
              <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] ${
                session.isLowBalance ? 'text-amber-400' : 'text-gray-500'
              }`}>
                <span className={`w-1 h-1 rounded-full ${session.isLowBalance ? 'bg-amber-400' : 'bg-emerald-400'} animate-pulse`} />
                ~{session.estimatedTxsRemaining} txs
              </div>
            )}
            <svg className={`w-4 h-4 text-gray-500 transition-transform ${balanceExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </button>

        {/* Expanded balance details */}
        {balanceExpanded && (
          <div className="px-5 pb-4 pt-1 border-t border-white/[0.06] space-y-3 animate-fadeIn">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3">
                <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">$POKER</div>
                <div className="text-cyan-400 text-xl font-bold tabular-nums">{balances.poker.toFixed(2)}</div>
              </div>
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3">
                <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">Staked</div>
                <div className="text-emerald-400 text-xl font-bold tabular-nums">{balances.staked.toFixed(2)}</div>
                {balances.pendingSolRewards > 0 && (
                  <div className="text-amber-400/80 text-[10px] mt-0.5">+{balances.pendingSolRewards.toFixed(6)} SOL earned</div>
                )}
                <Link href="/staking" className="text-gray-500 hover:text-cyan-400 text-[10px] mt-1 inline-block transition-colors">
                  Manage &rarr;
                </Link>
              </div>
              <div className="md:col-span-2 rounded-xl bg-white/[0.03] border border-white/[0.06] p-3">
                <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-1.5">Tournament Winnings</div>
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <div className="flex items-baseline gap-1">
                    <span className="text-amber-400 text-base font-bold tabular-nums">{(player.claimableSol / 1e9).toFixed(4)}</span>
                    <span className="text-gray-500 text-[10px]">SOL</span>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-blue-400 text-base font-bold tabular-nums">{balances.unrefined.toFixed(2)}</span>
                    <span className="text-gray-500 text-[10px]">Unrefined</span>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-purple-400 text-base font-bold tabular-nums">{balances.refined.toFixed(2)}</span>
                    <span className="text-gray-500 text-[10px]">Refined</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <button onClick={onClaimSol} disabled={claimingSol || player.claimableSol <= 0}
                    className="px-3 py-1 text-[10px] font-bold rounded bg-amber-500/10 border border-amber-500/25 text-amber-400 hover:bg-amber-500/20 disabled:opacity-30 transition-colors">
                    {claimingSol ? '...' : 'CLAIM SOL'}
                  </button>
                  <button onClick={onClaimUnrefined} disabled={claiming || (balances.unrefined <= 0 && balances.refined <= 0)}
                    className="px-3 py-1 text-[10px] font-bold rounded bg-cyan-500/10 border border-cyan-500/25 text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-30 transition-colors">
                    {claiming ? '...' : 'CLAIM ALL'}
                  </button>
                </div>
                <p className="text-gray-600 text-[9px] mt-1">10% tax on Unrefined claim — redistributed as Refined to holders</p>
              </div>
            </div>
            {player.freeEntries > 0 && (
              <div className="px-3 py-2 rounded-lg bg-emerald-500/[0.06] border border-emerald-500/15">
                <span className="text-emerald-400 text-xs font-medium">
                  {player.freeEntries} free Sit & Go entries remaining (Micro tier only)
                </span>
              </div>
            )}
            {session.isLowBalance && (
              <button onClick={onTopUp}
                className="w-full px-3 py-2 rounded-lg bg-amber-500/[0.06] border border-amber-500/15 text-amber-400 text-xs font-medium hover:bg-amber-500/10 transition-colors">
                Session low — Top Up for more gasless transactions
              </button>
            )}
          </div>
        )}
      </div>

      {/* ─── Pending Cashouts Banner ─── */}
      {pendingCashouts.length > 0 && (
        <div className="glass-card p-4 border-amber-500/20 bg-amber-500/[0.04]">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-lg">&#x1F4B0;</span>
              <div>
                <span className="text-amber-400 text-sm font-bold">
                  {(pendingCashouts.reduce((s, p) => s + p.cashoutChips, 0) / 1e9).toFixed(4)} SOL
                </span>
                <span className="text-gray-400 text-xs ml-1.5">
                  pending cashout from {pendingCashouts.length} seat{pendingCashouts.length > 1 ? 's' : ''}
                </span>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              {pendingCashouts.map(p => {
                const key = `${p.tablePda}-${p.seatIndex}`;
                const isClaiming = claimingCashout === key;
                return (
                  <button
                    key={key}
                    onClick={() => handleClaimCashout(p.tablePda, p.seatIndex)}
                    disabled={!!claimingCashout}
                    className="px-4 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-400 text-xs font-bold hover:bg-amber-500/20 disabled:opacity-40 transition-colors"
                  >
                    {isClaiming ? 'Claiming...' : `Claim ${(p.cashoutChips / 1e9).toFixed(4)} SOL`}
                  </button>
                );
              })}
            </div>
          </div>
          {cashoutError && (
            <p className="text-red-400 text-xs mt-2">{cashoutError}</p>
          )}
        </div>
      )}

      {/* ─── Active Games Banner ─── */}
      {myActiveGames.length > 0 && (
        <div className="glass-card p-4 border-emerald-500/15">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
              <span className="text-emerald-400 text-sm font-bold">Active Game{myActiveGames.length > 1 ? 's' : ''}</span>
            </div>
            <div className="flex gap-2">
              {myActiveGames.map(q => (
                <button key={q.id} onClick={() => q.tablePda && onResumeGame(q.tablePda)}
                  className="px-4 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs font-bold hover:bg-emerald-500/20 transition-colors">
                  Resume {q.type === 'heads_up' ? 'HU' : q.type === '6max' ? '6-Max' : '9-Max'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ─── Main Tabs ─── */}
      <div className="glass-card overflow-hidden">
        {/* Tab Header */}
        <div className="flex border-b border-white/[0.06]">
          {(['tournaments', 'cash'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-6 py-3.5 text-sm font-bold transition-all relative ${
                tab === t
                  ? 'text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}>
              {t === 'tournaments' ? 'Sit & Go' : 'Cash Games'}
              {tab === t && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-cyan-500 to-emerald-500" />
              )}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="p-5">
          {tab === 'tournaments' ? (
            <SngTab
              queues={filteredQueues}
              selectedTier={selectedTier}
              onTierChange={onTierChange}
              canPlayFree={canPlayFree}
              onJoin={onJoinTable}
              onLeave={onLeaveQueue}
              onResume={onResumeGame}
              joiningQueue={joiningQueue}
              leavingQueue={leavingQueue}
              publicKey={publicKey?.toBase58() || ''}
              hideFullTables={hideFullTables}
              onToggleHideFull={() => setHideFullTables(!hideFullTables)}
            />
          ) : (
            <CashTab
              tables={cashTables}
              loading={cashLoading}
              publicKey={publicKey?.toBase58() || ''}
              hideFullTables={hideFullTables}
              onToggleHideFull={() => setHideFullTables(!hideFullTables)}
            />
          )}
        </div>
      </div>

      {/* ─── Compact Pool Stats ─── */}
      <div className="flex items-center justify-center gap-4 sm:gap-6 py-2 text-[11px] text-gray-600 flex-wrap">
        <PoolStat label="Burned" value={`${poolState.totalStaked.toFixed(0)} POKER`} color="text-red-400" tooltip="Total $POKER permanently burned via staking. Burned tokens earn a share of all rake." />
        <span className="text-gray-700">·</span>
        <PoolStat label="Unrefined" value={poolState.totalUnrefined.toFixed(0)} color="text-blue-400/70" tooltip="Unrefined $POKER from tournament winnings. Claim to convert to tokens (10% tax applies)." />
        <span className="text-gray-700">·</span>
        <PoolStat label="SOL Distributed" value={poolState.solDistributed.toFixed(4)} color="text-amber-400/80" tooltip="Total SOL distributed to stakers from cash game rake." />
        <span className="text-gray-700">·</span>
        <PoolStat label="Supply" value={poolState.circulatingSupply.toLocaleString()} color="text-cyan-400/70" tooltip="Total circulating $POKER supply (minted tokens in wallets)." />
      </div>
    </div>
  );
}

// ─── Pool Stat with Tooltip ───
function PoolStat({ label, value, color, tooltip }: { label: string; value: string; color: string; tooltip: string }) {
  const [showTip, setShowTip] = useState(false);
  return (
    <span
      className="relative cursor-help select-none"
      onMouseEnter={() => setShowTip(true)}
      onMouseLeave={() => setShowTip(false)}
      onClick={() => setShowTip(v => !v)}
    >
      {label}: <span className={`${color} font-medium`}>{value}</span>
      {showTip && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-lg bg-gray-800 border border-white/10 text-gray-200 text-[10px] leading-tight w-48 text-center z-50 shadow-xl whitespace-normal">
          {tooltip}
        </span>
      )}
    </span>
  );
}

// ─── SNG Tab ───
function SngTab({
  queues, selectedTier, onTierChange, canPlayFree, onJoin, onLeave, onResume,
  joiningQueue, leavingQueue, publicKey, hideFullTables, onToggleHideFull,
}: {
  queues: SitNGoQueue[];
  selectedTier: SnGTier;
  onTierChange: (t: SnGTier) => void;
  canPlayFree: boolean;
  onJoin: (id: string) => void;
  onLeave: (id: string) => void;
  onResume: (tablePda: string) => void;
  joiningQueue: string | null;
  leavingQueue: string | null;
  publicKey: string;
  hideFullTables: boolean;
  onToggleHideFull: () => void;
}) {
  const tierInfo = TIERS[selectedTier];
  const isFreeEligible = canPlayFree && selectedTier === SnGTier.Micro;

  return (
    <div className="space-y-4">
      {/* Tier pills */}
      <div className="flex items-center gap-2 flex-wrap">
        {TIERS.map((tier) => {
          const isSelected = selectedTier === tier.id;
          const isFree = canPlayFree && tier.id === SnGTier.Micro;
          return (
            <button key={tier.id} onClick={() => onTierChange(tier.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                isSelected
                  ? `${tier.accent} ${tier.color} border font-bold`
                  : 'bg-white/[0.03] border border-white/[0.06] text-gray-500 hover:text-gray-300'
              }`}>
              {tier.name}
              <span className="ml-1.5 text-[10px] opacity-70">
                {isFree ? 'FREE' : lamportsToSol(tier.totalBuyIn)}
              </span>
            </button>
          );
        })}
        <button onClick={onToggleHideFull}
          className={`ml-auto flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors ${
            hideFullTables ? 'text-cyan-400' : 'text-gray-600'
          }`}>
          <span className={`w-2.5 h-2.5 rounded-sm border transition-colors ${
            hideFullTables ? 'bg-cyan-500/30 border-cyan-500/50' : 'border-gray-600'
          }`}>
            {hideFullTables && <span className="block text-[7px] text-center leading-[10px]">✓</span>}
          </span>
          Hide full
        </button>
      </div>

      {/* Buy-in info */}
      <div className={`flex items-center justify-between px-4 py-2.5 rounded-xl border ${tierInfo.accent}`}>
        <div className="flex items-center gap-3">
          <span className={`text-sm font-bold ${tierInfo.color}`}>{tierInfo.name}</span>
          <span className="text-gray-500 text-xs">{tierInfo.desc}</span>
        </div>
        <span className={`text-sm font-bold ${isFreeEligible ? 'text-emerald-400' : tierInfo.color}`}>
          {isFreeEligible ? 'FREE ENTRY' : `${lamportsToSol(tierInfo.totalBuyIn)} SOL`}
        </span>
      </div>

      {/* Game type cards */}
      <div className="grid md:grid-cols-3 gap-3">
        {queues.map((queue) => {
          const isFull = queue.status === 'in_progress';
          const isMyGame = queue.players?.includes(publicKey);
          const hasEmptySeat = (queue.emptySeats?.length ?? 0) > 0;
          const actualPlayers = queue.onChainPlayers ?? queue.currentPlayers;
          const payoutBps = queue.maxPlayers <= 2 ? [10000] : queue.maxPlayers <= 6 ? [6500, 3500] : [5000, 3000, 2000];
          const solPool = (tierInfo.entryAmount || 0) * queue.maxPlayers;
          const pokerPool = 100 * queue.maxPlayers;
          const posLabels = ['1st', '2nd', '3rd'];
          const typeName = queue.type === 'heads_up' ? 'Heads Up' : queue.type === '6max' ? '6-Max' : '9-Max';
          const icon = GAME_TYPE_ICONS[queue.type] || '♠';

          return (
            <div key={queue.id}
              className={`rounded-xl border transition-all ${
                isFull && !isMyGame && !hasEmptySeat
                  ? 'bg-white/[0.015] border-white/[0.04] opacity-50'
                  : 'bg-white/[0.03] border-white/[0.06] hover:border-cyan-500/20 hover:bg-white/[0.04]'
              }`}>
              {/* Header */}
              <div className="p-4 pb-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{icon}</span>
                    <h3 className="text-white font-bold text-sm">{typeName}</h3>
                  </div>
                  <div className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                    queue.status === 'waiting' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/15' :
                    hasEmptySeat ? 'bg-amber-500/10 text-amber-400 border border-amber-500/15' :
                    'bg-cyan-500/10 text-cyan-400 border border-cyan-500/15'
                  }`}>
                    {queue.status === 'waiting' ? `${queue.currentPlayers}/${queue.maxPlayers}` :
                     hasEmptySeat ? `${actualPlayers}/${queue.maxPlayers} OPEN` : 'LIVE'}
                  </div>
                </div>
                <p className="text-gray-600 text-[11px]">{queue.maxPlayers} players · Turbo blinds</p>
              </div>

              {/* Prizes */}
              <div className="mx-4 mb-3 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-1.5">Prizes</div>
                {solPool > 0 && (
                  <div className="flex gap-2 mb-1.5 pb-1.5 border-b border-white/[0.04]">
                    {payoutBps.map((bps, i) => {
                      const solPrize = (solPool * bps / 10000) / 1e9;
                      return (
                        <div key={i} className="flex-1 text-center">
                          <div className="text-[10px] font-bold text-gray-300">{posLabels[i]}</div>
                          <div className="text-[11px] text-amber-400 font-bold">{solPrize.toFixed(4)} SOL</div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="flex gap-2">
                  {payoutBps.map((bps, i) => {
                    const pokerPrize = (pokerPool * bps / 10000);
                    return (
                      <div key={i} className="flex-1 text-center">
                        {!solPool && <div className="text-[10px] font-bold text-gray-300">{posLabels[i]}</div>}
                        <div className="text-[10px] text-cyan-400 font-medium">{pokerPrize.toFixed(0)} POKER</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Action */}
              <div className="px-4 pb-4">
                {isMyGame && queue.tablePda ? (
                  <div className="flex gap-2">
                    {queue.status === 'waiting' && (
                      <button onClick={() => onLeave(queue.id)} disabled={leavingQueue === queue.id}
                        className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400 text-xs font-bold hover:bg-red-500/20 transition-colors disabled:opacity-30 flex-1">
                        {leavingQueue === queue.id ? '...' : 'Leave'}
                      </button>
                    )}
                    <button onClick={() => onResume(queue.tablePda!)}
                      className="px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs font-bold hover:bg-emerald-500/20 transition-colors flex-1">
                      Resume
                    </button>
                  </div>
                ) : hasEmptySeat && !isMyGame ? (
                  <button onClick={() => onJoin(queue.id)} disabled={joiningQueue === queue.id}
                    className="w-full py-2.5 rounded-lg bg-gradient-to-r from-emerald-500/10 to-cyan-500/10 border border-emerald-500/25 text-emerald-400 text-sm font-bold hover:from-emerald-500/20 hover:to-cyan-500/20 transition-all disabled:opacity-30">
                    {joiningQueue === queue.id ? 'Joining...' : 'Join Open Seat'}
                  </button>
                ) : isFull && !isMyGame && !hasEmptySeat ? (
                  <button onClick={() => queue.tablePda && onResume(queue.tablePda)} disabled={!queue.tablePda}
                    className="w-full py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-gray-400 text-xs font-bold hover:bg-white/[0.06] transition-colors disabled:opacity-30">
                    Spectate
                  </button>
                ) : (
                  <button onClick={() => onJoin(queue.id)} disabled={joiningQueue === queue.id}
                    className="w-full py-2.5 rounded-lg bg-gradient-to-r from-cyan-500/10 to-emerald-500/10 border border-cyan-500/25 text-cyan-400 text-sm font-bold hover:from-cyan-500/20 hover:to-emerald-500/20 transition-all disabled:opacity-30">
                    {joiningQueue === queue.id ? 'Joining...' : isFreeEligible ? 'Play Free' : 'Join'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-gray-600 text-[10px] text-center">
        Tables auto-start when full · New queue opens automatically
      </p>
    </div>
  );
}

// ─── Cash Games Tab ───
function CashTab({
  tables, loading, publicKey, hideFullTables, onToggleHideFull,
}: {
  tables: CashTable[];
  loading: boolean;
  publicKey: string;
  hideFullTables: boolean;
  onToggleHideFull: () => void;
}) {
  const [tokenFilter, setTokenFilter] = useState<'all' | 'sol' | 'poker' | 'other'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const PAGE_SIZE = 12;

  // Only show playable tables: not Complete + not private (unless creator)
  const playable = tables.filter(t => {
    if (t.phase === 7) return false;
    if (t.isPrivate && t.creator !== publicKey) return false;
    if (hideFullTables && t.currentPlayers >= t.maxPlayers) return false;
    return true;
  });

  // Filter by token
  const tokenFiltered = playable.filter(t => {
    if (tokenFilter === 'sol') return t.tokenMint === PublicKey.default.toBase58();
    if (tokenFilter === 'poker') return t.tokenMint === POKER_MINT.toBase58();
    if (tokenFilter === 'other') return t.tokenMint !== PublicKey.default.toBase58() && t.tokenMint !== POKER_MINT.toBase58();
    return true;
  });

  // Filter by search (table ID / pubkey)
  const filtered = searchQuery.trim()
    ? tokenFiltered.filter(t => t.pubkey.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : tokenFiltered;

  // Sort: active tables first (by player count desc), then waiting
  const sorted = [...filtered].sort((a, b) => {
    if (a.currentPlayers !== b.currentPlayers) return b.currentPlayers - a.currentPlayers;
    return b.handNumber - a.handNumber;
  });

  const activeTables = sorted.filter(t => t.currentPlayers > 0);
  const emptyTables = sorted.filter(t => t.currentPlayers === 0);

  // Deduplicate empty tables: 1 per blind level
  const seenBlinds = new Set<string>();
  const dedupedEmpty = emptyTables.filter(t => {
    const key = `${t.smallBlind}-${t.bigBlind}-${t.tokenMint}`;
    if (seenBlinds.has(key)) return false;
    seenBlinds.add(key);
    return true;
  });

  // Paginate: show limited tables unless user clicks "Show more"
  const allDisplay = [...activeTables, ...dedupedEmpty];
  const displayTables = showAll ? allDisplay : allDisplay.slice(0, PAGE_SIZE);
  const hasMore = allDisplay.length > PAGE_SIZE && !showAll;
  const displayActive = displayTables.filter(t => t.currentPlayers > 0);
  const displayEmpty = displayTables.filter(t => t.currentPlayers === 0);

  // Token counts (based on playable tables only)
  const solCount = playable.filter(t => t.tokenMint === PublicKey.default.toBase58()).length;
  const pokerCount = playable.filter(t => t.tokenMint === POKER_MINT.toBase58()).length;
  const otherCount = playable.filter(t => t.tokenMint !== PublicKey.default.toBase58() && t.tokenMint !== POKER_MINT.toBase58()).length;

  return (
    <div className="space-y-4">
      {/* Header with Create + Manage buttons */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-gray-500 text-xs hidden sm:block">Play with custom stakes · Create or join an existing table</p>
        <div className="flex items-center gap-2 ml-auto">
          <Link href="/dealer"
            className="px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-lg bg-cyan-500/[0.06] border border-cyan-500/15 text-cyan-400/70 text-[11px] sm:text-xs font-medium hover:bg-cyan-500/10 hover:text-cyan-300 transition-colors">
            🃏 Dealer
          </Link>
          <Link href="/my-tables"
            className="px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-gray-400 text-[11px] sm:text-xs font-medium hover:bg-white/[0.06] hover:text-gray-200 transition-colors">
            Manage
          </Link>
          <Link href="/my-tables/create"
            className="px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg bg-gradient-to-r from-cyan-500/10 to-emerald-500/10 border border-cyan-500/25 text-cyan-400 text-[11px] sm:text-xs font-bold hover:from-cyan-500/20 hover:to-emerald-500/20 transition-all">
            + Create
          </Link>
        </div>
      </div>

      {/* Filters row */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Token filter pills */}
        {([['all', `All (${playable.length})`], ['sol', `SOL (${solCount})`], ['poker', `POKER (${pokerCount})`], ...(otherCount > 0 ? [['other', `Other (${otherCount})`]] : [])] as [string, string][]).map(([key, label]) => (
          <button key={key} onClick={() => setTokenFilter(key as typeof tokenFilter)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              tokenFilter === key
                ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/25'
                : 'bg-white/[0.03] border border-white/[0.06] text-gray-500 hover:text-gray-300'
            }`}>
            {label}
          </button>
        ))}
        {/* Hide full toggle */}
        <button onClick={onToggleHideFull}
          className={`flex items-center gap-1 px-2 py-1.5 rounded text-[10px] transition-colors ${
            hideFullTables ? 'text-cyan-400' : 'text-gray-600'
          }`}>
          <span className={`w-2.5 h-2.5 rounded-sm border transition-colors ${
            hideFullTables ? 'bg-cyan-500/30 border-cyan-500/50' : 'border-gray-600'
          }`}>
            {hideFullTables && <span className="block text-[7px] text-center leading-[10px]">&#10003;</span>}
          </span>
          Hide full
        </button>
        {/* Search */}
        <div className="ml-auto relative">
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search ID..."
            className="w-28 sm:w-40 px-2.5 sm:px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs text-gray-300 placeholder-gray-600 focus:border-cyan-500/30 focus:outline-none transition-colors"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400 text-xs">&times;</button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="w-6 h-6 border-2 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-gray-500 text-xs">Loading tables...</p>
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-white/[0.08] rounded-xl">
          <div className="text-3xl mb-3 opacity-30">&#9824;</div>
          <p className="text-gray-500 text-sm mb-1">{searchQuery ? 'No tables match your search' : 'No cash tables yet'}</p>
          <p className="text-gray-600 text-xs mb-4">{searchQuery ? 'Try a different table ID' : 'Be the first to create one!'}</p>
          {!searchQuery && (
            <Link href="/my-tables/create"
              className="inline-block px-5 py-2 rounded-lg bg-cyan-500/10 border border-cyan-500/25 text-cyan-400 text-xs font-bold hover:bg-cyan-500/20 transition-colors">
              Create Table
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {/* Active tables — 2-col on larger screens */}
          {displayActive.length > 0 && (
            <>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium px-1">
                Active ({activeTables.length}){displayActive.length < activeTables.length && <span className="text-gray-600"> · showing {displayActive.length}</span>}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                {displayActive.map(table => (
                  <CashTableRow key={table.pubkey} table={table} />
                ))}
              </div>
            </>
          )}

          {/* Empty/Waiting tables */}
          {displayEmpty.length > 0 && (
            <>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium px-1 mt-3">
                Open ({dedupedEmpty.length}){displayEmpty.length < dedupedEmpty.length && <span className="text-gray-600"> · showing {displayEmpty.length}</span>}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                {displayEmpty.map(table => (
                  <CashTableRow key={table.pubkey} table={table} />
                ))}
              </div>
            </>
          )}
          {/* Show more button */}
          {hasMore && (
            <button onClick={() => setShowAll(true)}
              className="w-full py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-gray-400 text-xs font-medium hover:bg-white/[0.05] hover:text-gray-300 transition-colors">
              Show all {allDisplay.length} tables
            </button>
          )}
        </div>
      )}

      {/* Manage link */}
      {sorted.length > 0 && (
        <div className="text-center">
          <Link href="/my-tables" className="text-gray-500 hover:text-cyan-400 text-xs transition-colors">
            Manage my tables &rarr;
          </Link>
        </div>
      )}
    </div>
  );
}

// ─── Cash Table Row ───
function CashTableRow({ table }: { table: CashTable }) {
  const router = useRouter();
  const symbol = getTokenSymbol(table.tokenMint);
  const tokenImg = useTokenLogo(table.tokenMint);
  const blinds = formatBlinds(table.smallBlind, table.bigBlind, table.tokenMint);
  const hasSpace = table.currentPlayers < table.maxPlayers;
  const phaseLabel = PHASE_LABELS[table.phase] || '?';
  const isActive = table.phase >= 2 && table.phase <= 6;
  const gameUrl = `/game/${table.pubkey}`;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // Try client-side nav first, fall back to hard navigation on failure
    try {
      router.push(gameUrl);
      // If RSC payload fetch fails, client-side nav silently stalls — detect & fallback
      setTimeout(() => {
        if (window.location.pathname !== gameUrl) {
          window.location.href = gameUrl;
        }
      }, 2000);
    } catch {
      window.location.href = gameUrl;
    }
  }, [router, gameUrl]);

  return (
    <a href={gameUrl} onClick={handleClick} className={`block flex items-center justify-between px-4 py-3 rounded-xl border transition-colors cursor-pointer ${
      isActive
        ? 'bg-white/[0.03] border-white/[0.06] hover:border-cyan-500/20 hover:bg-white/[0.05]'
        : 'bg-white/[0.02] border-white/[0.04] hover:border-white/[0.08] hover:bg-white/[0.04]'
    }`}>
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        {/* Token icon */}
        <div className="shrink-0 w-7 h-7 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center overflow-hidden bg-white/[0.04] border border-white/[0.08]">
          <img src={tokenImg} alt={symbol} width={28} height={28} className="w-5 h-5 sm:w-7 sm:h-7" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
            <span className="text-white text-xs sm:text-sm font-medium">{blinds} {symbol}</span>
            <span className="text-gray-600 text-[10px]">
              {table.maxPlayers === 2 ? 'HU' : table.maxPlayers === 6 ? '6-Max' : '9-Max'}
            </span>
            {table.isUserCreated && (
              <span className="hidden sm:inline px-1.5 py-0.5 rounded text-[9px] font-medium bg-purple-500/10 text-purple-400/70 border border-purple-500/15">
                User
              </span>
            )}
            {table.isPrivate && (
              <span className="hidden sm:inline px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-500/10 text-amber-400/70 border border-amber-500/15">
                Private
              </span>
            )}
            {(() => {
              const bb = table.bigBlind;
              const capBB = (table.rakeCap && table.rakeCap > 0 && bb > 0) ? (table.rakeCap / bb).toFixed(1) : null;
              const tier = getRakeCapTier(bb);
              return (
                <>
                  <span className={`hidden sm:inline px-1.5 py-0.5 rounded text-[9px] font-medium ${tier.bg} ${tier.color} ${tier.border}`}>
                    {tier.name}
                  </span>
                  <span className="hidden sm:inline px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500/8 text-emerald-400/60 border border-emerald-500/10">
                    5%{capBB ? ` · ${capBB}BB` : ''}
                  </span>
                </>
              );
            })()}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={`text-[10px] ${isActive ? 'text-emerald-400' : 'text-gray-600'}`}>
              {isActive ? `${phaseLabel} · #${table.handNumber}` : phaseLabel}
            </span>
            {table.pot > 0 && (
              <span className="text-[10px] text-amber-400/80">Pot: {formatBlinds(table.pot, table.pot, table.tokenMint).split('/')[0]}</span>
            )}
            <span className="hidden sm:inline text-[9px] text-gray-700 font-mono">{table.pubkey.slice(0, 6)}...{table.pubkey.slice(-4)}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-1 sm:ml-2">
        {/* Player count */}
        <div className="text-right mr-1">
          <div className="flex items-center gap-1">
            {Array.from({ length: table.maxPlayers }, (_, i) => (
              <span key={i} className={`w-1.5 h-1.5 rounded-full ${
                i < table.currentPlayers ? 'bg-emerald-400' : 'bg-white/[0.1]'
              }`} />
            ))}
          </div>
          <div className="text-[10px] text-gray-500 mt-0.5">{table.currentPlayers}/{table.maxPlayers}</div>
        </div>

        {/* Visual label */}
        <span className={`px-3 sm:px-4 py-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-colors ${
          hasSpace
            ? 'bg-emerald-500/10 border border-emerald-500/25 text-emerald-400'
            : 'bg-white/[0.04] border border-white/[0.08] text-gray-400'
        }`}>
          {hasSpace ? 'Join' : 'View'}
        </span>
      </div>
    </a>
  );
}
