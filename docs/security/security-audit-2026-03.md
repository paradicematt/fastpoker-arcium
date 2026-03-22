# Security Audit Report — Fast Poker (Arcium MPC Architecture)
**Date**: March 2026 (Rev 2: March 19)  
**Auditor**: Cascade Security Engineer  
**Scope**: On-chain Anchor program (`programs/fastpoker/src/`), crank service (`backend/crank-service.ts`), Arcium MPC integration  

---

## Executive Summary

The Fast Poker codebase has been audited across all critical attack surfaces. The architecture uses Arcium MPC for card encryption (replacing the legacy TEE model) with all game logic on Solana L1. Core poker invariants (turn enforcement, phase guards, signer validation, hand evaluation) are correctly implemented. **Rev 2** adds a comprehensive cross-comparison with the legacy TEE codebase, identifying 10 confirmed bugs and 2 design-level issues that need fixes before mainnet.

**Confirmed bugs needing fixes:** A1, A3, A5, A6, A7, B1, B3, B4, B6, B7, B8  
**False positives (no fix needed):** A2, A4, B2 (mock-only), B5, C1-C3

---

## STRIDE Threat Analysis

| Threat             | Component                    | Risk   | Status       |
|--------------------|------------------------------|--------|--------------|
| Spoofing           | MPC callbacks                | High   | **Mitigated** — CPI context validation |
| Spoofing           | player_action signer         | High   | **Mitigated** — wallet OR session key check |
| Tampering          | Card values on-chain         | Crit   | **Mitigated** — Rescue cipher encryption |
| Tampering          | Bet amounts / chip balances  | High   | **Mitigated** — on-chain arithmetic checks |
| Tampering          | Zero-chip all-in (A1)        | Crit   | ⚠️ **OPEN** — no guard on `process_all_in` |
| Repudiation        | Player actions               | Low    | **Mitigated** — events emitted for every action |
| Info Disclosure    | Hole cards (opponent sneak)  | Crit   | **Mitigated** — SeatCards stores ciphertext only |
| Info Disclosure    | Seats 2+ cards (B1)          | High   | ✅ **FIXED** — `claim_hole_cards` MPC circuit + crank auto-claim |
| Info Disclosure    | Community cards pre-reveal   | High   | **Mitigated** — DeckState encrypted, Table.community_cards = 255 |
| Denial of Service  | Gap griefing (out-of-turn)   | High   | **Mitigated** — NotPlayersTurn check |
| Denial of Service  | Stale timeout race           | High   | **Mitigated** — action_nonce guard |
| Denial of Service  | 0-chip player dealt in (A3)  | High   | ⚠️ **OPEN** — cash game 0-chip Active not auto-sat-out |
| Denial of Service  | Immediate kick on sit-out (A5)| Med   | ⚠️ **OPEN** — sit_out_handler missing timestamp |
| Elevation of Priv  | Non-player acting            | High   | **Mitigated** — seat.wallet check + PDA verification |
| Elevation of Priv  | Premature seat clear (B7)    | Med    | ⚠️ **OPEN** — no receipt nonce guard on L1 |

---

## Findings — Gameplay Logic (A-series)

### A1: Zero-amount all-in exploit [CRITICAL] ⚠️

**File**: `instructions/player_action.rs:227-247`  
**Impact**: A player with 0 chips can call AllIn → gets AllIn status + bitmask set for free. `all_in_amount = 0` bypasses all bet logic. Disrupts `advance_action` round counting — effectively a free ride to showdown with no risk.

**Root cause**: `process_all_in` has no guard for `seat.chips == 0`.

**Fix**: 1 line at top of `process_all_in`:
```rust
require!(seat.chips > 0, PokerError::InsufficientChips);
```

**Severity**: Critical — exploitable by any player, breaks pot integrity.

---

### A2: start_game strict seat validation [FALSE POSITIVE — NO FIX]

**File**: `instructions/start_game.rs:88-102`  
**Reported as**: "Strict `provided_mask == expected_mask` prevents self-healing if `seats_occupied` drifts."

