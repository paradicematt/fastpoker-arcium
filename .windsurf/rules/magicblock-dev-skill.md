---
name: magicblock
description: MagicBlock Ephemeral Rollups development patterns for Solana. Covers delegation/undelegation flows, dual-connection architecture (base layer + ER), cranks for scheduled tasks, VRF for verifiable randomness, and TypeScript/Anchor integration. Use for high-performance gaming, real-time apps, and fast transaction throughput on Solana.
user-invocable: true
---

# MagicBlock Ephemeral Rollups Skill

## What this Skill is for
Use this Skill when the user asks for:
- MagicBlock Ephemeral Rollups integration
- Delegating/undelegating Solana accounts to ephemeral rollups
- High-performance, low-latency transaction flows
- Crank scheduling (recurring automated transactions)
- VRF (Verifiable Random Function) for provable randomness
- Dual-connection architecture (base layer + ephemeral rollup)
- Gaming and real-time app development on Solana

## Key Concepts

**Ephemeral Rollups** enable high-performance, low-latency transactions by temporarily delegating Solana account ownership to an ephemeral rollup. Ideal for gaming, real-time apps, and fast transaction throughput.

**Delegation** transfers account ownership from your program to the delegation program, allowing the ephemeral rollup to process transactions at ~10-50ms latency vs ~400ms on base layer.

**Architecture**:
```
┌─────────────────┐     delegate      ┌─────────────────────┐
│   Base Layer    │ ───────────────►  │  Ephemeral Rollup   │
│    (Solana)     │                   │    (MagicBlock)     │
│                 │  ◄───────────────  │                     │
└─────────────────┘    undelegate     └─────────────────────┘
     ~400ms                                  ~10-50ms
```

## Default stack decisions (opinionated)

1) **Programs: Anchor with ephemeral-rollups-sdk**
   - Use `ephemeral-rollups-sdk` with Anchor features
   - Apply `#[ephemeral]` macro before `#[program]`
   - Use `#[delegate]` and `#[commit]` macros for delegation contexts

2) **Dual Connections**
   - Base layer connection for initialization and delegation
   - Ephemeral rollup connection for operations on delegated accounts

3) **Transaction Routing**
   - Delegate transactions → Base Layer
   - Operations on delegated accounts → Ephemeral Rollup
   - Undelegate/commit transactions → Ephemeral Rollup

## Operating procedure (how to execute tasks)

### 1. Classify the operation type
- Account initialization (base layer)
- Delegation (base layer)
- Operations on delegated accounts (ephemeral rollup)
- Commit state (ephemeral rollup)
- Undelegation (ephemeral rollup)

### 2. Pick the right connection
- Base layer: `https://api.devnet.solana.com` (or mainnet)
- Ephemeral rollup: `https://devnet.magicblock.app/`

### 3. Implement with MagicBlock-specific correctness
Always be explicit about:
- Which connection to use for each transaction
- Delegation status checks before operations
- PDA seeds matching between delegate call and account definition
- Using `skipPreflight: true` for ER transactions
- Waiting for state propagation after delegate/undelegate

### 4. Add appropriate features
- Cranks for recurring automated transactions
- VRF for verifiable randomness in games/lotteries

### 5. Deliverables expectations
When you implement changes, provide:
- Exact files changed + diffs
- Commands to install/build/test
- Risk notes for anything touching delegation/signing/state commits

## Progressive disclosure (read when needed)
- Core delegation patterns: [delegation.md](delegation.md)
- TypeScript frontend setup: [typescript-setup.md](typescript-setup.md)
- Cranks (scheduled tasks): [cranks.md](cranks.md)
- VRF (randomness): [vrf.md](vrf.md)
- Reference links & versions: [resources.md](resources.md)


---

# cranks

# Cranks (Scheduled Tasks)

Cranks enable automatic, recurring transactions on Ephemeral Rollups without external infrastructure.

## Additional Dependencies

```toml
[dependencies]
magicblock-magic-program-api = { version = "0.3.1", default-features = false }
bincode = "^1.3"
sha2 = "0.10"
```

## Crank Imports

```rust
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};
```

## Crank Arguments

```rust
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ScheduleCrankArgs {
    pub task_id: u64,                    // Unique task identifier
    pub execution_interval_millis: u64,  // Milliseconds between executions
    pub iterations: u64,                 // Number of times to execute
}
```

## Schedule Crank Instruction

