# Card Privacy Model — Arcium MPC

## Overview

All card data is encrypted using Arcium's Rescue cipher with x25519 key exchange. No plaintext card values exist on-chain during active gameplay.

## Encryption Parties

| Party | Type | Can Decrypt |
|---|---|---|
| Player (per-seat) | `Enc<Shared, u8>` | Only that player (client-side, using their x25519 private key) |
| MXE (cluster) | `Enc<Mxe, u8>` | Only the MPC cluster (via callback computation) |
| Program PDA | N/A | Program reads encrypted data as instruction account input |

## Card Lifecycle

### Hole Cards
1. **Deal:** MPC circuit encrypts each player's 2 hole cards to their unique x25519 pubkey → `SeatCards.enc_card1`, `SeatCards.enc_card2`
2. **During play:** Player reads `SeatCards` via `getAccountInfo`, decrypts locally with their x25519 private key + MXE shared secret
3. **Showdown:** MPC callback writes plaintext to `SeatCards.card1`, `SeatCards.card2` for active (non-folded) players only
4. **Folded:** Cards stay encrypted forever — never revealed to anyone

### Community Cards
1. **Deal:** MPC circuit encrypts 5 community cards to MXE key → `DeckState.encrypted_community`
2. **During play:** Nobody can read community cards (encrypted to MXE, not any player)
3. **Reveal (Flop/Turn/River):** Small MPC call decrypts the relevant cards → plaintext written to `Table.community_cards`
4. **Post-reveal:** Revealed community cards are public (written plaintext on-chain)

### DeckState / Shuffle
- The shuffle permutation is generated inside the MPC circuit using `ArcisRNG::shuffle()`
- Shuffle entropy comes from MPC node randomness (secure by MPC protocol)
- No PRNG state, seed, or shuffle order is ever stored on-chain
- The `DeckState` account stores only encrypted outputs, never the shuffle itself

## Threat Model

| Attack | Mitigation |
|---|---|
| Read opponent's hole cards via `getAccountInfo` | Ciphertext only — encrypted to opponent's x25519 key |
| Read unrevealed community cards | Encrypted to MXE key — nobody can decrypt without MPC callback |
| Crank reads cards while processing | Crank sees only ciphertext — same as any other RPC reader |
| Replay encrypted cards from previous hand | `hand_number` field in DeckState prevents cross-hand replay |
| Derive x25519 private key from pubkey | x25519 is computationally secure (ECDH on Curve25519) |
| MPC node collusion | Cerberus protocol: secure if at least 1 of N nodes is honest |

## Player Key Lifecycle

1. Player connects wallet
2. Frontend derives x25519 keypair from wallet signature (deterministic — same wallet always produces same key)
3. x25519 pubkey submitted during `seat_player` instruction → stored in `PlayerSeat.x25519_pubkey`
4. At deal time, MPC circuit reads all active players' pubkeys and encrypts per-player
5. Player uses x25519 private key + MXE public key → shared secret → RescueCipher → decrypt cards locally

## Circuit Implementation (encrypted-ixs/src/lib.rs)

### Circuit 1: `shuffle_and_deal`
- **Supports:** 2-9 players
- **Inputs:** `mxe: Mxe`, `p0..p8: Shared` (one per player, each with unique x25519 pubkey), `num_players: u8`
- **Outputs:** 9 `Enc<Shared, u16>` (packed hole cards: card1×256+card2) + 1 `Enc<Mxe, u8>` (comm1) + 4 `Enc<Shared, u8>` (comm2-5 via `Shared::new(pX_key)`)
- **Total:** 14 outputs × 32 bytes = 448 bytes (fits single-TX callback)
- **Shuffle:** `ArcisRNG::shuffle(&mut deck)` — MPC-secure randomness
- **Per-player encryption:** Each player's `Shared` instance encrypts their packed hole card to their unique key.
- **Community cards 2-5:** Use `Shared::new(pX_key).from_arcis()` workaround (Arcis can't construct multiple `Mxe` instances). These are NOT client-side decryptable — designed for reveal via `reveal_community` MPC circuit. See threat model A12.
- **Unused seats:** Get card value 0xFFFF (both cards = 255 = NOT_DEALT)
- **Client unpacks:** `card1 = u16 >> 8`, `card2 = u16 & 0xFF`

### Circuit 2: `reveal_community`
- **Inputs:** 5 `Enc<Mxe, u8>` (community card ciphertexts from DeckState), `num_to_reveal: u8`
- **Outputs:** 5 plaintext `u8` values (`.reveal()`)
- **Called:** At flop (num_to_reveal=3), turn (4), river (5)
- **Unrevealed slots:** Return 255
- **Note:** comm2-5 are `Enc<Shared>` from shuffle_and_deal, not `Enc<Mxe>`. Type mismatch with this circuit's inputs is a known issue (A12).

### Circuit 3: `reveal_showdown`
- **Inputs:** 18 `Enc<Mxe, u8>` (MXE-encrypted copies of all hole cards, 2 per player × 9), `active_mask: u16`
- **Outputs:** 18 plaintext `u8` values (`.reveal()`)
- **Bitmask:** Uses modulo arithmetic (Arcis doesn't support bitwise `&` on integers)
- **Folded players:** Get 255 (never revealed)

### Known Limitations / Workarounds
- **Mxe can't be constructed:** Arcis doesn't allow `let mxe2 = Mxe;`. Only the `mxe` parameter instance exists. Community cards 2-5 are encrypted to temporary `Shared::new(pX_key)` instances instead. **Validated:** These are NOT client-side decryptable (all decryption approaches tested, all produce garbage). Community reveals must go through `reveal_community` MPC circuit.
- **Community card type mismatch (A12):** `reveal_community` expects `Enc<Mxe, u8>` inputs, but comm2-5 are `Enc<Shared, u8>` from shuffle_and_deal. This is a known architectural gap.
- **Packed format (9-player):** 23 unpacked outputs exceeded single-TX callback limit (736+64=800 bytes). Packed to 14 outputs (448+64=512 bytes) using `Enc<Shared, u16>` for hole cards.
- **Arcis conditional execution:** Both branches of `if/else` always execute in MPC (no side-channel leaks). The `num_players` checks are safe because num_players is plaintext.
- **MPC raw output format:** Grouped by owner key with interleaved nonces. Output nonce = input nonce + 1 (LE u128). Each output encrypted independently at CTR counter=0.