**Analysis**: On L1 (Arcium), `seats_occupied` shouldn't drift because settle/leave/clear all update it atomically. The TEE self-healing was needed because ER delegation introduced race conditions. The strict check is actually *more secure* — it catches corruption instead of hiding it. If a table gets stuck, admin intervention is preferable to silently masking state corruption.

**Severity**: Not a bug. Downgraded from HIGH to INFORMATIONAL.

---

### A3: start_game missing auto-sitout for 0-chip Active players (cash game) [HIGH] ⚠️

**File**: `instructions/start_game.rs` (missing before `active_mask` build at ~line 299)  
**Impact**: In cash games, a busted player (0 chips) stays Active → gets dealt into the hand → posts 0 blind → `min_bet = 0` → everyone checks for free. Degenerate hand state.

**Root cause**: The bust reconciliation at lines 124-187 only runs for SNG (`if table.is_sit_and_go()`). Cash games have no equivalent 0-chip auto-sitout.

**Fix**: ~15 lines — before `active_mask` build, iterate remaining_accounts for cash games: if status=Active and chips=0, set status=SittingOut and update masks.

**Severity**: High — creates exploitable degenerate game state in cash games.

---

### A4: settle.rs Leaving player is_folded logic [FALSE POSITIVE — NO FIX]

**File**: `instructions/settle.rs:149-153`  
**Reported as**: "Arcium uses `seats_folded` bitmask instead of TEE's `seats_allin` check for Leaving players."

**Analysis**: Verified that `process_leave_cash_game` (player_action.rs:381) **correctly sets the fold bit** for non-all-in mid-hand leavers. The settle logic `(status == 6 && seats_folded bit set)` works because:
- Leaving + all-in → no fold bit → pot-eligible ✅
- Leaving + not-all-in → fold bit set by `process_leave_cash_game` → dead money ✅
- Mid-hand joiners can't exist on L1 (join only during Waiting) → TEE's `(status == 1 && total_bet == 0)` check is unnecessary.

**Severity**: Not a bug. Downgraded from HIGH to NOT APPLICABLE.

---

### A5: sit_out.rs missing sit_out_timestamp [MEDIUM] ⚠️

**File**: `instructions/sit_out.rs:46`  
**Impact**: `sit_out_handler` sets `status = SittingOut` but does NOT set `sit_out_timestamp`. The `process_sit_out` in `player_action.rs:272` DOES set it. Without it, `crank_kick_inactive` reads `sit_out_timestamp = 0` → `elapsed = now - 0 = billions` → **kicks player IMMEDIATELY** instead of after 5 minutes.

**Root cause**: Two paths to sit-out — `sit_out_handler` (standalone instruction) and `process_sit_out` (via `player_action`). Only the latter sets the timestamp.

**Fix**: 2 lines after `sit_out.rs:46`:
```rust
let clock = Clock::get()?;
seat.sit_out_timestamp = clock.unix_timestamp;
```

**Severity**: Medium — exploitable by griefers calling `crank_kick_inactive` immediately after a player uses the standalone sit-out instruction.

---

### A6: start_game missing missed blinds tracking [MEDIUM] ⚠️

**File**: `instructions/start_game.rs` (missing after blind position calculation at ~line 388)  
**Impact**: SittingOut players at natural SB/BB positions don't get `missed_sb`/`missed_bb` marked. When they return via `sit_in_handler`, they bypass blind debt entirely.

**Root cause**: The TEE version had a ~30-line loop marking missed blinds on SittingOut players at natural blind positions. This was not ported to the Arcium version.

**Fix**: ~20 lines — after blind positions are set (line 388), iterate SittingOut seats: if seat would naturally be at SB position, set `missed_sb = true`; if at BB, set `missed_bb = true`.

**Severity**: Medium — economic exploit in cash games (sit out at BB, return for free).

---

### A7: SNG bust check doesn't exclude Leaving players [LOW] ⚠️

**File**: `instructions/start_game.rs:137`  
**Impact**: `if status != 0 && status != 5` doesn't exclude Leaving (6). A Leaving player with 0 chips could get re-busted.

