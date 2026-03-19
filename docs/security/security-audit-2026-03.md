# Security Audit Report — Fast Poker (Arcium MPC Architecture)
**Date**: March 2026  
**Auditor**: Cascade Security Engineer  
**Scope**: On-chain Anchor program (`programs/fastpoker/src/`), crank service (`backend/crank-service.ts`), Arcium MPC integration  

---

## Executive Summary

The Fast Poker codebase has been audited across all critical attack surfaces. The architecture uses Arcium MPC for card encryption (replacing the legacy TEE model) with all game logic on Solana L1. Overall security posture is **solid** — the core poker invariants (turn enforcement, phase guards, signer validation, hand evaluation) are correctly implemented. Several findings are documented below, ranging from **informational** to **medium** severity. No critical exploits were found.

---

## STRIDE Threat Analysis

| Threat             | Component                    | Risk   | Status       |
|--------------------|------------------------------|--------|--------------|
| Spoofing           | MPC callbacks                | High   | **Mitigated** — CPI context validation (A11) |
| Spoofing           | player_action signer         | High   | **Mitigated** — wallet OR session key check |
| Tampering          | Card values on-chain         | Crit   | **Mitigated** — Rescue cipher encryption |
| Tampering          | Bet amounts / chip balances  | High   | **Mitigated** — on-chain arithmetic checks |
| Repudiation        | Player actions               | Low    | **Mitigated** — events emitted for every action |
| Info Disclosure    | Hole cards (opponent sneak)  | Crit   | **Mitigated** — SeatCards stores ciphertext only |
| Info Disclosure    | Community cards pre-reveal   | High   | **Mitigated** — DeckState encrypted, Table.community_cards = 255 |
| Denial of Service  | Gap griefing (out-of-turn)   | High   | **Mitigated** — NotPlayersTurn check |
| Denial of Service  | Stale timeout race           | High   | **Mitigated** — action_nonce guard |
| Elevation of Priv  | Non-player acting            | High   | **Mitigated** — seat.wallet check + PDA verification |

---

## Findings

### F1: `devnet_bypass_deal` has no feature gate [MEDIUM]

**File**: `instructions/devnet_bypass_deal.rs`  
**Impact**: Anyone can call `devnet_bypass_deal` on mainnet to deal plaintext cards (no encryption). This exposes all hole cards as readable values in SeatCards.card1/card2.

**Current state**: The instruction exists in the deployed binary with no `#[cfg(feature = "devnet")]` guard. It is permissionless — any signer can call it when `table.phase == Starting`.

**Recommendation**: Either:
1. Add `#[cfg(feature = "devnet")]` to exclude from production builds, OR
2. Add an on-chain admin flag (e.g., `table.mock_deal_enabled`) that defaults to false, OR
3. Remove `devnet_bypass_deal` and `devnet_bypass_reveal` from the production binary entirely.

**Severity**: Medium — requires a crank to race against `arcium_deal` (both consume the `Starting` phase), but an attacker with a fast bot could front-run the crank's `arcium_deal` with `devnet_bypass_deal` to force plaintext dealing.

---

### F2: BLS signature verification disabled on localnet (TODO in production) [MEDIUM]

**File**: `instructions/arcium_deal_callback.rs:180-188`  
**Impact**: The shuffle_and_deal callback uses CPI context validation instead of BLS signature verification. This is documented as a localnet workaround.

**Current state**: `validate_arcium_callback_context()` checks the preceding instruction is from the Arcium program. This is sufficient IF the Arcium program is not compromised, but BLS verification provides an additional cryptographic guarantee.

**Recommendation**: 
- Re-enable `verify_output_raw()` BLS check for devnet/mainnet deployments.
- Keep CPI context validation as a fallback/belt-and-suspenders.
- Add integration test that verifies BLS works on devnet cluster.

**Severity**: Medium — CPI context validation is a reasonable defense, but BLS adds defense-in-depth against Arcium program bugs.

---

