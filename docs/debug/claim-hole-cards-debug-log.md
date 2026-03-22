# claim_hole_cards Debug Log

> Tracking document for B1 fix: P2+ hole card decryption via `claim_hole_cards` MPC circuit.
> Every attempt, result, and finding is recorded here. **Read before making changes.**

---

## Problem Statement

After `shuffle_and_deal`, only P0 and P1 receive encrypted hole cards via the deal callback (stride-3 slots fit within SIZE=320). P2+ get nothing (B1 bug). The `claim_hole_cards` circuit was created to fix this — it takes the MXE-encrypted all-cards pack, decrypts it, extracts the target player's cards, and re-encrypts as `Enc<Shared, u16>` to the player's key.

**Goal:** P2's `claim_hole_cards` callback writes correct ciphertext + nonce to `SeatCards`, enabling client-side Rescue cipher decryption.

---

## Circuit Definition

**File:** `encrypted-ixs/src/lib.rs`

```rust
fn claim_hole_cards(packed_all: Enc<Mxe, AllCards>, player: Shared, seat_index: u8) -> Enc<Shared, u16>
```

- **Input:** MXE-encrypted all-cards pack (same data used by `reveal_community` / `reveal_all_showdown`)
- **Output:** Single `Enc<Shared, u16>` — Rescue-encrypted packed card pair for the target player
- **comp_def_offset:** `comp_def_offset("claim_hole_cards")` = 4003793729

**init_comp_defs params:**
```
PlaintextU128 (MXE nonce) + Ciphertext (MXE ct) + ArcisX25519Pubkey (player) + PlaintextU128 (player nonce) + PlaintextU8 (seat_index)
```

---

## Attempt Log

### Attempt 1: Initial Implementation — `Output::Ciphertext; 1`, SIZE=32

**Changes:**
- `init_comp_defs.rs`: `vec![Output::Ciphertext; 1]`
- `ClaimHoleCardsOutput::SIZE = 32`
- Callback read slot 0 as `SharedEncryptedStruct` (pubkey + nonce + ciphertext)

**Result:** ❌ Decryption failed. The 32-byte raw output is NOT a `SharedEncryptedStruct`. That format is client-side only. Raw MPC output uses stride-3 layout.

**Learning:** Raw MPC output for `Enc<Shared, T>` is stride-3: `[nonce(32), ct1(32), ct2(32)]` — not `SharedEncryptedStruct`.

---

### Attempt 2: Stride-3 with `Output::Ciphertext; 3`, SIZE=96, assumed [nonce, ct1, ct2]

**Changes:**
- `init_comp_defs.rs`: `vec![Output::Ciphertext; 3]`
- `ClaimHoleCardsOutput::SIZE = 96`
- Callback: slot 0 = nonce, slot 1 = ct1, slot 2 = ct2
- `DeckState` was plain `Account<'info, DeckState>` (not boxed)

**Result:** ❌ MPC computation succeeded but callback TX failed 5/5 retries:
```
InstructionError(2, ProgramFailedToComplete)
```

**Root Cause:** Stack overflow in BPF. `DeckState` (~1000+ bytes) was on the stack. The deal callback uses `Box<Account<'info, DeckState>>` — claim callback didn't.

**Learning:** Always Box large accounts (DeckState) in callback structs. Build warnings about stack overflow are real.

---

### Attempt 3: Box DeckState — callback arrives, but slot ordering wrong

**Changes:**
- `pub deck_state: Box<Account<'info, DeckState>>` (matching deal callback pattern)

**Result:** ✅ Callback arrives! But P2 decryption fails — nonce mismatch.