**Analysis**: Leaving is cash-game-only. SNG can't have Leaving players. This is a defensive-only fix.

**Fix**: 1-line change — add `&& status != 6`.

**Severity**: Low — defensive coding, not exploitable in practice.

---

## Findings — Arcium MPC-Specific (B-series)

### B1: Deal callback only writes encrypted cards to P0+P1 [HIGH] ⚠️

**File**: `instructions/arcium_deal.rs:258`  
**Impact**: `seats_in_callback = min(max_players, 2)` — only 2 SeatCards PDAs included in callback TX (1232-byte limit). Players 2-8 get zeroed `enc_card1` and `nonce` → client-side Rescue cipher decryption returns garbage. **Only P0 and P1 can see their cards during active play.**

**Root cause**: Two constraints:
1. Callback TX size limit (1232 bytes) can't fit all 9 SeatCards accounts
2. Raw output SIZE=320 (10 slots × 32) only has complete stride-3 data for P0+P1

**Note**: Showdown path works for ALL players via `reveal_all_showdown` (unpacks from single MXE Pack). The issue is **real-time hole card viewing during active play** for seats 2+.

**Fix options**:
1. Split into multiple callback TXs (`num_callback_txs = 2` or 3)
2. Add permissionless `claim_encrypted_cards` instruction that reads from DeckState
3. Store per-player encrypted data in DeckState (has space in `encrypted_hole_cards[0..8]`)

**Severity**: High — fundamental feature gap for 3+ player tables.

---

### B2: devnet_bypass_deal HU first-to-act wrong [LOW]

**File**: `instructions/devnet_bypass_deal.rs:188-190`  
**Impact**: Uses `table.dealer_button` directly instead of `table.small_blind_seat` for HU. Could be wrong if dealer seat is SittingOut (not in active_mask).

**Note**: Only affects mock deal mode. The production `arcium_deal_callback.rs:295` has the correct `next_seat_in_mask(bb, active_mask)` logic.

**Fix**: 1-line change (use `table.small_blind_seat`). Low priority — mock only.

**Severity**: Low — devnet/testing only.

---

### B3: Deal callback missing hand_number validation [MEDIUM] ⚠️

**File**: `instructions/arcium_deal_callback.rs:197-306`  
**Impact**: No check that `deck_state.hand_number == table.hand_number`. If a stale MPC callback arrives from a previous hand (e.g., retry after misdeal), it could overwrite current hand's encrypted data.

**Fix**: 1 line in callback handler:
```rust
require!(deck_state.hand_number == table.hand_number, PokerError::ArciumCallbackInvalid);
```

**Severity**: Medium — stale callback could corrupt current hand's card data.

---

### B4: Showdown queue missing fold-win guard [MEDIUM] ⚠️

**File**: `instructions/arcium_showdown_queue.rs:154`  
**Impact**: `active_mask = seats_occupied & !seats_folded` — no check for `active_mask.count_ones() > 1`. If only 1 non-folded player (fold win), queueing showdown wastes MPC computation and could cause edge-case issues if the circuit expects multiple active players.

**Fix**: 1 line:
```rust
require!(active_mask.count_ones() > 1, PokerError::InvalidActionForPhase);
```

**Severity**: Medium — wasteful MPC + potential circuit edge case.

---

### B5: Reveal callback all-in runout [NOT A BUG]

**File**: `instructions/arcium_reveal.rs:169-180`  
**Reported as**: "Neither advance_action nor start_game checks for ALL players all-in preflop."

**Analysis**: After review, `advance_action` correctly sets `GamePhase::FlopRevealPending` when all players are all-in. The crank then queues reveal. The reveal callback correctly auto-advances for all-in runouts (no betting round needed). All code paths are correct.

**Severity**: Not a bug.

---

### B6: settle.rs Leaving cashout missing guard [MEDIUM] ⚠️

**File**: `instructions/settle.rs:729-758`  
**Impact**: Always writes `cashout_chips = total_owed` without checking `total_owed > 0`. If `leave_cash_game` already snapshotted during Waiting phase (zeroed chips + vault_reserve), settle overwrites `cashout_chips = 0` + increments nonce → **player loses money** (their earlier snapshot is destroyed).

