'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { CrankDashboard } from '@/components/admin/CrankDashboard';

// ─── Types ───
interface ParsedSeat {
  index: number;
  pubkey: string;
  wallet: string;
  chips: number;
  bet: number;
  status: number;
  statusName: string;
  cashoutChips?: number;
  cashoutNonce?: number;
  vaultReserve?: number;
  sitOutTimestamp?: number;
}

interface ParsedTable {
  pubkey: string;
  tableId: string;
  authority: string;
  phase: number;
  phaseName: string;
  gameType: number;
  gameTypeName: string;
  maxPlayers: number;
  currentPlayers: number;
  handNumber: number;
  pot: number;
  smallBlind: number;
  bigBlind: number;
  currentPlayer: number;
  dealerSeat: number;
  isDelegated: boolean;
  seatsOccupied: number;
  prizesDistributed: boolean;
  eliminatedCount: number;
  eliminatedSeats: number[];
  communityCards: number[];
  lamports: number;
  location: 'ER' | 'L1';
  validatorName?: string;
  seats: ParsedSeat[];
  tier: number;
  tierName: string;
  entryAmount: number;
  feeAmount: number;
  prizePool: number;
  rakeAccumulated: number;
  isUserCreated: boolean;
  creator: string;
  creatorRakeTotal: number;
  tokenMint: string;
  vaultLamports: number;
  vaultTotalDeposited: number;
  vaultTotalWithdrawn: number;
  vaultTotalRakeDistributed: number;
  vaultRakeNonce: number;
  isStuck: boolean;
  stuckReason: string | null;
  isClosing: boolean;
  closingStage: 'undelegate' | 'prize_distribution' | 'close_accounts' | null;
  itmPreview: {
    place: number;
    seatIndex: number | null;
    wallet: string;
    payoutBps: number;
    pokerAmount: number;
    solLamports: number;
  }[];
  closingAgeSec?: number;
  createdAt?: string;
}

interface AdminData {
  timestamp: number;
  crank?: {
    updatedAt: number;
    totals: {
      erCranks: number;
      l1Cranks: number;
      totalCranks: number;
      erCostLamports: number;
      l1CostLamports: number;
      totalCostLamports: number;
      totalSuccess?: number;
      totalFailed?: number;
      simSaved?: number;
    };
    byLabel?: Record<string, { chain: string; count: number; costLamports: number; successCount?: number; failCount?: number }>;
  };
  teeHealth?: {
    reachable: boolean;
    ok: number;
    fail: number;
    failedPubkeys: string[];
    authMethod: string;
  };
  crankStatus?: {
    pid: number;
    startedAt: number;
    heartbeat: number;
    status: 'online' | 'offline';
    tablesTracked: number;
    tablesProcessing: number;
    recentErrors: string[];
    uptime: string;
    heartbeatAge: number;
    config?: {
      process_cashouts: boolean;
      auto_kick: boolean;
      rake_sweep: boolean;
      auction_sweep: boolean;
      timeout_enabled: boolean;
      crank_sng: boolean;
      crank_cash: boolean;
      removal_sweep_interval: number;
      rake_sweep_interval: number;
      timeout_ms: number;
      tee_rpc: string;
      l1_rpc: string;
      crank_keypair_path: string;
      l1_payer_keypair_path: string;
      pool_authority_keypair_path: string;
    };
  };
  treasury: {
    address: string;
    balanceSol: number;
    balanceLamports: number;
    pokerBalance: number;
    tokens?: { mint: string; balance: number; decimals: number; uiBalance: number }[];
  };
  pool: {
    totalStaked: number;
    totalUnrefined: number;
    solDistributed: number;
    solClaimed?: number;
    solAvailable: number;
    pokerAvailable: number;
    pokerDistributed: number;
  } | null;
  tables: {
    er: ParsedTable[];
    l1: ParsedTable[];
    totalCount: number;
    erCount: number;
    l1Count: number;
    stuckCount: number;
    totalRentHeldSol: number;
  };
  summary: {
    activeTables: number;
    waitingTables: number;
    completedTables: number;
    totalPot: number;
    totalPlayers: number;
    cashGameTables: number;
    sitAndGoTables: number;
    totalRakeAccumulated: number;
    poolPokerBalance: number;
  };
}

// ─── Card helpers ───
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

function cardToString(c: number): string {
  if (c === 255) return '??';
  if (c < 0 || c > 51) return '??';
  return RANKS[c % 13] + SUITS[Math.floor(c / 13)];
}

function suitColor(c: number): string {
  if (c === 255 || c < 0 || c > 51) return 'text-gray-500';
  const suit = Math.floor(c / 13);
  return suit === 1 || suit === 2 ? 'text-red-400' : 'text-gray-300';
}

// ─── Phase colors ───
function phaseColor(phase: number): string {
  switch (phase) {
    case 0: return 'text-gray-400 bg-gray-400/10';
    case 1: return 'text-yellow-400 bg-yellow-400/10';
    case 2: return 'text-cyan-400 bg-cyan-400/10';
    case 3: return 'text-blue-400 bg-blue-400/10';
    case 4: return 'text-purple-400 bg-purple-400/10';
    case 5: return 'text-pink-400 bg-pink-400/10';
    case 6: return 'text-amber-400 bg-amber-400/10';
    case 7: return 'text-emerald-400 bg-emerald-400/10';
    default: return 'text-gray-500 bg-gray-500/10';
  }
}

function seatStatusColor(status: number): string {
  switch (status) {
    case 0: return 'text-gray-600';
    case 1: return 'text-emerald-400';
    case 2: return 'text-red-400';
    case 3: return 'text-amber-400';
    case 4: return 'text-gray-400';
    case 5: return 'text-red-600'; // Busted
    case 6: return 'text-orange-400'; // Leaving
    default: return 'text-gray-500';
  }
}

function short(key: string): string {
  return key.slice(0, 6) + '...' + key.slice(-4);
}

const POKER_MINT_STR = 'DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX';
const SOL_MINT_STR = '11111111111111111111111111111111';
const CLOSING_STUCK_SECS = 120;

function tokenSymbol(mint: string): string {
  if (!mint || mint === SOL_MINT_STR) return 'SOL';
  if (mint === POKER_MINT_STR) return 'POKER';
  return mint.slice(0, 4) + '...';
}

function fmtAmt(raw: number, decimals: number = 9): string {
  const val = raw / 10 ** decimals;
  if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
  if (val >= 1) return val.toFixed(val % 1 === 0 ? 0 : 2);
  if (val === 0) return '0';
  return parseFloat(val.toPrecision(3)).toString();
}

function fmtChips(raw: number): string {
  if (raw >= 1_000_000) return `${(raw / 1_000_000).toFixed(1)}M`;
  if (raw >= 1_000) return `${(raw / 1_000).toFixed(1)}K`;
  return Math.floor(raw).toString();
}

function fmtLamportsAsSol(lamports: number): string {
  return (lamports / 1e9).toFixed(6);
}

// ─── Components ───

function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" style={{ animationDelay: '0ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" style={{ animationDelay: '200ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" style={{ animationDelay: '400ms' }} />
    </span>
  );
}

