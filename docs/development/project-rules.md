---
trigger: always_on
---

# Fast Poker (Arcium) — Project Rules & Design Principles

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

### 1. Permissionless — No Central Authority Required

- **All game instructions are permissionless.** `start_game`, `arcium_deal`, `arcium_reveal`, `settle`, `handle_timeout` — anyone can call them. No admin key required during gameplay.
- **The crank service is a convenience, not a requirement.** If the crank goes down, any player (or third party) can call the same instructions to advance the game.
- **Table creation is permissionless.** Any wallet can create a user-owned cash game table and earn rake.
- **Never add admin-only gates to game-critical instructions.** Admin instructions (force-close, fix, recover) are separate and clearly marked.

### 2. Card Privacy via Arcium MPC — Cryptographic, Not Access-Control

- **SeatCards store Rescue-cipher encrypted hole cards.** Each player's cards encrypted to their unique x25519 public key via `Enc<Shared, u16>` (packed pair) in the MPC circuit. Anyone can read the account — they get ciphertext they cannot decrypt.
- **DeckState stores MXE-encrypted ALL cards (community + holes) in a single Pack<[u8; 23]>.** Both `reveal_community` and `reveal_all_showdown` decrypt the same MXE ciphertext.
- **No Permission Program.** TEE Permission PDAs are eliminated entirely. Privacy comes from cryptography, not RPC access control.
- **Player x25519 pubkey stored in `PlayerSeat.x25519_pubkey`.** Provided during `seat_player`, derived deterministically from wallet signature on the frontend.
- **Folded players' cards stay encrypted forever.** No reveal path for folded hands.
- **Community cards revealed via small MPC calls** at flop/turn/river. Each reveal decrypts community indices from the Pack<[u8;23]> and writes plaintext to `Table.community_cards`.
- **Showdown reveals ALL active hands in a single MPC call.** `reveal_all_showdown` decrypts hole card indices from the same Pack, returns 9 packed u16 values. Callback writes plaintext to `SeatCards.card1/card2` for non-folded players. Then `settle_hand` evaluates.
- **NEVER log or `msg!` card values, encrypted or plaintext.** No `#[cfg(test)]` code that exposes card values.

### 3. Session Keys (gum-sdk) — 1-Click Gameplay on L1

- **Session keys work on Solana L1** — gum-sdk's `#[derive(Session)]` validates against the Solana program, not ER. Players get 1-click gameplay without wallet popups.
- **Implementation: gum-sdk `session-keys` crate (v3.0.10).** Same as before — `#[derive(Session)]` macro on `PlayerAction` struct.
- **Session key balance pays L1 TX fees.** ~0.01 SOL funds ~2000 transactions. Show remaining TX count in UI.
- **The UI must NEVER require a wallet popup during active gameplay.**

### 4. STEEL Contract — SPL Token & SOL Staking (Unchanged)

- **STEEL program handles all SPL token and SOL staking operations.** No changes from previous architecture.
- **NEVER send tokens directly to the STEEL contract.** Use proper instruction flow.
- **The counter is the source of truth** — not the token account balance.

### 5. On-Chain Integrity — Arcium MPC Model

- **All game logic runs on-chain** (Solana L1). No server-side game logic.
- **The crank only calls permissionless instructions** — it cannot cheat or manipulate outcomes.
- **Hand evaluation, pot calculation, side pots** — all computed on-chain in `settle_hand`.
- **Randomness model (Arcium MPC):**
  - **Shuffle + deal (`arcium_deal`)**: MPC circuit uses `ArcisRNG::shuffle()` for entropy. Fully permissionless, no oracle dependency. One MPC call per hand deals all cards.
  - **Community reveals (`arcium_reveal`)**: Small MPC call per street decrypts pre-dealt community cards from `DeckState.encrypted_community`.
  - **Showdown (`arcium_showdown`)**: MPC callback writes plaintext hole cards for active players → `settle_hand` evaluates.
- **MPC callback latency**: ~2-5s local, ~10-30s devnet. Game shows "Dealing..." during wait.
- **MPC timeout**: If callback doesn't arrive within 60s → `handle_mpc_timeout` → misdeal, blinds returned.

