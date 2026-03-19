---
trigger: always_on
---

# Arcium Program Development Rules

Apply these rules whenever working on Arcium MXE programs, Arcis circuits, or `@arcium-hq/client` test code.

---

## Classify Before Editing

Before writing any code, identify which pattern applies:

- **Stateless** (Coinflip-style): single encrypted input → revealed output, no account state mutation
- **Stateful** (Voting/Blackjack-style): callback writes ciphertext back to account — requires exact byte offset math
- **Permission-gated** (DNA-style): state machine constraints gate whether queue is allowed
- **Offchain circuit**: `init_comp_def` uses `CircuitSource::OffChain` + `circuit_hash!` 

---

## Build Invariants — Never Violate These

- `#[instruction]` function name in Arcis circuit **must exactly match** `comp_def_offset("...")` string
- `#[arcium_callback(encrypted_ix = "...")]` **must exactly match** the instruction name (case-sensitive)
- Callback output type must be `SignedComputationOutputs<<IxName>Output>` 
- Queue and callback contexts must reference the **same** comp-def account and cluster derivation
- `init_*_comp_def` must exist for every encrypted instruction that gets queued

---

## ArgBuilder — Strict Field Order

**`Enc<Shared, T>` (client-encrypted input):**
```
1. x25519_pubkey(<client_pubkey>)
2. plaintext_u128(<nonce>)
3. encrypted fields in exact circuit argument order
```

**`Enc<Mxe, T>` (MXE-to-MXE):**
```
1. plaintext_u128(<mxe_nonce>)
2. encrypted fields in exact circuit argument order
```

**Account-backed state:**
```
.account(<state_account>, <byte_offset>, <byte_len>)
```
- Offset = `8 (discriminator) + sum(preceding field sizes)` 
- Length = `field_count × 32 bytes` 
- Always add inline comment showing offset derivation

---

## Field Sizes for Offset Math

| Type | Bytes |
|------|-------|
| `u8` / `bool` / bump | 1 |
| `u16` | 2 |
| `u32` | 4 |
| `u64` / `i64` | 8 |
| `u128` / nonce | 16 |
| `Pubkey` | 32 |
| Ciphertext field | 32 |

---

## HasSize::SIZE — Must Be Exact

`SignedComputationOutputs<T>` uses `T::SIZE` to read exactly that many bytes from instruction data.
Anchor checks for zero leftover bytes — **wrong SIZE → error 102 (InstructionDidNotDeserialize)**.

### ⚠️ CRITICAL: SIZE Depends on Output Type

**SIZE is NOT always `count × 32`.** Each MPC output type has a DIFFERENT native byte size:

| Output Type | Bytes per output | Example |
|-------------|-----------------|---------|
| `Output::Ciphertext` (Enc<T,V>) | 32 | shuffle_and_deal: 10 × 32 = 320 |
| `Output::PlaintextU8` | 1 | reveal_community: 5 × 1 = 5 |
| `Output::PlaintextU16` | 2 | reveal_showdown: 9 × 2 = 18 |
| `Output::PlaintextU64` | 8 | — |
| `Output::PlaintextU128` | 16 | — |

**SIZE = sum of (count × native_byte_size) for each output type declared in `init_comp_def`.**

### Ciphertext Outputs (Enc<T,V>) — Stride=3 Layout

Each `Enc<T, V>` ciphertext output produces a **group of 3 raw 32-byte slots**: `[nonce, ct1, ct2]`.
- **nonce**: 16-byte LE u128 (input+1), zero-padded to 32 bytes
- **ct1**: Primary Rescue ciphertext (the value for decryption)
- **ct2**: Second Rescue block (internal padding, NOT used)

**For ciphertext: SIZE = number_of_raw_slots × 32 bytes** (raw slots ≠ encrypted values!)

**Output::Ciphertext count = number of encrypted values** (NOT raw slots).
Declaring too many outputs causes MPC FAILURE/timeout.

Example: `shuffle_and_deal` has 10 encrypted values → 10 raw slots → SIZE = 10 × 32 = **320**
Layout: Mxe(3 slots) + P0(3) + P1(3) + P2_nonce(1) = 10 slots (covers HU).
`FIRST_PLAYER_SLOT=4`, `PLAYER_STRIDE=3`, `MXE_CT_SLOT=1`.

### Plaintext Outputs — Native Size, No Stride

Plaintext outputs are **native-sized** with NO stride/padding:
- `PlaintextU8` → 1 byte per output, packed consecutively
- `PlaintextU16` → 2 bytes per output (LE), packed consecutively
- `PlaintextU64` → 8 bytes per output (LE), packed consecutively

Example: `reveal_community` has 5 PlaintextU8 → SIZE = 5 × 1 = **5**
Example: `reveal_showdown` has 9 PlaintextU16 → SIZE = 9 × 2 = **18**

