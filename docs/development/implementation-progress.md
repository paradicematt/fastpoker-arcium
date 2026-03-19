# Implementation Progress — Arcium Migration

## Session: 2026-03-11

### Phase 0: Environment Setup ✅
- Docker Engine v29.3.0 installed in WSL
- Arcium CLI v0.8.5 via arcup (`/home/user/.cargo/bin/arcium`)
- Arx Node + Trusted Dealer Docker images v0.8.5
- Project source copied from `J:\Poker` → `J:\Poker-Arc`
- `encrypted-ixs/` scaffold created via `arcium init`
- `Arcium.toml` — localnet config (2 nodes, Cerberus backend)
- Workspace `Cargo.toml` (members: `programs/fastpoker`, `encrypted-ixs`)
- Docs structure: `docs/architecture/`, `docs/privacy/`, `docs/economics/`, `docs/development/`, `docs/reference/`
- Project rules rewritten for Arcium architecture

### Phase 1: Strip TEE ✅
**14 files deleted:**
- `permissions.rs`, `create_public_permission.rs`, `delegate_permission.rs`, `update_seat_cards_permission.rs`
- `tee_deal.rs`, `tee_reveal.rs`, `deal_vrf.rs`
- `delegate.rs`, `delegate_crank_tally.rs`, `admin_undelegate_er.rs`
- `schedule_timeout.rs`, `schedule_settle.rs`, `schedule_next_hand.rs`

**7 files cleaned:**
- `lib.rs` — all TEE/Permission/Delegation dispatch removed, `#[ephemeral]` removed
- `init_table_seat.rs` — permission PDA creation removed
- `seat_player.rs` — UpdatePermission CPI + accounts removed
- `join_table.rs` — UpdatePermission CPI + SNG guard removed
- `start_game.rs` — 126-line TEE design doc replaced
- `player_action.rs` — MagicBlock ScheduleTask CPI removed (72 lines)
- `constants.rs` — PERMISSION_PROGRAM constants removed

**3 dependencies removed:** `ephemeral-rollups-sdk`, `magicblock-magic-program-api`, `ephemeral-vrf-sdk`

### Phase 2: MPC Circuits ✅
Three circuits in `encrypted-ixs/src/lib.rs`:
1. **`shuffle_and_deal`** — 6 players max, per-player `Shared` encryption, community to MXE
2. **`reveal_community`** — decrypts MXE community cards → plaintext via `.reveal()`
3. **`reveal_showdown`** — decrypts active players' hole cards using modulo bitmask