```rust
pub fn schedule_my_crank(ctx: Context<ScheduleCrank>, args: ScheduleCrankArgs) -> Result<()> {
    let crank_ix = Instruction {
        program_id: crate::ID,
        accounts: vec![AccountMeta::new(ctx.accounts.my_account.key(), false)],
        data: anchor_lang::InstructionData::data(&crate::instruction::MyCrankInstruction {}),
    };

    let ix_data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
        task_id: args.task_id,
        execution_interval_millis: args.execution_interval_millis,
        iterations: args.iterations,
        instructions: vec![crank_ix],
    })).map_err(|_| ProgramError::InvalidArgument)?;

    let schedule_ix = Instruction::new_with_bytes(
        MAGIC_PROGRAM_ID,
        &ix_data,
        vec![
            AccountMeta::new(ctx.accounts.payer.key(), true),
            AccountMeta::new(ctx.accounts.my_account.key(), false),
        ],
    );

    invoke_signed(&schedule_ix, &[
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.my_account.to_account_info(),
    ], &[])?;

    Ok(())
}
```

## Client-Side Crank Scheduling

```typescript
import { MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

// CRITICAL: Send to Ephemeral Rollup (not base layer)
const tx = await program.methods
  .scheduleMyCrank({
    taskId: new BN(1),
    executionIntervalMillis: new BN(100),
    iterations: new BN(10),
  })
  .accounts({
    magicProgram: MAGIC_PROGRAM_ID,
    payer: erProvider.wallet.publicKey,
    program: program.programId,
  })
  .transaction();
```

## Key Points

- Cranks run automatically on the Ephemeral Rollup
- No external infrastructure needed (no servers, no cron jobs)
- Schedule transactions must be sent to the Ephemeral Rollup, not base layer
- `task_id` must be unique per scheduled task
- `execution_interval_millis` controls timing between executions
- `iterations` controls how many times the task runs


---

# delegation

# Delegation Patterns (Rust Programs)

## Rust Program Setup

### Dependencies

```toml
# Cargo.toml
[dependencies]
anchor-lang = { version = "0.32.1", features = ["init-if-needed"] }
ephemeral-rollups-sdk = { version = "0.6.5", features = ["anchor", "disable-realloc"] }
```

### Imports

```rust
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};
```

### Program Macros

```rust
#[ephemeral]  // REQUIRED: Add before #[program]
#[program]
pub mod my_program {
    // ...
}
```

## Delegate Instruction

```rust
pub fn delegate(ctx: Context<DelegateInput>, uid: String) -> Result<()> {
    // Method name is `delegate_<field_name>` based on the account field
    ctx.accounts.delegate_my_account(
        &ctx.accounts.payer,
        &[b"seed", uid.as_bytes()],  // PDA seeds
        DelegateConfig::default(),
    )?;
    Ok(())
}

#[delegate]  // Adds delegation accounts automatically
#[derive(Accounts)]
#[instruction(uid: String)]
pub struct DelegateInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The PDA to delegate
    #[account(mut, del, seeds = [b"seed", uid.as_bytes()], bump)]
    pub my_account: AccountInfo<'info>,  // Use AccountInfo with `del` constraint
}
```

## Undelegate Instruction

```rust
pub fn undelegate(ctx: Context<Undelegate>) -> Result<()> {
    commit_and_undelegate_accounts(
        &ctx.accounts.payer,
        vec![&ctx.accounts.my_account.to_account_info()],
        &ctx.accounts.magic_context,
        &ctx.accounts.magic_program,
    )?;
    Ok(())
}

#[commit]  // Adds magic_context and magic_program automatically
#[derive(Accounts)]
pub struct Undelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub my_account: Account<'info, MyAccount>,
}
```

## Commit Without Undelegating

```rust
pub fn commit(ctx: Context<CommitState>) -> Result<()> {
    commit_accounts(
        &ctx.accounts.payer,
        vec![&ctx.accounts.my_account.to_account_info()],
        &ctx.accounts.magic_context,
        &ctx.accounts.magic_program,
    )?;
    Ok(())
}
```

## Common Gotchas

### Method Name Convention
The delegate method is auto-generated as `delegate_<field_name>`:
```rust
pub my_account: AccountInfo<'info>,  // => ctx.accounts.delegate_my_account()
```

### PDA Seeds Must Match
Seeds in delegate instruction must exactly match account definition:
```rust
#[account(mut, del, seeds = [b"tomo", uid.as_bytes()], bump)]
pub tomo: AccountInfo<'info>,

// Delegate call - seeds must match
ctx.accounts.delegate_tomo(&payer, &[b"tomo", uid.as_bytes()], config)?;
```

### Account Owner Changes on Delegation
```
Not delegated: account.owner == YOUR_PROGRAM_ID
Delegated:     account.owner == DELEGATION_PROGRAM_ID
```

## Best Practices

