---
name: arcium-program-development
description: A brief description, shown to the model to help it understand when to use this skill
---

# Arcium MXE Program Development

Apply whenever working on Arcium MXE programs (`programs/`), Arcis circuits (`encrypted-ixs/`),
or `@arcium-hq/client` TypeScript code. Current toolchain: **arcium 0.6.3 · anchor 0.32.1 · solana 2.3.0 · rust 1.89.0**.

---

## Workspace Layout

```
encrypted-ixs/src/lib.rs      ← Arcis circuits (#[encrypted] mod, #[instruction] fns)
programs/<name>/src/lib.rs    ← Anchor program (init_comp_def, queue, callback)
programs/<name>/Cargo.toml    ← must include arcium-anchor/idl-build in idl-build feature
tests/<name>.ts               ← TypeScript: encrypt → queue → awaitComputationFinalization
Cargo.toml (workspace)        ← NO [patch.crates-io] section in 0.4+
rust-toolchain.toml           ← channel = "1.89.0" (TOML format, not plain text file)
```

**Cargo.toml — required features/lints for every program (0.4+):**
```toml
[dependencies]
anchor-lang = { version = "0.32.1", features = ["init-if-needed"] }
arcium-client  = { version = "0.6.3", default-features = false }
arcium-macros  = { version = "0.6.3" }
arcium-anchor  = { version = "0.6.3" }

[features]
idl-build = ["anchor-lang/idl-build", "arcium-anchor/idl-build"]  # both required

[lints.rust]
unexpected_cfgs = { level = "warn", check-cfg = ['cfg(target_os, values("solana"))'] }
```

---

## Step 1 — Classify the Pattern

Before writing any code, identify which pattern applies:

| Pattern | Signature | Example |
|---------|-----------|---------|
| **Stateless** | Returns `Enc<Shared,T>`, no account mutation. Result emitted as event. | Coinflip, RPS |
| **Stateful** | Returns `Enc<Mxe,T>`. Callback writes ciphertext back to a PDA. `.account()` in ArgBuilder. | Voting, Sealed Auction, Blackjack |
| **Multi-step init** | First computation creates initial encrypted state, later computations update it. | Voting (`create_poll` → `vote` → `reveal_result`) |
| **Permission-gated** | State machine on the Anchor side restricts when `queue_computation` may be called. | Medical Records |
| **RNG** | Uses `ArcisRNG` primitive inside the circuit. No client input required. | Coinflip |

---

## Step 2 — Arcis Circuit (`encrypted-ixs/src/lib.rs`)

### Module skeleton
```rust
use arcis_imports::*;  // NOT arcis::* in encrypted-ixs crate

#[encrypted]
mod circuits {
    use arcis_imports::*;

    // ─── Testable helpers (no MPC runtime needed) ───
    pub fn basis_points_fee(amount: u64, bps: u64) -> u64 {
        amount * bps / 10_000
    }

    // ─── Encrypted instructions (require MPC runtime) ───
    #[instruction]
    pub fn flip(rng: ArcisRng) -> Enc<Shared, bool> {
        rng.owner.from_arcis(rng.next_bool())
    }

    #[instruction]
    pub fn vote(
        ballot: Enc<Shared, u8>,           // user's choice, shared secret
        counts: Enc<Mxe, [u64; 3]>,        // running tally, MXE-only
    ) -> Enc<Mxe, [u64; 3]> {
        let choice = ballot.to_arcis();
        let mut tally = counts.to_arcis();
        for i in 0..3usize {
            let matches = i as u8 == choice;  // both branches always execute
            tally[i] += if matches { 1u64 } else { 0u64 };
        }
        counts.owner.from_arcis(tally)
    }
}
```

### Enc<Owner, T> — two modes

| Type | Decryptable by | Use for |
|------|----------------|---------|
| `Enc<Shared, T>` | Client + MXE | User inputs/outputs (vote, bid, hand, card choice) |
| `Enc<Mxe, T>` | MXE cluster only | Protocol state (tallies, deck, order book) |

Never use `Enc<Shared>` for aggregate state — any user could decrypt it.

### Mandatory call pattern
```rust
let value = enc_input.to_arcis();     // secret-share for MPC
// ... compute on `value` ...
enc_input.owner.from_arcis(result)    // re-encrypt and return
```

### MPC execution model — critical pitfalls

Both branches of every `if` **always execute**. The condition selects the result; it does not skip work.

