'use client';

import { useState, useEffect, useCallback } from 'react';
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { L1_RPC, ANCHOR_PROGRAM_ID, STEEL_PROGRAM_ID, POOL_PDA, TREASURY, PLAYER_CLAIMABLE_SOL_OFFSET } from '@/lib/constants';
import { getPlayerPda } from '@/lib/pda';

// Constants from program
const REGISTRATION_COST = 0; // Free registration (rent-only)
const FREE_ENTRIES_ON_REGISTER = 0; // Decoupled — admin grants free entries separately

// Anchor discriminators
const REGISTER_DISCRIMINATOR = Buffer.from([242, 146, 194, 234, 234, 145, 228, 42]);

// Steel init_unrefined discriminator (disc byte = 24, no args)
const INIT_UNREFINED_DISC = Buffer.from([24]);

/** Derive Unrefined PDA (Steel program) */
function getUnrefinedPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('unrefined'), owner.toBuffer()],
    STEEL_PROGRAM_ID,
  );
}

export interface PlayerStats {
  isRegistered: boolean;
  freeEntries: number;
  handsPlayed: number;
  handsWon: number;
  totalWinnings: number;
  totalLosses: number;
  tournamentsPlayed: number;
  tournamentsWon: number;
  registeredAt: number;
  claimableSol: number; // lamports of SOL winnings available to claim
}

interface UsePlayerReturn {
  player: PlayerStats | null;
  isLoading: boolean;
  error: string | null;
  register: () => Promise<string>;
  refresh: () => Promise<void>;
}

/**
 * Hook for reading PlayerAccount PDA from chain
 * 
 * All player data (registration, free entries, stats) is on-chain.
 */
export function usePlayer(): UsePlayerReturn {
  const { publicKey, sendTransaction, connected } = useWallet();
  const [player, setPlayer] = useState<PlayerStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPlayer = useCallback(async () => {
    if (!publicKey || !connected) {
      setPlayer(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const connection = new Connection(L1_RPC, 'confirmed');
      const [playerPda] = getPlayerPda(publicKey);
      const [unrefinedPda] = getUnrefinedPda(publicKey);
      
      // Check both PDAs in parallel
      const [accountInfo, unrefinedInfo] = await Promise.all([
        connection.getAccountInfo(playerPda),
        connection.getAccountInfo(unrefinedPda),
      ]);
      
      if (!accountInfo) {
        // Player not registered at all
        setPlayer({
          isRegistered: false,
          freeEntries: 0,
          handsPlayed: 0,
          handsWon: 0,
          totalWinnings: 0,
          totalLosses: 0,
          tournamentsPlayed: 0,
          tournamentsWon: 0,
          registeredAt: 0,
          claimableSol: 0,
        });
        return;
      }

      // Parse PlayerAccount data
      // Layout: discriminator(8) + wallet(32) + is_registered(1) + free_entries(1) + 
      //         hands_played(8) + hands_won(8) + total_winnings(8) + total_losses(8) +
      //         tournaments_played(4) + tournaments_won(4) + registered_at(8) + bump(1)
      const data = accountInfo.data;
      
      // Fully registered only if BOTH PlayerAccount AND Unrefined PDA exist
      const isRegistered = data[40] === 1 && !!unrefinedInfo;
      const freeEntries = data[41];
      const handsPlayed = Number(data.readBigUInt64LE(42));
      const handsWon = Number(data.readBigUInt64LE(50));
      const totalWinnings = Number(data.readBigUInt64LE(58)) / 1e9; // Convert to SOL
      const totalLosses = Number(data.readBigUInt64LE(66)) / 1e9;
      const tournamentsPlayed = data.readUInt32LE(74);
      const tournamentsWon = data.readUInt32LE(78);
      const registeredAt = Number(data.readBigInt64LE(82));
      // claimable_sol at offset 91 (u64 LE) — SOL winnings from tiered SNGs
      const claimableSol = data.length >= PLAYER_CLAIMABLE_SOL_OFFSET + 8
        ? Number(data.readBigUInt64LE(PLAYER_CLAIMABLE_SOL_OFFSET))
        : 0;

      setPlayer({
        isRegistered,
        freeEntries,
        handsPlayed,
        handsWon,
        totalWinnings,
        totalLosses,
        tournamentsPlayed,
        tournamentsWon,
        registeredAt,
        claimableSol,
      });
    } catch (err: any) {
      console.error('Failed to fetch player:', err);
      setError(err.message || 'Failed to load player data');
      // Assume not registered on error
      setPlayer({
        isRegistered: false,
        freeEntries: 0,
        handsPlayed: 0,
        handsWon: 0,
        totalWinnings: 0,
        totalLosses: 0,
        tournamentsPlayed: 0,
        tournamentsWon: 0,
        registeredAt: 0,
        claimableSol: 0,
      });
    } finally {
      setIsLoading(false);
    }
  }, [publicKey, connected]);

  // Fetch on mount and wallet change
  useEffect(() => {
    fetchPlayer();
  }, [fetchPlayer]);

  // Fetch on connect only - no polling needed
  // Player data changes infrequently, refresh manually when needed

  const register = useCallback(async (): Promise<string> => {
    if (!publicKey || !sendTransaction) {
      throw new Error('Wallet not connected');
    }

    const connection = new Connection(L1_RPC, 'confirmed');
    const [playerPda] = getPlayerPda(publicKey);
    const [unrefinedPda] = getUnrefinedPda(publicKey);

    // Check which PDAs already exist
    const [playerInfo, unrefinedInfo] = await Promise.all([
      connection.getAccountInfo(playerPda),
      connection.getAccountInfo(unrefinedPda),
    ]);

    const tx = new Transaction();

    // Only add register_player if PlayerAccount PDA doesn't exist
    if (!playerInfo) {
      tx.add(new TransactionInstruction({
        programId: ANCHOR_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: playerPda, isSigner: false, isWritable: true },
          { pubkey: TREASURY, isSigner: false, isWritable: true },
          { pubkey: POOL_PDA, isSigner: false, isWritable: true },
          { pubkey: unrefinedPda, isSigner: false, isWritable: true },
          { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: REGISTER_DISCRIMINATOR,
      }));
    }

    // Legacy repair path: if Player PDA exists from old flow but Unrefined is missing,
    // initialize it directly via Steel.
    if (playerInfo && !unrefinedInfo) {
      tx.add(new TransactionInstruction({
        programId: STEEL_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: unrefinedPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: INIT_UNREFINED_DISC,
      }));
    }

    // If both already exist, nothing to do
    if (tx.instructions.length === 0) {
      await fetchPlayer();
      return 'already_registered';
    }

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = publicKey;

    const signature = await sendTransaction(tx, connection);
    await connection.confirmTransaction(signature, 'confirmed');

    // Refresh player data
    await fetchPlayer();

    return signature;
  }, [publicKey, sendTransaction, fetchPlayer]);

  return {
    player,
    isLoading,
    error,
    register,
    refresh: fetchPlayer,
  };
}

/**
 * Get cost to register (for display)
 */
export function getRegistrationCost(): number {
  return REGISTRATION_COST / 1e9; // In SOL
}

/**
 * Get number of free entries given on registration
 */
export function getFreeEntriesOnRegister(): number {
  return FREE_ENTRIES_ON_REGISTER;
}
