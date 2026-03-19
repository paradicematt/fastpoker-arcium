'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import Link from 'next/link';
import {
  L1_RPC,
  ANCHOR_PROGRAM_ID,
  DEALER_REGISTRY_SEED,
  DEALER_LICENSE_SEED,
  DEALER_LICENSE_BASE_PRICE,
  DEALER_LICENSE_INCREMENT,
  DEALER_LICENSE_MAX_PRICE,
  TREASURY,
  POOL_PDA,
  STEEL_PROGRAM_ID,
} from '@/lib/constants';

const PROGRAM_ID = new PublicKey(ANCHOR_PROGRAM_ID);

// Anchor discriminator for purchase_dealer_license (sha256('global:purchase_dealer_license')[0..8])
const PURCHASE_DISC = Buffer.from([67, 26, 163, 170, 5, 108, 229, 155]);

// DealerRegistry layout: 8 disc + 32 authority + 4 total_sold + 8 total_revenue + 1 bump = 53
const REGISTRY_AUTHORITY_OFFSET = 8;
const REGISTRY_TOTAL_SOLD_OFFSET = 40;
const REGISTRY_TOTAL_REVENUE_OFFSET = 44;

// DealerLicense layout: 8 disc + 32 wallet + 4 license_number + 8 purchased_at + 8 price_paid + 1 bump = 61
const LICENSE_WALLET_OFFSET = 8;
const LICENSE_NUMBER_OFFSET = 40;
const LICENSE_PURCHASED_AT_OFFSET = 44;
const LICENSE_PRICE_PAID_OFFSET = 52;

function getRegistryPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(DEALER_REGISTRY_SEED)],
    PROGRAM_ID
  );
}

function getLicensePda(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(DEALER_LICENSE_SEED), wallet.toBuffer()],
    PROGRAM_ID
  );
}

function calcPrice(totalSold: number): number {
  const price = DEALER_LICENSE_BASE_PRICE + totalSold * DEALER_LICENSE_INCREMENT;
  return Math.min(price, DEALER_LICENSE_MAX_PRICE);
}

function formatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(lamports >= LAMPORTS_PER_SOL ? 2 : 4);
}

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

interface RegistryState {
  authority: string;
  totalSold: number;
  totalRevenue: number;
}

interface LicenseState {
  wallet: string;
  licenseNumber: number;
  purchasedAt: number;
  pricePaid: number;
}

