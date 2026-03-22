# Fast Poker Arcium — Startup Guide

Complete step-by-step guide to start the Arcium localnet, initialize circuits, run the crank service, and execute E2E tests.

---

## Prerequisites

### Required Software (WSL2 on Windows)
- **WSL2** with Ubuntu 22.04+
- **Docker Desktop** (Windows) with WSL2 backend enabled
- **Solana CLI 2.1.21** (installed in WSL)
- **Arcium CLI 0.8.5** (installed in WSL via `avm`)
- **Anchor CLI 0.32.1** (installed in WSL via `avm`)
- **Rust 1.86.0** (stable, for SBF builds)
- **Rust nightly** (for Arcis circuit builds)
- **Node.js 18+** (for TypeScript scripts)

### Installation Commands (WSL)
```bash
# Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/v2.1.21/install)"

# Anchor Version Manager (avm)
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force

# Arcium CLI
avm install arcium 0.8.5
avm use arcium 0.8.5

# Anchor CLI
avm install 0.32.1
avm use 0.32.1

# Rust toolchains
rustup install 1.86.0
rustup default 1.86.0
rustup install nightly
```

### Project Setup
```bash
# Clone/navigate to project
cd /mnt/j/Poker-Arc

# Install Node dependencies
cd backend && npm install
cd ../client && npm install
cd ../encrypted-ixs && npm install
```

---

## Startup Sequence

### 1. Build Programs (One-Time or After Code Changes)

**Build Anchor program (fastpoker):**
```bash
wsl bash /mnt/j/Poker-Arc/build-anchor.sh
```
- Uses Rust 1.86.0 (SBF-compatible)
- Pins problematic crate versions (indexmap, proc-macro-crate)
- Runs `cargo-build-sbf` in `programs/fastpoker`
- Copies output `.so` to `target/deploy/fastpoker.so`
- **Time:** ~2-3 minutes

**Build Arcis circuits (encrypted-ixs):**
```bash
cd /mnt/j/Poker-Arc/encrypted-ixs
RUSTUP_TOOLCHAIN=nightly arcium build --skip-program
```
- Uses Rust nightly (Arcis requirement)
- Builds 4 circuits: `shuffle_and_deal`, `reveal_community`, `reveal_all_showdown`, `claim_hole_cards`
- Outputs to `build/` directory
- **Time:** ~30-60 seconds

**Build Steel program (poker_program):**
```bash
cd /mnt/j/Poker-Arc/contracts
anchor build
```
- Outputs to `contracts/target/deploy/poker_program.so`
- **Time:** ~1-2 minutes

---

### 2. Start Arcium Localnet

**CRITICAL:** Arcium localnet MUST run from a native Linux filesystem (ext4), NOT from `/mnt/j/` (NTFS), because:
- `solana-test-validator` creates `admin.rpc` Unix domain socket
- Unix domain sockets don't work on NTFS in WSL
- Arcium CLI checks `admin.rpc` for node health → fails on NTFS

**Start command:**
```bash
wsl bash /mnt/j/Poker-Arc/scripts/start-arcium-localnet.sh
```

**What it does:**
1. **Cleanup:** Kills old validator + Docker containers
2. **Workspace:** Mirrors project to `/tmp/poker-arc-workspace` (ext4)
3. **Copies:** `.so` files, circuits, configs, minimal source for Anchor parsing
4. **Starts:** `arcium localnet --skip-build`
   - Solana test validator (localhost:8899)
   - Arcium MXE program (genesis)
   - 4 Docker MPC nodes (arx-node-0 through arx-node-3)
   - Trusted dealer container (DKG coordinator)
5. **Networking fix:** Connects containers to default bridge (WSL2 host access)
6. **DKG:** Waits for Distributed Key Generation (timeout: 120s from `Arcium.toml`)

