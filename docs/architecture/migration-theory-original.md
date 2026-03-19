# FastPoker: Migrate Card Privacy from MagicBlock TEE to Arcium MPC

## Context

FastPoker currently uses MagicBlock's TEE (Trusted Execution Environment) Permission Program for card privacy. The TEE's L1 finalization channel is unstable and breaking in production. We are migrating to a hybrid architecture:

- **Regular MagicBlock ER (no TEE)** handles all game speed: betting actions, timeouts, settlement
- **Arcium MXE (Multi-Party Computation)** handles all card privacy: shuffle, deal, community card reveal, showdown

This eliminates the Permission Program entirely and replaces `tee_deal`/`tee_reveal` with Arcium MXE instructions. The ER delegation system is kept unchanged -- we are only switching from TEE endpoint to regular ER.

---

## Step 0: Read Before Writing Anything

Before touching a single file, read the following in order. Do not skip this step.

1. Read the full directory tree of the Anchor program (`programs/fast-poker/src/`)
2. Read every file in `instructions/` -- understand each instruction's purpose
3. Read `state/` -- understand every account struct (Table, Seat, SeatCards, DeckState, DepositProof, CrankTallyER, etc.)
4. Read `lib.rs` -- understand the full instruction dispatch list
5. Read `create_public_permission.rs` in full
6. Read `tee_deal.rs` in full
7. Read `tee_reveal.rs` in full
8. Read `delegate.rs` in full
9. Read `seat_player.rs` in full
10. Read `crank-service.ts` (or equivalent backend) -- identify all TEE-specific logic
11. Read the frontend card visibility hook (likely `useTeeAuth` or similar) and any `tee-auth-server.ts`

After reading, produce a **pre-implementation audit** as a comment block or markdown file listing:
- Every file that will be deleted
- Every file that will be modified and exactly which parts
- Every new file that will be created
- Every account struct that changes
- Confirmation that you have NOT started modifying any files yet

Wait for approval of the audit before proceeding.

---

## Step 1: Delete the Permission Program (10 instructions)

These instructions exist solely for TEE permission management. They must be deleted entirely -- no stubs, no dead code.

Delete the following instructions (files and their corresponding dispatch entries in `lib.rs`):

```
create_table_permission
create_seat_permission
create_deck_state_permission
delegate_table_permission
delegate_seat_permission
delegate_deck_state_permission
delegate_permission          (the SeatCards one in delegate_permission.rs)
update_seat_cards_permission
reset_seat_permission
muck_cards                   (the permission-based fold -- NOT player_action fold logic)
```

For each deletion:
- Remove the instruction file
- Remove the `use` import in `lib.rs`
- Remove the dispatch entry in `lib.rs`
- Check for any CPI calls to these instructions from other instructions and remove those CPI calls
- Check `seat_player.rs` -- it may optionally call `update_seat_cards_permission` post-seating; remove that call

Do NOT delete or modify:
- Any delegation/undelegation instructions (`delegate_table`, `delegate_seat`, `delegate_deck_state`, `delegate_game`, `commit_and_undelegate_table`, `commit_state`, `undelegate_table`, `cleanup_deposit_proof`, `delegate_crank_tally`)
- The two-step join flow (`deposit_for_join`, `seat_player`, `clear_leaving_seat`, `process_cashout_v2`)
- Any game logic instructions (`start_game`, `player_action`, `settle_hand`, `handle_timeout`, `schedule_timeout`)

After deleting, run `anchor build` and fix all compilation errors before proceeding to Step 2.

---

## Step 2: Clean Up Account Structs

With the Permission Program removed, clean up account structs that referenced permission PDAs.

### DeckState

Remove from `DeckState`:
- Any field that stored the permission PDA address
- Any field used only by the Permission Program (e.g., a permission bump)

Keep in `DeckState`:
- `rng_state` -- this will move to Arcium in Step 3, but keep the field for now as a placeholder
- `used_card_mask` -- same
- All other fields unrelated to permissions

### SeatCards

Remove from `SeatCards`:
- Any field that stored the permission PDA address
- Any permission-related bump field

Keep in `SeatCards`:
- The 2-card storage fields -- these will store Arcium-encrypted card data in Step 3
- The seat reference / player pubkey fields

### Table and Seat

Remove any fields that stored permission PDA addresses or bumps.

After cleanup, run `anchor build` and fix all compilation errors before proceeding to Step 3.

---

## Step 3: Install Arcium Tooling

Do not write any Arcium code yet. First set up the tooling.