```rust
// WRONG — secret_idx write happens regardless of found_match
if found_match {
    data[secret_idx] = new_value;
}

// CORRECT — constant-index sweep with conditional assign
for i in 0..N {
    let should_write = found_match && (i == secret_idx);
    if should_write { data[i] = new_value; }
}
```

`.reveal()` and `.from_arcis()` cannot appear inside conditional blocks.

### Operation costs
| Cheap | Expensive |
|-------|-----------|
| `+`, `-`, `*` | `>`, `<`, `==`, `!=` |
| Constants, public inputs | `/`, `%` |
| Fixed-index array access | Dynamic/secret-index access — O(n) |

Reuse comparison results — computing the same comparison twice costs double.

### Supported return types
✅ `u8/u16/u32/u64/u128/i*`, `bool`, `[T; N]` (fixed), tuples, custom structs
❌ `Vec<T>`, `String`, `HashMap`, `Option<T>`, `Result<T,E>`, references, generics with lifetimes

### Unit testing helpers
```rust
#[cfg(test)]
mod tests {
    use super::circuits::basis_points_fee;
    #[test]
    fn fee_calc() { assert_eq!(basis_points_fee(10_000, 250), 250); }
}
```
`#[instruction]` functions cannot be unit-tested — they require the live MPC runtime.

---

## Step 3 — Computation Definition Account

One per `#[instruction]`. Call once on deploy (never again, unless you wipe the ledger).

```rust
pub fn init_flip_comp_def(ctx: Context<InitFlipCompDef>) -> Result<()> {
    init_comp_def(ctx.accounts, 0, None, None)?;  // 0 = cu_price_micro
    Ok(())
}

#[init_computation_definition_accounts("flip", payer)]
#[derive(Accounts)]
pub struct InitFlipCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    pub comp_def_account: UncheckedAccount<'info>,  // Arcium creates via CPI
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}
```

`COMP_DEF_OFFSET_FLIP` = `comp_def_offset("flip")` = first 4 bytes of `sha256("flip")` as little-endian u32.
Address: `derive_comp_def_pda!(COMP_DEF_OFFSET_FLIP)`.

---

## Step 4 — Queue Instruction

### ArgBuilder — field order is STRICT. Wrong order = silent input corruption.

**`Enc<Shared, T>` (client-encrypted input):**
```
1. .x25519_pubkey(pub_key)          ← client ephemeral pubkey [u8; 32]
2. .plaintext_u128(nonce)           ← deserialized LE u128
3. .encrypted_u8/16/32/64/128/bool(ciphertext)  ← one call per field, circuit order
```

**`Enc<Mxe, T>` (account-backed state read from PDA):**
```
1. .plaintext_u128(mxe_nonce)       ← no pubkey for MXE-only data
2. .encrypted_*(ciphertext)
   OR
   .account(pubkey, byte_offset, byte_len)  ← for data stored in an account
```

**`.account()` offset formula — never use magic numbers:**
```
offset = 8 (discriminator) + sum(byte sizes of all preceding fields)
len    = num_ciphertext_fields × 32
```

Field sizes for offset math:
| Type | Bytes | | Type | Bytes |
|------|-------|-|------|-------|
| `u8` / `bool` / bump | 1 | | `u64` / `i64` | 8 |
| `u16` | 2 | | `u128` / nonce | 16 |
| `u32` / `i32` | 4 | | `Pubkey` | 32 |
| | | | Ciphertext field | 32 |

Always add an inline comment showing derivation:
```rust
// Poll { authority: Pubkey[32], is_active: bool[1], vote_counts: [u64;3] ciphertexts }
// offset = 8 + 32 + 1 = 41, len = 3 * 32 = 96
.account(ctx.accounts.poll.key(), 41, 96)
```

Recompute offsets immediately whenever the account struct gains, loses, or reorders fields.

### Full queue instruction — coinflip (stateless, RNG, no client ciphertext)

```rust
pub fn flip(
    ctx: Context<Flip>,
    computation_offset: u64,
) -> Result<()> {
    let args = ArgBuilder::new().build();  // no inputs — ArcisRng is internal

    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        None,                                              // callback server addr
        vec![FlipCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[],                                           // no custom callback accounts
        )?],
        1,                                                 // num_callback_txs
        0,                                                 // cu_price_micro
    )?;
    Ok(())
}
```

### Full queue instruction — voting (stateful, Enc<Mxe> from account)

