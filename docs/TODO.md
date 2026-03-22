# FastPoker Arcium — Roadmap & TODO

## Completed ✅

### Core Architecture
- [x] Anchor program with Arcium MPC encrypted shuffle/deal/reveal/showdown
- [x] 3 Arcis circuits: `shuffle_and_deal`, `reveal_community`, `reveal_all_showdown`
- [x] Single-MXE `Pack<[u8;23]>` architecture (all 23 cards in one MXE ciphertext)
- [x] Crank service for permissionless game operation (Arcium MPC mode only)
- [x] Steel staking contract integration
- [x] Dealer license bonding curve system
- [x] Session key support (gum-sdk)
- [x] Rebuy instruction for cash games

### Multi-Player Showdown ✅
- [x] **Full 9-player showdown** — Single MPC call decrypts all active hands
- [x] `shuffle_and_deal`: 10 ciphertext outputs (1 MXE all-cards + 9 player Shared pairs)
- [x] `reveal_community`: reads MXE `Pack<[u8;23]>` → 5 PlaintextU8 community cards
- [x] `reveal_all_showdown`: reads MXE `Pack<[u8;23]>` → 9 PlaintextU16 packed hole cards
- [x] P0+P1 get client-side card viewing via Shared outputs
- [x] **P2+ client-side card viewing** via `claim_hole_cards` circuit (B1 fix)
  - 4th Arcis circuit: re-encrypts from MXE Pack to player's Shared key
  - Queue/callback instructions + crank auto-claim + frontend session-key fallback
  - E2E verified: 3p, 6p, 9p — all cards decrypt correctly, all unique

### Security
- [x] Remove `devnet_bypass_deal` / `devnet_bypass_reveal` (plaintext card security hole)
- [x] Remove hardcoded Helius API key from crank-service.ts
- [x] **BLS signature verification** — `extract_mpc_output()` helper with feature flag:
  - Production (default): CPI validation + BLS `verify_output_raw()` (cryptographic proof)
  - Localnet (`skip-bls` feature): CPI validation only (BLS error 6001 on Docker nodes)
  - Build: `SKIP_BLS=1` (default) → localnet. `SKIP_BLS=0` → production with BLS.
- [x] x25519 pubkey zero-check in arcium_deal (M6)
- [x] Rake on fold wins after flop (M4)
- [x] Fold-win leaving player cashout snapshot (H1)

### Testing
- [x] E2E HU (heads-up): 5-hand timing test, all streets + showdown + settle
- [x] E2E 6-max: 3-player and 6-player (deal + streets + showdown + settle)
- [x] E2E 9-max: 9-player (deal + streets + showdown + settle + quick fold hand 2)
- [x] Security tests: 10/10 vectors verified
- [x] Legacy test files moved to `backend/legacy/` (referenced removed `devnet_bypass_deal`)

---

## TODO (Priority Order)

### HIGH
- [x] **Frontend integration** — ✅ Encrypted card display (`useArciumCards`), MPC phase overlays, session key fallback, crank integration. E2E tested (2/2 passed).
- [ ] **Devnet deployment** — Deploy with `SKIP_BLS=0` (BLS enabled), test real Arcium cluster

### MEDIUM
- [x] **Port security tests to Arcium mode** — ✅ `backend/e2e-security-tests.ts` ported from
  legacy. 11 security vectors: card privacy, gap griefing, double action, unauthorized settle/start,
  non-player action, A1/A3/B3/B4 guards. Uses `arcium_deal` + MPC polling.
- [x] **Port crank stress test** — ✅ `backend/stress-test-crank.ts` ported from legacy.
  5 scenarios: HU idle, HU fold, HU leave, 3× parallel, 6-max sitout. x25519 keys required.
- [x] **Client-side card viewing for P2+** — ✅ Implemented via `claim_hole_cards`.
  Crank auto-claims + frontend session-key fallback. E2E tested 3/6/9 players.

### LOW
- [x] **Performance monitoring** — ✅ `PerformanceTracker` class in `backend/stress-test-crank.ts` (Scenario 6).
  Tracks per-hand: TX fees, CU consumed, MPC latency, wall clock time.
  Scans crank-initiated TXs (start_game, arcium_deal, callbacks, settle).
  Generates JSON report (`perf-report.json`) + ER threshold check ($0.10/hand).