// ─── Bonding Curve Chart (SVG) ───
function BondingCurveChart({ totalSold }: { totalSold: number }) {
  const points = 100;
  const maxLicenses = 9900; // when price hits 100 SOL cap
  const w = 400;
  const h = 120;
  const padding = { top: 10, right: 10, bottom: 20, left: 40 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;

  const pathData = useMemo(() => {
    const pts: string[] = [];
    for (let i = 0; i <= points; i++) {
      const sold = (i / points) * maxLicenses;
      const price = Math.min(
        DEALER_LICENSE_BASE_PRICE + sold * DEALER_LICENSE_INCREMENT,
        DEALER_LICENSE_MAX_PRICE
      );
      const x = padding.left + (i / points) * chartW;
      const y =
        padding.top +
        chartH -
        (price / DEALER_LICENSE_MAX_PRICE) * chartH;
      pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return pts.join(' ');
  }, []);

  // Current position dot
  const currentX =
    padding.left + Math.min(totalSold / maxLicenses, 1) * chartW;
  const currentPrice = calcPrice(totalSold);
  const currentY =
    padding.top +
    chartH -
    (currentPrice / DEALER_LICENSE_MAX_PRICE) * chartH;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto">
      {/* Grid lines */}
      {[0, 25, 50, 75, 100].map((pct) => {
        const y = padding.top + chartH - (pct / 100) * chartH;
        return (
          <g key={pct}>
            <line
              x1={padding.left}
              y1={y}
              x2={w - padding.right}
              y2={y}
              stroke="rgba(255,255,255,0.04)"
              strokeWidth={0.5}
            />
            <text
              x={padding.left - 4}
              y={y + 3}
              textAnchor="end"
              fill="rgba(255,255,255,0.25)"
              fontSize="7"
              fontFamily="monospace"
            >
              {pct}
            </text>
          </g>
        );
      })}
      {/* Curve */}
      <path d={pathData} fill="none" stroke="rgba(6,182,212,0.5)" strokeWidth={1.5} />
      {/* Filled area under curve up to current position */}
      <path
        d={`${pathData.split('L').slice(0, Math.max(1, Math.floor((totalSold / maxLicenses) * points) + 1)).join('L')} L${currentX.toFixed(1)},${(padding.top + chartH).toFixed(1)} L${padding.left},${(padding.top + chartH).toFixed(1)} Z`}
        fill="rgba(6,182,212,0.08)"
      />
      {/* Current dot */}
      <circle cx={currentX} cy={currentY} r={3.5} fill="#06b6d4" />
      <circle cx={currentX} cy={currentY} r={6} fill="none" stroke="rgba(6,182,212,0.4)" strokeWidth={1} />
      {/* X axis label */}
      <text
        x={w / 2}
        y={h - 2}
        textAnchor="middle"
        fill="rgba(255,255,255,0.25)"
        fontSize="7"
        fontFamily="monospace"
      >
        Licenses Sold
      </text>
      {/* Y axis label */}
      <text
        x={2}
        y={h / 2}
        textAnchor="middle"
        fill="rgba(255,255,255,0.25)"
        fontSize="7"
        fontFamily="monospace"
        transform={`rotate(-90 8 ${h / 2})`}
      >
        SOL
      </text>
    </svg>
  );
}

export default function DealerLicensePage() {
  const { publicKey, signTransaction, connected } = useWallet();
  const [registry, setRegistry] = useState<RegistryState | null>(null);
  const [ownLicense, setOwnLicense] = useState<LicenseState | null>(null);
  const [customWallet, setCustomWallet] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [customLicense, setCustomLicense] = useState<LicenseState | null>(null);
  const [checkingCustom, setCheckingCustom] = useState(false);
  const [purchasing, setPurchasing] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  const conn = useMemo(() => new Connection(L1_RPC, 'confirmed'), []);

  // Fetch registry state
  const fetchRegistry = useCallback(async () => {
    try {
      const [registryPda] = getRegistryPda();
      const info = await conn.getAccountInfo(registryPda);
      if (!info || info.data.length < 53) {
        setRegistry(null);
        setLoading(false);
        return;
      }
      const data = info.data;
      const authority = new PublicKey(data.slice(REGISTRY_AUTHORITY_OFFSET, REGISTRY_AUTHORITY_OFFSET + 32)).toBase58();
      const totalSold = data.readUInt32LE(REGISTRY_TOTAL_SOLD_OFFSET);
      const totalRevenue = Number(data.readBigUInt64LE(REGISTRY_TOTAL_REVENUE_OFFSET));
      setRegistry({ authority, totalSold, totalRevenue });
    } catch (e) {
      console.error('Failed to fetch registry:', e);
      setRegistry(null);
    }
    setLoading(false);
  }, [conn]);

  // Check if a wallet has a license
  const checkLicense = useCallback(
    async (wallet: PublicKey): Promise<LicenseState | null> => {
      try {
        const [pda] = getLicensePda(wallet);
        const info = await conn.getAccountInfo(pda);
        if (!info || info.data.length < 61) return null;
        const data = info.data;
        return {
          wallet: new PublicKey(data.slice(LICENSE_WALLET_OFFSET, LICENSE_WALLET_OFFSET + 32)).toBase58(),
          licenseNumber: data.readUInt32LE(LICENSE_NUMBER_OFFSET),
          purchasedAt: Number(data.readBigInt64LE(LICENSE_PURCHASED_AT_OFFSET)),
          pricePaid: Number(data.readBigUInt64LE(LICENSE_PRICE_PAID_OFFSET)),
        };
      } catch {
        return null;
      }
    },
    [conn]
  );

  // Fetch own license + balance
  useEffect(() => {
    if (!publicKey) {
      setOwnLicense(null);
      setSolBalance(0);
      return;
    }
    (async () => {
      const [lic, bal] = await Promise.all([
        checkLicense(publicKey),
        conn.getBalance(publicKey).catch(() => 0),
      ]);
      setOwnLicense(lic);
      setSolBalance(bal);
    })();
  }, [publicKey, checkLicense, conn, registry]);

  useEffect(() => {
    fetchRegistry();
    const iv = setInterval(fetchRegistry, 10_000);
    return () => clearInterval(iv);
  }, [fetchRegistry]);

  // Check custom wallet license
  useEffect(() => {
    if (!useCustom || !customWallet) {
      setCustomLicense(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setCheckingCustom(true);
        const pk = new PublicKey(customWallet);
        const lic = await checkLicense(pk);
        if (!cancelled) setCustomLicense(lic);
      } catch {
        if (!cancelled) setCustomLicense(null);
      } finally {
        if (!cancelled) setCheckingCustom(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customWallet, useCustom, checkLicense]);

  // Determine target wallet
  const targetWallet = useMemo(() => {
    if (useCustom && customWallet) {
      try {
        return new PublicKey(customWallet);
      } catch {
        return null;
      }
    }
    return publicKey;
  }, [useCustom, customWallet, publicKey]);

  const targetHasLicense = useCustom ? customLicense : ownLicense;
  const currentPrice = registry ? calcPrice(registry.totalSold) : DEALER_LICENSE_BASE_PRICE;
  const canAfford = solBalance >= currentPrice + 10_000_000; // +0.01 SOL for fees/rent

  // Purchase handler
  const handlePurchase = useCallback(async () => {
    if (!publicKey || !signTransaction || !targetWallet || !registry) return;
    setError(null);
    setTxSig(null);
    setPurchasing(true);

    try {
      const [registryPda] = getRegistryPda();
      const [licensePda] = getLicensePda(targetWallet);

      // Build purchase_dealer_license instruction
      // Accounts: buyer(signer,mut), beneficiary, registry(mut), license(init), treasury(mut), steel_pool(mut), steel_program, system_program
      const keys = [
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: targetWallet, isSigner: false, isWritable: false },
        { pubkey: registryPda, isSigner: false, isWritable: true },
        { pubkey: licensePda, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: POOL_PDA, isSigner: false, isWritable: true },
        { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];

      const ix = {
        programId: PROGRAM_ID,
        keys,
        data: Buffer.from(PURCHASE_DISC),
      };

      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

      const signed = await signTransaction(tx);
      const sig = await conn.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
      });
      await conn.confirmTransaction(sig, 'confirmed');

      setTxSig(sig);
      // Refresh data
      await fetchRegistry();
      if (targetWallet.equals(publicKey)) {
        const lic = await checkLicense(publicKey);
        setOwnLicense(lic);
      }
    } catch (e: any) {
      console.error('Purchase failed:', e);
      setError(e?.message || 'Transaction failed');
    } finally {
      setPurchasing(false);
    }
  }, [publicKey, signTransaction, targetWallet, registry, conn, fetchRegistry, checkLicense]);

  const isCustomValid = useMemo(() => {
    if (!customWallet) return false;
    try {
      new PublicKey(customWallet);
      return true;
    } catch {
      return false;
    }
  }, [customWallet]);

  // ─── Render ───
  return (
    <div className="min-h-screen">
      {/* Hero */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-cyan-500/[0.04] via-transparent to-transparent" />
        <div className="absolute top-20 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-cyan-500/[0.06] rounded-full blur-[120px]" />

        <div className="relative max-w-3xl mx-auto px-4 pt-16 pb-8 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-xs font-medium mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            Now Available
          </div>

          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
            <span className="text-white">Dealer</span>{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-emerald-400">
              License
            </span>
          </h1>

          <p className="text-gray-400 text-base sm:text-lg max-w-xl mx-auto leading-relaxed">
            Become a licensed dealer on Fast Poker. Earn{' '}
            <span className="text-cyan-300 font-medium">25% of cash game rake</span> and{' '}
            <span className="text-emerald-300 font-medium">45% of SNG tournament fees</span>{' '}
            by running crank operations for the network.
          </p>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 pb-20 space-y-6">
        {/* Stats Row */}
        {registry && (
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-center">
              <div className="text-2xl font-bold text-cyan-400 tabular-nums">
                {registry.totalSold}
              </div>
              <div className="text-[11px] text-gray-500 mt-1">Licenses Sold</div>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-center">
              <div className="text-2xl font-bold text-emerald-400 tabular-nums">
                {formatSol(currentPrice)} SOL
              </div>
              <div className="text-[11px] text-gray-500 mt-1">Current Price</div>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-center">
              <div className="text-2xl font-bold text-amber-400 tabular-nums">
                {formatSol(registry.totalRevenue)} SOL
              </div>
              <div className="text-[11px] text-gray-500 mt-1">Total Revenue</div>
            </div>
          </div>
        )}

        {/* Progress + Bonding Curve */}
        {registry && (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-mono text-gray-500 uppercase tracking-wider">
                Bonding Curve
              </h3>
              <span className="text-xs text-gray-500 font-mono">
                Next: {formatSol(calcPrice(registry.totalSold + 1))} SOL
              </span>
            </div>

            {/* Progress bar */}
            <div className="mb-4">
              <div className="h-2 rounded-full bg-white/[0.04] overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-all duration-700"
                  style={{
                    width: `${Math.min((registry.totalSold / 9900) * 100, 100)}%`,
                  }}
                />
              </div>
              <div className="flex justify-between mt-1.5">
                <span className="text-[10px] text-gray-600 font-mono">1.00 SOL</span>
                <span className="text-[10px] text-gray-600 font-mono">
                  {registry.totalSold} / 9,900+
                </span>
                <span className="text-[10px] text-gray-600 font-mono">100.00 SOL</span>
              </div>
            </div>

            <BondingCurveChart totalSold={registry.totalSold} />

            <div className="mt-3 grid grid-cols-2 gap-3 text-center">
              <div className="rounded-lg bg-white/[0.02] border border-white/[0.04] py-2">
                <div className="text-xs text-gray-500">Price increases by</div>
                <div className="text-sm font-medium text-cyan-300">0.01 SOL</div>
                <div className="text-[10px] text-gray-600">per license sold</div>
              </div>
              <div className="rounded-lg bg-white/[0.02] border border-white/[0.04] py-2">
                <div className="text-xs text-gray-500">Purchase split</div>
                <div className="text-sm font-medium text-emerald-300">50 / 50</div>
                <div className="text-[10px] text-gray-600">Treasury / Staker Pool</div>
              </div>
            </div>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="text-center py-12">
            <div className="inline-block w-6 h-6 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
            <p className="text-gray-500 text-sm mt-3">Loading registry...</p>
          </div>
        )}

        {/* Registry not initialized */}
        {!loading && !registry && (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-6 text-center">
            <div className="text-amber-400 text-lg font-medium mb-2">
              Registry Not Initialized
            </div>
            <p className="text-gray-400 text-sm">
              The Dealer Registry has not been created yet. An admin needs to call{' '}
              <code className="text-xs bg-white/[0.06] px-1.5 py-0.5 rounded">
                init_dealer_registry
              </code>{' '}
              first.
            </p>
          </div>
        )}

        {/* Purchase Section */}
        {registry && (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Purchase a Dealer License</h3>

            {/* Wallet Connection */}
            {!connected ? (
              <div className="text-center py-8">
                <p className="text-gray-400 text-sm mb-4">
                  Connect your wallet to purchase a dealer license.
                </p>
                <WalletMultiButton />
              </div>
            ) : (
              <div className="space-y-4">
                {/* Connected wallet display */}
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500/20 to-emerald-500/20 border border-cyan-500/30 flex items-center justify-center">
                    <span className="text-cyan-400 text-[10px] font-bold">
                      {publicKey?.toBase58().slice(0, 2)}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-500">Connected Wallet</div>
                    <div className="text-sm text-white font-mono truncate">
                      {publicKey?.toBase58()}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-gray-500">Balance</div>
                    <div className="text-sm font-medium text-gray-300">
                      {(solBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL
                    </div>
                  </div>
                </div>

                {/* Already licensed check (own wallet) */}
                {!useCustom && ownLicense && (
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-emerald-400 text-lg">&#10003;</span>
                      <span className="text-emerald-300 font-medium">You Already Have a License</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <div className="text-xs text-gray-500">License #</div>
                        <div className="text-sm font-bold text-white">
                          {ownLicense.licenseNumber}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500">Price Paid</div>
                        <div className="text-sm font-bold text-white">
                          {ownLicense.pricePaid === 0
                            ? 'Granted'
                            : formatSol(ownLicense.pricePaid) + ' SOL'}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500">Date</div>
                        <div className="text-sm font-bold text-white">
                          {new Date(ownLicense.purchasedAt * 1000).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Toggle: Buy for self vs custom wallet */}
                {!ownLicense && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => setUseCustom(false)}
                      className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-colors border ${
                        !useCustom
                          ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                          : 'bg-white/[0.02] border-white/[0.06] text-gray-400 hover:text-white'
                      }`}
                    >
                      Buy for my wallet
                    </button>
                    <button
                      onClick={() => setUseCustom(true)}
                      className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-colors border ${
                        useCustom
                          ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                          : 'bg-white/[0.02] border-white/[0.06] text-gray-400 hover:text-white'
                      }`}
                    >
                      Buy for another wallet
                    </button>
                  </div>
                )}

                {/* Custom wallet input */}
                {useCustom && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs text-gray-500 block mb-1.5">
                        Recipient Wallet Address
                      </label>
                      <input
                        type="text"
                        value={customWallet}
                        onChange={(e) => setCustomWallet(e.target.value.trim())}
                        placeholder="Enter Solana wallet address..."
                        className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.08] text-white text-sm font-mono placeholder-gray-600 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20 transition-colors"
                      />
                      {customWallet && !isCustomValid && (
                        <p className="text-red-400 text-xs mt-1.5">
                          Invalid Solana address
                        </p>
                      )}
                      {checkingCustom && (
                        <p className="text-gray-500 text-xs mt-1.5">
                          Checking license status...
                        </p>
                      )}
                      {isCustomValid && customLicense && (
                        <p className="text-amber-400 text-xs mt-1.5">
                          This wallet already has License #{customLicense.licenseNumber}
                        </p>
                      )}
                    </div>

                    {/* Warning box */}
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4">
                      <div className="flex gap-2">
                        <span className="text-amber-400 text-base leading-none mt-0.5">&#9888;</span>
                        <div>
                          <div className="text-amber-300 text-xs font-semibold mb-1">
                            Non-Transferable License Warning
                          </div>
                          <p className="text-gray-400 text-xs leading-relaxed">
                            The Dealer License is permanently bound to the recipient wallet
                            address above. It <strong className="text-amber-300">cannot be transferred,
                            refunded, or reassigned</strong> to any other wallet.
                            <br /><br />
                            Double-check that the wallet address is correct and that the
                            recipient has access to this wallet. <strong className="text-amber-300">This
                            action cannot be undone.</strong>
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Warning for own wallet too */}
                {!useCustom && !ownLicense && (
                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <div className="flex gap-2">
                      <span className="text-gray-500 text-base leading-none mt-0.5">&#9432;</span>
                      <p className="text-gray-400 text-xs leading-relaxed">
                        The license will be permanently bound to your connected wallet{' '}
                        <code className="text-cyan-400 text-[10px] bg-white/[0.06] px-1 py-0.5 rounded">
                          {publicKey ? shortAddr(publicKey.toBase58()) : '...'}
                        </code>
                        . It is non-transferable and cannot be moved to another wallet.
                        Make sure this is the wallet you want to use as your dealer identity.
                      </p>
                    </div>
                  </div>
                )}

                {/* Price + Purchase Button */}
                {!targetHasLicense && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-gradient-to-r from-cyan-500/[0.06] to-emerald-500/[0.06] border border-cyan-500/20">
                      <div>
                        <div className="text-xs text-gray-500">License Price</div>
                        <div className="text-xl font-bold text-white">
                          {formatSol(currentPrice)}{' '}
                          <span className="text-gray-400 text-sm font-normal">SOL</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-gray-500">License #</div>
                        <div className="text-lg font-bold text-cyan-400">
                          {registry.totalSold}
                        </div>
                      </div>
                    </div>

                    {!canAfford && (
                      <div className="text-center text-red-400 text-xs py-2">
                        Insufficient balance. You need at least{' '}
                        {formatSol(currentPrice + 10_000_000)} SOL.
                      </div>
                    )}

                    <button
                      onClick={handlePurchase}
                      disabled={
                        purchasing ||
                        !canAfford ||
                        !targetWallet ||
                        (useCustom && !isCustomValid) ||
                        !!targetHasLicense
                      }
                      className={`w-full py-3.5 rounded-xl text-sm font-semibold transition-all ${
                        purchasing ||
                        !canAfford ||
                        !targetWallet ||
                        (useCustom && !isCustomValid)
                          ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                          : 'bg-gradient-to-r from-cyan-500 to-emerald-500 text-black hover:from-cyan-400 hover:to-emerald-400 shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/30'
                      }`}
                    >
                      {purchasing ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="w-4 h-4 border-2 border-gray-500/30 border-t-gray-500 rounded-full animate-spin" />
                          Purchasing...
                        </span>
                      ) : targetHasLicense ? (
                        'Already Licensed'
                      ) : (
                        `Purchase License for ${formatSol(currentPrice)} SOL`
                      )}
                    </button>

                    {useCustom && isCustomValid && targetWallet && (
                      <p className="text-center text-[10px] text-gray-600 font-mono">
                        License will be bound to: {targetWallet.toBase58()}
                      </p>
                    )}
                  </div>
                )}

                {/* TX Result */}
                {txSig && (
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4 text-center">
                    <div className="text-emerald-400 font-medium mb-1">
                      License Purchased Successfully!
                    </div>
                    <a
                      href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-cyan-400 hover:text-cyan-300 underline font-mono"
                    >
                      View on Explorer: {txSig.slice(0, 20)}...
                    </a>
                  </div>
                )}

                {error && (
                  <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-4 text-center">
                    <div className="text-red-400 text-sm font-medium mb-1">
                      Purchase Failed
                    </div>
                    <p className="text-gray-400 text-xs break-all">{error}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* What You Get section */}
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
          <h3 className="text-lg font-semibold text-white mb-4">What You Get</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              {
                icon: '\u{1F4B0}',
                title: '25% Cash Game Rake',
                desc: 'Earn 25% of all rake from user-created cash game tables you deal.',
                color: 'text-emerald-400',
              },
              {
                icon: '\u{1F3C6}',
                title: '45% SNG Tournament Fees',
                desc: 'Earn 45% of all Sit & Go tournament entry fees from tables you deal.',
                color: 'text-amber-400',
              },
              {
                icon: '\u{1F680}',
                title: 'Permissionless Operation',
                desc: 'Run your own crank. No approval needed. Earn from every hand dealt.',
                color: 'text-cyan-400',
              },
              {
                icon: '\u{1F512}',
                title: 'On-Chain Enforcement',
                desc: 'Rewards enforced by the smart contract. No trust required.',
                color: 'text-purple-400',
              },
            ].map((item) => (
              <div
                key={item.title}
                className="flex gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/[0.04]"
              >
                <span className="text-xl">{item.icon}</span>
                <div>
                  <div className={`text-sm font-medium ${item.color}`}>{item.title}</div>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* How It Works */}
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
          <h3 className="text-lg font-semibold text-white mb-4">How It Works</h3>
          <div className="space-y-3">
            {[
              {
                step: '1',
                title: 'Purchase a License',
                desc: 'Buy a non-transferable Dealer License at the current bonding curve price. Price increases by 0.01 SOL with each sale.',
              },
              {
                step: '2',
                title: 'Run a Crank',
                desc: 'Set up and run a crank service that processes game actions (deal, settle, start). Any licensed wallet can operate.',
              },
              {
                step: '3',
                title: 'Earn Rewards',
                desc: 'Your crank actions are tracked on-chain. When distribute_crank_rewards runs, your earnings are paid directly to your wallet.',
              },
            ].map((item) => (
              <div
                key={item.step}
                className="flex gap-3 items-start"
              >
                <div className="w-7 h-7 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center flex-shrink-0">
                  <span className="text-cyan-400 text-xs font-bold">{item.step}</span>
                </div>
                <div>
                  <div className="text-sm font-medium text-white">{item.title}</div>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* FAQ */}
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
          <h3 className="text-lg font-semibold text-white mb-4">FAQ</h3>
          <div className="space-y-3">
            {[
              {
                q: 'Is there a time limit on the sale?',
                a: 'No. Dealer licenses are always available. The price simply increases with each purchase along the bonding curve.',
              },
              {
                q: 'Can I transfer my license?',
                a: 'No. Licenses are non-transferable. They are PDA accounts derived from your wallet address and permanently bound to it.',
              },
              {
                q: 'Where does my purchase SOL go?',
                a: '50% goes to the Fast Poker Treasury and 50% goes to the Staker Pool (benefiting $POKER stakers).',
              },
              {
                q: 'What happens if I lose access to my wallet?',
                a: 'The license cannot be recovered or transferred. You would need to purchase a new license from a new wallet.',
              },
              {
                q: 'How much can I earn?',
                a: 'Earnings depend on the volume of games you deal. Licensed dealers earn 25% of cash game rake and 45% of SNG fees, weighted by their share of crank actions.',
              },
            ].map((item) => (
              <div key={item.q}>
                <div className="text-sm font-medium text-gray-300">{item.q}</div>
                <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Back link */}
        <div className="text-center pt-4">
          <Link
            href="/dealer"
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            &larr; Back to Dealer Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