**Expected output:**
```
=== Environment ===
  Solana: solana-cli 2.1.21
  Arcium: arcium-cli 0.8.5
  Docker: Docker version 24.x.x
  Anchor: anchor-cli 0.31.2 [shim → real 0.32.1]

=== Cleaning up ===
  Stopped old Arcium Docker containers
  Cleanup done.

=== Creating ext4 workspace at /tmp/poker-arc-workspace ===
  Workspace ready.

=== Starting Arcium Localnet ===
  Working dir: /tmp/poker-arc-workspace (ext4 — UDS will work)
  This starts: validator + Arcium MXE program + 4 Docker nodes + DKG
  Timeout: 120s (from Arcium.toml)

  Waiting for Docker containers to start...
  All 4 Docker node containers detected
  Trusted dealer container detected
  Connecting containers to default bridge for host validator access...
    artifacts-arx-node-0-1 → bridge ✓
    artifacts-arx-node-1-1 → bridge ✓
    artifacts-arx-node-2-1 → bridge ✓
    artifacts-arx-node-3-1 → bridge ✓
    artifacts-arcium-trusted-dealer-1 → bridge ✓
  Done. Waiting for DKG (timeout=120s)...

[Arcium CLI output...]
✓ Localnet started successfully
```

**Time:** 
- First run: ~60-90 seconds (DKG + container startup)
- Subsequent runs: ~60-90 seconds (same — DKG always runs fresh)

**Verify localnet is running:**
```bash
wsl bash /mnt/j/Poker-Arc/scripts/check-localnet.sh
```
Expected: `✓ Validator RPC OK`, `✓ All 4 nodes healthy`

**Common issues:**
- **DKG timeout false-positive:** If `arcium localnet` reports timeout but `curl localhost:9091/health` returns `OK`, nodes ARE online — proceed.
- **Stale containers:** If DKG fails, ensure ALL containers are killed (including `arcium-trusted-dealer`) before restart.
- **Genesis programs immutable:** To deploy updated code, restart entire localnet (authority=`11111111...`).

---

### 3. Initialize Arcium Circuits (After Every Localnet Restart)

**REQUIRED:** Circuits must be initialized on-chain after every localnet restart.

**Copy localnet keypair for E2E tests:**
```bash
wsl bash -c "cp ~/.config/solana/id.json /mnt/j/Poker-Arc/backend/.localnet-keypair.json"
```

**Initialize circuits:**
```bash
cd /tmp/poker-arc-workspace
ARCIUM_CLUSTER_OFFSET=0 CIRCUIT_BUILD_DIR=../build npx ts-node --transpile-only /mnt/j/Poker-Arc/backend/arcium-init-circuits.ts
```

**What it does:**
1. Uploads 4 circuits to Arcium cluster (shuffle_and_deal, reveal_community, reveal_all_showdown, claim_hole_cards)
2. Creates CompDef accounts for each circuit
3. Finalizes circuits (required for MPC execution)

**Expected output:**
```
=== Arcium Circuit Initialization ===
  Cluster offset: 0
  Circuit build dir: ../build

Uploading shuffle_and_deal...
  ✓ Circuit uploaded
  ✓ CompDef created
  ✓ Circuit finalized

Uploading reveal_community...
  ✓ Circuit uploaded
  ✓ CompDef created
  ✓ Circuit finalized

Uploading reveal_all_showdown...
  ✓ Circuit uploaded
  ✓ CompDef created
  ✓ Circuit finalized

Uploading claim_hole_cards...
  ✓ Circuit uploaded
  ✓ CompDef created
  ✓ Circuit finalized

✅ All circuits initialized
```

**Time:** ~10-20 seconds

**Note:** `shuffle_and_deal` upload (13MB) may timeout, but genesis bytecode works. Finalization succeeds.

---

### 4. Start Crank Service (Optional for Manual Tests)

The crank service automates game progression: `start_game`, `arcium_deal`, `arcium_reveal_queue`, `arcium_showdown_queue`, `settle_hand`, `cashout`, `kick_inactive`.

