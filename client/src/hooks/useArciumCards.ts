'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useConnection } from '@solana/wallet-adapter-react';
import { getSeatCardsPda } from '@/lib/pda';
import { parseCard, Card } from '@/lib/cards';
import { SEAT_CARDS_OFFSETS, CARD_NOT_DEALT } from '@/lib/constants';
import type { X25519Keypair } from '@/lib/arcium-keys';

interface UseArciumCardsReturn {
  holeCards: [Card | null, Card | null];
  isEncrypted: boolean;
  isLoading: boolean;
  error: string | null;
}

/**
 * Hook for decrypting Arcium-encrypted hole cards during active play.
 *
 * During play, SeatCards.card1/card2 are 255 (not dealt). The actual cards are
 * encrypted in SeatCards.enc_card1 (32-byte Rescue ciphertext at offset 76).
 * This hook reads the ciphertext + nonce, then decrypts using the player's
 * x25519 secret key and the MXE public key.
 *
 * Decryption flow (verified in backend E2E):
 *   1. Read enc_card1 (32B at offset 76) and nonce (16B at offset 140) from SeatCards
 *   2. Derive shared secret: x25519.getSharedSecret(playerSecretKey, mxePublicKey)
 *   3. RescueCipher(sharedSecret).decrypt([ctBigint], nonce) → packed u16
 *   4. card1 = (u16 >> 8) & 0xFF, card2 = u16 & 0xFF
 *
 * Falls back to plaintext card1/card2 at showdown (when they're not 255).
 */
export function useArciumCards(
  tablePda: PublicKey | null,
  seatIndex: number | null,
  x25519Keypair: X25519Keypair | null,
  mxePublicKey: Uint8Array | null,
  pollIntervalMs: number = 2000,
): UseArciumCardsReturn {
  const { connection } = useConnection();
  const [holeCards, setHoleCards] = useState<[Card | null, Card | null]>([null, null]);
  const [isEncrypted, setIsEncrypted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastEncHex = useRef<string>('');

  const fetchAndDecrypt = useCallback(async () => {
    if (!tablePda || seatIndex === null) {
      setHoleCards([null, null]);
      setIsEncrypted(false);
      return;
    }

    try {
      const [seatCardsPda] = getSeatCardsPda(tablePda, seatIndex);
      const info = await connection.getAccountInfo(seatCardsPda);
      if (!info || info.data.length < SEAT_CARDS_OFFSETS.NONCE + 16) {
        setHoleCards([null, null]);
        return;
      }

      const data = info.data;

      // First check plaintext cards (available at showdown)
      const card1Val = data[SEAT_CARDS_OFFSETS.CARD1];
      const card2Val = data[SEAT_CARDS_OFFSETS.CARD2];
      if (card1Val !== CARD_NOT_DEALT && card2Val !== CARD_NOT_DEALT) {
        setHoleCards([parseCard(card1Val), parseCard(card2Val)]);
        setIsEncrypted(false);
        return;
      }

      // Check if encrypted cards exist
      const encCard1 = data.slice(SEAT_CARDS_OFFSETS.ENC_CARD1, SEAT_CARDS_OFFSETS.ENC_CARD1 + 32);
      const isAllZero = encCard1.every((b: number) => b === 0);
      if (isAllZero) {
        setHoleCards([null, null]);
        setIsEncrypted(false);
        return;
      }

      // Encrypted cards exist — try to decrypt
      const encHex = Buffer.from(encCard1).toString('hex');
      if (encHex === lastEncHex.current && holeCards[0] !== null) {
        return; // Same ciphertext, already decrypted
      }
      lastEncHex.current = encHex;

      if (!x25519Keypair || !mxePublicKey) {
        setIsEncrypted(true);
        setHoleCards([null, null]);
        setError('x25519 key or MXE public key not available');
        return;
      }

      setIsLoading(true);

      // Decrypt using Rescue cipher
      const nonce = data.slice(SEAT_CARDS_OFFSETS.NONCE, SEAT_CARDS_OFFSETS.NONCE + 16);
      const { x25519: x25519Fn } = await import('@noble/curves/ed25519');
      const sharedSecret = x25519Fn.getSharedSecret(x25519Keypair.secretKey, mxePublicKey);

      // Convert ciphertext bytes to BigInt (LE)
      let ctBigint = BigInt(0);
      for (let i = 31; i >= 0; i--) {
        ctBigint = (ctBigint << BigInt(8)) | BigInt(encCard1[i]);
      }

      // Convert nonce bytes to BigInt (LE u128)
      let nonceBigint = BigInt(0);
      for (let i = 15; i >= 0; i--) {
        nonceBigint = (nonceBigint << BigInt(8)) | BigInt(nonce[i]);
      }

      // Import RescueCipher from @arcium-hq/client
      const { RescueCipher } = await import('@arcium-hq/client');
      const cipher = new RescueCipher(sharedSecret);
      const decrypted = cipher.decrypt([ctBigint], nonceBigint);

      if (decrypted && decrypted.length > 0) {
        const packed = Number(decrypted[0]);
        const c1 = (packed >> 8) & 0xFF;
        const c2 = packed & 0xFF;

        if (c1 >= 0 && c1 <= 51 && c2 >= 0 && c2 <= 51) {
          setHoleCards([parseCard(c1), parseCard(c2)]);
          setIsEncrypted(true);
          setError(null);
        } else {
          setHoleCards([null, null]);
          setIsEncrypted(true);
          setError(`Decrypted invalid cards: ${c1}, ${c2}`);
        }
      } else {
        setHoleCards([null, null]);
        setIsEncrypted(true);
        setError('Decryption returned empty');
      }
    } catch (err: any) {
      console.error('[useArciumCards] decrypt error:', err);
      setError(err.message || 'Decryption failed');
      setIsEncrypted(true);
    } finally {
      setIsLoading(false);
    }
  }, [tablePda, seatIndex, x25519Keypair, mxePublicKey, connection]);

  // Poll for card updates
  useEffect(() => {
    fetchAndDecrypt();

    if (tablePda && seatIndex !== null) {
      intervalRef.current = setInterval(fetchAndDecrypt, pollIntervalMs);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchAndDecrypt, tablePda, seatIndex, pollIntervalMs]);

  return { holeCards, isEncrypted, isLoading, error };
}
