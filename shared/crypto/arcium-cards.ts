/**
 * Arcium Card Decryption Utility
 *
 * Standalone module for decrypting hole cards from SeatCards accounts.
 * Uses x25519 key exchange with the MXE to derive a shared secret,
 * then Rescue cipher to decrypt encrypted card data.
 *
 * Dependencies: @arcium-hq/client (x25519, getMXEPublicKey)
 *               @solana/web3.js   (Connection, PublicKey)
 *
 * Usage:
 *   const decryptor = new ArciumCardDecryptor(connection, mxeProgramId);
 *   await decryptor.init(walletSignMessage);
 *   const cards = await decryptor.decryptSeatCards(seatCardsPDA);
 *
 * For mock/local mode (devnet_bypass_deal), cards are plaintext in card1/card2
 * fields — no decryption needed. Use readPlaintextCards() instead.
 */

import { Connection, PublicKey } from '@solana/web3.js';

// ─── Card Constants ───
export const CARD_NOT_DEALT = 255;
export const TOTAL_CARDS = 52;

// ─── SeatCards Account Layout (matches programs/fastpoker/src/state/seat_cards.rs) ───
// Anchor discriminator: 8 bytes
// table:      Pubkey (32)
// seat_index: u8     (1)
// player:     Pubkey (32)
// card1:      u8     (1)  — plaintext, 255 = not dealt
// card2:      u8     (1)  — plaintext, 255 = not dealt
// bump:       u8     (1)
// enc_card1:  [u8;32](32) — Rescue ciphertext
// enc_card2:  [u8;32](32) — Rescue ciphertext
// nonce:      [u8;16](16) — decryption nonce
const SEAT_CARDS_OFFSETS = {
  DISCRIMINATOR: 0,   // 8 bytes
  TABLE:         8,   // 32 bytes
  SEAT_INDEX:    40,  // 1 byte
  PLAYER:        41,  // 32 bytes
  CARD1:         73,  // 1 byte (plaintext)
  CARD2:         74,  // 1 byte (plaintext)
  BUMP:          75,  // 1 byte
  ENC_CARD1:     76,  // 32 bytes (ciphertext)
  ENC_CARD2:     108, // 32 bytes (ciphertext)
  NONCE:         140, // 16 bytes
  TOTAL_SIZE:    156, // 8 + 148 (discriminator + SeatCards::LEN)
} as const;

// ─── Card Representation ───
export type Suit = 'h' | 'd' | 'c' | 's';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type CardString = `${Rank}${Suit}`;

export interface DecodedCard {
  index: number;      // 0-51
  rank: Rank;
  suit: Suit;
  display: CardString; // e.g. "As", "Kh", "2c"
}

export interface SeatCardsData {
  table: PublicKey;
  seatIndex: number;
  player: PublicKey;
  card1: number;       // plaintext (255 = not dealt)
  card2: number;       // plaintext (255 = not dealt)
  encCard1: Uint8Array; // 32-byte ciphertext
  encCard2: Uint8Array; // 32-byte ciphertext
  nonce: Uint8Array;    // 16-byte nonce
}

export interface DecryptedHoleCards {
  card1: DecodedCard | null; // null if not dealt
  card2: DecodedCard | null;
}

// ─── Card Index Mapping ───
// Matches hand_eval.rs encoding: rank = card % 13, suit = card / 13
// Rank: 0=2, 1=3, ..., 8=T, 9=J, 10=Q, 11=K, 12=A
// Suit: 0=clubs, 1=diamonds, 2=hearts, 3=spades
const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS: Suit[] = ['c', 'd', 'h', 's'];

export function decodeCardIndex(index: number): DecodedCard | null {
  if (index === CARD_NOT_DEALT || index >= TOTAL_CARDS) return null;
  const rankIdx = index % 13;
  const suitIdx = Math.floor(index / 13);
  const rank = RANKS[rankIdx];
  const suit = SUITS[suitIdx];
  return { index, rank, suit, display: `${rank}${suit}` as CardString };
}