**Start crank:**
```bash
cd /mnt/j/Poker-Arc/backend
DEAL_MODE=arcium npx ts-node --transpile-only crank-service.ts
```

**Environment variables:**
- `DEAL_MODE=arcium` — Use Arcium MPC for dealing (required)
- `RPC_URL` — Default: `http://127.0.0.1:8899`
- `ARCIUM_CLUSTER_OFFSET` — Default: `0`

**Expected output:**
```
╔════════════════════════════════════════════════════════════════╗
║  Fast Poker Crank Service — Arcium MPC Mode                  ║
╚════════════════════════════════════════════════════════════════╝

  RPC: http://127.0.0.1:8899
  Deal mode: arcium (MPC)
  Cluster offset: 0
  Poll interval: 3000ms

🔄 Starting crank loop...
  [Tick 1] Scanning tables...
  [Tick 1] 0 tables found
```

**Leave running in a separate terminal.**

---

### 5. Run E2E Tests

All tests assume:
- ✅ Localnet is running
- ✅ Circuits are initialized
- ✅ Crank is running (for stress test only)

#### Core E2E Tests

**Multi-max test (3p/6p/9p full game flow):**
```bash
cd /mnt/j/Poker-Arc/backend
ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only e2e-arcium-multimax.ts
```
- Tests: 3-player, 6-player, 9-player
- Flow: deal → preflop → flop → turn → river → showdown → settle
- **Time:** ~60-90 seconds (first MPC on fresh localnet: 5-15+ minutes preprocessing)

**Security tests (11 vectors):**
```bash
cd /mnt/j/Poker-Arc/backend
ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only e2e-security-tests.ts
```
- Tests: Card privacy, gap griefing, double action, unauthorized settle/start, non-player action, A1/A3/B3/B4 guards
- **Time:** ~30-60 seconds (+ MPC preprocessing if first run)

**Claim hole cards test (P2+ card viewing):**
```bash
cd /mnt/j/Poker-Arc/backend
ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only e2e-claim-cards.ts
```
- Tests: 3p, 6p, 9p — all players can decrypt their hole cards
- **Time:** ~60-90 seconds

**Stress test (requires crank running):**
```bash
cd /mnt/j/Poker-Arc/backend
ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only stress-test-crank.ts
```
- Creates 5 scenarios: HU idle, HU fold, HU leave, 3× parallel, 6-max sitout
- Monitors crank handling all tables autonomously
- **Time:** ~2-5 minutes (monitors for 120s)

#### Quick Smoke Tests

**Arcium deal smoke test:**
```bash
cd /mnt/j/Poker-Arc/backend
ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only smoke-test-arcium-deal.ts
```

**Privacy test:**
```bash
cd /mnt/j/Poker-Arc/backend
ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only smoke-test-privacy.ts
```

---

## MPC Timing Expectations

### First MPC Execution (Fresh Localnet)
- **shuffle_and_deal:** 5-15+ minutes (preprocessing: 2.9B ACUs)
- **Subsequent executions:** ~8 seconds

### After Preprocessing Cached
| Operation | Time |
|-----------|------|
| shuffle_and_deal | ~8s |
| reveal_community (flop/turn/river) | ~2s each |
| reveal_all_showdown | ~2s |
| claim_hole_cards | ~2s |
| **Full hand (all streets + showdown)** | ~18-20s |

---

## Troubleshooting

### Localnet won't start
```bash
# Kill everything and restart
wsl bash -c "pkill -f solana-test-validator; docker stop \$(docker ps -aq); docker rm \$(docker ps -aq)"
wsl bash /mnt/j/Poker-Arc/scripts/start-arcium-localnet.sh
```

### MPC computations timeout
- **First run:** Wait 5-15 minutes for preprocessing
- **Subsequent:** Check node logs: `docker logs artifacts-arx-node-0-1`
- **Verify circuits finalized:** Re-run `arcium-init-circuits.ts`