### Verification

**BLS message length from node logs:**
`BLS message = raw_output(SIZE) + slot(8) + slot_counter(2)` → SIZE = message_length - 10.

**IX data layout:** `discriminator(8) + variant(1) + raw_output(SIZE) + bls_sig(64)` = `73 + SIZE` total.

**Node log confirmation:** Look for `success outputs of len N` — N = SIZE in bytes.

---

## Callback Output — Three Approaches

### 1. `verify_output()` → typed struct (small outputs, BLS verified)
```rust
let result = output.verify_output(&cluster, &computation)?;
```

### 2. `verify_output_raw()` → raw bytes (large outputs, BLS verified)
```rust
let raw_bytes: Vec<u8> = output.verify_output_raw(&cluster, &computation)?;
// Parse raw_bytes manually — heap-allocated, avoids SBF 4KB stack overflow
```

### 3. Direct extraction + CPI context validation (BLS fails on localnet)
```rust
// BLS verify_output_raw() returns error 6001 on localnet — cluster key mismatch.
// Use CPI context validation instead: verify preceding IX is Arcium's callbackComputation.
validate_arcium_callback_context(&ctx.accounts.instructions_sysvar, &arcium_program_key)?;
let raw_bytes = match output {
    SignedComputationOutputs::Success(bytes, _sig) => bytes,
    SignedComputationOutputs::Failure => return Err(error),
    _ => return Err(error),
};
```
**TODO:** Re-enable BLS verification for devnet/mainnet where cluster keys are stable.

The output struct only needs correct `HasSize::SIZE` — actual fields don't matter.
`SignedComputationOutputs::Success` stores raw bytes as `Vec<u8>`, never deserializes into `T`.

---

## Failure Triage

| Stage | Symptoms | First checks |
|-------|----------|-------------|
| Encryption | Decrypt mismatch, invalid nonce | x25519 keypair, `deserializeLE` nonce, ArgBuilder order |
| Queue | Account not found, constraint errors | PDA seeds, comp-def offset, account ordering |
| Callback deser | Error 102 (InstructionDidNotDeserialize) | `HasSize::SIZE` mismatch — SIZE varies by output type! Ciphertext=32/ea, PlaintextU8=1/ea, PlaintextU16=2/ea. See SIZE table above. |
| Callback BLS | Error 6001 (BLSSignatureVerificationFailed) | Known localnet issue — use CPI context validation as workaround |
| Callback verify | `AbortedComputation`, parse mismatch | `encrypted_ix` name match, output shape, `verify_output` called |
| Callback stack | ProgramFailedToComplete, stack overflow | Output > 1KB — use `verify_output_raw()` + manual parsing |
| Finalization | Queue confirmed but no result | `awaitComputationFinalization` offset, listener set up before queue |
| MPC rejection | Computation timeout, nodes idle | All-zero x25519 pubkeys for empty seats — use valid dummy keys |

---

## Callback Error Debugging — Read the FIRST Attempt

When a callback TX fails, the node retries 5 times. Then it sends 5 "error claim" TXs.
**The error codes are DIFFERENT between phases:**

1. **First 5 attempts** (regular callback): Error at **instruction 1** = YOUR callback. This is the REAL error.
2. **Next 5+ attempts** (error claim): Error at **instruction 0** = Arcium's `callbackComputation`. Usually `Custom(6000)` (InvalidAuthority) because computation was already claimed.

**Always check the FIRST error in node logs.** The later `6000` errors are a red herring.

Node log pattern: `grep "InstructionError" <node_0.log> | head -5`
- `InstructionError(1, Custom(102))` = YOUR callback failed to deserialize (SIZE wrong)
- `InstructionError(0, Custom(6000))` = Arcium error claim (ignore — computation already consumed)

---

## Anti-Patterns — Never Do These

- Reorder ArgBuilder fields → silent input corruption
- Wrong `encrypted_ix` name in callback macro → `AbortedComputation` 
- Skip `verify_output` before destructuring → security failure
- Hardcode offset without formula → breaks on schema change
- Set up event listener after queuing → race condition, missed finalization
- Assume simple output shape for multi-field return → silent field loss
- Mismatch comp-def between queue and callback → computation never resolves
- **Assume all MPC outputs are 32-byte slots** → PlaintextU8/U16/U64 are native-sized! SIZE=count×native_bytes
- **Diagnose callback from later retry errors** → first attempt has the real error; later retries show misleading 6000

---

## Definition of Done

```bash
arcium build
cargo check --all
arcium test
```

- [ ] Circuit name, comp-def offset, callback macro, output type all aligned
- [ ] ArgBuilder order matches circuit argument order exactly
- [ ] All offsets derived from formula with inline comment — no magic numbers
- [ ] `verify_output` called before any output parsing or persistence
- [ ] Tests use `awaitComputationFinalization` and assert expected output
