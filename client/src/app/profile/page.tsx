'use client';

import { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import Link from 'next/link';
import { L1_RPC, STEEL_PROGRAM_ID, POKER_MINT, ANCHOR_PROGRAM_ID, POOL_PDA, TABLE_ACCOUNT_SIZE } from '@/lib/constants';
import { getPlayerPda } from '@/lib/pda';
import * as crypto from 'crypto';

import { AVATAR_OPTIONS, getAvatarById } from '@/lib/avatars';

interface MongoProfile {
  username: string;
  avatarUrl: string;
}

interface CreatorTable {
  pubkey: string;
  gameTypeName: string;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  currentPlayers: number;
  rakeAccumulated: number;
  creatorRakeTotal: number;
  vaultTotalRakeDistributed: number;
  phase: string;
  tokenSymbol: string;
  isLegacy: boolean;
}

function getTokenSymbolFromMint(mint: string): string {
  if (mint === PublicKey.default.toBase58()) return 'SOL';
  if (mint === POKER_MINT.toBase58()) return 'POKER';
  return mint.slice(0, 4) + '...';
}

function fmtToken(raw: number): string {
  const val = raw / 1e9;
  if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
  if (val >= 1) return val.toFixed(val % 1 === 0 ? 0 : 2);
  if (val === 0) return '0';
  return parseFloat(val.toPrecision(3)).toString();
}

// Anchor discriminators for claim instructions
const CLAIM_SOL_DISC = Buffer.from([47, 206, 17, 43, 28, 213, 74, 12]);
const PLAYER_CLAIMABLE_SOL_OFFSET = 91;

interface OnChainStats {
  isRegistered: boolean;
  freeEntries: number;
  handsPlayed: number;
  handsWon: number;
  tournamentsPlayed: number;
  tournamentsWon: number;
  registeredAt: number;
  claimableSol: number; // lamports
  // Balances
  pokerBalance: number;
  stakedAmount: number;
  unrefinedAmount: number;
  refinedAmount: number;
  pendingSolRewards: number;
  pendingPokerRewards: number;
}

export default function ProfilePage() {
  const { connected, publicKey, sendTransaction } = useWallet();
  const [mongoProfile, setMongoProfile] = useState<MongoProfile | null>(null);
  const [stats, setStats] = useState<OnChainStats | null>(null);
  const [creatorTables, setCreatorTables] = useState<CreatorTable[]>([]);
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [claimingSol, setClaimingSol] = useState(false);
  const [claimingUnrefined, setClaimingUnrefined] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Pending cashouts
  const [pendingCashouts, setPendingCashouts] = useState<{ tablePda: string; seatIndex: number; cashoutChips: number; smallBlind: number; bigBlind: number }[]>([]);
  const [claimingCashoutProfile, setClaimingCashoutProfile] = useState<string | null>(null);
  const [cashoutErrorProfile, setCashoutErrorProfile] = useState<string | null>(null);

  // Fetch on-chain stats + MongoDB profile
  useEffect(() => {
    if (!connected || !publicKey) {
      setStats(null);
      setMongoProfile(null);
      setLoading(false);
      return;
    }

    const fetchAll = async () => {
      try {
        const connection = new Connection(L1_RPC, 'confirmed');
        const [playerPda] = getPlayerPda(publicKey);

        // Fetch on-chain PlayerAccount PDA
        // Layout: discriminator(8) + wallet(32) + is_registered(1) + free_entries(1) +
        //         hands_played(8) + hands_won(8) + total_winnings(8) + total_losses(8) +
        //         tournaments_played(4) + tournaments_won(4) + registered_at(8) + bump(1)
        const playerInfo = await connection.getAccountInfo(playerPda);
        
        let onChain: OnChainStats = {
          isRegistered: false, freeEntries: 0,
          handsPlayed: 0, handsWon: 0,
          tournamentsPlayed: 0, tournamentsWon: 0,
          registeredAt: 0, claimableSol: 0,
          pokerBalance: 0, stakedAmount: 0, unrefinedAmount: 0, refinedAmount: 0,
          pendingSolRewards: 0, pendingPokerRewards: 0,
        };

        if (playerInfo && playerInfo.data.length >= 90) {
          const d = playerInfo.data;
          onChain.isRegistered = d[40] === 1;
          onChain.freeEntries = d[41];
          onChain.handsPlayed = Number(d.readBigUInt64LE(42));
          onChain.handsWon = Number(d.readBigUInt64LE(50));
          onChain.tournamentsPlayed = d.readUInt32LE(74);
          onChain.tournamentsWon = d.readUInt32LE(78);
          onChain.registeredAt = Number(d.readBigInt64LE(82));
          onChain.claimableSol = d.length >= PLAYER_CLAIMABLE_SOL_OFFSET + 8
            ? Number(d.readBigUInt64LE(PLAYER_CLAIMABLE_SOL_OFFSET))
            : 0;
        }

        // Fetch token balances in parallel
        const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, publicKey);
        const [stakePda] = PublicKey.findProgramAddressSync(
          [Buffer.from('stake'), publicKey.toBuffer()], STEEL_PROGRAM_ID
        );
        const [unrefinedPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('unrefined'), publicKey.toBuffer()], STEEL_PROGRAM_ID
        );

        const [tokenInfo, stakeInfo, unrefinedInfo] = await Promise.all([
          connection.getAccountInfo(tokenAccount).catch(() => null),
          connection.getAccountInfo(stakePda).catch(() => null),
          connection.getAccountInfo(unrefinedPda).catch(() => null),
        ]);

        if (tokenInfo) {
          try {
            const account = await getAccount(connection, tokenAccount);
            onChain.pokerBalance = Number(account.amount) / 1e9;
          } catch {}
        }
        // Stake: disc(8) + owner(32) + burned_amount(8) + sol_reward_debt(16) + pending_sol(8)
        let burnedRaw = BigInt(0);
        let solRewardDebt = BigInt(0);
        let storedPendingSol = BigInt(0);
        if (stakeInfo && stakeInfo.data.length >= 72) {
          burnedRaw = stakeInfo.data.readBigUInt64LE(40);
          onChain.stakedAmount = Number(burnedRaw) / 1e9;
          const debtLo = stakeInfo.data.readBigUInt64LE(48);
          const debtHi = stakeInfo.data.readBigUInt64LE(56);
          solRewardDebt = (debtHi << BigInt(64)) | debtLo;
          storedPendingSol = stakeInfo.data.readBigUInt64LE(64);
        }
        // Unrefined: disc(8) + owner(32) + unrefined_amount(8) + refined_amount(8) + refined_debt(16) @ offsets 40, 48, 56
        let unrefinedRaw = BigInt(0);
        let storedRefined = BigInt(0);
        let refinedDebt = BigInt(0);
        if (unrefinedInfo && unrefinedInfo.data.length >= 72) {
          unrefinedRaw = unrefinedInfo.data.readBigUInt64LE(40);
          storedRefined = unrefinedInfo.data.readBigUInt64LE(48);
          const debtLo = unrefinedInfo.data.readBigUInt64LE(56);
          const debtHi = unrefinedInfo.data.readBigUInt64LE(64);
          refinedDebt = (debtHi << BigInt(64)) | debtLo;
          onChain.unrefinedAmount = Number(unrefinedRaw) / 1e6;
        }

        // Compute rewards on-the-fly from pool state
        const poolInfo = await connection.getAccountInfo(
          PublicKey.findProgramAddressSync([Buffer.from('pool')], STEEL_PROGRAM_ID)[0]
        ).catch(() => null);
        if (poolInfo && poolInfo.data.length >= 168) {
          // Compute claimable SOL rewards (same as Rust calculate_pending_sol)
          const accSolLo = poolInfo.data.readBigUInt64LE(96);
          const accSolHi = poolInfo.data.readBigUInt64LE(104);
          const accSolPerToken = (accSolHi << BigInt(64)) | accSolLo;
          if (burnedRaw > BigInt(0)) {
            const accumulated = burnedRaw * accSolPerToken;
            const lazyPending = accumulated > solRewardDebt
              ? (accumulated - solRewardDebt) / BigInt(1_000_000_000_000)
              : BigInt(0);
            onChain.pendingSolRewards = Number(storedPendingSol + lazyPending) / 1e9;
          } else {
            onChain.pendingSolRewards = Number(storedPendingSol) / 1e9;
          }

          // Compute pending POKER rewards from cash game rake
          // poker_reward_debt: u128 at stake offset 72, pending_poker: u64 at offset 88
          // acc_poker_per_token: u128 at pool offset 128
          if (stakeInfo && stakeInfo.data.length >= 96 && burnedRaw > BigInt(0)) {
            const pokerDebtLo = stakeInfo.data.readBigUInt64LE(72);
            const pokerDebtHi = stakeInfo.data.readBigUInt64LE(80);
            const pokerRewardDebt = (pokerDebtHi << BigInt(64)) | pokerDebtLo;
            const storedPendingPoker = stakeInfo.data.readBigUInt64LE(88);
            const accPokerLo = poolInfo.data.readBigUInt64LE(128);
            const accPokerHi = poolInfo.data.readBigUInt64LE(136);
            const accPokerPerToken = (accPokerHi << BigInt(64)) | accPokerLo;
            const accumulated = burnedRaw * accPokerPerToken;
            const lazyPending = accumulated > pokerRewardDebt
              ? (accumulated - pokerRewardDebt) / BigInt(1_000_000_000_000)
              : BigInt(0);
            onChain.pendingPokerRewards = Number(storedPendingPoker + lazyPending) / 1e9;
          }

          // Compute refined
          if (unrefinedRaw > BigInt(0)) {
            const accLo = poolInfo.data.readBigUInt64LE(152);
            const accHi = poolInfo.data.readBigUInt64LE(160);
            const accRefined = (accHi << BigInt(64)) | accLo;
            const pending = Number((unrefinedRaw * accRefined - refinedDebt) / BigInt(1_000_000_000_000));
            onChain.refinedAmount = (Number(storedRefined) + pending) / 1e6;
          } else {
            onChain.refinedAmount = Number(storedRefined) / 1e6;
          }
        } else {
          onChain.refinedAmount = Number(storedRefined) / 1e6;
        }

        setStats(onChain);

        // Fetch creator tables (tables where creator = this wallet)
        try {
          const TABLE_DISC = crypto.createHash('sha256').update('account:Table').digest().slice(0, 8);
          const PHASE_NAMES = ['Waiting','Starting','Preflop','Flop','Turn','River','Showdown','Complete'];
          const creatorAccounts = await connection.getProgramAccounts(ANCHOR_PROGRAM_ID, {
            filters: [
              { memcmp: { offset: 0, bytes: Buffer.from(TABLE_DISC).toString('base64'), encoding: 'base64' as any } },
              { memcmp: { offset: 290, bytes: publicKey.toBase58() } }, // CREATOR offset
            ],
          });
          const tables: CreatorTable[] = creatorAccounts.map(({ pubkey, account }) => {
            const d = Buffer.from(account.data);
            const isLegacy = d.length < TABLE_ACCOUNT_SIZE;
            let tokenSymbol = 'SOL';
            if (!isLegacy && d.length >= 385 + 32) {
              const mint = new PublicKey(d.subarray(385, 385 + 32)).toBase58();
              tokenSymbol = getTokenSymbolFromMint(mint);
            }
            return {
              pubkey: pubkey.toBase58(),
              gameTypeName: d[104] === 3 ? 'Cash Game' : 'Sit & Go',
              smallBlind: Number(d.readBigUInt64LE(105)),
              bigBlind: Number(d.readBigUInt64LE(113)),
              maxPlayers: d[121],
              currentPlayers: d[122],
              rakeAccumulated: Number(d.readBigUInt64LE(147)),
              creatorRakeTotal: Number(d.readBigUInt64LE(323)),
              vaultTotalRakeDistributed: 0,
              phase: PHASE_NAMES[d[160]] ?? 'Unknown',
              tokenSymbol,
              isLegacy,
            };
          });

          // Fetch vault data to get total_rake_distributed for each cash table
          const cashCreatorTables = tables.filter(t => t.gameTypeName === 'Cash Game');
          if (cashCreatorTables.length > 0) {
            const vaultPromises = cashCreatorTables.map(t => {
              const tablePk = new PublicKey(t.pubkey);
              const [vaultPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('vault'), tablePk.toBuffer()], ANCHOR_PROGRAM_ID
              );
              return connection.getAccountInfo(vaultPda)
                .then(info => {
                  if (!info) return { pubkey: t.pubkey, rakeDistributed: 0 };
                  const vd = Buffer.from(info.data);
                  return { pubkey: t.pubkey, rakeDistributed: vd.length >= 73 ? Number(vd.readBigUInt64LE(65)) : 0 };
                })
                .catch(() => ({ pubkey: t.pubkey, rakeDistributed: 0 }));
            });
            const vaults = await Promise.all(vaultPromises);
            const vaultMap = new Map(vaults.map(v => [v.pubkey, v.rakeDistributed]));
            for (const t of tables) {
              t.vaultTotalRakeDistributed = vaultMap.get(t.pubkey) || 0;
            }
          }

          setCreatorTables(tables);
        } catch (e) {
          console.error('Failed to fetch creator tables:', e);
        }

        // Fetch MongoDB profile (username/avatar)
        try {
          const res = await fetch(`/api/profile?wallet=${publicKey.toBase58()}`);
          if (res.ok) {
            const data = await res.json();
            setMongoProfile(data);
            setUsername(data.username || '');
            setAvatarUrl(data.avatarUrl || '');
          }
        } catch {}
      } catch (e) {
        console.error('Failed to fetch profile data:', e);
      } finally {
        setLoading(false);
      }
    };

    fetchAll();
  }, [connected, publicKey, refreshKey]);

  // Fetch pending cashouts
  useEffect(() => {
    if (!connected || !publicKey) { setPendingCashouts([]); return; }
    const fetchPending = () => {
      fetch(`/api/cash-game/pending-cashouts?wallet=${publicKey.toBase58()}`)
        .then(r => r.json())
        .then(data => setPendingCashouts(data.pendingCashouts || []))
        .catch(() => {});
    };
    fetchPending();
    const interval = setInterval(fetchPending, 30000);
    return () => clearInterval(interval);
  }, [connected, publicKey, refreshKey]);

  const handleClaimCashoutProfile = async (tablePda: string, seatIndex: number) => {
    const key = `${tablePda}-${seatIndex}`;
    setClaimingCashoutProfile(key);
    setCashoutErrorProfile(null);
    try {
      const res = await fetch('/api/cash-game/claim-cashout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tablePda, seatIndex }),
      });
      const data = await res.json();
      if (data.success) {
        setPendingCashouts(prev => prev.filter(p => !(p.tablePda === tablePda && p.seatIndex === seatIndex)));
        setRefreshKey(k => k + 1);
      } else {
        setCashoutErrorProfile(data.error || 'Claim failed');
      }
    } catch (e: any) {
      setCashoutErrorProfile(e.message || 'Network error');
    } finally {
      setClaimingCashoutProfile(null);
    }
  };

  const handleSave = async () => {
    if (!publicKey) return;
    setSaving(true);
    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: publicKey.toBase58(), username, avatarUrl }),
      });
      if (res.ok) {
        const data = await res.json();
        setMongoProfile(data);
        setEditing(false);
      }
    } catch (e) {
      console.error('Failed to save profile:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleClaimSol = async () => {
    if (!publicKey || !sendTransaction || !stats?.claimableSol) return;
    setClaimingSol(true);
    try {
      const connection = new Connection(L1_RPC, 'confirmed');
      const [playerPda] = getPlayerPda(publicKey);
      const ix = new TransactionInstruction({
        programId: ANCHOR_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: playerPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: CLAIM_SOL_DISC,
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
      setRefreshKey(k => k + 1);
    } catch (e: any) {
      console.error('Claim SOL failed:', e);
      alert('Claim SOL failed: ' + e.message);
    } finally {
      setClaimingSol(false);
    }
  };

  const handleClaimUnrefined = async () => {
    if (!publicKey || !sendTransaction || !stats?.unrefinedAmount) return;
    setClaimingUnrefined(true);
    try {
      const connection = new Connection(L1_RPC, 'confirmed');
      const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, publicKey);
      const [unrefinedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('unrefined'), publicKey.toBuffer()], STEEL_PROGRAM_ID
      );
      const [mintAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool')], STEEL_PROGRAM_ID
      );
      // ClaimAll discriminator = 6
      const data = Buffer.alloc(1);
      data.writeUInt8(6, 0);
      const ix = new TransactionInstruction({
        programId: STEEL_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: unrefinedPda, isSigner: false, isWritable: true },
          { pubkey: POOL_PDA, isSigner: false, isWritable: true },
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: POKER_MINT, isSigner: false, isWritable: true },
          { pubkey: mintAuthority, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });
      const tx = new Transaction();
      try { await getAccount(connection, tokenAccount); } catch {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, tokenAccount, publicKey, POKER_MINT));
      }
      tx.add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
      setRefreshKey(k => k + 1);
    } catch (e: any) {
      console.error('Claim unrefined failed:', e);
      alert('Claim failed: ' + e.message);
    } finally {
      setClaimingUnrefined(false);
    }
  };

  if (!connected) {
    return (
      <main className="min-h-screen bg-gray-950">
        <div className="max-w-4xl mx-auto px-4 py-20 text-center">
          <h2 className="text-2xl font-bold text-white mb-4">Connect Your Wallet</h2>
          <p className="text-gray-400 mb-8">Connect your wallet to view your profile</p>
          <WalletMultiButton />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-950">
      
      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-6 sm:py-8 pb-16">
        <h1 className="text-xl sm:text-2xl font-bold text-white mb-4 sm:mb-6">Your Profile</h1>

        {loading ? (
          <div className="text-center py-12 text-gray-400">Loading profile...</div>
        ) : (
          <div className="space-y-4 sm:space-y-6">
            {/* Profile Card */}
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4 sm:p-6">
              <div className="flex items-start gap-3 sm:gap-6">
                {/* Avatar */}
                <div className="relative">
                  {(() => {
                    const av = getAvatarById(avatarUrl);
                    return (
                      <div className={`w-14 h-14 sm:w-20 sm:h-20 rounded-full bg-gradient-to-br ${av?.gradient || 'from-cyan-500 to-emerald-500'} border border-white/[0.1] flex items-center justify-center text-2xl sm:text-3xl overflow-hidden`}>
                        {av?.image ? (
                          <img src={av.image} alt={av.label} className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-white">{av?.fallbackEmoji || '\u2660'}</span>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Info */}
                <div className="flex-1">
                  {editing ? (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-gray-500 text-xs mb-1">Username</label>
                        <input
                          type="text"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          placeholder="Enter username"
                          className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white text-sm focus:border-cyan-500/50 focus:outline-none"
                          maxLength={20}
                        />
                      </div>
                      <div>
                        <label className="block text-gray-500 text-xs mb-1">Choose Avatar</label>
                        <div className="grid grid-cols-7 gap-2">
                          {AVATAR_OPTIONS.map((av) => (
                            <button
                              key={av.id}
                              type="button"
                              onClick={() => setAvatarUrl(av.id)}
                              className={`flex flex-col items-center gap-0.5 p-1 rounded-lg transition-all ${
                                avatarUrl === av.id
                                  ? 'bg-cyan-500/10 ring-1 ring-cyan-400 scale-105'
                                  : 'hover:bg-white/[0.04] opacity-70 hover:opacity-100'
                              }`}
                              title={av.label}
                            >
                              <div className={`w-10 h-10 rounded-full bg-gradient-to-br ${av.gradient} flex items-center justify-center text-lg overflow-hidden border border-white/[0.08]`}>
                                {av.image ? (
                                  <img src={av.image} alt={av.label} className="w-full h-full object-cover" />
                                ) : (
                                  <span className="text-white">{av.fallbackEmoji}</span>
                                )}
                              </div>
                              <span className="text-[8px] text-gray-500 truncate max-w-[48px]">{av.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={handleSave} disabled={saving}
                          className="px-4 py-1.5 bg-cyan-500/15 border border-cyan-500/25 hover:bg-cyan-500/25 rounded-lg text-cyan-400 text-sm font-bold disabled:opacity-50">
                          {saving ? 'Saving...' : 'Save'}
                        </button>
                        <button onClick={() => setEditing(false)}
                          className="px-4 py-1.5 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.06] rounded-lg text-gray-300 text-sm">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-3 mb-1">
                        <h2 className="text-xl font-bold text-white">
                          {mongoProfile?.username || 'Anonymous Player'}
                        </h2>
                        <button onClick={() => setEditing(true)}
                          className="px-2 py-0.5 text-[10px] font-medium rounded bg-white/[0.04] border border-white/[0.08] text-gray-400 hover:text-white hover:bg-white/[0.08]">
                          Edit
                        </button>
                      </div>
                      <p className="text-gray-500 text-[10px] sm:text-xs font-mono mb-2 truncate max-w-[200px] sm:max-w-none">
                        {publicKey?.toBase58()}
                      </p>
                      {stats?.registeredAt ? (
                        <p className="text-gray-600 text-xs">
                          Member since {new Date(stats.registeredAt * 1000).toLocaleDateString()}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* XP Progression */}
            {stats && (
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-6">
                {(() => {
                  // XP system: hands*10 + wins*25 + tourney wins*500
                  const xp = (stats.handsPlayed * 10) + (stats.handsWon * 25) + (stats.tournamentsWon * 500);
                  // Level thresholds (exponential): 0, 100, 300, 600, 1000, 1500, 2200, 3000, 4000, 5500, 7500, 10000, 15000, 22000, 35000, 50000
                  const LEVELS = [0, 100, 300, 600, 1000, 1500, 2200, 3000, 4000, 5500, 7500, 10000, 15000, 22000, 35000, 50000, 75000, 120000, 200000, 350000, 999999];
                  const TIER_NAMES = ['Rookie', 'Rookie', 'Novice', 'Novice', 'Regular', 'Regular', 'Grinder', 'Grinder', 'Shark', 'Shark', 'Pro', 'Pro', 'Elite', 'Elite', 'Master', 'Master', 'Legend', 'Legend', 'Whale', 'Whale', 'Degen God'];
                  const TIER_COLORS = ['text-gray-400', 'text-gray-400', 'text-green-400', 'text-green-400', 'text-cyan-400', 'text-cyan-400', 'text-blue-400', 'text-blue-400', 'text-purple-400', 'text-purple-400', 'text-pink-400', 'text-pink-400', 'text-amber-400', 'text-amber-400', 'text-orange-400', 'text-orange-400', 'text-red-400', 'text-red-400', 'text-emerald-400', 'text-emerald-400', 'text-yellow-400'];
                  const BAR_COLORS = ['from-gray-500 to-gray-400', 'from-gray-500 to-gray-400', 'from-green-600 to-green-400', 'from-green-600 to-green-400', 'from-cyan-600 to-cyan-400', 'from-cyan-600 to-cyan-400', 'from-blue-600 to-blue-400', 'from-blue-600 to-blue-400', 'from-purple-600 to-purple-400', 'from-purple-600 to-purple-400', 'from-pink-600 to-pink-400', 'from-pink-600 to-pink-400', 'from-amber-600 to-amber-400', 'from-amber-600 to-amber-400', 'from-orange-600 to-orange-400', 'from-orange-600 to-orange-400', 'from-red-600 to-red-400', 'from-red-600 to-red-400', 'from-emerald-600 to-emerald-400', 'from-emerald-600 to-emerald-400', 'from-yellow-600 to-yellow-400'];
                  let level = 0;
                  for (let i = LEVELS.length - 1; i >= 0; i--) {
                    if (xp >= LEVELS[i]) { level = i; break; }
                  }
                  const currentThreshold = LEVELS[level] || 0;
                  const nextThreshold = LEVELS[Math.min(level + 1, LEVELS.length - 1)] || currentThreshold + 1;
                  const xpInLevel = xp - currentThreshold;
                  const xpNeeded = nextThreshold - currentThreshold;
                  const pct = Math.min((xpInLevel / xpNeeded) * 100, 100);

                  return (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${BAR_COLORS[level]} flex items-center justify-center shadow-lg`}>
                            <span className="text-white text-sm font-black">{level}</span>
                          </div>
                          <div>
                            <span className={`text-sm font-bold ${TIER_COLORS[level]}`}>{TIER_NAMES[level]}</span>
                            <div className="text-gray-500 text-[10px]">Level {level}</div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-white text-sm font-bold tabular-nums">{xp.toLocaleString()} XP</div>
                          <div className="text-gray-500 text-[10px]">
                            {level < LEVELS.length - 1 ? `${(nextThreshold - xp).toLocaleString()} XP to next level` : 'MAX LEVEL'}
                          </div>
                        </div>
                      </div>
                      <div className="relative h-3 bg-white/[0.04] rounded-full overflow-hidden border border-white/[0.06]">
                        <div
                          className={`absolute inset-y-0 left-0 bg-gradient-to-r ${BAR_COLORS[level]} rounded-full transition-all duration-1000 ease-out`}
                          style={{ width: `${pct}%` }}
                        />
                        <div className="absolute inset-0 bg-[repeating-linear-gradient(90deg,transparent,transparent_8px,rgba(255,255,255,0.03)_8px,rgba(255,255,255,0.03)_16px)]" />
                      </div>
                      <div className="flex justify-between mt-1.5 text-[9px] text-gray-600 tabular-nums">
                        <span>Lvl {level}</span>
                        <span>{Math.round(pct)}%</span>
                        <span>Lvl {Math.min(level + 1, LEVELS.length - 1)}</span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Game Stats */}
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-6">
              <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Game Stats</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard label="Tournaments Played" value={stats?.tournamentsPlayed || 0} color="text-white" />
                <StatCard label="Tournaments Won" value={stats?.tournamentsWon || 0} color="text-emerald-400" />
                <StatCard label="Hands Played" value={stats?.handsPlayed || 0} color="text-white" />
                <StatCard label="Hands Won" value={stats?.handsWon || 0} color="text-cyan-400" />
              </div>
              {stats && (
                <div className="mt-3 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  {stats.tournamentsPlayed > 0 ? (
                    <>
                      <span className="text-gray-500 text-xs">Win Rate: </span>
                      <span className="text-emerald-400 text-xs font-bold">
                        {((stats.tournamentsWon / stats.tournamentsPlayed) * 100).toFixed(1)}%
                      </span>
                      <span className="text-gray-600 text-xs ml-3">Hands Won: </span>
                      <span className="text-cyan-400 text-xs font-bold">
                        {stats.handsPlayed > 0 ? ((stats.handsWon / stats.handsPlayed) * 100).toFixed(1) : 0}%
                      </span>
                    </>
                  ) : (
                    <span className="text-gray-500 text-xs">No tournaments played yet — join a Sit &amp; Go to get started!</span>
                  )}
                </div>
              )}
            </div>

            {/* Token Balances */}
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-6">
              <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Balances</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3">
                  <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">$POKER</div>
                  <div className="text-cyan-400 text-lg font-bold tabular-nums">{(stats?.pokerBalance || 0).toFixed(2)}</div>
                  <div className="text-gray-600 text-[10px] mt-0.5">No market price yet</div>
                </div>
                <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3">
                  <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">Burned</div>
                  <div className="text-emerald-400 text-lg font-bold tabular-nums">{(stats?.stakedAmount || 0).toFixed(2)}</div>
                  {(stats?.pendingSolRewards || 0) > 0 && (
                    <div className="text-amber-400/80 text-[10px] font-mono mt-0.5">+{(stats?.pendingSolRewards || 0).toFixed(6)} SOL earned</div>
                  )}
                  <Link href="/staking" className="text-gray-500 hover:text-cyan-400 text-[10px] mt-1 inline-block transition-colors">+ more &rarr;</Link>
                </div>
                <StatCard label="SOL Staking Rewards" value={`${(stats?.pendingSolRewards || 0).toFixed(6)} SOL`} color="text-amber-400" />
                <StatCard label="POKER Staking Rewards" value={`${(stats?.pendingPokerRewards || 0).toFixed(4)}`} color="text-amber-400" />
              </div>
              {stats && stats.freeEntries > 0 && (
                <div className="mt-3 px-3 py-2 rounded-lg bg-emerald-500/[0.06] border border-emerald-500/15">
                  <span className="text-emerald-400 text-xs font-medium">
                    {stats.freeEntries} free Sit & Go entries remaining
                  </span>
                </div>
              )}
            </div>

            {/* Tournament Winnings: SOL + Unrefined + Refined */}
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-6">
              <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Tournament Winnings</h3>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-amber-400 text-lg font-bold tabular-nums">{((stats?.claimableSol || 0) / 1e9).toFixed(4)}</div>
                  <div className="text-gray-500 text-[10px]">SOL</div>
                </div>
                <div>
                  <div className="text-blue-400 text-lg font-bold tabular-nums">{(stats?.unrefinedAmount || 0).toFixed(2)}</div>
                  <div className="text-gray-500 text-[10px]">Unrefined</div>
                </div>
                <div>
                  <div className="text-purple-400 text-lg font-bold tabular-nums">{(stats?.refinedAmount || 0).toFixed(2)}</div>
                  <div className="text-gray-500 text-[10px]">Refined</div>
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                {(stats?.claimableSol || 0) > 0 && (
                  <button onClick={handleClaimSol} disabled={claimingSol}
                    className="px-3 py-1 text-[10px] font-bold rounded bg-amber-500/10 border border-amber-500/25 text-amber-400 hover:bg-amber-500/20 disabled:opacity-50 transition-colors">
                    {claimingSol ? 'Claiming...' : 'CLAIM SOL'}
                  </button>
                )}
                {((stats?.unrefinedAmount || 0) > 0 || (stats?.refinedAmount || 0) > 0) && (
                  <button onClick={handleClaimUnrefined} disabled={claimingUnrefined}
                    className="px-3 py-1 text-[10px] font-bold rounded bg-cyan-500/10 border border-cyan-500/25 text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-50 transition-colors">
                    {claimingUnrefined ? 'Claiming...' : 'CLAIM ALL'}
                  </button>
                )}
              </div>
            </div>

            {/* Pending Cashouts */}
            {pendingCashouts.length > 0 && (
              <div className="rounded-xl bg-amber-500/[0.04] border border-amber-500/20 p-6">
                <h3 className="text-sm font-bold text-amber-400 uppercase tracking-wider mb-4">Pending Cashouts</h3>
                <div className="space-y-2">
                  {pendingCashouts.map(p => {
                    const key = `${p.tablePda}-${p.seatIndex}`;
                    const isClaiming = claimingCashoutProfile === key;
                    return (
                      <div key={key} className="flex items-center justify-between rounded-lg bg-white/[0.02] border border-white/[0.04] p-3">
                        <div className="flex items-center gap-3">
                          <span className="text-amber-400 text-xs font-bold px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
                            Seat {p.seatIndex}
                          </span>
                          <span className="text-gray-400 text-xs font-mono">{p.tablePda.slice(0, 8)}...{p.tablePda.slice(-4)}</span>
                          <span className="text-amber-400 text-sm font-bold">{(p.cashoutChips / 1e9).toFixed(4)} SOL</span>
                        </div>
                        <button
                          onClick={() => handleClaimCashoutProfile(p.tablePda, p.seatIndex)}
                          disabled={!!claimingCashoutProfile}
                          className="px-4 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-400 text-xs font-bold hover:bg-amber-500/20 disabled:opacity-40 transition-colors"
                        >
                          {isClaiming ? 'Claiming...' : 'Claim'}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 px-3 py-2 rounded-lg bg-amber-500/[0.06] border border-amber-500/15 flex items-center justify-between">
                  <span className="text-amber-400 text-xs font-bold">
                    Total: {(pendingCashouts.reduce((s, p) => s + p.cashoutChips, 0) / 1e9).toFixed(4)} SOL
                  </span>
                  {pendingCashouts.length > 1 && (
                    <button
                      onClick={() => pendingCashouts.forEach(p => handleClaimCashoutProfile(p.tablePda, p.seatIndex))}
                      disabled={!!claimingCashoutProfile}
                      className="px-3 py-1 text-[10px] font-bold rounded bg-amber-500/10 border border-amber-500/25 text-amber-400 hover:bg-amber-500/20 disabled:opacity-40 transition-colors"
                    >
                      Claim All
                    </button>
                  )}
                </div>
                {cashoutErrorProfile && (
                  <p className="text-red-400 text-xs mt-2">{cashoutErrorProfile}</p>
                )}
              </div>
            )}

            {/* Creator Tables */}
            {creatorTables.length > 0 && (
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-6">
                <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Your Created Tables</h3>
                <div className="space-y-2">
                  {creatorTables.map(t => (
                    <div key={t.pubkey} className="flex items-center justify-between rounded-lg bg-white/[0.02] border border-white/[0.04] p-3">
                      <div className="flex items-center gap-3">
                        <span className="text-amber-400 text-xs font-bold px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
                          {t.gameTypeName === 'Cash Game' ? `$${t.tokenSymbol}` : t.gameTypeName}
                        </span>
                        <span className="text-gray-300 text-sm">{fmtToken(t.smallBlind)}/{fmtToken(t.bigBlind)} {t.tokenSymbol}</span>
                        {t.isLegacy && <span className="text-orange-400 text-[10px] px-1 py-0.5 rounded bg-orange-500/10 border border-orange-500/20">Legacy</span>}
                        <span className="text-gray-500 text-xs">{t.currentPlayers}/{t.maxPlayers} players</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${t.phase === 'Waiting' ? 'text-gray-400 bg-gray-500/10' : 'text-emerald-400 bg-emerald-500/10'}`}>{t.phase}</span>
                      </div>
                      <div className="flex items-center gap-4 text-xs">
                        {(() => {
                          const pending = Math.max(0, t.rakeAccumulated - t.vaultTotalRakeDistributed);
                          return pending > 0 ? (
                            <div>
                              <span className="text-gray-500">Pending: </span>
                              <span className="text-amber-400 font-bold">{fmtToken(pending)} {t.tokenSymbol}</span>
                            </div>
                          ) : (
                            <div>
                              <span className="text-gray-500">Claimed: </span>
                              <span className="text-emerald-400/60">{fmtToken(t.vaultTotalRakeDistributed)} {t.tokenSymbol}</span>
                            </div>
                          );
                        })()}
                        <div>
                          <span className="text-gray-500">Earned: </span>
                          <span className="text-emerald-400 font-bold">{fmtToken(t.creatorRakeTotal)} {t.tokenSymbol}</span>
                        </div>
                        <Link href={`/game/${t.pubkey}`} className="text-cyan-400 hover:text-cyan-300">
                          Open &rarr;
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 px-3 py-2 rounded-lg bg-amber-500/[0.06] border border-amber-500/15">
                  <span className="text-amber-400 text-xs">
                    Total creator rake earned: {creatorTables.map(t => `${fmtToken(t.creatorRakeTotal)} ${t.tokenSymbol}`).join(' + ') || '0'}
                  </span>
                </div>
              </div>
            )}

            {/* Quick Links */}
            <div className="grid md:grid-cols-3 gap-3">
              <Link href="/staking"
                className="rounded-xl bg-white/[0.03] border border-white/[0.06] hover:border-cyan-500/20 p-4 flex items-center justify-between transition-colors">
                <div>
                  <div className="text-white font-medium text-sm">Burn to Earn</div>
                  <div className="text-gray-500 text-xs">Stake $POKER to earn from every hand</div>
                </div>
                <span className="text-gray-600">&rarr;</span>
              </Link>
              <Link href="/my-tables"
                className="rounded-xl bg-white/[0.03] border border-white/[0.06] hover:border-amber-500/20 p-4 flex items-center justify-between transition-colors">
                <div>
                  <div className="text-white font-medium text-sm">My Tables</div>
                  <div className="text-gray-500 text-xs">Create & manage cash game tables</div>
                </div>
                <span className="text-gray-600">&rarr;</span>
              </Link>
              <Link href="/"
                className="rounded-xl bg-white/[0.03] border border-white/[0.06] hover:border-emerald-500/20 p-4 flex items-center justify-between transition-colors">
                <div>
                  <div className="text-white font-medium text-sm">Play Now</div>
                  <div className="text-gray-500 text-xs">Join a Sit & Go or Cash Game</div>
                </div>
                <span className="text-gray-600">&rarr;</span>
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function StatCard({ label, value, color = 'text-white' }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3">
      <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

