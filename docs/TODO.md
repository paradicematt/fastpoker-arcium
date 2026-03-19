# FastPoker Arcium — Roadmap & TODO

## Completed ✅

### Core Architecture
- [x] Anchor program with Arcium MPC encrypted shuffle/deal/reveal/showdown
- [x] 3 Arcis circuits: `shuffle_and_deal`, `reveal_community`, `reveal_player_cards`
- [x] Crank service for permissionless game operation (Arcium MPC mode only)
- [x] Steel staking contract integration
- [x] Dealer license bonding curve system
- [x] Session key support (gum-sdk)
- [x] Rebuy instruction for cash games

### Testing
- [x] E2E HU (heads-up): 5-hand timing test, all streets + showdown + settle
- [x] E2E 6-max: 3-player and 6-player (deal + streets + showdown + settle)
- [x] E2E 9-max: 9-player (deal + streets + showdown + settle)
- [x] Security tests: 10/10 vectors verified
- [x] Mock streets test: full street flow + all-in preflop
- [x] Full game test: SNG tournament, cash 6/9-max, crank payments, cashout

### Security
- [x] Remove `devnet_bypass_deal` / `devnet_bypass_reveal` (plaintext card security hole)
- [x] Remove hardcoded Helius API key from crank-service.ts
- [x] Callback CPI context validation (localnet workaround for BLS)
- [x] x25519 pubkey zero-check in arcium_deal (M6)
- [x] Rake on fold wins after flop (M4)
- [x] Fold-win leaving player cashout snapshot (H1)

---

## In Progress 🔧

### Multi-Player Showdown (HIGH PRIORITY)
**Problem:** SIZE=320 (10 output slots × 32 bytes) only delivers encrypted hole cards
to P0+P1 via SeatCards. Players 2-8 get zero SeatCards data and must fold before showdown.

**Root cause:** Each `Enc<Shared, u16>` output uses stride-3 layout (nonce + ct1 + ct2 = 96 bytes).
With 10 total encrypted return values (1 Mxe + 9 Shared), only 2 full player groups fit in 320 bytes.

**Design options:**
1. **Pack all hole cards into Mxe outputs** — Change circuit to return `Enc<Mxe, u128>` packed
   hole cards instead of per-player `Enc<Shared, u16>`. Fewer outputs = fits in callback.
   Downside: clients can't decrypt own cards without an extra MPC call (~2s latency).
2. **Multi-callback approach** — Split deal into multiple MPC calls. Complex orchestration.
3. **Store encrypted data in DeckState** — Write all ciphertext to DeckState instead of
   individual SeatCards. Showdown reads from DeckState. Requires DeckState expansion.

**Current workaround:** P2+ fold before showdown. MPC shuffles correctly for all 9 internally.

---

## TODO (Priority Order)

### HIGH
- [ ] **Fix full multi-player showdown** — All 9 players must be able to reach showdown
  with encrypted hole card reveal. See design options above.
- [ ] **Re-enable BLS verification** for devnet/mainnet MPC callbacks.
  Currently disabled on localnet (cluster keys change each restart → error 6001).
  BLS = cryptographic signature proving MPC output is genuine. Without it, fake callbacks possible.
  Must verify `SignedComputationOutputs::verify_output()` works on devnet cluster.

### MEDIUM
- [ ] **Frontend integration** — Wire encrypted card display + crank service into React client
- [ ] **Devnet deployment** — Deploy to devnet with real Arcium cluster, test remote MPC
- [ ] **Clean up legacy test files** — `e2e-mock-streets.ts`, `test-crank-local.ts` reference
  removed `devnet_bypass_deal`. Either delete or update to use arcium deal.
- [ ] **Remove legacy Helius API keys** from old test/utility scripts in `backend/`

### LOW
- [ ] **Performance monitoring** — HandCostLog tracking, ER integration if avg > $0.10/hand
- [ ] **9-max E2E with full showdown** — Once multi-player showdown fixed, test all 9 to showdown
- [ ] **Clean up Rust warnings** — ~13 unused variable/import warnings in the program

---

## Architecture Notes

### MPC Timing (localnet, cached preprocessing)
| Operation | Time |
|-----------|------|
| shuffle_and_deal | ~8s |
| reveal_community (flop/turn/river) | ~2s each |
| reveal_player_cards (showdown) | ~2s per player |
| Full hand (all streets + showdown) | ~21s |

### Key Constraints
- Output count MUST match circuit encrypted return values (currently 10)
- Stride-3 layout: each Enc value = 3 raw 32-byte slots
- Callback TX limit: ~10-12 accounts max before exceeding 1232-byte Solana TX limit
- First MPC on fresh localnet: 5-15min preprocessing. Subsequent: ~8s
