'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Connection, ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js';
import Link from 'next/link';
import { L1_RPC, ANCHOR_PROGRAM_ID, TABLE_OFFSETS, POKER_MINT, lamportsToSol } from '@/lib/constants';
import { buildCloseTableInstruction } from '@/lib/onchain-game';

const PHASE_LABELS = ['Waiting', 'Starting', 'Preflop', 'Flop', 'Turn', 'River', 'Showdown', 'Complete'];
const GAME_TYPE_LABELS = ['Sit & Go HU', 'Sit & Go 6-Max', 'Sit & Go 9-Max', 'Cash Game'];

function readU64LE(data: Buffer, offset: number): number {
  return Number(data.readBigUInt64LE(offset));
}

interface CashTableInfo {
  publicKey: string;
  tableId: string;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  currentPlayers: number;
  handNumber: number;
  phase: number;
  rakeAccumulated: number;
  creatorRakeTotal: number;
  isUserCreated: boolean;
  gameType: number;
  tokenMint: string;
  pot: number;
  buyInType: number;
  vaultTotalRakeDistributed: number;
  isPrivate: boolean;
  broken: boolean;
  zombie: boolean;
}

function parseTableData(pubkey: PublicKey, data: Buffer): CashTableInfo {
  const O = TABLE_OFFSETS;
  let tokenMint = PublicKey.default.toBase58();
  if (data.length >= 385 + 32) {
    tokenMint = new PublicKey(data.subarray(O.TOKEN_MINT, O.TOKEN_MINT + 32)).toBase58();
  }
  return {
    publicKey: pubkey.toBase58(),
    tableId: Buffer.from(data.subarray(O.TABLE_ID, O.TABLE_ID + 32)).toString('hex').slice(0, 16),
    smallBlind: readU64LE(data, O.SMALL_BLIND),
    bigBlind: readU64LE(data, O.BIG_BLIND),
    maxPlayers: data[O.MAX_PLAYERS],
    currentPlayers: data[O.CURRENT_PLAYERS],
    handNumber: readU64LE(data, O.HAND_NUMBER),
    pot: readU64LE(data, O.POT),
    phase: data[O.PHASE],
    rakeAccumulated: readU64LE(data, O.RAKE_ACCUMULATED),
    creatorRakeTotal: readU64LE(data, O.CREATOR_RAKE_TOTAL),
    isUserCreated: data[O.IS_USER_CREATED] === 1,
    gameType: data[O.GAME_TYPE],
    tokenMint,
    buyInType: data.length > O.BUY_IN_TYPE ? data[O.BUY_IN_TYPE] : 0,
    isPrivate: data.length > O.IS_PRIVATE ? data[O.IS_PRIVATE] === 1 : false,
    vaultTotalRakeDistributed: 0, // populated after vault fetch
    broken: false,
    zombie: false,
  };
}

function getTokenSymbol(mint: string): string {
  if (mint === PublicKey.default.toBase58()) return 'SOL';
  if (mint === POKER_MINT.toBase58()) return 'POKER';
  return mint.slice(0, 4) + '...';
}

function getTokenImage(mint: string): string {
  if (mint === PublicKey.default.toBase58()) return '/tokens/sol.svg';
  if (mint === POKER_MINT.toBase58()) return '/tokens/poker.svg';
  return '/tokens/sol.svg';
}

function formatTokenAmount(amount: number, decimals: number = 9): string {
  const val = amount / 10 ** decimals;
  if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
  if (val >= 1) return val.toFixed(val % 1 === 0 ? 0 : 2);
  return parseFloat(val.toPrecision(3)).toString();
}