```bash
# Install Arcium CLI (wraps anchor CLI)
npm install -g @arcium-hq/arcium-cli

# Install Arcium TypeScript SDK
npm install @arcium-hq/client

# Initialize Arcium in the project (run from project root)
arcium init
```

After `arcium init`, a `confidential-ixs/` directory will be created alongside `programs/`. This is where Arcis MPC circuits go. Read the generated structure before writing any circuits.

Read the Arcium documentation for the computation lifecycle:
- How a client encrypts inputs via x25519 key exchange with the MXE
- How a Solana instruction submits a computation to the MXE network
- How the callback fires and writes results back to L1 accounts

Read the reference poker implementation at `github.com/abrahamanavhoeba-alt/arcium_poker` -- specifically:
- `confidential-ixs/src/lib.rs` -- the 4 MPC circuits
- `programs/arcium_poker/src/arcium/mpc_shuffle.rs`
- `programs/arcium_poker/src/arcium/mpc_deal.rs`
- `programs/arcium_poker/src/arcium/mpc_reveal.rs`
- `tests/test_mxe_integration.ts`

---

## Step 4: Write the Arcium MPC Circuits (confidential-ixs)

Write 4 confidential instructions in `confidential-ixs/src/lib.rs` using the Arcis DSL.

### Circuit 1: `shuffle_and_deal`

**Purpose:** Shuffle 52 cards and encrypt each player's 2 hole cards to their individual public key.

**Inputs (encrypted):**
- `entropy: [u8; 32]` -- provided by the on-chain SlotHashes sysvar, passed as encrypted input
- `player_pubkeys: [[u8; 32]; MAX_PLAYERS]` -- each active player's x25519 public key for card encryption
- `num_players: u8` -- number of active players at the table

**Outputs:**
- `encrypted_deck: [[u8; 4]; 52]` -- full encrypted deck (encrypted under aggregate key for community card reveals)
- `player_cards: [[[u8; 64]; 2]; MAX_PLAYERS]` -- hole cards encrypted per-player (only that player can decrypt)

**Security requirement:** No intermediate plaintext card value should be observable by any node. The shuffle permutation must be derived from entropy and remain secret until community cards are revealed.

### Circuit 2: `reveal_community_cards`

**Purpose:** Decrypt and reveal N community cards from the pre-shuffled encrypted deck.

**Inputs (encrypted):**
- `encrypted_deck` -- the deck committed from `shuffle_and_deal`
- `reveal_positions: [u8; 5]` -- which positions in the deck to reveal (e.g., positions 10-14 for community cards)
- `num_to_reveal: u8` -- 3 for flop, 1 for turn, 1 for river

**Outputs:**
- `revealed_cards: [[u8; 4]; 5]` -- plaintext card values for the community cards (public, goes on-chain)

### Circuit 3: `decrypt_showdown_hands`

**Purpose:** At showdown, reveal hole cards for all still-active players (those who did not fold).

**Inputs (encrypted):**
- `encrypted_deck` -- from `shuffle_and_deal`
- `active_player_seats: [u8; MAX_PLAYERS]` -- bitmask of seats still in hand
- `player_card_positions: [[u8; 2]; MAX_PLAYERS]` -- which deck positions belong to each player

**Outputs:**
- `revealed_hands: [[[u8; 4]; 2]; MAX_PLAYERS]` -- hole cards for each active player, plaintext (public for showdown)

### Circuit 4: `verify_muck` (optional but recommended)

**Purpose:** Prove that a folded player's cards remain secret and were validly dealt, without revealing them.

**Inputs (encrypted):**
- `player_encrypted_cards: [[u8; 64]; 2]` -- the folded player's encrypted hole cards
- `deck_commitment: [u8; 32]` -- hash of the full deck from shuffle phase

**Outputs:**
- `is_valid_deal: bool` -- ZK proof that the cards were validly dealt without revealing values

After writing circuits, compile with:
```bash
arcium build
```

Fix all compilation errors before proceeding to Step 5.

---

## Step 5: Replace `tee_deal.rs` with `arcium_deal.rs`

Create `programs/fast-poker/src/instructions/arcium_deal.rs`.

**This instruction runs on L1 (not ER).** It is called BEFORE the betting round begins.

**Logic:**
1. Read the current `SlotHashes` sysvar and extract entropy
2. Read active player pubkeys from the Table/Seat accounts
3. Submit `shuffle_and_deal` computation to the Arcium MXE network:
   - Encrypt entropy as MXE input
   - Pass player pubkeys
   - Specify callback instruction (see below)