### 5b. Contract-Level Guards — Never Trust the Caller

- **Every security fix MUST include a contract-level guard.** The game is permissionless — anyone can craft raw transactions.
- **Validate all remaining_accounts on-chain.** Check PDA derivation, ownership, writability, and expected count.
- **Fail atomically.** If any required account is missing or invalid, reject the entire transaction.
- **`start_game` requires all active seats to have non-zero `x25519_pubkey`.** Prevents dealing to players without encryption keys.
- **After adding any contract-level guard, test on ALL table sizes (HU, 6-max, 9-max).**

### 5c. Audit Report — Always Document Findings

- **After every security finding or fix, update `AUDIT_REPORT.md` immediately.**
- **Include:** severity, affected files, root cause, impact, resolution, files changed, verification method.

### 6. Money Movement Stays on L1

- **TableVault and CashoutReceipt stay on L1.** No delegation.
- **join_table handles deposits** — SOL tables transfer to vault, SPL token tables transfer to escrow.
- **rebuy instruction (L1)** — cash games only, Waiting phase. Supports SOL + SPL tokens. Validates buy-in limits.
- **process_cashout runs on L1** — transfers SOL from vault back to player.
- **Chip tracking is virtual** — `PlayerSeat.chips` on L1 represents the player's balance.

### 7. Account Initialization — `init_table_seat` Creates Everything

- **`init_table_seat` is the single entry point for per-table account creation.** Called once per seat index (0..max_players-1).
- **Per-seat accounts created:** PlayerSeat, SeatCards, CashoutReceipt, DepositProof
- **Per-table accounts (init_if_needed, created on seat 0):** DeckState, TableVault, CrankTally
- **NO Permission PDA creation.** Removed — Arcium encryption replaces access control.

### 8. Crank Rewards — Dealer Economics

- **Only registered `CrankOperator` PDAs earn rewards.** Unregistered crankers advance the game for free (permissionless fallback).
- **Single `CrankTally` per table** (merged from old CrankTallyER + CrankTallyL1).
- **`try_record_crank_action()` checks for valid operator PDA.** If present → record weighted action. If absent → skip.
- **SNG split: 10% treasury, 45% stakers, 45% dealers (cranks).**
- **Cash game rake split: 50% creator, 5% treasury, 25% stakers, 25% dealers.** (Pending confirmation on total.)
- **`distribute_crank_rewards` runs on L1** after `settle_hand` (cash) or `distribute_prizes` (SNG).
- **TX Cost Monitoring:** `HandCostLog` tracks per-hand L1 fees. If avg > $0.10/hand → trigger ER integration.

### 9. Blind Posting — No Double Charge (Preserved)

- Same as previous architecture. `sit_in_handler` separates live bet from dead money. `start_game` checks `posted_blind` flag.

## Build Rules

- **Two separate toolchains required:**
  - `encrypted-ixs`: **nightly Rust** (arcis-interpreter needs `Span::local_file()`)
  - Anchor program: **Solana BPF compiler** (`cargo-build-sbf`, uses rustc 1.79.0-dev)
- **Cannot use `arcium test` as single command.** Build separately: `scripts/rebuild-circuits.sh` for circuits, `build-anchor.sh` for the program.
- **NTFS mount has cargo permission issues.** Circuit builds must copy to native Linux path first (handled by `scripts/rebuild-circuits.sh`).
- **Pin `time` crate to 0.3.36** — Arcium pulls in 0.3.47 which needs Rust 1.88.
- **Pin `indexmap` to >= 2.7.1** — Arcium's arcis compiler requires it.
- **Pin ordering matters:** `proc-macro-crate@3.5.0 → 3.2.0` BEFORE `indexmap@2.13.0 → 2.7.1` (3.5.0 transitively requires indexmap >= 2.11.4 via toml_edit).
- **SBF output path:** `cargo-build-sbf` outputs to `target/sbf-solana-solana/release/fastpoker.so`, NOT `target/deploy/`. Build script handles the copy.
- **`solana_program::hash` not available** in Anchor 0.32.1's re-export. Use pre-computed discriminator bytes instead of runtime hash computation.

## Testing Rules