### Do's
- Always use `skipPreflight: true` - Faster transactions, ER handles validation
- Use dual connections - Base layer for delegate, ER for operations/undelegate
- Verify delegation status - Check `accountInfo.owner.equals(DELEGATION_PROGRAM_ID)`
- Wait for state propagation - Add a 3 second sleep after delegate/undelegate in tests before proceeding to the next step
- Use `GetCommitmentSignature` - Verify commits reached base layer

### Don'ts
- Don't send delegate tx to ER - Delegation always goes to base layer
- Don't send operations to base layer - Delegated account ops go to ER
- Don't forget the `#[ephemeral]` macro - Required on program module
- Don't use `Account<>` in delegate context - Use `AccountInfo` with `del` constraint
- Don't skip the `#[commit]` macro - Required for undelegate context


---

# resources

# Resources & Reference

## Environment Variables

```bash
EPHEMERAL_PROVIDER_ENDPOINT=https://devnet.magicblock.app/
EPHEMERAL_WS_ENDPOINT=wss://devnet.magicblock.app/
ROUTER_ENDPOINT=https://devnet-router.magicblock.app/
WS_ROUTER_ENDPOINT=wss://devnet-router.magicblock.app/
```

## Version Requirements

| Software | Version |
|----------|---------|
| Solana | 2.3.13 |
| Rust | 1.85.0 |
| Anchor | 0.32.1 |
| Node | 24.10.0 |

## Key Program IDs

| Program | Address |
|---------|---------|
| Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Magic Program | `Magic11111111111111111111111111111111111111` |
| Magic Context | `MagicContext1111111111111111111111111111111` |
| Localnet Validator | `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev` |

## Rust Dependencies

```toml
[dependencies]
anchor-lang = { version = "0.32.1", features = ["init-if-needed"] }
ephemeral-rollups-sdk = { version = "0.6.5", features = ["anchor", "disable-realloc"] }

# For cranks
magicblock-magic-program-api = { version = "0.3.1", default-features = false }
bincode = "^1.3"
sha2 = "0.10"

# For VRF
ephemeral-vrf-sdk = { version = "0.2.1", features = ["anchor"] }
```

## NPM Dependencies

```json
{
  "dependencies": {
    "@coral-xyz/anchor": "^0.32.1",
    "@magicblock-labs/ephemeral-rollups-sdk": "^0.6.5"
  }
}
```

## Documentation Links

