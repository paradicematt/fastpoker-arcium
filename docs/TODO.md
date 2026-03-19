# FastPoker Arcium — Roadmap & TODO

## Completed ✅

### Core Architecture
- [x] Anchor program with Arcium MPC encrypted shuffle/deal/reveal/showdown
- [x] 3 Arcis circuits: `shuffle_and_deal`, `reveal_community`, `reveal_all_showdown`
- [x] Crank service for permissionless game operation (Arcium MPC mode only)
- [x] Steel staking contract integration
- [x] Dealer license bonding curve system
- [x] Session key support (gum-sdk)
- [x] Rebuy instruction for cash games

### Multi-Player Showdown ✅ (Redesigned)
- [x] **Full 9-player showdown** — All players can reach showdown via MXE-packed u128 hole cards
- [x] `shuffle_and_deal` circuit: adds `Enc<Mxe, u128>` output (7-bit packed, all 18 hole cards)
- [x] `reveal_all_showdown` circuit: single MPC call decrypts all 9 players' cards at once
- [x] Deal callback stores MXE packed_holes in `DeckState.encrypted_hole_cards[9..11]`
- [x] Showdown queue: single call reads MXE data from DeckState (no SeatCards needed)
- [x] Showdown callback: parses 9 × PlaintextU16, writes to Table + SeatCards
- [x] P0+P1 still get client-side card viewing via Shared outputs

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

## TODO (Priority Order)

### HIGH
- [ ] **Re-enable BLS verification** for devnet/mainnet MPC callbacks.
  Currently disabled on localnet (cluster keys change each restart → error 6001).
  BLS = cryptographic signature proving MPC output is genuine. Without it, fake callbacks possible.
  Must verify `SignedComputationOutputs::verify_output()` works on devnet cluster.
- [ ] **Build + test multi-player showdown on localnet** — Full E2E with 3/6/9 players all reaching showdown

### MEDIUM
- [ ] **Frontend integration** — Wire encrypted card display + crank service into React client
- [ ] **Devnet deployment** — Deploy to devnet with real Arcium cluster, test remote MPC
- [ ] **Clean up legacy test files** — `e2e-mock-streets.ts`, `test-crank-local.ts` reference
  removed `devnet_bypass_deal`. Either delete or update to use arcium deal.
- [ ] **Remove legacy Helius API keys** from old test/utility scripts in `backend/`

### LOW
- [ ] **Performance monitoring** — HandCostLog tracking, ER integration if avg > $0.10/hand
- [ ] **Clean up Rust warnings** — ~13 unused variable/import warnings in the program
- [ ] **Client-side card viewing for P2+** — Currently only P0+P1 get Shared outputs.
  P2+ need a separate `reveal_my_cards` MPC call for client-side viewing (~2s per player).

---

## Architecture Notes

### MPC Output Layout (shuffle_and_deal, SIZE=352)
11 encrypted outputs × 32 bytes. Stride-3 layout:
| Slots | Content | Description |
|-------|---------|-------------|
| 0-2 | Mxe community | Packed u64 (5 community cards) |
| 3-5 | Mxe packed_holes | Packed u128 (18 hole cards, 7-bit each) |
| 6-8 | P0 Shared | Client-decryptable hole cards |
| 9-10 | P1 Shared | Client-decryptable (ct2 truncated but unused) |

### Showdown Flow (reveal_all_showdown)
Single MPC call for all 9 players:
- Input: `Enc<Mxe, u128>` from DeckState + `active_mask: u16`
- Output: 9 × PlaintextU16 (card1×256+card2, 0xFFFF for inactive)
- SIZE = 18 bytes (9 × 2)

### 7-bit Packing (u128)
- 18 cards × 7 bits = 126 bits ≤ 128
- Card values 0-51 (dealt), 127 (NOT_DEALT sentinel)
- Pack: `packed = c0*128^17 + c1*128^16 + ... + c17*128^0`
- Unpack: `card_i = (packed / 128^(17-i)) % 128`

### MPC Timing (localnet, cached preprocessing)
| Operation | Time |
|-----------|------|
| shuffle_and_deal | ~8s |
| reveal_community (flop/turn/river) | ~2s each |
| reveal_all_showdown | ~2s (single call, all players) |
| Full hand (all streets + showdown) | ~18s |

### Key Constraints
- Output count MUST match circuit encrypted return values (now 11)
- Stride-3 layout: each Enc value = 3 raw 32-byte slots
- Callback TX limit: ~10-12 accounts max before exceeding 1232-byte Solana TX limit
- First MPC on fresh localnet: 5-15min preprocessing. Subsequent: ~8s