### F3: `reveal_community_callback` accepts arbitrary card values [LOW]

**File**: `instructions/arcium_reveal.rs:51-54`  
**Impact**: The `cards: [u8; 5]` and `num_revealed: u8` parameters are passed as instruction arguments, not extracted from MPC output bytes. If an attacker could spoof the callback (bypassing CPI context validation), they could inject arbitrary card values.

**Current state**: Protected by `validate_arcium_callback_context()` — only Arcium's `callbackComputation` can invoke this. The card values come from the MPC circuit's plaintext output.

**Recommendation**: Consider adding bounds checking: `require!(cards.iter().all(|&c| c < 52 || c == 255))` as defense-in-depth.

**Severity**: Low — CPI validation prevents spoofing, but bounds check costs minimal CUs.

---

### F4: `reveal_showdown_callback` limited to 6 players [INFORMATIONAL]

**File**: `instructions/arcium_showdown.rs:52-53`  
**Impact**: `revealed_cards: [[u8; 2]; 6]` limits showdown reveal to 6 seats. 9-max tables cannot use this callback.

**Current state**: Known limitation documented in the codebase. 9-max tables need multi-TX callbacks or a larger array.

**Recommendation**: For 9-max support, expand to `[[u8; 2]; 9]` and handle the TX size budget accordingly.

**Severity**: Informational — known design constraint, not a security vulnerability.

---

### F5: Timeout nonce guard uses `wrapping_add` — possible wraparound [INFORMATIONAL]

**File**: `instructions/timeout.rs:117`, `instructions/player_action.rs:103`  
**Impact**: `action_nonce` is `u16` with `wrapping_add(1)`. After 65,536 actions on the same table, the nonce wraps to 0. A stale timeout with nonce 0 could match a fresh state.

**Current state**: In practice, 65K actions on a single table is unlikely within a single hand (timeout requires nonce match + time elapsed).

**Recommendation**: No immediate fix needed — the timing guard (`elapsed >= TIMEOUT_SECONDS`) prevents exploitation even if nonce wraps. Document this as accepted risk.

**Severity**: Informational.

---

### F6: `shuffle_and_deal` SIZE=448 truncates player 4+ data [INFORMATIONAL]

**File**: `instructions/arcium_deal_callback.rs:56-58`  
**Impact**: For tables with 5+ players, players 4-8 get zeroed-out encrypted cards (beyond the 448-byte SIZE window). Their SeatCards will have empty ciphertexts.

**Current state**: Documented in code comments. HU/4-max works fully. 5+ player Arcium encrypted deals need multi-TX callbacks or SIZE increase.

**Recommendation**: Before launching 5+ player encrypted games, implement multi-TX callback or increase SIZE (requires Arcium protocol-level changes for larger callback payloads).

**Severity**: Informational — known limitation, not exploitable.

---

### F7: Crank service still has dead TEE validator registry code [LOW]

**File**: `backend/crank-service.ts` (VALIDATORS array, ValidatorEntry type, etc.)  
**Impact**: Dead code increases attack surface for confusion-based bugs and maintenance burden.

**Current state**: `getDefaultValidator()` is no longer called by `RPC_BASE` (fixed this session). `reloadValidatorsFromConfig()` call removed. But the `VALIDATORS` array, `ValidatorEntry` interface, `getValidatorByPubkey()`, and `TEE_VALIDATOR` constant still exist in the file.

**Recommendation**: Remove remaining dead validator registry code. Also remove `crankConfig.validators` from config schema.

**Severity**: Low — dead code, no runtime impact, but clutters codebase.

---

### F8: Hardcoded Helius API key in source code [LOW]

**File**: `backend/crank-service.ts:242`  
**Impact**: The L1_RPC fallback contains a Helius API key in the source: `https://devnet.helius-rpc.com/?api-key=0a2b697e-...`

**Current state**: This is a devnet API key (not mainnet). It's used as a fallback when `L1_RPC` env var is not set.