```rust
pub fn vote(
    ctx: Context<Vote>,
    computation_offset: u64,
    ballot_ciphertext: [u8; 32],
    pub_key: [u8; 32],
    nonce: u128,
) -> Result<()> {
    let poll = &ctx.accounts.poll;
    let args = ArgBuilder::new()
        // Enc<Shared, u8> ballot — client-encrypted
        .x25519_pubkey(pub_key)
        .plaintext_u128(nonce)
        .encrypted_u8(ballot_ciphertext)
        // Enc<Mxe, [u64;3]> vote_counts — from account storage
        // offset = 8(disc) + 32(authority) + 1(is_active) = 41, len = 3*32 = 96
        .plaintext_u128(poll.vote_counts_nonce)
        .account(poll.key(), 41, 96)
        .build();

    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        None,
        vec![VoteCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[CallbackAccount { pubkey: poll.key(), is_writable: true }],
        )?],
        1,
        0,
    )?;
    Ok(())
}
```

### Queue accounts struct — boilerplate (only change COMP_DEF_OFFSET and name)

```rust
#[queue_computation_accounts("flip", payer)]   // ← change name here
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct Flip<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_FLIP))]  // ← change offset constant
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    // Add your program-specific accounts below this line
}
```

---

## Step 5 — Callback Instruction

### Naming — must match exactly, case-sensitive, in all three places

```rust
// encrypted-ixs:         #[instruction]       pub fn vote(...)
// queue accounts macro:  #[queue_computation_accounts("vote", payer)]
// callback macro:        #[arcium_callback(encrypted_ix = "vote")]
// output type name:      VoteOutput  (auto-generated, PascalCase + "Output")
```

### Callback function — always call verify_output first

```rust
#[arcium_callback(encrypted_ix = "flip")]
pub fn flip_callback(
    ctx: Context<FlipCallback>,
    output: SignedComputationOutputs<FlipOutput>,
) -> Result<()> {
    // verify_output is MANDATORY before any field access
    let result = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(FlipOutput { field_0 }) => field_0,
        Err(e) => {
            msg!("Computation aborted: {}", e);
            return Err(ErrorCode::AbortedComputation.into());
        }
    };

    // result.ciphertexts[0]  — encrypted output [u8;32]
    // result.nonce           — u128 for client decryption
    // result.encryption_key  — [u8;32] shared pubkey (Shared only)

    emit!(FlipEvent {
        result: result.ciphertexts[0],
        nonce:  result.nonce.to_le_bytes(),
    });
    Ok(())
}
```

### Stateful callback — writing encrypted result back to account

```rust
#[arcium_callback(encrypted_ix = "vote")]
pub fn vote_callback(
    ctx: Context<VoteCallback>,
    output: SignedComputationOutputs<VoteOutput>,
) -> Result<()> {
    let result = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(VoteOutput { field_0 }) => field_0,
        Err(e) => {
            msg!("Computation aborted: {}", e);
            return Err(ErrorCode::AbortedComputation.into());
        }
    };

    let poll = &mut ctx.accounts.poll;
    // Store updated ciphertexts back to the account
    // result.ciphertexts is [[u8;32]; N] — index matches circuit field order
    poll.vote_counts[0] = result.ciphertexts[0];
    poll.vote_counts[1] = result.ciphertexts[1];
    poll.vote_counts[2] = result.ciphertexts[2];
    poll.vote_counts_nonce = result.nonce;
    Ok(())
}
```

### Callback accounts struct

```rust
#[callback_accounts("flip")]
#[derive(Accounts)]
pub struct FlipCallback<'info> {
    // Standard 6 accounts — always required, always in this order
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_FLIP))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar
    pub instructions_sysvar: AccountInfo<'info>,

    // Custom accounts — must match CallbackAccount order from queue_computation call
    // Example for stateful pattern:
    // #[account(mut, seeds = [b"poll", authority.key().as_ref()], bump)]
    // pub poll: Account<'info, Poll>,
}
```