// ─── Parse SeatCards Account Data ───
export function parseSeatCards(data: Buffer | Uint8Array): SeatCardsData {
  const buf = Buffer.from(data);
  if (buf.length < SEAT_CARDS_OFFSETS.TOTAL_SIZE) {
    throw new Error(`SeatCards data too short: ${buf.length} < ${SEAT_CARDS_OFFSETS.TOTAL_SIZE}`);
  }
  return {
    table: new PublicKey(buf.subarray(SEAT_CARDS_OFFSETS.TABLE, SEAT_CARDS_OFFSETS.TABLE + 32)),
    seatIndex: buf[SEAT_CARDS_OFFSETS.SEAT_INDEX],
    player: new PublicKey(buf.subarray(SEAT_CARDS_OFFSETS.PLAYER, SEAT_CARDS_OFFSETS.PLAYER + 32)),
    card1: buf[SEAT_CARDS_OFFSETS.CARD1],
    card2: buf[SEAT_CARDS_OFFSETS.CARD2],
    encCard1: new Uint8Array(buf.subarray(SEAT_CARDS_OFFSETS.ENC_CARD1, SEAT_CARDS_OFFSETS.ENC_CARD1 + 32)),
    encCard2: new Uint8Array(buf.subarray(SEAT_CARDS_OFFSETS.ENC_CARD2, SEAT_CARDS_OFFSETS.ENC_CARD2 + 32)),
    nonce: new Uint8Array(buf.subarray(SEAT_CARDS_OFFSETS.NONCE, SEAT_CARDS_OFFSETS.NONCE + 16)),
  };
}

// ─── Read Plaintext Cards (Mock/Local Mode) ───
// When using devnet_bypass_deal, cards are in plaintext fields.
// No decryption needed — just read card1/card2 directly.
export async function readPlaintextCards(
  connection: Connection,
  seatCardsPDA: PublicKey,
): Promise<DecryptedHoleCards> {
  const info = await connection.getAccountInfo(seatCardsPDA);
  if (!info || info.data.length < SEAT_CARDS_OFFSETS.TOTAL_SIZE) {
    return { card1: null, card2: null };
  }
  const parsed = parseSeatCards(info.data);
  return {
    card1: decodeCardIndex(parsed.card1),
    card2: decodeCardIndex(parsed.card2),
  };
}

// ─── Arcium Decryption (Production Mode) ───
// Requires @arcium-hq/client SDK for x25519 + Rescue cipher.
//
// Pattern:
//   1. Derive deterministic keypair from wallet signature
//   2. Fetch MXE public key from on-chain account
//   3. x25519 shared secret = ECDH(clientPriv, mxePub)
//   4. Rescue cipher decrypt enc_card1/enc_card2 using shared secret + nonce
//
// The implementation below is a skeleton — the actual Rescue cipher
// decrypt function comes from @arcium-hq/client SDK.

/**
 * Derive a deterministic x25519 private key from a wallet signature.
 * The player signs a known message, and the signature is hashed to
 * produce a stable 32-byte private key. This avoids storing a separate
 * keypair — the same wallet always produces the same decryption key.
 *
 * @param signMessage - wallet.signMessage() function
 * @returns 32-byte x25519 private key
 */
export async function deriveDecryptionKey(
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const msg = new TextEncoder().encode('FastPoker Arcium Card Decryption Key v1');
  const signature = await signMessage(msg);
  // Hash the signature to get a uniform 32-byte key
  // Use SubtleCrypto (browser) or crypto (Node.js)
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', signature);
    return new Uint8Array(hash);
  }
  // Node.js fallback
  const { createHash } = await import('crypto');
  return new Uint8Array(createHash('sha256').update(signature).digest());
}

/**
 * ArciumCardDecryptor — full decryption pipeline.
 *
 * Initialize once per session, then call decryptSeatCards() per hand.
 * Requires @arcium-hq/client to be installed.
 *
 * Usage:
 *   const decryptor = new ArciumCardDecryptor(connection, mxeProgramId);
 *   await decryptor.init(wallet.signMessage);
 *   const cards = await decryptor.decryptSeatCards(seatCardsPDA);
 */
export class ArciumCardDecryptor {
  private connection: Connection;
  private mxeProgramId: PublicKey;
  private clientPrivateKey: Uint8Array | null = null;
  private clientPublicKey: Uint8Array | null = null;
  private sharedSecret: Uint8Array | null = null;
  private initialized = false;

