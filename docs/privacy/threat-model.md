# Threat Model — Arcium Poker

## Attack Surface

### A1. Read Opponent's Hole Cards
- **Vector:** Call `getAccountInfo(seatCardsPDA)` for another player's seat
- **Mitigation:** SeatCards stores Rescue ciphertext encrypted to player's x25519 key. Without the private key, data is meaningless.
- **Severity:** Eliminated by design

### A2. Read Unrevealed Community Cards
- **Vector:** Call `getAccountInfo(deckStatePDA)` before flop/turn/river
- **Mitigation:** Community cards encrypted to `Enc<Mxe, u8>`. Only MPC callback can decrypt. No key stored on-chain.
- **Severity:** Eliminated by design

### A3. Crank Reads Cards While Processing
- **Vector:** Crank service processes TXs — does it see plaintext?
- **Mitigation:** Crank sees only ciphertext. MPC callbacks write encrypted data. Plaintext only appears at showdown (which is public anyway).
- **Severity:** Eliminated by design

### A4. Replay Encrypted Cards Across Hands
- **Vector:** Reuse encrypted card data from a previous hand
- **Mitigation:** `DeckState.hand_number` increments per hand. MPC circuit includes hand_number in computation — different hand = different ciphertext.
- **Severity:** Low — mitigated

### A5. MPC Node Collusion
- **Vector:** All MPC cluster nodes collude to reveal cards
- **Mitigation:** Cerberus protocol: secure if at least 1 of N nodes is honest. Arcium clusters have 3+ nodes.
- **Severity:** Theoretical — acceptable for poker use case

### A6. x25519 Key Derivation from Public Key
- **Vector:** Derive player's private key from their on-chain pubkey
- **Mitigation:** Computationally infeasible (ECDH on Curve25519, 128-bit security)
- **Severity:** Eliminated by cryptography

### A7. Session Key Compromise
- **Vector:** Attacker gains access to player's session key (stored in browser)
- **Mitigation:** Session key signs game actions (check/call/fold) but does NOT hold the x25519 card decryption key. Compromised session key allows playing on behalf of the user but not reading future cards (x25519 derived from wallet signature, not session key).
- **Severity:** Medium — same as current model. Mitigated by 24h session expiry.

### A8. DeckState Size Analysis
- **Vector:** Analyze ciphertext length/pattern to infer card values
- **Mitigation:** Rescue cipher produces fixed-size ciphertext regardless of plaintext value. All cards produce identical ciphertext sizes.
- **Severity:** Eliminated by cipher design

### A9. Timing Attack on MPC Callbacks
- **Vector:** Measure callback timing to infer computation complexity (and thus card values)
- **Mitigation:** MPC computation time is data-independent (both branches of conditionals always execute). Shuffle operation is constant-time.
- **Severity:** Eliminated by MPC protocol design

### A10. Griefing via MPC Timeout
- **Vector:** Attacker floods MPC queue to delay deal callbacks
- **Mitigation:** `handle_mpc_timeout` instruction. If callback doesn't arrive within 60s → misdeal. Blinds returned, new hand starts. Anyone can call this (permissionless).
- **Severity:** Low — game recovers automatically

### A11. Callback Spoofing — Fake MPC Results
- **Vector:** Attacker sends a fake callback TX with fabricated card data, bypassing MPC
- **Mitigation:** Arcium callback includes BLS signature from the MPC cluster. The callback handler MUST call `verify_output()` with the cluster's BLS public key. Invalid signatures are rejected.
- **Severity:** Critical if not verified — **must use `SignedComputationOutputs::verify_output()`**
- **Status:** TODO — current placeholder callback does not verify BLS signature yet

### A12. Community Card Encryption Key Mismatch
- **Vector:** Community cards 2-5 encrypted to `Shared` (player keys) instead of `Mxe` due to Arcis limitation (`Mxe` can't be multi-instantiated)
- **Mitigation:** Community cards 2-5 use `Shared::new(p0_key)` through `Shared::new(p3_key)`. The crank must use the matching player's shared secret to re-encrypt for `reveal_community`. This is a known limitation documented in `encrypted-ixs/src/lib.rs`.
- **Severity:** Medium — requires correct shared secret management in crank. Mitigated by MPC cluster executing the reveal circuit which takes `Enc<Mxe, u8>` inputs.
- **Status:** Needs validation with actual MPC execution

### A13. Computation Offset Collision
- **Vector:** Two different hands reuse the same computation offset, causing the MPC cluster to return stale results
- **Mitigation:** Computation offset is derived from `hand_number * 1_000_000 + timestamp_nonce`. The `DeckState.hand_number` is checked to match the current hand. The Arcium program also rejects duplicate computation offsets.
- **Severity:** Low — mitigated by unique offset generation

## Trust Assumptions

1. **Arcium MPC cluster:** At least 1 of N nodes is honest (Cerberus guarantee)
2. **Solana L1:** Standard Solana consensus assumptions
3. **x25519 + Rescue cipher:** Cryptographically secure (128-bit security level)
4. **Client-side key derivation:** Player's wallet private key is not compromised
5. **No plaintext card values stored on-chain** during active gameplay (enforced by contract guards)
6. **BLS signature verification** on all MPC callbacks prevents callback spoofing (A11)