4. Store the `computation_offset` (MXE job ID) in the `DeckState` account so the callback can find it

**Callback instruction (`arcium_deal_callback`):**
- Triggered by Arcium nodes when computation completes
- Receives `player_cards` output from MXE
- Writes each player's encrypted card pair to their `SeatCards` account
- Writes `encrypted_deck` to `DeckState` for use in community card reveals
- Updates game state to signal "cards dealt, betting can begin"

**Account constraints:**
- `DeckState` must NOT be delegated to ER when this instruction runs (it is on L1)
- After callback completes and game transitions to betting, `DeckState` and `SeatCards` can be delegated to ER

**Important:** The `SeatCards` account no longer needs permission-based access control. The cards stored in `SeatCards` are Arcium-encrypted -- only the player with the corresponding private key can decrypt them. Any player can call `getAccountInfo` on any `SeatCards` and will see ciphertext they cannot decrypt. Remove any access control checks that were previously enforcing the Permission Program pattern.

Delete `tee_deal.rs`.

---

## Step 6: Replace `tee_reveal.rs` with `arcium_reveal.rs`

Create `programs/fast-poker/src/instructions/arcium_reveal.rs`.

**This instruction runs on L1.** It is called at each community card phase (flop, turn, river) and at showdown.

**Logic:**
1. Read `encrypted_deck` from `DeckState`
2. Determine which positions to reveal (based on game phase: flop = positions 10-12, turn = 13, river = 14, or whichever index scheme is in use)
3. Submit `reveal_community_cards` computation to the Arcium MXE network
4. Store `computation_offset` for callback tracking

**Callback instruction (`arcium_reveal_callback`):**
- Receives `revealed_cards` plaintext output from MXE
- Writes community card values to the Table account (the existing community card fields)
- Updates game phase state

**For showdown:** Same pattern but uses `decrypt_showdown_hands` circuit instead.

**Note on ER coordination:** Community card reveals happen between betting streets. The game is on ER during betting but the reveal is L1. The flow is:
1. Betting street ends on ER → `commit_state` commits ER state back to L1
2. L1 `arcium_reveal` submits MXE computation
3. Arcium callback writes community cards to L1 Table account
4. L1 delegation resumes for next betting street

This adds one commit/redelegate cycle per street. Evaluate if this is acceptable or if a single pre-deal of all community cards (concealed in the encrypted deck) is preferable for latency.

Delete `tee_reveal.rs`.

---

## Step 7: Update Delegation Instructions

In `delegate.rs`:

**Remove:** `delegate_deck_state` -- if DeckState is redesigned so its private fields live in the MXE state rather than on-chain, it may not need delegation. Evaluate based on what fields remain after Step 2.