- **Three testing modes:** Mock (`ARCIUM_MOCK=true`), Localnet (Docker MXE), Devnet (remote MPC)
- **Mock mode for game logic:** Instant deals, no MPC. Use `devnet_bypass_deal`.
- **Localnet for full E2E:** Real MPC encryption, ~2-5s callbacks. Requires Docker.
- **Start Docker daemon manually in WSL:** `sudo dockerd &`
- **Always use tiny blinds for testing:** 0.00005/0.0001 SOL.
- **Bot scripts use test keypairs** from `tests/keys/`.

## UI/UX Rules

- **Game page loads from L1** — all table/seat data from standard `getAccountInfo`.
- **Polling for game state.** 2s for active games, 5s for waiting.
- **Card display:** Frontend derives x25519 shared secret with MXE, decrypts SeatCards locally via RescueCipher.
- **Admin panel cannot read player cards** — this is correct behavior for trustless poker.

## Process Management Rules

- **NEVER kill all node processes.** Always identify and kill ONLY the specific process needed.

## Workflow Orchestration

### 1. Plan Mode Default
- **Enter plan mode for ANY non-trivial task** (3+ steps or architectural decisions).

### 2. Verification Before Done
- **Never mark a task complete without proving it works.**

### 3. Autonomous Bug Fixing
- **When given a bug report: just fix it.** Point at logs, errors, failing tests — then resolve.

## Arcium Circuit Deployment Rules — CRITICAL

### Genesis Bytecode Bug (MUST follow this workflow)
- **`uploadCircuit()` in `@arcium-hq/client` SKIPS raw circuit accounts that already exist with sufficient size.**
- **`arcium localnet` pre-seeds old bytecode from `artifacts/*.json` genesis files.**
- **If you change the circuit, you MUST update genesis files BEFORE restarting localnet.**
- **Script: `scripts/update-genesis-circuits.ts`** patches `artifacts/*_raw_circuit_*.json` with fresh `.arcis` data.
- **Also patched `backend/node_modules/@arcium-hq/client/build/index.cjs`** to force re-upload (look for `FORCE RE-UPLOADING`).
- **Verify after deploy:** Run `backend/verify-circuit-data.ts` to confirm on-chain SHA256 matches local `.arcis`.

### Full Circuit Change Deployment Workflow
```
1. Edit circuit:       encrypted-ixs/src/lib.rs
2. Build circuits:     wsl bash /mnt/j/Poker-Arc/scripts/rebuild-circuits.sh
3. Update constants:   init_comp_defs.rs (CIRCUIT_LEN, WEIGHT, output count)
4. Update callback:    arcium_deal_callback.rs (SIZE, NUM_OUTPUTS, index mapping)
5. Build program:      wsl bash /mnt/j/Poker-Arc/build-anchor.sh
6. Update genesis:     npx ts-node --transpile-only scripts/update-genesis-circuits.ts
7. Restart localnet:   wsl bash /mnt/j/Poker-Arc/scripts/start-arcium-localnet.sh
8. Re-init circuits:   npx ts-node --transpile-only scripts/arcium-init-circuits.ts
9. Verify bytecode:    npx ts-node --transpile-only backend/verify-circuit-data.ts
10. Smoke test:        npx ts-node --transpile-only backend/smoke-test-arcium-deal.ts
```
**SKIP ANY STEP → STALE BYTECODE → MPC DESERIALIZATION FAILURE**

### HasSize::SIZE — Output-Type-Specific (CRITICAL — Verified 2026-03-15)

**`HasSize::SIZE` VARIES BY OUTPUT TYPE — NOT always `count × 32`!**

| Output Type | Bytes per output | Circuit Example | SIZE |
|-------------|-----------------|-----------------|------|
| `Output::Ciphertext` (Enc<T,V>) | 32 | shuffle_and_deal: 10 ct | **320** |
| `Output::PlaintextU8` | 1 | reveal_community: 5 u8 | **5** |
| `Output::PlaintextU16` | 2 | reveal_showdown: 9 u16 | **18** |
| `Output::PlaintextU64` | 8 | — | — |
| `Output::PlaintextU128` | 16 | — | — |

