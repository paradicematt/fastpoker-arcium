'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { L1_RPC, STEEL_PROGRAM_ID, POKER_MINT, POOL_PDA, ANCHOR_PROGRAM_ID } from '@/lib/constants';
import {
  getRakeVaultPda,
  getStakerClaimPda,
  buildClaimRakeRewardInstruction,
} from '@/lib/onchain-game';

interface RakeVaultInfo {
  tokenMint: string;
  totalDeposited: number;
  totalClaimed: number;
  vaultBalance: number; // current token balance in vault
  yourClaimed: number;
  claimable: boolean;
}

interface StakingState {
  pokerBalance: number;
  stakedAmount: number;
  unrefinedAmount: number;
  refinedAmount: number;
  pendingRewards: number;
  pendingPokerRewards: number;
  totalPoolStaked: number;
  yourSharePercent: number;
  solDistributed: number;
  pokerDistributed: number;
  pokerAvailable: number;
}

// Simple toast component
function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl border shadow-lg backdrop-blur-sm max-w-sm animate-in ${
      type === 'success'
        ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
        : 'bg-red-500/15 border-red-500/30 text-red-400'
    }`}>
      <div className="flex items-start gap-2">
        <span className="text-sm shrink-0">{type === 'success' ? '\u2713' : '\u2717'}</span>
        <p className="text-sm">{message}</p>
        <button onClick={onClose} className="ml-2 shrink-0 text-gray-500 hover:text-gray-300">&times;</button>
      </div>
    </div>
  );
}

export default function StakingPage() {
  const { connected, publicKey, sendTransaction } = useWallet();
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => setToast({ message, type }), []);
  const [state, setState] = useState<StakingState>({
    pokerBalance: 0,
    stakedAmount: 0,
    unrefinedAmount: 0,
    refinedAmount: 0,
    pendingRewards: 0,
    pendingPokerRewards: 0,
    totalPoolStaked: 0,
    yourSharePercent: 0,
    solDistributed: 0,
    pokerDistributed: 0,
    pokerAvailable: 0,
  });
  const [stakeAmount, setStakeAmount] = useState('');
  const [loading, setLoading] = useState(true);
  const [txPending, setTxPending] = useState(false);
  const [rakeVaults, setRakeVaults] = useState<RakeVaultInfo[]>([]);

  // Fetch staking state — extracted as callback so handlers can call it after tx
  const fetchState = useCallback(async () => {
    if (!publicKey) return;
    try {
      const connection = new Connection(L1_RPC, 'confirmed');
      
      // Batch: fetch stake, unrefined, pool, and token account in one RPC call
      const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, publicKey);
      const [stakePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('stake'), publicKey.toBuffer()],
        STEEL_PROGRAM_ID
      );
      const [unrefinedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('unrefined'), publicKey.toBuffer()],
        STEEL_PROGRAM_ID
      );

      const accounts = await connection.getMultipleAccountsInfo([
        tokenAccount, stakePda, unrefinedPda, POOL_PDA,
      ]);
      const [tokenAcct, stakeAcct, unrefinedAcct, poolAcct] = accounts;

      // Parse POKER balance
      let pokerBalance = 0;
      if (tokenAcct && tokenAcct.data.length >= 64) {
        pokerBalance = Number(Buffer.from(tokenAcct.data).readBigUInt64LE(64)) / 1e9;
      }

      // Parse stake
      let stakedAmount = 0, pendingRewards = 0;
      let burnedRaw = BigInt(0);
      let solRewardDebt = BigInt(0);
      let storedPendingSol = BigInt(0);
      if (stakeAcct && stakeAcct.data.length >= 72) {
        const d = Buffer.from(stakeAcct.data);
        burnedRaw = d.readBigUInt64LE(40);
        stakedAmount = Number(burnedRaw) / 1e9;
        const debtLo = d.readBigUInt64LE(48);
        const debtHi = d.readBigUInt64LE(56);
        solRewardDebt = (debtHi << BigInt(64)) | debtLo;
        storedPendingSol = d.readBigUInt64LE(64);
      }

      // Parse unrefined
      let unrefinedAmount = 0, refinedAmount = 0;
      let unrefinedRaw = BigInt(0);
      let storedRefined = BigInt(0);
      let refinedDebt = BigInt(0);
      if (unrefinedAcct && unrefinedAcct.data.length >= 72) {
        const d = Buffer.from(unrefinedAcct.data);
        unrefinedRaw = d.readBigUInt64LE(40);
        storedRefined = d.readBigUInt64LE(48);
        const debtLo = d.readBigUInt64LE(56);
        const debtHi = d.readBigUInt64LE(64);
        refinedDebt = (debtHi << BigInt(64)) | debtLo;
        unrefinedAmount = Number(unrefinedRaw) / 1e6;
      }

      // Parse pool
      let totalPoolStaked = 0;
      let solDistributed = 0, pokerDistributed = 0, pokerAvailable = 0;
      let pendingPokerRewards = 0;
      if (poolAcct && poolAcct.data.length >= 168) {
        const pd = Buffer.from(poolAcct.data);
        totalPoolStaked = Number(pd.readBigUInt64LE(72)) / 1e9;
        solDistributed = Number(pd.readBigUInt64LE(88)) / 1e9;
        pokerAvailable = Number(pd.readBigUInt64LE(112)) / 1e9;
        pokerDistributed = Number(pd.readBigUInt64LE(120)) / 1e9;

        // Compute claimable SOL rewards lazily
        const accSolLo = pd.readBigUInt64LE(96);
        const accSolHi = pd.readBigUInt64LE(104);
        const accSolPerToken = (accSolHi << BigInt(64)) | accSolLo;
        if (burnedRaw > BigInt(0)) {
          const accumulated = burnedRaw * accSolPerToken;
          const lazyPending = accumulated > solRewardDebt
            ? (accumulated - solRewardDebt) / BigInt(1_000_000_000_000)
            : BigInt(0);
          pendingRewards = Number(storedPendingSol + lazyPending) / 1e9;
        } else {
          pendingRewards = Number(storedPendingSol) / 1e9;
        }

        // Compute claimable POKER rewards
        if (stakeAcct && stakeAcct.data.length >= 96 && burnedRaw > BigInt(0)) {
          const sd = Buffer.from(stakeAcct.data);
          const pokerDebtLo = sd.readBigUInt64LE(72);
          const pokerDebtHi = sd.readBigUInt64LE(80);
          const pokerRewardDebt = (pokerDebtHi << BigInt(64)) | pokerDebtLo;
          const storedPendingPoker = sd.readBigUInt64LE(88);
          const accPokerLo = pd.readBigUInt64LE(128);
          const accPokerHi = pd.readBigUInt64LE(136);
          const accPokerPerToken = (accPokerHi << BigInt(64)) | accPokerLo;
          const accumulated = burnedRaw * accPokerPerToken;
          const lazyPending = accumulated > pokerRewardDebt
            ? (accumulated - pokerRewardDebt) / BigInt(1_000_000_000_000)
            : BigInt(0);
          pendingPokerRewards = Number(storedPendingPoker + lazyPending) / 1e9;
        }

        // Compute refined on-the-fly
        const accLo = pd.readBigUInt64LE(152);
        const accHi = pd.readBigUInt64LE(160);
        const accRefined = (accHi << BigInt(64)) | accLo;
        let computedRefined = Number(storedRefined);
        if (unrefinedRaw > BigInt(0)) {
          const pending = Number((unrefinedRaw * accRefined - refinedDebt) / BigInt(1_000_000_000_000));
          computedRefined += pending;
        }
        refinedAmount = computedRefined / 1e6;
      }

      const yourSharePercent = totalPoolStaked > 0 ? (stakedAmount / totalPoolStaked) * 100 : 0;

      // Fetch RakeVault accounts (only if any exist — skip on initial loads for speed)
      const vaults: RakeVaultInfo[] = [];
      try {
        const vaultAccounts = await connection.getProgramAccounts(ANCHOR_PROGRAM_ID, {
          filters: [{ dataSize: 97 }],
        });
        for (const { account } of vaultAccounts) {
          const d = Buffer.from(account.data);
          if (d.length < 97) continue;
          const mint = new PublicKey(d.subarray(8, 40)).toBase58();
          const totalDep = Number(d.readBigUInt64LE(40)) / 1e9;
          const totalCl = Number(d.readBigUInt64LE(48)) / 1e9;
          const vaultAta = new PublicKey(d.subarray(64, 96));
          let vaultBal = 0;
          try {
            const ataInfo = await getAccount(connection, vaultAta);
            vaultBal = Number(ataInfo.amount) / 1e9;
          } catch {}
          let yourCl = 0;
          let claimable = false;
          if (publicKey && stakedAmount > 0) {
            const rakeVaultPda = getRakeVaultPda(new PublicKey(mint));
            const claimPda = getStakerClaimPda(rakeVaultPda, publicKey);
            try {
              const claimInfo = await connection.getAccountInfo(claimPda);
              if (claimInfo && claimInfo.data.length >= 81) {
                yourCl = Number(Buffer.from(claimInfo.data).readBigUInt64LE(72)) / 1e9;
              }
            } catch {}
            claimable = vaultBal > 0;
          }
          vaults.push({ tokenMint: mint, totalDeposited: totalDep, totalClaimed: totalCl, vaultBalance: vaultBal, yourClaimed: yourCl, claimable });
        }
      } catch {}
      setRakeVaults(vaults);

      setState({
        pokerBalance, stakedAmount, unrefinedAmount, refinedAmount,
        pendingRewards, pendingPokerRewards, totalPoolStaked,
        yourSharePercent, solDistributed, pokerDistributed, pokerAvailable,
      });
    } catch (e) {
      console.error('Failed to fetch staking state:', e);
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    if (!connected || !publicKey) {
      setLoading(false);
      return;
    }
    fetchState();
    const interval = setInterval(fetchState, 10000);
    return () => clearInterval(interval);
  }, [connected, publicKey, fetchState]);

  const handleStake = async () => {
    if (!publicKey || !sendTransaction) return;
    const amount = parseFloat(stakeAmount);
    if (isNaN(amount) || amount <= 0) return;

    setTxPending(true);
    try {
      const connection = new Connection(L1_RPC, 'confirmed');
      const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, publicKey);
      const [stakePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('stake'), publicKey.toBuffer()],
        STEEL_PROGRAM_ID
      );

      // BurnStake discriminator = 1
      const data = Buffer.alloc(9);
      data.writeUInt8(1, 0);
      data.writeBigUInt64LE(BigInt(Math.floor(amount * 1e9)), 1);

      const ix = new TransactionInstruction({
        programId: STEEL_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: stakePda, isSigner: false, isWritable: true },
          { pubkey: POOL_PDA, isSigner: false, isWritable: true },
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: POKER_MINT, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });

      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig);
      
      setStakeAmount('');
      showToast('Stake successful!', 'success');
      await fetchState();
    } catch (e: any) {
      console.error('Stake failed:', e);
      showToast('Stake failed: ' + (e.message || 'Unknown error'), 'error');
    } finally {
      setTxPending(false);
    }
  };

  const handleClaimRewards = async () => {
    if (!publicKey || !sendTransaction) return;

    setTxPending(true);
    try {
      const connection = new Connection(L1_RPC, 'confirmed');
      const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, publicKey);
      const poolTokenAccount = await getAssociatedTokenAddress(POKER_MINT, POOL_PDA, true);
      const [stakePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('stake'), publicKey.toBuffer()],
        STEEL_PROGRAM_ID
      );

      const tx = new Transaction();

      // Ensure user ATA exists before claim (needed for POKER payout path)
      try {
        await getAccount(connection, tokenAccount);
      } catch {
        tx.add(
          createAssociatedTokenAccountInstruction(
            publicKey,
            tokenAccount,
            publicKey,
            POKER_MINT,
          )
        );
      }

      // ClaimStakeRewards discriminator = 3
      // Accounts: staker, stake, pool, staker_token_account, pool_token_account, token_program, system_program
      const data = Buffer.alloc(1);
      data.writeUInt8(3, 0);

      const ix = new TransactionInstruction({
        programId: STEEL_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: stakePda, isSigner: false, isWritable: true },
          { pubkey: POOL_PDA, isSigner: false, isWritable: true },
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: poolTokenAccount, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });

      tx.add(ix);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig);
      
      showToast('Rewards claimed!', 'success');
      await fetchState();
    } catch (e: any) {
      console.error('Claim failed:', e);
      showToast('Claim failed: ' + (e.message || 'Unknown error'), 'error');
    } finally {
      setTxPending(false);
    }
  };

  const handleClaimRakeVault = async (tokenMintStr: string) => {
    if (!publicKey || !sendTransaction) return;
    setTxPending(true);
    try {
      const connection = new Connection(L1_RPC, 'confirmed');
      const tokenMint = new PublicKey(tokenMintStr);
      const rakeVaultPda = getRakeVaultPda(tokenMint);

      // Read vault to get vault_token_account
      const vaultInfo = await connection.getAccountInfo(rakeVaultPda);
      if (!vaultInfo || vaultInfo.data.length < 97) throw new Error('Vault not found');
      const vaultTokenAccount = new PublicKey(vaultInfo.data.subarray(64, 96));

      const stakerTokenAccount = await getAssociatedTokenAddress(tokenMint, publicKey);
      const [stakePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('stake'), publicKey.toBuffer()],
        STEEL_PROGRAM_ID,
      );

      const tx = new Transaction();

      // Ensure recipient ATA exists for this mint before claim.
      try {
        await getAccount(connection, stakerTokenAccount);
      } catch {
        tx.add(
          createAssociatedTokenAccountInstruction(
            publicKey,
            stakerTokenAccount,
            publicKey,
            tokenMint,
          )
        );
      }

      const ix = buildClaimRakeRewardInstruction(
        publicKey,
        tokenMint,
        vaultTokenAccount,
        stakerTokenAccount,
        POOL_PDA,
        stakePda,
      );

      tx.add(ix);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig);
      showToast('Rake vault claimed!', 'success');
      await fetchState();
    } catch (e: any) {
      console.error('Rake vault claim failed:', e);
      showToast('Claim failed: ' + (e.message || 'Unknown error'), 'error');
    } finally {
      setTxPending(false);
    }
  };

  const handleClaimUnrefined = async () => {
    if (!publicKey || !sendTransaction) return;

    setTxPending(true);
    try {
      const connection = new Connection(L1_RPC, 'confirmed');
      const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, publicKey);
      const [stakePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('stake'), publicKey.toBuffer()],
        STEEL_PROGRAM_ID
      );

      // ClaimRefined discriminator = 5
      const data = Buffer.alloc(1);
      data.writeUInt8(5, 0);

      const ix = new TransactionInstruction({
        programId: STEEL_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: stakePda, isSigner: false, isWritable: true },
          { pubkey: POOL_PDA, isSigner: false, isWritable: true },
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: POKER_MINT, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });

      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig);
      
      showToast('Unrefined claimed!', 'success');
      await fetchState();
    } catch (e: any) {
      console.error('Claim failed:', e);
      showToast('Claim failed: ' + (e.message || 'Unknown error'), 'error');
    } finally {
      setTxPending(false);
    }
  };

  return (
    <main className="min-h-screen bg-gray-950">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Title */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">Burn to Earn</h1>
          <p className="text-gray-400">Stake your $POKER tokens to earn from every hand played</p>
        </div>

        {!connected ? (
          <div className="text-center py-12">
            <p className="text-gray-400 mb-4">Connect your wallet to start staking</p>
            <WalletMultiButton />
          </div>
        ) : loading ? (
          <div className="text-center py-12 text-gray-400">Loading...</div>
        ) : (
          <div className="space-y-6">
            {/* How It Works */}
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-6">
              <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">How It Works</h2>
              <div className="grid md:grid-cols-3 gap-3 text-sm">
                <div className="rounded-lg bg-white/[0.02] border border-white/[0.04] p-4">
                  <span className="inline-flex w-6 h-6 rounded-full bg-cyan-500/10 border border-cyan-500/20 items-center justify-center text-cyan-400 text-[10px] font-bold mb-2">1</span>
                  <h3 className="font-medium text-white text-sm mb-1">Burn $POKER to Stake</h3>
                  <p className="text-gray-500 text-xs">Permanently burned and converted to stake. Irreversible.</p>
                </div>
                <div className="rounded-lg bg-white/[0.02] border border-white/[0.04] p-4">
                  <span className="inline-flex w-6 h-6 rounded-full bg-cyan-500/10 border border-cyan-500/20 items-center justify-center text-cyan-400 text-[10px] font-bold mb-2">2</span>
                  <h3 className="font-medium text-white text-sm mb-1">Earn from Every Hand</h3>
                  <p className="text-gray-500 text-xs">25% of rake from user tables (50% from system tables) goes to stakers.</p>
                </div>
                <div className="rounded-lg bg-white/[0.02] border border-white/[0.04] p-4">
                  <span className="inline-flex w-6 h-6 rounded-full bg-cyan-500/10 border border-cyan-500/20 items-center justify-center text-cyan-400 text-[10px] font-bold mb-2">3</span>
                  <h3 className="font-medium text-white text-sm mb-1">Win Sit & Go = Unrefined</h3>
                  <p className="text-gray-500 text-xs">Claim Unrefined to get Refined based on pool share.</p>
                </div>
              </div>
              <div className="mt-4 p-3 rounded-lg bg-amber-500/[0.06] border border-amber-500/15">
                <p className="text-amber-400 text-xs">
                  Burning $POKER is permanent. Your stake cannot be unstaked or converted back.
                </p>
              </div>
            </div>

            {/* Your Stake */}
            <div className="grid md:grid-cols-2 gap-6">
              {/* Stake Card */}
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-6">
                <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Stake $POKER</h3>
                
                <div className="mb-4">
                  <div className="text-gray-500 text-xs mb-1">Available Balance</div>
                  <div className="text-2xl font-bold text-cyan-400">{state.pokerBalance.toFixed(4)} $POKER</div>
                </div>

                <div className="mb-4">
                  <label className="block text-gray-500 text-xs mb-1">Amount to Stake</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={stakeAmount}
                      onChange={(e) => setStakeAmount(e.target.value)}
                      placeholder="0.00"
                      className="flex-1 px-4 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white focus:border-cyan-500/50 focus:outline-none"
                    />
                    <button
                      onClick={() => setStakeAmount(state.pokerBalance.toString())}
                      className="px-3 py-2 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.06] rounded-lg text-gray-300 text-sm"
                    >
                      Max
                    </button>
                  </div>
                </div>

                <button
                  onClick={handleStake}
                  disabled={txPending || !stakeAmount}
                  className="w-full py-3 bg-cyan-500/15 border border-cyan-500/25 hover:bg-cyan-500/25 rounded-lg text-cyan-400 font-bold disabled:opacity-50 transition-colors"
                >
                  {txPending ? 'Processing...' : 'Burn & Stake'}
                </button>
              </div>

              {/* Your Position */}
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-6">
                <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Your Position</h3>
                
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-gray-500 text-sm">Your Stake</span>
                    <span className="text-white font-medium">{state.stakedAmount.toFixed(4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500 text-sm">Total Pool</span>
                    <span className="text-white font-medium">{state.totalPoolStaked.toFixed(4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500 text-sm">Your Share</span>
                    <span className="text-emerald-400 font-medium">{state.yourSharePercent.toFixed(4)}%</span>
                  </div>
                  <hr className="border-white/[0.06]" />
                  <div className="flex justify-between">
                    <span className="text-gray-500 text-sm">Pending SOL</span>
                    <span className="text-amber-400 font-medium">{state.pendingRewards.toFixed(6)} SOL</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500 text-sm">Pending POKER</span>
                    <span className="text-cyan-400 font-medium">{state.pendingPokerRewards.toFixed(4)} POKER</span>
                  </div>
                </div>

                <button
                  onClick={handleClaimRewards}
                  disabled={txPending || (state.pendingRewards <= 0 && state.pendingPokerRewards <= 0)}
                  className="w-full mt-4 py-3 bg-emerald-500/15 border border-emerald-500/25 hover:bg-emerald-500/25 rounded-lg text-emerald-400 font-bold disabled:opacity-50 transition-colors"
                >
                  {txPending ? 'Processing...' : 'Claim All Rewards (SOL + POKER)'}
                </button>
              </div>
            </div>

            {/* Revenue Breakdown */}
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-6">
              <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Pool Revenue</h3>
              <div className="grid md:grid-cols-3 gap-3">
                <div className="rounded-lg bg-white/[0.02] border border-white/[0.04] p-4">
                  <div className="text-gray-500 text-xs uppercase tracking-wider">SOL Distributed</div>
                  <div className="text-xl font-bold text-amber-400 mt-1">{state.solDistributed.toFixed(6)}</div>
                  <p className="text-gray-600 text-xs mt-1">From Sit & Go entry fees</p>
                </div>
                <div className="rounded-lg bg-white/[0.02] border border-white/[0.04] p-4">
                  <div className="text-gray-500 text-xs uppercase tracking-wider">POKER Distributed</div>
                  <div className="text-xl font-bold text-cyan-400 mt-1">{state.pokerDistributed.toFixed(4)}</div>
                  <p className="text-gray-600 text-xs mt-1">From cash game rake (25-50%)</p>
                </div>
                <div className="rounded-lg bg-white/[0.02] border border-white/[0.04] p-4">
                  <div className="text-gray-500 text-xs uppercase tracking-wider">POKER Available</div>
                  <div className="text-xl font-bold text-emerald-400 mt-1">{state.pokerAvailable.toFixed(4)}</div>
                  <p className="text-gray-600 text-xs mt-1">Unclaimed in pool</p>
                </div>
              </div>
            </div>

            {/* Unrefined/Refined */}
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-6">
              <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Unrefined & Refined Tokens</h3>
              
              <div className="grid md:grid-cols-2 gap-3">
                <div className="rounded-lg bg-white/[0.02] border border-white/[0.04] p-4">
                  <div className="text-gray-500 text-xs uppercase tracking-wider">Unrefined Balance</div>
                  <div className="text-2xl font-bold text-blue-400 mt-1">{state.unrefinedAmount.toFixed(4)}</div>
                  <p className="text-gray-600 text-xs mt-1">Earned from Sit & Go wins</p>
                </div>
                <div className="rounded-lg bg-white/[0.02] border border-white/[0.04] p-4">
                  <div className="text-gray-500 text-xs uppercase tracking-wider">Refined Balance</div>
                  <div className="text-2xl font-bold text-purple-400 mt-1">{state.refinedAmount.toFixed(4)}</div>
                  <p className="text-gray-600 text-xs mt-1">Earned from others' 10% claim tax</p>
                </div>
              </div>

              <div className="mt-4 p-3 rounded-lg bg-cyan-500/[0.04] border border-cyan-500/10">
                <p className="text-gray-400 text-xs">
                  When anyone claims their Unrefined, 10% is taxed and redistributed as Refined to all remaining Unrefined holders proportionally. Hold Unrefined longer to earn more Refined passively.
                </p>
              </div>

              <button
                onClick={handleClaimUnrefined}
                disabled={txPending || state.unrefinedAmount <= 0}
                className="w-full mt-4 py-3 bg-blue-500/15 border border-blue-500/25 hover:bg-blue-500/25 rounded-lg text-blue-400 font-bold disabled:opacity-50 transition-colors"
              >
                {txPending ? 'Processing...' : 'Claim All'}
              </button>
            </div>

            {/* Rake Vault Rewards */}
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-6">
              <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Token Rake Vaults</h3>
              <p className="text-gray-500 text-xs mb-4">
                Claim your proportional share of rake from auction-listed tokens.
                When new tokens win auctions and generate rake, vaults appear here.
              </p>
              {rakeVaults.length === 0 ? (
                <div className="rounded-lg bg-white/[0.02] border border-white/[0.04] p-6 text-center">
                  <div className="text-gray-500 text-sm mb-2">No rake vaults yet</div>
                  <div className="text-gray-600 text-xs">
                    When auction-winning tokens generate cash game rake, vaults will appear here for you to claim your staker share.
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {rakeVaults.map((v) => (
                    <div key={v.tokenMint} className="rounded-lg bg-white/[0.02] border border-white/[0.04] p-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-sm font-mono text-gray-300">{v.tokenMint.slice(0, 8)}...{v.tokenMint.slice(-4)}</div>
                        <div className="text-xs text-gray-500">Vault Balance: <span className="text-emerald-400">{v.vaultBalance.toFixed(4)}</span></div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs mb-3">
                        <div>
                          <span className="text-gray-500">Total Deposited</span>
                          <div className="text-white font-medium">{v.totalDeposited.toFixed(4)}</div>
                        </div>
                        <div>
                          <span className="text-gray-500">Total Claimed</span>
                          <div className="text-white font-medium">{v.totalClaimed.toFixed(4)}</div>
                        </div>
                        <div>
                          <span className="text-gray-500">You Claimed</span>
                          <div className="text-cyan-400 font-medium">{v.yourClaimed.toFixed(4)}</div>
                        </div>
                      </div>
                      <button
                        onClick={() => handleClaimRakeVault(v.tokenMint)}
                        disabled={txPending || !v.claimable}
                        className="w-full py-2 bg-purple-500/15 border border-purple-500/25 hover:bg-purple-500/25 rounded-lg text-purple-400 font-bold text-sm disabled:opacity-50 transition-colors"
                      >
                        {txPending ? 'Processing...' : 'Claim Rake Reward'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

