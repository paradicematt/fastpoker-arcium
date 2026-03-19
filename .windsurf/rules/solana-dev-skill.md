---
name: solana-dev
description: End-to-end Solana development playbook (Jan 2026). Prefer Solana Foundation framework-kit (@solana/client + @solana/react-hooks) for React/Next.js UI. Prefer @solana/kit for all new client/RPC/transaction code. When legacy dependencies require web3.js, isolate it behind @solana/web3-compat (or @solana/web3.js as a true legacy fallback). Covers wallet-standard-first connection (incl. ConnectorKit), Anchor/Pinocchio programs, Codama-based client generation, LiteSVM/Mollusk/Surfpool testing, and security checklists.
user-invocable: true
---

# Solana Development Skill (framework-kit-first)

## What this Skill is for
Use this Skill when the user asks for:
- Solana dApp UI work (React / Next.js)
- Wallet connection + signing flows
- Transaction building / sending / confirmation UX
- On-chain program development (Anchor or Pinocchio)
- Client SDK generation (typed program clients)
- Local testing (LiteSVM, Mollusk, Surfpool)
- Security hardening and audit-style reviews
- Confidential transfers (Token-2022 ZK extension)
- **Toolchain setup, version mismatches, GLIBC errors, dependency conflicts**
- **Upgrading Anchor/Solana CLI versions, migration between versions**

## Default stack decisions (opinionated)
1) **UI: framework-kit first**
- Use `@solana/client` + `@solana/react-hooks`.
- Prefer Wallet Standard discovery/connect via the framework-kit client.

2) **SDK: @solana/kit first**
- Prefer Kit types (`Address`, `Signer`, transaction message APIs, codecs).
- Prefer `@solana-program/*` instruction builders over hand-rolled instruction data.

3) **Legacy compatibility: web3.js only at boundaries**
- If you must integrate a library that expects web3.js objects (`PublicKey`, `Transaction`, `Connection`),
  use `@solana/web3-compat` as the boundary adapter.
- Do not let web3.js types leak across the entire app; contain them to adapter modules.

4) **Programs**
- Default: Anchor (fast iteration, IDL generation, mature tooling).
- Performance/footprint: Pinocchio when you need CU optimization, minimal binary size,
  zero dependencies, or fine-grained control over parsing/allocations.

5) **Testing**
- Default: LiteSVM or Mollusk for unit tests (fast feedback, runs in-process).
- Use Surfpool for integration tests against realistic cluster state (mainnet/devnet) locally.
- Use solana-test-validator only when you need specific RPC behaviors not emulated by LiteSVM.

## Operating procedure (how to execute tasks)
When solving a Solana task:

### 1. Classify the task layer
- UI/wallet/hook layer
- Client SDK/scripts layer
- Program layer (+ IDL)
- Testing/CI layer
- Infra (RPC/indexing/monitoring)

### 2. Pick the right building blocks
- UI: framework-kit patterns.
- Scripts/backends: @solana/kit directly.
- Legacy library present: introduce a web3-compat adapter boundary.
- High-performance programs: Pinocchio over Anchor.

### 3. Implement with Solana-specific correctness
Always be explicit about:
- cluster + RPC endpoints + websocket endpoints
- fee payer + recent blockhash
- compute budget + prioritization (where relevant)
- expected account owners + signers + writability
- token program variant (SPL Token vs Token-2022) and any extensions

### 4. Add tests
- Unit test: LiteSVM or Mollusk.
- Integration test: Surfpool.
- For "wallet UX", add mocked hook/provider tests where appropriate.

### 5. Deliverables expectations
When you implement changes, provide:
- exact files changed + diffs (or patch-style output)
- commands to install/build/test
- a short "risk notes" section for anything touching signing/fees/CPIs/token transfers

## Progressive disclosure (read when needed)
- UI + wallet + hooks: [frontend-framework-kit.md](frontend-framework-kit.md)
- Kit ↔ web3.js boundary: [kit-web3-interop.md](kit-web3-interop.md)
- Anchor programs: [programs-anchor.md](programs-anchor.md)
- Pinocchio programs: [programs-pinocchio.md](programs-pinocchio.md)
- Testing strategy: [testing.md](testing.md)
- IDLs + codegen: [idl-codegen.md](idl-codegen.md)
- Payments: [payments.md](payments.md)
- Confidential transfers: [confidential-transfers.md](confidential-transfers.md)
- Security checklist: [security.md](security.md)
- Reference links: [resources.md](resources.md)
- **Version compatibility:** [compatibility-matrix.md](compatibility-matrix.md)
- **Common errors & fixes:** [common-errors.md](common-errors.md)
- **Surfpool (local network):** [surfpool.md](surfpool.md)
- **Surfpool cheatcodes:** [surfpool-cheatcodes.md](surfpool-cheatcodes.md)


---

# common-errors

# Common Solana Development Errors & Solutions

## GLIBC Errors

### `GLIBC_2.39 not found` / `GLIBC_2.38 not found`
```
anchor: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by anchor)
```

**Cause:** Anchor 0.31+ binaries are built on newer Linux and require GLIBC ≥2.38. Anchor 0.32+ requires ≥2.39.

**Solutions (pick one):**
1. **Upgrade OS** (best): Ubuntu 24.04+ has GLIBC 2.39
2. **Build from source:**
   ```bash
   # For Anchor 0.31.x:
   cargo install --git https://github.com/solana-foundation/anchor --tag v0.31.1 anchor-cli
   
   # For Anchor 0.32.x:
   cargo install --git https://github.com/solana-foundation/anchor --tag v0.32.1 anchor-cli
   ```
3. **Use Docker:**
   ```bash
   docker run -v $(pwd):/workspace -w /workspace solanafoundation/anchor:0.31.1 anchor build
   ```
4. **Use AVM with source build:**
   ```bash
   avm install 0.31.1 --from-source
   ```

---

## Rust / Cargo Errors

### `anchor-cli` fails to install with Rust 1.80 (`time` crate issue)
```
error[E0635]: unknown feature `proc_macro_span_shrink`
 --> .cargo/registry/src/.../time-macros-0.2.16/src/lib.rs
```