function StatCard({ label, value, sub, color = 'cyan' }: { label: string; value: React.ReactNode; sub?: string; color?: string }) {
  const colors: Record<string, string> = {
    cyan: 'border-cyan-500/20 from-cyan-500/5 to-transparent',
    emerald: 'border-emerald-500/20 from-emerald-500/5 to-transparent',
    amber: 'border-amber-500/20 from-amber-500/5 to-transparent',
    red: 'border-red-500/20 from-red-500/5 to-transparent',
    purple: 'border-purple-500/20 from-purple-500/5 to-transparent',
    blue: 'border-blue-500/20 from-blue-500/5 to-transparent',
  };
  const textColors: Record<string, string> = {
    cyan: 'text-cyan-400',
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    red: 'text-red-400',
    purple: 'text-purple-400',
    blue: 'text-blue-400',
  };
  return (
    <div className={`rounded-xl border bg-gradient-to-br ${colors[color]} p-4`}>
      <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-2xl font-bold ${textColors[color]}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

function TableCard({ table, expanded, onToggle, seats, loadingSeats, onMarkBroken }: { table: ParsedTable; expanded: boolean; onToggle: () => void; seats?: ParsedSeat[]; loadingSeats?: boolean; onMarkBroken?: (pubkey: string, action: 'mark' | 'unmark') => void }) {
  const phaseClasses = phaseColor(table.phase);
  const isSng = table.gameType < 3;
  const liveHref = table.gameType === 3 ? `/game/${table.pubkey}` : `/?table=${table.pubkey}`;
  const closingStageLabel = table.closingStage === 'undelegate'
    ? 'Undelegating'
    : table.closingStage === 'prize_distribution'
      ? 'Distributing Prizes'
      : table.closingStage === 'close_accounts'
        ? 'Closing Accounts'
        : 'Closing';
  const closingStuck = !!table.isClosing && (table.closingAgeSec ?? 0) >= CLOSING_STUCK_SECS;
  const showStuck = table.isStuck || closingStuck;
  const stuckMessage = closingStuck
    ? `Closing stuck: ${table.closingAgeSec}s in ${closingStageLabel}`
    : table.stuckReason;

  return (
    <div className={`rounded-xl border transition-all ${
      showStuck 
        ? 'border-red-500/40 bg-red-500/[0.03]' 
        : 'border-white/[0.06] bg-white/[0.02]'
    }`}>
      {/* Header */}
      <button onClick={onToggle} className="w-full p-4 text-left hover:bg-white/[0.02] transition-colors rounded-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Location badge */}
            <span className="text-xs font-bold px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
              L1
            </span>

            {/* Phase badge */}
            <span className={`text-xs font-bold px-2 py-0.5 rounded ${phaseClasses}`}>
              {table.phaseName}
            </span>

            {/* Stuck indicator */}
            {showStuck && (
              <span className="text-xs font-bold px-2 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30 animate-pulse">
                STUCK
              </span>
            )}

            {/* Closing indicator */}
            {table.isClosing && (
              <span className="text-xs font-bold px-2 py-0.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/30">
                Closing{table.closingAgeSec ? ` ${table.closingAgeSec}s` : ''}
              </span>
            )}

            {/* Table ID */}
            <span className="text-sm font-mono text-gray-300">
              {short(table.pubkey)}
            </span>

            <span className="text-xs text-gray-500">
              {table.gameType === 3
                ? `Cash · $${table.tokenMint === '11111111111111111111111111111111' ? 'SOL' : table.tokenMint === 'DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX' ? 'POKER' : table.tokenMint?.slice(0,4)}`
                : table.gameTypeName}
            </span>

            {/* Tier badge for SNG tables */}
            {table.gameType < 3 && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                table.tier === 0 ? 'bg-gray-500/15 text-gray-400 border border-gray-500/20' :
                table.tier === 1 ? 'bg-amber-600/15 text-amber-500 border border-amber-600/20' :
                table.tier === 2 ? 'bg-slate-300/15 text-slate-300 border border-slate-300/20' :
                table.tier === 3 ? 'bg-yellow-400/15 text-yellow-400 border border-yellow-400/20' :
                table.tier === 4 ? 'bg-cyan-300/15 text-cyan-300 border border-cyan-300/20' :
                'bg-rose-400/15 text-rose-400 border border-rose-400/20'
              }`}>
                {table.tierName ?? 'Micro'}
                {table.prizePool > 0 && ` · ${(table.prizePool / 1e9).toFixed(4)} SOL`}
              </span>
            )}
          </div>

          <div className="flex items-center gap-4 text-sm">
            {/* Hand number */}
            <div className="text-gray-500">
              H<span className="text-gray-300 font-mono">#{table.handNumber}</span>
            </div>

            {/* Players */}
            <div className="text-gray-500">
              <span className="text-gray-300 font-mono">{table.currentPlayers}</span>/{table.maxPlayers}
            </div>

            {/* Blinds */}
            <div className="text-cyan-300 font-mono font-bold text-xs">
              Blinds: {isSng
                ? `${fmtChips(table.smallBlind)}/${fmtChips(table.bigBlind)}`
                : `${fmtAmt(table.smallBlind)}/${fmtAmt(table.bigBlind)} ${tokenSymbol(table.tokenMint)}`}
            </div>

            {/* Community cards */}
            <div className="flex gap-0.5">
              {table.communityCards.map((c, i) => (
                <span key={i} className={`text-xs font-mono ${suitColor(c)}`}>
                  {cardToString(c)}
                </span>
              ))}
            </div>

            {/* Rent */}
            <div className="text-xs text-gray-600 font-mono">
              {(table.lamports / 1e9).toFixed(4)} SOL
            </div>

            {/* Port-out to live table */}
            <Link
              href={liveHref}
              onClick={(e) => e.stopPropagation()}
              className="text-cyan-300 hover:text-cyan-200 text-xs border border-cyan-500/30 rounded px-1.5 py-0.5"
              title="Open live table"
            >
              ↗
            </Link>

            {/* Expand arrow */}
            <span className={`text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`}>
              &#9662;
            </span>
          </div>
        </div>

        {showStuck && stuckMessage && (
          <div className="text-xs text-red-400/80 mt-2 pl-1">
            &#9888; {stuckMessage}
          </div>
        )}
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-white/[0.04] pt-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-xs">
            <div>
              <span className="text-gray-500">Pubkey</span>
              <div className="font-mono text-gray-300 break-all">{table.pubkey}</div>
            </div>
            <div>
              <span className="text-gray-500">Authority</span>
              <div className="font-mono text-gray-300">{short(table.authority)}</div>
            </div>
            <div>
              <span className="text-gray-500">Blinds</span>
              <div className="text-gray-300">
                {isSng
                  ? `${fmtChips(table.smallBlind)}/${fmtChips(table.bigBlind)} chips`
                  : `${fmtAmt(table.smallBlind)}/${fmtAmt(table.bigBlind)} ${tokenSymbol(table.tokenMint)}`}
              </div>
            </div>
            <div>
              <span className="text-gray-500">Delegated</span>
              <div className={table.location === 'ER' ? 'text-emerald-400' : 'text-gray-500'}>{table.location === 'ER' ? `YES (${table.validatorName || 'unknown'})` : 'No'}</div>
            </div>
            <div>
              <span className="text-gray-500">Dealer</span>
              <div className="text-gray-300">Seat {table.dealerSeat}</div>
            </div>
            <div>
              <span className="text-gray-500">Current Turn</span>
              <div className="text-gray-300">{table.currentPlayer === 255 ? '—' : `Seat ${table.currentPlayer}`}</div>
            </div>
            {table.createdAt && (
              <div>
                <span className="text-gray-500">Created</span>
                <div className="text-gray-300 text-[10px]">{new Date(table.createdAt).toLocaleString()}</div>
              </div>
            )}
            <div>
              <span className="text-gray-500">Prizes Dist.</span>
              <div className={table.prizesDistributed ? 'text-emerald-400' : 'text-gray-500'}>{table.prizesDistributed ? 'Yes' : 'No'}</div>
            </div>
            <div>
              <span className="text-gray-500">Eliminated</span>
              <div className="text-gray-300">{table.eliminatedCount}</div>
            </div>
            {table.isClosing && (
              <div>
                <span className="text-gray-500">Closing Stage</span>
                <div className={closingStuck ? 'text-red-400 font-semibold' : 'text-orange-300'}>
                  {closingStageLabel}{table.closingAgeSec ? ` (${table.closingAgeSec}s)` : ''}
                </div>
              </div>
            )}
            {table.gameType < 3 && (
              <>
                <div>
                  <span className="text-gray-500">Tier</span>
                  <div className="text-gray-300">{table.tierName ?? 'Micro'}</div>
                </div>
                <div>
                  <span className="text-gray-500">Entry / Fee</span>
                  <div className="text-gray-300">{(table.entryAmount / 1e9).toFixed(4)} / {(table.feeAmount / 1e9).toFixed(4)} SOL</div>
                </div>
                <div>
                  <span className="text-gray-500">Prize Pool</span>
                  <div className={table.prizePool > 0 ? 'text-amber-400 font-bold' : 'text-gray-500'}>{(table.prizePool / 1e9).toFixed(4)} SOL</div>
                </div>
              </>
            )}
            {table.gameType === 3 && (() => {
              const effectiveSeats = seats ?? table.seats;
              const totalVirtual = effectiveSeats.reduce((s, seat) => s + seat.chips + seat.bet, 0);
              const vaultRentLamports = 1002240; // ~rent for TableVault account
              const isSolTable = table.tokenMint === '11111111111111111111111111111111';
              const hasVault = (table.vaultLamports ?? 0) > 0;
              // SOL tables: vault lamports minus rent. SPL tables: vault deposited - withdrawn (token units).
              const totalDeposited = table.vaultTotalDeposited ?? 0;
              const escrowBalance = isSolTable
                ? (hasVault ? Math.max(0, table.vaultLamports - vaultRentLamports) : Math.max(0, table.lamports - 3821040))
                : Math.max(0, totalDeposited - (table.vaultTotalWithdrawn ?? 0));
              // Correct surplus: vault balance vs virtual chips.
              // Vault already had rake + cashouts withdrawn, so deficit only if vault < virtual chips.
              const surplus = escrowBalance - totalVirtual;
              // Vault tracking
              const rakeDistributed = table.vaultTotalRakeDistributed ?? 0;
              const totalWithdrawn = table.vaultTotalWithdrawn ?? 0;
              const rakeNonce = table.vaultRakeNonce ?? 0;
              // Creator payout: 50% of distributed rake for user-created tables
              const creatorPayout = table.isUserCreated ? Math.floor(rakeDistributed * 50 / 100) : 0;
              const platformPayout = rakeDistributed - creatorPayout;
              const stakerPayout = Math.floor(platformPayout / 2);
              const treasuryPayout = platformPayout - stakerPayout;
              // Cashouts = total withdrawn minus rake distributed
              const cashouts = Math.max(0, totalWithdrawn - rakeDistributed);
              return (
              <>
                {/* Escrow Health */}
                <div className="col-span-2 rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5 grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <span className="text-gray-500">{hasVault ? 'Vault (PDA)' : 'Escrow (PDA)'}</span>
                    <div className="text-emerald-400 font-bold">{fmtAmt(escrowBalance)} {tokenSymbol(table.tokenMint)}</div>
                    {!isSolTable && hasVault && <div className="text-gray-600 text-[10px]">dep: {fmtAmt(totalDeposited)} / wd: {fmtAmt(totalWithdrawn)}</div>}
                  </div>
                  <div>
                    <span className="text-gray-500">Virtual Total</span>
                    <div className="text-cyan-400 font-bold">{fmtAmt(totalVirtual)} {tokenSymbol(table.tokenMint)}</div>
                  </div>
                  <div>
                    <span className="text-gray-500">Balance</span>
                    <div className={surplus < 0 ? 'text-red-400 font-bold' : 'text-emerald-400 font-bold'}>
                      {surplus < 0 ? `−${fmtAmt(Math.abs(surplus))} DEFICIT` : `+${fmtAmt(surplus)} OK`}
                    </div>
                  </div>
                </div>
                {/* Vault Payouts Tracking */}
                {rakeDistributed > 0 && (
                  <div className="col-span-2 rounded-lg bg-white/[0.02] border border-emerald-500/20 p-2.5 text-xs">
                    <div className="text-emerald-400 font-semibold mb-1.5">Vault Payouts (L1 confirmed)</div>
                    <div className="grid grid-cols-4 gap-2">
                      <div>
                        <span className="text-gray-500">Rake Claimed</span>
                        <div className="text-amber-400 font-bold">{fmtAmt(rakeDistributed)}</div>
                      </div>
                      {table.isUserCreated && (
                        <div>
                          <span className="text-gray-500">Creator (50%)</span>
                          <div className="text-purple-400 font-bold">{fmtAmt(creatorPayout)}</div>
                        </div>
                      )}
                      <div>
                        <span className="text-gray-500">Stakers ({table.isUserCreated ? '25' : '50'}%)</span>
                        <div className="text-cyan-400 font-bold">{fmtAmt(stakerPayout)}</div>
                      </div>
                      <div>
                        <span className="text-gray-500">Treasury ({table.isUserCreated ? '25' : '50'}%)</span>
                        <div className="text-emerald-400 font-bold">{fmtAmt(treasuryPayout)}</div>
                      </div>
                    </div>
                    {cashouts > 0 && (
                      <div className="mt-1.5 text-gray-400">Player cashouts: {fmtAmt(cashouts)}</div>
                    )}
                    <div className="mt-1 text-gray-600">Nonce: {rakeNonce}</div>
                  </div>
                )}
                <div>
                  <span className="text-gray-500">Rake Pending</span>
                  {(() => {
                    const pending = Math.max(0, table.rakeAccumulated - rakeDistributed);
                    const isStale = table.rakeAccumulated > 0 && pending === 0;
                    return isStale
                      ? <div className="text-gray-600">0 <span className="text-[10px]">(ER stale: {fmtAmt(table.rakeAccumulated)})</span></div>
                      : <div className={pending > 0 ? 'text-amber-400 font-bold' : 'text-gray-500'}>{fmtAmt(pending)} {tokenSymbol(table.tokenMint)}</div>;
                  })()}
                </div>
                <div>
                  <span className="text-gray-500">User Created</span>
                  <div className={table.isUserCreated ? 'text-amber-400' : 'text-gray-500'}>{table.isUserCreated ? 'Yes' : 'System'}</div>
                </div>
                {table.isUserCreated && (
                  <div>
                    <span className="text-gray-500">Creator</span>
                    <div className="font-mono text-gray-300">{short(table.creator)}</div>
                  </div>
                )}
              </>
              );
            })()}
          </div>

          {/* Sit & Go prize positions */}
          {isSng && (() => {
            const PAYOUT_BPS: Record<number, number[]> = { 2: [10000], 6: [6500, 3500], 9: [5000, 3000, 2000] };
            const payouts = table.itmPreview.length > 0
              ? table.itmPreview
              : (PAYOUT_BPS[table.maxPlayers] ?? []).map((bps, idx) => ({
                  place: idx + 1, seatIndex: null, wallet: '',
                  payoutBps: bps,
                  pokerAmount: Math.floor((100_000_000 * table.maxPlayers * bps) / 10000),
                  solLamports: Math.floor((table.prizePool * bps) / 10000),
                }));
            if (payouts.length === 0) return null;
            return (
            <div className="mb-4">
              <div className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Prize Positions</div>
              <div className="space-y-1.5">
                {payouts.map((p) => {
                  const solVal = p.solLamports / 1e9;
                  const pokerVal = p.pokerAmount / 1e6;
                  const placeLabel = p.place === 1 ? '1st' : p.place === 2 ? '2nd' : p.place === 3 ? '3rd' : `${p.place}th`;
                  return (
                    <div key={p.place} className="flex items-center justify-between rounded-lg bg-white/[0.02] border border-white/[0.05] px-3 py-1.5 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-amber-300 font-bold w-8">{placeLabel}</span>
                        {p.seatIndex !== null && (
                          <>
                            <span className="text-gray-500">Seat</span>
                            <span className="text-gray-300 font-mono">{p.seatIndex}</span>
                            <span className="text-gray-500">·</span>
                          </>
                        )}
                        <span className="text-gray-400 font-mono">{p.wallet ? short(p.wallet) : ''}</span>
                      </div>
                      <div className="flex items-center gap-3 font-mono">
                        <span className="text-cyan-300">{(p.payoutBps / 100).toFixed(1)}%</span>
                        <span className="text-purple-300">{pokerVal.toFixed(0)} POKER</span>
                        {solVal > 0 && <span className="text-emerald-300">{solVal.toFixed(4)} SOL</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            );
          })()}

          {/* Seats */}
          {loadingSeats && (
            <div className="flex items-center gap-2 text-xs text-gray-500 py-3">
              <div className="w-3 h-3 border border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin" />
              Loading seats...
            </div>
          )}
          {/* Mark/Unmark Broken */}
          {onMarkBroken && (
            <div className="mb-4 flex items-center gap-3">
              {table.stuckReason?.startsWith('Broken:') ? (
                <button
                  onClick={() => onMarkBroken(table.pubkey, 'unmark')}
                  className="text-xs px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                >
                  Unmark Broken
                </button>
              ) : (
                <button
                  onClick={() => onMarkBroken(table.pubkey, 'mark')}
                  className="text-xs px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors"
                >
                  Mark as Broken
                </button>
              )}
              {table.stuckReason?.startsWith('Broken:') && (
                <span className="text-xs text-red-400/60">{table.stuckReason}</span>
              )}
            </div>
          )}

          {seats && seats.length > 0 && (() => {
            // Build finish position map for SNG seats
            const posMap = new Map<number, { pos: number; label: string; itm: typeof table.itmPreview[0] | null }>();
            if (isSng && table.eliminatedCount > 0) {
              const eliminated = table.eliminatedSeats.slice(0, table.eliminatedCount);
              // Winner = seat not in eliminated list (with a non-default wallet)
              const winnerSeat = Array.from({ length: table.maxPlayers }, (_, i) => i)
                .find(i => !eliminated.includes(i) && seats.some(s => s.index === i));
              if (winnerSeat !== undefined) {
                const finishSeats = [winnerSeat, ...eliminated.slice().reverse()];
                const posLabels = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th'];
                finishSeats.forEach((seatIdx, pos) => {
                  const itmEntry = table.itmPreview?.find(p => p.seatIndex === seatIdx) ?? null;
                  posMap.set(seatIdx, { pos: pos + 1, label: posLabels[pos] ?? `${pos + 1}th`, itm: itmEntry });
                });
              }
            }

            return (
            <div>
              <div className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Seats</div>
              <div className="space-y-1">
                {seats.map(seat => {
                  const finish = posMap.get(seat.index);
                  return (
                  <div
                    key={seat.index}
                    className={`flex items-center justify-between text-xs font-mono px-3 py-1.5 rounded-lg ${
                      seat.index === table.currentPlayer && table.phase >= 2 && table.phase <= 5
                        ? 'bg-cyan-500/10 border border-cyan-500/20'
                        : finish?.itm ? 'bg-amber-500/[0.04] border border-amber-500/10'
                        : 'bg-white/[0.02]'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-gray-500 w-4">#{seat.index}</span>
                      <span className={`w-16 ${seatStatusColor(seat.status)}`}>{seat.statusName}</span>
                      <span className="text-gray-400">{short(seat.wallet)}</span>
                      {finish && (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          finish.pos === 1 ? 'bg-yellow-400/20 text-yellow-300 border border-yellow-400/30' :
                          finish.itm ? 'bg-emerald-400/15 text-emerald-300 border border-emerald-400/20' :
                          'bg-gray-500/10 text-gray-500 border border-gray-500/15'
                        }`}>
                          {finish.label}
                        </span>
                      )}
                      {finish?.itm && (
                        <span className="text-emerald-400 text-[10px]">
                          {(finish.itm.solLamports / 1e9).toFixed(4)} SOL · {(finish.itm.pokerAmount / 1e6).toFixed(0)} POKER
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-gray-300">
                        Chips: <span className="text-white">{isSng ? fmtChips(seat.chips) : fmtAmt(seat.chips)}</span>
                      </span>
                      {seat.bet > 0 && (
                        <span className="text-amber-400">
                          Bet: {isSng ? `${fmtChips(seat.bet)} chips` : fmtAmt(seat.bet)}
                        </span>
                      )}
                      {(seat.status === 6 || seat.status === 4) && seat.cashoutChips !== undefined && seat.cashoutChips > 0 && (
                        <span className="text-orange-400 text-[10px]">
                          cashout={fmtAmt(seat.cashoutChips)} n={seat.cashoutNonce ?? 0}
                        </span>
                      )}
                      {seat.status === 4 && seat.sitOutTimestamp !== undefined && seat.sitOutTimestamp > 0 && (
                        <span className="text-gray-500 text-[10px]">
                          sitOut {Math.floor((Date.now() / 1000 - seat.sitOutTimestamp) / 60)}m
                        </span>
                      )}
                      {seat.vaultReserve !== undefined && seat.vaultReserve > 0 && (
                        <span className="text-blue-400 text-[10px]">
                          reserve={fmtAmt(seat.vaultReserve)}
                        </span>
                      )}
                      {seat.index === table.currentPlayer && table.phase >= 2 && table.phase <= 5 && (
                        <span className="text-cyan-400 animate-pulse text-[10px]">&#9664; ACTION</span>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ─── Event log for crank visualization ───
interface CrankEvent {
  id: number;
  time: string;
  table: string;
  from: string;
  to: string;
  type: 'phase_change' | 'stuck' | 'closed' | 'new' | 'prize_distribution' | 'closing';
}

interface TableTrackState {
  phase: number;
  prizesDistributed: boolean;
  isClosing: boolean;
}

// ─── Auctions Admin Tab ───
interface AuctionConfigData {
  currentEpoch: number;
  epochStart: number;
  epochEnd: number;
  durationDays: number;
  lastTotalBid: number;
  isExpired: boolean;
  timeRemaining: number;
}
interface ListedTokenData { mint: string; epoch: number; listedAt: number; }
interface BidData { mint: string; totalAmount: number; bidderCount: number; }
interface TokenMetaData { name: string; symbol: string; logoURI: string | null; }

function AuctionsAdmin() {
  const [config, setConfig] = useState<AuctionConfigData | null>(null);
  const [listedTokens, setListedTokens] = useState<ListedTokenData[]>([]);
  const [bids, setBids] = useState<BidData[]>([]);
  const [tokenMetas, setTokenMetas] = useState<Record<string, TokenMetaData>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // List token form
  const [listMint, setListMint] = useState('');
  const [listEpoch, setListEpoch] = useState('0');
  const [listing, setListing] = useState(false);
  const [listResult, setListResult] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/auction-state');
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setConfig(data.config);
      setListedTokens(data.listedTokens || []);
      setBids(data.bids || []);
      setError(null);

      // Fetch token metadata for all mints
      const allMints = [
        ...(data.listedTokens || []).map((t: ListedTokenData) => t.mint),
        ...(data.bids || []).map((b: BidData) => b.mint),
      ];
      const uniqueMints = Array.from(new Set(allMints)).filter(m => m !== '11111111111111111111111111111111');
      if (uniqueMints.length > 0) {
        try {
          const metaRes = await fetch(`/api/token-meta?mints=${uniqueMints.join(',')}`);
          if (metaRes.ok) {
            const metaData = await metaRes.json();
            setTokenMetas(prev => ({ ...prev, ...metaData }));
          }
        } catch {}
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchState(); }, [fetchState]);

  const handleListToken = async () => {
    if (!listMint.trim()) return;
    setListing(true);
    setListResult(null);
    try {
      const res = await fetch('/api/admin/list-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mint: listMint.trim(), epoch: parseInt(listEpoch) || 0 }),
      });
      const data = await res.json();
      if (data.success) {
        setListResult(`Listed ${listMint.trim().slice(0, 12)}... (sig: ${data.signature?.slice(0, 20)}...)`);
        setListMint('');
        fetchState();
      } else {
        setListResult(`Error: ${data.error}`);
      }
    } catch (e: any) {
      setListResult(`Error: ${e?.message}`);
    } finally {
      setListing(false);
    }
  };

  const mintLabel = (mint: string) => {
    const meta = tokenMetas[mint];
    if (meta) return `${meta.symbol} (${meta.name})`;
    return mint.slice(0, 12) + '...';
  };

  const formatTime = (secs: number) => {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  return (
    <div className="max-w-[1200px] mx-auto px-6 py-6 space-y-6">
      <h2 className="text-xl font-bold text-white">Auction Management</h2>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/[0.05] p-4 text-red-400 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="text-center py-12">
          <div className="w-6 h-6 border-2 border-purple-500/30 border-t-purple-400 rounded-full animate-spin mx-auto mb-3" />
          <div className="text-gray-500 text-sm">Loading auction state...</div>
        </div>
      ) : (
        <>
          {/* Auction Config */}
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
            <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Auction Config</h3>
            {config ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <div className="text-xs text-gray-500">Current Epoch</div>
                  <div className="text-lg font-bold text-white">{config.currentEpoch}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Duration</div>
                  <div className="text-lg font-bold text-white">{config.durationDays}d</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Status</div>
                  <div className={`text-lg font-bold ${config.isExpired ? 'text-red-400' : 'text-emerald-400'}`}>
                    {config.isExpired ? 'EXPIRED' : `${formatTime(config.timeRemaining)} left`}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Epoch Range</div>
                  <div className="text-sm text-gray-300">
                    {new Date(config.epochStart * 1000).toLocaleDateString()} &rarr; {new Date(config.epochEnd * 1000).toLocaleDateString()}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-amber-400 text-sm">AuctionConfig not initialized!</div>
            )}
          </div>

          {/* Admin List Token */}
          <div className="rounded-xl border border-purple-500/20 bg-purple-500/[0.03] p-5">
            <h3 className="text-sm font-bold text-purple-300 uppercase tracking-wider mb-3">Admin: List Token (Bypass Auction)</h3>
            <p className="text-xs text-gray-500 mb-3">
              Manually create a ListedToken PDA. Use to restore tokens that won auctions before a redeploy, or to list tokens directly.
            </p>
            <div className="flex gap-3 items-end flex-wrap">
              <div className="flex-1 min-w-[280px]">
                <label className="text-xs text-gray-500 block mb-1">Token Mint Address</label>
                <input
                  type="text"
                  value={listMint}
                  onChange={e => setListMint(e.target.value)}
                  placeholder="e.g. DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX"
                  className="w-full bg-gray-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-300 placeholder-gray-600 focus:border-purple-500/40 focus:outline-none font-mono"
                />
              </div>
              <div className="w-24">
                <label className="text-xs text-gray-500 block mb-1">Epoch</label>
                <input
                  type="number"
                  value={listEpoch}
                  onChange={e => setListEpoch(e.target.value)}
                  className="w-full bg-gray-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-300 focus:border-purple-500/40 focus:outline-none"
                />
              </div>
              <button
                onClick={handleListToken}
                disabled={listing || !listMint.trim()}
                className="px-4 py-2 rounded-lg bg-purple-500/20 border border-purple-500/30 text-purple-300 text-sm font-medium hover:bg-purple-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {listing ? 'Listing...' : 'List Token'}
              </button>
            </div>
            {listResult && (
              <div className={`mt-3 text-xs ${listResult.startsWith('Error') ? 'text-red-400' : 'text-emerald-400'}`}>
                {listResult}
              </div>
            )}
          </div>

          {/* Listed Tokens */}
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
            <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">
              Listed Tokens ({listedTokens.length})
            </h3>
            {listedTokens.length === 0 ? (
              <div className="text-gray-600 text-sm py-4 text-center">No tokens listed yet</div>
            ) : (
              <div className="space-y-2">
                {listedTokens.map(t => (
                  <div key={t.mint} className="flex items-center justify-between bg-white/[0.02] border border-white/[0.06] rounded-lg px-4 py-3">
                    <div className="flex items-center gap-3">
                      {tokenMetas[t.mint]?.logoURI && (
                        <img src={tokenMetas[t.mint].logoURI!} alt="" className="w-6 h-6 rounded-full" />
                      )}
                      <div>
                        <div className="text-sm font-medium text-white">{mintLabel(t.mint)}</div>
                        <div className="text-xs text-gray-500 font-mono">{t.mint}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-gray-500">Epoch {t.epoch}</div>
                      <div className="text-xs text-gray-600">{new Date(t.listedAt * 1000).toLocaleDateString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Bid Leaderboard */}
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
            <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">
              Global Bid Leaderboard ({bids.length})
            </h3>
            {bids.length === 0 ? (
              <div className="text-gray-600 text-sm py-4 text-center">No active bids</div>
            ) : (
              <div className="space-y-2">
                {bids.map((b, i) => (
                  <div key={b.mint} className="flex items-center justify-between bg-white/[0.02] border border-white/[0.06] rounded-lg px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className={`text-sm font-bold ${i === 0 ? 'text-amber-400' : i === 1 ? 'text-gray-300' : i === 2 ? 'text-orange-400' : 'text-gray-500'}`}>
                        #{i + 1}
                      </span>
                      {tokenMetas[b.mint]?.logoURI && (
                        <img src={tokenMetas[b.mint].logoURI!} alt="" className="w-6 h-6 rounded-full" />
                      )}
                      <div>
                        <div className="text-sm font-medium text-white">{mintLabel(b.mint)}</div>
                        <div className="text-xs text-gray-500 font-mono">{b.mint}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold text-cyan-400">{b.totalAmount.toFixed(4)} SOL</div>
                      <div className="text-xs text-gray-500">{b.bidderCount} bidder{b.bidderCount !== 1 ? 's' : ''}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main Page ───
export default function AdminPage() {
  const [adminTab, setAdminTab] = useState<'dashboard' | 'crank' | 'test' | 'auctions'>('dashboard');
  const [data, setData] = useState<AdminData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingTables, setLoadingTables] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [pollInterval, setPollInterval] = useState(3);
  const [crankEvents, setCrankEvents] = useState<CrankEvent[]>([]);
  const [filter, setFilter] = useState<'all' | 'er' | 'l1' | 'stuck' | 'broken' | 'cash' | 'sng'>('all');
  const [tableSearch, setTableSearch] = useState('');
  const [showCount, setShowCount] = useState(10);
  const [claimingRake, setClaimingRake] = useState(false);
  const [claimProgress, setClaimProgress] = useState<{ done: number; total: number; claimed: number; errors: number } | null>(null);
  const [claimResult, setClaimResult] = useState<string | null>(null);
  const prevTablesRef = useRef<Map<string, TableTrackState>>(new Map());
  const closingSinceRef = useRef<Map<string, number>>(new Map());
  const eventIdRef = useRef(0);

  const [seatCache, setSeatCache] = useState<Map<string, ParsedSeat[]>>(new Map());
  const [createdAtCache, setCreatedAtCache] = useState<Map<string, string>>(new Map());
  const [loadingSeats, setLoadingSeats] = useState<string | null>(null);
  const [crankAction, setCrankAction] = useState<string | null>(null);
  const [crankDashData, setCrankDashData] = useState<any>(null);
  const [crankLogs, setCrankLogs] = useState<string[]>([]);
  const [crankCmdResult, setCrankCmdResult] = useState<string | null>(null);

  const fetchCrankDash = useCallback(async () => {
    try {
      const resp = await fetch('/api/admin/crank');
      if (resp.ok) {
        const json = await resp.json();
        setCrankDashData(json);
        setCrankLogs(json.recentLogs || []);
      }
    } catch {}
  }, []);

  // Auto-poll crank dashboard when tab is active
  useEffect(() => {
    if (adminTab !== 'crank') return;
    fetchCrankDash();
    const iv = setInterval(fetchCrankDash, 5000);
    return () => clearInterval(iv);
  }, [adminTab, fetchCrankDash]);

  const sendCrankCommand = useCallback(async (action: 'start' | 'stop' | 'restart') => {
    setCrankAction(action);
    setCrankCmdResult(null);
    try {
      const resp = await fetch('/api/admin/crank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const result = await resp.json();
      if (!resp.ok) {
        setCrankCmdResult(`❌ ${action} failed: ${result.error}`);
      } else {
        setCrankCmdResult(`✅ ${result.message}`);
        // Poll for heartbeat after start
        if (action === 'start') {
          setTimeout(fetchCrankDash, 5000);
          setTimeout(fetchCrankDash, 10000);
          setTimeout(fetchCrankDash, 15000);
        } else {
          setTimeout(fetchCrankDash, 3000);
        }
      }
    } catch (e: any) {
      setCrankCmdResult(`❌ ${action} error: ${e.message}`);
    } finally {
      setCrankAction(null);
    }
  }, [fetchCrankDash]);

  const handleMarkBroken = useCallback(async (pubkey: string, action: 'mark' | 'unmark') => {
    const reason = action === 'mark' ? prompt('Reason for marking broken (optional):') || 'Manually marked broken' : undefined;
    try {
      const resp = await fetch('/api/admin/broken-tables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey, action, reason }),
      });
      if (resp.ok) {
        fetchData(false);
      }
    } catch {}
  }, []);

  const fetchSeatsForTable = useCallback(async (pubkey: string, maxPlayers: number, location: string) => {
    if (seatCache.has(pubkey)) return;
    setLoadingSeats(pubkey);
    try {
      const res = await fetch(`/api/admin/seats?table=${pubkey}&maxPlayers=${maxPlayers}`);
      if (res.ok) {
        const json = await res.json();
        setSeatCache(prev => new Map(prev).set(pubkey, json.seats ?? []));
        if (json.createdAt) {
          setCreatedAtCache(prev => new Map(prev).set(pubkey, json.createdAt));
        }
      }
    } catch { /* ignore */ }
    setLoadingSeats(null);
  }, [seatCache]);

  const fetchData = useCallback(async (isInitial = false) => {
    try {
      // Phase 1: Quick stats (treasury + pool) — renders immediately
      if (isInitial) {
        const quickRes = await fetch('/api/admin/status?skipTables=true');
        if (quickRes.ok) {
          const quickJson: AdminData = await quickRes.json();
          setData(quickJson);
          setLoading(false);
        }
        setLoadingTables(true);
      }

      // Phase 2: Full data with tables
      const res = await fetch('/api/admin/status?skipSeats=true');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: AdminData = await res.json();

      const stageLabel = (stage: ParsedTable['closingStage']): string => {
        if (stage === 'undelegate') return 'Undelegating';
        if (stage === 'prize_distribution') return 'Distributing Prizes';
        if (stage === 'close_accounts') return 'Closing Accounts';
        return 'Closing';
      };

      // Compute client-side closing age and closing-stuck overlay state.
      const nowMs = Date.now();
      const allIncoming = [...json.tables.er, ...json.tables.l1];
      for (const t of allIncoming) {
        if (t.isClosing) {
          const since = closingSinceRef.current.get(t.pubkey) ?? nowMs;
          if (!closingSinceRef.current.has(t.pubkey)) {
            closingSinceRef.current.set(t.pubkey, since);
          }
          const ageSec = Math.max(0, Math.floor((nowMs - since) / 1000));
          t.closingAgeSec = ageSec;
          if (ageSec >= CLOSING_STUCK_SECS) {
            t.isStuck = true;
            if (!t.stuckReason) {
              t.stuckReason = `Closing stuck: ${ageSec}s in ${stageLabel(t.closingStage)}`;
            }
          }
        } else {
          closingSinceRef.current.delete(t.pubkey);
          t.closingAgeSec = 0;
        }
      }

      json.tables.stuckCount = allIncoming.filter(t => t.isStuck).length;

      setData(json);
      setError(null);
      setLoadingTables(false);

      // Detect phase changes for crank event log
      const allTables = [...json.tables.er, ...json.tables.l1];
      const newMap = new Map<string, TableTrackState>();
      const newEvents: CrankEvent[] = [];
      const now = new Date().toLocaleTimeString('en-US', { hour12: false });

      for (const t of allTables) {
        const prev = prevTablesRef.current.get(t.pubkey);
        newMap.set(t.pubkey, {
          phase: t.phase,
          prizesDistributed: t.prizesDistributed,
          isClosing: t.isClosing,
        });

        if (prev === undefined) {
          // New table
          newEvents.push({
            id: eventIdRef.current++,
            time: now,
            table: short(t.pubkey),
            from: '',
            to: t.phaseName,
            type: 'new',
          });
        } else if (prev.phase !== t.phase) {
          const PHASE_NAMES_LOCAL = ['Waiting','Starting','Preflop','Flop','Turn','River','Showdown','Complete'];
          newEvents.push({
            id: eventIdRef.current++,
            time: now,
            table: short(t.pubkey),
            from: PHASE_NAMES_LOCAL[prev.phase] ?? '?',
            to: t.phaseName,
            type: t.isStuck ? 'stuck' : 'phase_change',
          });
        }

        if (prev && !prev.prizesDistributed && t.prizesDistributed) {
          newEvents.push({
            id: eventIdRef.current++,
            time: now,
            table: short(t.pubkey),
            from: 'Prizes pending',
            to: 'Prizes distributed',
            type: 'prize_distribution',
          });
        }

        if (prev && !prev.isClosing && t.isClosing) {
          newEvents.push({
            id: eventIdRef.current++,
            time: now,
            table: short(t.pubkey),
            from: t.phaseName,
            to: stageLabel(t.closingStage),
            type: 'closing',
          });
        }
      }

      // Detect closed tables
      for (const [key] of Array.from(prevTablesRef.current.entries())) {
        if (!newMap.has(key)) {
          newEvents.push({
            id: eventIdRef.current++,
            time: now,
            table: short(key),
            from: 'exists',
            to: 'closed',
            type: 'closed',
          });
        }
      }

      if (newEvents.length > 0) {
        setCrankEvents(prev => [...newEvents, ...prev].slice(0, 100));
      }
      prevTablesRef.current = newMap;
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
      setLoadingTables(false);
    }
  }, []);

  const claimAllRake = useCallback(async () => {
    if (!data || claimingRake) return;
    const allTables = [...data.tables.er, ...data.tables.l1];
    const claimable = allTables.filter(t => t.gameType === 3 && (t.rakeAccumulated - t.vaultTotalRakeDistributed) > 0);
    if (claimable.length === 0) {
      setClaimResult('No pending rake to claim');
      return;
    }
    setClaimingRake(true);
    setClaimResult(null);
    setClaimProgress({ done: 0, total: claimable.length, claimed: 0, errors: 0 });

    let totalClaimed = 0;
    let errorCount = 0;
    for (let i = 0; i < claimable.length; i++) {
      const table = claimable[i];
      try {
        const res = await fetch('/api/cash-game/clear-rake', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tablePda: table.pubkey }),
        });
        const result = await res.json();
        if (result.success && result.distributed) {
          totalClaimed += result.distributed;
        } else if (!result.success) {
          errorCount++;
        }
      } catch {
        errorCount++;
      }
      setClaimProgress({ done: i + 1, total: claimable.length, claimed: totalClaimed, errors: errorCount });
    }

    setClaimingRake(false);
    setClaimResult(
      `Claimed ${(totalClaimed / 1e9).toFixed(6)} from ${claimable.length - errorCount}/${claimable.length} table(s)` +
      (errorCount > 0 ? ` (${errorCount} error${errorCount > 1 ? 's' : ''})` : '')
    );
    fetchData();
  }, [data, claimingRake, fetchData]);

  useEffect(() => {
    fetchData(true);
    const interval = setInterval(() => fetchData(false), pollInterval * 1000);
    return () => clearInterval(interval);
  }, [fetchData, pollInterval]);

  // Filter + search + sort tables
  const allSorted = (() => {
    if (!data) return [];
    let all = [...data.tables.er, ...data.tables.l1];
    // Type filter — broken tables ONLY show in the 'broken' tab
    const isBroken = (t: ParsedTable) => t.stuckReason?.startsWith('Broken:');
    if (filter === 'broken') {
      all = all.filter(isBroken);
    } else {
      // Exclude broken tables from every other view
      all = all.filter(t => !isBroken(t));
      switch (filter) {
        case 'er': all = all.filter(t => data.tables.er.some(e => e.pubkey === t.pubkey)); break;
        case 'l1': all = all.filter(t => data.tables.l1.some(e => e.pubkey === t.pubkey)); break;
        case 'stuck': all = all.filter(t => t.isStuck); break;
        case 'cash': all = all.filter(t => t.gameType === 3); break;
        case 'sng': all = all.filter(t => t.gameType < 3); break;
      }
    }
    // Search filter
    if (tableSearch.trim()) {
      const q = tableSearch.trim().toLowerCase();
      all = all.filter(t =>
        t.pubkey.toLowerCase().includes(q) ||
        t.authority.toLowerCase().includes(q) ||
        t.phaseName.toLowerCase().includes(q) ||
        t.gameTypeName.toLowerCase().includes(q) ||
        (t.creator && t.creator.toLowerCase().includes(q))
      );
    }
    // Smart sort: stuck first → active phases (by currentPlayers desc) → waiting → complete
    all.sort((a, b) => {
      if (a.isStuck !== b.isStuck) return a.isStuck ? -1 : 1;
      // Active betting phases first (Preflop=2, Flop=3, Turn=4, River=5)
      const aActive = a.phase >= 2 && a.phase <= 5;
      const bActive = b.phase >= 2 && b.phase <= 5;
      if (aActive !== bActive) return aActive ? -1 : 1;
      // Then showdown
      if (a.phase === 6 && b.phase !== 6) return -1;
      if (b.phase === 6 && a.phase !== 6) return 1;
      // Within same category, sort by player count (most players first)
      if (a.currentPlayers !== b.currentPlayers) return b.currentPlayers - a.currentPlayers;
      return b.handNumber - a.handNumber;
    });
    return all;
  })();

  const filteredTables = allSorted.slice(0, showCount);
  const hasMore = allSorted.length > showCount;

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header */}
      <header className="border-b border-white/[0.06] bg-black/40 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-gray-500 hover:text-gray-300 text-sm">&larr; Game</Link>
            <div className="flex items-center gap-2">
              <span className="text-cyan-400 text-lg">&#9881;</span>
              <h1 className="text-lg font-bold text-white">Admin Dashboard</h1>
            </div>
            {data && (
              <span className="text-xs text-gray-600 font-mono">
                Last: {new Date(data.timestamp).toLocaleTimeString()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-500">Poll:</label>
            <select
              value={pollInterval}
              onChange={(e) => setPollInterval(Number(e.target.value))}
              className="bg-gray-900 border border-white/10 rounded-lg px-2 py-1 text-xs text-gray-300"
            >
              <option value={2}>2s</option>
              <option value={5}>5s</option>
              <option value={10}>10s</option>
              <option value={30}>30s</option>
            </select>
            <div className="flex items-center rounded-lg border border-white/10 overflow-hidden">
              <button
                onClick={() => setAdminTab('dashboard')}
                className={`px-3 py-1 text-xs font-medium transition-colors ${adminTab === 'dashboard' ? 'bg-cyan-500/20 text-cyan-300' : 'text-gray-500 hover:text-gray-300'}`}
              >
                Dashboard
              </button>
              <button
                onClick={() => setAdminTab('crank')}
                className={`px-3 py-1 text-xs font-medium transition-colors ${adminTab === 'crank' ? 'bg-emerald-500/20 text-emerald-300' : 'text-gray-500 hover:text-gray-300'}`}
              >
                ⚙ Crank
              </button>
              <button
                onClick={() => setAdminTab('test')}
                className={`px-3 py-1 text-xs font-medium transition-colors ${adminTab === 'test' ? 'bg-amber-500/20 text-amber-300' : 'text-gray-500 hover:text-gray-300'}`}
              >
                &gt;_ Test
              </button>
              <button
                onClick={() => setAdminTab('auctions')}
                className={`px-3 py-1 text-xs font-medium transition-colors ${adminTab === 'auctions' ? 'bg-purple-500/20 text-purple-300' : 'text-gray-500 hover:text-gray-300'}`}
              >
                Auctions
              </button>
            </div>
            <button
              onClick={() => fetchData(false)}
              className="px-3 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs hover:bg-cyan-500/20 transition-colors"
            >
              Refresh
            </button>
            <div className={`w-2 h-2 rounded-full ${error ? 'bg-red-500' : 'bg-emerald-500'} animate-pulse`} />
          </div>
        </div>
      </header>

      {adminTab === 'test' && (
        <div className="w-full" style={{ height: 'calc(100vh - 56px)' }}>
          <iframe src="/test?embed=1" className="w-full h-full border-0" />
        </div>
      )}

      {adminTab === 'crank' && <CrankDashboard crankDashData={crankDashData} crankLogs={crankLogs} crankAction={crankAction} crankCmdResult={crankCmdResult} sendCrankCommand={sendCrankCommand} crankMetrics={data?.crank ?? null} crankStatus={data?.crankStatus ?? null} fetchCrankDash={fetchCrankDash} />}

      {adminTab === 'auctions' && <AuctionsAdmin />}

      <main className={`max-w-[1600px] mx-auto px-6 py-6 space-y-6 ${adminTab !== 'dashboard' ? 'hidden' : ''}`}>
        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/[0.05] p-4 text-red-400 text-sm">
            Error: {error}
          </div>
        )}

        {loading && !data ? (
          <div className="text-center py-20">
            <div className="w-8 h-8 border-2 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin mx-auto mb-4" />
            <div className="text-gray-500 text-sm">Loading admin data...</div>
          </div>
        ) : data ? (
          <>
            {/* ─── Overview Stats ─── */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {loadingTables ? (
                <>
                  <StatCard label="TEE Tables" value={<LoadingDots />} color="emerald" />
                  <StatCard label="L1 Tables" value={<LoadingDots />} color="purple" />
                  <StatCard label="Stuck" value={<LoadingDots />} color="emerald" />
                  <StatCard label="Active Players" value={<LoadingDots />} color="emerald" />
                  <StatCard label="Cash Games" value={<LoadingDots />} sub="tables" color="amber" />
                  <StatCard label="Sit & Go" value={<LoadingDots />} sub="tables" color="cyan" />
                </>
              ) : (
                <>
                  <StatCard label="TEE Tables" value={data.tables.erCount} color="emerald" />
                  <StatCard label="L1 Tables" value={data.tables.l1Count} color="purple" />
                  <StatCard label="Stuck" value={data.tables.stuckCount} color={data.tables.stuckCount > 0 ? 'red' : 'emerald'} />
                  <StatCard label="Active Players" value={data.summary.totalPlayers} color="emerald" />
                  <StatCard label="Cash Games" value={data.summary.cashGameTables} sub="tables" color="amber" />
                  <StatCard label="Sit & Go" value={data.summary.sitAndGoTables} sub="tables" color="cyan" />
                </>
              )}
            </div>

            {/* ─── Treasury Wallet ─── */}
            <div className="rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-500/[0.04] to-transparent p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-amber-400">&#128176;</span>
                <h3 className="text-sm font-bold text-amber-300 uppercase tracking-wider">Treasury Wallet</h3>
                <span className="text-[10px] text-gray-600 font-mono ml-auto">{short(data.treasury.address)}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {/* SOL balance — always first */}
                <div className="rounded-lg bg-amber-500/[0.06] border border-amber-500/15 p-3">
                  <div className="text-[10px] text-amber-400/60 uppercase tracking-wider">SOL</div>
                  <div className="text-lg font-bold text-amber-400 tabular-nums">{data.treasury.balanceSol.toFixed(4)}</div>
                  <div className="text-[10px] text-gray-600">{data.treasury.balanceLamports.toLocaleString()} lamports</div>
                </div>
                {/* POKER balance — always second */}
                <div className="rounded-lg bg-cyan-500/[0.06] border border-cyan-500/15 p-3">
                  <div className="text-[10px] text-cyan-400/60 uppercase tracking-wider">POKER</div>
                  <div className="text-lg font-bold text-cyan-400 tabular-nums">{data.treasury.pokerBalance.toFixed(2)}</div>
                  <div className="text-[10px] text-gray-600">rake share</div>
                </div>
                {/* Rent held */}
                {loadingTables ? (
                  <div className="rounded-lg bg-purple-500/[0.06] border border-purple-500/15 p-3">
                    <div className="text-[10px] text-purple-400/60 uppercase tracking-wider">Rent Held</div>
                    <div className="text-lg font-bold text-purple-400 tabular-nums"><LoadingDots /></div>
                    <div className="text-[10px] text-gray-600">loading tables...</div>
                  </div>
                ) : (
                  <div className="rounded-lg bg-purple-500/[0.06] border border-purple-500/15 p-3">
                    <div className="text-[10px] text-purple-400/60 uppercase tracking-wider">Rent Held</div>
                    <div className="text-lg font-bold text-purple-400 tabular-nums">{data.tables.totalRentHeldSol.toFixed(4)} SOL</div>
                    <div className="text-[10px] text-gray-600">{data.tables.totalCount} accounts</div>
                  </div>
                )}
                {/* Other tokens in treasury */}
                {data.treasury.tokens && data.treasury.tokens
                  .filter(t => t.mint !== POKER_MINT_STR && t.uiBalance > 0)
                  .sort((a, b) => b.uiBalance - a.uiBalance)
                  .map(t => (
                    <div key={t.mint} className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-3">
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider">{tokenSymbol(t.mint)}</div>
                      <div className="text-lg font-bold text-gray-300 tabular-nums">{t.uiBalance >= 1 ? t.uiBalance.toFixed(4) : t.uiBalance.toPrecision(4)}</div>
                      <div className="text-[10px] text-gray-600 font-mono">{short(t.mint)}</div>
                    </div>
                  ))
                }
              </div>
            </div>

            {/* ─── Staking Rewards (separated from rake) ─── */}
            {data.pool && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-500/[0.04] to-transparent p-4">
                  <div className="text-[10px] text-amber-400/60 uppercase tracking-wider mb-1">SOL Staking Rewards</div>
                  <div className="text-lg font-bold text-amber-400 tabular-nums">{data.pool.solAvailable.toFixed(4)} <span className="text-xs font-normal">available</span></div>
                  <div className="text-xs text-gray-500 mt-1">Distributed: {data.pool.solDistributed.toFixed(4)} · Claimed: {(data.pool.solClaimed ?? 0).toFixed(4)}</div>
                  <div className="text-[10px] text-gray-600 mt-0.5">Delta (unclaimed): {(data.pool.solAvailable).toFixed(4)} SOL</div>
                </div>
                <div className="rounded-xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/[0.04] to-transparent p-4">
                  <div className="text-[10px] text-cyan-400/60 uppercase tracking-wider mb-1">POKER Staking Rewards</div>
                  <div className="text-lg font-bold text-cyan-400 tabular-nums">{data.pool.pokerAvailable.toFixed(2)} <span className="text-xs font-normal">available</span></div>
                  <div className="text-xs text-gray-500 mt-1">Distributed: {data.pool.pokerDistributed.toFixed(2)}</div>
                  <div className="text-[10px] text-gray-600 mt-0.5">From cash game rake (50%)</div>
                </div>
                <div className="rounded-xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.04] to-transparent p-4">
                  <div className="text-[10px] text-emerald-400/60 uppercase tracking-wider mb-1">Total Staked (Burned)</div>
                  <div className="text-lg font-bold text-emerald-400 tabular-nums">{data.pool.totalStaked.toFixed(0)} <span className="text-xs font-normal">POKER</span></div>
                  <div className="text-xs text-gray-500 mt-1">Burned into pool for rewards</div>
                </div>
                <div className="rounded-xl border border-purple-500/20 bg-gradient-to-br from-purple-500/[0.04] to-transparent p-4">
                  <div className="text-[10px] text-purple-400/60 uppercase tracking-wider mb-1">Unrefined Total</div>
                  <div className="text-lg font-bold text-purple-400 tabular-nums">{data.pool.totalUnrefined.toFixed(0)} <span className="text-xs font-normal">POKER</span></div>
                  <div className="text-xs text-gray-500 mt-1">SNG prizes (pending refine)</div>
                </div>
              </div>
            )}

            {/* ─── Rake Claim (compact) ─── */}
            {!loadingTables && (() => {
              const allTables = [...data.tables.er, ...data.tables.l1];
              const cashTables = allTables.filter(t => t.gameType === 3);
              const getPending = (t: ParsedTable) => Math.max(0, t.rakeAccumulated - t.vaultTotalRakeDistributed);
              const totalPendingRake = cashTables.reduce((s, t) => s + getPending(t), 0);
              const claimableCount = cashTables.filter(t => getPending(t) > 0).length;
              if (totalPendingRake === 0 && !claimingRake && !claimResult) return null;
              return (
                <div className="rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-500/[0.04] to-transparent p-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-3">
                    <span className="text-amber-400 text-sm">&#128176;</span>
                    <span className="text-xs text-amber-300 font-medium">
                      {fmtAmt(totalPendingRake)} pending rake across {claimableCount} table{claimableCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {claimResult && !claimingRake && (
                      <span className="text-xs text-emerald-400">{claimResult} <button onClick={() => setClaimResult(null)} className="text-gray-600 hover:text-gray-400 ml-1">&times;</button></span>
                    )}
                    {claimProgress && claimingRake && (
                      <span className="text-xs text-amber-300 font-mono">{claimProgress.done}/{claimProgress.total}</span>
                    )}
                    <button
                      onClick={claimAllRake}
                      disabled={claimingRake || totalPendingRake === 0}
                      className="px-3 py-1 rounded-lg text-xs font-bold transition-colors disabled:opacity-30 bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25"
                    >
                      {claimingRake ? 'Claiming...' : 'Claim All Rake'}
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* ─── Two-column: Tables + Crank Log ─── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

              {/* Tables Column (2/3 width) */}
              <div className="lg:col-span-2 space-y-3">
                {/* Filter tabs + search */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-gray-400 mr-1">Tables</span>
                  {(['all', 'er', 'l1', 'cash', 'sng', 'stuck', 'broken'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => { setFilter(f); setShowCount(10); }}
                      className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                        filter === f
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                          : 'bg-white/[0.03] text-gray-500 border border-white/[0.06] hover:text-gray-300'
                      }`}
                    >
                      {f === 'cash' ? 'CASH' : f === 'sng' ? 'S&G' : f === 'er' ? 'TEE' : f.toUpperCase()}
                      {f === 'stuck' && data.tables.stuckCount > 0 && (
                        <span className="ml-1 text-red-400">({data.tables.stuckCount})</span>
                      )}
                      {f === 'cash' && data.summary.cashGameTables > 0 && (
                        <span className="ml-1 text-amber-400">({data.summary.cashGameTables})</span>
                      )}
                    </button>
                  ))}
                  <input
                    type="text"
                    placeholder="Search pubkey / authority..."
                    value={tableSearch}
                    onChange={(e) => { setTableSearch(e.target.value); setShowCount(10); }}
                    className="ml-auto bg-gray-900 border border-white/10 rounded-lg px-3 py-1 text-xs text-gray-300 placeholder-gray-600 w-52 focus:border-cyan-500/40 focus:outline-none"
                  />
                  <span className="text-xs text-gray-600">{allSorted.length} total · showing {filteredTables.length}</span>
                </div>

                {/* Table list */}
                {loadingTables ? (
                  <div className="text-center py-12 border border-white/[0.04] rounded-xl">
                    <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin mx-auto mb-3" />
                    <div className="text-gray-500 text-sm">Loading tables from L1 + TEE...</div>
                    <div className="text-gray-600 text-xs mt-1">Scanning delegated &amp; undelegated accounts</div>
                  </div>
                ) : filteredTables.length === 0 ? (
                  <div className="text-center py-12 text-gray-600 text-sm border border-white/[0.04] rounded-xl">
                    No tables found
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredTables.map(table => (
                        <TableCard
                          key={table.pubkey}
                          table={{ ...table, createdAt: createdAtCache.get(table.pubkey) ?? table.createdAt }}
                          expanded={expandedTable === table.pubkey}
                          seats={seatCache.get(table.pubkey) ?? table.seats}
                          loadingSeats={loadingSeats === table.pubkey}
                          onMarkBroken={handleMarkBroken}
                          onToggle={() => {
                            const willExpand = expandedTable !== table.pubkey;
                            setExpandedTable(willExpand ? table.pubkey : null);
                            if (willExpand && !seatCache.has(table.pubkey) && table.seats.length === 0) {
                              fetchSeatsForTable(table.pubkey, table.maxPlayers, table.location);
                            }
                          }}
                        />
                      ))}
                    {hasMore && (
                      <button
                        onClick={() => setShowCount(c => c + 10)}
                        className="w-full py-2 rounded-xl border border-white/[0.06] bg-white/[0.02] text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] text-xs font-medium transition-colors"
                      >
                        Show More ({allSorted.length - showCount} remaining)
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Crank Dashboard (1/3 width) */}
              <div className="space-y-3">
                {/* ─── Crank Status (Live Heartbeat) ─── */}
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs text-gray-500 uppercase tracking-wider">Crank Service</div>
                    {data.crankStatus ? (
                      <div className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full ${data.crankStatus.status === 'online' ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'}`} />
                        <span className={`text-xs font-medium ${data.crankStatus.status === 'online' ? 'text-emerald-400' : 'text-red-400'}`}>
                          {data.crankStatus.status === 'online' ? 'Online' : 'Offline'}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-gray-600" />
                        <span className="text-xs text-gray-600">No heartbeat</span>
                      </div>
                    )}
                  </div>
                  {!data.crankStatus && (
                    <button
                      onClick={() => sendCrankCommand('start')}
                      disabled={!!crankAction}
                      className="w-full mt-2 px-2 py-1.5 rounded-lg border text-[10px] font-mono font-medium transition-colors bg-emerald-500/8 border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/15 disabled:opacity-40"
                    >
                      {crankAction === 'start' ? 'Starting...' : 'Start Crank'}
                    </button>
                  )}
                  {data.crankStatus && (
                    <>
                      <div className="grid grid-cols-3 gap-2 mb-2">
                        <div className="text-center">
                          <div className="text-sm font-bold text-white tabular-nums">{data.crankStatus.uptime}</div>
                          <div className="text-[9px] text-gray-500">Uptime</div>
                        </div>
                        <div className="text-center">
                          <div className="text-sm font-bold text-cyan-400 tabular-nums">{data.crankStatus.tablesTracked}</div>
                          <div className="text-[9px] text-gray-500">Tracked</div>
                        </div>
                        <div className="text-center">
                          <div className="text-sm font-bold text-amber-400 tabular-nums">{data.crankStatus.tablesProcessing}</div>
                          <div className="text-[9px] text-gray-500">Processing</div>
                        </div>
                      </div>
                      <div className="flex gap-3 text-[10px] text-gray-600">
                        <span>PID: {data.crankStatus.pid}</span>
                        <span>Heartbeat: {data.crankStatus.heartbeatAge}s ago</span>
                      </div>
                      <div className="flex gap-1.5 mt-2">
                        {data.crankStatus.status === 'online' ? (
                          <>
                            <button
                              onClick={() => sendCrankCommand('restart')}
                              disabled={!!crankAction}
                              className="flex-1 px-2 py-1 rounded-lg border text-[10px] font-mono font-medium transition-colors bg-amber-500/8 border-amber-500/25 text-amber-400 hover:bg-amber-500/15 disabled:opacity-40"
                            >
                              {crankAction === 'restart' ? 'Restarting...' : 'Restart'}
                            </button>
                            <button
                              onClick={() => sendCrankCommand('stop')}
                              disabled={!!crankAction}
                              className="flex-1 px-2 py-1 rounded-lg border text-[10px] font-mono font-medium transition-colors bg-red-500/8 border-red-500/25 text-red-400 hover:bg-red-500/15 disabled:opacity-40"
                            >
                              {crankAction === 'stop' ? 'Stopping...' : 'Stop'}
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => sendCrankCommand('start')}
                            disabled={!!crankAction}
                            className="flex-1 px-2 py-1 rounded-lg border text-[10px] font-mono font-medium transition-colors bg-emerald-500/8 border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/15 disabled:opacity-40"
                          >
                            {crankAction === 'start' ? 'Starting...' : 'Start Crank'}
                          </button>
                        )}
                      </div>
                      {data.crankStatus.recentErrors.length > 0 && (
                        <details className="mt-2">
                          <summary className="text-[10px] text-red-400/70 cursor-pointer hover:text-red-400">
                            {data.crankStatus.recentErrors.length} recent error(s)
                          </summary>
                          <div className="mt-1 max-h-32 overflow-y-auto space-y-0.5">
                            {data.crankStatus.recentErrors.slice(-10).map((e, i) => (
                              <div key={i} className="text-[9px] font-mono text-red-400/60 break-all">{e}</div>
                            ))}
                          </div>
                        </details>
                      )}
                    </>
                  )}
                </div>

                {/* ─── TEE Health ─── */}
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs text-gray-500 uppercase tracking-wider">TEE Connection</div>
                    {data.teeHealth ? (
                      <div className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full ${data.teeHealth.reachable ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'}`} />
                        <span className={`text-xs font-medium ${data.teeHealth.reachable ? 'text-emerald-400' : 'text-red-400'}`}>
                          {data.teeHealth.reachable ? 'Connected' : 'Unreachable'}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-gray-600" />
                        <span className="text-xs text-gray-600">Unknown</span>
                      </div>
                    )}
                  </div>
                  {data.teeHealth && (
                    <>
                      <div className="grid grid-cols-3 gap-2 mb-2">
                        <div className="text-center">
                          <div className="text-sm font-bold text-emerald-400 tabular-nums">{data.teeHealth.ok}</div>
                          <div className="text-[9px] text-gray-500">OK</div>
                        </div>
                        <div className="text-center">
                          <div className={`text-sm font-bold tabular-nums ${data.teeHealth.fail > 0 ? 'text-red-400' : 'text-gray-600'}`}>{data.teeHealth.fail}</div>
                          <div className="text-[9px] text-gray-500">Failed</div>
                        </div>
                        <div className="text-center">
                          <div className="text-sm font-bold text-cyan-400 tabular-nums">{data.teeHealth.ok + data.teeHealth.fail}</div>
                          <div className="text-[9px] text-gray-500">Total</div>
                        </div>
                      </div>
                      <div className="text-[10px] text-gray-600 mb-1">{data.teeHealth.authMethod}</div>
                      {data.teeHealth.fail > 0 && (
                        <details className="mt-1">
                          <summary className="text-[10px] text-amber-400/70 cursor-pointer hover:text-amber-400">
                            {data.teeHealth.fail} unreachable table(s) — likely stale L1 delegation records
                          </summary>
                          <div className="mt-1 max-h-32 overflow-y-auto space-y-0.5">
                            {data.teeHealth.failedPubkeys.map((pk, i) => (
                              <div key={i} className="text-[9px] font-mono text-gray-500 break-all">{pk}</div>
                            ))}
                          </div>
                        </details>
                      )}
                    </>
                  )}
                </div>

                {/* ─── Crank Config (Hot-Reloadable) ─── */}
                {data.crankStatus?.config && (() => {
                  const cfg = data.crankStatus.config;
                  const toggles: { key: string; label: string; color: string }[] = [
                    { key: 'crank_sng', label: 'SNG', color: 'blue' },
                    { key: 'crank_cash', label: 'Cash', color: 'green' },
                    { key: 'process_cashouts', label: 'Cashouts', color: 'amber' },
                    { key: 'auto_kick', label: 'Auto Kick', color: 'red' },
                    { key: 'timeout_enabled', label: 'Timeout', color: 'cyan' },
                    { key: 'rake_sweep', label: 'Rake Sweep', color: 'emerald' },
                    { key: 'auction_sweep', label: 'Auctions', color: 'purple' },
                  ];
                  const updateConfig = async (key: string, value: any) => {
                    try {
                      await fetch('/api/admin/crank-config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ [key]: value }),
                      });
                      // Re-fetch status to get updated config
                      setTimeout(() => fetchData(), 1000);
                    } catch {}
                  };
                  return (
                    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                      <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Config</div>
                      <div className="grid grid-cols-5 gap-1.5 mb-2">
                        {toggles.map(t => {
                          const isOn = (cfg as any)[t.key];
                          return (
                            <button
                              key={t.key}
                              onClick={() => updateConfig(t.key, !isOn)}
                              className={`px-1.5 py-1 rounded text-[9px] font-bold transition-colors ${
                                isOn
                                  ? `bg-${t.color}-500/15 border border-${t.color}-500/30 text-${t.color}-400`
                                  : 'bg-gray-500/10 border border-gray-500/20 text-gray-600'
                              }`}
                            >
                              {t.label}
                            </button>
                          );
                        })}
                      </div>
                      <div className="grid grid-cols-3 gap-1.5 text-[9px]">
                        <div>
                          <span className="text-gray-600">Kick: </span>
                          <span className="text-gray-400 font-mono">{(cfg.removal_sweep_interval / 1000).toFixed(0)}s</span>
                        </div>
                        <div>
                          <span className="text-gray-600">Rake: </span>
                          <span className="text-gray-400 font-mono">{(cfg.rake_sweep_interval / 1000).toFixed(0)}s</span>
                        </div>
                        <div>
                          <span className="text-gray-600">Timeout: </span>
                          <span className="text-gray-400 font-mono">{(cfg.timeout_ms / 1000).toFixed(0)}s</span>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* ─── Crank Stats (All-Time from metrics file) ─── */}
                {data.crank && (() => {
                  const c = data.crank;
                  const byLabel = c.byLabel || {};
                  // Group by category
                  const categories: Record<string, { count: number; cost: number; success: number; fail: number; labels: { name: string; count: number; cost: number; chain: string }[] }> = {};
                  for (const [label, info] of Object.entries(byLabel)) {
                    const base = label.replace(/ \(timeout\)$/, '').replace(/\[\d+\]/, '[*]').replace(/\(\d+\)/, '(*)');
                    const cat = base.startsWith('delegate_') ? 'Delegation' :
                                base.startsWith('commit_') ? 'Undelegation' :
                                base.startsWith('close_') ? 'Close' :
                                base.startsWith('distribute_') || base.startsWith('process_rake') ? 'Prizes & Rake' :
                                base.startsWith('process_cashout') ? 'Cashouts' :
                                base.startsWith('clear_leaving') || base.startsWith('cleanup_') || base.startsWith('crank_remove') ? 'Seat Cleanup' :
                                'Game Actions';
                    if (!categories[cat]) categories[cat] = { count: 0, cost: 0, success: 0, fail: 0, labels: [] };
                    const i = info as any;
                    categories[cat].count += i.count;
                    categories[cat].cost += i.costLamports;
                    categories[cat].success += (i.successCount || 0);
                    categories[cat].fail += (i.failCount || 0);
                    categories[cat].labels.push({ name: label, count: i.count, cost: i.costLamports, chain: i.chain });
                  }
                  const sortedCats = Object.entries(categories).sort((a, b) => b[1].count - a[1].count);
                  return (
                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                    <div className="flex items-center justify-between mb-3">
                      <div className="text-xs text-gray-500 uppercase tracking-wider">Crank Stats (All-Time)</div>
                      <span className="text-[10px] text-gray-600 font-mono">{new Date(c.updatedAt).toLocaleString()}</span>
                    </div>
                    {/* Summary row */}
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div className="rounded-lg bg-cyan-500/[0.06] border border-cyan-500/15 p-2 text-center">
                        <div className="text-lg font-bold text-cyan-400 tabular-nums">{c.totals.totalCranks.toLocaleString()}</div>
                        <div className="text-[10px] text-gray-500">Total TXs</div>
                      </div>
                      <div className="rounded-lg bg-amber-500/[0.06] border border-amber-500/15 p-2 text-center">
                        <div className="text-lg font-bold text-amber-400 tabular-nums">{fmtLamportsAsSol(c.totals.totalCostLamports)}</div>
                        <div className="text-[10px] text-gray-500">Total Cost</div>
                      </div>
                      <div className="rounded-lg bg-purple-500/[0.06] border border-purple-500/15 p-2 text-center">
                        <div className="text-lg font-bold text-purple-400 tabular-nums">{fmtLamportsAsSol(c.totals.l1CostLamports)}</div>
                        <div className="text-[10px] text-gray-500">L1 Cost</div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-500 mb-2">
                      <span>TEE: <span className="text-cyan-400">{c.totals.erCranks.toLocaleString()}</span> txs (free)</span>
                      <span>L1: <span className="text-purple-400">{c.totals.l1Cranks.toLocaleString()}</span> txs</span>
                      <span><span className="text-emerald-400">{(c.totals.totalSuccess || 0).toLocaleString()}</span> success</span>
                      <span><span className="text-red-400">{(c.totals.totalFailed || 0).toLocaleString()}</span> failed</span>
                      {(c.totals.simSaved || 0) > 0 && <span><span className="text-amber-300">{c.totals.simSaved}</span> sim-saved</span>}
                    </div>
                    {/* Category breakdown */}
                    <div className="space-y-1.5">
                      {sortedCats.map(([cat, info]) => (
                        <div key={cat} className="flex items-center justify-between text-xs px-1">
                          <span className="text-gray-400">{cat}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-emerald-400/70 font-mono tabular-nums">{info.success > 0 ? info.success.toLocaleString() : ''}</span>
                            {info.fail > 0 && <span className="text-red-400/70 font-mono tabular-nums">{info.fail}f</span>}
                            <span className="text-gray-300 font-mono tabular-nums w-12 text-right">{info.count.toLocaleString()}</span>
                            {info.cost > 0 && <span className="text-amber-400/70 font-mono tabular-nums w-20 text-right">{fmtLamportsAsSol(info.cost)}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  );
                })()}

                {/* ─── Live Activity Feed ─── */}
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-400">Live Activity</span>
                  <button
                    onClick={() => setCrankEvents([])}
                    className="text-xs text-gray-600 hover:text-gray-400"
                  >
                    Clear
                  </button>
                </div>

                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                  <div className="max-h-[400px] overflow-y-auto">
                    {crankEvents.length === 0 ? (
                      <div className="text-center py-8 text-gray-600 text-xs">
                        Watching for phase changes...
                      </div>
                    ) : (
                      <div className="divide-y divide-white/[0.04]">
                        {crankEvents.map(ev => (
                          <div key={ev.id} className="px-3 py-2 text-xs flex items-start gap-2">
                            <span className="text-gray-600 font-mono w-16 shrink-0">{ev.time}</span>
                            <span className={`w-4 text-center shrink-0 ${
                              ev.type === 'stuck' ? 'text-red-400' :
                              ev.type === 'closed' ? 'text-emerald-400' :
                              ev.type === 'prize_distribution' ? 'text-amber-300' :
                              ev.type === 'closing' ? 'text-orange-300' :
                              ev.type === 'new' ? 'text-cyan-400' :
                              'text-gray-400'
                            }`}>
                              {ev.type === 'stuck' ? '!' :
                               ev.type === 'closed' ? '×' :
                               ev.type === 'prize_distribution' ? '$' :
                               ev.type === 'closing' ? '⌛' :
                               ev.type === 'new' ? '+' : '→'}
                            </span>
                            <div className="flex-1 min-w-0">
                              <span className="font-mono text-gray-400">{ev.table}</span>
                              {ev.type === 'new' ? (
                                <span className="text-cyan-400 ml-2">NEW → {ev.to}</span>
                              ) : ev.type === 'closed' ? (
                                <span className="text-emerald-400 ml-2">CLOSED (rent recovered)</span>
                              ) : ev.type === 'prize_distribution' ? (
                                <span className="text-amber-300 ml-2">PRIZES DISTRIBUTED</span>
                              ) : ev.type === 'closing' ? (
                                <span className="text-orange-300 ml-2">CLOSING → {ev.to}</span>
                              ) : (
                                <span className="ml-2">
                                  <span className="text-gray-500">{ev.from}</span>
                                  <span className="text-gray-600 mx-1">→</span>
                                  <span className={ev.type === 'stuck' ? 'text-red-400' : 'text-gray-300'}>{ev.to}</span>
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Connection info */}
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-xs">
                  <div className="text-gray-500 mb-2 uppercase tracking-wider">Endpoints</div>
                  <div className="space-y-1">
                    <div>
                      <span className="text-gray-500">TEE (default):</span>{' '}
                      <span className="text-cyan-400/60 font-mono">devnet-tee.magicblock.app</span>
                      <span className="text-gray-600 ml-1">(MDTrz4)</span>
                    </div>
                    <div>
                      <span className="text-gray-500">TEE:</span>{' '}
                      <span className="text-cyan-400/60 font-mono">tee.magicblock.app</span>
                      <span className="text-gray-600 ml-1">(FnE6)</span>
                    </div>
                    <div>
                      <span className="text-gray-500">L1:</span>{' '}
                      <span className="text-purple-400/60 font-mono">devnet.helius-rpc.com</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Poker:</span>{' '}
                      <span className="text-gray-400 font-mono">4MLb...yiB</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Steel:</span>{' '}
                      <span className="text-amber-400/60 font-mono">9qHC...hZY6</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Staking Pool:</span>{' '}
                      <span className="text-emerald-400/60 font-mono">FSKr...oQQvLY</span>
                    </div>
                    <div>
                      <span className="text-gray-500">$POKER Mint:</span>{' '}
                      <span className="text-cyan-400/60 font-mono">DiJC...HZWX</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
