'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Connection, PublicKey } from '@solana/web3.js';
import { L1_RPC, ANCHOR_PROGRAM_ID } from '@/lib/constants';
import {
  getCurrentAuctionEpoch,
  getAuctionEndTime,
  getAuctionPda,
  getAuctionConfigPda,
  parseAuctionConfig,
  parseGlobalTokenBid,
  GLOBAL_BID_DATA_SIZE,
  GLOBAL_CONTRIB_DATA_SIZE,
  buildPlaceBidInstruction,
} from '@/lib/onchain-game';

// ─── Constants ───
const EPOCH_SECS = 604_800; // 7 days

// ─── Types ───

interface AuctionInfo {
  epoch: bigint;
  startTime: number;
  endTime: number;
  status: number; // 0=Active, 1=Resolved
  winningMint: string;
  totalBid: bigint;
  tokenCount: number;
}

interface GlobalBidInfo {
  tokenMint: string;
  totalAmount: bigint;
  bidderCount: number;
}

interface TokenMeta {
  name: string;
  symbol: string;
  logoURI: string | null;
  verified: boolean;
}

// ─── Parsers ───

function parseAuction(data: Buffer): AuctionInfo | null {
  if (data.length < 76) return null;
  return {
    epoch: data.readBigUInt64LE(8),
    startTime: Number(data.readBigInt64LE(16)),
    endTime: Number(data.readBigInt64LE(24)),
    status: data[32],
    winningMint: new PublicKey(data.subarray(33, 65)).toBase58(),
    totalBid: data.readBigUInt64LE(65),
    tokenCount: data.readUInt16LE(73),
  };
}


// ─── Helpers ───