**Wrong SIZE → Anchor error 102 (InstructionDidNotDeserialize).** This is the #1 callback failure cause.

### Single-MXE Pack<[u8;23]> Architecture (Verified 2026-03-19)

**CRITICAL BUG: Arcium multi-MXE output corruption.** When a circuit produces 2+ MXE ciphertext outputs, the 2nd+ MXE output is silently corrupted. The first MXE output always works. This was confirmed with u128, 2×u64, and Pack<[u8;18]> — all corrupted when used as the 2nd MXE output.

**Solution:** Pack ALL 23 cards (5 community + 18 hole) into a **single** `Enc<Mxe, Pack<[u8;23]>>` output. Both `reveal_community` and `reveal_all_showdown` decrypt the exact same ciphertext — community uses indices [0..4], holes uses [5..22].

- **Pack layout:** `[comm1..comm5, p0c1, p0c2, p1c1, p1c2, ..., p8c1, p8c2]`
- **2 hole cards packed per player into `Enc<Shared, u16>`**: `card1 * 256 + card2`
- **Encrypted values:** 1 Enc<Mxe, Pack<[u8;23]>> all-cards + 9 Enc<Shared,u16> packed hole cards = **10 encrypted values**
- **`Output::Ciphertext` count = 10** (matches encrypted values, NOT raw slots)
- **Client unpacks (Shared):** `card1 = u16 >> 8`, `card2 = u16 & 0xFF`
- **DeckState stores same nonce+ct1 in both `encrypted_community[0..1]` and `encrypted_hole_cards[9..10]`.**

### Arcis Pack<T> Compiler Quirks
- **`Pack::new()` fails with `[{integer}; N]` type error** if array is initialized with literals or conditionals.
- **Must use `[0u8; N]`** (explicit u8 suffix) and then assign elements individually ("Blackjack pattern").
- **Conditionals inside Pack arrays fail** — even with explicit type annotations. Use `active_mask` in the reveal circuit instead of sentinels in the Pack.
- **Pack<[u8; 23]> = 1 field element** (23/26 bytes capacity). No multi-element packing overhead.

### MPC Raw Output Format — Ciphertext Outputs Use Stride=3 (Verified 2026-03-14)
Each `Enc<T, V>` **ciphertext** output produces a **group of 3 raw 32-byte slots**: `[nonce, ct1, ct2]`.
- **nonce**: 16-byte LE u128 output nonce (= input_nonce + 1), zero-padded to 32 bytes
- **ct1**: Primary Rescue ciphertext — the encrypted field element for decryption
- **ct2**: Second Rescue block (internal padding, NOT used for decryption)

**Plaintext outputs are native-sized with NO stride:** PlaintextU8=1 byte, PlaintextU16=2 bytes (LE), packed consecutively.

With 10 declared ciphertext outputs, MPC sends **10 raw 32-byte slots = 320 bytes** (SIZE=320):
```
Slot  0: Mxe all-cards nonce  (value = 0x01, zero-padded to 32)
Slot  1: Mxe all-cards ct1    (Pack<[u8;23]> — community + holes) ← MXE_CT_SLOT
Slot  2: Mxe all-cards ct2    (unused Rescue block)
Slot  3: P0 nonce   (output nonce for player 0)
Slot  4: P0 ct1     ← FIRST_PLAYER_SLOT (hole card ciphertext for decryption)
Slot  5: P0 ct2     (unused)
Slot  6: P1 nonce
Slot  7: P1 ct1     ← hole card ciphertext
Slot  8: P1 ct2     (unused)
Slot  9: P2 nonce   (truncated — no ct1/ct2 within SIZE window)
```
- **Constants:** `MXE_CT_SLOT=1`, `FIRST_PLAYER_SLOT=4`, `PLAYER_STRIDE=3`
- **Stride=3**: `player_ct_offset(i) = (4 + i*3) * 32`, `player_nonce_offset(i) = (3 + i*3) * 32`
- **10 slots covers HU (2 players) for client-side decryption.** Players 2-8 get cards revealed via MPC showdown.
- **Declaring too many outputs causes MPC FAILURE** — output count must match encrypted values, not raw slots.
- **Nonces read from raw output** — no need to compute `input_nonce + 1`.
- **Each MPC output encrypted independently at CTR counter=0.** NOT sequential within a group.
- **Hole card decryption (client-side):** `RescueCipher(sharedSecret).decrypt([ct1], nonce)` → packed u16.