**Analysis of raw output (96 bytes, 3 slots):**
```
Slot 0 (bytes 0-31):  d839941c...1962091d  ← full 32 bytes, non-trivial
Slot 1 (bytes 32-63): 113bc75b...00000000  ← 16 bytes + 16 zeros
Slot 2 (bytes 64-95): (not stored/visible)
```
- Expected output nonce: `113bc75b470cd6d1b82211726cca8877` (= input + 1)
- Slot 1 first 16 bytes = expected nonce ✅
- Therefore: **slot 0 = ct1, slot 1 = nonce** (opposite of shuffle_and_deal's [nonce, ct1, ct2])

**Learning:** For `claim_hole_cards` with `Output::Ciphertext; 3` and 1 actual encrypted value, the slot order is **[ct1, nonce, ct2]**, NOT [nonce, ct1, ct2] as in shuffle_and_deal.

---

### Attempt 4: Auto-detect slot ordering + compute nonce from DeckState

**Changes:**
- Callback computes `expected_nonce = input_nonce + 1` from `DeckState.hole_card_nonces[seat_idx]`
- Checks slot 0 and slot 1 first-16-bytes against expected nonce
- Whichever matches → that's the nonce slot; the other is ct1
- Stores computed nonce (always correct) in `SeatCards.nonce`

**Result:** ❌ Callback succeeds. Nonce is correct. But **Rescue decryption produces garbage:**
```
P2 decrypted: 8331839777089193024... → INVALID(78) INVALID(110)
```
- Nonce match: ✅
- Shared secret cipher self-test: ✅ (encrypt/decrypt 12345 works)
- x25519 pubkey match: ✅
- Card uniqueness (6 cards, 6 unique): ✅

**Analysis:** The ciphertext (slot 0) is NOT a valid Rescue ciphertext for this shared secret + nonce. Possibilities:
1. Slot 0 is ct2 (unused Rescue block), not ct1 — real ct1 may be in slot 2
2. Slot 0 is some other MPC artifact (MXE input decryption residue)
3. The layout is [ct2, nonce, ct1] — ct1 is in slot 2

**Status:** Slot 0 is NOT ct1. Moved to Attempt 5.

---

### Attempt 5: Store slot 2, try decrypting all 3 slots

**Changes:**
- Callback: store slot 2 (bytes 64-95) in `enc_card2` instead of slot 1
- E2E test: try decrypting each of slots 0, 1, 2 with all nonce strategies

**Result:** ✅ **Slot 2 decrypts correctly!**
```
slot2+outputNonce: ✅ 3334  → 2♥ 8♠
slot2+computedNonce(in+1): ✅ 3334
```
Slots 0 and 1 both produce garbage.

**Verified layout: `[ct2, nonce, ct1]`**
- Slot 0 (bytes 0-31):  ct2 (unused Rescue block)
- Slot 1 (bytes 32-63): nonce (16-byte LE u128 = input+1, zero-padded to 32)
- Slot 2 (bytes 64-95): **ct1** (primary Rescue ciphertext)

---

### Attempt 6 (FINAL): Read ct1 from slot 2, compute nonce from DeckState

**Changes:**
- Callback: `ct1 = raw_bytes[64..96]` (slot 2), nonce = `input_nonce + 1` from DeckState
- Removed auto-detect logic — direct slot read
- `enc_card2` stores slot 1 (nonce slot) for diagnostics

**Result:** ✅ **ALL PASS — 2 consecutive runs**
```
Run 1: P0=K♦ 4♠  P1=3♣ 4♦  P2=2♥ 8♠  ✅ all unique
Run 2: P0=J♣ 5♠  P1=A♥ J♥  P2=Q♣ 7♣  ✅ all unique
```

---

## RESOLVED

**Root causes (3 issues):**
1. **Stack overflow** — `DeckState` not boxed → `ProgramFailedToComplete`
2. **Wrong slot** — assumed [nonce, ct1, ct2] but actual layout is [ct2, nonce, ct1]
3. **Nonce source** — reading nonce from raw output slot was fragile; computed from `input_nonce + 1` is reliable

**Final callback logic:**
```rust
let ct1 = raw_bytes[64..96];           // slot 2 = primary Rescue ciphertext
let nonce = input_nonce.wrapping_add(1); // computed from DeckState, not raw output
```

---

## Key Reference: Working Decryption (P0/P1 from deal callback)

For comparison, P0's working decryption:
- ct1 from stride-3 slot 4 (FIRST_PLAYER_SLOT) — full 32 bytes
- nonce from stride-3 slot 3 — 16 bytes zero-padded, matches input+1
- `RescueCipher(sharedSecret).decrypt([ctBigint], nonce)` → valid u16

**Client decryption flow:**
1. `sharedSecret = x25519.getSharedSecret(playerSecretKey, mxePublicKey)`
2. `cipher = new RescueCipher(sharedSecret)`
3. `cipher.decrypt([ctBigint], outputNonce)` → packed u16
4. `card1 = (u16 >> 8) & 0xFF, card2 = u16 & 0xFF`

---

## Multi-Player Test Results

| Players | Claims (P2+) | Cards | Unique | Result |
|---------|-------------|-------|--------|--------|
| 3 | 1 (P2) | 6 | 6 | ✅ PASS |
| 6 | 4 (P2-P5) | 12 | 12 | ✅ PASS |
| 9 | 7 (P2-P8) | 18 | 18 | ✅ PASS |

All callbacks arrived within seconds of each other. No MPC timeouts or callback failures at any player count.

---

## Key Discovery: Single-Output Ciphertext Layout

For circuits with **1 encrypted output** and `Output::Ciphertext; 3`:
- Layout is **[ct2, nonce, ct1]** — NOT [nonce, ct1, ct2]
- This differs from multi-output circuits (shuffle_and_deal) which use [nonce, ct1, ct2] per group

For circuits with **multiple encrypted outputs** (shuffle_and_deal, 10 outputs):
- Layout is stride-3 **[nonce, ct1, ct2]** per encrypted value, linearized
- First N slots returned where N = declared output count

---

## Constants & File Paths

| Item | Value |
|------|-------|
| Circuit | `encrypted-ixs/src/lib.rs` → `claim_hole_cards` |
| Callback | `programs/fastpoker/src/instructions/arcium_claim_cards_callback.rs` |
| Queue | `programs/fastpoker/src/instructions/arcium_claim_cards_queue.rs` |
| CompDef | `programs/fastpoker/src/instructions/init_comp_defs.rs` (InitClaimCompDef) |
| E2E test | `backend/e2e-claim-cards.ts` |
| Circuit len | 952,204 bytes |
| Circuit weight | 492,372,680 |
| comp_def_offset | 4003793729 |
| Program ID | BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N |
