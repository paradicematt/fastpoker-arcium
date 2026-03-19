'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as crypto from 'crypto';
import Link from 'next/link';
import { L1_RPC, ANCHOR_PROGRAM_ID, POKER_MINT } from '@/lib/constants';

const PROGRAM_ID = new PublicKey(ANCHOR_PROGRAM_ID);
const CRANK_OPERATOR_SEED = Buffer.from('crank');
const SOL_DEFAULT = PublicKey.default.toBase58();

interface TokenRakeEntry {
  mint: string;
  symbol: string;
  decimals: number;
  totalRake: number;
  dealerCut: number;
  tableCount: number;
  vaultBalance: number;
  vaultDeposited: number;
  vaultWithdrawn: number;
  vaultRakeDistributed: number;
  vaultCrankDistributed: number;
}

function resolveTokenSymbol(mint: string): { symbol: string; decimals: number } {
  if (mint === SOL_DEFAULT || !mint) return { symbol: 'SOL', decimals: 9 };
  if (mint === POKER_MINT.toBase58()) return { symbol: 'POKER', decimals: 9 };
  // Shorten unknown mints for display
  return { symbol: mint.slice(0, 6) + '…', decimals: 9 };
}

function getCrankOperatorPda(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CRANK_OPERATOR_SEED, authority.toBuffer()],
    PROGRAM_ID,
  );
}

// Discriminators
const REGISTER_DISC = crypto.createHash('sha256').update('global:register_crank_operator').digest().slice(0, 8);
const UPDATE_DISC = crypto.createHash('sha256').update('global:update_crank_operator').digest().slice(0, 8);