**Key Arcis DSL findings:**
- `Mxe` can't be constructed (only param instance exists)
- `Shared` moves on `from_arcis()` — need `Shared::new(pubkey)` for each use
- Bitwise `&` not supported — use `(val / divisor) % 2`
- Community cards 2-5 encrypted to `Shared` (workaround since `Mxe` can't be multi-instantiated)

**Circuit artifacts generated:** `.arcis`, `.idarc`, `.hash`, `.ts`, `.weight`, `.profile.json`
- `shuffle_and_deal`: 2,926,197,034 ACUs
- `reveal_community`: 241,706,528 ACUs
- `reveal_showdown`: 398,549,312 ACUs

### Phase 3: On-Chain Integration ✅
**Account struct changes:**
- `DeckState`: 58 → 876 bytes (encrypted_community, encrypted_hole_cards, nonces, computation tracking)
- `SeatCards`: 68 → 148 bytes (enc_card1, enc_card2, nonce; plaintext kept for showdown)
- `GamePhase`: Added `AwaitingDeal`, `AwaitingShowdown` variants
- `PokerError`: Added `InvalidPlayerCount`, `ArciumComputationPending`, `ArciumCallbackInvalid`, `ArciumComputationTimeout`, `ShuffleNotComplete`

**New instructions created:**
- `devnet_bypass_deal.rs` — mock mode (deterministic shuffle from SlotHashes, no MPC)
- `arcium_deal.rs` — phase transition Starting→AwaitingDeal (MPC queued by TS crank)
- `arcium_reveal.rs` — `reveal_community_callback` (writes plaintext community cards)
- `arcium_showdown.rs` — `reveal_showdown_callback` (writes plaintext hole cards to SeatCards)

**Architecture decision: `#[arcium_program]` conflict**
- `#[arcium_program]` macro conflicts with `session-keys` crate's `#[derive(Session)]`
- Resolution: Standard `#[program]` + split CPI (see `docs/architecture/arcium-cpi-decision.md`)
- On-chain: phase transitions + callback handlers (standard Anchor)
- Crank (TypeScript): queues MPC via Arcium TS SDK

**Build status:** `cargo check -p fastpoker` — **0 errors, 15 warnings**

---

## Build Commands

```bash
# Source WSL environment
source /mnt/j/Poker-Arc/scripts/wsl-env.sh

# Build everything
wsl bash /mnt/j/Poker-Arc/scripts/build-all.sh

# Build circuits only (nightly)
wsl bash /mnt/j/Poker-Arc/scripts/build-all.sh circuits

# Check program only
wsl bash /mnt/j/Poker-Arc/scripts/build-all.sh program

# Build circuits with arcium CLI
RUSTUP_TOOLCHAIN=nightly arcium build --skip-program

# Full arcium build (circuits + program)
RUSTUP_TOOLCHAIN=nightly arcium build
```

## Key Technical Facts

| Item | Detail |
|---|---|
| encrypted-ixs toolchain | nightly Rust (`arcis-interpreter` needs `Span::local_file()`) |
| fastpoker toolchain | Solana 3.1.8 BPF (`rustc 1.89.0`) |
| Build filesystem | Must use native Linux FS (`~/poker-arc-build`), not NTFS mount |
| time crate | Pinned to 0.3.36 (0.3.47 needs Rust 1.88) |
| indexmap | >= 2.7.1 (Arcium SDK requires it) |
| Cargo.toml exclude | `programs/test-cpi` |
| Docker daemon | `sudo dockerd &` in WSL (manual start) |
| Solana versions | 3.1.8 for BPF build, 2.1.21 for test-validator |

### Phase 4: Crank Economics ✅
- [x] Updated `settle.rs` rake distribution: user tables 50/5/25/25, system tables 5/50/45
- [x] Updated `distribute_prizes.rs` SNG fee distribution: 10/45/45
- [x] Updated `constants.rs` with all new BPS constants
- [x] Documented economics in `docs/economics/crank-dealer-economics.md`

### Phase 5a: Crank Service Fixes ✅
- [x] Fixed **PROGRAM_ID** — was old `4MLbu...`, now `BGyLY...`
- [x] **CRITICAL FIX: Phase enum was wrong** — missing `AwaitingDeal(2)` and `AwaitingShowdown(8)`, all values after Starting were off by 1-2. Every phase transition after Starting would have been misinterpreted.
- [x] Added `AwaitingDeal` and `AwaitingShowdown` to phase dispatch, needsCrank, and adaptive poll
- [x] Added `devnetBypassDeal` discriminator
- [x] Updated header comment with correct phase→action mapping

### Phase 5b: Arcium Card Decryption Module ✅
- [x] Created `shared/crypto/arcium-cards.ts` — standalone x25519 + Rescue cipher utility
- [x] Includes: SeatCards parser, card index decoder (0-51 → rank/suit), PDA helpers
- [x] `readPlaintextCards()` for mock/local mode (devnet_bypass_deal)
- [x] `ArciumCardDecryptor` class for production mode (x25519 ECDH + Rescue decrypt)
- [x] `deriveDecryptionKey()` — deterministic key from wallet signature (no extra keypair)
- [ ] Frontend `useArciumCards` React hook — blocked (no frontend app in this repo yet)

### Phase 5c: Remove TEE Auth — N/A
- No frontend exists in Poker-Arc repo (client-v2/ was in old Poker repo)
- `useTeeAuth` hook does not exist here — nothing to remove

### Phase 6: STEEL Integration ✅
- [x] Fixed hardcoded `FASTPOKER_PROGRAM_ID` in STEEL `consts.rs` → new Poker-Arc ID
- [x] Rebuilt STEEL `.so` with corrected program ID
- [x] Fixed `Anchor.toml` genesis to use STEEL's actual `declare_id!`
- [x] Set `REGISTRATION_COST=0`, `FREE_ENTRIES=0` to match FastPoker free registration
- [x] Documented full CPI flow in `docs/architecture/steel-cpi-flow.md`
- [x] Smoke test confirms STEEL CPI works (register_player → init_unrefined)

### Bug Fixes Applied
- [x] **settle.rs fold-win fast-path** — awards pot without hand eval when all fold
- [x] **session-keys removal** — replaced gum-sdk with custom SessionToken validation
- [x] **Stack overflow fixes** — boxed large accounts in JoinTable, InitTableSeat
- [x] **devnet_bypass_deal rewritten** — writes hole cards to SeatCards + PlayerSeat (was skipping SeatCards)
- [x] **devnet_bypass_reveal** — NEW instruction for mock community card reveal per street
- [x] **Community card visibility** — cards hidden until each street's reveal (deal only writes pre_community)
- [x] **Card encoding** — fixed to `rank=idx%13, suit=idx/13` (was `idx/4, idx%4`)
- [x] **current_player after deal** — devnet_bypass_deal now sets first-to-act (HU=SB, multi=UTG)
- [x] **Crank Phase enum** — was missing AwaitingDeal(2) and AwaitingShowdown(8), all phases off by 1-2
- [x] **STEEL Pool init** — Pool PDA must be initialized on local validator before distribute_prizes

### Smoke Tests — ALL PASSING ✅
1. `smoke-test-game-loop.ts` — Cash game fold-win
2. `smoke-test-sng.ts` — SNG HU Micro fold-win
3. `smoke-test-showdown.ts` — Full showdown: all streets, hand eval, per-street community visibility, rake
4. `smoke-test-sng-elimination.ts` — SNG lifecycle: all-in→bust→Complete→distribute_prizes
5. `smoke-test-6max-sng.ts` — 6-max Bronze tier: 6 players, prize pool 112.5M lamports, deal+fold+settle
6. `smoke-test-cash-comprehensive.ts` — Cash multi-hand, rake (200=5% of 4k pot), join locking, chip conservation

### Verified Behaviors
- Community cards hidden until per-street reveal (Flop ✅, Turn ✅, River ✅)
- Hole cards dealt to SeatCards PDAs (readable for hand eval)
- On-chain hand evaluation produces correct rankings
- Rake = 5% of pot when flop_reached, 0% on fold-before-flop
- SNG elimination: bust detection in start_game, eliminated_seats tracked
- 6-max Bronze: entry=18.75M + fee=6.25M per player, prize_pool=112.5M
- Join blocked during active hand (phase != Waiting)
- Multi-hand chip conservation (chips + rake = initial buy-in)

---

### Phase 7a: Arcium Localnet Infrastructure ✅

**Anchor CLI version shim:**
- Arcium CLI 0.8.5 hardcodes a check for Anchor CLI 0.31.2 (a version that was never publicly released)
- Official Arcium docs say 0.32.1 — this is a bug in the CLI's version check
- **Solution:** Anchor shim script at `/tmp/anchor-shim/anchor` reports `anchor-cli 0.31.2` but delegates all real commands to `anchor-0.32.1` via AVM

**Unix domain socket (admin.rpc) fix:**
- `solana-test-validator` creates `admin.rpc` Unix domain socket in the ledger directory
- NTFS (mounted at `/mnt/j/`) does NOT support Unix domain sockets in WSL
- Arcium CLI checks `admin.rpc` for validator health — fails silently on NTFS
- **Solution:** Mirror project to native Linux ext4 workspace at `/tmp/poker-arc-workspace` and run from there

**Docker DKG stale dealer fix:**
- Root cause: cleanup script filtered containers by `name=arx` which matched `arx-node-*` but NOT `arcium-trusted-dealer-*`
- Stale trusted dealer from a previous run persisted across restarts
- New arx-nodes couldn't complete DKG handshake against a dealer whose session was already done
- **Fix:** Expanded filter to `name=arx` + `name=arcium` + `name=recovery`, plus `docker compose down` fallback

**Final localnet status:**
- Validator running on ext4 workspace ✅
- All programs deployed via genesis: FastPoker, STEEL, Arcium, Lighthouse ✅
- MXE account + Cluster 0 + Mempool initialized ✅
- 4 Docker arx-nodes + 1 trusted dealer — all healthy ✅
- Node metrics at `localhost:9091-9094/health` → `OK` ✅
- DKG + MXE keygen completing successfully ✅
- Script: `scripts/start-arcium-localnet.sh`

### Phase 7b: Arcium CPI Implementation ✅

**Rust — `init_comp_defs.rs` (NEW):**
- Manual `InitCompDefAccs` trait implementation for 3 circuits
- `shuffle_and_deal` — 14 params (mxe nonce + 6×pubkey/nonce + num_players), 17 ciphertext outputs
- `reveal_community` — 6 params (5 ciphertexts + num_to_reveal), 5 plaintext u8 outputs
- `reveal_showdown` — 13 params (12 ciphertexts + active_mask), 12 plaintext u8 outputs
- Uses `arcium_client::pda::mxe_acc()` for PDA derivation, explicit `Parameter`/`Output` enums
- Registered in `lib.rs` as `init_shuffle_comp_def`, `init_reveal_comp_def`, `init_showdown_comp_def`

**Rust — `arcium_deal.rs` (REWRITTEN):**
- Manual `QueueCompAccs` trait implementation
- Local `ArciumSignerAccount` definition (1 field: bump) — can't import from `#[arcium_program]`
- Uses `ArgBuilder` to construct MPC args: mxe_nonce + 6×x25519_pubkey + 6×nonce + num_players
- CPI via `queue_computation()` — borrow ordering: CPI first, then mutable table/deck_state access
- All Arcium account addresses: mxe, mempool, execpool, computation, comp_def, cluster, fee_pool, clock

**TypeScript — `crank-service.ts` (UPDATED):**
- Full `crankArciumDeal()` replacing the TODO stub
- Arcium SDK imports: `getMXEAccAddress`, `getMempoolAccAddress`, `getExecutingPoolAccAddress`, etc.
- PDA helpers: `getArciumSignPda()`, `getArciumClockPda()`, `getArciumFeePoolPda()`, `computeCompDefOffset()`
- `DISC.arciumDeal` discriminator added
- Builds IX data: disc(8) + computation_offset(u64) + player_pubkeys(6×32) + player_nonces(6×u128) + num_players(u8)
- Account list matches `ArciumDeal` struct order exactly

**Key technical decision — why NOT use Arcium macros:**
- `#[arcium_program]` conflicts with session-keys `#[derive(Session)]` (both modify module structure)
- `#[queue_computation_accounts]` and `#[init_computation_definition_accounts]` macros generate code expecting `ID`/`ID_CONST` in scope from `#[arcium_program]`
- `derive_mxe_pda!()` and similar macros also depend on the module-level `ID` constant
- **Solution:** Manual trait impls using `arcium_client::pda::*` functions and explicit type imports from `arcium_client::idl::arcium`

**Build: 0 errors, `fastpoker.so` = 1.99 MB**

---

## Session: 2026-03-12/13 — MPC Debugging + 9-Player Circuit

### Phase 7c: 9-Player Circuit Expansion ✅
- [x] Expanded `shuffle_and_deal` from 6→9 player slots (p0..p8)
- [x] Expanded `reveal_showdown` to 9 players (active_mask u8→u16)
- [x] Updated `init_comp_defs.rs` — 9 Shared params, output counts
- [x] Updated `arcium_deal.rs` — Vec<u8> player_data (avoids SBF stack overflow)
- [x] Updated all TS callers (smoke test, E2E, crank service) for packed player_data format
- [x] Fixed PrivilegeEscalation — restored PDA bump seed before CPI
- [x] Rebuilt circuits: shuffle_and_deal = 12,987,712 bytes, 3,466,015,516 ACUs

### Phase 7d: MPC Callback Debugging ✅

**Bug 1: Stale Genesis Bytecode → MPC Deserialization Failure**
- **Symptom:** `ArciumComputationTimeout` (error 6110), MPC nodes log: `invalid value: integer 2, expected variant index 0 <= i < 2`
- **Root cause:** `uploadCircuit()` in `@arcium-hq/client` skips raw circuit accounts that already exist. Genesis pre-seeded old 6-player bytecode. On-chain = old header + partially overwritten data.
- **Fix:** Created `scripts/update-genesis-circuits.ts` to patch `artifacts/*_raw_circuit_*.json` with fresh `.arcis` bytecodes. Also patched `index.cjs` to force re-upload.
- **Verification:** `backend/verify-circuit-data.ts` confirms SHA256 match.

**Bug 2: Callback Too Large for Single TX**
- **Symptom:** MPC computation SUCCEEDED (23 outputs, BLS 4/4) but callback failed: `Output too large for single transaction (multi-tx-callbacks feature disabled)`
- **Root cause:** 23 outputs × 32 bytes = 736 + 64 BLS = 800 bytes exceeded single-TX limit. arx-node v0.8.5 has `multi-tx-callbacks` feature compile-time disabled.
- **Fix:** Packed 2 hole cards per player into `Enc<Shared, u16>` (card1 × 256 + card2). Reduced outputs from 23 → 14 (448 bytes + 64 = 512 bytes). Fits comfortably.
- **Files changed:** `encrypted-ixs/src/lib.rs`, `init_comp_defs.rs`, `arcium_deal_callback.rs`

**Final verification:** Full MPC pipeline confirmed working:
```
arcium_deal → MPC compute → BLS 4/4 → callback → phase Preflop ✅
MPC SUCCESS: 448 bytes raw output (expected 448)
shuffle_and_deal callback: hand #1, wrote encrypted cards, phase→Preflop
```

### Key Scripts Created This Session
- `scripts/rebuild-circuits.sh` — copies to Linux FS, builds circuits, copies back
- `scripts/update-genesis-circuits.ts` — patches genesis JSON with fresh .arcis data
- `scripts/arcium-init-circuits.ts` — inits comp defs + uploads + finalizes (env var keypair)
- `backend/verify-circuit-data.ts` — SHA256 comparison of on-chain vs local .arcis
- `backend/smoke-test-arcium-deal.ts` — full MPC deal E2E test
- `backend/poll-table.ts` — polls table phase for callback arrival

---

### Phase 8: Dealer License System ✅
- [x] `DealerRegistry` + `DealerLicense` accounts (`state/dealer_license.rs`)
- [x] `init_dealer_registry` (admin), `grant_dealer_license` (admin), `purchase_dealer_license` (permissionless)
- [x] Bonding curve pricing: BASE=0.001 SOL, INCREMENT=0.001/license, MAX=9.9 SOL
- [x] Purchase SOL split: 50% treasury, 50% staker pool
- [x] License enforcement in `distribute_crank_rewards` (unlicensed → weight=0)
- [x] Crank service updated: triplet remaining_accounts [wallet, operator_pda, license_pda]
- [x] E2E test: `backend/smoke-test-dealer-license.ts`
- [x] Build: 0 errors, `fastpoker.so` = 2.74 MB

### Phase 9: Crank Priority Fees ✅
- [x] `priority_fee_microlamports` config in CrankConfig (env: `PRIORITY_FEE_MICROLAMPORTS`)
- [x] `arcium_compute_units` config (env: `ARCIUM_COMPUTE_UNITS`, default 500K)
- [x] `addComputeBudgetIxs()` uses configurable fee from crankConfig
- [ ] Cost tracking: extend `HandCostLog` to include MPC computation fees (deferred)
- [ ] Break-even analysis: MPC cost vs crank reward share (deferred — needs devnet data)

### Phase 10: E2E Full Game Test ✅
- [x] `backend/e2e-full-game.ts` — comprehensive test covering all game flows
- [x] **SNG 6-max Bronze:** 5-7 hands, 5 eliminations, `distribute_prizes` ✅ (crankPool=16.8M)
- [x] **Cash 6-max Micro:** fold-win (rake=0) + mixed bet (rake=450 = 5%×9000, flop reached ✅)
- [x] **Cash 9-max Low:** mixed bet (rake=2250 = 5%×45000, flop reached ✅)
- [x] **Steel pool init:** auto-initialized in setup phase (discriminator=0, single byte)
- [x] **Dealer registry:** init ✅, grant license ✅, register crank operator ✅
- [x] **Distribute crank rewards:** 202 lamports to licensed operator ✅
- [x] **Program rebuild + localnet restart** with dealer license instructions in binary
- [x] Mixed betting strategy: 3 preflop callers + BB check → 4 see flop → check-through → showdown
- [x] Rake verified via math (`5% × pot`), not `flop_reached` flag (reset by settle)
- [x] Key fixes: `prize_authority` writable, Steel pool pre-flight, BB check vs call, license-before-distribute

#### Bugs Fixed in E2E
| Bug | Root Cause | Fix |
|-----|-----------|-----|
| `PrivilegeEscalation` on distribute_prizes | prize_authority not marked writable | Mark writable for Steel CPI |
| `InvalidAccountOwner` on Steel pool | Pool PDA didn't exist on localnet | Auto-init in setup phase |
| `NothingToCall` (6027) on BB | BB tried Call when posted blind matches min_bet | BB uses Check (act=1) |
| `Custom:101` on dealer registry | Instruction not in deployed binary | Rebuild .so + restart localnet |
| `Custom:0` on re-init | Registry already exists from setup | Check existence before init |
| `InsufficientFunds` (6061) on crank rewards | No licensed operator → total_weight=0 | Grant license before distribute |

## Remaining Work

### Additional Testing
- [x] Run `smoke-test-dealer-license.ts` on localnet ✅ (5/5 tests pass: init, grant, purchase, bonding curve, duplicate rejection)
- [x] Cash game `process_cashout_v3` (LeaveCashGame → process_cashout_v3 → vault→wallet 98k lamports + seat cleared) ✅
- [x] `claim_sol_winnings` (SNG winner claimed 73.1M lamports from PlayerAccount PDA) ✅
- [x] Privacy test: 9 SeatCards verified — enc1 fields contain non-zero data, card1/card2 = 0 (no plaintext leak) ✅

### Phase 11: Cashout Architecture Audit & v3 ✅

**Problem:** `process_cashout` (v1) transfers SOL from **table PDA** but `join_table` deposits to **vault PDA** — fund source mismatch. `process_cashout_v2` was designed for MagicBlock ER delegation model (raw byte offsets, two-step with `clear_leaving_seat`).

**Audit Findings:**
- No PDAs are delegated in Arcium architecture — zero ER usage
- ER artifacts remain in code (deposit_for_join, seat_player, cleanup_deposit_proof, clear_leaving_seat, DELEGATION_PROGRAM_BYTES) but are dead code
- ER hybrid would be complex: delegate table+seats+seatcards+deckstate, undelegate for every cashout/rake/prize, MPC callbacks target L1 accounts
- MPC latency (2-10s) dominates — ER fast blocks add minimal benefit
- Arcium writes **encrypted ciphertexts** to SeatCards/DeckState during active play; plaintext only after reveal/showdown callbacks

**Solution:** Created `process_cashout_v3` combining best of v1 + v2:
- ✅ Vault-based transfer (correct fund source)
- ✅ Nonce-protected via CashoutReceipt (no double cashout)
- ✅ Seat cleared inline (no separate clear_leaving_seat needed)
- ✅ Chip lock + kick tracking in PlayerTableMarker
- ✅ SPL token support (validated mint + owner)
- ✅ Drained wallet rent handling (payer covers shortfall)
- ✅ Anchor-deserialized seat (no raw byte offsets)
- ✅ E2E tested: 98,000 lamports transferred from vault, seat 1→6→0

**Dead ER code:** Kept for potential future ER integration. Not wired up.

**Files:**
- `programs/fastpoker/src/instructions/process_cashout_v3.rs` (new)
- `programs/fastpoker/src/lib.rs` (wired v3)
- `backend/e2e-full-game.ts` (Test 5 uses v3)

### Deferred: Hand Stats + XP System
**Status:** Data model complete (`PlayerAccount` has all fields), instructions exist (`award_xp`), but not wired to game flow.

**Recommendation:** Option 2 (separate crank instruction `record_hand_stats`). Stats are non-financial, eventual consistency is fine. Piggyback on `award_xp` call.

### Frontend
- [ ] Bootstrap frontend app (React/Next.js)
- [ ] Create `useArciumCards` React hook using `shared/crypto/arcium-cards.ts`
- [ ] Hook up client-v2 design
- [ ] `/dealer/license` purchase page (spec exists in crank-dealer-economics.md)
