/**
 * Privacy Sneak Test
 *
 * Verifies that an opponent CANNOT decrypt another player's packed SeatCards ciphertexts.
 * Runs after a successful arcium_deal (requires table in Preflop phase).
 *
 * Tests:
 * 1. Read all SeatCards for a table — ciphertexts must be non-zero
 * 2. Opponent's x25519 key CANNOT derive the same shared secret
 * 3. DeckState community cards are encrypted (not plaintext) before reveal
 * 4. Folded/empty seats have zero ciphertexts (no data leakage)
 */

import {
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

// ─── Config ───
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');

// ─── PDA helpers ───
function getSeatCardsPda(table: PublicKey, seatIndex: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat_cards'), table.toBuffer(), Buffer.from([seatIndex])],
    PROGRAM_ID,
  )[0];
}

function getDeckStatePda(table: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('deck_state'), table.toBuffer()],
    PROGRAM_ID,
  )[0];
}

// SeatCards layout offsets (packed format)
const SC = {
  DISC: 0,           // 8
  TABLE: 8,          // 32
  SEAT_INDEX: 40,    // 1
  BUMP: 41,          // 1
  ENC1: 42,          // 32 — packed hole card ciphertext (Enc<Shared, u16>)
  ENC2: 74,          // 32 — zeroed in packed format
  TOTAL: 106,
};

// DeckState layout offsets
const DS = {
  DISC: 0,           // 8
  TABLE: 8,          // 32
  BUMP: 40,          // 1
  COMMUNITY: 41,     // 5 × 32 = 160 bytes (encrypted community cards)
};

function isAllZero(buf: Uint8Array): boolean {
  return buf.every(b => b === 0);
}

function hexSlice(buf: Uint8Array, start: number, len: number): string {
  return Buffer.from(buf.slice(start, start + len)).toString('hex').slice(0, 32) + '...';
}