export default function MyTablesPage() {
  const { connected, publicKey, sendTransaction } = useWallet();
  const [tables, setTables] = useState<CashTableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [claimingAll, setClaimingAll] = useState(false);
  const [claimStatus, setClaimStatus] = useState<string | null>(null);
  const [incompleteTable, setIncompleteTable] = useState<{ tablePda: string; step: string; maxPlayers: number; createdAt: number } | null>(null);

  // Check for incomplete table creation in localStorage
  useEffect(() => {
    if (!publicKey) { setIncompleteTable(null); return; }
    try {
      const saved = localStorage.getItem(`create-table-${publicKey.toBase58()}`);
      if (saved) {
        const data = JSON.parse(saved);
        if (data.tablePda && data.completedStep && data.maxPlayers) {
          setIncompleteTable({ tablePda: data.tablePda, step: data.completedStep, maxPlayers: data.maxPlayers, createdAt: data.createdAt || 0 });
        }
      }
    } catch { /* ignore */ }
  }, [publicKey]);

  const fetchMyTables = useCallback(async () => {
    if (!publicKey) { setTables([]); setLoading(false); return; }
    if (tables.length === 0) setLoading(true);
    try {
      // Use server-side API that authenticates with TEE for ER reads
      const res = await fetch(`/api/tables/list?creator=${publicKey.toBase58()}`);
      const data = await res.json();
      const rawTables: any[] = data.tables || [];

      const parsed: CashTableInfo[] = rawTables.map((t: any) => ({
        publicKey: t.pubkey,
        tableId: '',
        smallBlind: t.smallBlind,
        bigBlind: t.bigBlind,
        maxPlayers: t.maxPlayers,
        currentPlayers: t.currentPlayers,
        handNumber: t.handNumber,
        phase: t.phase,
        rakeAccumulated: t.rakeAccumulated || 0,
        creatorRakeTotal: 0,
        isUserCreated: t.isUserCreated || false,
        gameType: t.gameType,
        tokenMint: t.tokenMint || PublicKey.default.toBase58(),
        pot: t.pot,
        buyInType: 0,
        isPrivate: t.isPrivate || false,
        vaultTotalRakeDistributed: 0,
        broken: t.broken || false,
        zombie: t.zombie || false,
      })).sort((a: CashTableInfo, b: CashTableInfo) => b.handNumber - a.handNumber);

      // Batch fetch vault data using getMultipleAccountsInfo (single RPC call)
      const l1Conn = new Connection(L1_RPC, 'confirmed');
      const cashParsed = parsed.filter(t => t.gameType === 3);
      if (cashParsed.length > 0) {
        const vaultPdas = cashParsed.map(t => {
          const tablePk = new PublicKey(t.publicKey);
          const [vaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('vault'), tablePk.toBuffer()], ANCHOR_PROGRAM_ID
          );
          return vaultPda;
        });
        try {
          const infos = await l1Conn.getMultipleAccountsInfo(vaultPdas);
          for (let i = 0; i < cashParsed.length; i++) {
            const info = infos[i];
            if (info) {
              const d = Buffer.from(info.data);
              cashParsed[i].vaultTotalRakeDistributed = d.length >= 73 ? Number(d.readBigUInt64LE(65)) : 0;
            }
          }
        } catch { /* ignore vault fetch failures */ }
      }

      setTables(parsed);
    } catch (e) {
      console.error('Failed to fetch tables:', e);
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    if (connected && publicKey) fetchMyTables();
    else { setTables([]); setLoading(false); }
  }, [connected, publicKey, fetchMyTables]);

  const copyLink = (tablePublicKey: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/game/${tablePublicKey}`);
    setCopiedLink(tablePublicKey);
    setTimeout(() => setCopiedLink(null), 2000);
  };

  const closeTable = async (tablePublicKey: string) => {
    if (!publicKey || !sendTransaction) return;
    setClosing(tablePublicKey);
    try {
      const connection = new Connection(L1_RPC, 'confirmed');
      const tablePda = new PublicKey(tablePublicKey);

      // Step 1: Check if table needs undelegation (delegated to ER)
      const l1Info = await connection.getAccountInfo(tablePda);
      const isOnL1 = l1Info && l1Info.owner.toBase58() === '4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB';

      if (!isOnL1) {
        // Table is delegated to ER — call API to undelegate first
        const res = await fetch('/api/cash-game/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tablePda: tablePublicKey }),
        });
        const data = await res.json();
        if (!data.success) {
          alert(data.error || 'Failed to undelegate table');
          return;
        }
        // Wait a moment for L1 to sync
        await new Promise(r => setTimeout(r, 3000));
      }

      // Step 2: Read table to get maxPlayers
      const tableInfo = await connection.getAccountInfo(tablePda);
      const rawMax = tableInfo?.data ? tableInfo.data[TABLE_OFFSETS.MAX_PLAYERS] : 0;
      const maxPlayers = Math.min(rawMax, 9); // safety cap
      console.log('[close] maxPlayers:', rawMax, '→', maxPlayers, 'owner:', tableInfo?.owner?.toBase58()?.slice(0, 8));

      // Step 3: Close on L1 with all child accounts
      // Uses creator for all seat wallets — keeps unique keys at ~33 for 9-max
      // (fits in 1232-byte TX limit) and sends ALL rent back to creator.
      const ix = buildCloseTableInstruction(publicKey, tablePda, publicKey, maxPlayers);
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }),
        ix,
      );
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');

      setTables(prev => prev.filter(t => t.publicKey !== tablePublicKey));
    } catch (e: any) {
      console.error('Failed to close table:', e);
      alert(`Close failed: ${e?.message?.slice(0, 120) || 'Unknown error'}`);
    } finally {
      setClosing(null);
    }
  };

  const cashTables = tables.filter(t => t.gameType === 3);
  const totalRakeEarned = cashTables.reduce((s, t) => s + t.creatorRakeTotal, 0);
  const claimableTables = cashTables.filter(t => (t.rakeAccumulated - t.vaultTotalRakeDistributed) > 0);

  const claimAllRake = async () => {
    if (!publicKey || claimableTables.length === 0) return;
    setClaimingAll(true);
    setClaimStatus(null);
    let claimed = 0;
    try {
      for (const table of claimableTables) {
        try {
          // Server-side atomic: L1 distribute + ER clear (nonce-guarded)
          // API auto-detects SOL vs SPL from table data and uses the correct instruction.
          // Permissionless — creator wallet receives 45% regardless of caller (5% to dealers).
          const res = await fetch('/api/cash-game/clear-rake', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tablePda: table.publicKey }),
          });
          const result = await res.json();
          if (!result.success && result.error) {
            throw new Error(result.error);
          }
          claimed++;
        } catch (e: any) {
          console.error(`Claim failed for ${table.publicKey.slice(0, 8)}:`, e?.message?.slice(0, 120));
        }
      }
      setClaimStatus(`Claimed from ${claimed}/${claimableTables.length} tables`);
      fetchMyTables();
    } catch (e: any) {
      setClaimStatus(`Error: ${e?.message?.slice(0, 80)}`);
    } finally {
      setClaimingAll(false);
    }
  };

  const totalHands = tables.reduce((s, t) => s + t.handNumber, 0);
  const activeTables = tables.length;

  return (
    <main className="min-h-screen bg-gray-950">

      <div className="max-w-5xl mx-auto px-3 sm:px-4 py-6 sm:py-8 pb-16">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Manage Tables</h1>
            <p className="text-xs sm:text-sm text-gray-500 mt-0.5">Create &amp; manage cash game tables &middot; earn 45% of rake</p>
          </div>
          <Link
            href="/my-tables/create"
            className="px-3 sm:px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 text-gray-950 text-xs sm:text-sm font-bold transition-all whitespace-nowrap"
          >
            + Create
          </Link>
        </div>

        {/* Incomplete table setup banner */}
        {incompleteTable && connected && !loading && (
          <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <div className="text-amber-400 text-sm font-medium mb-1">Incomplete table setup detected</div>
            <p className="text-gray-400 text-xs mb-2">
              A table was partially created ({incompleteTable.step}) but setup wasn&apos;t finished.
              <span className="font-mono text-gray-500 ml-1">{incompleteTable.tablePda.slice(0, 12)}...</span>
            </p>
            <div className="flex gap-2">
              <Link
                href="/my-tables/create"
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors"
              >
                Resume Setup
              </Link>
              <button
                onClick={() => {
                  if (publicKey) {
                    localStorage.removeItem(`create-table-${publicKey.toBase58()}`);
                    setIncompleteTable(null);
                  }
                }}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-white/[0.04] text-gray-400 hover:bg-white/[0.08] transition-colors"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Content */}
          <>
            {!connected ? (
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-16 text-center">
                <p className="text-gray-400 mb-4 text-sm">Connect your wallet to view and manage your tables</p>
                <WalletMultiButton />
              </div>
            ) : loading ? (
              <>
                {/* Skeleton stats */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                  {[1, 2, 3, 4].map(i => (
                    <div key={i} className="bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 sm:px-4 py-3 animate-pulse">
                      <div className="h-2 w-16 bg-white/[0.06] rounded mb-2" />
                      <div className="h-5 w-10 bg-white/[0.06] rounded" />
                    </div>
                  ))}
                </div>
                {/* Table loading */}
                <div className="text-center py-12 border border-white/[0.04] rounded-xl">
                  <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin mx-auto mb-3" />
                  <div className="text-gray-500 text-sm">Loading your tables...</div>
                </div>
              </>
            ) : (
              <>
                {/* Stats Bar */}
                {tables.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 sm:px-4 py-3">
                      <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wider">Tables</div>
                      <div className="text-lg font-bold text-white mt-0.5">{tables.length}</div>
                      <div className="text-[10px] text-gray-600">{activeTables} live{tables.length !== cashTables.length ? ` · ${cashTables.length} cash · ${tables.length - cashTables.length} SNG` : ''}</div>
                    </div>
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 sm:px-4 py-3">
                      <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wider">Total Hands</div>
                      <div className="text-lg font-bold text-white mt-0.5">{totalHands.toLocaleString()}</div>
                      <div className="text-[10px] text-gray-600">{tables.reduce((s, t) => s + t.currentPlayers, 0)} players now</div>
                    </div>
                    <div className="bg-emerald-500/[0.08] border border-emerald-500/[0.15] rounded-lg px-3 sm:px-4 py-3">
                      <div className="text-[10px] sm:text-xs text-emerald-400/60 uppercase tracking-wider" title="45% of 5% pot rake (5% goes to dealers)">Rake Earned (45%)</div>
                      <div className="flex items-center justify-between mt-0.5">
                        <div className="text-lg font-bold text-emerald-400">
                          {totalRakeEarned > 0 ? formatTokenAmount(totalRakeEarned) : '0'}
                        </div>
                      </div>
                      {claimStatus && <div className="text-[10px] text-emerald-300 mt-1">{claimStatus}</div>}
                    </div>
                    <div className="bg-amber-500/[0.06] border border-amber-500/[0.15] rounded-lg px-3 sm:px-4 py-3">
                      <div className="text-[10px] sm:text-xs text-amber-400/60 uppercase tracking-wider">Pending Rake</div>
                      <div className="text-lg font-bold text-amber-400 mt-0.5">
                        {claimableTables.length > 0 ? formatTokenAmount(claimableTables.reduce((s, t) => s + Math.max(0, t.rakeAccumulated - t.vaultTotalRakeDistributed), 0)) : '0'}
                      </div>
                      {claimableTables.length > 0 && (
                        <button
                          onClick={claimAllRake}
                          disabled={claimingAll}
                          className="mt-1 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/25 text-amber-400 text-[10px] font-bold hover:bg-amber-500/25 transition-colors disabled:opacity-40"
                        >
                          {claimingAll ? 'Claiming...' : `Claim (${claimableTables.length})`}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {cashTables.length === 0 ? (
                  <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-16 text-center">
                    <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center mx-auto mb-4">
                      <span className="text-cyan-400 text-xl">+</span>
                    </div>
                    <h3 className="text-lg font-bold text-white mb-1">No Tables Yet</h3>
                    <p className="text-gray-500 text-sm mb-6">Create a cash game table and earn 45% of every pot&apos;s rake</p>
                    <Link
                      href="/my-tables/create"
                      className="inline-block px-5 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 text-gray-950 text-sm font-bold transition-all"
                    >
                      Create Your First Table
                    </Link>
                  </div>
                ) : (
                  <>
                    {cashTables.length > 0 && (
                      <div className="mb-8">
                        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Cash Game Tables</h2>
                        <div className="space-y-3">
                          {cashTables.map(table => (
                            <TableCard key={table.publicKey} table={table} onCopyLink={copyLink} copiedLink={copiedLink} onClose={closeTable} closing={closing === table.publicKey} />
                          ))}
                        </div>
                      </div>
                    )}

                  </>
                )}
              </>
            )}
          </>
      </div>
    </main>
  );
}

function TableCard({ table, onCopyLink, copiedLink, onClose, closing }: {
  table: CashTableInfo;
  onCopyLink: (pk: string) => void;
  copiedLink: string | null;
  onClose?: (pk: string) => void;
  closing?: boolean;
}) {
  const isCash = table.gameType === 3;
  const phaseName = PHASE_LABELS[table.phase] || 'Unknown';
  const isActive = table.phase >= 2 && table.phase <= 6;
  const symbol = getTokenSymbol(table.tokenMint);
  const blindsLabel = `${formatTokenAmount(table.smallBlind)}/${formatTokenAmount(table.bigBlind)} ${symbol}`;

  return (
    <div className={`bg-white/[0.03] border rounded-xl p-4 transition-colors ${table.broken ? 'border-red-500/20 opacity-60' : table.zombie ? 'border-red-500/20' : 'border-white/[0.06] hover:border-white/[0.1]'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          {/* Type Badge */}
          <div className="shrink-0 w-10 h-10 rounded-lg flex items-center justify-center overflow-hidden bg-white/[0.04] border border-white/[0.08]">
            <img src={getTokenImage(table.tokenMint)} alt={symbol} className="w-8 h-8" />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">
                {isCash ? 'Cash' : GAME_TYPE_LABELS[table.gameType]} &middot; {blindsLabel}
              </span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                phaseName === 'Waiting' ? 'bg-gray-500/15 text-gray-400' :
                phaseName === 'Complete' ? 'bg-purple-500/15 text-purple-400' :
                isActive ? 'bg-emerald-500/15 text-emerald-400' :
                'bg-amber-500/15 text-amber-400'
              }`}>
                {phaseName}
              </span>
              {isCash && (
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${table.buyInType === 1 ? 'bg-amber-500/15 text-amber-400' : 'bg-gray-500/15 text-gray-400'}`}>{table.buyInType === 1 ? 'Deep' : 'Normal'}</span>
              )}
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-cyan-500/15 text-cyan-400">L1</span>
              {table.isPrivate && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-500/15 text-purple-400">Private</span>
              )}
              {table.broken && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/30">ORPHANED</span>
              )}
              {table.zombie && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/30">ZOMBIE</span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-500">
              <span>{table.maxPlayers}-max</span>
              <span>{table.currentPlayers}/{table.maxPlayers} players</span>
              <span>Hand #{table.handNumber}</span>
              {isCash && (() => {
                const pending = Math.max(0, table.rakeAccumulated - table.vaultTotalRakeDistributed);
                return pending > 0
                  ? <span className="text-amber-400">Pending Rake: {formatTokenAmount(pending)}</span>
                  : table.rakeAccumulated > 0
                    ? <span className="text-emerald-500">Rake Claimed: {formatTokenAmount(table.vaultTotalRakeDistributed)}</span>
                    : null;
              })()}
              <span className="font-mono">{table.publicKey.slice(0, 8)}...</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-3">
          {/* Recover — zombie tables need undelegate + fresh re-delegation */}
          {table.zombie && isCash && (
            <Link
              href={`/my-tables/create?resume=${table.publicKey}`}
              className="px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 text-red-400 text-xs font-medium transition-colors"
            >
              Recover
            </Link>
          )}
          {/* Whitelist — private tables only */}
          {table.isPrivate && isCash && (
            <Link
              href={`/my-tables/${table.publicKey}/whitelist`}
              className="px-2.5 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/20 hover:bg-purple-500/20 text-purple-400 text-xs font-medium transition-colors"
            >
              Whitelist
            </Link>
          )}
          {/* Close button — empty tables in Waiting/Complete */}
          {onClose && table.currentPlayers === 0 && (
            table.phase === 0 || table.phase === 7
          ) && (
            <button
              onClick={() => onClose(table.publicKey)}
              disabled={closing}
              className={`px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                closing
                  ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                  : 'bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 text-red-400'
              }`}
            >
              {closing ? 'Closing...' : 'Close'}
            </button>
          )}
          <button
            onClick={() => onCopyLink(table.publicKey)}
            className="px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08] text-gray-400 text-xs transition-colors"
          >
            {copiedLink === table.publicKey ? 'Copied!' : 'Share'}
          </button>
          <Link
            href={`/game/${table.publicKey}`}
            className="px-3 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20 hover:bg-cyan-500/20 text-cyan-400 text-xs font-medium transition-colors"
          >
            Open
          </Link>
        </div>
      </div>
    </div>
  );
}
