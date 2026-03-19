import { PublicKey } from '@solana/web3.js';
import { 
  ANCHOR_PROGRAM_ID, STEEL_PROGRAM_ID,
  TABLE_SEED, SEAT_SEED, SEAT_CARDS_SEED, PLAYER_SEED, STAKE_SEED 
} from './constants';

/**
 * Derive Table PDA
 */
export function getTablePda(tableId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(TABLE_SEED), Buffer.from(tableId)],
    ANCHOR_PROGRAM_ID
  );
}

/**
 * Derive Seat PDA
 */
export function getSeatPda(tablePda: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEAT_SEED), tablePda.toBuffer(), Buffer.from([seatIndex])],
    ANCHOR_PROGRAM_ID
  );
}

/**
 * Derive SeatCards PDA (for private hole cards)
 */
export function getSeatCardsPda(tablePda: PublicKey, seatIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEAT_CARDS_SEED), tablePda.toBuffer(), Buffer.from([seatIndex])],
    ANCHOR_PROGRAM_ID
  );
}

/**
 * Derive Player PDA
 */
export function getPlayerPda(playerPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PLAYER_SEED), playerPubkey.toBuffer()],
    ANCHOR_PROGRAM_ID
  );
}

// NOTE: Old custom getSessionPda removed — use getGumSessionTokenPda from '@/hooks/useSession' instead

/**
 * Derive Stake PDA (Steel program)
 */
export function getStakePda(ownerPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(STAKE_SEED), ownerPubkey.toBuffer()],
    STEEL_PROGRAM_ID
  );
}

/**
 * Generate unique table ID from timestamp + random bytes
 */
export function generateTableId(): Uint8Array {
  const tableId = new Uint8Array(32);
  const now = BigInt(Date.now());
  new DataView(tableId.buffer).setBigUint64(0, now, true);
  
  // Add random bytes for uniqueness
  const randomBytes = crypto.getRandomValues(new Uint8Array(8));
  tableId.set(randomBytes, 24);
  
  return tableId;
}

/**
 * Convert table ID to base58 string for display
 */
export function tableIdToString(tableId: Uint8Array): string {
  // Use first 8 bytes as readable ID
  const shortId = Array.from(tableId.slice(0, 8))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return shortId.toUpperCase();
}