### Callback Error Debugging — Read the FIRST Attempt (Learned 2026-03-15)
When a callback TX fails, the Arcium node retries 5 times, then sends 5 "error claim" TXs.
**The error codes differ between phases:**
1. **First 5 attempts** (regular callback): Error at **instruction 1** = YOUR callback. This is the REAL error.
2. **Next 5+ attempts** (error claim): Error at **instruction 0** = Arcium's `callbackComputation`. Usually `Custom(6000)` (InvalidAuthority) because computation was already claimed.

**Always grep the FIRST error:** `grep "InstructionError" node_0.log | head -5`
- `InstructionError(1, Custom(102))` → SIZE mismatch in your callback
- `InstructionError(0, Custom(6000))` → ignore, computation already consumed by first attempt

### Community Card Encryption — NOT Client-Side Decryptable
- **comm1 = `Enc<Mxe, u8>`** — encrypted to MXE key, only MPC can decrypt.
- **comm2-5 = `Shared::new(pX_key).from_arcis()`** — creates a NEW `Shared` encryption context.
  `Shared::new()` does NOT inherit the CTR counter state from the input `pX` parameter.
  Despite sharing the same x25519 key and output nonce slot, decryption fails with all approaches.
- **This is by design (threat model A12).** Community cards are revealed via `reveal_community` MPC circuit.
- **E2E verified:** All decryption approaches tested (independent, paired, nonce+1, input nonce) — all produce garbage.
- **Privacy proof:** Community cards stored as ciphertext in DeckState. `Table.community_cards` = all 255 until reveal.

### Single-TX Callback Size Limit
- **arx-node v0.8.5:** `multi-tx-callbacks` feature is DISABLED (compile-time).
- **Max safe output:** ~17 ciphertexts × 32 = 544 bytes (6-player circuit worked at this size).
- **Current (10 outputs):** 320 bytes + 64 BLS = 384 bytes — fits comfortably.
- **If adding more outputs:** Check total bytes < ~600. Otherwise need output packing.
- **Output count increase requires full redeploy** (genesis restart + re-init circuits).

## Arcium CPI Rules

- **NEVER use `#[arcium_program]` macro** — conflicts with session-keys `#[derive(Session)]`.
- **NEVER use `#[queue_computation_accounts]`, `#[init_computation_definition_accounts]`, or `derive_mxe_pda!()`** — they all depend on `ID`/`ID_CONST` from `#[arcium_program]` scope.
- **ALWAYS manually implement `QueueCompAccs` and `InitCompDefAccs` traits** using `arcium_client::pda::*` functions for PDA derivation.
- **Import types from `arcium_client::idl::arcium::*`** (generated by `declare_program!`) — NOT from `arcium_anchor::prelude::*`.
- **`ArciumSignerAccount` is defined locally** in `arcium_deal.rs` (seeds: `b"ArciumSignerAccount"`, space: 9).
- **Borrow ordering in CPI handlers:** call `queue_computation()` BEFORE taking mutable borrows on `table`/`deck_state`.
- **Callback discriminators must be pre-computed** as byte arrays. Compute with: `node -e "require('crypto').createHash('sha256').update('global:ix_name').digest().slice(0,8)"`.
- **Callbacks MUST NOT be empty** — Arcium rejects `callbacks: vec![]` with error 6209.
- **All MPC callbacks MUST verify BLS signatures** via `SignedComputationOutputs::verify_output_raw()`. Without this, anyone can spoof callback data.
  - **`extract_mpc_output()` helper** (in `arcium_deal_callback.rs`) handles both modes:
    - **Production (default):** CPI context validation + BLS `verify_output_raw()` (cryptographic proof).
    - **Localnet (`skip-bls` feature):** CPI context validation only. BLS fails on localnet Docker nodes with error 6001 (cluster key mismatch).
  - **Build:** `SKIP_BLS=1` (default) → localnet mode. `SKIP_BLS=0` → production mode with BLS.
  - **All 3 callbacks** (deal, reveal, showdown) use the same `extract_mpc_output()` helper.