const CRANK_MODES = [
  { value: 0, label: 'Accept All', desc: 'Earn from all tables (rake + tips)', onClass: 'bg-cyan-500/10 border-cyan-500/20 text-cyan-400' },
  { value: 1, label: 'SOL Only', desc: 'Only operate SOL-denominated tables', onClass: 'bg-blue-500/10 border-blue-500/20 text-blue-400' },
  { value: 2, label: 'Tips Only', desc: 'Only accept tip rewards (no rake cut)', onClass: 'bg-amber-500/10 border-amber-500/20 text-amber-400' },
  { value: 3, label: 'Rake Only', desc: 'Only accept rake cut (no tips)', onClass: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' },
  { value: 4, label: 'Listed Tokens', desc: 'Only operate auction-listed token tables', onClass: 'bg-purple-500/10 border-purple-500/20 text-purple-400' },
  { value: 5, label: 'Free (Community)', desc: 'Run tables for free — community service', onClass: 'bg-gray-500/10 border-gray-500/20 text-gray-400' },
];

interface OperatorState {
  authority: string;
  mode: number;
  rakeDistInterval: number;
  lifetimeActions: number;
  lifetimeSolEarned: number;
  lifetimeTokenEarned: number;
  registeredAt: number;
}

function formatSol(lamports: number): string {
  if (lamports === 0) return '0';
  return (lamports / 1e9).toFixed(6);
}

function formatDate(ts: number): string {
  if (ts === 0) return 'N/A';
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Shared UI Components (matching admin CrankDashboard style) ───
function Panel({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <h3 className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Row({ k, v, vc }: { k: string; v: string | number; vc?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{k}</span>
      <span className={vc || 'text-gray-300'}>{String(v)}</span>
    </div>
  );
}

function MiniStatCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="text-center bg-white/[0.02] rounded-lg border border-white/[0.04] py-2 px-1">
      <div className={`text-sm font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-[9px] text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}

export default function DealerPage() {
  const { publicKey, signTransaction } = useWallet();
  const [operator, setOperator] = useState<OperatorState | null>(null);
  const [crankPubkey, setCrankPubkey] = useState<string | null>(null);
  const [crankPda, setCrankPda] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [selectedMode, setSelectedMode] = useState(0);
  const [rakeInterval, setRakeInterval] = useState('0');
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [crankData, setCrankData] = useState<any>(null);
  const [crankMetrics, setCrankMetrics] = useState<any>(null);
  const [crankAction, setCrankAction] = useState<string | null>(null);
  const [crankCmdResult, setCrankCmdResult] = useState<string | null>(null);
  const [pendingCrankPool, setPendingCrankPool] = useState<{ total: number; totalRake: number; tableCount: number }>({ total: 0, totalRake: 0, tableCount: 0 });
  const [tokenRakeBreakdown, setTokenRakeBreakdown] = useState<TokenRakeEntry[]>([]);
  const [claiming, setClaiming] = useState(false);
  const [claimResult, setClaimResult] = useState<{ msg: string; ok: boolean } | null>(null);
  const [walletSol, setWalletSol] = useState<number>(0);
  const [splBalances, setSplBalances] = useState<{ mint: string; symbol: string; balance: number; decimals: number }[]>([]);

  // Fetch operator from server-side API (reads crank keypair from disk — no wallet needed)
  const fetchOperator = useCallback(async () => {
    try {
      const resp = await fetch('/api/admin/crank-operator');
      if (!resp.ok) { setOperator(null); setLoading(false); return; }
      const data = await resp.json();
      setCrankPubkey(data.pubkey || null);
      setCrankPda(data.pda || null);
      setWalletSol(data.solBalance || 0);
      if (data.registered && data.operator) {
        setOperator(data.operator);
        setSelectedMode(data.operator.mode);
        setRakeInterval((data.operator.rakeDistInterval || 0).toString());
      } else {
        setOperator(null);
      }
    } catch (e) {
      console.error('Failed to fetch operator:', e);
      setOperator(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchOperator(); }, [fetchOperator]);
  useEffect(() => {
    const iv = setInterval(fetchOperator, 15000);
    return () => clearInterval(iv);
  }, [fetchOperator]);

  // Fetch crank operational data + logs
  const fetchCrankOps = useCallback(async () => {
    try {
      const [crankResp, statusResp] = await Promise.all([
        fetch('/api/admin/crank').catch(() => null),
        fetch('/api/admin/status').catch(() => null),
      ]);
      if (crankResp?.ok) {
        const json = await crankResp.json();
        setCrankData(json);
      }
      if (statusResp?.ok) {
        const s = await statusResp.json();
        if (s.crank) setCrankMetrics(s.crank);
        const allTables = [...(s.tables?.er || []), ...(s.tables?.l1 || [])];
        const cashTables = allTables.filter((t: any) => t.gameType === 3);

        // Group by tokenMint for per-token breakdown
        const byMint = new Map<string, { rake: number; pool: number; count: number; vBal: number; vDep: number; vWith: number; vRakeDist: number; vCrankDist: number }>();
        for (const t of cashTables) {
          const mint = t.tokenMint || SOL_DEFAULT;
          const entry = byMint.get(mint) || { rake: 0, pool: 0, count: 0, vBal: 0, vDep: 0, vWith: 0, vRakeDist: 0, vCrankDist: 0 };
          entry.rake += t.rakeAccumulated || 0;
          entry.pool += t.crankPoolAccumulated || 0;
          entry.count += 1;
          entry.vBal += t.vaultLamports || 0;
          entry.vDep += t.vaultTotalDeposited || 0;
          entry.vWith += t.vaultTotalWithdrawn || 0;
          entry.vRakeDist += t.vaultTotalRakeDistributed || 0;
          entry.vCrankDist += t.vaultCrankDistributed || 0;
          byMint.set(mint, entry);
        }

        const breakdown: TokenRakeEntry[] = [];
        let totalPool = 0;
        let totalRake = 0;
        Array.from(byMint.entries()).forEach(([mint, e]) => {
          const { symbol, decimals } = resolveTokenSymbol(mint);
          breakdown.push({
            mint, symbol, decimals,
            totalRake: e.rake, dealerCut: e.pool, tableCount: e.count,
            vaultBalance: e.vBal, vaultDeposited: e.vDep, vaultWithdrawn: e.vWith,
            vaultRakeDistributed: e.vRakeDist, vaultCrankDistributed: e.vCrankDist,
          });
          totalPool += e.pool;
          totalRake += e.rake;
        });
        // Sort: SOL first, then by totalRake descending
        breakdown.sort((a, b) => {
          if (a.mint === SOL_DEFAULT) return -1;
          if (b.mint === SOL_DEFAULT) return 1;
          return b.totalRake - a.totalRake;
        });
        setTokenRakeBreakdown(breakdown);
        setPendingCrankPool({ total: totalPool, totalRake, tableCount: cashTables.length });
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchCrankOps();
    const iv = setInterval(fetchCrankOps, 5000);
    return () => clearInterval(iv);
  }, [fetchCrankOps]);

  // Fetch crank wallet SOL balance + SPL token accounts
  const fetchBalances = useCallback(async () => {
    if (!crankPubkey) return;
    try {
      const conn = new Connection(L1_RPC, 'confirmed');
      const pk = new PublicKey(crankPubkey);
      const sol = await conn.getBalance(pk);
      setWalletSol(sol);
      const tokenAccts = await conn.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_PROGRAM_ID });
      const balances = tokenAccts.value
        .map(({ account }) => {
          const p = account.data.parsed?.info;
          if (!p) return null;
          const bal = Number(p.tokenAmount?.amount || 0);
          if (bal === 0) return null;
          const mint = p.mint as string;
          const decimals = p.tokenAmount?.decimals || 0;
          let symbol = mint.slice(0, 6) + '...';
          if (mint === POKER_MINT.toBase58()) symbol = 'POKER';
          return { mint, symbol, balance: bal, decimals };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null);
      setSplBalances(balances);
    } catch {}
  }, [crankPubkey]);

  useEffect(() => {
    if (!operator) return;
    fetchBalances();
    const iv = setInterval(fetchBalances, 15000);
    return () => clearInterval(iv);
  }, [operator, fetchBalances]);

  const register = async () => {
    if (!publicKey || !signTransaction) return;
    setRegistering(true);
    try {
      const conn = new Connection(L1_RPC, 'confirmed');
      const [pda] = getCrankOperatorPda(publicKey);
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: pda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: REGISTER_DISC,
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const signed = await signTransaction(tx);
      const sig = await conn.sendRawTransaction(signed.serialize());
      await conn.confirmTransaction(sig, 'confirmed');
      setToast({ msg: 'Registered as Dealer!', type: 'success' });
      await fetchOperator();
    } catch (e: any) {
      console.error('Register failed:', e);
      setToast({ msg: `Registration failed: ${e?.message?.slice(0, 100)}`, type: 'error' });
    }
    setRegistering(false);
  };

  const updateMode = async () => {
    if (!operator) return;
    if (!publicKey || !signTransaction) {
      setToast({ msg: 'Connect your wallet to update settings (must match the wallet that registered)', type: 'error' });
      return;
    }
    setUpdating(true);
    try {
      const conn = new Connection(L1_RPC, 'confirmed');
      const [pda] = getCrankOperatorPda(publicKey);
      const data = Buffer.alloc(8 + 1 + 8);
      UPDATE_DISC.copy(data);
      data[8] = selectedMode;
      data.writeBigUInt64LE(BigInt(parseInt(rakeInterval) || 0), 9);
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: false },
          { pubkey: pda, isSigner: false, isWritable: true },
        ],
        data,
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const signed = await signTransaction(tx);
      const sig = await conn.sendRawTransaction(signed.serialize());
      await conn.confirmTransaction(sig, 'confirmed');
      setToast({ msg: 'Dealer settings updated!', type: 'success' });
      await fetchOperator();
    } catch (e: any) {
      console.error('Update failed:', e);
      setToast({ msg: `Update failed: ${e?.message?.slice(0, 100)}`, type: 'error' });
    }
    setUpdating(false);
  };

  const claimRewards = async () => {
    setClaiming(true);
    setClaimResult(null);
    try {
      const resp = await fetch('/api/admin/claim-rewards', { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok) {
        setClaimResult({ msg: data.error || 'Claim failed', ok: false });
      } else {
        const distributed = data.distributed || 0;
        const total = data.tables?.length || 0;
        if (distributed > 0) {
          setClaimResult({ msg: `Distributed rewards from ${distributed}/${total} table(s)`, ok: true });
        } else {
          setClaimResult({ msg: data.message || 'No rewards to distribute', ok: true });
        }
        await fetchOperator();
        await fetchBalances();
      }
    } catch (e: any) {
      setClaimResult({ msg: e.message || 'Claim failed', ok: false });
    }
    setClaiming(false);
  };

  // Crank service control
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
        setCrankCmdResult(`\u274C ${action} failed: ${result.error}`);
      } else {
        setCrankCmdResult(`\u2705 ${result.message}`);
        if (action === 'start') {
          setTimeout(fetchCrankOps, 5000);
          setTimeout(fetchCrankOps, 10000);
          setTimeout(fetchCrankOps, 15000);
        } else {
          setTimeout(fetchCrankOps, 3000);
        }
      }
    } catch (e: any) {
      setCrankCmdResult(`\u274C ${action} error: ${e.message}`);
    } finally {
      setCrankAction(null);
    }
  }, [fetchCrankOps]);

  const isOnline = crankData?.status === 'online';
  const hb = crankData?.heartbeat;

  // Computed revenue stats
  const netProfit = operator && crankMetrics?.totals?.totalCostLamports
    ? operator.lifetimeSolEarned - crankMetrics.totals.totalCostLamports
    : 0;
  const uptimeHours = operator?.registeredAt
    ? Math.max(1, (Date.now() / 1000 - operator.registeredAt) / 3600)
    : 1;

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl border shadow-lg max-w-sm ${
          toast.type === 'success' ? 'bg-emerald-900/80 border-emerald-500/30 text-emerald-200' : 'bg-red-900/80 border-red-500/30 text-red-200'
        }`}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">{toast.msg}</span>
            <button onClick={() => setToast(null)} className="text-white/50 hover:text-white">&#10005;</button>
          </div>
        </div>
      )}

      {/* Dealer License Banner */}
      <div className="max-w-5xl mx-auto px-4 pt-4">
        <Link href="/dealer/license"
          className="block rounded-xl border border-cyan-500/20 bg-gradient-to-r from-cyan-500/[0.06] to-emerald-500/[0.04] p-3 hover:border-cyan-500/30 transition-colors group">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-lg">&#127183;</span>
              <div>
                <span className="text-sm font-medium text-cyan-400 group-hover:text-cyan-300">Dealer License</span>
                <span className="text-xs text-gray-500 ml-2">Purchase a license to earn rake &amp; SNG fees</span>
              </div>
            </div>
            <span className="text-gray-500 group-hover:text-gray-300 text-xs">&rarr;</span>
          </div>
        </Link>
      </div>

      {loading ? (
        <div className="text-center py-24 text-gray-500">Loading dealer status...</div>
      ) : !operator && !crankPubkey ? (
        /* ═══ No Crank Keypair ═══ */
        <div className="max-w-3xl mx-auto px-6 py-12 text-center">
          <div className="text-6xl mb-4">🃏</div>
          <h2 className="text-2xl font-bold mb-2">No Crank Keypair Found</h2>
          <p className="text-gray-400 mb-6 max-w-md mx-auto">
            Set <code className="text-cyan-400">crank_keypair_path</code> in your crank-config.json,
            or place a keypair at <code className="text-cyan-400">contracts/auth/deployers/crank-keypair.json</code>.
          </p>
          <div className="grid grid-cols-3 gap-4 max-w-lg mx-auto mb-8">
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 text-center">
              <div className="text-cyan-400 text-2xl font-bold">5%</div>
              <div className="text-gray-500 text-xs mt-1">of Rake</div>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 text-center">
              <div className="text-amber-400 text-2xl font-bold">2&times;</div>
              <div className="text-gray-500 text-xs mt-1">L1 Actions Weight</div>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 text-center">
              <div className="text-emerald-400 text-2xl font-bold">Tips</div>
              <div className="text-gray-500 text-xs mt-1">From Players</div>
            </div>
          </div>
        </div>
      ) : !operator ? (
        /* ═══ Not Registered ═══ */
        <div className="max-w-3xl mx-auto px-6 py-12 space-y-6">
          <div className="bg-gradient-to-br from-cyan-500/[0.08] to-blue-500/[0.04] border border-cyan-500/20 rounded-2xl p-8 text-center">
            <div className="text-5xl mb-4">🃏</div>
            <h2 className="text-2xl font-bold mb-2">Become a Dealer</h2>
            <p className="text-gray-400 mb-6 max-w-lg mx-auto">
              Register as a Dealer to start earning rewards. Your crank service will operate poker tables,
              dealing cards, processing actions, and settling hands. You earn a share of every pot&apos;s rake
              proportional to your actions.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl mx-auto mb-8">
              <div className="bg-black/30 border border-white/[0.06] rounded-xl p-5">
                <div className="text-cyan-400 font-bold text-lg mb-1">Rake Cut</div>
                <div className="text-gray-400 text-sm">5% of the 5% pot rake goes to active dealers, weighted by actions performed.</div>
              </div>
              <div className="bg-black/30 border border-white/[0.06] rounded-xl p-5">
                <div className="text-amber-400 font-bold text-lg mb-1">Player Tips</div>
                <div className="text-gray-400 text-sm">Players can tip the dealer directly via the Tip Jar on each table.</div>
              </div>
              <div className="bg-black/30 border border-white/[0.06] rounded-xl p-5">
                <div className="text-emerald-400 font-bold text-lg mb-1">Permissionless</div>
                <div className="text-gray-400 text-sm">Anyone can run a dealer node. No approval needed. Just register and start.</div>
              </div>
            </div>
            <button
              onClick={register}
              disabled={registering}
              className="px-8 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {registering ? 'Registering...' : 'Register as Dealer'}
            </button>
            <p className="text-gray-600 text-xs mt-3">Costs ~0.002 SOL for PDA rent (refundable)</p>
          </div>
        </div>
      ) : (
        /* ═══ Registered — Full Dashboard (matches admin CrankDashboard layout) ═══ */
        <div className="max-w-[1400px] mx-auto px-6 py-6 space-y-5">
          {/* ─── Status Banner ─── */}
          <div className={`rounded-xl border p-5 ${isOnline ? 'border-emerald-500/30 bg-emerald-500/[0.04]' : 'border-red-500/30 bg-red-500/[0.04]'}`}>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div className={`w-4 h-4 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'}`} />
                <div>
                  <h2 className={`text-lg font-bold ${isOnline ? 'text-emerald-400' : 'text-red-400'}`}>
                    <span className="text-cyan-400">Dealer</span> Service — {isOnline ? 'Online' : 'Offline'}
                  </h2>
                  {hb && (
                    <div className="flex flex-wrap gap-x-4 text-xs text-gray-500 mt-0.5 font-mono">
                      <span>PID: {hb.pid}</span>
                      <span>Uptime: {hb.uptime || '—'}</span>
                      <span>HB: {hb.heartbeatAge}s ago</span>
                      <span>Tracked: {hb.tablesTracked ?? '—'} / Processing: {hb.tablesProcessing ?? '—'}</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                {isOnline ? (
                  <>
                    <button onClick={() => sendCrankCommand('restart')} disabled={!!crankAction}
                      className="px-4 py-2 rounded-lg border text-xs font-medium bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20 disabled:opacity-40 transition-colors">
                      {crankAction === 'restart' ? 'Restarting...' : 'Restart'}
                    </button>
                    <button onClick={() => sendCrankCommand('stop')} disabled={!!crankAction}
                      className="px-4 py-2 rounded-lg border text-xs font-medium bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20 disabled:opacity-40 transition-colors">
                      {crankAction === 'stop' ? 'Stopping...' : 'Stop'}
                    </button>
                  </>
                ) : (
                  <button onClick={() => sendCrankCommand('start')} disabled={!!crankAction}
                    className="px-5 py-2 rounded-lg border text-sm font-medium bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-40 transition-colors">
                    {crankAction === 'start' ? 'Starting...' : 'Start Crank'}
                  </button>
                )}
                <button onClick={fetchCrankOps}
                  className="px-3 py-2 rounded-lg border text-xs font-medium bg-white/[0.03] border-white/10 text-gray-400 hover:bg-white/[0.06] transition-colors">
                  Refresh
                </button>
              </div>
            </div>
          {crankCmdResult && (
            <div className={`mt-3 text-xs font-mono px-3 py-2 rounded-lg ${crankCmdResult.startsWith('\u2705') ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
              {crankCmdResult}
            </div>
          )}
          </div>

          {/* ─── Two-column layout ─── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

            {/* ═══ Left Column ═══ */}
            <div className="space-y-4">

              {/* Heartbeat */}
              <Panel title="Heartbeat">
                {hb ? (
                  <div className="space-y-1.5 text-xs font-mono">
                    <Row k="Status" v={hb.status || (isOnline ? 'running' : 'offline')} vc={isOnline ? 'text-emerald-400' : 'text-red-400'} />
                    <Row k="PID" v={hb.pid} />
                    <Row k="Started" v={hb.startedAt ? new Date(hb.startedAt).toLocaleString() : '—'} />
                    <Row k="Uptime" v={hb.uptime || '—'} />
                    <Row k="Tables Tracked" v={hb.tablesTracked ?? 0} vc="text-cyan-400" />
                    <Row k="Processing" v={hb.tablesProcessing ?? 0} vc="text-amber-400" />
                    <Row k="Heartbeat Age" v={`${hb.heartbeatAge}s`} />
                  </div>
                ) : (
                  <div className="text-xs text-gray-600 italic">No heartbeat. Start the dealer service to begin monitoring.</div>
                )}
              </Panel>

              {/* Revenue Summary */}
              <Panel title="Revenue Summary">
                <div className="space-y-1.5 text-xs font-mono">
                  <Row k="Lifetime Actions" v={operator.lifetimeActions.toLocaleString()} vc="text-white" />
                  <Row k="SOL Earned" v={`${formatSol(operator.lifetimeSolEarned)} SOL`} vc="text-emerald-400" />
                  <Row k="Token Earned" v={operator.lifetimeTokenEarned.toLocaleString()} vc="text-amber-400" />
                  <Row k="TX Costs" v={`${((crankMetrics?.totals?.totalCostLamports || 0) / 1e9).toFixed(6)} SOL`} vc="text-red-300" />
                  <Row k="Net Profit" v={`${(netProfit / 1e9).toFixed(6)} SOL`} vc={netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'} />
                  <div className="border-t border-white/[0.04] my-1.5" />
                  <Row k="SOL/Hour" v={operator.lifetimeSolEarned > 0 ? `${(operator.lifetimeSolEarned / 1e9 / uptimeHours).toFixed(6)}` : '0'} vc="text-gray-400" />
                  <Row k="SOL/Day" v={operator.lifetimeSolEarned > 0 ? `${(operator.lifetimeSolEarned / 1e9 / (uptimeHours / 24)).toFixed(6)}` : '0'} vc="text-gray-400" />
                  {operator.lifetimeActions > 0 && (
                    <Row k="SOL/Action" v={(operator.lifetimeSolEarned / 1e9 / operator.lifetimeActions).toFixed(8)} vc="text-gray-400" />
                  )}
                  <div className="border-t border-white/[0.04] my-1.5" />
                  <Row k="Registered" v={formatDate(operator.registeredAt)} />
                  <Row k="Mode" v={CRANK_MODES[operator.mode]?.label || 'Unknown'} />
                </div>
              </Panel>

              {/* Dealer Settings */}
              <Panel title="Dealer Settings">
                <div className="text-[9px] text-gray-600 uppercase tracking-wider mb-1.5">Operating Mode</div>
                <div className="space-y-1 mb-3">
                  {CRANK_MODES.map(m => {
                    const active = selectedMode === m.value;
                    return (
                      <button
                        key={m.value}
                        onClick={() => setSelectedMode(m.value)}
                        className={`w-full flex items-center justify-between px-2 py-1 rounded border text-[10px] font-mono transition-colors ${
                          active ? m.onClass : 'bg-gray-800/40 border-gray-700/30 text-gray-600'
                        } hover:opacity-80`}
                      >
                        <span>{m.label}</span>
                        {active && <span className="text-[9px] font-bold text-emerald-400">&#10003;</span>}
                      </button>
                    );
                  })}
                </div>

                <div className="text-[9px] text-gray-600 uppercase tracking-wider mb-1.5 pt-2 border-t border-white/[0.04]">Rake Interval</div>
                <div className="flex items-center gap-2 mb-3">
                  <input
                    type="number"
                    value={rakeInterval}
                    onChange={e => setRakeInterval(e.target.value)}
                    className="flex-1 bg-gray-900 border border-gray-700/40 rounded px-2 py-1 text-[10px] text-gray-300 text-right tabular-nums focus:border-cyan-500/50 focus:outline-none"
                    min="0"
                    step="10"
                  />
                  <span className="text-[9px] text-gray-600">hands (0=manual)</span>
                </div>

                {(selectedMode !== operator.mode || parseInt(rakeInterval) !== operator.rakeDistInterval) && (
                  <button
                    onClick={updateMode}
                    disabled={updating}
                    className="w-full py-1.5 rounded bg-cyan-600/20 border border-cyan-500/30 text-cyan-400 text-[10px] font-medium hover:bg-cyan-600/30 disabled:opacity-40 transition-colors"
                  >
                    {updating ? 'Saving...' : 'Save Settings'}
                  </button>
                )}
              </Panel>

              {/* Wallet / Vault */}
              <Panel title="Wallet &amp; Vault">
                <div className="space-y-1.5 text-xs font-mono">
                  <Row k="SOL Balance" v={`${(walletSol / LAMPORTS_PER_SOL).toFixed(4)} SOL`} vc="text-emerald-400" />
                  <Row k="Pubkey" v={crankPubkey ? crankPubkey.slice(0, 12) + '...' : '—'} />
                  <Row k="PDA" v={crankPda ? crankPda.slice(0, 12) + '...' : '—'} />
                </div>
                {splBalances.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-white/[0.04]">
                    <div className="text-[9px] text-gray-600 uppercase tracking-wider mb-1.5">SPL Tokens</div>
                    <div className="space-y-1">
                      {splBalances.map(t => (
                        <div key={t.mint} className="flex justify-between text-[10px] font-mono px-2 py-0.5 rounded bg-white/[0.02]">
                          <span className="text-gray-400">{t.symbol}</span>
                          <span className="text-gray-300">{(t.balance / 10 ** t.decimals).toFixed(Math.min(t.decimals, 4))}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Panel>
            </div>

            {/* ═══ Right Column ═══ */}
            <div className="lg:col-span-2 space-y-4">

              {/* Revenue Stats (top cards) */}
              <Panel title="Revenue &amp; Crank Stats">
                <div className="grid grid-cols-4 gap-3 mb-3">
                  <MiniStatCard label="SOL Earned" value={formatSol(operator.lifetimeSolEarned)} color="text-emerald-400" />
                  <MiniStatCard label="Lifetime Actions" value={operator.lifetimeActions.toLocaleString()} color="text-white" />
                  <MiniStatCard
                    label="TX Cost"
                    value={`${((crankMetrics?.totals?.totalCostLamports || 0) / 1e9).toFixed(6)} SOL`}
                    color="text-red-300"
                  />
                  <MiniStatCard
                    label="Net Profit"
                    value={`${(netProfit / 1e9).toFixed(6)} SOL`}
                    color={netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}
                  />
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <MiniStatCard label="Total TXs" value={crankMetrics?.totals?.totalCranks?.toLocaleString() || '0'} color="text-white" />
                  <MiniStatCard label="ER TXs" value={crankMetrics?.totals?.erCranks?.toLocaleString() || '0'} color="text-cyan-400" />
                  <MiniStatCard label="L1 TXs" value={crankMetrics?.totals?.l1Cranks?.toLocaleString() || '0'} color="text-amber-400" />
                  <MiniStatCard
                    label="Pending Pool"
                    value={`${tokenRakeBreakdown.length} token${tokenRakeBreakdown.length !== 1 ? 's' : ''}`}
                    color="text-cyan-400"
                  />
                </div>
                {/* byLabel breakdown */}
                {crankMetrics?.byLabel && Object.keys(crankMetrics.byLabel).length > 0 && (
                  <details className="mt-3">
                    <summary className="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300 mb-2">
                      {Object.keys(crankMetrics.byLabel).length} action types
                    </summary>
                    <div className="grid grid-cols-2 gap-1 max-h-48 overflow-y-auto">
                      {Object.entries(crankMetrics.byLabel)
                        .sort((a: any, b: any) => (b[1].count || 0) - (a[1].count || 0))
                        .map(([label, info]: [string, any]) => (
                          <div key={label} className="flex justify-between text-[9px] font-mono px-2 py-0.5 rounded bg-white/[0.02]">
                            <span className="text-gray-400 truncate mr-2">{label}</span>
                            <span className="text-gray-300 shrink-0">{info.count}x {info.chain === 'L1' ? '(L1)' : ''}</span>
                          </div>
                        ))}
                    </div>
                  </details>
                )}
              </Panel>

              {/* Vault & Rake Revenue (per-token breakdown) */}
              <Panel title={<>Dealer Revenue <span className="text-emerald-400 normal-case ml-1">{pendingCrankPool.tableCount} cash tables</span></>}>
                {/* Summary row */}
                {(() => {
                  const totalDealerCut = tokenRakeBreakdown.reduce((s, tk) => s + tk.dealerCut / (10 ** tk.decimals), 0);
                  const totalClaimed = tokenRakeBreakdown.reduce((s, tk) => s + tk.vaultCrankDistributed / (10 ** tk.decimals), 0);
                  const totalUnclaimed = tokenRakeBreakdown.reduce((s, tk) => s + Math.max(0, tk.dealerCut - tk.vaultCrankDistributed) / (10 ** tk.decimals), 0);
                  return (
                    <div className="grid grid-cols-4 gap-3 mb-3">
                      <div className="bg-white/[0.02] rounded-lg border border-cyan-500/10 p-2.5">
                        <div className="text-[9px] text-gray-500 uppercase">Total Dealer 5%</div>
                        <div className="text-sm font-bold text-cyan-400 tabular-nums">{totalDealerCut.toFixed(6)}</div>
                        <div className="text-[9px] text-gray-600">all tokens (native)</div>
                      </div>
                      <div className="bg-white/[0.02] rounded-lg border border-emerald-500/10 p-2.5">
                        <div className="text-[9px] text-gray-500 uppercase">Claimed</div>
                        <div className="text-sm font-bold text-emerald-400 tabular-nums">{totalClaimed.toFixed(6)}</div>
                        <div className="text-[9px] text-gray-600">distributed to wallet</div>
                      </div>
                      <div className="bg-white/[0.02] rounded-lg border border-amber-500/10 p-2.5">
                        <div className="text-[9px] text-gray-500 uppercase">Unclaimed</div>
                        <div className="text-sm font-bold text-amber-400 tabular-nums">{totalUnclaimed.toFixed(6)}</div>
                        <div className="text-[9px] text-gray-600">pending in vaults</div>
                      </div>
                      <div className="bg-white/[0.02] rounded-lg border border-white/[0.04] p-2.5">
                        <div className="text-[9px] text-gray-500 uppercase">Token Types</div>
                        <div className="text-sm font-bold text-white tabular-nums">{tokenRakeBreakdown.length}</div>
                        <div className="text-[9px] text-gray-600">{pendingCrankPool.tableCount} tables</div>
                      </div>
                    </div>
                  );
                })()}

                {/* Per-token breakdown */}
                {tokenRakeBreakdown.length > 0 ? (
                  <div className="space-y-2">
                    {tokenRakeBreakdown.map(tk => {
                      const div = 10 ** tk.decimals;
                      const prec = Math.min(tk.decimals, 6);
                      const cutUi = (tk.dealerCut / div).toFixed(prec);
                      const claimedRaw = tk.vaultCrankDistributed;
                      const unclaimedRaw = Math.max(0, tk.dealerCut - claimedRaw);
                      const claimedUi = (claimedRaw / div).toFixed(prec);
                      const unclaimedUi = (unclaimedRaw / div).toFixed(prec);
                      const rakeUi = (tk.totalRake / div).toFixed(prec);
                      const isSol = tk.mint === SOL_DEFAULT;
                      const accentBorder = isSol ? 'border-emerald-500/20' : 'border-purple-500/20';
                      const accentText = isSol ? 'text-emerald-400' : 'text-purple-400';
                      return (
                        <div key={tk.mint} className={`rounded-lg border ${accentBorder} bg-white/[0.02] p-3`}>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className={`text-xs font-bold ${accentText}`}>{tk.symbol}</span>
                              <span className="text-[9px] text-gray-600">{tk.tableCount} table{tk.tableCount !== 1 ? 's' : ''}</span>
                              {!isSol && (
                                <span className="text-[8px] text-gray-700 font-mono">{tk.mint.slice(0, 8)}&hellip;</span>
                              )}
                            </div>
                            {unclaimedRaw > 0 && (
                              <span className="text-[8px] font-medium text-amber-400 bg-amber-500/10 rounded px-1.5 py-0.5">unclaimed</span>
                            )}
                          </div>
                          <div className="grid grid-cols-4 gap-2">
                            <div>
                              <div className="text-[8px] text-gray-600 uppercase">Rake Accum.</div>
                              <div className="text-[11px] font-bold text-white/60 tabular-nums">{rakeUi}</div>
                            </div>
                            <div>
                              <div className="text-[8px] text-gray-600 uppercase">Dealer 5%</div>
                              <div className="text-[11px] font-bold text-cyan-400 tabular-nums">{cutUi}</div>
                            </div>
                            <div>
                              <div className="text-[8px] text-gray-600 uppercase">Claimed</div>
                              <div className="text-[11px] font-bold text-emerald-400 tabular-nums">{claimedUi}</div>
                            </div>
                            <div>
                              <div className="text-[8px] text-gray-600 uppercase">Unclaimed</div>
                              <div className={`text-[11px] font-bold tabular-nums ${unclaimedRaw > 0 ? 'text-amber-400' : 'text-gray-600'}`}>{unclaimedUi}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-xs text-gray-600 italic py-2">No active cash game tables with rake data.</div>
                )}

                {/* Claim rewards button */}
                {pendingCrankPool.total > 0 && (
                  <div className="flex items-center justify-between gap-3 bg-cyan-500/[0.06] rounded-lg px-3 py-2 mt-3">
                    <span className="text-[10px] text-cyan-400/60">
                      Pending crank pool across all tokens. Claim triggers distribute_crank_rewards.
                    </span>
                    <button
                      onClick={claimRewards}
                      disabled={claiming}
                      className="shrink-0 px-3 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-medium hover:bg-emerald-500/25 disabled:opacity-40 transition-colors"
                    >
                      {claiming ? 'Claiming...' : 'Claim Rewards'}
                    </button>
                  </div>
                )}
                {claimResult && (
                  <div className={`text-[10px] mt-2 px-3 py-2 rounded-lg ${claimResult.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                    {claimResult.msg}
                  </div>
                )}
              </Panel>

              {/* PnL Chart */}
              <PnLChart
                solEarned={operator.lifetimeSolEarned}
                txCost={crankMetrics?.totals?.totalCostLamports || 0}
                actions={operator.lifetimeActions}
              />

              {/* Crank Config (matching admin) */}
              <DealerCrankConfig />

              {/* Table Filtering */}
              <TableFilterPanel />

              {/* Wallet Management */}
              <WalletManagement crankPubkey={crankPubkey} onImport={fetchOperator} />

              {/* How to Run */}
              <Panel title="Become a Dealer">
                <div className="text-[11px] text-gray-400 leading-relaxed space-y-2">
                  <p>The Dealer Service is fully permissionless — anyone can run one and earn <span className="text-emerald-400 font-medium">5% of every pot&apos;s rake</span>.</p>
                  <div className="bg-gray-950 rounded-lg border border-gray-800/40 p-3 font-mono text-[10px] text-gray-500 space-y-1">
                    <div className="text-gray-400"># 1. Install the Dealer Service</div>
                    <div>cd dealer-service &amp;&amp; npm install</div>
                    <div className="text-gray-400"># 2. Setup wallet + register on-chain</div>
                    <div>npm run setup</div>
                    <div className="text-gray-400"># 3. Start dealing tables</div>
                    <div>npm run start</div>
                    <div className="text-gray-400"># 4. Check earnings</div>
                    <div>npm run earnings</div>
                  </div>
                  <p className="text-[10px] text-gray-600">
                    Dealers earn 5% of rake (mandatory) + optional player tips. Rewards are action-weighted — L1 actions count 2&times;.
                  </p>
                </div>
              </Panel>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PnL Chart (SVG-based, localStorage history, 1d/7d/30d tabs) ───
const PNL_STORAGE_KEY = 'dealer-pnl-history';
interface PnLPoint { ts: number; earned: number; cost: number; actions: number; }

function PnLChart({ solEarned, txCost, actions }: { solEarned: number; txCost: number; actions: number }) {
  const [range, setRange] = useState<'1d' | '7d' | '30d'>('7d');
  const [history, setHistory] = useState<PnLPoint[]>([]);

  // Record a data point every poll (deduped to 1 per minute)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PNL_STORAGE_KEY);
      const stored: PnLPoint[] = raw ? JSON.parse(raw) : [];
      const now = Date.now();
      const last = stored[stored.length - 1];
      if (!last || now - last.ts > 60_000) {
        stored.push({ ts: now, earned: solEarned, cost: txCost, actions });
        // Keep max 30 days of minutely data (~43k points)
        const cutoff = now - 30 * 86400_000;
        const trimmed = stored.filter(p => p.ts > cutoff);
        localStorage.setItem(PNL_STORAGE_KEY, JSON.stringify(trimmed));
        setHistory(trimmed);
      } else {
        setHistory(stored);
      }
    } catch { setHistory([]); }
  }, [solEarned, txCost, actions]);

  const rangeMs = range === '1d' ? 86400_000 : range === '7d' ? 7 * 86400_000 : 30 * 86400_000;
  const cutoff = Date.now() - rangeMs;
  const filtered = history.filter(p => p.ts > cutoff);

  // Build chart points
  const W = 580, H = 140, PAD = 4;
  const points = filtered.length > 1 ? filtered : [{ ts: Date.now() - rangeMs, earned: 0, cost: 0, actions: 0 }, { ts: Date.now(), earned: solEarned, cost: txCost, actions }];
  const pnlValues = points.map(p => (p.earned - p.cost) / 1e9);
  const minV = Math.min(...pnlValues, 0);
  const maxV = Math.max(...pnlValues, 0.000001);
  const rangeV = maxV - minV || 0.000001;
  const tsMin = points[0].ts;
  const tsMax = points[points.length - 1].ts;
  const tsRange = tsMax - tsMin || 1;

  const svgPoints = points.map((p) => {
    const x = PAD + ((p.ts - tsMin) / tsRange) * (W - 2 * PAD);
    const y = H - PAD - (((p.earned - p.cost) / 1e9 - minV) / rangeV) * (H - 2 * PAD);
    return `${x},${y}`;
  }).join(' ');

  // Zero line
  const zeroY = H - PAD - ((0 - minV) / rangeV) * (H - 2 * PAD);
  const currentPnl = (solEarned - txCost) / 1e9;
  const isPositive = currentPnl >= 0;

  return (
    <Panel title={<>PnL Over Time <span className={`normal-case ml-1 ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>{isPositive ? '+' : ''}{currentPnl.toFixed(6)} SOL</span></>}>
      <div className="flex gap-1 mb-3">
        {(['1d', '7d', '30d'] as const).map(r => (
          <button key={r} onClick={() => setRange(r)}
            className={`px-2.5 py-1 rounded text-[10px] font-mono transition-colors ${
              range === r ? 'bg-cyan-500/15 border border-cyan-500/30 text-cyan-400' : 'text-gray-600 hover:text-gray-400'
            }`}>
            {r}
          </button>
        ))}
        <span className="ml-auto text-[9px] text-gray-600">{filtered.length} data points</span>
      </div>
      <div className="bg-gray-950 rounded-lg border border-gray-800/40 p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[140px]" preserveAspectRatio="none">
          {/* Zero line */}
          <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="4,4" />
          {/* PnL line */}
          <polyline points={svgPoints} fill="none" stroke={isPositive ? '#34d399' : '#f87171'} strokeWidth="2" strokeLinejoin="round" />
          {/* Fill area */}
          <polygon
            points={`${PAD},${zeroY} ${svgPoints} ${W - PAD},${zeroY}`}
            fill={isPositive ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)'}
          />
        </svg>
        <div className="flex justify-between text-[9px] text-gray-600 font-mono mt-1 px-1">
          <span>{new Date(tsMin).toLocaleDateString()}</span>
          <span>{new Date(tsMax).toLocaleDateString()}</span>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3">
        <div className="text-center">
          <div className="text-[9px] text-gray-500 uppercase">Revenue</div>
          <div className="text-xs font-bold text-emerald-400 tabular-nums">{(solEarned / 1e9).toFixed(6)}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] text-gray-500 uppercase">TX Costs</div>
          <div className="text-xs font-bold text-red-300 tabular-nums">{(txCost / 1e9).toFixed(6)}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] text-gray-500 uppercase">Net PnL</div>
          <div className={`text-xs font-bold tabular-nums ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>{isPositive ? '+' : ''}{currentPnl.toFixed(6)}</div>
        </div>
      </div>
    </Panel>
  );
}

// ─── Crank Config Panel (full config matching admin, with RPC endpoints) ───
function DealerCrankConfig() {
  const [cfg, setCfg] = useState<Record<string, any> | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/crank-config');
      if (r.ok) {
        const resp = await r.json();
        const data = resp.config || resp;
        setCfg(data);
        setDraft({
          timeout_ms: data.timeout_ms ?? 20000,
          removal_sweep_interval: data.removal_sweep_interval ?? 30000,
          rake_sweep_interval: data.rake_sweep_interval ?? 60000,
          tee_rpc: data.tee_rpc ?? 'https://devnet-tee.magicblock.app',
          l1_rpc: data.l1_rpc ?? '',
        });
      }
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const toggleField = async (key: string) => {
    if (!cfg) return;
    setToggling(key);
    setMsg(null);
    try {
      const r = await fetch('/api/admin/crank-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: !cfg[key] }),
      });
      if (r.ok) { const resp = await r.json(); setCfg(resp.config || resp); }
      else setMsg({ text: 'Toggle failed', ok: false });
    } catch { setMsg({ text: 'Toggle failed', ok: false }); }
    finally { setToggling(null); }
  };

  const hasDraftChanges = cfg && (
    draft.timeout_ms !== (cfg.timeout_ms ?? 20000) ||
    draft.removal_sweep_interval !== (cfg.removal_sweep_interval ?? 30000) ||
    draft.rake_sweep_interval !== (cfg.rake_sweep_interval ?? 60000) ||
    (draft.tee_rpc || '') !== (cfg.tee_rpc || '') ||
    (draft.l1_rpc || '') !== (cfg.l1_rpc || '')
  );

  const saveDraft = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch('/api/admin/crank-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (r.ok) { const resp = await r.json(); setCfg(resp.config || resp); setMsg({ text: 'Saved — crank picks up in ~5s', ok: true }); }
      else setMsg({ text: 'Save failed', ok: false });
    } catch { setMsg({ text: 'Save failed', ok: false }); }
    finally { setSaving(false); }
  };

  if (loading) return <Panel title="Crank Config"><div className="text-xs text-gray-600 italic">Loading...</div></Panel>;
  if (!cfg) return <Panel title="Crank Config"><div className="text-xs text-red-400">{msg?.text || 'No config'}</div></Panel>;

  const toggles: { key: string; label: string; onClass: string }[] = [
    { key: 'crank_sng', label: 'SNG Tables', onClass: 'bg-blue-500/10 border-blue-500/20 text-blue-400' },
    { key: 'crank_cash', label: 'Cash Tables', onClass: 'bg-green-500/10 border-green-500/20 text-green-400' },
    { key: 'process_cashouts', label: 'Cashouts', onClass: 'bg-amber-500/10 border-amber-500/20 text-amber-400' },
    { key: 'auto_kick', label: 'Auto Kick', onClass: 'bg-red-500/10 border-red-500/20 text-red-400' },
    { key: 'timeout_enabled', label: 'Timeout', onClass: 'bg-cyan-500/10 border-cyan-500/20 text-cyan-400' },
    { key: 'rake_sweep', label: 'Rake Sweep', onClass: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' },
    { key: 'auction_sweep', label: 'Auctions', onClass: 'bg-purple-500/10 border-purple-500/20 text-purple-400' },
  ];

  const intervals: { key: string; label: string; defaultMs: number }[] = [
    { key: 'timeout_ms', label: 'Auto-fold Timeout', defaultMs: 20000 },
    { key: 'removal_sweep_interval', label: 'Kick Sweep Interval', defaultMs: 30000 },
    { key: 'rake_sweep_interval', label: 'Rake Sweep Interval', defaultMs: 60000 },
  ];

  return (
    <Panel title="Crank Config">
      {msg && <div className={`text-[10px] mb-2 px-1 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</div>}

      <div className="text-[9px] text-gray-600 uppercase tracking-wider mb-1.5">Features <span className="text-gray-700 normal-case">(instant)</span></div>
      <div className="space-y-1 mb-3">
        {toggles.map(t => {
          const on = cfg[t.key] !== false;
          return (
            <button
              key={t.key}
              onClick={() => toggleField(t.key)}
              disabled={toggling === t.key}
              className={`w-full flex items-center justify-between px-2 py-1 rounded border text-[10px] font-mono transition-colors ${
                on ? t.onClass : 'bg-gray-800/40 border-gray-700/30 text-gray-600'
              } hover:opacity-80 disabled:opacity-40`}
            >
              <span>{t.label}</span>
              <span className={`text-[9px] font-bold ${on ? 'text-emerald-400' : 'text-gray-600'}`}>
                {toggling === t.key ? '...' : on ? 'ON' : 'OFF'}
              </span>
            </button>
          );
        })}
      </div>

      <div className="text-[9px] text-gray-600 uppercase tracking-wider mb-1.5 pt-2 border-t border-white/[0.04]">
        Intervals {hasDraftChanges && <span className="text-amber-400 normal-case ml-1">unsaved</span>}
      </div>
      <div className="space-y-1.5 mb-3">
        {intervals.map(iv => (
          <div key={iv.key} className="flex items-center justify-between text-[10px] font-mono">
            <span className="text-gray-500">{iv.label}</span>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                value={Math.round((draft[iv.key] ?? iv.defaultMs) / 1000)}
                onChange={e => setDraft(prev => ({ ...prev, [iv.key]: Math.max(1000, (parseInt(e.target.value) || 1) * 1000) }))}
                className="w-14 bg-gray-900 border border-gray-700/40 rounded px-1.5 py-0.5 text-[10px] text-gray-300 text-right tabular-nums focus:border-cyan-500/50 focus:outline-none"
              />
              <span className="text-gray-600 text-[9px] w-3">s</span>
            </div>
          </div>
        ))}
      </div>

      {/* RPC Endpoints */}
      <details className="pt-2 border-t border-white/[0.04]">
        <summary className="text-[9px] text-gray-600 uppercase tracking-wider cursor-pointer hover:text-gray-400 select-none">
          RPC Endpoints
        </summary>
        <div className="space-y-1.5 mt-2">
          <div>
            <label className="text-[9px] text-gray-600 block mb-0.5">TEE RPC</label>
            <input
              type="text"
              value={draft.tee_rpc || ''}
              onChange={e => setDraft(prev => ({ ...prev, tee_rpc: e.target.value }))}
              placeholder="https://devnet-tee.magicblock.app"
              className="w-full bg-gray-900 border border-gray-700/40 rounded px-2 py-1 text-[10px] text-gray-300 font-mono focus:border-cyan-500/50 focus:outline-none placeholder:text-gray-700"
            />
          </div>
          <div>
            <label className="text-[9px] text-gray-600 block mb-0.5">L1 RPC</label>
            <input
              type="text"
              value={draft.l1_rpc || ''}
              onChange={e => setDraft(prev => ({ ...prev, l1_rpc: e.target.value }))}
              placeholder="https://api.devnet.solana.com"
              className="w-full bg-gray-900 border border-gray-700/40 rounded px-2 py-1 text-[10px] text-gray-300 font-mono focus:border-cyan-500/50 focus:outline-none placeholder:text-gray-700"
            />
          </div>
        </div>
      </details>

      {hasDraftChanges && (
        <button
          onClick={saveDraft}
          disabled={saving}
          className="mt-3 w-full py-1.5 rounded bg-cyan-600/20 border border-cyan-500/30 text-cyan-400 text-[10px] font-medium hover:bg-cyan-600/30 disabled:opacity-40 transition-colors"
        >
          {saving ? 'Saving...' : 'Save Config'}
        </button>
      )}
    </Panel>
  );
}

// ─── Table Filter Panel (Whitelist / Blacklist, matching admin) ───
function TableFilterPanel() {
  const [mode, setMode] = useState<'none' | 'whitelist' | 'blacklist'>('none');
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/crank-config');
      if (r.ok) {
        const resp = await r.json();
        const data = resp.config || resp;
        setMode(data.table_filter_mode || 'none');
        setWhitelist(data.table_whitelist || []);
        setBlacklist(data.table_blacklist || []);
      }
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const saveFilter = async (updates: Record<string, unknown>) => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch('/api/admin/crank-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (r.ok) {
        const resp = await r.json();
        const data = resp.config || resp;
        setMode(data.table_filter_mode || 'none');
        setWhitelist(data.table_whitelist || []);
        setBlacklist(data.table_blacklist || []);
        setMsg({ text: 'Saved', ok: true });
      } else {
        setMsg({ text: 'Save failed', ok: false });
      }
    } catch { setMsg({ text: 'Save failed', ok: false }); }
    finally { setSaving(false); }
  };

  const changeMode = (newMode: 'none' | 'whitelist' | 'blacklist') => {
    setMode(newMode);
    saveFilter({ table_filter_mode: newMode });
  };

  const activeList = mode === 'whitelist' ? whitelist : blacklist;
  const activeKey = mode === 'whitelist' ? 'table_whitelist' : 'table_blacklist';

  const addEntry = () => {
    const trimmed = input.trim();
    if (!trimmed || trimmed.length < 32 || trimmed.length > 44) { setMsg({ text: 'Invalid pubkey', ok: false }); return; }
    if (activeList.includes(trimmed)) { setMsg({ text: 'Already in list', ok: false }); return; }
    const updated = [...activeList, trimmed];
    if (mode === 'whitelist') setWhitelist(updated); else setBlacklist(updated);
    setInput('');
    saveFilter({ [activeKey]: updated });
  };

  const removeEntry = (pubkey: string) => {
    const updated = activeList.filter(e => e !== pubkey);
    if (mode === 'whitelist') setWhitelist(updated); else setBlacklist(updated);
    saveFilter({ [activeKey]: updated });
  };

  if (loading) return <Panel title="Table Filtering"><div className="text-xs text-gray-600 italic">Loading...</div></Panel>;

  const modeColors: Record<string, string> = {
    none: 'bg-gray-500/10 border-gray-500/20 text-gray-400',
    whitelist: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
    blacklist: 'bg-red-500/10 border-red-500/20 text-red-400',
  };
  const modeLabels: Record<string, string> = { none: 'Off', whitelist: 'Whitelist Only', blacklist: 'Blacklist Skip' };

  return (
    <Panel title={<>Table Filtering <span className={`text-[9px] font-normal ml-1 ${mode !== 'none' ? 'text-amber-400' : 'text-gray-600'}`}>({modeLabels[mode]})</span></>}>
      {msg && <div className={`text-[10px] mb-2 px-1 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</div>}

      <div className="text-[9px] text-gray-600 uppercase tracking-wider mb-1.5">Mode</div>
      <div className="flex gap-1 mb-3">
        {(['none', 'whitelist', 'blacklist'] as const).map(m => (
          <button key={m} onClick={() => changeMode(m)} disabled={saving}
            className={`flex-1 px-2 py-1.5 rounded border text-[10px] font-mono transition-colors ${
              mode === m ? modeColors[m] + ' font-bold' : 'bg-gray-800/40 border-gray-700/30 text-gray-600 hover:text-gray-400'
            } disabled:opacity-40`}>
            {m === 'none' ? 'Off' : m === 'whitelist' ? 'WL' : 'BL'}
          </button>
        ))}
      </div>

      {mode !== 'none' && (
        <>
          <div className="text-[9px] text-gray-600 uppercase tracking-wider mb-1.5">
            {mode === 'whitelist' ? 'Whitelisted' : 'Blacklisted'} Tables ({activeList.length})
          </div>
          <div className="flex gap-1 mb-2">
            <input type="text" value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addEntry()} placeholder="Table pubkey..."
              className="flex-1 bg-gray-900 border border-gray-700/40 rounded px-2 py-1 text-[10px] text-gray-300 font-mono focus:border-cyan-500/50 focus:outline-none placeholder:text-gray-700" />
            <button onClick={addEntry} disabled={saving || !input.trim()}
              className="px-2.5 py-1 rounded border text-[10px] font-medium bg-cyan-600/15 border-cyan-500/30 text-cyan-400 hover:bg-cyan-600/25 disabled:opacity-40 transition-colors">+</button>
          </div>
          {activeList.length > 0 ? (
            <div className="space-y-1 max-h-36 overflow-y-auto">
              {activeList.map(pubkey => (
                <div key={pubkey} className="flex items-center justify-between px-2 py-1 rounded bg-white/[0.02] border border-white/[0.04] group">
                  <span className="text-[10px] font-mono text-gray-400 truncate mr-2" title={pubkey}>{pubkey.slice(0, 8)}...{pubkey.slice(-6)}</span>
                  <button onClick={() => removeEntry(pubkey)} className="text-[9px] text-red-500/60 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">&#10005;</button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[10px] text-gray-600 italic py-1">No tables in {mode}.</div>
          )}
        </>
      )}
      {mode === 'none' && (
        <div className="text-[10px] text-gray-600 italic">All delegated tables will be cranked.</div>
      )}
    </Panel>
  );
}

// ─── Wallet Management (import private key, change wallet) ───
function WalletManagement({ crankPubkey, onImport }: { crankPubkey: string | null; onImport: () => void }) {
  const [secretInput, setSecretInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [expanded, setExpanded] = useState(false);

  const handleImport = async () => {
    if (!secretInput.trim()) return;
    setImporting(true);
    setMsg(null);
    try {
      // Try to parse as JSON array first, else treat as base58
      let body: any;
      try {
        const parsed = JSON.parse(secretInput.trim());
        if (Array.isArray(parsed)) {
          body = { secretKey: parsed };
        } else {
          body = { secretKey: secretInput.trim() };
        }
      } catch {
        body = { secretKey: secretInput.trim() };
      }

      const r = await fetch('/api/admin/crank-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await r.json();
      if (r.ok) {
        setMsg({ text: `Imported: ${result.pubkey?.slice(0, 12)}... Restart crank to apply.`, ok: true });
        setSecretInput('');
        onImport();
      } else {
        setMsg({ text: result.error || 'Import failed', ok: false });
      }
    } catch (e: any) {
      setMsg({ text: e.message || 'Import failed', ok: false });
    }
    setImporting(false);
  };

  return (
    <Panel title="Wallet Management">
      <div className="space-y-1.5 text-xs font-mono mb-3">
        <Row k="Active Wallet" v={crankPubkey ? crankPubkey.slice(0, 16) + '...' : 'None'} vc={crankPubkey ? 'text-cyan-400' : 'text-red-400'} />
      </div>

      <button onClick={() => setExpanded(!expanded)}
        className="w-full text-left text-[10px] text-gray-500 hover:text-gray-300 transition-colors mb-2">
        {expanded ? '▾ Hide Import' : '▸ Import / Change Wallet'}
      </button>

      {expanded && (
        <div className="space-y-2 pt-2 border-t border-white/[0.04]">
          {msg && <div className={`text-[10px] px-1 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</div>}
          <div>
            <label className="text-[9px] text-gray-600 block mb-0.5">Private Key (base58 or JSON byte array)</label>
            <textarea
              value={secretInput}
              onChange={e => setSecretInput(e.target.value)}
              placeholder="Paste base58 private key or [1,2,3,...] byte array"
              rows={3}
              className="w-full bg-gray-900 border border-gray-700/40 rounded px-2 py-1.5 text-[10px] text-gray-300 font-mono focus:border-cyan-500/50 focus:outline-none placeholder:text-gray-700 resize-none"
            />
          </div>
          <button onClick={handleImport} disabled={importing || !secretInput.trim()}
            className="w-full py-1.5 rounded bg-amber-600/20 border border-amber-500/30 text-amber-400 text-[10px] font-medium hover:bg-amber-600/30 disabled:opacity-40 transition-colors">
            {importing ? 'Importing...' : 'Import Keypair'}
          </button>
          <div className="text-[9px] text-gray-600">
            Saves to crank keypair path. Restart the crank service after importing.
          </div>
        </div>
      )}
    </Panel>
  );
}
