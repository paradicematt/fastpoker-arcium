# Local Testing Guide — Arcium + Solana

## Prerequisites

- **WSL2 (Ubuntu)** — for Rust/Solana builds
- **Docker Engine** in WSL (v29.3.0+) — for Arcium MXE nodes (NOT Docker Desktop)
- **Node.js** v18+ — for TypeScript tests
- **Solana CLI** v2.1.21 — for `solana-test-validator`
- **Anchor CLI** v0.32.1 — via AVM (`avm install 0.32.1`)
- **Arcium CLI** v0.8.5 — installed via `arcup` (NOT npm). Binary at `~/.cargo/bin/arcium`
- **Rust stable 1.86.0** — for program builds via `cargo-build-sbf`
- **Rust nightly** — for encrypted-ixs circuit compilation (`arcis-interpreter`)

## Three Testing Modes

### 1. Mock Mode (`DEAL_MODE=mock`)
No MPC. Instant deals. For game logic testing.

```bash
# Uses existing smoke tests against local validator
# Start: anchor localnet (or arcium localnet)
# Tests use devnet_bypass_deal — deterministic shuffle from SlotHashes
DEAL_MODE=mock npx ts-node tests/smoke-test-game-loop.ts
```

### 2. Arcium Localnet MPC (`DEAL_MODE=arcium`)
Full MPC with real Rescue-cipher encryption. ~2-10s per computation.

```bash
# ONE COMMAND — starts validator + deploys programs + spins up Docker MPC nodes + DKG
wsl bash /mnt/j/Poker-Arc/scripts/start-arcium-localnet.sh

# Verify everything is up
wsl bash /mnt/j/Poker-Arc/scripts/check-localnet.sh

# Run Arcium E2E test (TODO)
DEAL_MODE=arcium npx ts-node tests/arcium-e2e-test.ts
```

### 3. Devnet MPC
Real Arcium network. ~10-30s callbacks. Future.

---

## Arcium Localnet Startup Flow (Detailed)

The `scripts/start-arcium-localnet.sh` script handles the full startup:

### Step 1: Environment Setup
- Sets PATH for Solana 2.1.21, AVM, Cargo
- Installs Anchor CLI **shim** at `/tmp/anchor-shim/anchor`:
  - Reports `anchor-cli 0.31.2` (satisfies Arcium CLI's hardcoded version check)
  - Delegates all real commands to `anchor-0.32.1` via AVM
  - **Why:** Arcium CLI 0.8.5 checks for Anchor 0.31.2, which was never publicly released (docs say 0.32.1)

### Step 2: Docker Cleanup
- Kills `solana-test-validator` if running
- Stops ALL Arcium Docker containers: `arx-node-*`, `arcium-trusted-dealer-*`, `recovery-node-*`
- Runs `docker compose down` on the artifacts compose file
- **Critical:** Must kill the trusted-dealer container — a stale dealer prevents DKG completion

### Step 3: Create ext4 Workspace
- Creates `/tmp/poker-arc-workspace` on native Linux filesystem
- Copies: `Anchor.toml`, `Arcium.toml`, `Cargo.toml`, `encrypted-ixs/`, `build/`, `artifacts/`, `target/deploy/*.so`, `programs/fastpoker/Cargo.toml`
- **Why:** `solana-test-validator` creates `admin.rpc` Unix domain socket in the ledger directory. UDS doesn't work on NTFS (`/mnt/j/`) in WSL. The validator appears to start but health checks fail silently.

### Step 4: `arcium localnet --skip-build`
From the ext4 workspace, this:
1. Generates genesis accounts (Arcium program, Lighthouse, MXE, Cluster, nodes)
2. Starts `anchor localnet` (which runs `solana-test-validator` with genesis)
3. Waits for validator to come online (up to 60s, startup_wait in Anchor.toml)
4. Starts Docker containers via `docker-compose-arx-env.yml` (4 arx-nodes + 1 trusted-dealer)
5. Waits for DKG ceremony to complete (up to 300s, localnet_timeout_secs in Arcium.toml)
6. DKG = Distributed Key Generation — nodes generate shared MXE encryption keys

### What Gets Deployed via Genesis
| Account | Address | Owner |
|---|---|---|
| FastPoker program | `BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N` | BPFLoaderUpgradeab1e |
| STEEL program | `9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6` | BPFLoaderUpgradeab1e |
| Arcium program | `Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ` | BPFLoaderUpgradeab1e |
| Lighthouse program | `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95` | BPFLoaderUpgradeab1e |
| MXE Account | `7MSDfoo86WnuUKZbUCYGhzixhF7n8ANSCVjugcxg28cf` | Arcium program |
| Cluster 0 | `CuTp9LKzoY9hy77TkrickLpVTUFgvnRfQHB9tnhG2ypt` | Arcium program |
| Mempool | `9rUSnh5VrMtRUrJrgAUwcyWvL9NYkscAsDFS5RjPW6Da` | Arcium program |

**Note:** Genesis programs have immutable authority (`11111111...`). To deploy updated code, you must restart the entire localnet.

### Post-Startup: Initialize Computation Definitions
After localnet is up, before MPC can be used:
```bash
# 1. Call initCompDefs on FastPoker program (registers 3 circuits with Arcium)
# 2. Upload circuit bytecode via @arcium-hq/client SDK uploadCircuit()
# 3. Finalize computation definitions
# (Script: TODO — arcium-init-circuits.ts)
```

---

## Environment Variables

| Variable | Values | Default | Description |
|---|---|---|---|
| `DEAL_MODE` | `tee`/`mock`/`arcium` | `tee` | Deal mechanism in crank service |
| `ARCIUM_CLUSTER_OFFSET` | number | `0` | MXE cluster offset (localnet always 0) |
| `FASTPOKER_PROGRAM_ID` | pubkey | `BGyLY...` | FastPoker program address |

## Docker Architecture

The `artifacts/docker-compose-arx-env.yml` runs the MPC infrastructure:

| Container | IP | Port | Role |
|---|---|---|---|
| `arcium-trusted-dealer` | `172.20.0.99` | 8012 | DKG coordinator + preprocessing |
| `arx-node-0` | `172.20.0.100` | 9091→metrics | MPC executor node |
| `arx-node-1` | `172.20.0.101` | 9092→metrics | MPC executor node |
| `arx-node-2` | `172.20.0.102` | 9093→metrics | MPC executor node |
| `arx-node-3` | `172.20.0.103` | 9094→metrics | MPC executor node |

Nodes connect to the validator via `host.docker.internal:8899` (Docker host gateway).

## Troubleshooting

### DKG Not Completing (Most Common Issue)
**Symptoms:** `arcium localnet` hangs at "Waiting for nodes to come online", eventually times out.

**Check 1 — Stale trusted dealer:**
```bash
docker ps -a --format 'table {{.Names}}\t{{.CreatedAt}}\t{{.Status}}'
```
If the trusted-dealer was created much earlier than the arx-nodes, it's stale. Fix:
```bash
docker stop $(docker ps -aq); docker rm $(docker ps -aq)
docker network prune -f
# Then restart localnet
```

**Check 2 — Nodes actually healthy but CLI timeout false-positive:**
```bash
curl http://localhost:9091/health  # Should return "OK"
curl http://localhost:9092/health
```
If nodes respond `OK`, the localnet IS working — the arcium CLI just didn't detect it. Use as-is.

**Check 3 — admin.rpc UDS missing:**
```bash
ls -la /tmp/poker-arc-workspace/.anchor/test-ledger/admin.rpc
```
If file doesn't exist or isn't a socket (`s` type), the workspace isn't on ext4. Re-run the startup script.

### Other Issues
- **`arcium localnet` → "Anchor CLI 0.31.2 required":** Ensure the shim is on PATH before real anchor
- **Validator not starting:** Check `startup_wait` in Anchor.toml (currently 60000ms)
- **Program deploy fails "authority mismatch":** Genesis programs are immutable — must restart localnet
- **MXE keys not set (error 0x1772):** DKG hasn't completed. Check trusted-dealer container.
- **Callback not arriving:** Check node logs: `tail -f /tmp/poker-arc-workspace/artifacts/arx_node_logs/*.log`