- **NEVER use all-zero x25519 pubkeys** for empty seats — Arcium MPC nodes reject `[0; 32]` as invalid curve point.
- **Callback accounts MUST include SeatCards as remaining_accounts.** Without them, the callback handler's `ctx.remaining_accounts` is empty and encrypted hole cards are never written. Add `0..max_players` SeatCards PDAs (writable) to the `CallbackInstruction.accounts` list.
- **Only include SeatCards PDAs that exist on-chain.** Non-existent accounts (e.g., seats 2-8 for a HU table) cause the callback TX to fail silently — the MPC node can't construct the TX.
- **SeatCards enc1_offset = 76** (disc:8 + table:32 + seat_index:1 + player:32 + card1:1 + card2:1 + bump:1). Previous code had 42 which corrupted the player pubkey field.
- **enc2_offset = 108** (enc1_offset + 32). Stores raw 32-byte nonce slot from MPC output (diagnostic).
- **nonce_offset = 140** (enc2_offset + 32). Stores 16-byte output nonce (first 16 bytes of nonce slot from raw MPC output).
- **Showdown callback MUST write plaintext cards to SeatCards.** `settle_hand` reads `card1/card2` from SeatCards offsets 73-74, NOT from `Table.revealed_hands`. The `arcium_showdown_queue` must include the SeatCards PDA (writable) in callback accounts, and `arcium_showdown` callback writes cards there via `remaining_accounts[0]`.
- **`reveal_player_cards` circuit takes exactly 1 param:** `packed: Enc<Shared, u16>`. The `Enc<Shared>` carries implicit Shared context (x25519_pubkey + nonce + ciphertext = 3 ArgBuilder fields). NEVER add an explicit `_player: Shared` param — creates duplicate contexts (5 params instead of 3) causing MPC timeout.

### MPC Timing (localnet, cached preprocessing)

| Operation | Time |
|-----------|------|
| shuffle_and_deal | ~8s |
| reveal_community (flop/turn/river) | ~2s each |
| reveal_all_showdown (all 9 players, single call) | ~2s |
| Full hand (all streets + showdown) | ~20s |
| Quick hand (deal + fold) | ~9s |

Preprocessing is cached between hands — no speedup between hand 1 and hand 5.

### Multi-Player Showdown — Single MPC Call for All 9 Players (Verified 2026-03-19)

- **`reveal_all_showdown` reveals ALL active players' hole cards in one MPC call.** No per-player reveal needed.
- **Input:** Single `Enc<Mxe, Pack<[u8;23]>>` (same as community) + `active_mask` u16 bitmask.
- **Output:** 9 `PlaintextU16` values (SIZE=18). Each u16 = `(card1 << 8) | card2`. Inactive seats = `0xFFFF`.
- **Callback writes `card1`/`card2` to SeatCards** for active players. `settle_hand` reads from SeatCards.
- **9-player settle needs 800K CU** — add `ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })` to settle TX.
- **Stride-3 layout:** Each encrypted value uses 3 raw 32-byte slots `[nonce, ct1, ct2]`. With 10 slots (320 bytes), only Mxe + P0 + P1 get full Shared ciphertext. Players 2-8 SeatCards have no client-side decryptable data.
- **Players 2+ cannot decrypt cards client-side** (no Shared ciphertext in SeatCards). They CAN still play — the MPC circuit deals correctly for all 9 players internally. Showdown reveals all via MXE Pack.
- **Callback TX size limit:** Including all 9 SeatCards PDAs in the deal callback exceeds Solana's 1232-byte TX limit. Fix: limit callback SeatCards to 2 (`min(max_players, 2)`).
- **3-player/6-max, 6-player/6-max, 9-player/9-max E2E tests ALL PASS** (verified 2026-03-19, 162s total).

## Arcium Localnet Rules