- [MagicBlock Documentation](https://docs.magicblock.gg/)
- [MagicBlock Engine Examples](https://github.com/magicblock-labs/magicblock-engine-examples)
- [Ephemeral Rollups SDK (Rust)](https://crates.io/crates/ephemeral-rollups-sdk)
- [Ephemeral VRF SDK (Rust)](https://crates.io/crates/ephemeral-vrf-sdk)
- [NPM Package](https://www.npmjs.com/package/@magicblock-labs/ephemeral-rollups-sdk)


---

# typescript-setup

# TypeScript Frontend Setup

## Dependencies

```json
{
  "dependencies": {
    "@coral-xyz/anchor": "^0.32.1",
    "@magicblock-labs/ephemeral-rollups-sdk": "^0.6.5"
  }
}
```

## Imports

```typescript
import {
  DELEGATION_PROGRAM_ID,
  GetCommitmentSignature,
} from "@magicblock-labs/ephemeral-rollups-sdk";
```

## Dual Connections

```typescript
// Base layer connection (Solana devnet/mainnet)
const baseConnection = new Connection("https://api.devnet.solana.com");

// Ephemeral rollup connection
const erConnection = new Connection(
  process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet.magicblock.app/",
  { wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet.magicblock.app/" }
);
```

## Transaction Flow Summary

| Action | Send To | Provider |
|--------|---------|----------|
| Initialize account | Base Layer | `provider` |
| Delegate | Base Layer | `provider` |
| Operations on delegated | Ephemeral Rollup | `providerER` |
| Commit (keep delegated) | Ephemeral Rollup | `providerER` |
| Undelegate | Ephemeral Rollup | `providerER` |

## Check Delegation Status

```typescript
function checkIsDelegated(accountOwner: PublicKey): boolean {
  return accountOwner.equals(DELEGATION_PROGRAM_ID);
}

const accountInfo = await connection.getAccountInfo(pda);
const isDelegated = checkIsDelegated(accountInfo.owner);
```

## Delegate Transaction (Base Layer)

```typescript
async function buildDelegateTx(payer: PublicKey, uid: string): Promise<Transaction> {
  const instruction = await program.methods
    .delegate(uid)
    .accounts({ payer })
    .instruction();

  const tx = new Transaction().add(instruction);
  tx.feePayer = payer;
  return tx;
}

// Send to BASE LAYER
const txHash = await baseProvider.sendAndConfirm(tx, [], {
  skipPreflight: true,
  commitment: "confirmed",
});
```

## Execute on Delegated Account (Ephemeral Rollup)

```typescript
let tx = await program.methods
  .myInstruction()
  .accounts({ myAccount: pda })
  .transaction();

// CRITICAL: Use ephemeral rollup connection
tx.feePayer = erProvider.wallet.publicKey;
tx.recentBlockhash = (await erConnection.getLatestBlockhash()).blockhash;
tx = await erProvider.wallet.signTransaction(tx);

const txHash = await erProvider.sendAndConfirm(tx, [], { skipPreflight: true });
```

## Undelegate Transaction (Ephemeral Rollup)

```typescript
async function buildUndelegateTx(payer: PublicKey, pda: PublicKey): Promise<Transaction> {
  const instruction = await program.methods
    .undelegate()
    .accounts({
      payer,
      myAccount: pda,
      magicProgram: new PublicKey("Magic11111111111111111111111111111111111111"),
      magicContext: new PublicKey("MagicContext1111111111111111111111111111111"),
    })
    .instruction();

  const tx = new Transaction().add(instruction);
  tx.feePayer = payer;
  return tx;
}

// Send to EPHEMERAL ROLLUP
const txHash = await erProvider.sendAndConfirm(tx, [], { skipPreflight: true });

// Wait for commitment on base layer
const commitTxHash = await GetCommitmentSignature(txHash, erConnection);
```

## Key Program IDs

```typescript
const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
const LOCALNET_VALIDATOR = new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");
```

## Localnet Requires Validator Identity

```typescript
const remainingAccounts = endpoint.includes("localhost")
  ? [{ pubkey: LOCALNET_VALIDATOR, isSigner: false, isWritable: false }]
  : [];
```

## React Native Buffer Issues

Anchor's `program.account.xxx.fetch()` may fail in React Native. Manually decode:

```typescript
const accountInfo = await connection.getAccountInfo(pda);
const isDelegated = accountInfo.owner.equals(DELEGATION_PROGRAM_ID);
const data = manuallyDecodeAccount(accountInfo.data);
```


---

# vrf

# VRF (Verifiable Random Function)

VRF provides provably fair randomness for games, lotteries, and any application requiring verifiable randomness.

## Additional Dependencies

```toml
[dependencies]
ephemeral-vrf-sdk = { version = "0.2.1", features = ["anchor"] }
```

## VRF Imports

```rust
use ephemeral_vrf_sdk::anchor::vrf;
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;
```

## Request Randomness

```rust
pub fn request_randomness(ctx: Context<RequestRandomnessCtx>, client_seed: u8) -> Result<()> {
    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.payer.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: ID,
        callback_discriminator: instruction::ConsumeRandomness::DISCRIMINATOR.to_vec(),
        caller_seed: [client_seed; 32],
        accounts_metas: Some(vec![SerializableAccountMeta {
            pubkey: ctx.accounts.my_account.key(),
            is_signer: false,
            is_writable: true,
        }]),
        ..Default::default()
    });

    ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
    Ok(())
}

#[vrf]  // Required macro for VRF interactions
#[derive(Accounts)]
pub struct RequestRandomnessCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [MY_SEED, payer.key().to_bytes().as_slice()], bump)]
    pub my_account: Account<'info, MyAccount>,
    /// CHECK: Oracle queue
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}
```

## Consume Randomness Callback

```rust
pub fn consume_randomness(ctx: Context<ConsumeRandomnessCtx>, randomness: [u8; 32]) -> Result<()> {
    let random_value = ephemeral_vrf_sdk::rnd::random_u8_with_range(&randomness, 1, 6);
    ctx.accounts.my_account.last_random = random_value;
    Ok(())
}

#[derive(Accounts)]
pub struct ConsumeRandomnessCtx<'info> {
    /// SECURITY: Validates callback is from VRF program
    #[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub my_account: Account<'info, MyAccount>,
}
```

## Oracle Queue Constants

| Constant | Use Case |
|----------|----------|
| `DEFAULT_QUEUE` | Non-delegated programs (base layer) |
| `DEFAULT_EPHEMERAL_QUEUE` | Delegated programs (ephemeral rollup) |

## Key Points

- VRF provides cryptographically verifiable randomness
- The callback pattern ensures randomness is delivered asynchronously
- Always validate `vrf_program_identity` signer in the callback to prevent spoofed randomness
- Use `DEFAULT_EPHEMERAL_QUEUE` for delegated accounts on the ephemeral rollup
- Use `DEFAULT_QUEUE` for non-delegated accounts on the base layer
- `caller_seed` can be used to add entropy from the client side


