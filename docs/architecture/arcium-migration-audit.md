# Arcium Migration Plan — Audit & Issues

Audited against: FastPoker codebase at `programs/fastpoker/src/`, `backend/crank-service.ts`, `client-v2/src/`
Reference implementation: `github.com/dharmanan/arcium-poker` (encrypted-ixs/ + programs/crypto-bluff/)

---

## CRITICAL — Architecture-Breaking Issues

### C1. The #1 Decision Is Missing: Pre-Deal vs Per-Street MPC

The plan doesn't commit to a card lifecycle model. This is the foundational architectural decision.

**Current model (TEE):** Sequential PRNG — `tee_deal` shuffles + deals hole cards + stores PRNG state in DeckState. `tee_reveal` resumes PRNG to draw burn+community cards. Total latency: ~400ms per reveal (all on ER).

**Arcium MPC cannot resume PRNG across calls.** Each MPC computation is independent — there's no shared mutable state between invocations (unless using a persistent MXE, which adds complexity).

Two options:

| | Option A: Pre-Deal All | Option B: Per-Street MPC |
|---|---|---|
| MPC calls per hand | 1 (+ showdown reveal) | 4-5 (deal + flop + turn + river + showdown) |
| Reveal latency | ~0ms (on-chain copy) | 10-30s per street (MPC callback wait) |
| Total dead time | ~20s (initial deal + showdown) | 60-120s per hand |
| Privacy model | Community cards encrypted on-chain until reveal | Community cards never on-chain until revealed |
| Complexity | Medium | Very High |

**Recommendation:** Option A (pre-deal). One MPC call produces ALL cards. Community cards stored encrypted in DeckState; reveals are on-chain decryption using pre-committed reveal keys. This preserves sub-second reveal latency.

The plan's Step 6 vaguely acknowledges this ("Evaluate if this is acceptable or if a single pre-deal of all community cards is preferable for latency") but doesn't make the decision. It must be decided before any code is written.

---

### C2. Regular ER Has NO Privacy — Fundamental Architecture Conflict

The plan states: "Regular MagicBlock ER (no TEE) handles all game speed."

**Problem:** Regular ER has no read-access control. All account data is publicly readable via `getAccountInfo`. With TEE, the Permission Program enforced per-account read ACLs. Without TEE:

- Any `SeatCards` on regular ER can be read by anyone → hole cards visible
- Any `DeckState` on regular ER can be read by anyone → undelt community cards visible
- There is NO permission program on regular ER