- **Start localnet:** `wsl bash /mnt/j/Poker-Arc/scripts/start-arcium-localnet.sh`
- **Verify nodes:** `curl -s http://localhost:9091/health` (ports 9091-9094)
- **MUST run from ext4 filesystem** (`/tmp/poker-arc-workspace`) — NTFS breaks admin.rpc Unix domain socket.
- **MUST kill ALL Docker containers** before restart — including `arcium-trusted-dealer` (filter by `name=arx` + `name=arcium` + `name=recovery`).
- **Genesis programs are immutable** (authority=`11111111...`). To deploy updated code, restart entire localnet.
- **Arcium CLI 0.8.5 requires Anchor 0.31.2** (never publicly released). Use shim that reports 0.31.2 but delegates to 0.32.1.
- **DKG timeout false-positive:** If `arcium localnet` reports timeout but `curl localhost:9091/health` returns `OK`, nodes ARE online — use as-is.
- **First MPC execution on fresh localnet requires SIGNIFICANT preprocessing time** (5-15+ minutes for shuffle_and_deal). Subsequent runs are faster (~2-10s).
- **Circuit init required after every localnet restart:** `ARCIUM_CLUSTER_OFFSET=0 CIRCUIT_BUILD_DIR=build npx ts-node --transpile-only backend/arcium-init-circuits.ts`
- **Localnet keypair must be copied:** `wsl bash -c "cp ~/.config/solana/id.json /mnt/j/Poker-Arc/backend/.localnet-keypair.json"`
- **shuffle_and_deal (13MB) upload always times out** on localnet but genesis bytecode works. Finalization succeeds regardless.
- **ARCIUM_CLUSTER_OFFSET=0** must be set for all Arcium client operations on localnet.

## Steel Pool & Prize Distribution Rules

- **Steel pool PDA must exist before `distribute_prizes`.** Seeds: `["pool"]`, program: `STEEL_PROGRAM_ID`.
- **Steel Initialize instruction:** discriminator=0 (single byte), accounts: `[authority(signer,mut), poolPDA(mut), POKER_MINT(read), SystemProgram]`.
- **POKER_MINT doesn't need to exist as SPL token** for pool init — Steel just stores the address.
- **`prize_authority` PDA MUST be writable** in the outer `distribute_prizes` instruction. Steel CPI marks it `writable+signer` via `AccountMeta::new(key, true)`. Without this → `PrivilegeEscalation`.
- **`flop_reached` is reset by `settle` handler.** Cannot be read after settle. Verify via rake math: `rake = 5% × pot` proves flop was reached.
- **Dealer license required for crank rewards.** `distribute_crank_rewards` zeroes weight for unlicensed operators. If total_weight=0 → `InsufficientFunds` (6061).
- **Check PDA existence before re-init.** Anchor `init` constraint returns `Custom:0` if account already exists.

## Common Error Codes

