# IDL Generation Limitation

## Problem

`anchor idl build` fails with "Safety checks failed: Failed to parse crate: could not find file". Originally caused by `session-keys` crate (removed), but persists even without it — this is a known Anchor CLI IDL builder bug with complex programs that have many instruction modules.

```
error: custom attribute panicked
  --> session-keys-3.0.10/src/lib.rs:23:1
   = help: message: Safety checks failed: Failed to parse crate: could not find file
```

This affects ALL IDL generation methods (`anchor idl build`, `arcium build`).

## Impact

- No `target/idl/fastpoker.json` generated
- No `target/types/fastpoker.ts` generated
- Cannot use `anchor.workspace.Fastpoker` in TypeScript tests

## Workaround

The original FastPoker project never used Anchor IDL either. All instructions are built manually:

1. **Instruction discriminators:** SHA256("global:<instruction_name>")[0..8]
2. **Account layouts:** Hardcoded byte offsets matching Rust struct layout
3. **PDA derivation:** Manual `PublicKey.findProgramAddressSync()` calls

The crank service (`backend/crank-service.ts`) and all test scripts use this pattern.

## Future Fix Options

1. **Upgrade session-keys** to a version compatible with Anchor 0.32.1 IDL builder
2. **Remove session-keys** and implement session tokens manually (complex)
3. **Generate IDL from a stripped program** that excludes session-keys (workaround)
4. **Use Anchor client without IDL** — build instructions manually (current approach)

## For Tests

Use the shared types from `shared/types/` and build transactions manually:

```typescript
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { sha256 } from 'js-sha256';

// Discriminator for any instruction
function getDiscriminator(name: string): Buffer {
  return Buffer.from(sha256.digest(`global:${name}`)).slice(0, 8);
}

// Example: create_table discriminator
const CREATE_TABLE_DISC = getDiscriminator('create_table');
```
