import { useCallback, useState } from 'react';
import { Connection, PublicKey, Transaction, Keypair, SystemProgram } from '@solana/web3.js';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { ANCHOR_PROGRAM_ID } from '@/lib/constants';
import { buildJoinTableInstruction } from '@/lib/onchain-game';

const STARTING_STACK = 1500;

interface PendingJoin {
  tablePda: string;
  seatIndex: number;
  maxPlayers: number;
}

interface UseJoinTableReturn {
  joinTable: (tablePda: string, seatIndex: number, maxPlayers?: number) => Promise<string | null>;
  retryJoin: () => Promise<string | null>;
  isPending: boolean;
  error: string | null;
  pendingJoin: PendingJoin | null;
  clearError: () => void;
}

/**
 * Arcium L1 join table hook.
 * Simple join_table instruction on L1 — no gum session bundling, no delegation.
 */
export function useJoinTable(): UseJoinTableReturn {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingJoin, setPendingJoin] = useState<PendingJoin | null>(null);

  const clearError = useCallback(() => {
    setError(null);
    setPendingJoin(null);
  }, []);

  const joinTable = useCallback(async (
    tablePdaString: string,
    seatIndex: number,
    maxPlayers: number = 2
  ): Promise<string | null> => {
    if (!publicKey || !sendTransaction) {
      setError('Wallet not connected');
      return null;
    }

    setIsPending(true);
    setError(null);

    try {
      const tablePda = new PublicKey(tablePdaString);
      const tx = new Transaction();

      // Add join table instruction
      const joinInstruction = buildJoinTableInstruction(
        publicKey,
        tablePda,
        seatIndex,
        STARTING_STACK,
        // SNG: no cash game opts needed — vault/receipt/token accounts default to None
      );
      tx.add(joinInstruction);

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      // Simulate first to get detailed error
      try {
        const simResult = await connection.simulateTransaction(tx);
        if (simResult.value.err) {
          console.error('Simulation failed:', simResult.value.err);
          console.error('Logs:', simResult.value.logs);
          throw new Error(`Simulation failed: ${JSON.stringify(simResult.value.err)}\nLogs: ${simResult.value.logs?.join('\n')}`);
        }
      } catch (simErr: any) {
        if (simErr.message?.includes('Simulation failed')) throw simErr;
        console.warn('Simulation check failed:', simErr.message);
      }

      const signature = await sendTransaction(tx, connection);
      await connection.confirmTransaction(signature, 'confirmed');

      console.log('Joined table on-chain:', signature);
      return signature;
    } catch (err: any) {
      console.error('Join table failed:', err);
      const msg = err.message || 'Failed to join table';
      const isWhitelistError = msg.includes('0x1796')
        || (msg.includes('Unauthorized') && !msg.includes('Session'));
      setError(isWhitelistError
        ? 'This is a private table. You are not on the whitelist. Ask the table creator to add your wallet.'
        : msg);
      setPendingJoin({ tablePda: tablePdaString, seatIndex, maxPlayers });
      throw err;
    } finally {
      setIsPending(false);
    }
  }, [publicKey, sendTransaction, connection]);

  const retryJoin = useCallback(async (): Promise<string | null> => {
    if (!pendingJoin) {
      setError('No pending join to retry');
      return null;
    }
    const { tablePda, seatIndex, maxPlayers } = pendingJoin;
    setPendingJoin(null);
    return joinTable(tablePda, seatIndex, maxPlayers);
  }, [pendingJoin, joinTable]);

  return {
    joinTable,
    retryJoin,
    isPending,
    error,
    pendingJoin,
    clearError,
  };
}