| Code | Name | Meaning |
|------|------|---------|
| Custom:0 | AlreadyInitialized | Anchor `init` on existing account |
| Custom:101 | InstructionFallbackNotFound | Instruction not in deployed binary |
| Custom:102 | InstructionDidNotDeserialize | **Wrong `HasSize::SIZE`** — most common callback failure. Check SIZE table above. |
| 6000 (Arcium) | InvalidAuthority | Arcium error — often a red herring on callback retries (computation already claimed). Check FIRST error instead. |
| 6001 (Arcium) | BLSSignatureVerificationFailed | Known localnet issue — use CPI context validation |
| 6027 | NothingToCall | Call action when no bet to call (BB should Check, not Call) |
| 6061 | InsufficientFunds | `distribute_crank_rewards` when total_weight=0 (no licensed operators) |
| 6110 | ArciumComputationTimeout | MPC callback returned Failure variant (AbortedComputation) |
| 6113 | InvalidAccountData | settle_hand failed — often means SeatCards card1/card2 are still 255 (showdown callback didn't write plaintext) |
| 6209 (Arcium) | InvalidCallbackInstructions | Arcium rejects empty `callbacks: vec![]` |
| 3005 | AccountNotInitialized | Anchor `Option<Account>` requires sentinel (program ID) for None |
| 3012 | AccountNotInitialized | Comp def account not initialized (run circuit init script) |

## Code Style Rules

- **Discriminators are SHA256("global:<instruction_name>")[0..8]**
- **PDA seeds must match Rust exactly**
- **NEVER use `derive_*_pda!()` macros** — use `arcium_client::pda::*` functions directly
- **NEVER use `#[arcium_program]`** — use standard `#[program]` + manual trait impls
- **`queue_computation()`** for submitting MPC jobs
- **`ArgBuilder::new().plaintext_u128(...).x25519_pubkey(...).build()`** for MPC args
- **Anchor `Option<Account<'info, T>>`** requires an account at that position even for None — pass the program ID as sentinel. Without this → error 3005.

## Frontend Integration Rules

- **`confirmBuyIn` builds and sends `join_table` TX directly.** No API call. Uses `buildJoinTableInstruction` from `onchain-game.ts`.
- **`handleLeaveTable` sends `leave_table` TX in Waiting/Complete phases.** Falls back to `player_action(LeaveCashGame)` during active hands to flag for end-of-hand removal.
- **`auto-start` sends `start_game` TX client-side.** The old `/api/cash-game/ready` endpoint no longer exists.
- **`buildJoinTableInstruction` has exactly 14 accounts** matching the on-chain `JoinTable` struct. SNG callers pass `PROGRAM_ID` sentinels for optional cash game accounts (vault, receipt, unclaimed, token accounts).
- **Stale on-chain state across test runs causes UI crashes.** E2E tests must clean up seats (`leave_table` TXs) in `beforeAll` hooks.
- **React error-boundary in 2-player E2E tests** is caused by wallet mock + stale state race conditions, not code logic bugs. Mitigate with cleanup and retry.

## E2E Test Suite

### Backend Tests (TypeScript, direct RPC)

| Test File | Mode | What It Proves |
|-----------|------|----------------|
| `e2e-arcium-cards.ts` | Arcium MPC | Hole card decryption, privacy proofs, community encrypted in DeckState |
| `e2e-mock-streets.ts` | Mock deal | Full street flow (Preflop→Flop→Turn→River→Showdown) + all-in preflop |
| `e2e-full-game.ts` | Mock deal | Complete game with settle, rake, crank rewards, dealer license |
| `smoke-test-arcium-deal.ts` | Arcium MPC | Quick smoke: deal → verify encrypted SeatCards |
| `smoke-test-dealer-license.ts` | — | Dealer license init, grant, purchase, bonding curve, duplicate rejection |

### Frontend E2E Tests (Playwright, browser-based)

| Test File | What It Proves |
|-----------|----------------|
| `full-lifecycle.spec.ts` | Create table, join, buy-in, leave, seat verification, SNG queue, form validation |
| `sng.spec.ts` | SNG join flow via lobby |
| `cash-game.spec.ts` | Cash game join/leave via UI |
| `lobby.spec.ts` | Lobby navigation, table discovery |
| `create-table.spec.ts` | Create table form validation |

### E2E Test Environment

- **No crank runs during Playwright E2E tests.** The frontend E2E tests (`client/e2e/`) test UI flows only (join, leave, navigation). They do NOT advance game state — no dealing, no betting rounds, no settle.
- **Backend E2E tests self-crank.** Tests in `backend/` (e.g., `e2e-full-game.ts`) send all crank instructions directly (start_game, devnet_bypass_deal, settle_hand, etc.) — no external crank process needed.
- **The crank service (`backend/crank-service.ts`) is for live environments only** (devnet, mainnet). It watches table accounts via `programSubscribe` and auto-sends phase transitions.
- **Stale seat cleanup:** Playwright tests use `beforeAll` hooks to send `leave_table` TXs for deterministic E2E wallets, clearing seats left over from aborted test runs.
- **Deterministic wallet seeds:** `fastpoker-e2e-wallet-v1-N` where N=0,1,2,... Derived via `crypto.createHash('sha256').update(seed).digest()`.

## Master On-Chain Reference

See `docs/reference/on-chain-reference.md` for comprehensive:
- Account sizes and field-by-field byte offsets (Table, PlayerSeat, SeatCards, DeckState, etc.)
- PDA seeds for all 25+ account types
- Instruction discriminators and account lists
- Enum values (GamePhase, SeatStatus, GameType, PokerAction, SnGTier)
- Arcium MPC output format and decryption flow
- Error code reference
- Game flow state machine