**Fix**: 3-line guard:
```rust
if total_owed > 0 {
    // ... existing cashout snapshot code ...
}
```

**Severity**: Medium — cash game players who left during Waiting phase lose their cashout.

---

### B7: clear_leaving_seat.rs no receipt nonce guard [MEDIUM] ⚠️

**File**: `instructions/clear_leaving_seat.rs:35-97`  
**Impact**: `clear_leaving_seat` zeros `cashout_chips` (line 76) without verifying a CashoutReceipt. On L1 (Arcium), the receipt IS accessible — the TEE limitation excuse (line 50-52 comment) no longer applies. Anyone can call this permissionlessly to clear a Leaving seat **before** the crank processes the cashout transfer → **player loses money**.

**Fix**: Add CashoutReceipt account to struct + nonce check:
```rust
require!(receipt.last_processed_nonce >= seat.cashout_nonce, PokerError::CashoutNotProcessed);
```

**Severity**: Medium — griefable loss-of-funds for cash game players.

---

### B8: rebuy.rs no auto-activate after rebuy [LOW] ⚠️

**File**: `instructions/rebuy.rs:160-163`  
**Impact**: After successful rebuy, only clears `hands_since_bust`. Does NOT set `status = Active` or update `seats_occupied`. Player stays SittingOut → must manually ReturnToPlay.

**Fix**: ~5 lines after `seat.hands_since_bust = 0`:
```rust
if seat.status == SeatStatus::SittingOut && seat.chips > 0 {
    seat.status = SeatStatus::Active;
    table.seats_occupied |= 1 << seat.seat_number;
}
```

**Severity**: Low — UX issue, not a security vulnerability.

---

## Findings — Infrastructure (F-series, from Rev 1)

### F1: `devnet_bypass_deal` has no feature gate [RESOLVED ✅]

**File**: `instructions/devnet_bypass_deal.rs`  
**Status**: Files exist on disk but are **not compiled** — no `pub mod devnet_bypass_deal` or `pub mod devnet_bypass_reveal` in `lib.rs`. Dead code, never in the binary. No fix needed.

---

### F2: BLS signature verification disabled (localnet workaround) [RESOLVED ✅]

**File**: `instructions/arcium_deal_callback.rs:169-194`  
**Status**: Already feature-gated via `#[cfg(feature = "skip-bls")]` in `Cargo.toml`. Building **without** `--features skip-bls` enables BLS automatically. Production builds just omit the feature flag. No fix needed.

---

### F3: Reveal callback accepts arbitrary card values [LOW]

**File**: `instructions/arcium_reveal.rs:51-54`  
**Impact**: No bounds check on card values. Protected by CPI validation.  
**Recommendation**: Add `require!(c < 52 || c == 255)` defense-in-depth.

---

### F5: Timeout nonce wraparound [INFORMATIONAL]

**File**: `instructions/timeout.rs:117`  
**Impact**: `u16` nonce wraps after 65K actions. Timing guard prevents exploitation.  
**Status**: Accepted risk.

---

### F7: Dead TEE validator code in crank [LOW]

**File**: `backend/crank-service.ts`  
**Impact**: Dead code. No runtime impact.  
**Recommendation**: Cleanup.

---

### F8: Hardcoded Helius API key [LOW]

**File**: `backend/crank-service.ts:242`  
**Impact**: Devnet key in source.  
**Recommendation**: Move to env var.

---

## Blind Posting Analysis (C-series)

### C1: BB posting 0 blind — **Depends on A3**
If A3 (0-chip auto-sitout) is fixed, this can't happen. `current_chips.min(big_blind)` = 0 only if a 0-chip player stays Active, which A3 prevents.

### C2: BB overrides short SB all-in — **CORRECT**
SB=5, BB=20: SB posts 5 (all-in), min_bet=5. BB posts 20, min_bet=20. Standard poker rules. No bug.

### C3: HU SB/BB same seat — **NOT A BUG**
`active_count == 2` guarantees exactly 2 seats in mask. `next_seat_in_mask(sb)` always finds the other. Same non-issue in TEE version.