- [ ] **Clean up Rust warnings** — ~13 unused variable/import warnings in the program
- [x] **9-player settle CU budget** — ✅ Verified sufficient: 800K in E2E test, 1.3M in crank-service.

---

## Architecture Notes

### Single-MXE Pack Architecture
All 23 cards (5 community + 18 hole) packed into a single `Enc<Mxe, Pack<[u8;23]>>`.
Avoids multi-MXE output corruption bug (2nd+ MXE outputs produce corrupted ciphertext).
DeckState stores the same MXE ciphertext for both `reveal_community` and `reveal_all_showdown`.

### MPC Output Layout (shuffle_and_deal, SIZE=320)
10 ciphertext outputs × 32 bytes. Stride-3 layout:
| Slots | Content | Description |
|-------|---------|-------------|
| 0-2 | Mxe all-cards | `Pack<[u8;23]>` (5 community + 18 hole cards) |
| 3-5 | P0 Shared | Client-decryptable hole cards (u16 packed pair) |
| 6-8 | P1 Shared | Client-decryptable hole cards (u16 packed pair) |
| 9 | P2 nonce | Partial slot for HU+ (ct truncated but unused) |

Constants: `MXE_CT_SLOT=1`, `FIRST_PLAYER_SLOT=4`, `PLAYER_STRIDE=3`.

### Showdown Flow (reveal_all_showdown)
Single MPC call for all 9 players:
- Input: `Enc<Mxe, Pack<[u8;23]>>` from DeckState + `active_mask: u16`
- Output: 9 × PlaintextU16 (card1×256+card2, 0xFFFF for inactive)
- SIZE = 18 bytes (9 × 2)

### MPC Timing (localnet, cached preprocessing)
| Operation | Time |
|-----------|------|
| shuffle_and_deal | ~8s |
| reveal_community (flop/turn/river) | ~2s each |
| reveal_all_showdown | ~2s (single call, all players) |
| Full hand (all streets + showdown) | ~18s |

### Circuit Sizes
| Circuit | Size | ACUs |
|---------|------|------|
| shuffle_and_deal | ~12.8MB | 3.4B |
| reveal_community | 160KB | 162M |
| reveal_all_showdown | 287KB | 178M |

### Key Constraints
- Output count MUST match circuit encrypted return values (10 for shuffle_and_deal)
- Stride-3 layout: each Enc value = 3 raw 32-byte slots
- Callback TX limit: ~10-12 accounts max before exceeding 1232-byte Solana TX limit
- First MPC on fresh localnet: 5-15min preprocessing. Subsequent: ~8s
- 9-player settle_hand needs 800K compute units

### Test Suite
| Test | File | What it covers |
|------|------|---------------|
| Multi-max E2E | `e2e-arcium-multimax.ts` | 3p + 6p + 9p: deal→streets→showdown→settle |
| 5-hand timing | `e2e-arcium-5hands.ts` | HU: 5 consecutive hands, MPC timing |
| Card proof | `e2e-arcium-cards.ts` | Encryption/decryption/privacy proof |
| Claim cards | `e2e-claim-cards.ts` | P2+ hole card claim + decrypt (3/6/9 player) |
| All tables | `e2e-all-tables.ts` | Every table type (cash + SNG tiers) |
| Arcium deal | `smoke-test-arcium-deal.ts` | Quick MPC queue + callback |
| Dealer license | `smoke-test-dealer-license.ts` | Bonding curve pricing |
| Privacy | `smoke-test-privacy.ts` | Opponent can't decrypt cards |
| Kick | `test-kick.ts` | Crank kick inactive player |
| Permissionless | `test-permissionless.ts` | 5-wallet permissionless flow |
| Security (Arcium) | `e2e-security-tests.ts` | 11 vectors: privacy, griefing, guards (A1/A3/B3/B4) |
| Stress (Arcium) | `stress-test-crank.ts` | 5 scenarios: idle, fold, leave, parallel, sitout |
| *Legacy (broken)* | `backend/legacy/` | 5 files using removed devnet_bypass_deal |
