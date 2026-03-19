'use client';

import { useState, useEffect, useCallback } from 'react';

interface CrankDashboardProps {
  crankDashData: any;
  crankLogs: string[];
  crankAction: string | null;
  crankCmdResult: string | null;
  sendCrankCommand: (action: 'start' | 'stop' | 'restart') => void;
  crankMetrics: any;
  crankStatus: any;
  fetchCrankDash: () => void;
}

export function CrankDashboard({
  crankDashData, crankLogs, crankAction, crankCmdResult,
  sendCrankCommand, crankMetrics, crankStatus, fetchCrankDash,
}: CrankDashboardProps) {
  const isOnline = crankDashData?.status === 'online';
  const hb = crankDashData?.heartbeat;

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-6 space-y-5">
      {/* ─── Status Banner ─── */}
      <div className={`rounded-xl border p-5 ${isOnline ? 'border-emerald-500/30 bg-emerald-500/[0.04]' : 'border-red-500/30 bg-red-500/[0.04]'}`}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className={`w-4 h-4 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'}`} />
            <div>
              <h2 className={`text-lg font-bold ${isOnline ? 'text-emerald-400' : 'text-red-400'}`}>
                Crank Service — {isOnline ? 'Online' : 'Offline'}
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
            <button onClick={fetchCrankDash}
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* ─── Left: Details ─── */}
        <div className="space-y-4">
          {/* Heartbeat */}
          <Panel title="Heartbeat">
            {hb ? (
              <div className="space-y-1.5 text-xs font-mono">
                <Row k="Status" v={hb.status} vc={isOnline ? 'text-emerald-400' : 'text-red-400'} />
                <Row k="PID" v={hb.pid} />
                <Row k="Started" v={hb.startedAt ? new Date(hb.startedAt).toLocaleString() : '—'} />
                <Row k="Uptime" v={hb.uptime || '—'} />
                <Row k="Tables Tracked" v={hb.tablesTracked ?? 0} vc="text-cyan-400" />
                <Row k="Processing" v={hb.tablesProcessing ?? 0} vc="text-amber-400" />
                <Row k="Heartbeat Age" v={`${hb.heartbeatAge}s`} />
                <Row k="Deal Mode" v={hb.dealMode === 'arcium' ? 'Arcium MPC' : hb.dealMode === 'mock' ? 'Mock (debug)' : hb.dealMode ?? '—'} vc={hb.dealMode === 'arcium' ? 'text-emerald-400' : 'text-amber-400'} />
              </div>
            ) : (
              <div className="text-xs text-gray-600 italic">No heartbeat file. Start the crank to begin monitoring.</div>
            )}
          </Panel>

          {/* On-Chain Dealer Stats */}
          <Panel title="Dealer Earnings (On-Chain)">
            {hb?.dealerStats ? (
              <div className="space-y-1.5 text-xs font-mono">
                <Row k="Operator" v={hb.dealerStats.operatorPubkey ? `${hb.dealerStats.operatorPubkey.slice(0, 8)}...${hb.dealerStats.operatorPubkey.slice(-4)}` : '—'} />
                <Row k="Lifetime Actions" v={hb.dealerStats.lifetimeActions ?? 0} vc="text-cyan-400" />
                <Row k="SOL Earned" v={`${((hb.dealerStats.lifetimeSolEarned ?? 0) / 1e9).toFixed(6)} SOL`} vc="text-emerald-400" />
                <Row k="Token Earned" v={hb.dealerStats.lifetimeTokenEarned ?? 0} vc="text-amber-400" />
                <Row k="Registered" v={hb.dealerStats.registeredAt ? new Date(hb.dealerStats.registeredAt * 1000).toLocaleDateString() : '—'} />
                <div className="text-[9px] text-gray-600 pt-1">Refreshed {hb.dealerStats.lastRefreshed ? `${Math.round((Date.now() - hb.dealerStats.lastRefreshed) / 1000)}s ago` : 'never'}</div>
              </div>
            ) : (
              <div className="text-xs text-gray-600 italic">{isOnline ? 'Waiting for on-chain stats refresh...' : 'Start the crank to see earnings.'}</div>
            )}
          </Panel>

          {/* Recent Errors */}
          <Panel title={<>Recent Errors {hb?.recentErrors?.length > 0 && <span className="text-red-400">({hb.recentErrors.length})</span>}</>}>
            {hb?.recentErrors?.length > 0 ? (
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {hb.recentErrors.slice(-15).reverse().map((e: string, i: number) => (
                  <div key={i} className="text-[10px] font-mono text-red-400/70 break-all bg-red-500/[0.05] rounded px-2 py-1">{e}</div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-gray-600 italic">No recent errors</div>
            )}
          </Panel>

          {/* Config (Live, Editable) */}
          <CrankConfigPanel />

          {/* Table Filtering (Whitelist / Blacklist) */}
          <TableFilterPanel />
        </div>

        {/* ─── Right: Stats + Logs ─── */}
        <div className="lg:col-span-2 space-y-4">
          {/* All-Time Stats */}
          {crankMetrics && (
            <Panel title="All-Time Crank Stats">
              <div className="grid grid-cols-4 gap-3 mb-3">
                <StatCard label="Total TXs" value={crankMetrics.totals.totalCranks} color="text-white" />
                <StatCard label="Successful" value={crankMetrics.totals.totalSuccess ?? 0} color="text-emerald-400" />
                <StatCard label="Failed" value={crankMetrics.totals.totalFailed ?? 0} color="text-red-400" />
                <StatCard label="TX Cost" value={`${(crankMetrics.totals.totalCostLamports / 1e9).toFixed(6)} SOL`} color="text-amber-300" />
              </div>
              {/* byLabel breakdown */}
              {crankMetrics.byLabel && Object.keys(crankMetrics.byLabel).length > 0 && (
                <details>
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
          )}

          {/* Crank Output Log */}
          <Panel title="Crank Output Log">
            <div className="bg-gray-950 rounded-lg border border-gray-800/40 p-3 max-h-[500px] overflow-y-auto font-mono text-[10px] leading-relaxed">
              {crankLogs.length > 0 ? (
                crankLogs.map((line, i) => (
                  <div key={i} className={`${
                    line.includes('❌') || line.includes('error') || line.includes('FAIL') ? 'text-red-400/80' :
                    line.includes('✅') || line.includes('confirmed') ? 'text-emerald-400/70' :
                    line.includes('⚠') ? 'text-amber-400/70' :
                    line.includes('═') || line.includes('🃏') || line.includes('🟢') ? 'text-cyan-400/70' :
                    'text-gray-500'
                  } break-all`}>{line}</div>
                ))
              ) : (
                <div className="text-gray-600 italic">No log output available. Start the crank to see output here.</div>
              )}
            </div>
          </Panel>

          {/* How to Run Your Own */}
          <Panel title="Become a Dealer">
            <div className="text-[11px] text-gray-400 leading-relaxed space-y-2">
              <p>The Dealer Service is fully permissionless — anyone can run one and earn <span className="text-emerald-400 font-medium">5% of every pot&apos;s rake</span>.</p>
              <div className="bg-gray-950 rounded-lg border border-gray-800/40 p-3 font-mono text-[10px] text-gray-500 space-y-1">
                <div className="text-gray-400"># 1. Install the Dealer Service</div>
                <div>cd dealer-service && npm install</div>
                <div className="text-gray-400"># 2. Setup wallet + register on-chain</div>
                <div>npm run setup</div>
                <div className="text-gray-400"># 3. Start dealing tables (Arcium MPC)</div>
                <div>npm run start</div>
                <div className="text-gray-400"># 4. Check earnings</div>
                <div>npm run earnings</div>
              </div>
              <p className="text-[10px] text-gray-600">
                Dealers earn 5% of rake (mandatory) + optional player tips. All deals use Arcium MPC encryption.
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

// ─── Helper Components ───
function Panel({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <h3 className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Row({ k, v, vc, sz }: { k: string; v: string | number; vc?: string; sz?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{k}</span>
      <span className={`${vc || 'text-gray-300'} ${sz === 'sm' ? 'text-[10px]' : ''}`}>{String(v)}</span>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="text-center bg-white/[0.02] rounded-lg border border-white/[0.04] py-2 px-1">
      <div className={`text-sm font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-[9px] text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}

// ─── Crank Config Panel ───
// Toggles: instant save (hot-reloaded by crank every ~5s, no restart)
// Intervals + RPC: draft editing, requires explicit "Save" to apply
function CrankConfigPanel() {
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
        const data = resp.config || resp; // API returns { config: {...} }
        setCfg(data);
        setDraft({
          timeout_ms: data.timeout_ms ?? 20000,
          removal_sweep_interval: data.removal_sweep_interval ?? 30000,
          rake_sweep_interval: data.rake_sweep_interval ?? 60000,
          tee_rpc: data.tee_rpc ?? 'https://devnet-tee.magicblock.app',
          l1_rpc: data.l1_rpc ?? 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df',
        });
      } else setMsg({ text: 'Failed to load config', ok: false });
    } catch { setMsg({ text: 'Config API unreachable', ok: false }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  // Instant toggle save (hot-reload, no restart needed)
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
      if (r.ok) {
        const resp = await r.json();
        setCfg(resp.config || resp);
      } else setMsg({ text: 'Toggle failed', ok: false });
    } catch { setMsg({ text: 'Toggle failed', ok: false }); }
    finally { setToggling(null); }
  };

  // Draft has unsaved changes?
  const hasDraftChanges = cfg && (
    draft.timeout_ms !== (cfg.timeout_ms ?? 20000) ||
    draft.removal_sweep_interval !== (cfg.removal_sweep_interval ?? 30000) ||
    draft.rake_sweep_interval !== (cfg.rake_sweep_interval ?? 60000) ||
    (draft.tee_rpc || '') !== (cfg.tee_rpc || '') ||
    (draft.l1_rpc || '') !== (cfg.l1_rpc || '')
  );

  // Save intervals + RPC (requires explicit action)
  const saveDraft = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch('/api/admin/crank-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (r.ok) {
        const resp = await r.json();
        const updated = resp.config || resp;
        setCfg(updated);
        setMsg({ text: 'Saved — crank will pick up changes within ~5s', ok: true });
      } else {
        setMsg({ text: (await r.json()).error || 'Save failed', ok: false });
      }
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

      {/* Feature Toggles — instant save */}
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

      {/* Intervals — draft, requires save */}
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

      {/* RPC — collapsible, draft, requires save */}
      <details className="pt-2 border-t border-white/[0.04]">
        <summary className="text-[9px] text-gray-600 uppercase tracking-wider cursor-pointer hover:text-gray-400 select-none">
          RPC Endpoints
        </summary>
        <div className="space-y-1.5 mt-2">
          <div>
            <label className="text-[9px] text-gray-600 block mb-0.5">Solana RPC</label>
            <input
              type="text"
              value={draft.tee_rpc || ''}
              onChange={e => setDraft(prev => ({ ...prev, tee_rpc: e.target.value }))}
              placeholder="https://api.devnet.solana.com"
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

      {/* Save button — only for intervals + RPC */}
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

// ─── Table Filter Panel (Whitelist / Blacklist) ───
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
        setMsg({ text: 'Saved — crank picks up in ~5s', ok: true });
      } else {
        const err = await r.json().catch(() => ({}));
        setMsg({ text: err.error || 'Save failed', ok: false });
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
    if (!trimmed || trimmed.length < 32 || trimmed.length > 44) {
      setMsg({ text: 'Invalid pubkey (must be 32-44 chars base58)', ok: false });
      return;
    }
    if (activeList.includes(trimmed)) {
      setMsg({ text: 'Already in list', ok: false });
      return;
    }
    const updated = [...activeList, trimmed];
    if (mode === 'whitelist') setWhitelist(updated);
    else setBlacklist(updated);
    setInput('');
    saveFilter({ [activeKey]: updated });
  };

  const removeEntry = (pubkey: string) => {
    const updated = activeList.filter(e => e !== pubkey);
    if (mode === 'whitelist') setWhitelist(updated);
    else setBlacklist(updated);
    saveFilter({ [activeKey]: updated });
  };

  const clearAll = () => {
    if (mode === 'whitelist') setWhitelist([]);
    else setBlacklist([]);
    saveFilter({ [activeKey]: [] });
  };

  if (loading) return <Panel title="Table Filtering"><div className="text-xs text-gray-600 italic">Loading...</div></Panel>;

  const modeColors: Record<string, string> = {
    none: 'bg-gray-500/10 border-gray-500/20 text-gray-400',
    whitelist: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
    blacklist: 'bg-red-500/10 border-red-500/20 text-red-400',
  };
  const modeLabels: Record<string, string> = {
    none: 'Off — Crank All',
    whitelist: 'Whitelist — Only Listed',
    blacklist: 'Blacklist — Skip Listed',
  };

  return (
    <Panel title={<>Table Filtering <span className={`text-[9px] font-normal ml-1 ${mode !== 'none' ? 'text-amber-400' : 'text-gray-600'}`}>({modeLabels[mode]})</span></>}>
      {msg && <div className={`text-[10px] mb-2 px-1 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</div>}

      {/* Mode selector */}
      <div className="text-[9px] text-gray-600 uppercase tracking-wider mb-1.5">Mode</div>
      <div className="flex gap-1 mb-3">
        {(['none', 'whitelist', 'blacklist'] as const).map(m => (
          <button
            key={m}
            onClick={() => changeMode(m)}
            disabled={saving}
            className={`flex-1 px-2 py-1.5 rounded border text-[10px] font-mono transition-colors ${
              mode === m
                ? modeColors[m] + ' font-bold'
                : 'bg-gray-800/40 border-gray-700/30 text-gray-600 hover:text-gray-400'
            } disabled:opacity-40`}
          >
            {m === 'none' ? 'Off' : m === 'whitelist' ? 'WL' : 'BL'}
          </button>
        ))}
      </div>

      {/* Add entry + list (only when mode is active) */}
      {mode !== 'none' && (
        <>
          <div className="text-[9px] text-gray-600 uppercase tracking-wider mb-1.5">
            {mode === 'whitelist' ? 'Whitelisted Tables' : 'Blacklisted Tables'}
            {activeList.length > 0 && <span className="text-gray-500 normal-case ml-1">({activeList.length})</span>}
          </div>

          {/* Add input */}
          <div className="flex gap-1 mb-2">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addEntry()}
              placeholder="Table pubkey..."
              className="flex-1 bg-gray-900 border border-gray-700/40 rounded px-2 py-1 text-[10px] text-gray-300 font-mono focus:border-cyan-500/50 focus:outline-none placeholder:text-gray-700"
            />
            <button
              onClick={addEntry}
              disabled={saving || !input.trim()}
              className="px-2.5 py-1 rounded border text-[10px] font-medium bg-cyan-600/15 border-cyan-500/30 text-cyan-400 hover:bg-cyan-600/25 disabled:opacity-40 transition-colors"
            >
              +
            </button>
          </div>

          {/* Current list */}
          {activeList.length > 0 ? (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {activeList.map(pubkey => (
                <div key={pubkey} className="flex items-center justify-between px-2 py-1 rounded bg-white/[0.02] border border-white/[0.04] group">
                  <span className="text-[10px] font-mono text-gray-400 truncate mr-2" title={pubkey}>
                    {pubkey.slice(0, 8)}...{pubkey.slice(-6)}
                  </span>
                  <button
                    onClick={() => removeEntry(pubkey)}
                    className="text-[9px] text-red-500/60 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    title="Remove"
                  >
                    &#10005;
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[10px] text-gray-600 italic py-2">
              No tables in {mode}. Add a table pubkey above.
            </div>
          )}

          {/* Clear all */}
          {activeList.length > 1 && (
            <button
              onClick={clearAll}
              disabled={saving}
              className="mt-2 w-full py-1 rounded text-[9px] text-red-400/60 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-all disabled:opacity-40"
            >
              Clear All ({activeList.length})
            </button>
          )}
        </>
      )}

      {mode === 'none' && (
        <div className="text-[10px] text-gray-600 italic">
          All delegated tables will be cranked. Switch to Whitelist or Blacklist mode to filter.
        </div>
      )}
    </Panel>
  );
}
