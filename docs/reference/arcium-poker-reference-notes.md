# Arcium Poker Reference Notes

Source: `github.com/dharmanan/arcium-poker` (Crypto Bluff)

## Overview
- 2-player MVP poker built for Solana Hackathon
- Uses Arcium MPC for shuffle, deal, and hand evaluation
- Devnet fallback when MPC callbacks unavailable
- NOT production-ready — prototype only

## Key Differences from Our Architecture

| Aspect | Reference (Crypto Bluff) | Our Design (FastPoker-Arc) |
|---|---|---|
| Players | Fixed 2 (dealer vs player) | Dynamic 2-9 per table |
| Join/Leave | None — both must be seated before start | Dynamic between hands |
| Circuit | Single `Shared` client | Per-player `Shared::new(pubkey)` |
| Hand eval | MPC circuit (placeholder) | On-chain `hand_eval.rs` (proven) |
| Community reveal | All encrypted to single client | Encrypted to MXE, revealed via small MPC calls |
| Session keys | None | gum-sdk session keys |
| Crank/Dealer | None | Full weighted tally + operator key system |
| Token economics | Demo chips only | STEEL contract (SOL + SPL staking) |
| Table creation | Admin only | Permissionless (any wallet) |

## Circuit Design (encrypted-ixs/src/lib.rs)

### `shuffle_and_deal_cards_v3`
```rust
fn shuffle_and_deal_cards_v3(mxe: Mxe, client: Shared) -> (
    Enc<Mxe, u8>,       // dealer card (MXE-only)
    Enc<Shared, u8>,     // player card 1
    Enc<Shared, u8>,     // player card 2
    Enc<Shared, u8>,     // community 1-5 (all to same client)
    ...
)
```
- Uses `ArcisRNG::shuffle(&mut deck)` for randomness
- Creates additional `Shared` instances via `Shared::new(client_pubkey)`
- All community cards encrypted to the single client (2-player only)

**Our adaptation:** Replace single `client: Shared` with `p0..p8: Shared` (one per seat). Each player gets unique `Shared::new(player_x25519_pubkey)`. Community cards go to `Mxe` instead of `Shared`.

### `evaluate_hand_v2`
- Placeholder — returns hardcoded `1u8` (player always wins)
- **We don't need this** — our `hand_eval.rs` runs on plaintext after showdown reveal

### `prove_entry_fee`
- Placeholder — returns hardcoded `1u8`
- **We don't need this** — our deposit/vault system handles entry fees

## On-Chain Program (programs/crypto-bluff/src/lib.rs)

### Key Patterns We Reuse
1. ~~**`#[arcium_program]`** macro on module~~ **DEPRECATED — conflicts with session-keys `#[derive(Session)]`. Use `#[program]` + manual trait impls.**
2. **`init_comp_def()`** — one-time registration of each MPC circuit
3. **`queue_computation()`** — submits MPC job with args + callback spec
4. ~~**`#[arcium_callback(encrypted_ix = "...")]`** — callback handler macro~~ **DEPRECATED — we use manual callback handlers with `validate_arcium_callback_context` CPI validation.**
5. **`SignedComputationOutputs<T>`** — typed callback output with `HasSize::SIZE` (SIZE varies by output type! See project-rules.md)
6. ~~**`output.verify_output(&cluster, &computation)`**~~ **BLS fails on localnet (error 6001). Use `SignedComputationOutputs::Success` pattern match + CPI context validation instead.**

### Account Patterns (DEPRECATED — do NOT use derive macros)
**Use `arcium_client::pda::*` functions directly instead of these macros:**
- ~~`derive_mxe_pda!()`~~ → `arcium_client::pda::mxe_acc(&PROGRAM_ID)`
- ~~`derive_comp_pda!()`~~ → `arcium_client::pda::computation_acc(...)`
- ~~`derive_comp_def_pda!()`~~ → `arcium_client::pda::computation_definition_acc(&PROGRAM_ID, offset)`
- ~~`derive_sign_pda!()`~~ → Manual seeds: `[b"ArciumSignerAccount"]`
- **NEVER use `derive_*_pda!()` macros** — they depend on `ID`/`ID_CONST` from `#[arcium_program]` scope which we don't use.

### ArgBuilder Pattern
```typescript
let args = ArgBuilder::new()
    .plaintext_u128(shuffle_seed)
    .x25519_pubkey(client_pubkey)
    .plaintext_u128(client_nonce)
    .build();
```

### Callback Account Pattern
```rust
vec![CallbackAccount {
    pubkey: ctx.accounts.game.key(),
    is_writable: true,
}]
```

## Devnet Fallback
- `devnet_bypass_shuffle_and_deal()` — deterministic deal when MPC unavailable
- Controlled by `VITE_MPC_MODE` env var
- **We implement similar:** `devnet_bypass_deal` instruction + `MPC_MODE` env var

## Local Testing
- Docker Compose: `artifacts/docker-compose-arx-env.yml`
- `arcium deploy --cluster-offset 0` for localnet
- Full MPC with real callbacks on localhost