### Tests fail with "Account not found"
- **Circuits not initialized:** Run step 3 (circuit init)
- **Wrong cluster offset:** Ensure `ARCIUM_CLUSTER_OFFSET=0`

### Crank doesn't process tables
- **Check crank is running:** Look for `[Tick N] Scanning tables...` output
- **Check deal mode:** Must be `DEAL_MODE=arcium`
- **Check x25519 keys:** All players must have `set_x25519_key` called

### BLS verification fails (error 6001)
- **Expected on localnet:** Cluster keys don't match production
- **Workaround:** CPI context validation used instead
- **Production:** Re-enable BLS by building with `SKIP_BLS=0`

---

## Quick Reference

### Full Startup (from scratch)
```bash
# 1. Start localnet (WSL)
wsl bash /mnt/j/Poker-Arc/scripts/start-arcium-localnet.sh

# 2. New terminal: Initialize circuits (WSL)
wsl bash -c "cp ~/.config/solana/id.json /mnt/j/Poker-Arc/backend/.localnet-keypair.json"
cd /tmp/poker-arc-workspace
ARCIUM_CLUSTER_OFFSET=0 CIRCUIT_BUILD_DIR=../build npx ts-node --transpile-only /mnt/j/Poker-Arc/backend/arcium-init-circuits.ts

# 3. New terminal: Start crank (optional, Windows or WSL)
cd /mnt/j/Poker-Arc/backend
DEAL_MODE=arcium npx ts-node --transpile-only crank-service.ts

# 4. New terminal: Run tests (Windows or WSL)
cd /mnt/j/Poker-Arc/backend
ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only e2e-arcium-multimax.ts
```

### Restart Localnet (after code changes)
```bash
# 1. Rebuild programs
wsl bash /mnt/j/Poker-Arc/build-anchor.sh

# 2. Restart localnet
wsl bash /mnt/j/Poker-Arc/scripts/start-arcium-localnet.sh

# 3. Re-initialize circuits
wsl bash -c "cp ~/.config/solana/id.json /mnt/j/Poker-Arc/backend/.localnet-keypair.json"
cd /tmp/poker-arc-workspace
ARCIUM_CLUSTER_OFFSET=0 CIRCUIT_BUILD_DIR=../build npx ts-node --transpile-only /mnt/j/Poker-Arc/backend/arcium-init-circuits.ts

# 4. Restart crank (if running)
# Ctrl+C in crank terminal, then re-run start command
```

### Check Status
```bash
# Validator RPC
curl http://localhost:8899 -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'

# Arcium nodes
curl http://localhost:9091/health  # node-0
curl http://localhost:9092/health  # node-1
curl http://localhost:9093/health  # node-2
curl http://localhost:9094/health  # node-3

# Docker containers
docker ps --filter "name=arx"
```

---

## File Locations

### Build Outputs
- Anchor program: `target/deploy/fastpoker.so`
- Steel program: `contracts/target/deploy/poker_program.so`
- Arcis circuits: `build/*.circuit`

### Localnet Runtime
- Workspace: `/tmp/poker-arc-workspace/` (ext4, ephemeral)
- Ledger: `/tmp/poker-arc-workspace/test-ledger/`
- Artifacts: `/tmp/poker-arc-workspace/artifacts/`
- Node logs: `/tmp/poker-arc-workspace/artifacts/arx_node_logs/`

### Test Scripts
- E2E tests: `backend/e2e-*.ts`
- Smoke tests: `backend/smoke-test-*.ts`
- Stress test: `backend/stress-test-crank.ts`
- Legacy (broken): `backend/legacy/` (uses removed `devnet_bypass_deal`)

---

## Next Steps

After E2E tests pass:
1. **Frontend integration** — Wire encrypted card display + crank WebSocket events
2. **Devnet deployment** — Deploy with `SKIP_BLS=0` (BLS enabled)
3. **Performance monitoring** — HandCostLog tracking, ER integration if avg > $0.10/hand
