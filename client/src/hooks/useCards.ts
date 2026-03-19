'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { getSeatCardsPda } from '@/lib/pda';
import { parseCard, Card } from '@/lib/cards';
import { L1_RPC, SEAT_CARDS_OFFSETS, CARD_NOT_DEALT } from '@/lib/constants';

interface UseCardsReturn {
  holeCards: [Card | null, Card | null];
  communityCards: Card[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Read account from L1 (Arcium — no TEE/ER).
 */
async function readAccount(
  conn: Connection,
  pubkey: PublicKey,
): Promise<Buffer | null> {
  try {
    const info = await conn.getAccountInfo(pubkey);
    if (info && info.data.length > 0) return info.data as Buffer;
  } catch { /* fall through */ }
  return null;
}

/**
 * Hook for reading hole cards and community cards from L1.
 *
 * Arcium architecture:
 * - Hole cards: Read plaintext card1/card2 from SeatCards PDA (offsets 73/74).
 *   During active play, these are 255 (not dealt) — only written at showdown reveal.
 *   For encrypted card display during play, use useArciumCards hook (requires Rescue decryption).
 * - Community cards: Read from Table account at offset 155 (plaintext after crank reveal).
 * - Opponent cards: Read plaintext card1/card2 at showdown.
 */
export function useCards(tablePda: PublicKey | null, seatIndex: number | null): UseCardsReturn {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [holeCards, setHoleCards] = useState<[Card | null, Card | null]>([null, null]);
  const [communityCards, setCommunityCards] = useState<Card[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCards = useCallback(async () => {
    if (!tablePda || seatIndex === null || !publicKey) {
      setHoleCards([null, null]);
      setCommunityCards([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Read SeatCards PDA from L1
      const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
      const seatCardsData = await readAccount(connection, seatCardsPda);

      if (seatCardsData && seatCardsData.length >= SEAT_CARDS_OFFSETS.BUMP) {
        // Plaintext card1/card2 (written at showdown reveal, 255 otherwise)
        const card1 = parseCard(seatCardsData[SEAT_CARDS_OFFSETS.CARD1]);
        const card2 = parseCard(seatCardsData[SEAT_CARDS_OFFSETS.CARD2]);
        setHoleCards([card1, card2]);
      } else {
        setHoleCards([null, null]);
      }

      // Read community cards from Table account (plaintext after crank reveal)
      const tableData = await readAccount(connection, tablePda);
      if (tableData) {
        const communityOffset = 155;
        if (tableData.length >= communityOffset + 5) {
          const cards: Card[] = [];
          for (let i = 0; i < 5; i++) {
            const cardByte = tableData[communityOffset + i];
            if (cardByte !== CARD_NOT_DEALT && cardByte !== 0) {
              const card = parseCard(cardByte);
              if (card) cards.push(card);
            }
          }
          setCommunityCards(cards);
        }
      }
    } catch (err: any) {
      console.error('Failed to fetch cards:', err);
      setError(err.message || 'Failed to load cards');
    } finally {
      setIsLoading(false);
    }
  }, [tablePda, seatIndex, publicKey, connection]);

  useEffect(() => {
    fetchCards();
  }, [fetchCards]);

  return {
    holeCards,
    communityCards,
    isLoading,
    error,
    refresh: fetchCards,
  };
}

/**
 * Hook for reading opponent's visible cards (face-up at showdown).
 * In Arcium, opponents' cards are plaintext in card1/card2 only after showdown reveal.
 */
export function useOpponentCards(tablePda: PublicKey | null, seatIndex: number): Card[] {
  const { connection } = useConnection();
  const [cards, setCards] = useState<Card[]>([]);

  useEffect(() => {
    if (!tablePda) {
      setCards([]);
      return;
    }

    const fetchOpponentCards = async () => {
      try {
        const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
        const data = await readAccount(connection, seatCardsPda);

        if (data && data.length >= SEAT_CARDS_OFFSETS.BUMP) {
          const card1Val = data[SEAT_CARDS_OFFSETS.CARD1];
          const card2Val = data[SEAT_CARDS_OFFSETS.CARD2];
          if (card1Val !== CARD_NOT_DEALT && card2Val !== CARD_NOT_DEALT) {
            const card1 = parseCard(card1Val);
            const card2 = parseCard(card2Val);
            setCards([card1, card2].filter((c): c is Card => c !== null));
          } else {
            setCards([]);
          }
        }
      } catch (err) {
        console.error('Failed to fetch opponent cards:', err);
      }
    };

    fetchOpponentCards();
  }, [tablePda, seatIndex, connection]);

  return cards;
}