**If SeatCards stores Arcium ciphertext (encrypted to player's key):** This is fine — anyone can read the ciphertext but can't decrypt without the player's private key. This works.

**If DeckState stores pre-dealt community cards (even encrypted):** The encrypted blob exists on-chain. Security depends entirely on Arcium encryption strength. But storing ALL 5 community cards encrypted from hand start means the ciphertext is available for the entire hand duration. This is acceptable if encryption is strong, but the plan should explicitly acknowledge this trust model change.

**If DeckState stores plaintext community cards (as the current PRNG approach would produce):** GAME OVER. Anyone reads ahead. This is NOT viable on regular ER.

**Action required:** The plan must specify that:
1. SeatCards stores Arcium-encrypted hole cards (unreadable without player key) ✓
2. DeckState stores encrypted community cards with a reveal mechanism that doesn't require MPC per street
3. DeckState MUST NOT contain plaintext unrevealed cards on regular ER

---

### C3. settle_hand Is Broken — Not Addressed

`settle_hand` (settle.rs) reads `SeatCards.card1` and `SeatCards.card2` as **plaintext u8 values** (0-51) and passes them to `hand_eval.rs` for ranking computation.

With Arcium encryption, SeatCards will contain ciphertext, not plaintext card indices. `settle_hand` cannot run `hand_eval` on encrypted data.

**Options:**
1. **MPC showdown reveal → on-chain settle:** At showdown, MPC callback writes plaintext card values to SeatCards for active (non-folded) players. Then `settle_hand` works unchanged. Folded players' cards stay encrypted.
2. **Full MPC evaluation:** Run hand_eval inside MPC circuit. Return only the winner index + chip distributions. Most private but most complex.
3. **Hybrid:** MPC reveals active hands to on-chain, `hand_eval` runs on-chain as today.

**Recommendation:** Option 1 or 3. Keep `hand_eval.rs` and `settle.rs` unchanged. MPC callback writes plaintext to SeatCards at showdown (cards are public at showdown anyway). This minimizes code changes.

The plan must add a step between Step 5 and Step 6 for the showdown reveal flow.

---

### C4. Multiplayer Card Encryption — Reference Is 2-Player Only

The reference `arcium-poker` is a **2-player** game (dealer vs player). Its circuit outputs:
```rust
fn shuffle_and_deal_cards_v3(mxe: Mxe, client: Shared) -> (Enc<Mxe, u8>, Enc<Shared, u8>, ...)
```

This encrypts cards to exactly 2 parties: `Mxe` (dealer) and `Shared` (single client).

**FastPoker supports 2-9 players.** Each player needs hole cards encrypted to THEIR individual key. The Arcis `Shared` party type represents a single client. Encrypting to N different players requires either:

1. **N separate MPC calls** (one per player) — very slow
2. **A single circuit with N output slots**, each encrypted to a different player pubkey — the circuit needs to accept N x25519 pubkeys and output N encrypted card pairs
3. **Arcium's multi-party output** if the SDK supports per-output-field encryption targets

The plan's circuit design (`player_cards: [[[u8; 64]; 2]; MAX_PLAYERS]`) assumes option 2 but doesn't verify the Arcis DSL can encrypt different outputs to different parties. **This must be validated with Arcium's SDK before writing circuits.**

---

### C5. MPC Callback Latency — The Devnet Warning

The reference repo README states:
> "MPC transactions are queued but callbacks may not arrive due to executor availability"

The reference implements `devnet_bypass_shuffle_and_deal()` as a fallback. This means Arcium MPC callbacks are **unreliable on devnet**.

The plan mentions "If Arcium MXE computation does not complete within N seconds, emit an alert" but doesn't define:
- What N is (5s? 30s? 60s?)
- What happens to the game while waiting (players staring at "Dealing..." for 60s?)
- Whether a fallback exists (deterministic deal for testing?)
- Whether this is acceptable for production

**Action required:** Add a concrete timeout strategy. Define MOCK mode for testing. Define acceptable latency SLA (e.g., "deal must complete within 5 seconds or game falls back to misdeal").

---

## HIGH — Significant Gaps

### H1. Account Size Changes Not Addressed

**SeatCards** currently: 68 bytes (`table:32 + seat_index:1 + player:32 + card1:1 + card2:1 + bump:1`).
With Arcium: card1/card2 (2 bytes) → encrypted card pair (64-128+ bytes depending on Arcium cipher). Account needs to be ~200+ bytes.

**DeckState** currently: 58 bytes (`table:32 + used_card_mask:8 + deck_index:1 + bump:1 + rng_state:8`).
With Arcium: needs encrypted community cards (~320+ bytes for 5 cards), MXE computation tracking, reveal keys.

**Both accounts need `realloc` or recreation.** All existing tables have the old size. The plan needs a migration step:
- Close existing SeatCards/DeckState PDAs
- Re-create with new size
- Or use `realloc` in the new instructions

### H2. DeckState Redesign Is Underspecified

The plan says "rng_state -- this will move to Arcium in Step 3, but keep the field for now as a placeholder."

`rng_state` has NO equivalent in Arcium. The entire DeckState concept changes:

**Current purpose:** Store PRNG state between tee_deal and tee_reveal calls.
**New purpose:** Store encrypted community cards + MPC job tracking.

New DeckState should be:
```rust
pub struct DeckState {
    pub table: Pubkey,
    pub bump: u8,
    pub encrypted_community: [[u8; 64]; 5],  // 5 encrypted community cards
    pub community_reveal_key: [u8; 32],       // Key to decrypt community cards (from MPC)
    pub cards_revealed: u8,                    // How many community cards have been revealed
    pub computation_id: [u8; 32],             // MXE computation tracking
    pub shuffle_complete: bool,                // Whether MPC deal callback has fired
}
```

### H3. Step 7 Incorrectly Removes delegate_deck_state

The plan says: "Remove: delegate_deck_state — if DeckState is redesigned so its private fields live in the MXE state."

**Wrong.** DeckState still needs to exist on-chain to store encrypted community cards. Whether it needs delegation depends on the architecture:

- If community reveals happen on ER (pre-dealt cards decrypted on-chain): DeckState must be on ER → needs delegation ✓
- If community reveals happen on L1 (MPC callback): DeckState stays on L1 → no delegation needed

With the recommended pre-deal approach (Option A from C1), DeckState SHOULD be delegated to ER so reveals are instant. **Keep delegate_deck_state.**

### H4. Crank State Machine Needs Major Redesign

The plan says "replace tee_deal calls with arcium_deal calls." But the flow fundamentally changes from synchronous to **asynchronous**:

**Current crank flow:**
```
start_game (ER) → tee_deal (ER, instant) → phase=Preflop → betting → tee_reveal (ER, instant) → ...
```

**Arcium crank flow:**
```
start_game (ER) → commit_state → arcium_deal (L1, queue MPC) → WAIT for callback →
callback updates state → redelegate to ER → phase=Preflop → betting → ...
```

The crank needs:
- New phase tracking: `AwaitingDeal`, `AwaitingReveal` (or poll existing phases)
- MPC callback polling/event listening
- Timeout + misdeal fallback
- L1↔ER commit/redelegate cycle management per deal (not just per hand end)

### H5. The Reference Repo URL Is Wrong

The plan references `github.com/abrahamanavhoeba-alt/arcium_poker` — this returns **404**.
The actual repo is: **`github.com/dharmanan/arcium-poker`**

### H6. The Arcis Directory Name Is Wrong

The plan says `arcium init` creates `confidential-ixs/`. The actual reference repo uses **`encrypted-ixs/`**. Verify which name the current Arcium CLI version uses.

### H7. init_table_seat Creates SeatCards Permission — Not Mentioned

`init_table_seat.rs` likely creates the SeatCards + its permission PDA during table setup. The plan says to delete permission instructions but doesn't mention updating `init_table_seat` to skip permission PDA creation. This will cause `init_table_seat` to fail or create orphaned PDAs.

**Add to Step 2:** Update `init_table_seat.rs` to remove permission PDA creation.

### H8. All-In Runout Auto-Advance Must Be Preserved

`tee_reveal.rs` lines 105-127 handle auto-advancement when all players are all-in:
```
Flop → if !active_can_bet → TurnRevealPending
Turn → if !active_can_bet → RiverRevealPending
River → if !active_can_bet → Showdown
```

This logic must be preserved in whatever replaces `tee_reveal`. If community reveals are on-chain (pre-dealt), this is straightforward. If reveals require MPC callbacks, the auto-advance becomes a chain of async MPC calls.

### H9. CrankTallyER Recording Must Be Preserved

Both `tee_deal` (line 326) and `tee_reveal` (line 146) call `try_record_crank_action()` to track crank activity for the dealer reward system. The replacement instructions must preserve this or the crank reward economics break.

### H10. The Frontend Description Assumes Single-Party Decryption

The plan's frontend pattern:
```js
const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
const decryptedCards = cipher.decrypt(seatCardsData.data, nonce);
```

This assumes a standard x25519 key exchange where each player derives a shared secret with the MXE. But in a multiplayer game, the MPC circuit must encrypt each player's cards to their SPECIFIC public key. The frontend decryption is correct in principle but depends on the circuit correctly handling per-player encryption (see C4).

---

## MEDIUM — Correctness / Completeness Issues

### M1. `pre_community` Field on Table Not Addressed

`Table` has `pre_community: [u8; 5]` which stored pre-dealt community cards. With Arcium, this field either:
- Gets removed (community cards live in DeckState encrypted)
- Stays as-is but unused
- Gets repurposed

The plan doesn't mention it.

### M2. `deck_seed` and `deck_index` Fields on Table Not Addressed

`Table` has `deck_seed: [u8; 32]` and `deck_index: u8` which were used for the legacy VRF flow. `tee_deal` sets `deck_seed = [0; 32]` and `deck_index = 0`. These are dead fields that should be cleaned up or repurposed.

### M3. New GamePhase Values May Be Needed

The current phases include `Starting` (between start_game and deal). With async MPC, you may need:
- `AwaitingDeal` — MPC shuffle queued, waiting for callback
- Or reuse `Starting` with a sub-state flag

If a reveal requires MPC, the existing `*RevealPending` phases may need sub-states too.

### M4. The tee_deal Entropy Model Is Lost

`tee_deal` derives entropy from slot_hashes (10-hash chain, 5.7×10²¹ combinatorial complexity). With Arcium MPC, the shuffle randomness comes from MPC node entropy (secure by MPC protocol). The plan should document why Arcium's entropy model is equivalent or better.

### M5. Error Enum Additions Not Listed

The plan says "Use the existing error enum pattern for new error variants" but doesn't list which new errors are needed:
- `ArciumComputationPending`
- `ArciumCallbackInvalid`
- `ArciumComputationTimeout`
- `ShuffleNotComplete`
- `RevealKeyInvalid`
- etc.

### M6. `tee-auth-server.ts` Location Not Verified

The plan says to delete `tee-auth-server.ts`. Verify the actual file path. Based on the grep results, TEE auth is spread across:
- `client-v2/src/hooks/useTeeAuth.ts` (frontend hook)
- `client-v2/src/app/api/tee/` (API routes)
- `client-v2/src/hooks/useGameAuth.tsx`

There may not be a standalone `tee-auth-server.ts` file.

### M7. TEE Validator Constant Needs Updating

`constants.rs` contains `TEE_VALIDATOR_BYTES` and `tee_validator()` used during delegation. Switching from TEE to regular ER means changing the validator target. The plan says "change it to the regular ER validator" but this is a constants.rs change, not just a config change.

### M8. 28 Frontend Files Reference TEE Auth

The grep found 28 files in `client-v2/src/` that reference TEE auth patterns. The plan lists only `useTeeAuth`, `tee-auth-server.ts`, and "frontend card visibility hook." A complete file-by-file audit of all 28 files is needed.

### M9. Existing Tests Not Inventoried

The plan's "Definition of Done" says "All existing tests pass" but doesn't inventory which tests exist and which will break. Any test that calls `tee_deal`, `tee_reveal`, or permission instructions will fail and needs updating.

---

## LOW — Minor / Polish Issues

### L1. Circuit Input Types Need Arcis DSL Validation

The plan specifies circuit inputs like `entropy: [u8; 32]`, `player_pubkeys: [[u8; 32]; MAX_PLAYERS]`. These need validation against Arcis 0.6.3's actual type system. The reference only uses `Enc<Mxe, u8>` and `Enc<Shared, u8>` — basic encrypted unsigned integers.

### L2. `verify_muck` Circuit Is Unnecessary

The plan proposes a ZK proof that folded cards were validly dealt. This is overkill — if cards are Arcium-encrypted and the player folds, nobody can read them anyway. The encryption itself is the proof. Remove this circuit.

### L3. arcium-cli Installation Command May Be Outdated

The plan says `npm install -g @arcium-hq/arcium-cli`. Verify this is the current package name. The reference uses `arcis = "=0.6.3"` in Cargo.toml.

### L4. Deployment Order Not Specified

Anchor program and Arcium circuits have a deployment dependency. The Arcium computation definitions must be deployed first (to get cluster/computation account addresses), then the Anchor program can reference them. The plan doesn't specify deployment order.

---

## SUMMARY TABLE

| ID | Severity | Issue |
|----|----------|-------|
| C1 | CRITICAL | Pre-deal vs per-street MPC — decision not made |
| C2 | CRITICAL | Regular ER has no privacy — DeckState exposure risk |
| C3 | CRITICAL | settle_hand broken with encrypted SeatCards |
| C4 | CRITICAL | Multiplayer encryption — reference is 2-player only |
| C5 | CRITICAL | MPC callback latency — unreliable on devnet |
| H1 | HIGH | Account size changes (SeatCards, DeckState) not addressed |
| H2 | HIGH | DeckState redesign underspecified |
| H3 | HIGH | Step 7 incorrectly removes delegate_deck_state |
| H4 | HIGH | Crank state machine needs async redesign |
| H5 | HIGH | Reference repo URL is wrong (404) |
| H6 | HIGH | Arcis directory name wrong (confidential-ixs vs encrypted-ixs) |
| H7 | HIGH | init_table_seat permission creation not addressed |
| H8 | HIGH | All-in runout auto-advance must be preserved |
| H9 | HIGH | CrankTallyER recording must be preserved |
| H10 | HIGH | Frontend assumes single-party decryption |
| M1-M9 | MEDIUM | Various field cleanup, phase additions, test inventory |
| L1-L4 | LOW | DSL validation, circuit removal, deployment order |

**Total: 5 CRITICAL, 10 HIGH, 9 MEDIUM, 4 LOW**

---

## RECOMMENDED REVISED ARCHITECTURE

Based on the audit, the correct architecture is:

### One MPC Call Per Hand (Pre-Deal All Cards)

```
1. start_game (ER)          → phase = Starting
2. commit_state (ER→L1)     → sync table state to L1
3. arcium_deal (L1)          → queue single MPC computation:
                                - Shuffle 52 cards
                                - Output per-player encrypted hole cards
                                - Output community cards encrypted to table key
                                - Output reveal key (split or committed)
4. MPC callback (L1)         → arcium_deal_callback:
                                - Write encrypted hole cards to SeatCards[i]
                                - Write encrypted community to DeckState
                                - Store reveal key material
                                - Set phase = Preflop
5. redelegate (L1→ER)        → table + seats + DeckState back on ER
6. Betting (ER)              → unchanged game logic
7. arcium_reveal (ER)        → ON-CHAIN community card reveal:
                                - Read encrypted community from DeckState
                                - Decrypt using pre-stored reveal key
                                - Write plaintext to Table.community_cards
                                - NO MPC CALL NEEDED
8. More betting (ER)         → unchanged
9. Showdown (ER or L1)       → Either:
                                a) MPC callback reveals active hands → settle_hand unchanged
                                b) On-chain settle using encrypted eval (complex)
```

**Key insight:** Steps 3-5 add ~15-25s at hand start (MPC + redelegate). But Steps 7 (reveals) are **instant** because community cards are pre-dealt and decrypted on-chain. Total overhead per hand: ~15-25s once at deal time, NOT per street.

### The Reveal Key Problem

If community cards are encrypted and stored on ER (publicly readable), the reveal key CANNOT also be on ER — otherwise anyone decrypts ahead. Options:

1. **Time-locked reveal:** Reveal key stored in DeckState but encrypted. The `arcium_reveal` instruction uses a PDA-signed decryption (program is the only entity that can decrypt). This works because the program controls when cards are written to `Table.community_cards`.

2. **Commitment scheme:** MPC outputs a commitment to community cards (hash). Reveal data stored off-chain in MPC persistent state. On-chain reveal instruction calls MPC to get plaintext. (Adds MPC latency per reveal — bad.)

3. **DeckState stays private on ER via different mechanism:** If Arcium provides an on-chain encryption primitive (encrypt to program PDA), DeckState can store community cards encrypted to the program. Program decrypts during reveal. No one else can read.

**Recommendation:** Option 1 or 3. Validate with Arcium SDK whether program-as-decryptor is supported.