function short(key: string): string {
  if (key === '11111111111111111111111111111111') return 'None';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

function formatSol(lamports: bigint): string {
  const val = Number(lamports) / 1e9;
  if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
  if (val >= 1) return val.toFixed(val % 1 === 0 ? 0 : 2);
  if (val === 0) return '0';
  return parseFloat(val.toPrecision(3)).toString();
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function epochDateRange(epoch: bigint, startMs?: number | null, endMs?: number | null): string {
  if (startMs && endMs) {
    const startStr = fmtDate(Math.floor(startMs / 1000));
    const endStr = fmtDate(Math.floor(endMs / 1000) - 1);
    return `${startStr} – ${endStr}`;
  }
  // Fallback: wall-clock derived (legacy)
  const start = Number(epoch) * EPOCH_SECS;
  const end = (Number(epoch) + 1) * EPOCH_SECS;
  const startStr = fmtDate(start);
  const endStr = fmtDate(end - 1);
  return `${startStr} – ${endStr}`;
}

function useCountdown(targetMs: number): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const diff = Math.max(0, targetMs - now);
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  if (diff <= 0) return 'Ended';
  if (d > 0) return `${d}d ${h}h ${m}m`;
  return `${h}h ${m}m ${s}s`;
}

// ─── Token Metadata (via server-side API route) ───

const metaCache = new Map<string, TokenMeta>();

async function fetchTokenMetaBatch(mints: string[]): Promise<Record<string, TokenMeta>> {
  // Filter out already-cached mints
  const uncached = mints.filter((m) => !metaCache.has(m));
  if (uncached.length > 0) {
    try {
      const res = await fetch(`/api/token-meta?mints=${uncached.join(',')}`);
      if (res.ok) {
        const data: Record<string, TokenMeta> = await res.json();
        for (const [mint, meta] of Object.entries(data)) {
          metaCache.set(mint, meta);
        }
      }
    } catch (e) {
      console.warn('[Auction] Metadata fetch failed:', e);
    }
  }
  // Build result from cache
  const result: Record<string, TokenMeta> = {};
  for (const m of mints) {
    result[m] = metaCache.get(m) || { name: short(m), symbol: '???', logoURI: null, verified: false };
  }
  return result;
}

// ─── Main Component ───

export default function AuctionsPage() {
  const { publicKey, sendTransaction, connected } = useWallet();
  const conn = useMemo(() => new Connection(L1_RPC, 'confirmed'), []);

  // Config-driven epoch (adaptive duration) with wall-clock fallback
  const [configEpoch, setConfigEpoch] = useState<bigint | null>(null);
  const [configEndMs, setConfigEndMs] = useState<number | null>(null);
  const [configDurationDays, setConfigDurationDays] = useState<number>(7);

  const currentEpoch = configEpoch ?? getCurrentAuctionEpoch();
  const endTimeMs = configEndMs ?? getAuctionEndTime(currentEpoch);
  const countdown = useCountdown(endTimeMs);

  const [auction, setAuction] = useState<AuctionInfo | null>(null);
  const [bids, setBids] = useState<GlobalBidInfo[]>([]);
  const [pastAuctions, setPastAuctions] = useState<AuctionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [tokenMetas, setTokenMetas] = useState<Record<string, TokenMeta>>({});

  // Bid form
  const [candidateMint, setCandidateMint] = useState('');
  const [bidAmount, setBidAmount] = useState('');
  const [anchorVote, setAnchorVote] = useState('');
  const [bidStatus, setBidStatus] = useState<string | null>(null);
  const [bidding, setBidding] = useState(false);

  // Top anchor votes (SOL-weighted, from GlobalBidContribution accounts)
  const [topVotes, setTopVotes] = useState<{ vote: bigint; weight: bigint }[]>([]);

  // Quick-add state (inline bid on leaderboard)
  const [quickAddMint, setQuickAddMint] = useState<string | null>(null);
  const [quickAddAmt, setQuickAddAmt] = useState('');
  const quickAddRef = useRef<HTMLInputElement>(null);

  // Fetch current auction and bids
  const fetchData = useCallback(async () => {
    try {
      // Try to read AuctionConfig PDA for adaptive epoch info
      const configPda = getAuctionConfigPda();
      const configInfo = await conn.getAccountInfo(configPda);
      let activeEpoch = currentEpoch;
      if (configInfo && configInfo.data.length >= 41) {
        const cfg = parseAuctionConfig(Buffer.from(configInfo.data));
        activeEpoch = cfg.currentEpoch;
        setConfigEpoch(cfg.currentEpoch);
        setConfigEndMs((cfg.currentEpochStart + cfg.currentEpochDuration) * 1000);
        setConfigDurationDays(Math.round(cfg.currentEpochDuration / 86_400));
      }

      // Fetch current epoch's AuctionState (for epoch-level stats)
      const auctionPda = getAuctionPda(activeEpoch);
      const auctionInfo = await conn.getAccountInfo(auctionPda);
      if (auctionInfo && auctionInfo.data.length >= 76) {
        setAuction(parseAuction(Buffer.from(auctionInfo.data)));
      } else {
        setAuction(null);
      }

      // Fetch ALL GlobalTokenBid accounts (persistent leaderboard)
      const globalBidAccounts = await conn.getProgramAccounts(ANCHOR_PROGRAM_ID, {
        filters: [{ dataSize: GLOBAL_BID_DATA_SIZE }],
      });

      const allParsed: GlobalBidInfo[] = [];
      for (const { account } of globalBidAccounts) {
        const bid = parseGlobalTokenBid(Buffer.from(account.data));
        if (bid && bid.totalAmount > BigInt(0)) allParsed.push(bid);
      }

      allParsed.sort((a, b) => (b.totalAmount > a.totalAmount ? 1 : b.totalAmount < a.totalAmount ? -1 : 0));
      setBids(allParsed);

      // Fetch token metadata for all leaderboard mints
      const mints = allParsed.map((b) => b.tokenMint);

      // Fetch past epoch winners (AuctionState accounts with status=Resolved)
      const past: AuctionInfo[] = [];
      for (let i = 1; i <= 20; i++) {
        const pastEpoch = activeEpoch - BigInt(i);
        if (pastEpoch < BigInt(0)) break;
        const pastPda = getAuctionPda(pastEpoch);
        try {
          const info = await conn.getAccountInfo(pastPda);
          if (info && info.data.length >= 76) {
            const a = parseAuction(Buffer.from(info.data));
            if (a && a.status === 1) past.push(a);
          }
        } catch { /* skip */ }
      }
      setPastAuctions(past);

      // Fetch GlobalBidContribution accounts (90 bytes) for top anchor votes
      try {
        const contribAccounts = await conn.getProgramAccounts(ANCHOR_PROGRAM_ID, {
          filters: [{ dataSize: GLOBAL_CONTRIB_DATA_SIZE }],
        });
        const voteMap = new Map<string, bigint>(); // vote value → total SOL weight
        for (const { account } of contribAccounts) {
          const data = Buffer.from(account.data);
          if (data.length < 90) continue;
          const amount = data.readBigUInt64LE(72);
          const optionTag = data.readUInt8(80);
          if (optionTag !== 1 || amount === BigInt(0)) continue;
          const vote = data.readBigUInt64LE(81);
          if (vote === BigInt(0)) continue;
          const key = vote.toString();
          voteMap.set(key, (voteMap.get(key) || BigInt(0)) + amount);
        }
        const sorted = Array.from(voteMap.entries())
          .map(([v, w]) => ({ vote: BigInt(v), weight: w }))
          .sort((a, b) => (b.weight > a.weight ? 1 : b.weight < a.weight ? -1 : 0))
          .slice(0, 5);
        setTopVotes(sorted);
      } catch (e) {
        console.warn('[Auction] Failed to fetch anchor votes:', e);
      }

      // Collect winner mints for metadata
      const winnerMints = past
        .filter((a) => a.winningMint !== '11111111111111111111111111111111')
        .map((a) => a.winningMint);
      const allMints = Array.from(new Set([...mints, ...winnerMints]));
      if (allMints.length > 0) {
        const metaMap = await fetchTokenMetaBatch(allMints);
        setTokenMetas((prev) => ({ ...prev, ...metaMap }));
      }
    } catch (e) {
      console.warn('Auction fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, [conn, currentEpoch]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 30_000);
    return () => clearInterval(id);
  }, [fetchData]);

  // Place bid (full form or quick-add)
  const submitBid = async (mintStr: string, solAmount: number) => {
    if (!publicKey || !connected) {
      setBidStatus('Connect wallet first');
      return;
    }

    setBidding(true);
    setBidStatus(null);
    try {
      const mint = new PublicKey(mintStr);
      const amountLamports = BigInt(Math.floor(solAmount * 1e9));

      // Pre-validate: check the mint is a real SPL token on-chain
      const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const TOKEN_2022_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
      const mintAcct = await conn.getAccountInfo(mint);
      if (!mintAcct) {
        setBidStatus('Error: Account not found — enter a valid token mint address');
        setBidding(false);
        return;
      }
      if (mintAcct.owner.toBase58() === TOKEN_2022_ID) {
        setBidStatus('Error: Token-2022 mints are not currently supported');
        setBidding(false);
        return;
      }
      if (mintAcct.owner.toBase58() !== TOKEN_PROGRAM_ID) {
        setBidStatus('Error: Not a valid SPL token mint');
        setBidding(false);
        return;
      }
      if (mintAcct.data.length < 82 || mintAcct.data[45] !== 1) {
        setBidStatus('Error: Not an initialized SPL token mint');
        setBidding(false);
        return;
      }
      // Check freeze authority (bytes 46-49 = COption tag, 0 = None)
      const freezeTag = mintAcct.data[46] | (mintAcct.data[47] << 8) | (mintAcct.data[48] << 16) | (mintAcct.data[49] << 24);
      if (freezeTag !== 0) {
        setBidStatus('Error: Token has freeze authority — not allowed');
        setBidding(false);
        return;
      }

      const anchorVoteBigint = anchorVote ? BigInt(Math.floor(parseFloat(anchorVote))) : undefined;
      const ix = buildPlaceBidInstruction(publicKey, mint, amountLamports, currentEpoch, anchorVoteBigint);

      const { blockhash } = await conn.getLatestBlockhash();
      const { Transaction } = await import('@solana/web3.js');
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: publicKey });
      tx.add(ix);

      const sig = await sendTransaction(tx, conn);
      await conn.confirmTransaction(sig, 'confirmed');
      if (anchorVote) {
        console.log(`[Auction] Anchor vote: ${anchorVote} submitted on-chain`);
      }
      setBidStatus(`Bid placed! Tx: ${sig.slice(0, 12)}...${anchorVote ? ' (anchor vote recorded)' : ''}`);
      setCandidateMint('');
      setBidAmount('');
      setAnchorVote('');
      setQuickAddMint(null);
      setQuickAddAmt('');
      fetchData();
    } catch (e: any) {
      setBidStatus(`Error: ${e?.message?.slice(0, 80) || 'Unknown error'}`);
    } finally {
      setBidding(false);
    }
  };

  const handleBid = () => {
    if (!candidateMint || candidateMint.length < 32) {
      setBidStatus('Enter a valid token mint address');
      return;
    }
    const amount = parseFloat(bidAmount);
    if (!amount || amount <= 0) {
      setBidStatus('Enter a valid bid amount');
      return;
    }
    submitBid(candidateMint, amount);
  };

  const handleQuickAdd = (mint: string) => {
    const amount = parseFloat(quickAddAmt);
    if (!amount || amount <= 0) {
      setBidStatus('Enter a valid SOL amount');
      return;
    }
    submitBid(mint, amount);
  };

  // Focus input when quick-add opens
  useEffect(() => {
    if (quickAddMint && quickAddRef.current) quickAddRef.current.focus();
  }, [quickAddMint]);

  const topBid = bids.length > 0 ? bids[0] : null;
  const configStartMs = configEndMs && configDurationDays ? configEndMs - configDurationDays * 86_400_000 : null;
  const dateRange = epochDateRange(currentEpoch, configStartMs, configEndMs);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <main className="max-w-4xl mx-auto px-3 sm:px-4 py-6 sm:py-8 space-y-5 sm:space-y-8 pb-16">
        {/* Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">
            <span className="text-cyan-400">Token Listing</span> Auctions
          </h1>
          <p className="text-gray-400 mt-1.5 sm:mt-2 text-sm sm:text-base">
            Bid SOL to get tokens listed for cash games. Bids are persistent — they carry across epochs.
            At epoch end, #1 on the leaderboard gets listed and removed. Everyone else carries forward.
          </p>
        </div>

        {/* Current Epoch Card */}
        <div className="rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/5 to-transparent p-4 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-xs text-gray-500 uppercase tracking-wider">Current Auction ({configDurationDays}d epoch)</div>
              <div className="text-lg sm:text-2xl font-bold text-cyan-400">{dateRange}</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500 uppercase tracking-wider">Time Remaining</div>
              <div className="text-lg sm:text-2xl font-bold text-amber-400 font-mono">{countdown}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3">
              <div className="text-xs text-gray-500">Total SOL Bid</div>
              <div className="text-lg font-bold text-cyan-300">
                {bids.length > 0 ? formatSol(bids.reduce((sum, b) => sum + b.totalAmount, BigInt(0))) : '0'} SOL
              </div>
            </div>
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3">
              <div className="text-xs text-gray-500">Top Bid</div>
              <div className="text-lg font-bold text-amber-300">
                {topBid ? formatSol(topBid.totalAmount) : '0'} SOL
              </div>
              {topBid && tokenMetas[topBid.tokenMint] && (
                <div className="text-xs text-gray-500 truncate">{tokenMetas[topBid.tokenMint].symbol}</div>
              )}
            </div>
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3">
              <div className="text-xs text-gray-500">Tokens Competing</div>
              <div className="text-lg font-bold text-emerald-300">
                {bids.length}
              </div>
            </div>
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3">
              <div className="text-xs text-gray-500">Status</div>
              <div className={`text-lg font-bold ${
                !auction ? 'text-gray-500' :
                auction.status === 0 ? 'text-emerald-400' : 'text-purple-400'
              }`}>
                {!auction ? 'No bids yet' : auction.status === 0 ? 'Active' : 'Resolved'}
              </div>
            </div>
          </div>
        </div>

        {/* Place Bid Section */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 sm:p-6">
          <h2 className="text-base sm:text-lg font-bold text-white mb-3 sm:mb-4">Place a Bid</h2>
          <p className="text-xs sm:text-sm text-gray-400 mb-3 sm:mb-4">
            Enter the SPL token mint you want listed, and how much SOL to bid.
            SOL is split 50/50 between treasury and staker rewards. No refunds.
          </p>

          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 uppercase tracking-wider block mb-1">Token Mint Address</label>
              <input
                type="text"
                value={candidateMint}
                onChange={(e) => setCandidateMint(e.target.value.trim())}
                placeholder="e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                className="w-full px-4 py-2.5 rounded-xl bg-gray-900 border border-white/[0.08] text-white placeholder-gray-600 text-sm font-mono focus:outline-none focus:border-cyan-500/40"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 uppercase tracking-wider block mb-1">SOL Amount</label>
                <input
                  type="number"
                  value={bidAmount}
                  onChange={(e) => setBidAmount(e.target.value)}
                  placeholder="0.1"
                  min="0.001"
                  step="0.001"
                  className="w-full px-4 py-2.5 rounded-xl bg-gray-900 border border-white/[0.08] text-white placeholder-gray-600 text-sm focus:outline-none focus:border-cyan-500/40"
                />
              </div>
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <label className="text-xs text-gray-500 uppercase tracking-wider">Anchor Vote</label>
                  <span className="text-[9px] text-cyan-400/60 font-medium">(optional)</span>
                  <div className="relative group">
                    <span className="text-gray-600 text-xs cursor-help">&#9432;</span>
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2.5 rounded-lg bg-gray-900 border border-white/10 text-[10px] leading-relaxed w-64 text-left z-50 shadow-xl whitespace-normal hidden group-hover:block">
                      <div className="text-gray-300 font-medium mb-1">Anchor Blind Vote</div>
                      <div className="text-gray-400 mb-1">Vote on the &quot;mid-tier&quot; big blind value for this token (in raw token units). All 7 rake cap tiers are derived from your anchor vote using fixed ratios.</div>
                      <div className="text-gray-500 text-[9px] mt-1">Bigger bids = more voting power (SOL-weighted median). Leave blank to skip.</div>
                    </div>
                  </div>
                </div>
                {topVotes.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    <span className="text-[9px] text-gray-600 self-center mr-0.5">Popular:</span>
                    {topVotes.map((v) => (
                      <button
                        key={v.vote.toString()}
                        type="button"
                        onClick={() => setAnchorVote(v.vote.toString())}
                        className={`px-2 py-1 rounded-lg text-[10px] font-medium transition-all ${
                          anchorVote === v.vote.toString()
                            ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                            : 'bg-white/[0.03] text-gray-400 border border-white/[0.06] hover:bg-white/[0.06] hover:text-gray-300'
                        }`}
                      >
                        {Number(v.vote).toLocaleString()}
                        <span className="ml-1 text-[8px] opacity-50">{formatSol(v.weight)}</span>
                      </button>
                    ))}
                  </div>
                )}
                <input
                  type="number"
                  value={anchorVote}
                  onChange={(e) => setAnchorVote(e.target.value)}
                  placeholder="e.g. 1000000 (or click a popular vote above)"
                  min="0"
                  className="w-full px-4 py-2.5 rounded-xl bg-gray-900 border border-white/[0.08] text-white placeholder-gray-600 text-sm focus:outline-none focus:border-cyan-500/40"
                />
              </div>
            </div>
            <button
              onClick={handleBid}
              disabled={bidding || !connected}
              className={`w-full px-6 py-2.5 rounded-xl font-bold text-sm transition-all ${
                bidding || !connected
                  ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                  : 'bg-gradient-to-r from-cyan-500 to-emerald-500 text-white hover:from-cyan-400 hover:to-emerald-400 shadow-lg shadow-cyan-500/20'
              }`}
            >
              {bidding ? 'Bidding...' : `Bid ${bidAmount ? bidAmount + ' SOL' : 'SOL'}${anchorVote ? ' + Anchor Vote' : ''}`}
            </button>
            {bidStatus && (
              <div className={`text-sm px-3 py-2 rounded-lg ${
                bidStatus.startsWith('Error') ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'
              }`}>
                {bidStatus}
              </div>
            )}
          </div>
        </div>

        {/* Current Bids Leaderboard */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 sm:p-6">
          <h2 className="text-base sm:text-lg font-bold text-white mb-3 sm:mb-4">
            Leaderboard
            <span className="text-xs text-gray-500 font-normal ml-2">(persistent — carries across epochs)</span>
          </h2>

          {loading ? (
            <div className="text-gray-500 text-sm py-8 text-center">Loading bids...</div>
          ) : bids.length === 0 ? (
            <div className="text-gray-500 text-sm py-8 text-center">
              No bids yet. Be the first to bid for a token listing!
            </div>
          ) : (
            <div className="space-y-2">
              {bids.map((bid, idx) => {
                const meta = tokenMetas[bid.tokenMint];
                const isQuickOpen = quickAddMint === bid.tokenMint;
                return (
                  <div key={bid.tokenMint}>
                    <div
                      className={`p-3 rounded-xl border transition-all ${
                        idx === 0
                          ? 'border-amber-500/30 bg-amber-500/[0.05]'
                          : 'border-white/[0.06] bg-white/[0.02]'
                      }`}
                    >
                      <div className="flex items-center gap-2 sm:gap-3">
                        <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-xs sm:text-sm font-bold shrink-0 ${
                          idx === 0 ? 'bg-amber-500/20 text-amber-400' :
                          idx === 1 ? 'bg-gray-400/20 text-gray-300' :
                          idx === 2 ? 'bg-orange-600/20 text-orange-400' :
                          'bg-white/[0.05] text-gray-500'
                        }`}>
                          #{idx + 1}
                        </div>
                        {/* Token image */}
                        {meta?.logoURI ? (
                          <img
                            src={meta.logoURI}
                            alt={meta.symbol}
                            width={32}
                            height={32}
                            className="w-7 h-7 sm:w-8 sm:h-8 rounded-full shrink-0 bg-gray-800"
                          />
                        ) : (
                          <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gray-800 shrink-0 flex items-center justify-center text-xs text-gray-500">?</div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-xs sm:text-sm font-semibold text-gray-200 truncate max-w-[120px] sm:max-w-none">
                              {meta ? meta.name : short(bid.tokenMint)}
                            </span>
                            {meta?.symbol && (
                              <span className="text-[10px] sm:text-xs text-gray-500">${meta.symbol}</span>
                            )}
                            {meta?.verified && (
                              <span className="inline-flex items-center justify-center w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full bg-blue-500 shrink-0" title="JUP Verified">
                                <svg viewBox="0 0 16 16" fill="none" className="w-2.5 h-2.5 sm:w-3 sm:h-3">
                                  <path d="M6.5 11.5L3 8l1-1 2.5 2.5L12 4l1 1-6.5 6.5z" fill="white"/>
                                </svg>
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] sm:text-xs text-gray-500">{bid.bidderCount} bidder{bid.bidderCount !== 1 ? 's' : ''} · <span className="font-mono">{short(bid.tokenMint)}</span></div>
                        </div>
                        <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-auto">
                          <div className="text-right">
                            <div className="text-xs sm:text-sm font-bold text-cyan-300">{formatSol(bid.totalAmount)} SOL</div>
                            {auction && auction.totalBid > BigInt(0) && (
                              <div className="text-[10px] sm:text-xs text-gray-500">
                                {(Number(bid.totalAmount) * 100 / Number(auction.totalBid)).toFixed(1)}%
                              </div>
                            )}
                          </div>
                          {/* Quick Add button */}
                          <button
                            onClick={() => {
                              setQuickAddMint(isQuickOpen ? null : bid.tokenMint);
                              setQuickAddAmt('');
                            }}
                            className={`px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-[10px] sm:text-xs font-bold transition-all ${
                              isQuickOpen
                                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/25'
                            }`}
                            title="Add SOL to this bid"
                          >
                            + Add
                          </button>
                        </div>
                      </div>
                    </div>
                    {/* Quick-add inline form */}
                    {isQuickOpen && (
                      <div className="flex items-center gap-2 mt-1 ml-11 mr-1">
                        <input
                          ref={quickAddRef}
                          type="number"
                          value={quickAddAmt}
                          onChange={(e) => setQuickAddAmt(e.target.value)}
                          placeholder="SOL amount"
                          min="0.001"
                          step="0.001"
                          className="flex-1 px-3 py-1.5 rounded-lg bg-gray-900 border border-white/[0.08] text-white placeholder-gray-600 text-xs focus:outline-none focus:border-cyan-500/40"
                          onKeyDown={(e) => e.key === 'Enter' && handleQuickAdd(bid.tokenMint)}
                        />
                        {[0.05, 0.1, 0.5].map((v) => (
                          <button
                            key={v}
                            onClick={() => setQuickAddAmt(v.toString())}
                            className="px-2 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-gray-400 hover:text-white hover:bg-white/[0.08] transition-colors"
                          >
                            {v}
                          </button>
                        ))}
                        <button
                          onClick={() => handleQuickAdd(bid.tokenMint)}
                          disabled={bidding || !connected}
                          className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 text-white text-xs font-bold hover:from-cyan-400 hover:to-emerald-400 disabled:opacity-40 transition-all"
                        >
                          {bidding ? '...' : 'Bid'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Past Winners */}
        {pastAuctions.length > 0 && (
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6">
            <h2 className="text-lg font-bold text-white mb-4">Past Epoch Winners</h2>
            <div className="space-y-2">
              {pastAuctions.map((a) => {
                const hasWinner = a.winningMint !== '11111111111111111111111111111111';
                const wMeta = hasWinner ? tokenMetas[a.winningMint] : null;
                return (
                  <div
                    key={a.epoch.toString()}
                    className="flex items-center justify-between p-3 rounded-xl border border-white/[0.06] bg-white/[0.02]"
                  >
                    <div className="flex items-center gap-3">
                      <div className="text-xs text-gray-500 w-20 shrink-0">Epoch {a.epoch.toString()}</div>
                      {hasWinner && wMeta?.logoURI ? (
                        <img src={wMeta.logoURI} alt={wMeta.symbol} className="w-6 h-6 rounded-full shrink-0" />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-gray-800 shrink-0" />
                      )}
                      <div>
                        <span className="text-sm font-medium text-emerald-300">
                          {hasWinner ? (wMeta ? wMeta.name : short(a.winningMint)) : 'No winner'}
                        </span>
                        {wMeta?.verified && (
                          <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-blue-500 ml-1 align-middle">
                            <svg viewBox="0 0 16 16" fill="none" className="w-2.5 h-2.5"><path d="M6.5 11.5L3 8l1-1 2.5 2.5L12 4l1 1-6.5 6.5z" fill="white"/></svg>
                          </span>
                        )}
                        <span className="text-[10px] text-emerald-400/70 font-bold ml-2">LISTED</span>
                      </div>
                    </div>
                    <div className="text-xs text-gray-500">{formatSol(a.totalBid)} SOL deposited</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Info */}
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-xs text-gray-500 space-y-1">
          <div><strong className="text-gray-400">How it works:</strong> Each auction epoch, the token at the top of the leaderboard gets listed for cash games.</div>
          <div>Anyone can bid SOL for any SPL token mint. All tokens stay on the leaderboard — #1 at epoch end wins.</div>
          <div>Epoch duration adapts: high demand shortens it (min 1 day), low demand lengthens it (max 7 days).</div>
          <div>Bids are split 50/50: half to treasury, half to staker rewards. No refunds.</div>
          <div>Everything is fully permissionless and enforced by the contract — no admin keys needed.</div>
        </div>
      </main>
    </div>
  );
}
