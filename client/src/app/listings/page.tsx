'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { L1_RPC, ANCHOR_PROGRAM_ID, RAKE_CAP_TIERS } from '@/lib/constants';
import {
  LISTED_TOKEN_DATA_SIZE,
  parseListedToken,
  getTierConfigPda,
} from '@/lib/onchain-game';
import Link from 'next/link';

// TokenTierConfig layout (230 bytes):
// 8 disc + 32 token_mint + 56 tier_boundaries + 84 cap_bps + 8 min_bb + 1 community_governed + 8 updated_at + 32 authority + 1 bump
const TIER_CONFIG_SIZE = 230;
const TIER_BOUNDARIES_OFFSET = 40; // 8 disc + 32 mint
const CAP_BPS_OFFSET = 96;         // 40 + 56 (7 × u64)
const MIN_BB_OFFSET = 180;         // 96 + 84 (21 × u32)
const COMMUNITY_OFFSET = 188;      // 180 + 8
const UPDATED_AT_OFFSET = 189;     // 188 + 1

interface ListedTokenInfo {
  tokenMint: string;
  winningEpoch: bigint;
  listedAt: number;
  tierConfig: TierConfigInfo | null;
}

interface TierConfigInfo {
  tierBoundaries: bigint[];
  capBps: number[][];  // [tier][tableType]
  minBb: bigint;
  communityGoverned: boolean;
  updatedAt: number;
}

interface TokenMeta {
  name: string;
  symbol: string;
  logoURI: string | null;
}

const metaCache = new Map<string, TokenMeta>();

async function fetchTokenMetaBatch(mints: string[]): Promise<Record<string, TokenMeta>> {
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
    } catch {}
  }
  const result: Record<string, TokenMeta> = {};
  for (const m of mints) {
    result[m] = metaCache.get(m) || { name: m.slice(0, 8) + '...', symbol: '???', logoURI: null };
  }
  return result;
}

function parseTierConfig(data: Buffer): TierConfigInfo | null {
  if (data.length < TIER_CONFIG_SIZE) return null;
  const tierBoundaries: bigint[] = [];
  for (let i = 0; i < 7; i++) {
    tierBoundaries.push(data.readBigUInt64LE(TIER_BOUNDARIES_OFFSET + i * 8));
  }
  const capBps: number[][] = [];
  for (let tier = 0; tier < 7; tier++) {
    const row: number[] = [];
    for (let type = 0; type < 3; type++) {
      row.push(data.readUInt32LE(CAP_BPS_OFFSET + (tier * 3 + type) * 4));
    }
    capBps.push(row);
  }
  return {
    tierBoundaries,
    capBps,
    minBb: data.readBigUInt64LE(MIN_BB_OFFSET),
    communityGoverned: data.readUInt8(COMMUNITY_OFFSET) === 1,
    updatedAt: Number(data.readBigInt64LE(UPDATED_AT_OFFSET)),
  };
}

