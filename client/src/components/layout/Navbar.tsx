'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Connection } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { L1_RPC, POKER_MINT } from '@/lib/constants';
import { getAvatarById, type AvatarOption } from '@/lib/avatars';

export function Navbar() {
  const { connected, publicKey } = useWallet();
  const pathname = usePathname();
  const [solBalance, setSolBalance] = useState<number | undefined>();
  const [pokerBalance, setPokerBalance] = useState<number | undefined>();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [userAvatar, setUserAvatar] = useState<AvatarOption | null>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  const fetchBalances = useCallback(async () => {
    if (!publicKey) { setSolBalance(undefined); setPokerBalance(undefined); return; }
    try {
      const conn = new Connection(L1_RPC, 'confirmed');
      const [sol, pokerAta] = await Promise.all([
        conn.getBalance(publicKey),
        getAssociatedTokenAddress(POKER_MINT, publicKey).then(ata =>
          getAccount(conn, ata).then(a => Number(a.amount)).catch(() => 0)
        ),
      ]);
      setSolBalance(sol / 1e9);
      setPokerBalance(pokerAta / 1e9);
    } catch { /* silent */ }
  }, [publicKey]);

  useEffect(() => {
    fetchBalances();
    if (!publicKey) return;
    const id = setInterval(fetchBalances, 15_000);
    return () => clearInterval(id);
  }, [fetchBalances, publicKey]);

  // Fetch user avatar
  useEffect(() => {
    if (!publicKey) { setUserAvatar(null); return; }
    fetch(`/api/profile?wallet=${publicKey.toBase58()}`)
      .then(r => r.json())
      .then(data => {
        if (data.avatarUrl) {
          const av = getAvatarById(data.avatarUrl);
          setUserAvatar(av);
        } else {
          setUserAvatar(null);
        }
      })
      .catch(() => setUserAvatar(null));
  }, [publicKey]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setProfileOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close mobile menu on route change
  useEffect(() => { setMobileOpen(false); setProfileOpen(false); }, [pathname]);

  // Primary nav links (shown in desktop bar)
  const primaryNav = [
    { href: '/', label: 'Lobby', icon: '⚡' },
    { href: '/staking', label: 'Staking', icon: '▲' },
    { href: '/auctions', label: 'Auctions', icon: '🏷' },
    { href: '/how-to-play', label: 'How to Play', icon: '📖' },
  ];

  // Secondary links (profile dropdown + mobile menu)
  const secondaryNav = [
    { href: '/profile', label: 'Profile', icon: '◆' },
    { href: '/my-tables', label: 'Manage Tables', icon: '$' },
    { href: '/admin', label: 'Admin', icon: '⚙' },
  ];

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-gray-950/80 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        {/* Left: Hamburger (mobile) + Logo */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="md:hidden p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {mobileOpen
                ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              }
            </svg>
          </button>
          <Link href="/" className="flex items-center gap-2 group">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-500/20 to-emerald-500/20 border border-cyan-500/30 flex items-center justify-center group-hover:border-cyan-400/50 transition-colors">
              <span className="text-cyan-400 text-xs font-bold">FP</span>
            </div>
            <span className="text-sm font-bold tracking-tight hidden sm:inline">
              <span className="text-cyan-400">FAST</span>
              <span className="text-white ml-0.5">POKER</span>
            </span>
          </Link>
        </div>

        {/* Center: Desktop nav */}
        <nav className="hidden md:flex items-center gap-0.5">
          {primaryNav.map(item => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
                pathname === item.href
                  ? 'bg-white/[0.08] text-cyan-400'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.04]'
              )}
            >
              <span className="mr-1 text-[10px]">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Right: Balances + Profile + Wallet */}
        <div className="flex items-center gap-2">
          {connected && (
            <div className="hidden sm:flex items-center gap-2">
              {solBalance !== undefined && (
                <div className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-white/[0.04] border border-white/[0.06]">
                  <Image src="/tokens/sol.svg" alt="SOL" width={14} height={14} className="rounded-full" />
                  <span className="text-xs font-medium text-gray-300">{solBalance.toFixed(2)}</span>
                </div>
              )}
              {pokerBalance !== undefined && pokerBalance > 0 && (
                <div className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-cyan-500/[0.06] border border-cyan-500/[0.15]">
                  <Image src="/tokens/poker.svg" alt="POKER" width={14} height={14} className="rounded-full" />
                  <span className="text-xs font-medium text-cyan-300">{pokerBalance.toFixed(0)}</span>
                </div>
              )}
            </div>
          )}

          {/* Profile dropdown (desktop) */}
          {connected && (
            <div className="relative hidden md:block" ref={profileRef}>
              <button
                onClick={() => setProfileOpen(!profileOpen)}
                className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center border transition-colors overflow-hidden',
                  profileOpen
                    ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-400'
                    : 'bg-white/[0.04] border-white/[0.08] text-gray-400 hover:text-white hover:border-white/[0.15]'
                )}
              >
                {userAvatar?.image ? (
                  <Image src={userAvatar.image} alt={userAvatar.label} width={28} height={28} className="w-7 h-7 object-cover" />
                ) : (
                  <span className="text-xs font-bold">{publicKey?.toBase58().slice(0, 2)}</span>
                )}
              </button>
              {profileOpen && (
                <div className="absolute right-0 top-full mt-2 w-40 py-1 rounded-xl bg-gray-900 border border-white/[0.08] shadow-xl z-50">
                  {secondaryNav.map(item => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        'flex items-center gap-2 px-3 py-2 text-xs font-medium transition-colors',
                        pathname === item.href
                          ? 'text-cyan-400 bg-white/[0.04]'
                          : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
                      )}
                    >
                      <span className="text-[10px]">{item.icon}</span>
                      {item.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          <WalletMultiButton />
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="md:hidden border-t border-white/[0.06] bg-gray-950/95 backdrop-blur-xl">
          <div className="px-4 py-2 space-y-0.5">
            {[...primaryNav, ...secondaryNav].map(item => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  pathname === item.href
                    ? 'bg-white/[0.08] text-cyan-400'
                    : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
                )}
              >
                <span className="text-xs w-4 text-center">{item.icon}</span>
                {item.label}
              </Link>
            ))}
            {connected && (
              <div className="flex items-center gap-2 px-3 py-2 sm:hidden">
                {solBalance !== undefined && (
                  <span className="text-xs text-gray-500">{solBalance.toFixed(2)} SOL</span>
                )}
                {pokerBalance !== undefined && pokerBalance > 0 && (
                  <span className="text-xs text-cyan-400">{pokerBalance.toFixed(0)} POKER</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