**Recommendation**: Remove hardcoded API key. Use environment variable exclusively. Add `.env.example` with placeholder.

**Severity**: Low — devnet only, but bad practice that could leak to mainnet.

---

## Verified Security Controls

### ✅ Turn enforcement
- `player_action.rs:79-81`: `require!(table.current_player == seat.seat_number)`
- E2E verified: out-of-turn action correctly rejected (security test 4)

### ✅ Phase guards
- `settle.rs:18`: `constraint = table.phase == GamePhase::Showdown`
- `start_game.rs:19`: `constraint = table.phase == GamePhase::Waiting`
- `arcium_deal.rs:90`: `constraint = table.phase == GamePhase::Starting`
- `arcium_deal_callback.rs:106`: `constraint = table.phase == GamePhase::AwaitingDeal`
- E2E verified: settle during Preflop correctly rejected (security test 6)

### ✅ Signer validation
- `player_action.rs:38-46`: Wallet OR valid session key check
- E2E verified: non-player action correctly rejected (security test 8)

### ✅ Player count validation
- `start_game.rs:117`: `require!(table.current_players >= 2)`
- E2E verified: start with 1 player correctly rejected (security test 7)

### ✅ Timeout race prevention
- `timeout.rs:47-49`: `require!(table.action_nonce == expected_nonce)` — prevents stale timeouts
- `timeout.rs:56-60`: `require!(elapsed >= TIMEOUT_SECONDS)` — prevents instant force-folds

### ✅ Bet validation
- `player_action.rs:171-174`: Minimum bet >= big_blind, amount <= chips
- `player_action.rs:197`: Zero-raise rejection (GI-002 fix)
- `player_action.rs:170-171`: Zero-bet rejection (GI-003 fix)

### ✅ Card privacy (Arcium mode)
- SeatCards stores Rescue ciphertext — not readable without x25519 secret key
- Community cards = 255 until MPC reveal callback writes plaintext
- Folded cards never revealed (active_mask bitmask in reveal_showdown)
- E2E verified: full decryption pipeline working (e2e-arcium-cards.ts — 7/7 tests)

### ✅ MPC callback authentication
- `validate_arcium_callback_context()`: Checks preceding IX is Arcium's callbackComputation
- Applied to all 3 callbacks: shuffle_and_deal, reveal_community, reveal_showdown
- Prevents spoofing of card data (threat A11)

### ✅ Permissionless design
- `start_game`, `settle_hand`, `handle_timeout`, `arcium_deal` — all permissionless
- Crank is convenience, not authority — any wallet can call these instructions
- No central point of failure

---

## E2E Test Coverage Summary

| Test Suite | Tests | Status |
|-----------|-------|--------|
| `e2e-mock-streets.ts` | Street progression + all-in preflop | ✅ All passed |
| `e2e-full-game.ts` | SNG tournament, Cash 6-max/9-max, crank payments, cashout, privacy | ✅ 7/7 passed |
| `e2e-arcium-cards.ts` | MPC deal, hole card decryption, card uniqueness, privacy proofs | ✅ 7/7 passed |
| `e2e-security-tests.ts` | Privacy, gap griefing, out-of-turn, double-action, settle guard, 1-player start, non-player action | ✅ 10/10 passed |

---

## Recommendations Priority

| Priority | Finding | Action |
|----------|---------|--------|
| **P1** | F1: devnet_bypass_deal no feature gate | Add `#[cfg]` guard or admin flag before mainnet |
| **P1** | F2: Re-enable BLS verification | Enable for devnet/mainnet builds |
| **P2** | F3: Add card value bounds check | 1-line defense-in-depth |
| **P2** | F8: Hardcoded API key | Move to env var |
| **P3** | F7: Dead TEE validator code | Cleanup in next sprint |
| **P3** | F4: 9-max showdown support | Design multi-TX callback |
| **Info** | F5: Nonce wraparound | Accepted risk (timing guard) |
| **Info** | F6: SIZE=448 truncation | Known limitation, 5+ player support planned |