function formatUnits(val: bigint): string {
  const n = Number(val);
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

const TIER_NAMES = RAKE_CAP_TIERS.map(t => t.name);
const TABLE_TYPE_LABELS = ['HU', '6-Max', '9-Max'];

export default function ListingsPage() {
  const conn = useMemo(() => new Connection(L1_RPC, 'confirmed'), []);
  const [listings, setListings] = useState<ListedTokenInfo[]>([]);
  const [tokenMetas, setTokenMetas] = useState<Record<string, TokenMeta>>({});
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      // Fetch all ListedToken accounts
      const listedAccounts = await conn.getProgramAccounts(ANCHOR_PROGRAM_ID, {
        filters: [{ dataSize: LISTED_TOKEN_DATA_SIZE }],
      });

      const parsed: ListedTokenInfo[] = [];
      for (const { account } of listedAccounts) {
        const lt = parseListedToken(Buffer.from(account.data));
        if (!lt) continue;

        // Try to fetch TokenTierConfig for this token
        let tierConfig: TierConfigInfo | null = null;
        try {
          const tcPda = getTierConfigPda(new PublicKey(lt.tokenMint));
          const tcInfo = await conn.getAccountInfo(tcPda);
          if (tcInfo && tcInfo.data.length >= TIER_CONFIG_SIZE) {
            tierConfig = parseTierConfig(Buffer.from(tcInfo.data));
          }
        } catch {}

        parsed.push({
          tokenMint: lt.tokenMint,
          winningEpoch: lt.winningEpoch,
          listedAt: lt.listedAt,
          tierConfig,
        });
      }

      parsed.sort((a, b) => b.listedAt - a.listedAt);
      setListings(parsed);

      // Fetch metadata
      const mints = parsed.map(l => l.tokenMint);
      if (mints.length > 0) {
        const metas = await fetchTokenMetaBatch(mints);
        setTokenMetas(metas);
      }
    } catch (e) {
      console.warn('Listings fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, [conn]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="max-w-5xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Listed Tokens</h1>
            <p className="text-sm text-gray-500 mt-1">Tokens approved for cash game tables via auction</p>
          </div>
          <Link
            href="/auctions"
            className="px-4 py-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-sm font-medium hover:bg-cyan-500/20 transition-colors"
          >
            View Auctions
          </Link>
        </div>

        {loading ? (
          <div className="text-center py-20 text-gray-500">Loading listings...</div>
        ) : listings.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-4xl mb-3">🪙</div>
            <p className="text-gray-400">No tokens listed yet</p>
            <p className="text-gray-600 text-sm mt-1">Win an auction to get your token listed</p>
          </div>
        ) : (
          <div className="space-y-4">
            {listings.map((listing) => {
              const meta = tokenMetas[listing.tokenMint];
              const listedDate = new Date(listing.listedAt * 1000).toLocaleDateString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric',
              });
              const tc = listing.tierConfig;

              return (
                <div
                  key={listing.tokenMint}
                  className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 hover:bg-white/[0.04] transition-colors"
                >
                  {/* Token header */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      {meta?.logoURI && (
                        <img src={meta.logoURI} alt="" className="w-8 h-8 rounded-full" />
                      )}
                      <div>
                        <span className="text-white font-bold text-lg">{meta?.symbol || '???'}</span>
                        <span className="text-gray-500 text-sm ml-2">{meta?.name}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-gray-600">Listed {listedDate}</div>
                      <div className="text-[10px] text-gray-700 font-mono">{listing.tokenMint.slice(0, 12)}...</div>
                    </div>
                  </div>

                  {/* Tier config */}
                  {tc ? (
                    <div className="mt-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs text-gray-400 font-medium">Rake Cap Tiers</span>
                        {tc.communityGoverned && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-cyan-500/10 text-cyan-400/70 border border-cyan-500/15">
                            Community Governed
                          </span>
                        )}
                        <span className="text-[9px] text-gray-600">
                          Min BB: {formatUnits(tc.minBb)}
                        </span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-[10px]">
                          <thead>
                            <tr className="text-gray-600">
                              <th className="text-left py-1 pr-3">Tier</th>
                              <th className="text-right py-1 px-2">Max BB</th>
                              {TABLE_TYPE_LABELS.map(l => (
                                <th key={l} className="text-right py-1 px-2">{l} Cap</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {TIER_NAMES.map((name, i) => {
                              const tierColor = RAKE_CAP_TIERS[i];
                              const boundary = tc.tierBoundaries[i];
                              const isMax = boundary === BigInt('18446744073709551615');
                              return (
                                <tr key={name} className="border-t border-white/[0.03]">
                                  <td className={`py-1 pr-3 font-medium ${tierColor.color}`}>{name}</td>
                                  <td className="text-right py-1 px-2 text-gray-400">
                                    {isMax ? '∞' : formatUnits(boundary)}
                                  </td>
                                  {[0, 1, 2].map(type => {
                                    const bps = tc.capBps[i][type];
                                    const bbCap = bps === 0 ? 'None' : `${(bps / 10000).toFixed(bps % 10000 === 0 ? 0 : 1)} BB`;
                                    return (
                                      <td key={type} className="text-right py-1 px-2 text-gray-500">
                                        {bbCap}
                                      </td>
                                    );
                                  })}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 px-3 py-2 rounded-lg bg-amber-500/[0.06] border border-amber-500/15">
                      <span className="text-amber-400 text-xs">No tier config set — community anchor vote pending</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