**Keep unchanged:**
- `delegate_table`
- `delegate_seat`
- `delegate_seat_cards` -- SeatCards still gets delegated to ER (it now stores Arcium ciphertext which is safe to put on ER since it's encrypted)
- `delegate_deposit_proof`
- `delegate_game`
- `commit_and_undelegate_table`
- `commit_state`
- `undelegate_table`
- `cleanup_deposit_proof`

**Update the TEE endpoint to regular ER:** In any place where the delegation target was the TEE validator URL/address, change it to the regular ER validator. This is a config/constant change, not a logic change.

---

## Step 8: Update `lib.rs`

Remove:
- All 10 deleted permission instruction imports and dispatch entries
- `tee_deal` and `tee_reveal` dispatch entries

Add:
- `arcium_deal` and `arcium_deal_callback` dispatch entries
- `arcium_reveal` and `arcium_reveal_callback` dispatch entries

Run `anchor build`. All compilation errors must be resolved before continuing.

---

## Step 9: Update `crank-service.ts`

Remove entirely:
- TEE JWT token management (`useTeeAuth` or equivalent)
- Per-validator TEE connection routing
- TEE-specific error handling (500, 403, stale cache errors from Permission Program)
- Permission reset calls after player leaves seat

Update:
- Instruction calls: replace `tee_deal` calls with `arcium_deal` calls
- Instruction calls: replace `tee_reveal` calls with `arcium_reveal` calls
- Add Arcium TypeScript SDK import: `import { getClusterAccAddress, getArciumEnv } from "@arcium-hq/client"`
- Add MXE program ID constant for the deployed MXE
- Add logic to poll computation status (or listen for callback events) after submitting `arcium_deal` / `arcium_reveal`
- Add timeout handling: if Arcium MXE computation does not complete within N seconds, emit an alert (do not auto-retry blindly)

Keep unchanged:
- All ER delegation/undelegation calls
- Cashout and vault logic
- Crank revenue / tally logic
- `commit_and_undelegate_table` calls

---

## Step 10: Update the Frontend Client

**Remove:**
- `useTeeAuth` hook entirely
- `tee-auth-server.ts` (server-side TEE JWT token caching)
- Any logic that calls the TEE RPC endpoint to fetch card data
- Per-validator TEE read logic in admin panel

**Add:**
- `useArciumCards` hook: on mount, performs x25519 key exchange with the MXE to derive a shared secret, uses that secret to decrypt the player's `SeatCards` account data locally
- The player's private key for card decryption should be derived deterministically from a signed message (wallet signature over a known string), so the player does not need to store a separate keypair
- Card display logic: read `SeatCards` ciphertext via normal `getAccountInfo`, decrypt locally using the derived key, display card values

**Pattern (from Arcium TypeScript SDK docs):**
```typescript
// Derive keypair from wallet signature
const clientPrivateKey = x25519.utils.randomSecretKey(); // or derive from wallet sig
const clientPublicKey = x25519.getPublicKey(clientPrivateKey);

// Get MXE public key
const mxePublicKey = await getMXEPublicKeyWithRetry(provider, mxeProgramId);

// Derive shared secret
const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
const cipher = new RescueCipher(sharedSecret);

// Decrypt card data from SeatCards account
const seatCardsData = await connection.getAccountInfo(seatCardsPDA);
const decryptedCards = cipher.decrypt(seatCardsData.data, nonce);
```

**Admin panel:** Remove per-validator TEE read logic. Card visibility in admin panel should be disabled by default (admin cannot read player cards -- this is correct behavior for a trustless poker game).

---

## Step 11: Deploy and Test

### Local Testing (no MXE)
Arcium supports a mock/dual-mode where MXE accounts are passed as `None`. Use this for local tests:
- All game logic tests (betting, timeouts, settlement, cashout) should pass without any MXE
- Add a flag `ARCIUM_MOCK=true` for local test runs that bypasses MXE calls and uses deterministic test cards

### Devnet Testing (real MXE)
1. Deploy MXE program to Arcium devnet: `arcium deploy --network devnet`
2. Initialize MXE cluster: `arcium init-cluster --name poker-cluster`
3. Deploy Anchor program to Solana devnet: `anchor deploy --provider.cluster devnet`
4. Run integration test: deal cards, verify each player can decrypt their own cards, verify no player can decrypt another's, verify community cards reveal correctly at each street
5. **Benchmark deal latency:** time from `arcium_deal` TX confirmation to `arcium_deal_callback` TX confirmation. Record this number. If it exceeds 5 seconds, escalate before mainnet.

### Test Cases That Must Pass
- [ ] Player A cannot read Player B's hole cards (SeatCards ciphertext is unreadable without Player B's key)
- [ ] Folded player's cards remain encrypted post-hand (no showdown reveal path for folders)
- [ ] Community cards are revealed correctly at flop, turn, river
- [ ] Showdown correctly reveals all active players' hands
- [ ] Player can re-derive their card decryption key from wallet signature (no key loss risk)
- [ ] Full 6-player hand completes end-to-end on devnet
- [ ] `commit_and_undelegate_table` works on regular ER (not TEE) -- this was broken on TEE

---

## Constraints and Rules

**Never do any of the following:**
- Add the Permission Program back in any form
- Store plaintext card values in any on-chain account (SeatCards, DeckState, Table, or any other)
- Allow admin or crank to read any player's hole cards
- Use MagicBlock TEE validator endpoints for anything
- Delete or modify the ER delegation/undelegation system
- Delete or modify the TableVault / two-step join flow
- Modify hand evaluation, pot logic, rake calculation, or side pot logic
- Modify the kick-BB penalty, time bank, or seat management logic

**Code quality rules:**
- No `msg!` logging of card values, RNG state, or any field that should be private
- No `#[cfg(test)]` code that exposes private card values
- Every new instruction must have explicit account validation (PDAs checked, signers checked)
- Use the existing error enum pattern for new error variants

---

## Definition of Done

The migration is complete when:
1. `anchor build` passes with zero warnings on the permission/TEE-related code
2. All existing tests pass (betting, game flow, cashout, crank)
3. New Arcium integration tests pass on devnet
4. Deal latency benchmark is recorded and within acceptable range
5. No plaintext card values appear in any on-chain account
6. No Permission Program instructions remain in the codebase
7. Frontend card display works without any TEE auth token
8. `commit_and_undelegate_table` works correctly on regular ER endpoint