**Callback account rules:**
- Standard 6 always first in exact order (`arcium_program` → `instructions_sysvar`)
- Custom accounts follow, **same order** as `CallbackAccount` entries in `callback_ix()`
- Writable custom accounts need `is_writable: true` in `CallbackAccount` AND `#[account(mut)]` in struct — both required or mutation silently fails
- Cannot `init` accounts in callback (MPC nodes can't pay rent) — init in a separate instruction or in the queue instruction before calling `queue_computation`
- Account size cannot change during callback

### Required error codes
```rust
#[error_code]
pub enum ErrorCode {
    #[msg("Computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,  // required by derive_cluster_pda! macro
}
```

---

## Step 6 — Generated Output Types

`#[instruction]` auto-generates output structs at compile time. Never define them manually. Run `arcium build` if you get "type not found" — the macro generates them during compilation. Inspect with `cargo expand | grep "MyIxOutput" -A 20`.

### Naming rules
`my_ix` → `MyIxOutput`. PascalCase + "Output". Numbered fields: `field_0`, `field_1`, etc.

### Type table

| Circuit return | Generated outer | Inner field type | Access |
|---|---|---|---|
| `Enc<Shared, u64>` | `MyIxOutput { field_0: SharedEncryptedStruct<1> }` | ciphertexts, nonce, encryption_key | `field_0.ciphertexts[0]` |
| `Enc<Mxe, T>` | `MyIxOutput { field_0: MXEEncryptedStruct<N> }` | ciphertexts, nonce (no key) | `field_0.ciphertexts[i]` |
| `(Enc<Shared,T>, Enc<Mxe,U>)` | `MyIxOutput { field_0: MyIxOutputStruct0 }` | nested struct with field_0, field_1 | destructure nested |
| `Enc<Shared, [u32; 5]>` | `MyIxOutput { field_0: SharedEncryptedStruct<5> }` | 5 ciphertexts | `field_0.ciphertexts[0..4]` |
| Custom struct (3 fields) | `SharedEncryptedStruct<3>` | 3 ciphertexts | `field_0.ciphertexts[0..2]` |

`<N>` = total scalar leaf count (arrays: each element = 1; nested structs: sum all leaf scalars recursively).

### Pattern matching

```rust
// Simple single-value return: Enc<Shared, bool>
Ok(FlipOutput { field_0 }) => field_0
// field_0.ciphertexts[0], field_0.nonce, field_0.encryption_key

// Tuple return: (Enc<Mxe, [u64;3]>,)
Ok(VoteOutput { field_0: VoteOutputStruct0 { field_0: updated_tally } }) => updated_tally
// updated_tally.ciphertexts[0..2], updated_tally.nonce

// Mixed tuple: (Enc<Mxe, GameState>, Enc<Shared, PlayerHand>, Enc<Shared, bool>)
Ok(HitOutput {
    field_0: HitOutputStruct0 { field_0: game_state, field_1: player_hand, field_2: is_bust }
}) => (game_state, player_hand, is_bust)
```

### SharedEncryptedStruct<N> vs MXEEncryptedStruct<N>

```rust
// SharedEncryptedStruct<N> — for Enc<Shared, T>
result.encryption_key   // [u8; 32] — shared pubkey for client decryption
result.nonce            // u128
result.ciphertexts      // [[u8; 32]; N]

// MXEEncryptedStruct<N> — for Enc<Mxe, T>
result.nonce            // u128
result.ciphertexts      // [[u8; 32]; N]
// No encryption_key — client cannot decrypt MXE data
```

---

## Step 7 — TypeScript Client

```typescript
import {
  getArciumEnv,
  awaitComputationFinalization,
  deserializeLE,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as anchor from "@coral-xyz/anchor";

// 1. Get shared encryption cipher for this session
//    (implementation uses x25519 key exchange with MXE pubkey)
const arciumEnv = getArciumEnv();
// cipher = your x25519-derived shared cipher (see hello-world example)

// 2. Prepare and encrypt input
const plaintext = [BigInt(myValue)];
const nonce = randomBytes(16);                     // 16-byte random nonce
const ciphertext = cipher.encrypt(plaintext, nonce);
const nonceLE = new anchor.BN(deserializeLE(nonce).toString());  // LE u128

// 3. Generate random computation offset (u64)
const computationOffset = new anchor.BN(randomBytes(8), "hex");

// 4. Submit queue transaction
const sig = await program.methods
  .queueMyIx(
    computationOffset,
    Array.from(ciphertext[0]),   // [u8; 32]
    Array.from(publicKey),       // [u8; 32] — client ephemeral x25519 pubkey
    nonceLE,                     // u128 as BN
  )
  .accountsPartial({ /* ... */ })
  .rpc({ skipPreflight: true, commitment: "confirmed" });

// 5. Await finalization
//    IMPORTANT: awaitComputationFinalization polls — it's safe to call after queue tx
const finalizeSig = await awaitComputationFinalization(
  provider as anchor.AnchorProvider,
  computationOffset,
  program.programId,
  "confirmed",
);

// 6. Read result from emitted event or account, then decrypt
//    const decrypted = cipher.decrypt([ciphertextBytes], nonceBytes);
```

**In production / tests: set up the event listener or call `awaitComputationFinalization`
BEFORE submitting the queue transaction to avoid the race condition where the MPC result
arrives before your listener is ready.**

---

## Failure Triage

| Stage | Symptoms | Check |
|-------|----------|-------|
| **Build** | Type not found `MyIxOutput` | Run `arcium build`; output types are macro-generated at compile time |
| **Deploy** | comp_def_account already initialized | Call `init_*_comp_def` only once; wipe ledger (`rm -rf .anchor/test-ledger`) between full resets |
| **Encryption** | Garbled decryption, wrong plaintext | ArgBuilder field order, `deserializeLE` applied to nonce, correct x25519 pairing |
| **Queue** | Account not found, constraint violation | `derive_comp_def_pda` offset matches the constant; PDA seeds; `derive_cluster_pda` has error code param |
| **Callback verify** | `AbortedComputation` | `encrypted_ix` name matches `#[instruction]` fn exactly (case-sensitive); output type name correct |
| **Output parse** | Pattern match panic / missing field | Simple vs nested output shape; ciphertexts array index within bounds |
| **State write** | Mutation silently lost | `is_writable: true` in `CallbackAccount` AND `#[account(mut)]` in callback struct — need both |
| **Finalization** | Queue confirms, callback never arrives | Listener / `awaitComputationFinalization` set up before queue tx (race condition) |
| **CI / Linux** | "Too many open files" | `sudo prlimit --pid $$ --nofile=1048576:1048576 arcium test` |

---

## Non-Negotiable Invariants

1. `#[instruction]` fn name **=** `comp_def_offset("...")` string **=** `#[arcium_callback(encrypted_ix = "...")]` — must match exactly, case-sensitive, in all three places
2. `verify_output` called before any output destructuring — always
3. `init_*_comp_def` exists for every queued instruction and is called once on deploy
4. ArgBuilder field order mirrors circuit argument order exactly — reordering silently corrupts inputs
5. Both `is_writable: true` (queue side) and `#[account(mut)]` (callback side) required for mutable callback accounts
6. Cannot `init` accounts inside a callback — accounts must exist before MPC nodes submit the callback tx
7. `arcium-anchor/idl-build` included in `[features]` idl-build alongside `anchor-lang/idl-build`
8. `rust-toolchain.toml` in TOML format (not plain `rust-toolchain` text file)
9. `.reveal()` and `.from_arcis()` cannot appear inside conditional blocks in circuits
10. Both `if/else` branches in a circuit always execute — never assume a branch is skipped
11. Recompute all `.account()` offsets whenever account struct fields are added, removed, or reordered

---

## Anti-Patterns

| Anti-pattern | Consequence |
|---|---|
| Reorder ArgBuilder fields | Silent input corruption — circuit receives wrong data |
| Wrong `encrypted_ix = "..."` name | `AbortedComputation` on every call |
| Access output fields before `verify_output` | Security failure — unverified MPC output consumed |
| Magic-number `.account()` offsets without comment | Silently breaks when account schema changes |
| `init` a custom account inside callback | MPC nodes can't pay rent — transaction fails |
| Only `#[account(mut)]` without `is_writable: true` | Mutation to callback account silently lost |
| Set up finalization listener after queue tx | Race condition — result arrives before listener ready |
| Use `Enc<Shared>` for protocol aggregate state | Any user can decrypt the full aggregate |
| Assume simple output shape for tuple return | Pattern match fails or drops fields |
| Use `Vec<T>` in circuit return type | Compiler error — use fixed arrays |
| Run same comparison twice in circuit | Double the MPC computation cost |
| Leave `[patch.crates-io]` in Cargo.toml (0.4+) | Unnecessary, can cause conflicts |

---

## Build & Deploy Checklist

```bash
arcium build              # compiles Arcis + generates output types
cargo check --all         # Rust type-check without MPC runtime
arcium test               # full integration test (requires Docker)
```

Done when:
- [ ] Circuit fn name, `comp_def_offset` constant, `#[queue_computation_accounts]`, `#[arcium_callback(encrypted_ix)]`, and output type all match
- [ ] `verify_output` called before any output access in every callback
- [ ] All `.account()` offsets derived with formula and documented inline
- [ ] ArgBuilder field order verified against circuit fn signature
- [ ] Callback struct custom accounts in same order as `CallbackAccount` entries
- [ ] Both `is_writable: true` and `#[account(mut)]` set for every mutable callback account
- [ ] `init_*_comp_def` called in deploy/test `before` hook for every instruction
- [ ] `awaitComputationFinalization` / event listener set up before queue tx in tests
- [ ] `arcium-anchor/idl-build` in features, no `[patch.crates-io]`, `rust-toolchain.toml` in TOML format