  constructor(connection: Connection, mxeProgramId: PublicKey) {
    this.connection = connection;
    this.mxeProgramId = mxeProgramId;
  }

  /**
   * Initialize the decryptor by deriving keys and performing x25519 exchange.
   * Call once per session (e.g., when player sits down at table).
   */
  async init(signMessage: (message: Uint8Array) => Promise<Uint8Array>): Promise<void> {
    // Dynamic import — @arcium-hq/client must be installed
    const { x25519, getMXEPublicKey } = await import('@arcium-hq/client');

    // 1. Derive deterministic private key from wallet signature
    this.clientPrivateKey = await deriveDecryptionKey(signMessage);
    this.clientPublicKey = x25519.getPublicKey(this.clientPrivateKey);

    // 2. Fetch MXE public key from on-chain account
    const mxePublicKey = await getMXEPublicKey(this.connection, this.mxeProgramId);

    // 3. Derive shared secret via x25519 ECDH
    this.sharedSecret = x25519.getSharedSecret(this.clientPrivateKey, mxePublicKey);

    this.initialized = true;
  }

  /** Get the client's x25519 public key (sent to MPC as player_pubkey). */
  getPublicKey(): Uint8Array {
    if (!this.clientPublicKey) throw new Error('ArciumCardDecryptor not initialized');
    return this.clientPublicKey;
  }

  /**
   * Decrypt hole cards from a SeatCards PDA account.
   *
   * Reads the account, extracts ciphertext + nonce, decrypts using
   * the shared secret derived during init().
   *
   * Returns null cards if not dealt or decryption fails.
   */
  async decryptSeatCards(seatCardsPDA: PublicKey): Promise<DecryptedHoleCards> {
    if (!this.initialized || !this.sharedSecret) {
      throw new Error('ArciumCardDecryptor not initialized — call init() first');
    }

    const info = await this.connection.getAccountInfo(seatCardsPDA);
    if (!info || info.data.length < SEAT_CARDS_OFFSETS.TOTAL_SIZE) {
      return { card1: null, card2: null };
    }

    const parsed = parseSeatCards(info.data);

    // If plaintext cards are already revealed (showdown), use them directly
    if (parsed.card1 !== CARD_NOT_DEALT && parsed.card2 !== CARD_NOT_DEALT) {
      return {
        card1: decodeCardIndex(parsed.card1),
        card2: decodeCardIndex(parsed.card2),
      };
    }

    // Check if encrypted cards exist
    const hasEncrypted = parsed.encCard1.some(b => b !== 0);
    if (!hasEncrypted) {
      return { card1: null, card2: null };
    }

    // Decrypt packed u16 from enc_card1 using Rescue cipher with shared secret + output nonce.
    // Packed format: card1 * 256 + card2 in a single Enc<Shared, u16> ciphertext.
    // enc_card2 is zeroed in packed format (only enc_card1 is used).
    // The output nonce = input nonce + 1 (LE u128), stored in SeatCards.nonce by callback.
    try {
      const { RescueCipher } = await import('@arcium-hq/client');
      const cipher = new RescueCipher(this.sharedSecret);
      const result = cipher.decrypt([Array.from(parsed.encCard1)], parsed.nonce);
      const packed = Number(result[0]);

      // Unpack: card1 = high byte, card2 = low byte
      const cardIdx1 = (packed >> 8) & 0xFF;
      const cardIdx2 = packed & 0xFF;

      return {
        card1: decodeCardIndex(cardIdx1),
        card2: decodeCardIndex(cardIdx2),
      };
    } catch (err) {
      console.warn('Arcium card decryption failed (SDK not available or wrong key):', err);
      return { card1: null, card2: null };
    }
  }
}

// ─── PDA Derivation Helpers ───
const FASTPOKER_PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');

export function getSeatCardsPda(
  table: PublicKey,
  seatIndex: number,
  programId: PublicKey = FASTPOKER_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat_cards'), table.toBuffer(), Buffer.from([seatIndex])],
    programId,
  )[0];
}