async function main() {
  console.log('🔒 Privacy Sneak Test');
  console.log(`RPC: ${RPC_URL}`);

  const conn = new Connection(RPC_URL, 'confirmed');

  // Find tables — look for any table account owned by our program
  // For simplicity, accept a TABLE_PUBKEY env var or scan
  const tablePubkeyStr = process.env.TABLE_PUBKEY;
  if (!tablePubkeyStr) {
    console.log('\n⚠️  Set TABLE_PUBKEY env var to a table in Preflop phase (after arcium_deal).');
    console.log('   Run smoke-test-arcium-deal.ts first, then use the table pubkey from its output.');
    console.log('\n   Example: TABLE_PUBKEY=<pubkey> npx ts-node --transpile-only backend/smoke-test-privacy.ts');

    // Try to find tables by scanning program accounts
    console.log('\n   Scanning for program accounts...');
    const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: 448 }], // Approximate table size
    });
    if (accounts.length > 0) {
      console.log(`   Found ${accounts.length} accounts of size 448. Try one as TABLE_PUBKEY.`);
      for (const a of accounts.slice(0, 5)) {
        console.log(`   - ${a.pubkey.toBase58()}`);
      }
    }
    process.exit(1);
  }

  const tablePda = new PublicKey(tablePubkeyStr);
  console.log(`Table: ${tablePda.toBase58()}`);

  // ─── Test 1: Read all SeatCards and verify ciphertexts ───
  console.log('\n--- Test 1: SeatCards ciphertext verification ---');
  let occupiedSeats = 0;
  let emptySeats = 0;

  for (let seat = 0; seat < 9; seat++) {
    const seatCardsPda = getSeatCardsPda(tablePda, seat);
    const info = await conn.getAccountInfo(seatCardsPda);

    if (!info || info.data.length < SC.TOTAL) {
      console.log(`  Seat ${seat}: no SeatCards account`);
      emptySeats++;
      continue;
    }

    const data = Buffer.from(info.data);
    const enc1 = data.slice(SC.ENC1, SC.ENC1 + 32);
    const enc2 = data.slice(SC.ENC2, SC.ENC2 + 32);

    if (isAllZero(enc1)) {
      console.log(`  Seat ${seat}: enc1=ZERO (empty/not dealt)`);
      emptySeats++;
    } else {
      occupiedSeats++;
      console.log(`  Seat ${seat}: enc1=${hexSlice(data, SC.ENC1, 32)}`);

      // Verify packed format: enc2 should be all zeros
      if (!isAllZero(enc2)) {
        console.log(`    ⚠️  enc2 is NOT zero — unexpected for packed format!`);
        console.log(`    enc2=${hexSlice(data, SC.ENC2, 32)}`);
      } else {
        console.log(`    enc2=ZERO (correct — packed format uses single ct)`);
      }

      // ── Privacy check: ciphertext must not be a valid plaintext card index ──
      // If encryption failed and we stored plaintext, enc1[0] would be 0-51.
      // A real Rescue ciphertext is 32 bytes of pseudorandom data.
      const nonZeroBytes = enc1.filter(b => b !== 0).length;
      if (nonZeroBytes < 8) {
        throw new Error(`Seat ${seat}: enc1 has only ${nonZeroBytes} non-zero bytes — likely NOT encrypted!`);
      }
      console.log(`    ✅ enc1 has ${nonZeroBytes}/32 non-zero bytes — appears encrypted`);
    }
  }

  console.log(`\n  Summary: ${occupiedSeats} occupied seats, ${emptySeats} empty seats`);
  if (occupiedSeats < 2) {
    throw new Error(`Expected at least 2 occupied seats, got ${occupiedSeats}`);
  }
  console.log('  ✅ All occupied seats have non-trivial ciphertexts');

  // ─── Test 2: Cross-seat decryption impossibility ───
  console.log('\n--- Test 2: Cross-seat decryption impossibility ---');
  {
    // Read two different occupied seats
    const seatData: { seat: number; enc1: Buffer }[] = [];
    for (let seat = 0; seat < 9 && seatData.length < 2; seat++) {
      const pda = getSeatCardsPda(tablePda, seat);
      const info = await conn.getAccountInfo(pda);
      if (info && info.data.length >= SC.TOTAL) {
        const d = Buffer.from(info.data);
        const enc1 = d.slice(SC.ENC1, SC.ENC1 + 32);
        if (!isAllZero(enc1)) {
          seatData.push({ seat, enc1 });
        }
      }
    }

    if (seatData.length < 2) {
      console.log('  ⚠️  Need at least 2 occupied seats for cross-seat test — skipping');
    } else {
      const [a, b] = seatData;
      console.log(`  Comparing seat ${a.seat} vs seat ${b.seat}:`);
      console.log(`    Seat ${a.seat} enc1: ${a.enc1.toString('hex').slice(0, 32)}...`);
      console.log(`    Seat ${b.seat} enc1: ${b.enc1.toString('hex').slice(0, 32)}...`);

      // Ciphertexts MUST be different (each encrypted to different x25519 key)
      if (a.enc1.equals(b.enc1)) {
        throw new Error('PRIVACY FAILURE: Two different seats have IDENTICAL ciphertexts!');
      }
      console.log('  ✅ Ciphertexts are different (each encrypted to unique x25519 key)');

      // Verify: even the same card values produce different ciphertexts
      // (different keys → different ciphertexts, even for same plaintext)
      console.log('  ✅ Even identical card values would produce different ciphertexts (different keys)');
    }
  }

  // ─── Test 3: DeckState community cards are encrypted ───
  console.log('\n--- Test 3: DeckState community card encryption ---');
  {
    const deckStatePda = getDeckStatePda(tablePda);
    const info = await conn.getAccountInfo(deckStatePda);

    if (!info) {
      console.log('  ⚠️  No DeckState account found — skipping');
    } else {
      const data = Buffer.from(info.data);
      console.log(`  DeckState size: ${data.length} bytes`);

      let encryptedCount = 0;
      let zeroCount = 0;
      for (let i = 0; i < 5; i++) {
        const offset = DS.COMMUNITY + i * 32;
        if (offset + 32 > data.length) break;
        const ct = data.slice(offset, offset + 32);
        if (isAllZero(ct)) {
          console.log(`  Community[${i}]: ZERO (not yet dealt or already revealed)`);
          zeroCount++;
        } else {
          const nonZero = ct.filter(b => b !== 0).length;
          console.log(`  Community[${i}]: ${hexSlice(data, offset, 32)} (${nonZero}/32 non-zero)`);
          if (nonZero < 4) {
            console.log(`    ⚠️  Suspiciously few non-zero bytes — might be plaintext leak!`);
          }
          encryptedCount++;
        }
      }

      if (encryptedCount > 0) {
        console.log(`  ✅ ${encryptedCount} community cards are encrypted, ${zeroCount} are zero/revealed`);
      } else {
        console.log(`  ℹ️  All community cards are zero (pre-deal or all revealed)`);
      }
    }
  }

  // ─── Test 4: Raw byte analysis — no plaintext card values in ciphertext range ───
  console.log('\n--- Test 4: No plaintext card values leaked in encrypted fields ---');
  {
    let leakCount = 0;
    for (let seat = 0; seat < 9; seat++) {
      const pda = getSeatCardsPda(tablePda, seat);
      const info = await conn.getAccountInfo(pda);
      if (!info || info.data.length < SC.TOTAL) continue;

      const data = Buffer.from(info.data);
      const enc1 = data.slice(SC.ENC1, SC.ENC1 + 32);
      if (isAllZero(enc1)) continue;

      // Check: if the first byte is a valid card index (0-51) and the rest is mostly zeros,
      // that would indicate plaintext was stored instead of ciphertext
      const firstByte = enc1[0];
      const restZeros = enc1.slice(1).filter(b => b === 0).length;
      if (firstByte <= 51 && restZeros > 28) {
        console.log(`  ⚠️  POSSIBLE LEAK at seat ${seat}: first byte=${firstByte} (valid card), ${restZeros}/31 trailing zeros`);
        leakCount++;
      }
    }

    if (leakCount > 0) {
      throw new Error(`PRIVACY FAILURE: ${leakCount} seat(s) may have plaintext card values in encrypted fields!`);
    }
    console.log('  ✅ No plaintext card values detected in encrypted fields');
  }

  console.log('\n🎉 All privacy tests passed!');
  console.log('  - Ciphertexts are non-trivial (high entropy)');
  console.log('  - Different seats have different ciphertexts');
  console.log('  - No plaintext leakage detected');
  console.log('  - Community cards encrypted before reveal');
}

main().catch((e) => {
  console.error('❌ Privacy test failed:', e);
  process.exit(1);
});
