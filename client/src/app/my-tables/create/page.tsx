'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { L1_RPC, POKER_MINT, TREASURY, ANCHOR_PROGRAM_ID, POOL_PDA } from '@/lib/constants';
import {
  buildCreateUserTableInstruction,
  buildInitTableSeatInstruction,
  getTablePda,
  getSeatPda,
  getSeatCardsPda,
  getDeckStatePda,
  LISTED_TOKEN_DATA_SIZE,
  parseListedToken,
} from '@/lib/onchain-game';

// Token options — premium tokens that don't require auction listing
interface TokenOption {
  label: string;
  mint: PublicKey;
  symbol: string;
  decimals: number;
  color: string;
  accent: string;
}

const TOKEN_OPTIONS: TokenOption[] = [
  {
    label: 'SOL',
    mint: PublicKey.default,
    symbol: 'SOL',
    decimals: 9,
    color: 'text-purple-400',
    accent: 'border-purple-500/30 bg-purple-500/10',
  },
  {
    label: 'POKER',
    mint: POKER_MINT,
    symbol: 'POKER',
    decimals: 9,
    color: 'text-cyan-400',
    accent: 'border-cyan-500/30 bg-cyan-500/10',
  },
];

// Listed token metadata
interface ListedTokenInfo {
  mint: string;
  name: string;
  symbol: string;
  logoURI: string | null;
  decimals: number;
  listedAt: number;
}

// Preset blind levels per denomination
const BLIND_PRESETS: Record<string, { sb: number; bb: number; label: string }[]> = {
  SOL: [
    { sb: 5_000_000, bb: 10_000_000, label: '0.005 / 0.01' },
    { sb: 10_000_000, bb: 20_000_000, label: '0.01 / 0.02' },
    { sb: 25_000_000, bb: 50_000_000, label: '0.025 / 0.05' },
    { sb: 50_000_000, bb: 100_000_000, label: '0.05 / 0.1' },
    { sb: 100_000_000, bb: 200_000_000, label: '0.1 / 0.2' },
    { sb: 250_000_000, bb: 500_000_000, label: '0.25 / 0.5' },
  ],
  POKER: [
    { sb: 500_000_000, bb: 1_000_000_000, label: '0.5 / 1' },
    { sb: 1_000_000_000, bb: 2_000_000_000, label: '1 / 2' },
    { sb: 2_500_000_000, bb: 5_000_000_000, label: '2.5 / 5' },
    { sb: 5_000_000_000, bb: 10_000_000_000, label: '5 / 10' },
    { sb: 10_000_000_000, bb: 20_000_000_000, label: '10 / 20' },
    { sb: 25_000_000_000, bb: 50_000_000_000, label: '25 / 50' },
  ],
};

const MAX_PLAYERS_OPTIONS = [
  { value: 2, label: 'Heads-Up (2)' },
  { value: 6, label: '6-Max (6)' },
  { value: 9, label: 'Full Ring (9)' },
];

const BUY_IN_TYPES = [
  { value: 'normal' as const, label: 'Normal', minBB: 20, maxBB: 100, feeMult: 1, desc: '20-100 BB' },
  { value: 'deep' as const, label: 'Deep Stack', minBB: 50, maxBB: 250, feeMult: 2, desc: '50-250 BB · 2x fee' },
];

type SetupStep = 'config' | 'creating' | 'init-seats' | 'done';

const STEP_LABELS: Record<SetupStep, string> = {
  config: 'Configure',
  creating: 'Creating Table',
  'init-seats': 'Initializing Seats',
  done: 'Complete',
};