---

## Verified Security Controls

### ✅ Turn enforcement
- `player_action.rs:79-81`: `require!(table.current_player == seat.seat_number)`

### ✅ Phase guards
- `settle.rs:18`: `constraint = table.phase == GamePhase::Showdown`
- `start_game.rs:19`: `constraint = table.phase == GamePhase::Waiting`
- `arcium_deal.rs:90`: `constraint = table.phase == GamePhase::Starting`
- `arcium_deal_callback.rs:106`: `constraint = table.phase == GamePhase::AwaitingDeal`

### ✅ Signer validation
- `player_action.rs:38-46`: Wallet OR valid session key check

### ✅ Bet validation
- `player_action.rs:171-174`: Minimum bet >= big_blind, amount <= chips
- `player_action.rs:197`: Zero-raise rejection (GI-002)
- `player_action.rs:170-171`: Zero-bet rejection (GI-003)

### ✅ Card privacy (Arcium mode)
- SeatCards stores Rescue ciphertext
- Community = 255 until MPC reveal callback
- Folded cards never revealed (active_mask in reveal_showdown)

### ✅ MPC callback authentication
- `validate_arcium_callback_context()` on all 3 callbacks

### ✅ Permissionless design
- All game instructions callable by any wallet
- Crank is convenience, not authority

---

## E2E Test Coverage Summary

| Test Suite | Tests | Status |
|-----------|-------|--------|
| `e2e-mock-streets.ts` | Street progression + all-in preflop | ✅ All passed |
| `e2e-full-game.ts` | SNG tournament, Cash 6-max/9-max, crank payments, cashout, privacy | ✅ 7/7 passed |
| `e2e-arcium-cards.ts` | MPC deal, hole card decryption, card uniqueness, privacy proofs | ✅ 7/7 passed |
| `e2e-arcium-5hands.ts` | 5 consecutive MPC hands + settle | ✅ 5/5 passed |
| `e2e-security-tests.ts` | Privacy, gap griefing, out-of-turn, double-action, settle guard, 1-player start, non-player action | ✅ 10/10 passed |

---

## Recommendations Priority

| Priority | Finding | Fix Size | Action |
|----------|---------|----------|--------|
| **P0** | A1: Zero-chip all-in exploit | 1 line | Add `require!(seat.chips > 0)` in `process_all_in` |
| **P0** | A3: 0-chip Active in cash game | ~15 lines | Auto-sitout 0-chip Active before `active_mask` build |
| **P0** | B6: Leaving cashout overwrite | 3 lines | Add `if total_owed > 0` guard in settle |
| **P0** | B7: Premature seat clear | ~10 lines | Add receipt nonce check in `clear_leaving_seat` |
| **P1** | A5: Missing sit_out_timestamp | 2 lines | Set timestamp in `sit_out_handler` |
| **P1** | A6: Missing missed blinds | ~20 lines | Mark missed SB/BB on SittingOut at blind positions |
| **P1** | B1: Seats 2+ can't decrypt | ✅ **FIXED** | `claim_hole_cards` circuit + queue/callback + crank auto-claim + frontend session-key fallback. E2E: 3/6/9p pass. |
| **P1** | B3: Stale callback hand_number | 1 line | Add `hand_number` match in deal callback |
| **P1** | B4: Fold-win showdown guard | 1 line | Add `active_mask.count_ones() > 1` check |
| **P1** | F1: devnet_bypass_deal gate | 1 line | Add `#[cfg(feature = "devnet")]` |
| **P1** | F2: Re-enable BLS | Config | Enable for devnet/mainnet builds |
| **P2** | A7: SNG bust excludes Leaving | 1 line | Defensive `&& status != 6` |
| **P2** | B8: Rebuy auto-activate | 5 lines | Set Active + seats_occupied after rebuy |
| **P2** | B2: Mock deal HU first-to-act | 1 line | Use `small_blind_seat` not `dealer_button` |
| **P3** | F3, F7, F8 | Small | Defense-in-depth, dead code cleanup, env var |
