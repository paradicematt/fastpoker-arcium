'use client';

import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from 'react';
import { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';

const TX_COST_LAMPORTS = 5000;
const MIN_BALANCE_LAMPORTS = 1_000_000;
export const RECOMMENDED_TOPUP_LAMPORTS = 10_000_000;
export const SESSION_KEY_STORAGE_PREFIX = 'fastpoker_session_key';
const SESSION_SIG_STORAGE_PREFIX = 'fastpoker_session_sig';
const SESSION_DERIVE_MESSAGE = 'fastpoker-session-v1';

/**
 * Derive a deterministic session keypair from a wallet signature.
 * Ed25519 signatures are deterministic: same key + same message = same signature = same keypair.
 * Works across devices — no localStorage needed for the keypair itself.
 * Signature is cached in localStorage as an optimization (avoids popup on page reload).
 */
export async function deriveSessionKeypair(
  walletPubkey: PublicKey,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<Keypair> {
  const sigCacheKey = `${SESSION_SIG_STORAGE_PREFIX}_${walletPubkey.toBase58()}`;

  // Try cached signature first (avoids wallet popup)
  const cachedSig = localStorage.getItem(sigCacheKey);
  if (cachedSig) {
    try {
      const sigBytes = Uint8Array.from(atob(cachedSig), c => c.charCodeAt(0));
      const hashBuffer = await crypto.subtle.digest('SHA-256', sigBytes);
      return Keypair.fromSeed(new Uint8Array(hashBuffer));
    } catch {
      localStorage.removeItem(sigCacheKey);
    }
  }

  // Sign deterministic message (one wallet popup)
  const message = new TextEncoder().encode(SESSION_DERIVE_MESSAGE);
  const signature = await signMessage(message);

  // Cache signature for future page loads
  localStorage.setItem(sigCacheKey, btoa(String.fromCharCode.apply(null, Array.from(signature))));

  // SHA-256(signature) → 32-byte seed → deterministic keypair
  const hashBuffer = await crypto.subtle.digest('SHA-256', signature.buffer as ArrayBuffer);
  return Keypair.fromSeed(new Uint8Array(hashBuffer));
}

export interface SessionState {
  sessionKey: Keypair | null;
  balance: number; // in lamports
  isLowBalance: boolean;
  estimatedTxsRemaining: number;
  isActive: boolean;
  status: 'disconnected' | 'loading' | 'active' | 'no_session' | 'low_balance';
}

interface UseSessionReturn {
  session: SessionState;
  isLoading: boolean;
  error: string | null;
  createSession: () => Promise<void>;
  topUpSession: (amount?: number) => Promise<string>;
  reclaimSession: () => Promise<string>;
  reloadSession: () => void;
}

const defaultSession: SessionState = {
  sessionKey: null,
  balance: 0,
  isLowBalance: false,
  estimatedTxsRemaining: 0,
  isActive: false,
  status: 'disconnected',
};

const SessionContext = createContext<UseSessionReturn>({
  session: defaultSession,
  isLoading: false,
  error: null,
  createSession: async () => {},
  topUpSession: async () => '',
  reclaimSession: async () => '',
  reloadSession: () => {},
});

export function useSession(): UseSessionReturn {
  return useContext(SessionContext);
}

/**
 * Arcium L1 Session Provider.
 * Session = a deterministic Keypair derived from wallet signature.
 * The keypair's SOL balance pays for L1 game transactions (~5000 lamports each).
 * No gum-sdk, no on-chain session token PDA — just a funded keypair.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { publicKey: wallet, signMessage, signTransaction, connected } = useWallet();
  const { connection } = useConnection();
  const [session, setSession] = useState<SessionState>(defaultSession);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load session on wallet connect
  useEffect(() => {
    if (!connected || !wallet) {
      setSession(defaultSession);
      return;
    }
    loadSession();
  }, [connected, wallet]);

  const loadSession = useCallback(async () => {
    if (!wallet || !signMessage) return;
    setIsLoading(true);
    setError(null);
    try {
      const keypair = await deriveSessionKeypair(wallet, signMessage);
      const balance = await connection.getBalance(keypair.publicKey);
      const isLowBalance = balance < MIN_BALANCE_LAMPORTS;
      const estimatedTxsRemaining = Math.floor(balance / TX_COST_LAMPORTS);
      const isActive = balance > TX_COST_LAMPORTS;

      setSession({
        sessionKey: keypair,
        balance,
        isLowBalance,
        estimatedTxsRemaining,
        isActive,
        status: isActive ? (isLowBalance ? 'low_balance' : 'active') : 'no_session',
      });
    } catch (e: any) {
      console.error('Failed to load session:', e);
      setError(e.message || 'Failed to derive session key');
      setSession({ ...defaultSession, status: 'no_session' });
    } finally {
      setIsLoading(false);
    }
  }, [wallet, signMessage, connection]);

  const createSession = useCallback(async () => {
    if (!wallet || !signMessage || !signTransaction) {
      throw new Error('Wallet not connected');
    }
    setIsLoading(true);
    setError(null);
    try {
      const keypair = await deriveSessionKeypair(wallet, signMessage);

      // Fund the session key with recommended amount
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet,
          toPubkey: keypair.publicKey,
          lamports: RECOMMENDED_TOPUP_LAMPORTS,
        })
      );
      tx.feePayer = wallet;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const signed = await signTransaction(tx);
      await connection.sendRawTransaction(signed.serialize());

      // Reload balance
      await new Promise(resolve => setTimeout(resolve, 2000));
      await loadSession();
    } catch (e: any) {
      setError(e.message || 'Failed to create session');
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, [wallet, signMessage, signTransaction, connection, loadSession]);

  const topUpSession = useCallback(async (amount: number = RECOMMENDED_TOPUP_LAMPORTS): Promise<string> => {
    if (!wallet || !signTransaction || !session.sessionKey) {
      throw new Error('No active session');
    }
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet,
        toPubkey: session.sessionKey.publicKey,
        lamports: amount,
      })
    );
    tx.feePayer = wallet;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const signed = await signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    setTimeout(() => loadSession(), 2000);
    return sig;
  }, [wallet, signTransaction, session.sessionKey, connection, loadSession]);

  const reclaimSession = useCallback(async (): Promise<string> => {
    if (!wallet || !session.sessionKey) {
      throw new Error('No active session');
    }
    // Transfer all SOL back to wallet (minus TX fee)
    const balance = await connection.getBalance(session.sessionKey.publicKey);
    const transferAmount = balance - TX_COST_LAMPORTS;
    if (transferAmount <= 0) throw new Error('Insufficient session balance');

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: session.sessionKey.publicKey,
        toPubkey: wallet,
        lamports: transferAmount,
      })
    );
    tx.feePayer = session.sessionKey.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(session.sessionKey);
    const sig = await connection.sendRawTransaction(tx.serialize());
    setTimeout(() => loadSession(), 2000);
    return sig;
  }, [wallet, session.sessionKey, connection, loadSession]);

  const value: UseSessionReturn = {
    session,
    isLoading,
    error,
    createSession,
    topUpSession,
    reclaimSession,
    reloadSession: loadSession,
  };

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
}