**Cause:** Anchor 0.30.x uses a `time` crate version incompatible with Rust ≥1.80 ([anchor#3143](https://github.com/coral-xyz/anchor/pull/3143)).

**Solutions:**
1. **Use AVM** — it auto-selects `rustc 1.79.0` for Anchor < 0.31 ([anchor#3315](https://github.com/coral-xyz/anchor/pull/3315))
2. **Pin Rust version:**
   ```bash
   rustup install 1.79.0
   rustup default 1.79.0
   cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --locked
   ```
3. **Upgrade to Anchor 0.31+** which fixes this issue

### `unexpected_cfgs` warnings flooding build output
```
warning: unexpected `cfg` condition name: `feature`
```

**Cause:** Newer Rust versions (1.80+) are stricter about `cfg` conditions.

**Solution:** Add to your program's `Cargo.toml`:
```toml
[lints.rust]
unexpected_cfgs = { level = "allow" }
```
Or upgrade to Anchor 0.31+ which handles this.

### `error[E0603]: module inner is private`
**Cause:** Version mismatch between `anchor-lang` crate and Anchor CLI.

**Solution:** Ensure `anchor-lang` in Cargo.toml matches your `anchor --version`.

---

## Build Errors

### `cargo build-sbf` not found
```
error: no such command: `build-sbf`
```

**Cause:** Solana CLI not installed, or PATH not set.

**Solutions:**
1. Install Solana CLI: `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`
2. Add to PATH: `export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"`
3. Verify: `solana --version`

### `cargo build-bpf` is deprecated
```
Warning: cargo-build-bpf is deprecated. Use cargo-build-sbf instead.
```

**Cause:** As of Anchor 0.30.0, `cargo build-sbf` is the default. BPF target is deprecated in favor of SBF.

**Solution:** This is just a warning if you're using older tooling. Anchor 0.30+ handles this automatically. If calling manually, use `cargo build-sbf`.

### Platform tools download failure
```
Error: Failed to download platform-tools
```
or
```
error: could not compile `solana-program`
```

**Solutions:**
1. **Clear cache and retry:**
   ```bash
   rm -rf ~/.cache/solana/
   cargo build-sbf
   ```
2. **Manual platform tools install:**
   ```bash
   # Check which version you need
   solana --version
   # Download manually from:
   # https://github.com/anza-xyz/platform-tools/releases
   ```
3. **Check disk space** (see "No space left" error below)

### `anchor build` IDL generation fails
```
Error: IDL build failed
```
or
```
BPF SDK: /home/user/.local/share/solana/install/releases/2.1.7/solana-release/bin/sdk/sbf
Error: Function _ZN5anchor...
```

**Solutions:**
1. **Ensure `idl-build` feature is enabled (required since 0.30.0):**
   ```toml
   [features]
   default = []
   idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]
   ```
2. **Set ANCHOR_LOG for debugging:**
   ```bash
   ANCHOR_LOG=1 anchor build
   ```
3. **Skip IDL generation:**
   ```bash
   anchor build --no-idl
   ```
4. **Check for nightly Rust interference:**
   ```bash
   # IDL generation uses proc-macro2 which may need nightly features
   # Override with stable:
   RUSTUP_TOOLCHAIN=stable anchor build
   ```

### `anchor build` error with `proc_macro2` / `local_file` method not found
```
error[E0599]: no method named `local_file` found for struct `proc_macro2::Span`
```

**Cause:** proc-macro2 API change in newer nightly Rust.

**Solutions:**
1. Upgrade to Anchor 0.31.1+ (fixed in [#3663](https://github.com/solana-foundation/anchor/pull/3663))
2. Use stable Rust: `RUSTUP_TOOLCHAIN=stable anchor build`
3. Pin proc-macro2: `cargo update -p proc-macro2 --precise 1.0.86`

---

## Installation Errors

### `No space left on device` during Solana install
```
error: No space left on device (os error 28)
```

**Cause:** Solana CLI + platform tools can use 2-5 GB. Multiple versions compound this.

**Solutions:**
1. **Clean old versions:**
   ```bash
   # List installed versions
   ls ~/.local/share/solana/install/releases/
   
   # Remove old ones (keep only what you need)
   rm -rf ~/.local/share/solana/install/releases/1.16.*
   rm -rf ~/.local/share/solana/install/releases/1.17.*
   
   # Also clean cache
   rm -rf ~/.cache/solana/
   ```
2. **Clean Cargo/Rust caches:**
   ```bash
   cargo cache --autoclean  # if cargo-cache is installed
   # or manually:
   rm -rf ~/.cargo/registry/cache/
   rm -rf target/
   ```
3. **Clean AVM:**
   ```bash
   ls ~/.avm/bin/
   # Remove unused anchor versions
   ```

### `agave-install` not found
```
error: agave-install: command not found
```

**Cause:** Anchor CLI 0.31+ migrates to `agave-install` for Solana versions ≥1.18.19.

**Solution:** Install via the Solana install script (which installs both):
```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
```

---

## Testing Errors

### `solana-test-validator` crashes or hangs
```
Error: failed to start validator
```

**Solutions:**
1. **Kill existing validators:**
   ```bash
   pkill -f solana-test-validator
   # or
   solana-test-validator --kill
   ```
2. **Clean ledger:**
   ```bash
   rm -rf test-ledger/
   ```
3. **Check port availability:**
   ```bash
   lsof -i :8899  # RPC port
   lsof -i :8900  # Websocket port
   ```
4. **Consider Surfpool** as a modern alternative to `solana-test-validator`:
   ```bash
   curl --proto '=https' --tlsv1.2 -LsSf https://github.com/txtx/surfpool/releases/latest/download/surfpool-installer.sh | sh
   ```

### Anchor test fails with `Connection refused` / IPv6 issue
```
Error: connect ECONNREFUSED ::1:8899
```

**Cause:** Node.js 17+ resolves `localhost` to IPv6 `::1` by default, but `solana-test-validator` binds to `127.0.0.1`.

**Solutions:**
1. **Use Anchor 0.30+** which defaults to `127.0.0.1` instead of `localhost`
2. **Set NODE_OPTIONS:**
   ```bash
   NODE_OPTIONS="--dns-result-order=ipv4first" anchor test
   ```
3. **Edit Anchor.toml:**
   ```toml
   [provider]
   cluster = "http://127.0.0.1:8899"
   ```

---

## Anchor Version Migration Issues

### Anchor 0.29 → 0.30 Migration Errors

**`accounts` method type errors in TypeScript:**
```
Argument of type '{ ... }' is not assignable to parameter of type 'ResolvedAccounts<...>'
```

**Solution:** Change `.accounts({...})` to `.accountsPartial({...})` or remove auto-resolved accounts from the call.

**Missing `idl-build` feature:**
```
Error: `idl-build` feature is missing
```

**Solution:** Add to each program's Cargo.toml:
```toml
[features]
idl-build = ["anchor-lang/idl-build"]
```

**`overflow-checks` not specified:**
```
Error: overflow-checks must be specified in workspace Cargo.toml
```

**Solution:** Add to workspace `Cargo.toml`:
```toml
[profile.release]
overflow-checks = true
```

### Anchor 0.30 → 0.31 Migration Errors

**Solana v1 → v2 crate conflicts:**
```
error[E0308]: mismatched types
expected `solana_program::pubkey::Pubkey`
found `solana_sdk::pubkey::Pubkey`
```

**Solution:** Remove direct `solana-program` and `solana-sdk` dependencies. Use them through `anchor-lang`:
```rust
use anchor_lang::prelude::*;
// NOT: use solana_program::pubkey::Pubkey;
```

**`Discriminator` trait changes:**
```
error[E0277]: the trait bound `MyAccount: Discriminator` is not satisfied
```

**Solution:** Ensure you derive `#[account]` on your structs. The discriminator is now dynamically sized.

### Anchor 0.31 → 0.32 Migration Errors

**`solana-program` dependency warning becomes error:**
Anchor 0.32 fully removes `solana-program` as a dependency. If your code imports from `solana_program::*`, change to the smaller crates:
```rust
// Before (0.31):
use solana_program::pubkey::Pubkey;

// After (0.32):
use solana_pubkey::Pubkey;
// Or use anchor's re-export:
use anchor_lang::prelude::*;
```

**Duplicate mutable accounts error:**
```
Error: Duplicate mutable account
```
Anchor 0.32+ disallows duplicate mutable accounts by default. Use the `dup` constraint:
```rust
#[derive(Accounts)]
pub struct MyInstruction<'info> {
    #[account(mut)]
    pub account_a: Account<'info, MyAccount>,
    #[account(mut, dup = account_a)]
    pub account_b: Account<'info, MyAccount>,
}
```

---

## Miscellaneous Errors

### `solana airdrop` fails
```
Error: airdrop request failed
```

**Cause:** Rate limiting on devnet/testnet.

**Solutions:**
1. Wait and retry
2. Use the web faucet: https://faucet.solana.com
3. For testing, use localnet where airdrops are unlimited

### Anchor IDL account authority mismatch
```
Error: Authority did not sign
```

**Solution:** The IDL authority is the program's upgrade authority. Check with:
```bash
solana program show <PROGRAM_ID>
```

### `declare_program!` not finding IDL file
```
Error: file not found: idls/my_program.json
```

**Solution:** Place the IDL JSON in the `idls/` directory at the workspace root. The filename must match the program name (snake_case):
```
workspace/
├── idls/
│   └── my_program.json
├── programs/
│   └── my_program/
└── Anchor.toml
```

---

## LiteSVM Errors

### `undefined symbol: __isoc23_strtol` (litesvm native binary)
```
Error: Cannot find native binding.
cause: litesvm.linux-x64-gnu.node: undefined symbol: __isoc23_strtol
```

**Root cause:** LiteSVM 0.5.0 native binary is compiled against GLIBC 2.38+. The `__isoc23_strtol` symbol was introduced in GLIBC 2.38 (C23 standard functions). Systems with GLIBC < 2.38 (Ubuntu 22.04, Debian 12, etc.) cannot load this binary.

**Verified on:** Debian 12 (GLIBC 2.36) — Jan 2026

**Solutions:**
1. **Upgrade OS** to Ubuntu 24.04+ or Debian 13+ (recommended)
2. **Use Docker:**
   ```dockerfile
   FROM ubuntu:24.04
   RUN apt-get update && apt-get install -y nodejs npm
   ```
3. **Fall back to `solana-bankrun`** if you can't upgrade:
   ```bash
   pnpm remove litesvm anchor-litesvm
   pnpm add -D solana-bankrun anchor-bankrun
   ```
4. **Try litesvm 0.3.x** which may work on older GLIBC versions

### `Cannot find module './litesvm.linux-x64-gnu.node'`
```
Error: Cannot find module './litesvm.linux-x64-gnu.node'
```

**Root cause:** pnpm hoisting doesn't always correctly link native optional dependencies for native Node addons.

**Solutions:**
1. Delete `node_modules` and reinstall: `rm -rf node_modules && pnpm install`
2. Use `node-linker=hoisted` in `.npmrc`:
   ```
   node-linker=hoisted
   ```
3. Install the platform-specific package explicitly:
   ```bash
   pnpm add -D litesvm-linux-x64-gnu
   ```

---

## Platform Tools Errors

### `The Solana toolchain is corrupted` after fresh install
```
[ERROR cargo_build_sbf] The Solana toolchain is corrupted. Please, run cargo-build-sbf with the --force-tools-install argument to fix it.
```

**Root cause:** Solana CLI 2.2.x downloads platform-tools v1.48 (~516MB compressed, ~2GB extracted). On systems with limited root partition space (<3GB free in `~/.cache/solana/`), extraction can fail silently, leaving a corrupted toolchain (e.g., `rust/` directory missing `rustc` binary).

**Verified on:** Debian 12, Solana CLI 2.2.16, root partition 9.7GB with 2.1GB free — Jan 2026

**Solutions:**
1. **Run with `--force-tools-install`:**
   ```bash
   cargo build-sbf --force-tools-install
   ```
   This re-downloads and re-extracts. Takes 5-10 minutes on average connections.

2. **Ensure sufficient disk space** (~3GB free needed on partition containing `~/.cache/solana/`):
   ```bash
   df -h ~/.cache/solana/
   # If too small, symlink to bigger disk:
   rm -rf ~/.cache/solana/v1.48/platform-tools
   mkdir -p /mnt/data/solana-cache/v1.48/platform-tools
   ln -sf /mnt/data/solana-cache/v1.48/platform-tools ~/.cache/solana/v1.48/platform-tools
   ```

3. **Manual extraction** (if `--force-tools-install` keeps cycling):
   ```bash
   # Download manually
   wget https://github.com/anza-xyz/platform-tools/releases/download/v1.48/platform-tools-linux-x86_64.tar.bz2
   # Extract to a disk with space
   mkdir -p /mnt/data/solana-platform-tools/v1.48
   cd /mnt/data/solana-platform-tools/v1.48
   tar xjf /path/to/platform-tools-linux-x86_64.tar.bz2
   # Symlink
   ln -sf /mnt/data/solana-platform-tools/v1.48 ~/.cache/solana/v1.48/platform-tools
   ```

**Note:** The `version.md` file is the last file extracted. Its presence confirms successful extraction.

### Anchor CLI version mismatch warnings (non-fatal)
```
WARNING: `anchor-lang` version(0.32.1) and the current CLI version(0.30.1) don't match.
WARNING: `@coral-xyz/anchor` version(^0.32.1) and the current CLI version(0.30.1) don't match.
```

**Root cause:** Using Anchor CLI 0.30.1 with `anchor-lang = "0.32.1"` in Cargo.toml. The build **succeeds** but prints warnings.

**Verified on:** Debian 12, Anchor CLI 0.30.1 building anchor-lang 0.32.1 — builds and generates IDL correctly — Jan 2026

**Impact:** Builds work. IDL generation works. But subtle runtime issues may occur with IDL format differences between 0.30 and 0.32.

**Solutions:**
1. **Match versions** (recommended):
   ```toml
   # Anchor.toml
   [toolchain]
   anchor_version = "0.32.1"
   ```
   Then install matching CLI: `avm install 0.32.1`
2. **Or downgrade crate:** Change `anchor-lang = "0.30.1"` in Cargo.toml
3. **Ignore if just building:** The mismatch is cosmetic for `anchor build` and `anchor idl build`

---

## edition2024 Crate Incompatibility (Cargo 1.84.0)

### `feature edition2024 is required` during `cargo build-sbf`
```
error: failed to download `constant_time_eq v0.4.2`

Caused by:
  failed to parse manifest at `.../constant_time_eq-0.4.2/Cargo.toml`

Caused by:
  feature `edition2024` is required

  The package requires the Cargo feature called `edition2024`, but that feature is not
  stabilized in this version of Cargo (1.84.0 (12fe57a9d 2025-04-07)).
```

**Root cause:** Platform-tools v1.48 (used by Solana CLI 2.2.16 and CI with Solana stable 3.0.14) bundles `cargo 1.84.0` (Solana Rust fork), which does **not** support `edition = "2024"`. Multiple crates in the Solana dependency tree have released versions requiring edition2024.

### ⚠️ Known edition2024 Crates (Updated Jan 31, 2026)

| Crate | Breaking Version | Safe Version | Pulled By |
|---|---|---|---|
| `blake3` | ≥1.8.3 | **1.8.2** | `solana-blake3-hasher` → `solana-program` |
| `constant_time_eq` | ≥0.4.2 | **0.3.1** | `blake3` |
| `base64ct` | ≥1.8.3 | **1.7.3** | `pkcs8`, `spki` → various crypto crates |
| `indexmap` | ≥2.13.0 | **2.11.4** | `toml_edit` → `proc-macro-crate` → `borsh-derive` → `anchor-lang` |

**New crates may ship edition2024 at any time.** If you see this error with a crate not listed above, pin it to the previous version.

**Why existing repos break:** Projects without a `Cargo.lock` (or with a stale one) resolve to the latest crate versions at build time, pulling in edition2024-requiring releases. This is especially common in CI environments.

**Verified on:**
- Debian 12, Solana CLI 2.2.16, platform-tools v1.48 — Jan 30, 2026
- GitHub Actions (ubuntu-latest), Solana stable 3.0.14, Cargo 1.84.0 — Jan 31, 2026

### Solutions

**1. Pin all known problematic crates (recommended for CI):**
```bash
cargo generate-lockfile
cargo update -p blake3 --precise 1.8.2
cargo update -p constant_time_eq --precise 0.3.1
cargo update -p base64ct --precise 1.7.3
cargo update -p indexmap --precise 2.11.4
```

**2. Pin via workspace Cargo.toml:**
```toml
# In workspace Cargo.toml
[workspace.dependencies]
blake3 = "=1.8.2"
base64ct = "=1.7.3"
```

**3. Always commit Cargo.lock for programs and Anchor projects:**
```bash
# Force-add if .gitignore excludes it
git add -f Cargo.lock
```
This is the single most effective prevention — a committed lockfile prevents cargo from resolving to newer breaking versions.

**4. For monorepos with per-project Cargo.lock files (e.g., program-examples):**
Each Anchor project that has its own `Cargo.toml` outside the workspace needs its own `Cargo.lock`. Generate and pin for each:
```bash
for dir in $(find . -path "*/anchor/Cargo.toml" -exec dirname {} \;); do
  cd "$dir"
  cargo generate-lockfile
  cargo update -p blake3 --precise 1.8.2 2>/dev/null
  cargo update -p constant_time_eq --precise 0.3.1 2>/dev/null
  cargo update -p base64ct --precise 1.7.3 2>/dev/null
  cargo update -p indexmap --precise 2.11.4 2>/dev/null
  cd -
done
git add -f **/Cargo.lock
```

**5. Wait for platform-tools update** — a future platform-tools version will ship a cargo that supports edition2024. Track at [anza-xyz/platform-tools](https://github.com/anza-xyz/platform-tools/releases).

### `Could not find specification for target "sbpf-solana-solana"` with `--tools-version`
```
error: Error loading target specification: Could not find specification for target "sbpf-solana-solana".
Run `rustc --print target-list` for a list of built-in targets
```

**Root cause:** Using `cargo build-sbf --tools-version v1.43` with Solana CLI 2.2.16. The CLI generates `--target sbpf-solana-solana` but platform-tools v1.43 only knows older target triples (e.g., `sbf-solana-solana`). The SBPF target rename happened between v1.43 and v1.48.

**Verified on:** Debian 12, Solana CLI 2.2.16 — Jan 30, 2026

**Solution:** Don't downgrade platform-tools below your CLI's default version. Use the default tools version (v1.48 for CLI 2.2.16).

---

## Verified Test Results (Debian 12, Jan 2026)

Environment: Rust 1.93, Solana CLI 2.2.16, Anchor CLI 0.30.1, Node 22.22.0, GLIBC 2.36

| Test | Command | Result | Notes |
|------|---------|--------|-------|
| Anchor CLI/crate mismatch | `anchor build` (CLI 0.30.1 / anchor-lang 0.32.1) | ⚠️ PASS with warnings | Builds succeed; prints version mismatch warnings |
| cargo build-sbf (native) | `cargo build-sbf` on hello-solana, counter, transfer-sol, create-account, checking-accounts | ✅ PASS | All build after platform-tools v1.48 installed correctly |
| solana-bankrun (GLIBC 2.36) | `npm install solana-bankrun && require('solana-bankrun')` | ✅ PASS | `start` function available, works on GLIBC 2.36 |
| litesvm npm (GLIBC 2.36) | `npm install litesvm && require('litesvm')` | ❌ FAIL | `undefined symbol: __isoc23_strtol` — requires GLIBC ≥2.38 |
| @solana/web3.js CJS | `require('@solana/web3.js')` | ✅ PASS | Keypair, Connection etc. available |
| @solana/web3.js ESM | `import * as web3 from '@solana/web3.js'` | ✅ PASS | Full ESM support on Node 22 |
| @solana/kit (web3.js v2) ESM | `import('@solana/kit')` | ✅ PASS | ESM-only, works on Node 22 |
| @coral-xyz/anchor CJS | `require('@coral-xyz/anchor')` | ✅ PASS | Program, Provider etc. available |
| @coral-xyz/anchor ESM | `import * as anchor from '@coral-xyz/anchor'` | ✅ PASS | Full ESM support on Node 22 |
| IDL generation | `anchor idl build` (from program dir) | ✅ PASS | Generates valid JSON IDL with CLI 0.30.1 |
| Cargo duplicate deps | `cargo tree -d` on program-examples | ⚠️ INFO | 2295 lines of duplicate deps (ahash, base64, borsh, curve25519-dalek, ed25519-dalek, etc.) — normal for Solana workspace |
| Platform tools corruption | `cargo build-sbf` on fresh install | ❌ FAIL then PASS | Initial corruption due to disk space; fixed with `--force-tools-install` on adequate disk |

### Key Findings
1. **litesvm 0.5.0 npm is BROKEN on Debian 12** (GLIBC 2.36) — use `solana-bankrun` as fallback
2. **solana-bankrun works perfectly** on GLIBC 2.36 — recommended for Debian 12
3. **Platform-tools v1.48 needs ~2GB disk** for extraction — symlink `~/.cache/solana/` to a larger partition if root is small
4. **Anchor CLI 0.30.1 successfully builds anchor-lang 0.32.1** — warnings only, no errors
5. **Node 22 has full ESM+CJS support** for all Solana JS packages tested
6. **Cargo duplicate dependencies are normal** in Solana monorepos (borsh 0.9/0.10/1.x, curve25519-dalek 3.x/4.x, etc.)


---

# compatibility-matrix

# Solana Version Compatibility Matrix

## Master Compatibility Table

| Anchor Version | Release Date | Solana CLI | Rust Version | Platform Tools | GLIBC Req | Node.js | Key Notes |
|---|---|---|---|---|---|---|---|
| **0.32.x** | Oct 2025 | 2.1.x+ | 1.79–1.85+ (stable) | v1.50+ | ≥2.39 | ≥17 | Replaces `solana-program` with smaller crates; IDL builds on stable Rust; removes Solang |
| **0.31.1** | Apr 2025 | 2.0.x–2.1.x | 1.79–1.83 | v1.47+ | ≥2.39 ⚠️ | ≥17 | New Docker image `solanafoundation/anchor`; published under solana-foundation org. **Tested: binary requires GLIBC 2.39, not 2.38** |
| **0.31.0** | Mar 2025 | 2.0.x–2.1.x | 1.79–1.83 | v1.47+ | ≥2.39 ⚠️ | ≥17 | Solana v2 upgrade; dynamic discriminators; `LazyAccount`; `declare_program!` improvements. **Pre-built binary needs GLIBC 2.39** |
| **0.30.1** | Jun 2024 | 1.18.x (rec: 1.18.8+) | 1.75–1.79 | v1.43 | ≥2.31 | ≥16 | `declare_program!` macro; legacy IDL conversion; `RUSTUP_TOOLCHAIN` override |
| **0.30.0** | Apr 2024 | 1.18.x (rec: 1.18.8) | 1.75–1.79 | v1.43 | ≥2.31 | ≥16 | New IDL spec; token extensions; `cargo build-sbf` default; `idl-build` feature required |
| **0.29.0** | Oct 2023 | 1.16.x–1.17.x | 1.68–1.75 | v1.37–v1.41 | ≥2.28 | ≥16 | Account reference changes; `idl build` compilation method; `.anchorversion` file |

## Solana CLI Version Mapping

| Solana CLI | Agave Version | Era | solana-program Crate | Platform Tools | Status |
|---|---|---|---|---|---|
| **3.1.x** | v3.1.x | Jan 2026 | N/A (validator only) | v1.52 | Edge/Beta |
| **3.0.x** | v3.0.x | Late 2025 | N/A (validator only) | v1.52 | Stable (mainnet) |
| **2.1.x** | v2.1.x | Mid 2025 | 2.x | v1.47–v1.51 | Stable |
| **2.0.x** | v2.0.x | Early 2025 | 2.x | v1.44–v1.47 | Legacy |
| **1.18.x** | N/A (pre-Anza) | 2024 | 1.18.x | v1.43 | Legacy |
| **1.17.x** | N/A | 2023 | 1.17.x | v1.37–v1.41 | Deprecated |
| **1.16.x** | N/A | 2023 | 1.16.x | v1.35–v1.37 | Deprecated |

### Important: Solana CLI v3.x
As of Agave v3.0.0, Anza **no longer publishes the `agave-validator` binary**. Operators must build from source. The CLI tools (for program development) remain available via `agave-install` or the install script.

## Platform Tools → Rust Toolchain Mapping

| Platform Tools | Bundled Rust | Bundled Cargo | LLVM/Clang | Target Triple | Notes |
|---|---|---|---|---|---|
| **v1.52** | ~1.85 (solana fork) | ~1.85 | Clang 20 | `sbpf-solana-solana` | Latest; used by Solana CLI 3.x |
| **v1.51** | ~1.84 (solana fork) | ~1.84 | Clang 19 | `sbpf-solana-solana` | |
| **v1.50** | ~1.83 (solana fork) | ~1.83 | Clang 19 | `sbpf-solana-solana` | |
| **v1.49** | ~1.82 (solana fork) | ~1.82 | Clang 18 | `sbpf-solana-solana` | |
| **v1.48** | rustc 1.84.1-dev | cargo 1.84.0 | Clang 19 | `sbpf-solana-solana` | **Verified.** Used by Solana CLI 2.2.16. ⚠️ Cargo does NOT support `edition2024` |
| **v1.47** | ~1.80 (solana fork) | ~1.80 | Clang 17 | `sbpf-solana-solana` | Used by Anchor 0.31.x |
| **v1.46** | ~1.79 (solana fork) | ~1.79 | Clang 17 | `sbf-solana-solana` | |
| **v1.45** | ~1.79 (solana fork) | ~1.79 | Clang 17 | `sbf-solana-solana` | |
| **v1.44** | ~1.78 (solana fork) | ~1.78 | Clang 16 | `sbf-solana-solana` | |
| **v1.43** | ~1.75 (solana fork) | ~1.75 | Clang 16 | `sbf-solana-solana` | Used by Anchor 0.30.x/Solana 1.18.x. ❌ Incompatible with CLI 2.2.16 (`sbpf-solana-solana` target not found) |

**Note:** Platform Tools ship a **forked** Rust compiler from [anza-xyz/rust](https://github.com/anza-xyz/rust). The version numbers approximate the upstream Rust equivalent. The forked compiler includes SBF/SBPF target support.

**⚠️ CRITICAL (Jan 2026):** Platform-tools v1.48 bundles `cargo 1.84.0` which does NOT support `edition = "2024"`. Multiple crates now require it: `blake3 ≥1.8.3`, `constant_time_eq ≥0.4.2`, `base64ct ≥1.8.3`, `indexmap ≥2.13.0`. Pin to safe versions: `blake3=1.8.2`, `constant_time_eq=0.3.1`, `base64ct=1.7.3`, `indexmap=2.11.4`. **Always commit Cargo.lock files.** See [common-errors.md](./common-errors.md#edition2024-crate-incompatibility-cargo-1840) for full details and fix scripts.

## GLIBC Requirements by OS

| OS / Distro | GLIBC Version | Compatible Anchor |
|---|---|---|
| **Ubuntu 24.04 (Noble)** | 2.39 | All (0.29–0.32+) |
| **Ubuntu 22.04 (Jammy)** | 2.35 | 0.29–0.30.x only (build 0.31+ from source) |
| **Ubuntu 20.04 (Focal)** | 2.31 | 0.29–0.30.x only (build 0.31+ from source) |
| **Debian 12 (Bookworm)** | 2.36 | 0.29–0.30.x only ⚠️ **Tested: 0.31.1 and 0.32.1 pre-built binaries fail.** Build from source works for Anchor CLI, but `litesvm` 0.5.0 native binary also needs GLIBC 2.38+ |
| **Debian 13 (Trixie)** | 2.40 | All |
| **Fedora 39+** | ≥2.38 | All |
| **Arch Linux (rolling)** | Latest | All |
| **macOS 14+ (Sonoma)** | N/A (no GLIBC) | All |
| **macOS 12-13** | N/A | All |
| **Windows WSL2 (Ubuntu)** | Depends on distro | See Ubuntu version |

### Why GLIBC matters
Anchor 0.31+ and 0.32+ binaries are compiled against newer GLIBC. If your system's GLIBC is too old, you'll get:
```
anchor: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found
```

**Solutions:**
1. Upgrade your OS (recommended)
2. Build Anchor from source: `cargo install --git https://github.com/coral-xyz/anchor --tag v0.31.1 anchor-cli`
3. Use Docker (see install-guide.md)

## Anchor ↔ solana-program Crate Versions

| Anchor | anchor-lang Crate | Uses solana-program | Notes |
|---|---|---|---|
| **0.32.x** | 0.32.x | Replaced by individual `solana-*` crates | `solana-program` no longer a direct dep |
| **0.31.x** | 0.31.x | 2.x | Upgraded to Solana v2 crate ecosystem |
| **0.30.x** | 0.30.x | 1.18.x | Last version using Solana v1 crates |
| **0.29.x** | 0.29.x | 1.16.x–1.17.x | |

### Solana v2 Crate Ecosystem (Anchor 0.31+)
Anchor 0.31+ uses the Solana v2 crate structure. The monolithic `solana-program` crate is being split into smaller crates:
- `solana-pubkey` / `solana-address`
- `solana-instruction`
- `solana-account-info`
- `solana-msg`
- `solana-invoke`
- `solana-entrypoint`
- etc.

Anchor 0.32+ fully replaces `solana-program` with these smaller crates. When using `Anchor 0.31.x`, the `anchor build` command warns if you have `solana-program` as a direct dependency — it should come through `anchor-lang`.

## Anchor CLI ↔ anchor-lang Crate Compatibility

The Anchor CLI checks version compatibility with the `anchor-lang` crate used in your project. **Mismatched versions will produce a warning.** Always keep these in sync:

```toml
# Cargo.toml
[dependencies]
anchor-lang = "0.31.1"

# Must match CLI:
# anchor --version → anchor-cli 0.31.1
```

## SPL Token Crate Versions

| Anchor | anchor-spl | spl-token | spl-token-2022 | spl-associated-token-account |
|---|---|---|---|---|
| **0.32.x** | 0.32.x | Latest compatible | Latest compatible | Latest compatible |
| **0.31.x** | 0.31.x | 6.x | 5.x | 4.x |
| **0.30.x** | 0.30.x | 4.x–6.x | 3.x–4.x | 3.x |
| **0.29.x** | 0.29.x | 4.x | 1.x–3.x | 2.x–3.x |

## Node.js / TypeScript Requirements

| Anchor | @coral-xyz/anchor | Node.js | TypeScript |
|---|---|---|---|
| **0.32.x** | 0.32.x | ≥17 | 5.x |
| **0.31.x** | 0.31.x | ≥17 | 5.x |
| **0.30.x** | 0.30.x | ≥16 | 4.x–5.x |
| **0.29.x** | 0.29.x | ≥16 | 4.x |

## Known Working Combinations (Tested)

### 🟢 Modern (Recommended for new projects — Jan 2026)
```
Anchor CLI: 0.31.1
Solana CLI: 2.1.7 (stable)
Rust: 1.83.0
Platform Tools: v1.50
Node.js: 20.x LTS
OS: Ubuntu 24.04 or macOS 14+
```

### 🟢 Latest Anchor (Cutting edge)
```
Anchor CLI: 0.32.1
Solana CLI: 2.1.7+
Rust: 1.84.0+
Platform Tools: v1.52
Node.js: 20.x LTS
OS: Ubuntu 24.04+ (GLIBC ≥2.39) or macOS 14+
```

### 🟡 Legacy Compatible (For older systems)
```
Anchor CLI: 0.30.1
Solana CLI: 1.18.26
Rust: 1.79.0
Platform Tools: v1.43
Node.js: 18.x LTS
OS: Ubuntu 20.04+ or macOS 12+
```

### 🟡 Transitional (Upgrading from 0.30 → 0.31)
```
Anchor CLI: 0.31.0
Solana CLI: 2.0.x
Rust: 1.79.0
Platform Tools: v1.47
Node.js: 20.x LTS
OS: Ubuntu 24.04 or macOS 14+
```

## Testing Tools: LiteSVM / Bankrun Compatibility

| Tool | npm Package | GLIBC Req | Node.js | Notes |
|---|---|---|---|---|
| **LiteSVM 0.5.0** | `litesvm` | ≥2.38 ⚠️ | ≥18 | **Tested: native binary (`litesvm.linux-x64-gnu.node`) fails on Debian 12 (GLIBC 2.36) with `undefined symbol: __isoc23_strtol`**. Works on Ubuntu 24.04+, macOS. |
| **LiteSVM 0.3.x** | `litesvm` | ≥2.31 | ≥16 | Older API, may work on older systems |
| **solana-bankrun** | `solana-bankrun` | ≥2.28 | ≥16 | Legacy — being replaced by LiteSVM |
| **anchor-bankrun** | `anchor-bankrun` | ≥2.28 | ≥16 | Legacy Anchor wrapper for bankrun |
| **anchor-litesvm** | `anchor-litesvm` | Same as litesvm | ≥18 | Anchor wrapper for LiteSVM |

### LiteSVM on Older Systems
If `litesvm` 0.5.0 fails with GLIBC errors:
1. **Upgrade OS** to Ubuntu 24.04+ (recommended)
2. **Use Docker**: `FROM ubuntu:24.04` base image
3. **Fall back to `solana-bankrun`** temporarily
4. **Build litesvm from source** (requires Rust + napi-rs toolchain)

### Verified Test Environment (Jan 2026)
```
✅ Works: Anchor CLI 0.30.1 (built from source) + Solana CLI 2.2.16 + Rust 1.93.0 + Debian 12
❌ Fails: litesvm 0.5.0 native binary on Debian 12 (GLIBC 2.36)
❌ Fails: Anchor 0.31.1/0.32.1 pre-built binaries on Debian 12 (GLIBC 2.36)
✅ Works: cargo build-sbf (Solana 2.2.16, platform-tools v1.48) on Debian 12
✅ Works: Anchor 0.30.1 built from source with Rust 1.93.0 on Debian 12
```


---

# confidential-transfers

# Confidential Transfers (Token-2022 Extension)

## When to use this guidance

Use this guidance when the user asks about:

- Private/encrypted token balances
- Confidential transfers or balances on Solana
- Zero-knowledge proofs for token transfers
- Token-2022 confidential transfer extension(s)
- ElGamal encryption for tokens

## Current Network Availability

**Important:** Confidential transfers are currently only available on a TXTX cluster.

- RPC endpoint: `https://zk-edge.surfnet.dev/`
- Mainnet availability expected in a few months

When building for confidential transfers, always use the ZK-Edge RPC for testing. Plan for mainnet migration by abstracting the RPC endpoint configuration. Ensure the user is aware of this.

## Key Concepts

### What are Confidential Transfers?

Confidential transfers encrypt token balances and transfer amounts using zero-knowledge cryptography. onchain observers cannot see actual amounts, but the system still verifies:

- Sender has sufficient balance
- Transfer amounts are non-negative
- No tokens are created or destroyed

### Balance Types

Each confidential-enabled account has three balance types:

- **Public**: Standard visible SPL balance
- **Pending**: Encrypted incoming transfers awaiting application
- **Available**: Encrypted balance ready for outgoing transfers

### Encryption Keys

Two keys are derived deterministically from the account owner's keypair:

- **ElGamal keypair**: Used for transfer encryption (asymmetric)
- **AES key**: Used for balance decryption by owner (symmetric)

### Privacy Levels

Mints can configure four privacy modes:

- `Disabled`: No confidential transfers
- `Whitelisted`: Only approved accounts
- `OptIn`: Accounts choose to enable
- `Required`: All transfers must be confidential

## Dependencies

```toml
[dependencies]
# Solana core
solana-sdk = "3.0.0"
solana-client = "3.1.6"
solana-zk-sdk = "5.0.0"
solana-commitment-config = "3.1.0"

# Token-2022
spl-token-2022 = { version = "10.0.0", features = ["zk-ops"] }
spl-token-client = "0.18.0"
spl-associated-token-account = "8.0.0"

# Confidential transfer proofs
spl-token-confidential-transfer-proof-generation = "0.5.1"
spl-token-confidential-transfer-proof-extraction = "0.5.1"

# Async runtime
tokio = { version = "1", features = ["full"] }
```

## Common Types

```rust
use solana_sdk::signature::Signature;
use std::error::Error;

pub type CtResult<T> = Result<T, Box<dyn Error>>;
pub type SigResult = CtResult<Signature>;
pub type MultiSigResult = CtResult<Vec<Signature>>;
```

## Operation Flow

The typical flow for confidential transfers:

1. **Configure** - Enable confidential transfers on a token account
2. **Deposit** - Move tokens from public to pending balance
3. **Apply Pending** - Move pending to available balance
4. **Transfer** - Send from available balance (encrypted)
5. **Withdraw** - Move from available back to public balance

## Key Operations

### 1. Configure Account for Confidential Transfers

Before using confidential transfers, accounts must be configured with encryption keys:

```rust
use solana_client::rpc_client::RpcClient;
use solana_sdk::{signature::Signer, transaction::Transaction};
use spl_associated_token_account::get_associated_token_address_with_program_id;
use spl_token_2022::{
    extension::{
        confidential_transfer::instruction::{configure_account, PubkeyValidityProofData},
        ExtensionType,
    },
    instruction::reallocate,
    solana_zk_sdk::encryption::{auth_encryption::AeKey, elgamal::ElGamalKeypair},
};
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;

pub async fn configure_account_for_confidential_transfers(
    client: &RpcClient,
    payer: &dyn Signer,
    authority: &dyn Signer,
    mint: &solana_sdk::pubkey::Pubkey,
) -> SigResult {
    let token_account = get_associated_token_address_with_program_id(
        &authority.pubkey(),
        mint,
        &spl_token_2022::id(),
    );

    // Derive encryption keys deterministically from authority
    let elgamal_keypair = ElGamalKeypair::new_from_signer(
        authority,
        &token_account.to_bytes(),
    )?;
    let aes_key = AeKey::new_from_signer(
        authority,
        &token_account.to_bytes(),
    )?;

    // Maximum pending deposits before apply_pending_balance must be called
    let max_pending_balance_credit_counter = 65536u64;

    // Initial decryptable balance (encrypted with AES)
    let decryptable_balance = aes_key.encrypt(0);

    // Generate proof that we control the ElGamal public key
    let proof_data = PubkeyValidityProofData::new(&elgamal_keypair)
        .map_err(|_| "Failed to generate pubkey validity proof")?;

    // Proof will be in the next instruction (offset 1)
    let proof_location = ProofLocation::InstructionOffset(
        1.try_into().unwrap(),
        &proof_data,
    );

    let mut instructions = vec![];

    // 1. Reallocate to add ConfidentialTransferAccount extension
    instructions.push(reallocate(
        &spl_token_2022::id(),
        &token_account,
        &payer.pubkey(),
        &authority.pubkey(),
        &[&authority.pubkey()],
        &[ExtensionType::ConfidentialTransferAccount],
    )?);

    // 2. Configure account (includes proof instruction)
    instructions.extend(configure_account(
        &spl_token_2022::id(),
        &token_account,
        mint,
        &decryptable_balance.into(),
        max_pending_balance_credit_counter,
        &authority.pubkey(),
        &[],
        proof_location,
    )?);

    let recent_blockhash = client.get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &instructions,
        Some(&payer.pubkey()),
        &[authority, payer],
        recent_blockhash,
    );

    let signature = client.send_and_confirm_transaction(&transaction)?;
    Ok(signature)
}
```

### 2. Deposit to Confidential Balance

Move tokens from public balance to pending confidential balance:

```rust
use solana_client::rpc_client::RpcClient;
use solana_sdk::{signature::Signer, transaction::Transaction};
use spl_associated_token_account::get_associated_token_address_with_program_id;
use spl_token_2022::extension::confidential_transfer::instruction::deposit;

pub async fn deposit_to_confidential(
    client: &RpcClient,
    payer: &dyn Signer,
    authority: &dyn Signer,
    mint: &solana_sdk::pubkey::Pubkey,
    amount: u64,
    decimals: u8,
) -> SigResult {
    let token_account = get_associated_token_address_with_program_id(
        &authority.pubkey(),
        mint,
        &spl_token_2022::id(),
    );

    let deposit_ix = deposit(
        &spl_token_2022::id(),
        &token_account,
        mint,
        amount,
        decimals,
        &authority.pubkey(),
        &[&authority.pubkey()],
    )?;

    let recent_blockhash = client.get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &[deposit_ix],
        Some(&payer.pubkey()),
        &[payer, authority],
        recent_blockhash,
    );

    let signature = client.send_and_confirm_transaction(&transaction)?;
    Ok(signature)
}
```

### 3. Apply Pending Balance

Move tokens from pending to available (spendable) balance:

```rust
use solana_client::rpc_client::RpcClient;
use solana_sdk::{signature::Signer, transaction::Transaction};
use spl_associated_token_account::get_associated_token_address_with_program_id;
use spl_token_2022::{
    extension::{
        confidential_transfer::{
            instruction::apply_pending_balance as apply_pending_balance_instruction,
            ConfidentialTransferAccount,
        },
        BaseStateWithExtensions, StateWithExtensions,
    },
    solana_zk_sdk::encryption::{auth_encryption::AeKey, elgamal::ElGamalKeypair},
    state::Account as TokenAccount,
};

pub async fn apply_pending_balance(
    client: &RpcClient,
    payer: &dyn Signer,
    authority: &dyn Signer,
    mint: &solana_sdk::pubkey::Pubkey,
) -> SigResult {
    let token_account = get_associated_token_address_with_program_id(
        &authority.pubkey(),
        mint,
        &spl_token_2022::id(),
    );

    // Derive encryption keys
    let elgamal_keypair = ElGamalKeypair::new_from_signer(
        authority,
        &token_account.to_bytes(),
    )?;
    let aes_key = AeKey::new_from_signer(
        authority,
        &token_account.to_bytes(),
    )?;

    // Fetch account state
    let account_data = client.get_account(&token_account)?;
    let account = StateWithExtensions::<TokenAccount>::unpack(&account_data.data)?;
    let ct_extension = account.get_extension::<ConfidentialTransferAccount>()?;

    // Decrypt current balances - note: decrypt_u32 is called ON the ciphertext
    let pending_balance_lo: spl_token_2022::solana_zk_sdk::encryption::elgamal::ElGamalCiphertext =
        ct_extension.pending_balance_lo.try_into()
            .map_err(|_| "Failed to convert pending_balance_lo")?;
    let pending_balance_hi: spl_token_2022::solana_zk_sdk::encryption::elgamal::ElGamalCiphertext =
        ct_extension.pending_balance_hi.try_into()
            .map_err(|_| "Failed to convert pending_balance_hi")?;
    let available_balance: spl_token_2022::solana_zk_sdk::encryption::elgamal::ElGamalCiphertext =
        ct_extension.available_balance.try_into()
            .map_err(|_| "Failed to convert available_balance")?;

    // Decrypt using ciphertext.decrypt_u32(secret)
    let pending_lo = pending_balance_lo.decrypt_u32(elgamal_keypair.secret())
        .ok_or("Failed to decrypt pending_balance_lo")?;
    let pending_hi = pending_balance_hi.decrypt_u32(elgamal_keypair.secret())
        .ok_or("Failed to decrypt pending_balance_hi")?;
    let current_available = available_balance.decrypt_u32(elgamal_keypair.secret())
        .ok_or("Failed to decrypt available_balance")?;

    // Calculate new available balance
    let pending_total = pending_lo + (pending_hi << 16);
    let new_available = current_available + pending_total;

    // Encrypt new available balance with AES for owner
    let new_decryptable_balance = aes_key.encrypt(new_available);

    // Get expected pending balance credit counter
    let expected_counter: u64 = ct_extension.pending_balance_credit_counter.into();

    let apply_ix = apply_pending_balance_instruction(
        &spl_token_2022::id(),
        &token_account,
        expected_counter,
        &new_decryptable_balance.into(),
        &authority.pubkey(),
        &[&authority.pubkey()],
    )?;

    let recent_blockhash = client.get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &[apply_ix],
        Some(&payer.pubkey()),
        &[payer, authority],
        recent_blockhash,
    );

    let signature = client.send_and_confirm_transaction(&transaction)?;
    Ok(signature)
}
```

### 4. Confidential Transfer

Transfer tokens between accounts using zero-knowledge proofs. This is the most complex operation requiring multiple transactions and proof context state accounts:

```rust
use solana_client::rpc_client::RpcClient;
use solana_client::nonblocking::rpc_client::RpcClient as AsyncRpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_sdk::signature::{Keypair, Signer};
use spl_associated_token_account::get_associated_token_address_with_program_id;
use spl_token_2022::{
    extension::{
        confidential_transfer::{
            account_info::TransferAccountInfo,
            ConfidentialTransferAccount, ConfidentialTransferMint,
        },
        BaseStateWithExtensions, StateWithExtensions,
    },
    solana_zk_sdk::encryption::{
        auth_encryption::AeKey,
        elgamal::ElGamalKeypair,
        pod::elgamal::PodElGamalPubkey,
    },
    state::{Account as TokenAccount, Mint},
};
use spl_token_client::{
    client::{ProgramRpcClient, ProgramRpcClientSendTransaction, RpcClientResponse},
    token::{ProofAccountWithCiphertext, Token},
};
use std::sync::Arc;

fn extract_signature(response: RpcClientResponse) -> Result<solana_sdk::signature::Signature, Box<dyn std::error::Error>> {
    match response {
        RpcClientResponse::Signature(sig) => Ok(sig),
        _ => Err("Expected Signature response".into()),
    }
}

pub async fn transfer_confidential(
    client: &RpcClient,
    _payer: &dyn Signer,
    sender: &Keypair,  // Must be Keypair for token client
    mint: &solana_sdk::pubkey::Pubkey,
    recipient: &solana_sdk::pubkey::Pubkey,
    amount: u64,
) -> MultiSigResult {
    let sender_token_account = get_associated_token_address_with_program_id(
        &sender.pubkey(),
        mint,
        &spl_token_2022::id(),
    );
    let recipient_token_account = get_associated_token_address_with_program_id(
        recipient,
        mint,
        &spl_token_2022::id(),
    );

    // Get recipient's ElGamal public key
    let recipient_account_data = client.get_account(&recipient_token_account)?;
    let recipient_account = StateWithExtensions::<TokenAccount>::unpack(&recipient_account_data.data)?;
    let recipient_ct_extension = recipient_account.get_extension::<ConfidentialTransferAccount>()?;
    let recipient_elgamal_pubkey: spl_token_2022::solana_zk_sdk::encryption::elgamal::ElGamalPubkey =
        recipient_ct_extension.elgamal_pubkey.try_into()
            .map_err(|_| "Failed to convert recipient ElGamal pubkey")?;

    // Get auditor ElGamal public key from mint (if configured)
    let mint_account_data = client.get_account(mint)?;
    let mint_account = StateWithExtensions::<Mint>::unpack(&mint_account_data.data)?;
    let mint_ct_extension = mint_account.get_extension::<ConfidentialTransferMint>()?;
    let auditor_elgamal_pubkey: Option<spl_token_2022::solana_zk_sdk::encryption::elgamal::ElGamalPubkey> =
        Option::<PodElGamalPubkey>::from(mint_ct_extension.auditor_elgamal_pubkey)
            .map(|pk| pk.try_into())
            .transpose()
            .map_err(|_| "Failed to convert auditor ElGamal pubkey")?;

    // Derive sender's encryption keys
    let sender_elgamal = ElGamalKeypair::new_from_signer(
        sender,
        &sender_token_account.to_bytes(),
    )?;
    let sender_aes = AeKey::new_from_signer(
        sender,
        &sender_token_account.to_bytes(),
    )?;

    // Fetch sender account and create transfer info
    let account_data = client.get_account(&sender_token_account)?;
    let account = StateWithExtensions::<TokenAccount>::unpack(&account_data.data)?;
    let ct_extension = account.get_extension::<ConfidentialTransferAccount>()?;
    let transfer_info = TransferAccountInfo::new(ct_extension);

    // Verify sufficient balance
    let available_balance: spl_token_2022::solana_zk_sdk::encryption::elgamal::ElGamalCiphertext =
        transfer_info.available_balance.try_into()
            .map_err(|_| "Failed to convert available_balance")?;
    let current_available = available_balance.decrypt_u32(sender_elgamal.secret())
        .ok_or("Failed to decrypt available balance")?;

    if current_available < amount {
        return Err(format!(
            "Insufficient balance: have {}, need {}",
            current_available, amount
        ).into());
    }

    // Generate split transfer proofs (equality, ciphertext validity, range)
    let proof_data = transfer_info.generate_split_transfer_proof_data(
        amount,
        &sender_elgamal,
        &sender_aes,
        &recipient_elgamal_pubkey,
        auditor_elgamal_pubkey.as_ref(),
    )?;

    // Create async client for Token operations
    let rpc_url = client.url();
    let async_client = Arc::new(AsyncRpcClient::new_with_commitment(
        rpc_url,
        CommitmentConfig::confirmed(),
    ));
    let program_client = Arc::new(ProgramRpcClient::new(
        async_client,
        ProgramRpcClientSendTransaction,
    ));

    // Clone sender for Arc (Token client requires ownership)
    let sender_clone = Keypair::new_from_array(*sender.secret_bytes());
    let sender_arc: Arc<dyn Signer> = Arc::new(sender_clone);

    let token = Token::new(
        program_client,
        &spl_token_2022::id(),
        mint,
        None,
        sender_arc,
    );

    // Create proof context state accounts
    let equality_proof_account = Keypair::new();
    let ciphertext_validity_proof_account = Keypair::new();
    let range_proof_account = Keypair::new();

    let mut signatures = Vec::new();

    // 1. Create equality proof context account
    let response = token.confidential_transfer_create_context_state_account(
        &equality_proof_account.pubkey(),
        &sender.pubkey(),
        &proof_data.equality_proof_data,
        false,
        &[&equality_proof_account],
    ).await?;
    signatures.push(extract_signature(response)?);

    // 2. Create ciphertext validity proof context account
    let response = token.confidential_transfer_create_context_state_account(
        &ciphertext_validity_proof_account.pubkey(),
        &sender.pubkey(),
        &proof_data.ciphertext_validity_proof_data_with_ciphertext.proof_data,
        false,
        &[&ciphertext_validity_proof_account],
    ).await?;
    signatures.push(extract_signature(response)?);

    // 3. Create range proof context account
    let response = token.confidential_transfer_create_context_state_account(
        &range_proof_account.pubkey(),
        &sender.pubkey(),
        &proof_data.range_proof_data,
        true,  // Range proof uses batched verification
        &[&range_proof_account],
    ).await?;
    signatures.push(extract_signature(response)?);

    // 4. Execute the confidential transfer
    let ciphertext_validity_proof = ProofAccountWithCiphertext {
        context_state_account: ciphertext_validity_proof_account.pubkey(),
        ciphertext_lo: proof_data.ciphertext_validity_proof_data_with_ciphertext.ciphertext_lo,
        ciphertext_hi: proof_data.ciphertext_validity_proof_data_with_ciphertext.ciphertext_hi,
    };

    let response = token.confidential_transfer_transfer(
        &sender_token_account,
        &recipient_token_account,
        &sender.pubkey(),
        Some(&equality_proof_account.pubkey()),
        Some(&ciphertext_validity_proof),
        Some(&range_proof_account.pubkey()),
        amount,
        None,
        &sender_elgamal,
        &sender_aes,
        &recipient_elgamal_pubkey,
        auditor_elgamal_pubkey.as_ref(),
        &[sender],
    ).await?;
    signatures.push(extract_signature(response)?);

    // 5. Close proof context accounts to reclaim rent
    let response = token.confidential_transfer_close_context_state_account(
        &equality_proof_account.pubkey(),
        &sender_token_account,
        &sender.pubkey(),
        &[sender],
    ).await?;
    signatures.push(extract_signature(response)?);

    let response = token.confidential_transfer_close_context_state_account(
        &ciphertext_validity_proof_account.pubkey(),
        &sender_token_account,
        &sender.pubkey(),
        &[sender],
    ).await?;
    signatures.push(extract_signature(response)?);

    let response = token.confidential_transfer_close_context_state_account(
        &range_proof_account.pubkey(),
        &sender_token_account,
        &sender.pubkey(),
        &[sender],
    ).await?;
    signatures.push(extract_signature(response)?);

    Ok(signatures)
}
```

### 5. Withdraw from Confidential Balance

Move tokens from available confidential balance back to public balance:

```rust
use solana_client::rpc_client::RpcClient;
use solana_sdk::{signature::Signer, transaction::Transaction};
use spl_associated_token_account::get_associated_token_address_with_program_id;
use spl_token_2022::{
    extension::{
        confidential_transfer::{
            account_info::WithdrawAccountInfo,
            instruction::withdraw,
            ConfidentialTransferAccount,
        },
        BaseStateWithExtensions, StateWithExtensions,
    },
    solana_zk_sdk::encryption::{auth_encryption::AeKey, elgamal::ElGamalKeypair},
    state::Account as TokenAccount,
};
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;

pub async fn withdraw_from_confidential(
    client: &RpcClient,
    payer: &dyn Signer,
    authority: &dyn Signer,
    mint: &solana_sdk::pubkey::Pubkey,
    amount: u64,
    decimals: u8,
) -> SigResult {
    let token_account = get_associated_token_address_with_program_id(
        &authority.pubkey(),
        mint,
        &spl_token_2022::id(),
    );

    // Derive encryption keys
    let elgamal_keypair = ElGamalKeypair::new_from_signer(
        authority,
        &token_account.to_bytes(),
    )?;
    let aes_key = AeKey::new_from_signer(
        authority,
        &token_account.to_bytes(),
    )?;

    // Fetch account state
    let account_data = client.get_account(&token_account)?;
    let account = StateWithExtensions::<TokenAccount>::unpack(&account_data.data)?;
    let ct_extension = account.get_extension::<ConfidentialTransferAccount>()?;

    // Create withdraw account info helper
    let withdraw_info = WithdrawAccountInfo::new(ct_extension);

    // Decrypt available balance to verify sufficiency
    let available_balance: spl_token_2022::solana_zk_sdk::encryption::elgamal::ElGamalCiphertext =
        withdraw_info.available_balance.try_into()
            .map_err(|_| "Failed to convert available_balance")?;
    let current_available = available_balance.decrypt_u32(elgamal_keypair.secret())
        .ok_or("Failed to decrypt available balance")?;

    if current_available < amount {
        return Err(format!(
            "Insufficient confidential balance: have {}, need {}",
            current_available, amount
        ).into());
    }

    // Generate withdrawal proofs using the helper
    let proof_data = withdraw_info.generate_proof_data(
        amount,
        &elgamal_keypair,
        &aes_key,
    )?;

    // Calculate new decryptable available balance after withdrawal
    let new_available = current_available - amount;
    let new_decryptable_balance = aes_key.encrypt(new_available);

    // Build withdraw instruction with two proof locations (equality + range)
    let withdraw_instructions = withdraw(
        &spl_token_2022::id(),
        &token_account,
        mint,
        amount,
        decimals,
        &new_decryptable_balance.into(),
        &authority.pubkey(),
        &[&authority.pubkey()],
        ProofLocation::InstructionOffset(1.try_into().unwrap(), &proof_data.equality_proof_data),
        ProofLocation::InstructionOffset(2.try_into().unwrap(), &proof_data.range_proof_data),
    )?;

    let recent_blockhash = client.get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &withdraw_instructions,
        Some(&payer.pubkey()),
        &[payer, authority],
        recent_blockhash,
    );

    let signature = client.send_and_confirm_transaction(&transaction)?;
    Ok(signature)
}
```

## Reading Balances

To read and decrypt all balance types:

```rust
pub fn get_confidential_balances(
    client: &RpcClient,
    authority: &dyn Signer,
    mint: &solana_sdk::pubkey::Pubkey,
) -> Result<(u64, u64, u64), Box<dyn std::error::Error>> {
    let token_account = get_associated_token_address_with_program_id(
        &authority.pubkey(),
        mint,
        &spl_token_2022::id(),
    );

    let elgamal_keypair = ElGamalKeypair::new_from_signer(authority, &token_account.to_bytes())?;
    let aes_key = AeKey::new_from_signer(authority, &token_account.to_bytes())?;

    let account_data = client.get_account(&token_account)?;
    let account = StateWithExtensions::<TokenAccount>::unpack(&account_data.data)?;
    let ct_extension = account.get_extension::<ConfidentialTransferAccount>()?;

    // Public balance (visible to all)
    let public_balance = account.base.amount;

    // Pending balance (decrypt with ElGamal) - note method is on ciphertext
    let pending_lo_ct: spl_token_2022::solana_zk_sdk::encryption::elgamal::ElGamalCiphertext =
        ct_extension.pending_balance_lo.try_into()?;
    let pending_hi_ct: spl_token_2022::solana_zk_sdk::encryption::elgamal::ElGamalCiphertext =
        ct_extension.pending_balance_hi.try_into()?;

    let pending_lo = pending_lo_ct.decrypt_u32(elgamal_keypair.secret()).unwrap_or(0) as u64;
    let pending_hi = pending_hi_ct.decrypt_u32(elgamal_keypair.secret()).unwrap_or(0) as u64;
    let pending_balance = pending_lo + (pending_hi << 16);

    // Available balance (decrypt with AES - only owner can see)
    let available_balance = aes_key.decrypt(&ct_extension.decryptable_available_balance.try_into()?)?;

    Ok((public_balance, pending_balance, available_balance))
}
```

## Security Considerations

- **Key derivation is deterministic**: The same keypair always produces the same encryption keys for a given token account. This enables recovery but means keypair compromise exposes all confidential balances.
- **Auditor keys**: Mints can configure an auditor ElGamal public key that can decrypt all transfer amounts (but not balances).
- **Pending balance limits**: The `max_pending_balance_credit_counter` limits how many incoming transfers can accumulate before `apply_pending` must be called.
- **Proof verification**: All proofs are verified by the ZK ElGamal Proof Program onchain (`ZkE1Gama1Proof11111111111111111111111111111`).

## Reference Implementation

For complete working examples including mint creation, see:
https://github.com/gitteri/confidential-balances-exploration (Rust) and
https://github.com/catmcgee/confidential-transfers-explorer (TypeScript)

## Limitations

- Currently only works on ZK-Edge testnet (`https://zk-edge.surfnet.dev/`)
- Transfer operations require multiple transactions (7 total) due to proof size. This will be lower when larger transactions are merged into mainnet
- Proof generation can be computationally intensive (client-side)
- Sender must be a `Keypair` (not generic `Signer`) for transfers due to token client requirements


---

# frontend-framework-kit

# Frontend with framework-kit (Next.js / React)

## Goals
- One Solana client instance for the app (RPC + WS + wallet connectors)
- Wallet Standard-first discovery/connect
- Minimal "use client" footprint in Next.js (hooks only in leaf components)
- Transaction sending that is observable, cancelable, and UX-friendly

## Recommended dependencies
- @solana/client
- @solana/react-hooks
- @solana/kit
- @solana-program/system, @solana-program/token, etc. (only what you need)

## Bootstrap recommendation
Prefer `create-solana-dapp` and pick a kit/framework-kit compatible template for new projects.

## Provider setup (Next.js App Router)
Create a single client and provide it via SolanaProvider.

Example `app/providers.tsx`:

```tsx
'use client';

import React from 'react';
import { SolanaProvider } from '@solana/react-hooks';
import { autoDiscover, createClient } from '@solana/client';

const endpoint =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

// Some environments prefer an explicit WS endpoint; default to wss derived from https.
const websocketEndpoint =
  process.env.NEXT_PUBLIC_SOLANA_WS_URL ??
  endpoint.replace('https://', 'wss://').replace('http://', 'ws://');

export const solanaClient = createClient({
  endpoint,
  websocketEndpoint,
  walletConnectors: autoDiscover(),
});

export function Providers({ children }: { children: React.ReactNode }) {
  return <SolanaProvider client={solanaClient}>{children}</SolanaProvider>;
}
```

Then wrap `app/layout.tsx` with `<Providers>`.

## Hook usage patterns (high-level)

Prefer framework-kit hooks before writing your own store/subscription logic:

* `useWalletConnection()` for connect/disconnect and wallet discovery
* `useBalance(...)` for lamports balance
* `useSolTransfer(...)` for SOL transfers
* `useSplToken(...)` / token helpers for token balances/transfers
* `useTransactionPool(...)` for managing send + status + retry flows

When you need custom instructions, build them using `@solana-program/*` and send them via the framework-kit transaction helpers.

## Data fetching and subscriptions

* Prefer watchers/subscriptions rather than manual polling.
* Clean up subscriptions with abort handles returned by watchers.
* For Next.js: keep server components server-side; only leaf components that call hooks should be client components.

## Transaction UX checklist

* Disable inputs while a transaction is pending
* Provide a signature immediately after send
* Track confirmation states (processed/confirmed/finalized) based on UX need
* Show actionable errors:

  * user rejected signing
  * insufficient SOL for fees / rent
  * blockhash expired / dropped
  * account already in use / already initialized
  * program error (custom error code)

## When to use ConnectorKit (optional)

If you need a headless connector with composable UI elements and explicit state control, use ConnectorKit.
Typical reasons:

* You want a headless wallet connection core (useful across frameworks)
* You want more control over wallet/account state than a single provider gives
* You need production diagnostics/health checks for wallet sessions


---

# idl-codegen

# IDLs + client generation (Codama / Shank / Kinobi)

## Goal
Never hand-maintain multiple program clients by manually re-implementing serializers.
Prefer an IDL-driven, code-generated workflow.

## Codama (preferred)
- Use Codama as the "single program description format" to generate:
  - TypeScript clients (including Kit-friendly output)
  - Rust clients (when available/needed)
  - documentation artifacts

## Anchor → Codama
If the program is Anchor:
1) Produce Anchor IDL from the build
2) Convert Anchor IDL to Codama nodes (nodes-from-anchor)
3) Render a Kit-native TypeScript client (codama renderers)

## Native Rust → Shank → Codama
If the program is native:
1) Use Shank macros to extract a Shank IDL from annotated Rust
2) Convert Shank IDL to Codama
3) Generate clients via Codama renderers

## Repository structure recommendation
- `programs/<name>/` (program source)
- `idl/<name>.json` (Anchor/Shank IDL)
- `codama/<name>.json` (Codama IDL)
- `clients/ts/<name>/` (generated TS client)
- `clients/rust/<name>/` (generated Rust client)

## Generation guardrails
- Codegen outputs should be checked into git if:
  - you need deterministic builds
  - you want users to consume the client without running codegen
- Otherwise, keep codegen in CI and publish artifacts.

## "Do not do this"
- Do not write IDLs by hand unless you have no alternative.
- Do not hand-write Borsh layouts for programs you own; use the IDL/codegen pipeline.


---

# kit-web3-interop

# Kit ↔ web3.js Interop (boundary patterns)

## The rule
- New code: Kit types and Kit-first APIs.
- Legacy dependencies: isolate web3.js-shaped types behind an adapter boundary.

## Preferred bridge: @solana/web3-compat
Use `@solana/web3-compat` when:
- A dependency expects `PublicKey`, `Keypair`, `Transaction`, `VersionedTransaction`, `Connection`, etc.
- You are migrating an existing web3.js codebase incrementally.

### Why this approach works
- web3-compat re-exports web3.js-like types and delegates to Kit where possible.
- It includes helper conversions to move between web3.js and Kit representations.

## Practical boundary layout
Keep these modules separate:

- `src/solana/kit/`:
  - all Kit-first code: addresses, instruction builders, tx assembly, typed codecs, generated clients

- `src/solana/web3/`:
  - adapters for legacy libs (Anchor TS client, older SDKs)
  - conversions between `PublicKey` and Kit `Address`
  - conversions between web3 `TransactionInstruction` and Kit instruction shapes (only at edges)

## Conversion helpers (examples)
Use web3-compat helpers such as:
- `toAddress(...)`
- `toPublicKey(...)`
- `toWeb3Instruction(...)`
- `toKitSigner(...)`

## When you still need @solana/web3.js
Some methods outside web3-compat's compatibility surface may fall back to a legacy web3.js implementation.
If that happens:
- keep `@solana/web3.js` as an explicit dependency
- isolate fallback usage to adapter modules only
- avoid letting `PublicKey` bleed into your core domain types

## Common mistakes to prevent
- Mixing `Address` and `PublicKey` throughout the app (causes type drift and confusion)
- Building transactions in one stack and signing in another without explicit conversion
- Passing web3.js `Connection` into Kit-native code (or vice versa) rather than using a single source of truth

## Decision checklist
If you're about to add web3.js:
1) Is there a Kit-native equivalent? Prefer Kit.
2) Is the only reason a dependency? Use web3-compat at the boundary.
3) Can you generate a Kit-native client (Codama) instead? Prefer codegen.


