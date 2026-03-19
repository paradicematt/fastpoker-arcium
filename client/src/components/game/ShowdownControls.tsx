'use client';

import { useState } from 'react';
import { PublicKey, Transaction, TransactionInstruction, Connection } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { ANCHOR_PROGRAM_ID, L1_RPC } from '@/lib/constants';
import { getSeatPda } from '@/lib/pda';

interface ShowdownControlsProps {
  tablePda: PublicKey;
  seatIndex: number;
  isWinner: boolean;
  canMuck: boolean;
  onActionComplete?: () => void;
}

// Anchor discriminators
const SHOW_CARDS_DISCRIMINATOR = Buffer.from([147, 212, 51, 129, 87, 142, 51, 205]);
const MUCK_CARDS_DISCRIMINATOR = Buffer.from([93, 171, 28, 199, 216, 87, 193, 74]);

/**
 * Showdown Controls - Show or Muck cards at showdown
 * 
 * Winner must show cards to claim pot.
 * Losers can choose to show (for stats/reputation) or muck (hide).
 */
export function ShowdownControls({ 
  tablePda, 
  seatIndex, 
  isWinner, 
  canMuck,
  onActionComplete 
}: ShowdownControlsProps) {
  const { publicKey, sendTransaction } = useWallet();
  const [isPending, setIsPending] = useState(false);
  const [actionTaken, setActionTaken] = useState<'show' | 'muck' | null>(null);

  const handleShow = async () => {
    if (!publicKey || !sendTransaction) return;
    
    setIsPending(true);
    try {
      const connection = new Connection(L1_RPC, 'confirmed');
      const [seatPda] = getSeatPda(tablePda, seatIndex);

      const ix = new TransactionInstruction({
        programId: ANCHOR_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: true },
          { pubkey: seatPda, isSigner: false, isWritable: true },
        ],
        data: SHOW_CARDS_DISCRIMINATOR,
      });

      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig);
      
      setActionTaken('show');
      onActionComplete?.();
    } catch (err: any) {
      console.error('Show cards failed:', err);
      alert('Failed to show cards: ' + err.message);
    } finally {
      setIsPending(false);
    }
  };

  const handleMuck = async () => {
    if (!publicKey || !sendTransaction || !canMuck) return;
    
    setIsPending(true);
    try {
      const connection = new Connection(L1_RPC, 'confirmed');
      const [seatPda] = getSeatPda(tablePda, seatIndex);

      const ix = new TransactionInstruction({
        programId: ANCHOR_PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: true },
          { pubkey: seatPda, isSigner: false, isWritable: true },
        ],
        data: MUCK_CARDS_DISCRIMINATOR,
      });

      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig);
      
      setActionTaken('muck');
      onActionComplete?.();
    } catch (err: any) {
      console.error('Muck cards failed:', err);
      alert('Failed to muck cards: ' + err.message);
    } finally {
      setIsPending(false);
    }
  };

  if (actionTaken) {
    return (
      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 text-center">
        <span className="text-gray-400">
          {actionTaken === 'show' ? '✓ Cards shown' : '✓ Cards mucked'}
        </span>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-r from-purple-500/10 to-pink-500/10 border border-purple-500/30 rounded-xl p-6">
      <h3 className="text-lg font-bold text-white text-center mb-4">
        🏆 Showdown
      </h3>
      
      {isWinner ? (
        <div className="text-center">
          <p className="text-green-400 mb-4">You won! Show your cards to claim the pot.</p>
          <button
            onClick={handleShow}
            disabled={isPending}
            className="px-8 py-3 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 rounded-lg text-white font-bold disabled:opacity-50"
          >
            {isPending ? 'Showing...' : '👁️ Show Cards & Claim Pot'}
          </button>
        </div>
      ) : (
        <div className="text-center">
          <p className="text-gray-400 mb-4">
            {canMuck 
              ? 'You can show your cards or muck them.' 
              : 'You must show your cards.'}
          </p>
          <div className="flex justify-center gap-4">
            <button
              onClick={handleShow}
              disabled={isPending}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg text-white font-bold disabled:opacity-50"
            >
              {isPending ? '...' : '👁️ Show'}
            </button>
            {canMuck && (
              <button
                onClick={handleMuck}
                disabled={isPending}
                className="px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-white font-bold disabled:opacity-50"
              >
                {isPending ? '...' : '🙈 Muck'}
              </button>
            )}
          </div>
        </div>
      )}

      <p className="text-gray-500 text-xs text-center mt-4">
        {isWinner 
          ? 'Winners must reveal their hand to claim winnings'
          : 'Mucking hides your cards from other players'}
      </p>
    </div>
  );
}