export default function CreateTablePage() {
  const { connected, publicKey, sendTransaction, signTransaction, signAllTransactions } = useWallet();
  const router = useRouter();
  const searchParams = useSearchParams();
  const conn = useMemo(() => new Connection(L1_RPC, 'confirmed'), []);

  // Token category: 'premium' (SOL/POKER) or 'listed' (auction winners)
  const [tokenCategory, setTokenCategory] = useState<'premium' | 'listed'>('premium');
  const [denomIdx, setDenomIdx] = useState(0);
  const [presetIdx, setPresetIdx] = useState(0);
  const [customMode, setCustomMode] = useState(false);
  const [customSB, setCustomSB] = useState('');
  const [customBB, setCustomBB] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(6);
  const [buyInType, setBuyInType] = useState<'normal' | 'deep'>('normal');
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Listed tokens state
  const [listedTokens, setListedTokens] = useState<ListedTokenInfo[]>([]);
  const [listedLoading, setListedLoading] = useState(false);
  const [selectedListed, setSelectedListed] = useState<ListedTokenInfo | null>(null);
  const [listedSearch, setListedSearch] = useState('');
  const [listedDropdownOpen, setListedDropdownOpen] = useState(false);

  // Multi-step state
  const [step, setStep] = useState<SetupStep>('config');
  const [stepProgress, setStepProgress] = useState('');
  const [tableIdBytes, setTableIdBytes] = useState<Uint8Array | null>(null);
  const [tablePdaKey, setTablePdaKey] = useState<PublicKey | null>(null);
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [zombieStatus, setZombieStatus] = useState<{ isZombie: boolean; missing: string[]; tablePda: string } | null>(null);

  // ── Resume: check localStorage OR ?resume=<tablePda> query param ──
  useEffect(() => {
    if (!publicKey) return;

    // Check ?resume=<tablePda> from manage page — read table data from L1
    const resumePda = searchParams.get('resume');
    if (resumePda) {
      (async () => {
        try {
          const connection = new Connection(L1_RPC, 'confirmed');
          const tablePda = new PublicKey(resumePda);
          const info = await connection.getAccountInfo(tablePda);
          if (!info) { setError('Table not found on L1'); return; }
          const data = Buffer.from(info.data);
          const tableId = Array.from(data.subarray(8, 40));
          const mp = data[121]; // MAX_PLAYERS offset
          // Save to localStorage so runSetup can use it
          localStorage.setItem(`create-table-${publicKey.toBase58()}`, JSON.stringify({
            tableId, tablePda: resumePda, completedStep: 'created', maxPlayers: mp, createdAt: Date.now(),
          }));
          setResumeAvailable(true);
        } catch (e: any) {
          console.error('Failed to load table for resume:', e);
        }
      })();
      return;
    }

    // Check localStorage for interrupted table creation
    try {
      const saved = localStorage.getItem(`create-table-${publicKey.toBase58()}`);
      if (saved) {
        const data = JSON.parse(saved);
        if (data.tableId && data.tablePda && data.completedStep && data.maxPlayers) {
          setResumeAvailable(true);
        }
      }
    } catch { /* ignore */ }
  }, [publicKey, searchParams]);

  // ── L1 table existence check: when resume is available, check if table exists on L1 ──
  useEffect(() => {
    if (!resumeAvailable || !publicKey) return;
    try {
      const saved = localStorage.getItem(`create-table-${publicKey.toBase58()}`);
      if (!saved) return;
      const data = JSON.parse(saved);
      if (!data.tablePda || !data.completedStep) return;
      const tablePk = new PublicKey(data.tablePda);
      const l1 = new Connection(L1_RPC, 'confirmed');
      l1.getAccountInfo(tablePk).then(info => {
        setZombieStatus({
          isZombie: false,
          missing: [],
          tablePda: data.tablePda,
          tableExists: !!info,
        } as any);
      }).catch(() => {});
    } catch { /* ignore */ }
  }, [publicKey, searchParams]);

  // Fetch listed tokens on mount
  useEffect(() => {
    async function fetchListed() {
      setListedLoading(true);
      try {
        const accounts = await conn.getProgramAccounts(ANCHOR_PROGRAM_ID, {
          filters: [{ dataSize: LISTED_TOKEN_DATA_SIZE }],
        });
        const mints: string[] = [];
        const listedData: { mint: string; listedAt: number }[] = [];
        for (const { account } of accounts) {
          const parsed = parseListedToken(Buffer.from(account.data));
          if (parsed) {
            mints.push(parsed.tokenMint);
            listedData.push({ mint: parsed.tokenMint, listedAt: parsed.listedAt });
          }
        }
        // Fetch metadata + decimals
        if (mints.length > 0) {
          const [metaRes, ...mintInfos] = await Promise.all([
            fetch(`/api/token-meta?mints=${mints.join(',')}`).then(r => r.ok ? r.json() : ({} as Record<string, any>)).catch(() => ({} as Record<string, any>)),
            ...mints.map(m => conn.getAccountInfo(new PublicKey(m)).catch(() => null)),
          ]);
          const results: ListedTokenInfo[] = [];
          for (let i = 0; i < mints.length; i++) {
            const meta = (metaRes as Record<string, any>)[mints[i]];
            const mintAcct = mintInfos[i];
            let decimals = 9;
            if (mintAcct && mintAcct.data.length >= 45) {
              decimals = mintAcct.data[44]; // SPL Mint decimals at byte 44
            }
            results.push({
              mint: mints[i],
              name: meta?.name || mints[i].slice(0, 8) + '...',
              symbol: meta?.symbol || '???',
              logoURI: meta?.logoURI || null,
              decimals,
              listedAt: listedData[i].listedAt,
            });
          }
          results.sort((a, b) => b.listedAt - a.listedAt);
          setListedTokens(results);
        }
      } catch (e) {
        console.warn('Failed to fetch listed tokens:', e);
      } finally {
        setListedLoading(false);
      }
    }
    fetchListed();
  }, [conn]);

  // Active denomination: either premium token or selected listed token
  const denom: TokenOption = useMemo(() => {
    if (tokenCategory === 'listed' && selectedListed) {
      return {
        label: selectedListed.symbol,
        mint: new PublicKey(selectedListed.mint),
        symbol: selectedListed.symbol,
        decimals: selectedListed.decimals,
        color: 'text-amber-400',
        accent: 'border-amber-500/30 bg-amber-500/10',
      };
    }
    return TOKEN_OPTIONS[denomIdx];
  }, [tokenCategory, selectedListed, denomIdx]);

  const presets = BLIND_PRESETS[denom.symbol] || null;

  // Listed tokens always use custom blinds (no presets for arbitrary tokens)
  const effectiveCustomMode = customMode || !presets;

  // Compute actual blinds (raw units)
  const { smallBlind, bigBlind, blindsValid } = useMemo(() => {
    if (effectiveCustomMode) {
      const sbFloat = parseFloat(customSB);
      const bbFloat = parseFloat(customBB);
      if (isNaN(sbFloat) || isNaN(bbFloat) || sbFloat <= 0 || bbFloat <= 0) {
        return { smallBlind: BigInt(0), bigBlind: BigInt(0), blindsValid: false };
      }
      const sbRaw = BigInt(Math.round(sbFloat * 10 ** denom.decimals));
      const bbRaw = BigInt(Math.round(bbFloat * 10 ** denom.decimals));
      return { smallBlind: sbRaw, bigBlind: bbRaw, blindsValid: bbRaw === sbRaw * BigInt(2) && sbRaw > 0 };
    }
    const p = presets![presetIdx] || presets![0];
    return { smallBlind: BigInt(p.sb), bigBlind: BigInt(p.bb), blindsValid: true };
  }, [effectiveCustomMode, customSB, customBB, denom, presetIdx, presets]);

  const isSol = denom.mint.equals(PublicKey.default);
  const buyInInfo = BUY_IN_TYPES.find(b => b.value === buyInType)!;
  const feeBB = buyInInfo.feeMult;
  const denomFee = bigBlind * BigInt(feeBB);
  const denomFeeDisplay = `${Number(denomFee) / 10 ** denom.decimals} ${denom.symbol}`;
  const flatSolFee = 0.05; // 0.05 SOL always
  const minBuyIn = Number(bigBlind) * buyInInfo.minBB / 10 ** denom.decimals;
  const maxBuyIn = Number(bigBlind) * buyInInfo.maxBB / 10 ** denom.decimals;
  // Rent: Table+DeckState+Vault PDAs ~0.007 + per seat (Seat+SeatCards) ~0.004
  const pdaRent = 0.007 + 0.004 * maxPlayers;
  const totalRentEstimate = pdaRent.toFixed(3);

  const isProcessing = step !== 'config' && step !== 'done';

  // Helper: save progress to localStorage
  const saveProgress = useCallback((tId: Uint8Array, tPda: PublicKey, completedStep: string, mp: number) => {
    if (!publicKey) return;
    localStorage.setItem(`create-table-${publicKey.toBase58()}`, JSON.stringify({
      tableId: Array.from(tId),
      tablePda: tPda.toBase58(),
      completedStep,
      maxPlayers: mp,
      createdAt: Date.now(),
    }));
  }, [publicKey]);

  const clearProgress = useCallback(() => {
    if (!publicKey) return;
    localStorage.removeItem(`create-table-${publicKey.toBase58()}`);
    setResumeAvailable(false);
  }, [publicKey]);

  // (Delegation helpers removed — Arcium L1 doesn't use TEE delegation)

  // ─── Batch sign + send: sign ALL txs in one wallet popup, fire all, then confirm ───
  const signAndSendAll = useCallback(async (
    txs: Transaction[],
    connection: Connection,
    label: string,
    onProgress?: (i: number, total: number) => void,
  ): Promise<string[]> => {
    if (txs.length === 0) return [];
    // Set feePayer + blockhash for all txs
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    for (const tx of txs) {
      tx.feePayer = publicKey!;
      tx.recentBlockhash = blockhash;
    }
    // ONE wallet popup to sign all
    const signed = signAllTransactions ? await signAllTransactions(txs) : txs;
    // Fire ALL txs immediately (Solana processes in order within same leader slot)
    // This avoids blockhash expiry from waiting for each confirmation sequentially
    const sigs: string[] = [];
    for (let i = 0; i < signed.length; i++) {
      onProgress?.(i, signed.length);
      const sig = await connection.sendRawTransaction(signed[i].serialize(), { skipPreflight: true });
      sigs.push(sig);
      console.log(`[${label}] TX ${i + 1}/${signed.length} sent: ${sig.slice(0, 20)}`);
    }
    // Now confirm all — they should already be processing on-chain
    for (let i = 0; i < sigs.length; i++) {
      onProgress?.(i, sigs.length);
      try {
        await connection.confirmTransaction({ signature: sigs[i], blockhash, lastValidBlockHeight }, 'confirmed');
      } catch (e: any) {
        // If confirmation fails, the TX might have landed anyway — check signature status
        const status = await connection.getSignatureStatus(sigs[i]);
        if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') {
          console.log(`[${label}] TX ${i + 1} confirmed via status check`);
          continue;
        }
        throw new Error(`${label} TX ${i + 1}/${sigs.length} failed: ${e?.message?.slice(0, 100)}`);
      }
    }
    return sigs;
  }, [publicKey, signAllTransactions]);

  // ─── Single TX send with polling confirmation (reliable on devnet) ───
  // Uses signTransaction + manual sendRawTransaction to bypass Phantom's internal
  // RPC which causes 'Unexpected error' on devnet (429 rate limiting).
  const sendSingleTx = useCallback(async (
    tx: Transaction,
    connection: Connection,
    label: string,
  ): Promise<string> => {
    tx.feePayer = publicKey!;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    let sig: string;
    if (signTransaction) {
      // Sign via wallet, send via our RPC (bypasses Phantom's devnet rate limits)
      const signed = await signTransaction(tx);
      sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    } else {
      // Fallback: use sendTransaction (goes through Phantom's RPC)
      sig = await sendTransaction!(tx, connection, { skipPreflight: true });
    }
    console.log(`[${label}] TX sent: ${sig.slice(0, 20)}`);
    // Poll-based confirmation (more reliable than websocket on devnet)
    for (let poll = 0; poll < 60; poll++) {
      const status = await connection.getSignatureStatus(sig);
      if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') {
        if (status.value.err) throw new Error(`[${label}] TX confirmed but failed: ${JSON.stringify(status.value.err)}`);
        console.log(`[${label}] TX confirmed (poll ${poll})`);
        return sig;
      }
      // Check if blockhash expired — but give 5 extra polls (TX may have landed just before expiry)
      const blockHeight = await connection.getBlockHeight();
      if (blockHeight > lastValidBlockHeight + 30) {
        throw new Error(`[${label}] TX blockhash expired. Click Resume to retry.`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`[${label}] TX confirmation timed out after 60s. Click Resume to retry.`);
  }, [publicKey, sendTransaction, signTransaction]);

  // Core setup logic — 3 wallet popups total via signAllTransactions
  // Phase 1: Create table (1 popup)
  // Phase 2: Init seats + create permissions (1 popup — batch signed)
  // Phase 3: All delegations (1 popup — batch signed)
  const runSetup = useCallback(async (
    _startFrom: 'creating' | 'init-seats' | 'delegating',
    tableId: Uint8Array,
    tablePda: PublicKey,
    mp: number,
  ) => {
    if (!publicKey || !sendTransaction || !signAllTransactions) return;
    const connection = new Connection(L1_RPC, 'confirmed');

    // ═══ PHASE 1: Create table (1 wallet popup) ═══
    setStep('creating');
    {
      const existing = await connection.getAccountInfo(tablePda);
      if (existing) {
        console.log('[create] Table already exists, skipping');
        setStepProgress('Table exists — skipping...');
      } else {
        let creatorAta: PublicKey | undefined;
        let treasuryAta: PublicKey | undefined;
        let poolAta: PublicKey | undefined;
        const preIxs: typeof Transaction.prototype['instructions'] = [];

        if (!isSol) {
          creatorAta = await getAssociatedTokenAddress(denom.mint, publicKey, false);
          treasuryAta = await getAssociatedTokenAddress(denom.mint, TREASURY, true);
          poolAta = await getAssociatedTokenAddress(denom.mint, POOL_PDA, true);

          const [creatorAtaInfo, treasuryAtaInfo, poolAtaInfo] = await Promise.all([
            connection.getAccountInfo(creatorAta),
            connection.getAccountInfo(treasuryAta),
            connection.getAccountInfo(poolAta),
          ]);

          const denomFeeRaw = Number(bigBlind) * (buyInType === 'deep' ? 2 : 1);
          if (creatorAtaInfo) {
            const tokenBalance = await connection.getTokenAccountBalance(creatorAta);
            if (Number(tokenBalance.value.amount) < denomFeeRaw) {
              throw new Error(
                `Insufficient ${denom.symbol} balance. Need ${denomFeeRaw / 10 ** denom.decimals} ${denom.symbol} for denomination fee. Balance: ${tokenBalance.value.uiAmountString}`
              );
            }
          } else {
            throw new Error(`No ${denom.symbol} tokens. Need ${denomFeeRaw / 10 ** denom.decimals} ${denom.symbol} for denomination fee.`);
          }

          if (!treasuryAtaInfo) preIxs.push(createAssociatedTokenAccountInstruction(publicKey, treasuryAta, TREASURY, denom.mint));
          if (!poolAtaInfo) preIxs.push(createAssociatedTokenAccountInstruction(publicKey, poolAta, POOL_PDA, denom.mint));
        }

        const { instruction: createIx } = buildCreateUserTableInstruction(
          publicKey, tableId, smallBlind, bigBlind, mp,
          denom.mint, creatorAta, treasuryAta, buyInType === 'deep' ? 1 : 0, poolAta, isPrivate,
        );

        setStepProgress('Approve: Create table (1/3)...');
        const tx = new Transaction();
        preIxs.forEach(ix => tx.add(ix));
        tx.add(createIx);
        await sendSingleTx(tx, connection, 'create-table');

        const tableInfo = await connection.getAccountInfo(tablePda);
        if (!tableInfo) throw new Error('Table creation TX confirmed but account not found.');

        if (!isSol && denom.mint.equals(POKER_MINT)) {
          try {
            const poolShare = (bigBlind * BigInt(buyInType === 'deep' ? 2 : 1)) / BigInt(2);
            await fetch('/api/record-poker-reward', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ amount: poolShare.toString() }),
            });
          } catch (e) { console.warn('record-poker-reward failed (non-critical):', e); }
        }
      }
      saveProgress(tableId, tablePda, 'created', mp);
    }

    // ═══ PHASE 2: Init seats + create permissions (1 wallet popup — batch signed) ═══
    setStep('init-seats');
    {
      const phase2Txs: Transaction[] = [];

      // Build init seat TXs (batch 3 per TX — each seat creates 5 PDAs now: seat, seatCards, deckState, receipt, proof)
      const SEAT_INIT_BATCH = 3;
      for (let batch = 0; batch < mp; batch += SEAT_INIT_BATCH) {
        const end = Math.min(batch + SEAT_INIT_BATCH, mp);
        const [firstSeatPda] = getSeatPda(tablePda, batch);
        if (await connection.getAccountInfo(firstSeatPda)) {
          console.log(`[init-seats] Batch ${batch}-${end - 1} exists, skipping`);
          continue;
        }
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }));
        for (let i = batch; i < end; i++) {
          tx.add(buildInitTableSeatInstruction(publicKey, tablePda, i));
        }
        phase2Txs.push(tx);
      }

      // (Permission creation removed — Arcium L1 doesn't use TEE permissions)

      // 1 wallet popup for all Phase 2 TXs (batch sign + sequential send with polling)
      if (phase2Txs.length > 0) {
        setStepProgress(`Approve: Init seats + permissions (2/3) — ${phase2Txs.length} TXs...`);
        const { blockhash } = await connection.getLatestBlockhash();
        for (const tx of phase2Txs) {
          tx.feePayer = publicKey!;
          tx.recentBlockhash = blockhash;
        }
        const signed = await signAllTransactions(phase2Txs);

        // Send each TX sequentially, poll for confirmation before next
        for (let i = 0; i < signed.length; i++) {
          setStepProgress(`Initializing seats...`);
          const sig = await connection.sendRawTransaction(signed[i].serialize(), { skipPreflight: true });
          console.log(`[phase2] TX ${i + 1}/${signed.length} sent: ${sig.slice(0, 20)}`);
          // Poll for confirmation
          for (let poll = 0; poll < 60; poll++) {
            const status = await connection.getSignatureStatus(sig);
            if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') {
              if (status.value.err) throw new Error(`[phase2] TX ${i + 1} confirmed but failed: ${JSON.stringify(status.value.err)}`);
              console.log(`[phase2] TX ${i + 1}/${signed.length} confirmed (poll ${poll})`);
              break;
            }
            if (poll === 59) throw new Error('Phase 2 TX not confirmed after 60s. Click Resume to retry.');
            await new Promise(r => setTimeout(r, 1000));
          }
          saveProgress(tableId, tablePda, 'seats-init', mp);
        }
      }
      saveProgress(tableId, tablePda, 'perms-created', mp);
    }

    // ═══ Arcium L1: No delegation needed — table is ready after seat init ═══
    clearProgress();
    setStep('done');
    setStepProgress('Table is live!');
    setTimeout(() => router.push(`/game/${tablePda.toBase58()}`), 2000);
  }, [publicKey, sendTransaction, signAllTransactions, signAndSendAll, sendSingleTx, isSol, denom, smallBlind, bigBlind, buyInType, saveProgress, clearProgress, router]);

  // Error wrapper for setup calls
  const withErrorHandling = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      console.error('Table setup failed:', e);
      let msg = 'Transaction failed';
      if (e?.message) {
        msg = e.message;
        if (msg.length > 200 && /^[A-Za-z0-9+/=]+$/.test(msg.replace(/\s/g, ''))) {
          msg = 'Transaction simulation failed. Check balances and token listing.';
        }
        const anchorMatch = msg.match(/custom program error: (0x[0-9a-fA-F]+)/);
        if (anchorMatch) {
          msg = `Program error: ${anchorMatch[1]} — ${msg}`;
        }
      }
      setError(msg);
    }
  }, []);

  // Start fresh table creation
  const handleFullSetup = useCallback(async () => {
    if (!publicKey || !sendTransaction || !blindsValid) return;
    await withErrorHandling(async () => {
      const tableId = new Uint8Array(32);
      crypto.getRandomValues(tableId);
      setTableIdBytes(tableId);
      const [tablePda] = getTablePda(tableId);
      setTablePdaKey(tablePda);
      await runSetup('creating', tableId, tablePda, maxPlayers);
    });
  }, [publicKey, sendTransaction, blindsValid, maxPlayers, runSetup, withErrorHandling]);

  // Resume interrupted table creation — runSetup is fully idempotent,
  // it checks on-chain state at every step and skips what's already done.
  const handleResume = useCallback(async () => {
    if (!publicKey || !sendTransaction) return;
    await withErrorHandling(async () => {
      const saved = localStorage.getItem(`create-table-${publicKey.toBase58()}`);
      if (!saved) return;
      const data = JSON.parse(saved);
      const tableId = new Uint8Array(data.tableId);
      const tablePda = new PublicKey(data.tablePda);
      const mp = data.maxPlayers;
      setTableIdBytes(tableId);
      setTablePdaKey(tablePda);
      setMaxPlayers(mp);

      // Always start from 'creating' — each step detects on-chain state and skips if done
      await runSetup('creating', tableId, tablePda, mp);
    });
  }, [publicKey, sendTransaction, runSetup, withErrorHandling]);

  // Cancel interrupted creation and start fresh
  const handleCancelResume = useCallback(() => {
    clearProgress();
    setStep('config');
    setStepProgress('');
    setError(null);
  }, [clearProgress]);

  const stepOrder: SetupStep[] = ['config', 'creating', 'init-seats', 'done'];
  const stepIdx = stepOrder.indexOf(step);

  return (
    <main className="min-h-screen bg-gray-950">
      <div className="max-w-lg mx-auto px-4 py-8">
        <Link href="/my-tables" className="text-sm text-gray-500 hover:text-gray-300 transition-colors mb-6 inline-block">
          &larr; Back to Cash Games
        </Link>

        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-6">
          <h1 className="text-xl font-bold text-white mb-1">Create Cash Game Table</h1>
          <p className="text-sm text-gray-500 mb-4">Earn 45% of every pot&apos;s rake as the table creator (5% goes to dealers)</p>

          {/* Resume banner for interrupted creation */}
          {resumeAvailable && step === 'config' && (
            <div className={`mb-4 p-3 border rounded-lg ${
              (zombieStatus as any)?.tableExists
                ? 'bg-green-500/10 border-green-500/20'
                : 'bg-amber-500/10 border-amber-500/20'
            }`}>
              {(zombieStatus as any)?.tableExists ? (
                <>
                  <div className="text-green-400 text-sm font-medium mb-1">Table exists on L1</div>
                  <p className="text-gray-400 text-xs mb-2">Table is set up. Go to table to play, or resume to re-verify.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => router.push(`/game/${zombieStatus!.tablePda}`)}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-green-500/20 text-green-300 hover:bg-green-500/30 transition-colors"
                    >
                      Go to Table
                    </button>
                    <button
                      onClick={handleResume}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors"
                    >
                      Resume Setup
                    </button>
                    <button
                      onClick={handleCancelResume}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-white/[0.04] text-gray-400 hover:bg-white/[0.08] transition-colors"
                    >
                      Discard
                    </button>
                  </div>
                </>
              ) : zombieStatus ? (
                <>
                  <div className="text-amber-400 text-sm font-medium mb-1">Incomplete table setup</div>
                  <p className="text-gray-400 text-xs mb-2">Table needs finishing — seats, permissions, or delegation still pending.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleResume}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors"
                    >
                      Resume Setup
                    </button>
                    <button
                      onClick={handleCancelResume}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-white/[0.04] text-gray-400 hover:bg-white/[0.08] transition-colors"
                    >
                      Discard &amp; Start Fresh
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="text-gray-400 text-sm font-medium mb-1">Checking table status...</div>
                  <p className="text-gray-500 text-xs mb-2">Verifying L1 delegation status.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleResume}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors"
                    >
                      Resume Setup
                    </button>
                    <button
                      onClick={handleCancelResume}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-white/[0.04] text-gray-400 hover:bg-white/[0.08] transition-colors"
                    >
                      Discard &amp; Start Fresh
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step indicator */}
          {step !== 'config' && (
            <div className="mb-6">
              <div className="flex items-center gap-1 mb-2">
                {stepOrder.slice(1).map((s, i) => {
                  const sIdx = i + 1;
                  const isDone = stepIdx > sIdx;
                  const isActive = stepIdx === sIdx;
                  return (
                    <div key={s} className="flex items-center flex-1">
                      <div className={`h-1.5 flex-1 rounded-full transition-all ${
                        isDone ? 'bg-emerald-500' : isActive ? 'bg-cyan-500 animate-pulse' : 'bg-white/[0.06]'
                      }`} />
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                {step === 'done' ? (
                  <span className="text-emerald-400 text-sm font-medium">&#10003; Table setup complete!</span>
                ) : (
                  <>
                    <div className="w-3 h-3 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                    <span className="text-cyan-400 text-sm font-medium">{stepProgress}</span>
                  </>
                )}
              </div>
              {tablePdaKey && (
                <div className="mt-2 text-[10px] text-gray-600 font-mono break-all">
                  Table: {tablePdaKey.toBase58()}
                </div>
              )}
            </div>
          )}

          {!connected ? (
            <div className="text-center py-8">
              <p className="text-gray-400 text-sm mb-4">Connect your wallet to create a table</p>
              <WalletMultiButton />
            </div>
          ) : (
            <div className="space-y-5">
              {/* Token (Currency) */}
              <div className={isProcessing ? 'opacity-50 pointer-events-none' : ''}>
                <label className="text-xs text-gray-500 uppercase tracking-wider font-medium block mb-2">Token (Currency)</label>

                {/* Category tabs: Premium | Listed */}
                <div className="flex gap-1 mb-3 p-0.5 bg-white/[0.03] rounded-lg">
                  <button
                    onClick={() => { setTokenCategory('premium'); setSelectedListed(null); }}
                    className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-all ${
                      tokenCategory === 'premium' ? 'bg-white/[0.08] text-white' : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    SOL / POKER
                  </button>
                  <button
                    onClick={() => { setTokenCategory('listed'); setCustomMode(true); }}
                    className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-all ${
                      tokenCategory === 'listed' ? 'bg-amber-500/15 text-amber-400' : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    Listed Tokens {listedTokens.length > 0 && <span className="ml-1 text-[10px] opacity-60">({listedTokens.length})</span>}
                  </button>
                </div>

                {tokenCategory === 'premium' ? (
                  <div className="flex gap-2">
                    {TOKEN_OPTIONS.map((d, i) => (
                      <button
                        key={d.symbol}
                        onClick={() => { setDenomIdx(i); setPresetIdx(0); setCustomMode(false); }}
                        className={`flex-1 p-3 rounded-lg border text-center transition-all ${
                          denomIdx === i ? d.accent + ' ring-1 ring-white/10' : 'bg-white/[0.02] border-white/[0.06] hover:border-white/[0.1]'
                        }`}
                      >
                        <img src={d.mint.equals(PublicKey.default) ? '/tokens/sol.svg' : '/tokens/poker.svg'} alt={d.symbol} className="w-6 h-6 mx-auto mb-1" />
                        <div className={`text-sm font-bold ${denomIdx === i ? d.color : 'text-white'}`}>{d.label}</div>
                      </button>
                    ))}
                  </div>
                ) : (
                  /* Listed tokens dropdown with search */
                  <div className="relative">
                    {listedLoading ? (
                      <div className="text-gray-500 text-xs py-4 text-center">Loading listed tokens...</div>
                    ) : listedTokens.length === 0 ? (
                      <div className="text-gray-500 text-xs py-4 text-center">
                        No tokens listed yet. <a href="/auctions" className="text-cyan-500 hover:underline">Bid in auctions</a> to list a token.
                      </div>
                    ) : (
                      <>
                        {/* Selected token display / trigger */}
                        <button
                          onClick={() => setListedDropdownOpen(!listedDropdownOpen)}
                          className={`w-full p-3 rounded-lg border text-left transition-all flex items-center gap-3 ${
                            selectedListed
                              ? 'border-amber-500/30 bg-amber-500/10'
                              : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.12]'
                          }`}
                        >
                          {selectedListed?.logoURI ? (
                            <img src={selectedListed.logoURI} alt={selectedListed.symbol} className="w-7 h-7 rounded-full shrink-0" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-gray-800 shrink-0 flex items-center justify-center text-xs text-gray-500">?</div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className={`text-sm font-semibold ${selectedListed ? 'text-amber-400' : 'text-gray-400'}`}>
                              {selectedListed ? `${selectedListed.name} ($${selectedListed.symbol})` : 'Select a listed token...'}
                            </div>
                            {selectedListed && (
                              <div className="text-[10px] text-gray-500 font-mono truncate">{selectedListed.mint}</div>
                            )}
                          </div>
                          <svg className={`w-4 h-4 text-gray-500 transition-transform ${listedDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                        </button>

                        {/* Dropdown */}
                        {listedDropdownOpen && (
                          <div className="absolute z-50 mt-1 w-full bg-gray-900 border border-white/[0.1] rounded-lg shadow-xl max-h-60 overflow-hidden">
                            <div className="p-2 border-b border-white/[0.06]">
                              <input
                                type="text"
                                value={listedSearch}
                                onChange={(e) => setListedSearch(e.target.value)}
                                placeholder="Search by name, symbol, or mint..."
                                className="w-full px-3 py-1.5 rounded-md bg-white/[0.04] border border-white/[0.08] text-white text-xs placeholder-gray-600 focus:outline-none focus:border-cyan-500/40"
                                autoFocus
                              />
                            </div>
                            <div className="overflow-y-auto max-h-44">
                              {listedTokens
                                .filter((t) => {
                                  if (!listedSearch) return true;
                                  const q = listedSearch.toLowerCase();
                                  return t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q) || t.mint.toLowerCase().includes(q);
                                })
                                .map((t) => (
                                  <button
                                    key={t.mint}
                                    onClick={() => {
                                      setSelectedListed(t);
                                      setListedDropdownOpen(false);
                                      setListedSearch('');
                                      setCustomMode(true);
                                    }}
                                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/[0.04] transition-colors ${
                                      selectedListed?.mint === t.mint ? 'bg-amber-500/10' : ''
                                    }`}
                                  >
                                    {t.logoURI ? (
                                      <img src={t.logoURI} alt={t.symbol} className="w-6 h-6 rounded-full shrink-0" />
                                    ) : (
                                      <div className="w-6 h-6 rounded-full bg-gray-800 shrink-0 flex items-center justify-center text-[9px] text-gray-500">?</div>
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <div className="text-xs font-medium text-gray-200 truncate">{t.name}</div>
                                      <div className="text-[10px] text-gray-500">${t.symbol} · {t.decimals} decimals</div>
                                    </div>
                                  </button>
                                ))}
                              {listedTokens.filter(t => {
                                if (!listedSearch) return true;
                                const q = listedSearch.toLowerCase();
                                return t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q) || t.mint.toLowerCase().includes(q);
                              }).length === 0 && (
                                <div className="px-3 py-3 text-center">
                                  <p className="text-xs text-gray-500 mb-1">No matching tokens found</p>
                                  <Link href="/auctions" className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors">
                                    Can&apos;t find your token? Get it listed &rarr;
                                  </Link>
                                </div>
                              )}
                            </div>
                            <div className="border-t border-white/[0.06] px-3 py-2 text-center">
                              <Link href="/auctions" className="text-[10px] text-gray-500 hover:text-cyan-400 transition-colors">
                                Don&apos;t see your token? Win an auction to get listed &rarr;
                              </Link>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Blinds */}
              <div className={isProcessing ? 'opacity-50 pointer-events-none' : ''}>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-gray-500 uppercase tracking-wider font-medium">Blinds ({denom.symbol})</label>
                  {presets && (
                    <button
                      onClick={() => setCustomMode(!customMode)}
                      className="text-xs text-cyan-500 hover:text-cyan-400 transition-colors"
                    >
                      {customMode ? 'Use presets' : 'Custom'}
                    </button>
                  )}
                </div>

                {effectiveCustomMode ? (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-gray-600 block mb-1">Small Blind</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={customSB}
                        onChange={e => {
                          const val = e.target.value;
                          setCustomSB(val);
                          const num = parseFloat(val);
                          if (!isNaN(num) && num > 0) {
                            setCustomBB(String(num * 2));
                          }
                        }}
                        placeholder="0.01"
                        className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-sm focus:outline-none focus:border-cyan-500/40"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-gray-600 block mb-1">Big Blind</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={customBB}
                        onChange={e => {
                          const val = e.target.value;
                          setCustomBB(val);
                          const num = parseFloat(val);
                          if (!isNaN(num) && num > 0) {
                            setCustomSB(String(num / 2));
                          }
                        }}
                        placeholder="0.02"
                        className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white text-sm focus:outline-none focus:border-cyan-500/40"
                      />
                    </div>
                    {effectiveCustomMode && customSB && customBB && !blindsValid && (
                      <div className="col-span-2 text-red-400 text-xs">BB must be exactly 2x SB</div>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {presets!.map((p, i) => (
                      <button
                        key={p.label}
                        onClick={() => setPresetIdx(i)}
                        className={`p-2.5 rounded-lg border text-center transition-all ${
                          presetIdx === i
                            ? 'bg-cyan-500/10 border-cyan-500/30 ring-1 ring-cyan-500/20'
                            : 'bg-white/[0.02] border-white/[0.06] hover:border-white/[0.1]'
                        }`}
                      >
                        <div className={`text-xs font-semibold ${presetIdx === i ? 'text-cyan-400' : 'text-white'}`}>
                          {p.label}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Buy-in Type */}
              <div className={isProcessing ? 'opacity-50 pointer-events-none' : ''}>
                <label className="text-xs text-gray-500 uppercase tracking-wider font-medium block mb-2">Buy-in Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {BUY_IN_TYPES.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setBuyInType(opt.value)}
                      className={`p-3 rounded-lg border text-left transition-all ${
                        buyInType === opt.value
                          ? 'bg-cyan-500/10 border-cyan-500/30 ring-1 ring-cyan-500/20'
                          : 'bg-white/[0.02] border-white/[0.06] hover:border-white/[0.1]'
                      }`}
                    >
                      <div className={`text-sm font-semibold ${buyInType === opt.value ? 'text-cyan-400' : 'text-white'}`}>{opt.label}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Table Size */}
              <div className={isProcessing ? 'opacity-50 pointer-events-none' : ''}>
                <label className="text-xs text-gray-500 uppercase tracking-wider font-medium block mb-2">Table Size</label>
                <div className="grid grid-cols-3 gap-2">
                  {MAX_PLAYERS_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setMaxPlayers(opt.value)}
                      className={`p-3 rounded-lg border text-center transition-all ${
                        maxPlayers === opt.value
                          ? 'bg-cyan-500/10 border-cyan-500/30 ring-1 ring-cyan-500/20'
                          : 'bg-white/[0.02] border-white/[0.06] hover:border-white/[0.1]'
                      }`}
                    >
                      <div className={`text-sm font-semibold ${maxPlayers === opt.value ? 'text-cyan-400' : 'text-white'}`}>
                        {opt.label}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Private Table Toggle */}
              <div className={isProcessing ? 'opacity-50 pointer-events-none' : ''}>
                <label className="text-xs text-gray-500 uppercase tracking-wider font-medium block mb-2">Table Access</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setIsPrivate(false)}
                    className={`p-3 rounded-lg border text-center transition-all ${
                      !isPrivate
                        ? 'bg-cyan-500/10 border-cyan-500/30 ring-1 ring-cyan-500/20'
                        : 'bg-white/[0.02] border-white/[0.06] hover:border-white/[0.1]'
                    }`}
                  >
                    <div className={`text-sm font-semibold ${!isPrivate ? 'text-cyan-400' : 'text-white'}`}>Public</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">Anyone can join</div>
                  </button>
                  <button
                    onClick={() => setIsPrivate(true)}
                    className={`p-3 rounded-lg border text-center transition-all ${
                      isPrivate
                        ? 'bg-amber-500/10 border-amber-500/30 ring-1 ring-amber-500/20'
                        : 'bg-white/[0.02] border-white/[0.06] hover:border-white/[0.1]'
                    }`}
                  >
                    <div className={`text-sm font-semibold ${isPrivate ? 'text-amber-400' : 'text-white'}`}>Private</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">Whitelist only</div>
                  </button>
                </div>
                {isPrivate && (
                  <div className="mt-2 text-[10px] text-amber-400/70 bg-amber-500/5 border border-amber-500/10 rounded-lg px-3 py-2">
                    Private tables require whitelisting players after creation. Manage whitelist from your tables page.
                  </div>
                )}
              </div>

              {/* Summary */}
              <div className="bg-white/[0.02] border border-white/[0.04] rounded-lg p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Token</span>
                  <span className={`font-medium ${denom.color}`}>{denom.symbol}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Blinds</span>
                  <span className="text-white font-medium">
                    {Number(smallBlind) / 10 ** denom.decimals} / {Number(bigBlind) / 10 ** denom.decimals} {denom.symbol}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Table Size</span>
                  <span className="text-white font-medium">{maxPlayers}-max</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Buy-in Range</span>
                  <span className="text-white font-medium">{blindsValid ? `${minBuyIn} – ${maxBuyIn} ${denom.symbol}` : '—'}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Creator Rake</span>
                  <span className="text-emerald-400 font-medium">45% of 5% pot rake</span>
                </div>
                <div className="text-[10px] text-gray-600 -mt-1">5% dealer · 25% stakers · 25% treasury</div>
                <div className="border-t border-white/[0.04] my-2" />
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Platform Fee</span>
                  <span className="text-amber-400 font-medium">{flatSolFee} SOL</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Denomination Fee ({feeBB} BB)</span>
                  <span className="text-amber-400 font-medium">{blindsValid ? denomFeeDisplay : '—'}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Seat Rent (refundable)</span>
                  <span className="text-gray-400 font-medium">~{totalRentEstimate} SOL</span>
                </div>
                <div className="text-[10px] text-gray-600 mt-1">
                  3 wallet approvals (all TXs batch-signed per step, with auto-retry)
                </div>
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-red-400 text-xs">
                  {error}
                  {step !== 'config' && (
                    <button
                      onClick={() => { setStep('config'); setError(null); }}
                      className="mt-2 block text-cyan-400 hover:text-cyan-300 underline text-xs"
                    >
                      Reset and try again
                    </button>
                  )}
                </div>
              )}

              <button
                onClick={handleFullSetup}
                disabled={isProcessing || !blindsValid || step === 'done' || (tokenCategory === 'listed' && !selectedListed)}
                className={`w-full py-3 rounded-lg text-sm font-bold transition-all ${
                  isProcessing || !blindsValid || step === 'done' || (tokenCategory === 'listed' && !selectedListed)
                    ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                    : 'bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 text-gray-950'
                }`}
              >
                {step === 'done'
                  ? '&#10003; Table Live — Redirecting...'
                  : isProcessing
                    ? STEP_LABELS[step]
                    : tokenCategory === 'listed' && !selectedListed
                      ? 'Select a token first'
                      : 'Create & Setup Table'}
              </button>

              <p className="text-xs text-gray-600 text-center">
                Table rent is returned when the table is closed. You will need to approve multiple transactions.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