---

# payments

# Payments and commerce (optional)

## When payments are in scope
Use this guidance when the user asks about:
- checkout flows, tips, payment buttons
- payment request URLs / QR codes
- fee abstraction / gasless transactions

## Commerce Kit (preferred)
Use Commerce Kit as the default for payment experiences:
- drop-in payment UI components (buttons, modals, checkout flows)
- headless primitives for building custom checkout experiences
- React hooks for merchant/payment workflows
- built-in payment verification and confirmation handling
- support for SOL and SPL token payments

### When to use Commerce Kit
- You want a production-ready payment flow with minimal setup
- You need both UI components and headless APIs
- You want built-in best practices for payment verification
- You're building merchant experiences (tipping, checkout, subscriptions)

### Commerce Kit patterns
- Use the provided hooks for payment state management
- Leverage the built-in confirmation tracking (don't roll your own)
- Use the headless APIs when you need custom UI but want the payment logic handled

## Kora (gasless / fee abstraction)
Consider Kora when you need:
- sponsored transactions (user doesn't pay gas)
- users paying fees in tokens other than SOL
- a trusted signing / paymaster component

## UX and security checklist for payments
- Always show recipient + amount + token clearly before signing.
- Protect against replay (use unique references / memoing where appropriate).
- Confirm settlement by querying chain state, not by trusting client-side callbacks.
- Handle partial failures gracefully (transaction sent but not confirmed).
- Provide clear error messages for common failure modes (insufficient balance, rejected signature).


---

# programs-anchor

# Programs with Anchor (default choice)

## When to use Anchor
Use Anchor by default when:
- You want fast iteration with reduced boilerplate
- You want an IDL and TypeScript client story out of the box
- You want mature testing and workspace tooling
- You need built-in security through automatic account validation

## Core Advantages
- **Reduced Boilerplate**: Abstracts repetitive account management, instruction serialization, and error handling
- **Built-in Security**: Automatic account-ownership verification and data validation
- **IDL Generation**: Automatic interface definition for client generation

## Core Macros

### `declare_id!()`
Declares the onchain address where the program resides—a unique public key derived from the project's keypair.

### `#[program]`
Marks the module containing every instruction entrypoint and business-logic function.

### `#[derive(Accounts)]`
Lists accounts an instruction requires and automatically enforces their constraints:
- Declares all necessary accounts for specific instructions
- Enforces constraint checks automatically to block bugs and exploits
- Generates helper methods for safe account access and mutation

### `#[error_code]`
Enables custom, human-readable error types with `#[msg(...)]` attributes for clearer debugging.

## Account Types

| Type | Purpose |
|------|---------|
| `Signer<'info>` | Verifies the account signed the transaction |
| `SystemAccount<'info>` | Confirms System Program ownership |
| `Program<'info, T>` | Validates executable program accounts |
| `Account<'info, T>` | Typed program account with automatic validation |
| `UncheckedAccount<'info>` | Raw account requiring manual validation |

## Account Constraints

### Initialization
```rust
#[account(
    init,
    payer = payer,
    space = 8 + CustomAccount::INIT_SPACE
)]
pub account: Account<'info, CustomAccount>,
```

### PDA Validation
```rust
#[account(
    seeds = [b"vault", owner.key().as_ref()],
    bump
)]
pub vault: SystemAccount<'info>,
```

### Ownership and Relationships
```rust
#[account(
    has_one = authority @ CustomError::InvalidAuthority,
    constraint = account.is_active @ CustomError::AccountInactive
)]
pub account: Account<'info, CustomAccount>,
```

### Reallocation
```rust
#[account(
    mut,
    realloc = new_space,
    realloc::payer = payer,
    realloc::zero = true  // Clear old data when shrinking
)]
pub account: Account<'info, CustomAccount>,
```

### Closing Accounts
```rust
#[account(
    mut,
    close = destination
)]
pub account: Account<'info, CustomAccount>,
```

## Account Discriminators

Default discriminators use `sha256("account:<StructName>")[0..8]`. Custom discriminators (Anchor 0.31+):

```rust
#[account(discriminator = 1)]
pub struct Escrow { ... }
```

**Constraints:**
- Discriminators must be unique across your program
- Using `[1]` prevents using `[1, 2, ...]` which also start with `1`
- `[0]` conflicts with uninitialized accounts

## Instruction Patterns

### Basic Structure
```rust
#[program]
pub mod my_program {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, data: u64) -> Result<()> {
        ctx.accounts.account.data = data;
        Ok(())
    }
}
```

### Context Implementation Pattern
Move logic to context struct implementations for organization and testability:

```rust
impl<'info> Transfer<'info> {
    pub fn transfer_tokens(&mut self, amount: u64) -> Result<()> {
        // Implementation
        Ok(())
    }
}
```

## Cross-Program Invocations (CPIs)

### Basic CPI
```rust
let cpi_accounts = Transfer {
    from: ctx.accounts.from.to_account_info(),
    to: ctx.accounts.to.to_account_info(),
};
let cpi_program = ctx.accounts.system_program.to_account_info();
let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

transfer(cpi_ctx, amount)?;
```

### PDA-Signed CPIs
```rust
let seeds = &[b"vault".as_ref(), &[ctx.bumps.vault]];
let signer = &[&seeds[..]];
let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
```

## Error Handling

```rust
#[error_code]
pub enum MyError {
    #[msg("Custom error message")]
    CustomError,
    #[msg("Value too large: {0}")]
    ValueError(u64),
}

// Usage
require!(value > 0, MyError::CustomError);
require!(value < 100, MyError::ValueError(value));
```

## Token Accounts

### SPL Token
```rust
#[account(
    mint::decimals = 9,
    mint::authority = authority,
)]
pub mint: Account<'info, Mint>,

#[account(
    mut,
    associated_token::mint = mint,
    associated_token::authority = owner,
)]
pub token_account: Account<'info, TokenAccount>,
```

### Token2022 Compatibility
Use `InterfaceAccount` for dual compatibility:

```rust
use anchor_spl::token_interface::{Mint, TokenAccount};

pub mint: InterfaceAccount<'info, Mint>,
pub token_account: InterfaceAccount<'info, TokenAccount>,
pub token_program: Interface<'info, TokenInterface>,
```

## LazyAccount (Anchor 0.31+)

Heap-allocated, read-only account access for efficient memory usage:

```rust
// Cargo.toml
anchor-lang = { version = "0.31.1", features = ["lazy-account"] }

// Usage
pub account: LazyAccount<'info, CustomAccountType>,

pub fn handler(ctx: Context<MyInstruction>) -> Result<()> {
    let value = ctx.accounts.account.get_value()?;
    Ok(())
}
```

**Note:** LazyAccount is read-only. After CPIs, use `unload()` to refresh cached values.

## Zero-Copy Accounts

For accounts exceeding stack/heap limits:

```rust
#[account(zero_copy)]
pub struct LargeAccount {
    pub data: [u8; 10000],
}
```

Accounts under 10,240 bytes use `init`; larger accounts require external creation then `zero` constraint initialization.

## Remaining Accounts

Pass dynamic accounts beyond fixed instruction structure:

```rust
pub fn batch_operation(ctx: Context<BatchOp>, amounts: Vec<u64>) -> Result<()> {
    let remaining = &ctx.remaining_accounts;
    require!(remaining.len() % 2 == 0, BatchError::InvalidSchema);

    for (i, chunk) in remaining.chunks(2).enumerate() {
        process_pair(&chunk[0], &chunk[1], amounts[i])?;
    }
    Ok(())
}
```

## Version Management

- Use AVM (Anchor Version Manager) for reproducible builds
- Keep Solana CLI + Anchor versions aligned in CI and developer setup
- Pin versions in `Anchor.toml`

## Compatibility Notes for Anchor 0.32.0

To resolve build conflicts with certain crates in Anchor 0.32.0, run these cargo update commands in your project root:

```bash
cargo update base64ct --precise 1.6.0
cargo update constant_time_eq --precise 0.4.1
cargo update blake3 --precise 1.5.5
```

Additionally, if you encounter warnings about `solana-program` conflicts, add `solana-program = "3"` to the `[dependencies]` section in your program's `Cargo.toml` file (e.g., `programs/your-program/Cargo.toml`).


## Security Best Practices

### Account Validation
- Use typed accounts (`Account<'info, T>`) over `UncheckedAccount` when possible
- Always validate signer requirements explicitly
- Use `has_one` for ownership relationships
- Validate PDA seeds and bumps

### CPI Safety
- Use `Program<'info, T>` to validate CPI targets (prevents arbitrary CPI attacks)
- Never pass extra privileges to CPI callees
- Prefer explicit program IDs for known CPIs

### Common Gotchas
- **Avoid `init_if_needed`**: Permits reinitialization attacks
- **Legacy IDL formats**: Ensure tooling agrees on format (pre-0.30 vs new spec)
- **PDA seeds**: Ensure all seed material is stable and canonical

## Testing

- Use `anchor test` for end-to-end tests
- Prefer Mollusk or LiteSVM for fast unit tests
- Use Surfpool for integration tests with mainnet state

## IDL and Clients

- Treat the program's IDL as a product artifact
- Prefer generating Kit-native clients via Codama
- If using Anchor TS client in Kit-first app, put it behind web3-compat boundary


---

# programs-pinocchio

# Programs with Pinocchio

Pinocchio is a minimalist Rust crate for crafting Solana programs without the heavyweight `solana-program` crate. It delivers significant performance gains through zero-copy techniques and minimal dependencies.

## When to Use Pinocchio

Use Pinocchio when you need:

- **Maximum compute efficiency**: 84% CU savings compared to Anchor
- **Minimal binary size**: Leaner code paths and smaller deployments
- **Zero external dependencies**: Only Solana SDK types required
- **Fine-grained control**: Direct memory access and byte-level operations
- **no_std environments**: Embedded or constrained contexts

## Core Architecture

### Program Structure Validation Checklist

Before building/deploying, verify lib.rs contains all required components:

- [ ] `entrypoint!(process_instruction)` macro
- [ ] `pub const ID: Address = Address::new_from_array([...])` with correct program ID
- [ ] `fn process_instruction(program_id: &Address, accounts: &[AccountView], data: &[u8]) -> ProgramResult`
- [ ] Instruction routing logic with proper discriminators
- [ ] `pub mod instructions; pub use instructions::*;`

### Entrypoint Pattern

```rust
use pinocchio::{
    account::AccountView,
    address::Address,
    entrypoint,
    error::ProgramError,
    ProgramResult,
};

entrypoint!(process_instruction);

fn process_instruction(
    _program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    match instruction_data.split_first() {
        Some((0, data)) => Deposit::try_from((data, accounts))?.process(),
        Some((1, _)) => Withdraw::try_from(accounts)?.process(),
        _ => Err(ProgramError::InvalidInstructionData)
    }
}
```

Single-byte discriminators support 255 instructions; use two bytes for up to 65,535 variants.

### Panic Handler Configuration

**For std environments (SBF builds):**

```rust
entrypoint!(process_instruction);
// Remove nostd_panic_handler!() - std provides panic handling
```

**For no_std environments:**

```rust
#![no_std]
entrypoint!(process_instruction);
nostd_panic_handler!();
```

**Critical**: Never include both - causes duplicate lang item error in SBF builds.

### Program ID Declaration

```rust
pub const ID: Address = Address::new_from_array([
    // Your 32-byte program ID as bytes
    0xXX, 0xXX, ..., 0xXX,
]);
```

// Note: Use `Address::new_from_array()` not `Address::new()`

### Recommended Import Structure

```rust
use pinocchio::{
    account::AccountView,
    address::Address,
    entrypoint,
    error::ProgramError,
    ProgramResult,
};
// Add CPI imports only when needed:
// cpi::{invoke_signed, Seed, Signer},
// Add system program imports only when needed:
// pinocchio_system::instructions::Transfer,
```

### Instruction Structure

Separate validation from business logic using the `TryFrom` trait:

```rust
pub struct Deposit<'a> {
    pub accounts: DepositAccounts<'a>,
    pub data: DepositData,
}

impl<'a> TryFrom<(&'a [u8], &'a [AccountView])> for Deposit<'a> {
    type Error = ProgramError;

    fn try_from((data, accounts): (&'a [u8], &'a [AccountView])) -> Result<Self, Self::Error> {
        let accounts = DepositAccounts::try_from(accounts)?;
        let data = DepositData::try_from(data)?;
        Ok(Self { accounts, data })
    }
}

impl<'a> Deposit<'a> {
    pub const DISCRIMINATOR: &'a u8 = &0;

    pub fn process(&self) -> ProgramResult {
        // Business logic only - validation already complete
        Ok(())
    }
}
```

## Account Validation

Pinocchio requires manual validation. Wrap all checks in `TryFrom` implementations:

### Account Struct Validation

```rust
pub struct DepositAccounts<'a> {
    pub owner: &'a AccountView,
    pub vault: &'a AccountView,
    pub system_program: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for DepositAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [owner, vault, system_program, _remaining @ ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        // Signer check
        if !owner.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Owner check
        if !vault.owned_by(&pinocchio_system::ID) {
            return Err(ProgramError::InvalidAccountOwner);
        }

        // Program ID check (prevents arbitrary CPI)
        if system_program.address() != &pinocchio_system::ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        Ok(Self { owner, vault, system_program })
    }
}



        // Owner check
        if !vault.is_owned_by(&pinocchio_system::ID) {
            return Err(ProgramError::InvalidAccountOwner);
        }

        // Program ID check (prevents arbitrary CPI)
        if system_program.address() != &pinocchio_system::ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        Ok(Self { owner, vault, system_program })
    }
}
```

### Instruction Data Validation

```rust
pub struct DepositData {
    pub amount: u64,
}

impl<'a> TryFrom<&'a [u8]> for DepositData {
    type Error = ProgramError;

    fn try_from(data: &'a [u8]) -> Result<Self, Self::Error> {
        if data.len() != core::mem::size_of::<u64>() {
            return Err(ProgramError::InvalidInstructionData);
        }

        let amount = u64::from_le_bytes(data.try_into().unwrap());

        if amount == 0 {
            return Err(ProgramError::InvalidInstructionData);
        }

        Ok(Self { amount })
    }
}
```

## Token programs

Use the crates pinocchio-token and pinocchio-token2022

### SPL Token

```rust
use pinoccio_token::{instructions::InitializeMint2, state::Mint};

...
InitializeMint2 {
    mint: account,
    decimals,
    mint_authority,
    freeze_authority,
}.invoke()?;

let mint = Mint::from_account_view(account)?;
```

### Token2022

Token2022 provides a similar state struct

```rust
let mint = Mint::from_account_view(account)?;
```

## Cross-Program Invocations (CPIs)

### Basic CPI

```rust
use pinocchio_system::instructions::Transfer;

Transfer {
    from: self.accounts.owner,
    to: self.accounts.vault,
    lamports: self.data.amount,
}.invoke()?;
```

### PDA-Signed CPI

```rust
use pinocchio::cpi::{Seed, Signer};

let bump_byte = &[bump];
let seeds = [
    Seed::from(b"vault"),
    Seed::from(self.accounts.owner.address().as_ref()),
    Seed::from(&bump_byte),
];
let signers = [Signer::from(&seeds)];

Transfer {
    from: self.accounts.vault,
    to: self.accounts.owner,
    lamports: self.accounts.vault.lamports(),
}.invoke_signed(&signers)?;
```

## Reading and Writing Data

### Struct Field Ordering

Order fields from largest to smallest alignment to minimize padding:

```rust
// Good: 16 bytes total
#[repr(C)]
struct GoodOrder {
    big: u64,     // 8 bytes, 8-byte aligned
    medium: u16,  // 2 bytes, 2-byte aligned
    small: u8,    // 1 byte, 1-byte aligned
    // 5 bytes padding
}

// Bad: 24 bytes due to padding
#[repr(C)]
struct BadOrder {
    small: u8,    // 1 byte
    // 7 bytes padding
    big: u64,     // 8 bytes
    medium: u16,  // 2 bytes
    // 6 bytes padding
}
```

### Zero-Copy Reading (Safe Pattern)

Use byte arrays with accessor methods to avoid alignment issues:

```rust
#[repr(C)]
pub struct Config {
    pub authority: Pubkey,
    pub mint: Pubkey,
    seed: [u8; 8],   // Store as bytes
    fee: [u8; 2],    // Store as bytes
    pub state: u8,
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() != Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        // Safe: all fields are byte-aligned
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    pub fn seed(&self) -> u64 {
        u64::from_le_bytes(self.seed)
    }

    pub fn fee(&self) -> u16 {
        u16::from_le_bytes(self.fee)
    }

    pub fn set_seed(&mut self, seed: u64) {
        self.seed = seed.to_le_bytes();
    }

    pub fn set_fee(&mut self, fee: u16) {
        self.fee = fee.to_le_bytes();
    }
}
```

### Field-by-Field Serialization (Safest)

```rust
impl Config {
    pub fn write_to_buffer(&self, data: &mut [u8]) -> Result<(), ProgramError> {
        if data.len() != Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        let mut offset = 0;

        data[offset..offset + 32].copy_from_slice(self.authority.as_ref());
        offset += 32;

        data[offset..offset + 32].copy_from_slice(self.mint.as_ref());
        offset += 32;

        data[offset..offset + 8].copy_from_slice(&self.seed);
        offset += 8;

        data[offset..offset + 2].copy_from_slice(&self.fee);
        offset += 2;

        data[offset] = self.state;
        data[offset + 1] = self.bump;

        Ok(())
    }
}
```

### Dangerous Patterns to Avoid

```rust
// ❌ transmute with unaligned data
let value: u64 = unsafe { core::mem::transmute(bytes_slice) };

// ❌ Pointer casting to packed structs
#[repr(C, packed)]
pub struct Packed { pub a: u8, pub b: u64 }
let config = unsafe { &*(data.as_ptr() as *const Packed) };

// ❌ Direct field access on packed structs creates unaligned references
let b_ref = &packed.b;

// ❌ Assuming alignment without verification
let config = unsafe { &*(data.as_ptr() as *const Config) };
```

## Error Handling

Use `thiserror` for descriptive errors (supports `no_std`):

```rust
use thiserror::Error;
use num_derive::FromPrimitive;
use pinocchio::program_error::ProgramError;

#[derive(Clone, Debug, Eq, Error, FromPrimitive, PartialEq)]
pub enum VaultError {
    #[error("Lamport balance below rent-exempt threshold")]
    NotRentExempt,
    #[error("Invalid account owner")]
    InvalidOwner,
    #[error("Account not initialized")]
    NotInitialized,
}

impl From<VaultError> for ProgramError {
    fn from(e: VaultError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
```

## Closing Accounts Securely

Prevent revival attacks by marking closed accounts:

```rust
pub fn close(account: &AccountView, destination: &AccountView) -> ProgramResult {
    // Add lamports
    destination.set_lamports(destination.lamports() + account.lamports())?;

    // Close
    account.close()
}
```

## Performance Optimization

### Feature Flags

```toml
[features]
default = ["perf"]
perf = []
```

```rust
#[cfg(not(feature = "perf"))]
pinocchio::msg!("Instruction: Deposit");
```

### Bitwise Flags for Storage

Pack up to 8 booleans in one byte:

```rust
const FLAG_ACTIVE: u8 = 1 << 0;
const FLAG_FROZEN: u8 = 1 << 1;
const FLAG_ADMIN: u8 = 1 << 2;

// Set flag
flags |= FLAG_ACTIVE;

// Check flag
if flags & FLAG_ACTIVE != 0 { /* active */ }

// Clear flag
flags &= !FLAG_ACTIVE;
```

### Zero-Allocation Architecture

Use references instead of heap allocations:

```rust
// Good: references with borrowed lifetimes
pub struct Instruction<'a> {
    pub accounts: &'a [AccountView],
    pub data: &'a [u8],
}

// Enforce no heap usage
no_allocator!();
```

Respect Solana's memory limits: 4KB stack per function, 32KB total heap.

### Skip Redundant Checks

If a CPI will fail on incorrect accounts anyway, skip pre-validation:

```rust
// Instead of validating ATA derivation, compute expected address
let expected_ata = find_program_address(
    &[owner.address(), token_program.address(), mint.address()],
    &pinocchio_associated_token_account::ID,
).0;

if account.address() != &expected_ata {
    return Err(ProgramError::InvalidAccountData);
}
```

## Batch Instructions

Process multiple operations in a single CPI (saves ~1000 CU per batched operation):

```rust
const IX_HEADER_SIZE: usize = 2; // account_count + data_length

pub fn process_batch(mut accounts: &[AccountView], mut data: &[u8]) -> ProgramResult {
    loop {
        if data.len() < IX_HEADER_SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let account_count = data[0] as usize;
        let data_len = data[1] as usize;
        let data_offset = IX_HEADER_SIZE + data_len;

        if accounts.len() < account_count || data.len() < data_offset {
            return Err(ProgramError::InvalidInstructionData);
        }

        let (ix_accounts, ix_data) = (&accounts[..account_count], &data[IX_HEADER_SIZE..data_offset]);

        process_inner_instruction(ix_accounts, ix_data)?;

        if data_offset == data.len() {
            break;
        }

        accounts = &accounts[account_count..];
        data = &data[data_offset..];
    }

    Ok(())
}
```

## Testing

Use Mollusk or LiteSVM for fast Rust-based testing:

```rust
#[cfg(test)]
pub mod tests;

// Run with: cargo test-sbf
```

See [testing.md](testing.md) for detailed testing patterns with Mollusk and LiteSVM.

## Build & Deployment

### Build Validation

After `cargo build-sbf`:

- [ ] Check .so file size (>1KB, typically 5-15KB for Pinocchio programs)
- [ ] Verify file type: `file target/deploy/program.so` should show "ELF 64-bit LSB shared object"
- [ ] Test regular compilation: `cargo build` should succeed
- [ ] Run tests: `cargo test` should pass

### Dependency Compatibility Issues

**If SBF build fails with "edition2024" errors:**

```bash
# Downgrade problematic dependencies to compatible versions
cargo update base64ct --precise 1.6.0
cargo update constant_time_eq --precise 0.4.1
cargo update blake3 --precise 1.5.5
```

**When to apply**: Only when encountering Cargo "edition2024" errors during `cargo build-sbf`. These downgrades resolve toolchain compatibility issues while maintaining functionality.

**Note**: These specific versions were tested and verified to work with current Solana toolchain. Regular `cargo update` may pull incompatible versions.

## Security Checklist

- [ ] Validate all account owners in `TryFrom` implementations
- [ ] Check signer status for authority accounts
- [ ] Verify PDA derivation matches expected seeds
- [ ] Validate program IDs before CPIs (prevent arbitrary CPI)
- [ ] Use checked math (`checked_add`, `checked_sub`, etc.)
- [ ] Mark closed accounts to prevent revival attacks
- [ ] Validate instruction data length before parsing
- [ ] Check for duplicate mutable accounts when accepting multiple of same type


---

# resources

# Curated Resources (Source-of-Truth First)

## Learning Platforms
- [Blueshift](https://learn.blueshift.gg/) - Free, open-source Solana learning platform
- [Blueshift GitHub](https://github.com/blueshift-gg) - Course content and tools
- [Solana Cookbook](https://solanacookbook.com/)

## Core Solana Docs
- [Solana Documentation](https://solana.com/docs) (Core, RPC, Frontend, Programs)
- [Next.js + Solana React Hooks](https://solana.com/docs/frontend/nextjs-solana)
- [@solana/web3-compat](https://solana.com/docs/frontend/web3-compat)
- [RPC API Reference](https://solana.com/docs/rpc)

## Modern JS/TS SDK
- [@solana/kit Repository](https://github.com/anza-xyz/kit)
- [Solana Kit Docs](https://solana.com/docs/clients/kit) (installation, upgrade guide)

## UI and Wallet Infrastructure
- [framework-kit Repository](https://github.com/solana-foundation/framework-kit) (@solana/client, @solana/react-hooks)
- [ConnectorKit](https://github.com/civic-io/connector-kit) (headless Wallet Standard connector)

## Scaffolding
- [create-solana-dapp](https://github.com/solana-developers/create-solana-dapp)

## Program Frameworks

### Anchor
- [Anchor Repository](https://github.com/coral-xyz/anchor)
- [Anchor Documentation](https://www.anchor-lang.com/)
- [Anchor Version Manager (AVM)](https://www.anchor-lang.com/docs/avm)

### Pinocchio
- [Pinocchio Repository](https://github.com/anza-xyz/pinocchio)
- [pinocchio-system](https://crates.io/crates/pinocchio-system)
- [pinocchio-token](https://crates.io/crates/pinocchio-token)
- [Pinocchio Guide](https://github.com/vict0rcarvalh0/pinocchio-guide)
- [How to Build with Pinocchio (Helius)](https://www.helius.dev/blog/pinocchio)

## Testing

### LiteSVM
- [LiteSVM Repository](https://github.com/LiteSVM/litesvm)
- [litesvm crate](https://crates.io/crates/litesvm)
- [litesvm npm](https://www.npmjs.com/package/litesvm)

### Mollusk
- [Mollusk Repository](https://github.com/buffalojoec/mollusk)
- [mollusk-svm crate](https://crates.io/crates/mollusk-svm)

### Surfpool
- [Surfpool Documentation](https://docs.surfpool.run/)
- [Surfpool Repository](https://github.com/txtx/surfpool)

## IDLs and Codegen
- [Codama Repository](https://github.com/codama-idl/codama)
- [Codama Generating Clients](https://solana.com/docs/programs/codama-generating-clients)
- [Shank (Metaplex)](https://github.com/metaplex-foundation/shank)
- [Kinobi (Metaplex)](https://github.com/metaplex-foundation/kinobi)

## Tokens and NFTs
- [SPL Token Documentation](https://spl.solana.com/token)
- [Token-2022 Documentation](https://spl.solana.com/token-2022)
- [Metaplex Documentation](https://developers.metaplex.com/)

## Payments
- [Commerce Kit Repository](https://github.com/solana-foundation/commerce-kit)
- [Commerce Kit Documentation](https://commercekit.solana.com/)
- [Kora Documentation](https://docs.kora.network/)

## Security
- [Blueshift Program Security Course](https://learn.blueshift.gg/en/courses/program-security)
- [Solana Security Best Practices](https://solana.com/docs/programs/security)

## Performance and Optimization
- [Solana Optimized Programs](https://github.com/Laugharne/solana_optimized_programs)
- [sBPF Assembly SDK](https://github.com/blueshift-gg/sbpf)
- [Doppler Oracle (21 CU)](https://github.com/blueshift-gg/doppler)


---

# security

# Solana Security Checklist (Program + Client)

## Core Principle

Assume the attacker controls:

- Every account passed into an instruction
- Every instruction argument
- Transaction ordering (within reason)
- CPI call graphs (via composability)

---

## Vulnerability Categories

### 1. Missing Owner Checks

**Risk**: Attacker creates fake accounts with identical data structure and correct discriminator.

**Attack**: Without owner checks, deserialization succeeds for both legitimate and counterfeit accounts.

**Anchor Prevention**:

```rust
// Option 1: Use typed accounts (automatic)
pub account: Account<'info, ProgramAccount>,

// Option 2: Explicit constraint
#[account(owner = program_id)]
pub account: UncheckedAccount<'info>,
```

**Pinocchio Prevention**:

```rust
if !account.is_owned_by(&crate::ID) {
    return Err(ProgramError::InvalidAccountOwner);
}
```

---

### 2. Missing Signer Checks

**Risk**: Any account can perform operations that should be restricted to specific authorities.

**Attack**: Attacker locates target account, extracts owner pubkey, constructs transaction using real owner's address without their signature.

**Anchor Prevention**:

```rust
// Option 1: Use Signer type
pub authority: Signer<'info>,

// Option 2: Explicit constraint
#[account(signer)]
pub authority: UncheckedAccount<'info>,

// Option 3: Manual check
if !ctx.accounts.authority.is_signer {
    return Err(ProgramError::MissingRequiredSignature);
}
```

**Pinocchio Prevention**:

```rust
if !self.accounts.authority.is_signer() {
    return Err(ProgramError::MissingRequiredSignature);
}
```

---

### 3. Arbitrary CPI Attacks

**Risk**: Program blindly calls whatever program is passed as parameter, becoming a proxy for malicious code.

**Attack**: Attacker substitutes malicious program mimicking expected interface (e.g., fake SPL Token that reverses transfers).

**Anchor Prevention**:

```rust
// Use typed Program accounts
pub token_program: Program<'info, Token>,

// Or explicit validation
if ctx.accounts.token_program.key() != &spl_token::ID {
    return Err(ProgramError::IncorrectProgramId);
}
```

**Pinocchio Prevention**:

```rust
if self.accounts.token_program.key() != &pinocchio_token::ID {
    return Err(ProgramError::IncorrectProgramId);
}
```

---

### 4. Reinitialization Attacks

**Risk**: Calling initialization functions on already-initialized accounts overwrites existing data.

**Attack**: Attacker reinitializes account to become new owner, then drains controlled assets.

**Anchor Prevention**:

```rust
// Use init constraint (automatic protection)
#[account(init, payer = payer, space = 8 + Data::LEN)]
pub account: Account<'info, Data>,

// Manual check if needed
if ctx.accounts.account.is_initialized {
    return Err(ProgramError::AccountAlreadyInitialized);
}
```

**Critical**: Avoid `init_if_needed` - it permits reinitialization.

**Pinocchio Prevention**:

```rust
// Check discriminator before initialization
let data = account.try_borrow_data()?;
if data[0] == ACCOUNT_DISCRIMINATOR {
    return Err(ProgramError::AccountAlreadyInitialized);
}
```

---

### 5. PDA Sharing Vulnerabilities

**Risk**: Same PDA used across multiple users enables unauthorized access.

**Attack**: Shared PDA authority becomes "master key" unlocking multiple users' assets.

**Vulnerable Pattern**:

```rust
// BAD: Only mint in seeds - all vaults for same token share authority
seeds = [b"pool", pool.mint.as_ref()]
```

**Secure Pattern**:

```rust
// GOOD: Include user-specific identifiers
seeds = [b"pool", vault.key().as_ref(), owner.key().as_ref()]
```

---

### 6. Type Cosplay Attacks

**Risk**: Accounts with identical data structures but different purposes can be substituted.

**Attack**: Attacker passes controlled account type as different type parameter, bypassing authorization.

**Prevention**: Use discriminators to distinguish account types.

**Anchor**: Automatic 8-byte discriminator with `#[account]` macro.

**Pinocchio**:

```rust
// Validate discriminator before processing
let data = account.try_borrow_data()?;
if data[0] != EXPECTED_DISCRIMINATOR {
    return Err(ProgramError::InvalidAccountData);
}
```

---

### 7. Duplicate Mutable Accounts

**Risk**: Passing same account twice causes program to overwrite its own changes.

**Attack**: Sequential mutations on identical accounts cancel earlier changes.

**Prevention**:

```rust
// Anchor
if ctx.accounts.account_1.key() == ctx.accounts.account_2.key() {
    return Err(ProgramError::InvalidArgument);
}

// Pinocchio
if self.accounts.account_1.key() == self.accounts.account_2.key() {
    return Err(ProgramError::InvalidArgument);
}
```

---

### 8. Revival Attacks

**Risk**: Closed accounts can be restored within same transaction by refunding lamports.

**Attack**: Multi-instruction transaction drains account, refunds rent, exploits "closed" account.

**Secure Closure Pattern**:

```rust
// Anchor: Use close constraint
#[account(mut, close = destination)]
pub account: Account<'info, Data>,

// Pinocchio: Full secure closure
pub fn close(account: &AccountInfo, destination: &AccountInfo) -> ProgramResult {
    // 1. Add lamports
    destination.set_lamports(destination.lamports() + account.lamports())?;

    // 2. Close
    account.close()
}
```

---

### 9. Data Matching Vulnerabilities

**Risk**: Correct type/ownership validation but incorrect assumptions about data relationships.

**Attack**: Signer matches transaction but not stored owner field.

**Prevention**:

```rust
// Anchor: has_one constraint
#[account(has_one = authority)]
pub account: Account<'info, Data>,

// Pinocchio: Manual validation
let data = Config::from_bytes(&account.try_borrow_data()?)?;
if data.authority != *authority.key() {
    return Err(ProgramError::InvalidAccountData);
}
```

---

## Program-Side Checklist

### Account Validation

- [ ] Validate account owners match expected program
- [ ] Validate signer requirements explicitly
- [ ] Validate writable requirements explicitly
- [ ] Validate PDAs match expected seeds + bump
- [ ] Validate token mint ↔ token account relationships
- [ ] Validate rent exemption / initialization status
- [ ] Check for duplicate mutable accounts

### CPI Safety

- [ ] Validate program IDs before CPIs (no arbitrary CPI)
- [ ] Do not pass extra writable or signer privileges to callees
- [ ] Ensure invoke_signed seeds are correct and canonical

### Arithmetic and Invariants

- [ ] Use checked math (`checked_add`, `checked_sub`, `checked_mul`, `checked_div`)
- [ ] Avoid unchecked casts
- [ ] Re-validate state after CPIs when required

### State Lifecycle

- [ ] Close accounts securely (mark discriminator, drain lamports)
- [ ] Avoid leaving "zombie" accounts with lamports
- [ ] Gate upgrades and ownership transfers
- [ ] Prevent reinitialization of existing accounts

---

## Client-Side Checklist

- [ ] Cluster awareness: never hardcode mainnet endpoints in dev flows
- [ ] Simulate transactions for UX where feasible
- [ ] Handle blockhash expiry and retry with fresh blockhash
- [ ] Treat "signature received" as not-final; track confirmation
- [ ] Never assume token program variant; detect Token-2022 vs classic
- [ ] Validate transaction simulation results before signing
- [ ] Show clear error messages for common failure modes

---

## Security Review Questions

1. Can an attacker pass a fake account that passes validation?
2. Can an attacker call this instruction without proper authorization?
3. Can an attacker substitute a malicious program for CPI targets?
4. Can an attacker reinitialize an existing account?
5. Can an attacker exploit shared PDAs across users?
6. Can an attacker pass the same account for multiple parameters?
7. Can an attacker revive a closed account in the same transaction?
8. Can an attacker exploit mismatches between stored and provided data?


---

# surfpool-cheatcodes

# Surfpool Cheatcodes Reference

All 22 `surfnet_*` JSON-RPC methods available on the surfnet RPC endpoint (default `http://127.0.0.1:8899`).

Every request uses standard JSON-RPC 2.0 format:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "surfnet_<method>",
  "params": [...]
}
```

---

## Account Manipulation

### `surfnet_setAccount`

Set or update an account's state directly.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `pubkey` | `string` | Base-58 encoded public key |
| 2 | `update` | `object` | Fields to update |

**`update` fields** (all optional):

| Field | Type | Description |
|---|---|---|
| `lamports` | `u64` | Account balance in lamports |
| `data` | `string` | Base-64 encoded account data |
| `owner` | `string` | Base-58 program owner |
| `executable` | `bool` | Whether the account is executable |
| `rent_epoch` | `u64` | Rent epoch |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_setAccount",
  "params": [
    "5cQvx...",
    { "lamports": 1000000000, "owner": "11111111111111111111111111111111" }
  ]
}
```

**Returns:** `RpcResponse<()>`

---

### `surfnet_setTokenAccount`

Set or update an SPL token account.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `owner` | `string` | Token account owner (base-58) |
| 2 | `mint` | `string` | Token mint (base-58) |
| 3 | `update` | `object` | Token account fields to update |
| 4 | `token_program` | `string?` | Token program address (optional, defaults to Token Program) |

**`update` fields** (all optional):

| Field | Type | Description |
|---|---|---|
| `amount` | `string` | Token amount |
| `delegate` | `string?` | Delegate pubkey |
| `state` | `string` | Account state |
| `delegated_amount` | `string` | Delegated amount |
| `close_authority` | `string?` | Close authority pubkey |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_setTokenAccount",
  "params": [
    "5cQvx...",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    { "amount": "1000000000" }
  ]
}
```

**Returns:** `RpcResponse<()>`

---

### `surfnet_resetAccount`

Reset an account to its initial state (re-fetches from remote RPC if available).

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `pubkey` | `string` | Base-58 encoded public key |
| 2 | `config` | `object?` | Optional configuration |

**`config` fields:**

| Field | Type | Default | Description |
|---|---|---|---|
| `include_owned_accounts` | `bool` | `false` | Cascade reset to accounts owned by this account |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_resetAccount",
  "params": ["5cQvx..."]
}
```

**Returns:** `RpcResponse<()>`

---

### `surfnet_streamAccount`

Mark an account for automatic remote fetching and caching.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `pubkey` | `string` | Base-58 encoded public key |
| 2 | `config` | `object?` | Optional configuration |

**`config` fields:**

| Field | Type | Default | Description |
|---|---|---|---|
| `include_owned_accounts` | `bool` | `false` | Also stream accounts owned by this account |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_streamAccount",
  "params": ["5cQvx..."]
}
```

**Returns:** `RpcResponse<()>`

---

### `surfnet_getStreamedAccounts`

List all accounts currently marked for streaming.

**Parameters:** None.

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_getStreamedAccounts",
  "params": []
}
```

**Returns:** `RpcResponse<GetStreamedAccountsResponse>` — object containing streamed account addresses.

---

## Program Management

### `surfnet_cloneProgramAccount`

Copy a program (and its program data account) from one address to another.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `source_program_id` | `string` | Source program address (base-58) |
| 2 | `destination_program_id` | `string` | Destination program address (base-58) |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_cloneProgramAccount",
  "params": ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "MyCustomToken..."]
}
```

**Returns:** `RpcResponse<()>`

---

### `surfnet_setProgramAuthority`

Change a program's upgrade authority.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `program_id` | `string` | Program address (base-58) |
| 2 | `new_authority` | `string?` | New authority pubkey (omit to remove upgrade authority) |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_setProgramAuthority",
  "params": ["MyProgram...", "NewAuthority..."]
}
```

**Returns:** `RpcResponse<()>`

---

### `surfnet_writeProgram`

Deploy program data in chunks, bypassing transaction size limits (5MB RPC limit).

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `program_id` | `string` | Program address (base-58) |
| 2 | `data` | `string` | Hex-encoded program data chunk |
| 3 | `offset` | `number` | Byte offset to write at |
| 4 | `authority` | `string?` | Write authority (optional, defaults to system program) |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_writeProgram",
  "params": ["MyProgram...", "deadbeef...", 0]
}
```

**Returns:** `RpcResponse<()>`

---

### `surfnet_registerIdl`

Register an IDL for a program in memory.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `idl` | `object` | Full Anchor IDL object (address should match program pubkey) |
| 2 | `slot` | `number?` | Slot at which to register (defaults to latest) |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_registerIdl",
  "params": [{ "address": "MyProgram...", "metadata": {}, "instructions": [], "accounts": [] }]
}
```

**Returns:** `RpcResponse<()>`

---

### `surfnet_getActiveIdl`

Retrieve the registered IDL for a program.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `program_id` | `string` | Program address (base-58) |
| 2 | `slot` | `number?` | Slot to query at (defaults to latest) |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_getActiveIdl",
  "params": ["MyProgram..."]
}
```

**Returns:** `RpcResponse<Option<Idl>>` — the IDL object, or `null` if none registered.

---

## Time Control

### `surfnet_timeTravel`

Jump forward or backward in time on the local network.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `config` | `object?` | Time travel configuration (provide one field) |

**`config` fields** (mutually exclusive):

| Field | Type | Description |
|---|---|---|
| `absoluteTimestamp` | `u64` | Jump to a specific UNIX timestamp |
| `absoluteSlot` | `u64` | Jump to a specific slot |
| `absoluteEpoch` | `u64` | Jump to a specific epoch (1 epoch = 432,000 slots) |

**Example — jump to epoch 100:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_timeTravel",
  "params": [{ "absoluteEpoch": 100 }]
}
```

**Returns:** `EpochInfo` — the updated clock state.

---

### `surfnet_pauseClock`

Freeze slot advancement. No new slots are produced until resumed.

**Parameters:** None.

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_pauseClock",
  "params": []
}
```

**Returns:** `EpochInfo` — clock state at the moment of pause.

---

### `surfnet_resumeClock`

Resume slot advancement after a pause.

**Parameters:** None.

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_resumeClock",
  "params": []
}
```

**Returns:** `EpochInfo` — resumed clock state.

---

## Transaction Profiling

### `surfnet_profileTransaction`

Simulate a transaction without committing state and return compute-unit estimates with before/after account snapshots.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `transaction_data` | `string` | Base-64 encoded `VersionedTransaction` |
| 2 | `tag` | `string?` | Optional tag for grouping profiles |
| 3 | `config` | `object?` | Optional profile result configuration |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_profileTransaction",
  "params": ["AQAAAA..."]
}
```

**Returns:** `RpcResponse<UiKeyedProfileResult>` — CU estimates, logs, errors, and account snapshots.

---

### `surfnet_getTransactionProfile`

Retrieve a stored transaction profile by signature or UUID.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `signature_or_uuid` | `string` | Transaction signature (base-58) or UUID |
| 2 | `config` | `object?` | Optional profile result configuration |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_getTransactionProfile",
  "params": ["5wHu1qwD..."]
}
```

**Returns:** `RpcResponse<Option<UiKeyedProfileResult>>` — the profile, or `null` if not found.

---

### `surfnet_getProfileResultsByTag`

Retrieve all profiles associated with a tag.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `tag` | `string` | Tag to query |
| 2 | `config` | `object?` | Optional profile result configuration |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_getProfileResultsByTag",
  "params": ["my-test-suite"]
}
```

**Returns:** `RpcResponse<Option<Vec<UiKeyedProfileResult>>>` — array of profiles, or `null`.

---

## Network State

### `surfnet_setSupply`

Configure what `getSupply` returns.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `update` | `object` | Supply fields to override |

**`update` fields** (all optional):

| Field | Type | Description |
|---|---|---|
| `total` | `u64` | Total supply in lamports |
| `circulating` | `u64` | Circulating supply |
| `non_circulating` | `u64` | Non-circulating supply |
| `non_circulating_accounts` | `string[]` | Non-circulating account addresses |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_setSupply",
  "params": [{ "total": 500000000000000000, "circulating": 400000000000000000 }]
}
```

**Returns:** `RpcResponse<()>`

---

### `surfnet_resetNetwork`

Reset the entire network to its initial state.

**Parameters:** None.

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_resetNetwork",
  "params": []
}
```

**Returns:** `RpcResponse<()>`

---

### `surfnet_getLocalSignatures`

Get recent transaction signatures with logs and errors.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `limit` | `number?` | Max signatures to return (default 50) |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_getLocalSignatures",
  "params": [10]
}
```

**Returns:** `RpcResponse<Vec<RpcLogsResponse>>` — array of signatures with logs.

---

### `surfnet_getSurfnetInfo`

Get network information including runbook execution history.

**Parameters:** None.

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_getSurfnetInfo",
  "params": []
}
```

**Returns:** `RpcResponse<GetSurfnetInfoResponse>`

---

### `surfnet_exportSnapshot`

Export all account state as a JSON snapshot.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `config` | `object?` | Optional export configuration |

**`config` fields:**

| Field | Type | Description |
|---|---|---|
| `includeParsedAccounts` | `bool` | Include parsed account data |
| `filter` | `object?` | Filter: `includeProgramAccounts`, `includeAccounts`, `excludeAccounts` |
| `scope` | `object?` | Scope: `"network"` (default) or `{"preTransaction": "<base64_tx>"}` |

**Example — export full network state:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_exportSnapshot",
  "params": []
}
```

**Example — export with filters:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_exportSnapshot",
  "params": [{
    "includeParsedAccounts": true,
    "filter": { "includeAccounts": ["5cQvx...", "8bRz..."] }
  }]
}
```

**Returns:** `RpcResponse<BTreeMap<String, AccountSnapshot>>` — map of pubkeys to account snapshots. Load snapshots on start with `surfpool start --snapshot ./export.json`.

---

## Scenarios

### `surfnet_registerScenario`

Register a set of account overrides on a timeline.

**Parameters:**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `scenario` | `object` | Scenario definition |
| 2 | `slot` | `number?` | Base slot for relative slot calculations (defaults to current) |

**`scenario` fields:**

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique identifier (UUID v4) |
| `name` | `string` | Human-readable name |
| `description` | `string` | Description |
| `tags` | `string[]` | Tags for categorization |
| `overrides` | `object[]` | Array of override instances |

**`overrides[]` fields:**

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique override identifier |
| `templateId` | `string` | Reference to an override template |
| `values` | `object` | Map of field paths to override values |
| `scenarioRelativeSlot` | `u64` | Slot offset from base when override applies |
| `label` | `string?` | Optional label |
| `enabled` | `bool` | Whether this override is active |
| `fetchBeforeUse` | `bool` | Fetch fresh data before applying (for price feeds) |
| `account` | `object` | Account specifier (pubkey or PDA) |

**Example:**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "surfnet_registerScenario",
  "params": [{
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "SOL price drop",
    "description": "Simulate SOL dropping to $50",
    "tags": ["oracle", "testing"],
    "overrides": [{
      "id": "override-1",
      "templateId": "pyth-sol-usd-v2",
      "scenarioRelativeSlot": 0,
      "label": "Set SOL price to $50",
      "enabled": true,
      "fetchBeforeUse": false,
      "account": { "type": "pubkey", "value": "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE" },
      "values": {
        "price_message.price": 5000000000,
        "price_message.publish_time": 1700000000
      }
    }]
  }]
}
```

**Returns:** `RpcResponse<()>`

See [surfpool-scenarios.md](surfpool-scenarios.md) for all available templates and protocol details.


---

# surfpool

# Surfpool Reference

## What is Surfpool

Surfpool is a drop-in replacement for `solana-test-validator` built on [LiteSVM](https://github.com/LiteSVM/litesvm). It provides a local Solana network (called a "surfnet") with sub-second startup, automatic mainnet state cloning, transaction profiling, and a built-in web UI (Studio).

Key differences from `solana-test-validator`:
- **Instant startup** — no genesis ledger to bootstrap; the SVM runs in-process.
- **Mainnet state on demand** — accounts are lazily fetched from a remote RPC and cached locally. No need to pre-clone accounts.
- **Cheatcodes** — 22 `surfnet_*` RPC methods to manipulate time, accounts, programs, and scenarios without restarting.
- **Transaction profiling** — compute-unit estimation with before/after account snapshots.
- **Scenario system** — override protocol state (Pyth, Jupiter, Raydium, etc.) to simulate market conditions.
- **Infrastructure as Code** — define deployment runbooks in `txtx.yml` and auto-execute on start.
- **MCP server** — expose surfnet operations as tool calls for AI agents.

## Installation

```bash
curl -sL https://run.surfpool.run/ | bash
```

Or install from source with Cargo:

```bash
cargo surfpool-install
```

Verify installation:

```bash
surfpool --version
```

## Quick Start

### Anchor Project

Start surfpool in the root of an Anchor workspace. It detects `txtx.yml` (or generates one) and deploys programs automatically:

```bash
cd my-anchor-project
surfpool start
```

Use `--watch` to auto-redeploy when `.so` files change in `target/deploy/`:

```bash
surfpool start --watch
```

For Anchor test suites, enable compatibility mode:

```bash
surfpool start --legacy-anchor-compatibility
```

### Mainnet State Cloning

Fork mainnet state with zero config — accounts are fetched lazily when accessed:

```bash
surfpool start --network mainnet
```

Use a custom RPC for better rate limits:

```bash
surfpool start --rpc-url https://my-rpc-provider.com
```

Run fully offline (no remote fetching):

```bash
surfpool start --offline
```

### CI Mode

Start with CI-optimized defaults (no TUI, no Studio, no profiling, no logs):

```bash
surfpool start --ci
```

Run as a background daemon (Linux only):

```bash
surfpool start --ci --daemon
```

## When to Use Surfpool

| Criterion | surfpool | solana-test-validator | litesvm / bankrun |
|---|---|---|---|
| Startup time | Sub-second | 10-30 seconds | Sub-second |
| Architecture | In-process SVM (LiteSVM) | Full validator runtime | In-process SVM |
| RPC server | Full JSON-RPC on port 8899 | Full JSON-RPC on port 8899 | No RPC server (bankrun has limited BanksClient) |
| WebSocket support | Yes (port 8900) | Yes | No |
| Mainnet state | Lazy clone on first access | Manual `--clone` per account | Manual account setup |
| Account manipulation | 22 cheatcode RPC methods | None (restart + `--account` files) | Direct `set_account()` in-process |
| Time control | `surfnet_timeTravel`, `pauseClock`, `resumeClock` | `--slots-per-epoch`, warp via CLI | `warp_to_slot()` in-process |
| Transaction profiling | Built-in CU profiling with snapshots | None | None |
| Program hot-reload | `--watch` flag | Restart required | Restart required |
| Web UI | Studio (port 18488) | None | None |
| Protocol scenarios | 8 built-in protocols | None | None |
| MCP server | Built-in (`surfpool mcp`) | None | None |
| Geyser plugins | Supported | Supported | Not supported |
| CI mode | `--ci` flag | Manual config | Native (no server needed) |
| Infrastructure as Code | txtx.yml runbooks | None | None |
| Offline mode | `--offline` flag | Always offline | Always offline |
| Persistent state | `--db` flag (SQLite) | Ledger directory | None |

**Use surfpool** for local development, integration testing, mainnet forking, and CI pipelines that need an RPC endpoint.

**Use litesvm/bankrun** for unit-level program tests that run in-process without an RPC server.

**Use solana-test-validator** only when specific validator runtime behavior is required that surfpool does not yet replicate (vote processing, leader schedule, etc.).

### Decision Tree

- **Unit test exercising a single instruction in isolation?** Use litesvm (Rust) or bankrun (JS/Python).
- **Need a full JSON-RPC endpoint?** Use surfpool.
- **Need mainnet account state (tokens, programs, oracles)?** Use surfpool (lazy cloning).
- **Need to manipulate time, accounts, or protocol state at runtime?** Use surfpool (cheatcodes).
- **Local dev environment with hot-reload?** Use surfpool (`--watch`).
- **CI pipeline needing RPC?** Use `surfpool start --ci`.
- **DeFi scenario simulation?** Use surfpool (scenario system).
- **Full validator fidelity?** Use solana-test-validator.

### Summary Table

| Use Case | Recommended Tool |
|---|---|
| Unit testing a single instruction | litesvm / bankrun |
| Integration testing with RPC | surfpool |
| Local development with hot-reload | surfpool |
| Mainnet fork testing | surfpool |
| CI pipeline (needs RPC) | surfpool (`--ci`) |
| CI pipeline (in-process only) | litesvm / bankrun |
| DeFi scenario simulation | surfpool |
| AI agent-assisted development | surfpool (MCP server) |
| Full validator fidelity testing | solana-test-validator |

## Migration from solana-test-validator

Replace:

```bash
solana-test-validator \
  --clone TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA \
  --clone <account-1> \
  --clone <account-2> \
  --url https://api.mainnet-beta.solana.com \
  --reset
```

With:

```bash
surfpool start
```

Accounts are cloned lazily — no need to specify them upfront.

Replace account file loading:

```bash
solana-test-validator --account <pubkey> ./account.json
```

With snapshot loading:

```bash
surfpool start --snapshot ./accounts.json
```

Or use cheatcodes at runtime:

```bash
curl -X POST http://127.0.0.1:8899 -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"surfnet_setAccount","params":["<pubkey>",{"lamports":1000000000}]}'
```

### From litesvm/bankrun (adding RPC layer)

If in-process tests need to be promoted to integration tests with an RPC endpoint, start surfpool alongside:

```bash
surfpool start --ci
```

Then point the test client to `http://127.0.0.1:8899` instead of using the in-process bank.

## CLI Reference

### `surfpool start`

Start a local Solana network (surfnet). Alias: `surfpool simnet`.

#### Network Configuration

| Flag | Short | Default | Env Var | Description |
|---|---|---|---|---|
| `--port` | `-p` | `8899` | — | RPC port |
| `--ws-port` | `-w` | `8900` | — | WebSocket port |
| `--host` | `-o` | `127.0.0.1` | `SURFPOOL_NETWORK_HOST` | Bind address |
| `--rpc-url` | `-u` | — | `SURFPOOL_DATASOURCE_RPC_URL` | Custom datasource RPC URL (conflicts with `--network`) |
| `--network` | `-n` | — | — | Predefined network: `mainnet`, `devnet`, `testnet` (conflicts with `--rpc-url`) |
| `--offline` | — | `false` | — | Start without a remote RPC client |

#### Block Production

| Flag | Short | Default | Description |
|---|---|---|---|
| `--slot-time` | `-t` | `400` | Slot time in milliseconds |
| `--block-production-mode` | `-b` | `clock` | Block production mode: `clock`, `transaction`, `manual` |

Modes:
- `clock` — advance slots at a fixed interval (default, `400ms`)
- `transaction` — advance a slot only when a transaction is received
- `manual` — slots only advance via explicit RPC calls

#### Airdrops

| Flag | Short | Default | Description |
|---|---|---|---|
| `--airdrop` | `-a` | — | Pubkey(s) to airdrop SOL to on start. Repeatable. |
| `--airdrop-amount` | `-q` | `10000000000000` | Amount of lamports to airdrop (default ~10,000 SOL) |
| `--airdrop-keypair-path` | `-k` | `~/.config/solana/id.json` | Keypair file(s) to airdrop to. Repeatable. |

#### Deployment & Runbooks

| Flag | Short | Default | Description |
|---|---|---|---|
| `--manifest-file-path` | `-m` | `./txtx.yml` | Path to the runbook manifest |
| `--runbook` | `-r` | `deployment` | Runbook ID(s) to execute. Repeatable. |
| `--runbook-input` | `-i` | — | JSON input file(s) for runbooks. Repeatable. |
| `--no-deploy` | — | `false` | Disable auto deployment |
| `--yes` | `-y` | `false` | Skip runbook generation prompts |
| `--watch` | — | `false` | Auto re-execute deployment on `.so` file changes in `target/deploy/` |

#### Anchor Compatibility

| Flag | Short | Default | Description |
|---|---|---|---|
| `--legacy-anchor-compatibility` | — | `false` | Apply Anchor test suite defaults |
| `--anchor-test-config-path` | — | — | Path(s) to `Test.toml` files. Repeatable. |

#### Studio

| Flag | Short | Default | Description |
|---|---|---|---|
| `--studio-port` | `-s` | `18488` | Studio web UI port |
| `--no-studio` | — | `false` | Disable Studio |

#### Profiling & Logging

| Flag | Short | Default | Description |
|---|---|---|---|
| `--disable-instruction-profiling` | — | `false` | Disable instruction profiling |
| `--max-profiles` | `-c` | `200` | Max transaction profiles to hold in memory |
| `--log-level` | `-l` | `info` | Log level: `trace`, `debug`, `info`, `warn`, `error`, `none` |
| `--log-path` | — | `.surfpool/logs` | Log file directory |
| `--log-bytes-limit` | — | `10000` | Max bytes in transaction logs (0 = unlimited) |

#### SVM Features

| Flag | Short | Default | Description |
|---|---|---|---|
| `--feature` | `-f` | — | Enable specific SVM features. Repeatable. |
| `--disable-feature` | — | — | Disable specific SVM features. Repeatable. |
| `--features-all` | — | `false` | Enable all SVM features (override mainnet defaults) |

By default, surfpool uses mainnet feature flags.

#### Plugins & Subgraphs

| Flag | Short | Default | Description |
|---|---|---|---|
| `--geyser-plugin-config` | `-g` | — | Geyser plugin config file(s). Repeatable. |
| `--subgraph-db` | `-d` | `:memory:` | Subgraph database URL (SQLite or Postgres) |

#### Persistence & Snapshots

| Flag | Short | Default | Description |
|---|---|---|---|
| `--db` | — | — | Surfnet database URL for persistent state (`:memory:` or `*.sqlite`) |
| `--surfnet-id` | — | `default` | Unique ID to isolate database storage across instances |
| `--snapshot` | — | — | JSON snapshot file(s) to preload accounts from. Repeatable. |

#### Telemetry

| Flag | Short | Default | Env Var | Description |
|---|---|---|---|---|
| `--metrics-enabled` | — | `false` | `SURFPOOL_METRICS_ENABLED` | Enable Prometheus metrics |
| `--metrics-addr` | — | `0.0.0.0:9000` | `SURFPOOL_METRICS_ADDR` | Prometheus endpoint address |

#### Process Control

| Flag | Short | Default | Description |
|---|---|---|---|
| `--no-tui` | — | `false` | Stream logs instead of terminal UI |
| `--daemon` | — | `false` | Run as background process (Linux only) |
| `--ci` | — | `false` | CI mode (sets `--no-tui`, `--no-studio`, `--disable-instruction-profiling`, `--log-level none`) |
| `--skip-signature-verification` | — | `false` | Skip signature verification for all transactions |

### `surfpool run`

Execute a runbook from the manifest.

| Flag | Short | Default | Description |
|---|---|---|---|
| `--manifest-file-path` | `-m` | `./txtx.yml` | Path to the manifest |
| `--unsupervised` | `-u` | `false` | Execute without interactive supervision |
| `--browser` | `-b` | `false` | Supervise via browser UI |
| `--terminal` | `-t` | `false` | Supervise via terminal (coming soon) |
| `--output-json` | — | — | Output results as JSON. Optional directory path. |
| `--output` | — | — | Pick a specific output to stdout |
| `--explain` | — | `false` | Explain execution plan without running |
| `--env` | — | — | Environment from txtx.yml |
| `--input` | — | — | Input file(s) for batch processing. Repeatable. |
| `--force` | `-f` | `false` | Execute even if cached state shows already executed |
| `--log-level` | `-l` | `info` | Log level |
| `--log-path` | — | `.surfpool/logs` | Log directory |

Positional argument: `<runbook>` — runbook name or `.tx` file path.

```bash
# Execute interactively in browser
surfpool run deployment

# Execute without supervision, output JSON
surfpool run deployment --unsupervised --output-json ./outputs/

# Force re-execution
surfpool run deployment --unsupervised --force
```

### `surfpool ls`

List runbooks in the current directory.

| Flag | Short | Default | Description |
|---|---|---|---|
| `--manifest-file-path` | `-m` | `./txtx.yml` | Path to the manifest |

### `surfpool mcp`

Start the MCP (Model Context Protocol) server for AI agent integrations. No additional flags.

```bash
surfpool mcp
```

### `surfpool completions`

Generate shell completion scripts. Alias: `surfpool completion`.

Positional argument: `<shell>` — `bash`, `zsh`, `fish`, `elvish`, `powershell`.

```bash
surfpool completions zsh
```

### Environment Variables

| Variable | Description | Used By |
|---|---|---|
| `SURFPOOL_DATASOURCE_RPC_URL` | Default datasource RPC URL | `--rpc-url` |
| `SURFPOOL_NETWORK_HOST` | Override bind host | `--host` |
| `SURFPOOL_METRICS_ENABLED` | Enable Prometheus metrics | `--metrics-enabled` |
| `SURFPOOL_METRICS_ADDR` | Prometheus endpoint address | `--metrics-addr` |

## Infrastructure as Code

Surfpool uses `txtx.yml` manifests and runbooks to define deployment workflows.

### Manifest Structure

Place a `txtx.yml` at the project root:

```yaml
name: my-project
runbooks:
  - name: deployment
    description: Deploy programs to localnet
    file: ./runbooks/deployment.tx
```

### Auto-Deploy with Watch

Combine `--watch` with runbooks to auto-redeploy on `.so` file changes:

```bash
surfpool start --watch --runbook deployment
```

### Runbook Inputs

Pass inputs to runbooks for parameterized deployments:

```bash
surfpool start --runbook-input params.json
```

## MCP Integration

Surfpool includes a built-in MCP (Model Context Protocol) server for AI agent integrations. The server communicates over stdio using the MCP protocol.

### Configuration

#### Claude Code

Add to `.claude/settings.json` or project-level `CLAUDE.md`:

```json
{
  "mcpServers": {
    "surfpool": {
      "command": "surfpool",
      "args": ["mcp"]
    }
  }
}
```

#### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "surfpool": {
      "command": "surfpool",
      "args": ["mcp"]
    }
  }
}
```

#### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "surfpool": {
      "command": "surfpool",
      "args": ["mcp"]
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|---|---|
| `start_surfnet` | Start a local Solana network. Default returns a shell command; `run_as_subprocess: true` starts in background. |
| `set_token_accounts` | Set SOL/SPL token balances for accounts on a running surfnet |
| `start_surfnet_with_token_accounts` | Start network + fund accounts in one call (background process) |
| `call_surfnet_rpc` | Call any RPC method (standard Solana or `surfnet_*` cheatcodes) on a running surfnet |
| `create_scenario` | Create a protocol state scenario. Read `override_templates` resource first. |
| `get_override_templates` | List available override templates |

### MCP Resources

| Resource URI | Description |
|---|---|
| `str:///rpc_endpoints` | List of all available RPC endpoints |
| `str:///override_templates` | All available scenario override templates |

### Agent Workflow via MCP

1. **Start surfnet:** Call `start_surfnet` or `start_surfnet_with_token_accounts`
2. **Set up state:** Use `set_token_accounts` to fund accounts, or `call_surfnet_rpc` with cheatcodes
3. **Create scenarios:** Read `override_templates`, then call `create_scenario`
4. **Execute transactions:** Use `call_surfnet_rpc` with `sendTransaction` or `simulateTransaction`
5. **Inspect results:** Use `call_surfnet_rpc` with `surfnet_getTransactionProfile` or `surfnet_exportSnapshot`

## Cheatcodes Overview

Surfpool exposes 22 `surfnet_*` JSON-RPC methods on the same port as the standard Solana RPC:

### Account Manipulation
- `surfnet_setAccount` — set lamports, data, owner, executable flag on any account
- `surfnet_setTokenAccount` — set SPL token account balances, delegates, state
- `surfnet_resetAccount` — restore an account to its initial state
- `surfnet_streamAccount` — mark an account for automatic remote fetching and caching
- `surfnet_getStreamedAccounts` — list all streamed accounts

### Program Management
- `surfnet_cloneProgramAccount` — copy a program from one address to another
- `surfnet_setProgramAuthority` — change a program's upgrade authority
- `surfnet_writeProgram` — deploy program data in chunks (bypasses TX size limits)
- `surfnet_registerIdl` — register an IDL for a program in memory
- `surfnet_getActiveIdl` — retrieve the registered IDL for a program

### Time Control
- `surfnet_timeTravel` — jump to an absolute timestamp, slot, or epoch
- `surfnet_pauseClock` — freeze slot advancement
- `surfnet_resumeClock` — resume slot advancement

### Transaction Profiling
- `surfnet_profileTransaction` — simulate a transaction and return CU estimates with account snapshots
- `surfnet_getTransactionProfile` — retrieve a stored profile by signature or UUID
- `surfnet_getProfileResultsByTag` — retrieve all profiles for a given tag

### Network State
- `surfnet_setSupply` — configure what `getSupply` returns
- `surfnet_resetNetwork` — reset the entire network to initial state
- `surfnet_getLocalSignatures` — get recent transaction signatures with logs
- `surfnet_getSurfnetInfo` — get network info including runbook execution history
- `surfnet_exportSnapshot` — export all account state as a JSON snapshot

### Scenarios
- `surfnet_registerScenario` — register a set of account overrides on a timeline

See [surfpool-cheatcodes.md](surfpool-cheatcodes.md) for full parameter schemas and JSON-RPC examples.

## Scenarios Overview

The scenario system allows overriding protocol account state to simulate market conditions, liquidation events, and oracle price movements without deploying mock contracts.

### Supported Protocols

| Protocol | Version | Account Types | Templates |
|---|---|---|---|
| Pyth | v2 | PriceUpdateV2 | SOL/USD, BTC/USD, ETH/USD, ETH/BTC |
| Jupiter | v6 | TokenLedger | Token ledger override |
| Raydium | CLMM v3 | PoolState | SOL/USDC, BTC/USDC, ETH/USDC |
| Switchboard | on-demand | SwitchboardQuote | Quote override |
| Meteora | DLMM v1 | LbPair | SOL/USDC, USDT/SOL |
| Kamino | v1 | Reserve, Obligation | Reserve state, reserve config, obligation health |
| Drift | v2 | PerpMarket, SpotMarket, User, State | Perp market, spot market, user state, global state |
| Whirlpool | v0.7.0 | Whirlpool | SOL/USDC, SOL/USDT, mSOL/SOL, ORCA/USDC |

See [surfpool-scenarios.md](surfpool-scenarios.md) for full template schemas and protocol details.

## Common Agent Workflows

### 1. Start a Local Network and Deploy a Program

```bash
surfpool start --watch
```

Surfpool detects `txtx.yml`, generates a deployment runbook if needed, deploys programs, and airdrops SOL to the default keypair. The RPC is available at `http://127.0.0.1:8899`.

### 2. Set Up Token Accounts for Testing

```bash
curl -X POST http://127.0.0.1:8899 -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"surfnet_setTokenAccount","params":["<OWNER>","<MINT>",{"amount":"1000000000"}]}'
```

### 3. Test Time-Sensitive Logic

```bash
# Pause
curl -X POST http://127.0.0.1:8899 -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"surfnet_pauseClock","params":[]}'

# Time travel to a future epoch
curl -X POST http://127.0.0.1:8899 -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"surfnet_timeTravel","params":[{"absoluteEpoch":100}]}'

# Resume
curl -X POST http://127.0.0.1:8899 -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"surfnet_resumeClock","params":[]}'
```

### 4. Profile Transaction Compute Units

```bash
curl -X POST http://127.0.0.1:8899 -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"surfnet_profileTransaction","params":["<BASE64_TX>"]}'
```

### 5. Export and Restore State

```bash
# Export snapshot
curl -X POST http://127.0.0.1:8899 -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"surfnet_exportSnapshot","params":[]}'

# Load on next start
surfpool start --snapshot ./snapshot.json
```


---

# testing

# Testing Strategy (LiteSVM / Mollusk / Surfpool)

## Testing Pyramid

1. **Unit tests (fast)**: LiteSVM or Mollusk
2. **Integration tests (realistic state)**: Surfpool
3. **Cluster smoke tests**: devnet/testnet/mainnet as needed

## LiteSVM

A lightweight Solana Virtual Machine that runs directly in your test process. Created by Aursen from Exotic Markets.

### When to Use LiteSVM

- Fast execution without validator overhead
- Direct account state manipulation
- Built-in performance profiling
- Multi-language support (Rust, TypeScript, Python)

### Rust Setup

```bash
cargo add --dev litesvm
```

```rust
use litesvm::LiteSVM;
use solana_sdk::{pubkey::Pubkey, signature::Keypair, transaction::Transaction};

#[test]
fn test_deposit() {
    let mut svm = LiteSVM::new();

    // Load your program
    let program_id = pubkey!("YourProgramId11111111111111111111111111111");
    svm.add_program_from_file(program_id, "target/deploy/program.so");

    // Create accounts
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    // Build and send transaction
    let tx = Transaction::new_signed_with_payer(
        &[/* instructions */],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );

    let result = svm.send_transaction(tx);
    assert!(result.is_ok());
}
```

### TypeScript Setup

```bash
npm i --save-dev litesvm
```

```typescript
import { LiteSVM } from 'litesvm';
import { PublicKey, Transaction, Keypair } from '@solana/web3.js';

const programId = new PublicKey("YourProgramId11111111111111111111111111111");
const svm = new LiteSVM();
svm.addProgramFromFile(programId, "target/deploy/program.so");

// Build transaction
const tx = new Transaction();
tx.recentBlockhash = svm.latestBlockhash();
tx.add(/* instructions */);
tx.sign(payer);

// Simulate first (optional)
const simulation = svm.simulateTransaction(tx);

// Execute
const result = svm.sendTransaction(tx);
```

### Account Types in LiteSVM

**System Accounts:**
- Payer accounts (contain lamports)
- Uninitialized accounts (empty, awaiting setup)

**Program Accounts:**
- Serialize with `borsh`, `bincode`, or `solana_program_pack`
- Calculate rent-exempt minimum balance

**Token Accounts:**
- Use `spl_token::state::Mint` and `spl_token::state::Account`
- Serialize with Pack trait

### Advanced LiteSVM Features

```rust
// Modify clock sysvar
svm.set_sysvar(&Clock { slot: 1000, .. });

// Warp to slot
svm.warp_to_slot(5000);

// Configure compute budget
svm.set_compute_budget(ComputeBudget { max_units: 400_000, .. });

// Toggle signature verification (useful for testing)
svm.with_sigverify(false);

// Check compute units used
let result = svm.send_transaction(tx)?;
println!("CUs used: {}", result.compute_units_consumed);
```

## Mollusk

A lightweight test harness providing direct interface to program execution without full validator runtime. Best for Rust-only testing with fine-grained control.

### When to Use Mollusk

- Fast execution for rapid development cycles
- Precise account state manipulation for edge cases
- Detailed performance metrics and CU benchmarking
- Custom syscall testing

### Setup

```bash
cargo add --dev mollusk-svm
cargo add --dev mollusk-svm-programs-token  # For SPL token helpers
cargo add --dev solana-sdk solana-program
```

### Basic Usage

```rust
use mollusk_svm::Mollusk;
use mollusk_svm::result::Check;
use solana_sdk::{account::Account, pubkey::Pubkey, instruction::Instruction};

#[test]
fn test_instruction() {
    let program_id = Pubkey::new_unique();
    let mollusk = Mollusk::new(&program_id, "target/deploy/program");

    // Create accounts
    let payer = (
        Pubkey::new_unique(),
        Account {
            lamports: 1_000_000_000,
            data: vec![],
            owner: solana_sdk::system_program::ID,
            executable: false,
            rent_epoch: 0,
        },
    );

    // Build instruction
    let instruction = Instruction {
        program_id,
        accounts: vec![/* account metas */],
        data: vec![/* instruction data */],
    };

    // Execute with validation
    mollusk.process_and_validate_instruction(
        &instruction,
        &[payer],
        &[
            Check::success(),
            Check::compute_units(50_000),
        ],
    );
}
```

### Token Program Helpers

```rust
use mollusk_svm_programs_token::token;

// Add token program to test environment
token::add_program(&mut mollusk);

// Create pre-configured token accounts
let mint_account = token::mint_account(decimals, supply, mint_authority);
let token_account = token::token_account(mint, owner, amount);
```

### CU Benchmarking

```rust
use mollusk_svm::MolluskComputeUnitBencher;

let bencher = MolluskComputeUnitBencher::new(mollusk)
    .must_pass(true)
    .out_dir("../target/benches");

bencher.bench(
    "deposit_instruction",
    &instruction,
    &accounts,
);
// Generates markdown report with CU usage and deltas
```

### Advanced Configuration

```rust
// Set compute budget
mollusk.set_compute_budget(200_000);

// Enable all feature flags
mollusk.set_feature_set(FeatureSet::all_enabled());

// Customize sysvars
mollusk.sysvars.clock = Clock {
    slot: 1000,
    epoch: 5,
    unix_timestamp: 1700000000,
    ..Default::default()
};
```

## Surfpool

SDK and tooling suite for integration testing with realistic cluster state. Surfnet is the local network component (drop-in replacement for solana-test-validator).

### When to Use Surfpool

- Complex CPIs requiring mainnet programs (e.g., Jupiter with 40+ accounts)
- Testing against realistic account state
- Time travel and block manipulation
- Account/program cloning between environments

### Setup

```bash
# Install Surfpool CLI
cargo install surfpool

# Start local Surfnet
surfpool start
```

### Connection Setup

```typescript
import { Connection } from '@solana/web3.js';

const connection = new Connection("http://localhost:8899", "confirmed");
```

### System Variable Control

```typescript
// Time travel to specific slot
await connection._rpcRequest('surfnet_timeTravel', [{
    absoluteSlot: 250000000
}]);

// Pause/resume block production
await connection._rpcRequest('surfnet_pauseClock', []);
await connection._rpcRequest('surfnet_resumeClock', []);
```

### Account Manipulation

```typescript
// Set account state
await connection._rpcRequest('surfnet_setAccount', [{
    pubkey: accountPubkey.toString(),
    lamports: 1000000000,
    data: Buffer.from(accountData).toString('base64'),
    owner: programId.toString(),
}]);

// Set token account
await connection._rpcRequest('surfnet_setTokenAccount', [{
    pubkey: ownerPubkey.toString(),        // Owner of the token account (wallet)
    mint: mintPubkey.toString(),
    owner: ownerPubkey.toString(),
    amount: "1000000",
}]);

// Clone account from another program
await connection._rpcRequest('surfnet_cloneProgramAccount', [{
    source: sourceProgramId.toString(),
    destination: destProgramId.toString(),
    account: accountPubkey.toString(),
}]);
```

### SOL Supply Configuration

```typescript
// Configure supply for economic edge case testing
await connection._rpcRequest('surfnet_setSupply', [{
    circulating: "500000000000000000",
    nonCirculating: "100000000000000000",
    total: "600000000000000000",
}]);
```

## Test Layout Recommendation

```
tests/
├── unit/
│   ├── deposit.rs      # LiteSVM or Mollusk
│   ├── withdraw.rs
│   └── mod.rs
├── integration/
│   ├── full_flow.rs    # Surfpool
│   └── mod.rs
└── fixtures/
    └── accounts.rs     # Shared test account setup
```

## CI Guidance

```yaml
jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run unit tests
        run: cargo test-sbf

  integration-tests:
    runs-on: ubuntu-latest
    needs: unit-tests
    steps:
      - uses: actions/checkout@v4
      - name: Start Surfpool
        run: surfpool start --background
      - name: Run integration tests
        run: cargo test --test integration
```

## Best Practices

- Keep unit tests as the default CI gate (fast feedback)
- Use deterministic PDAs and seeded keypairs for reproducibility
- Minimize fixtures; prefer programmatic account creation
- Profile CU usage during development to catch regressions
- Run integration tests in separate CI stage to control runtime


