# Deployment Guide

## Environments

| Environment | RPC | Cluster Offset | Notes |
|---|---|---|---|
| Localnet | `http://127.0.0.1:8899` | 0 | Docker MXE nodes, `ARCIUM_CLUSTER_OFFSET=0` |
| Devnet | `https://devnet.helius-rpc.com/?api-key=...` | TBD | Arcium devnet cluster |
| Mainnet | TBD | TBD | Production |

## Program IDs

| Program | ID | .so Path |
|---|---|---|
| FastPoker (Anchor) | `BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N` | `target/deploy/fastpoker.so` |
| STEEL Tokenomics | `BaYBb2JtaVffVnQYk1TwDUwZskgdnZcnNawfVzj3YvkH` | `contracts/target/deploy/poker_program.so` |
| Arcium MXE | `Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ` | (built into localnet genesis) |

---

## Full Circuit Change Workflow (MUST follow exactly)

If you change ANY circuit code, ALL steps must be followed. Skipping steps causes stale bytecode → MPC deserialization failure.

```bash
# 1. Edit circuit
#    encrypted-ixs/src/lib.rs

# 2. Build circuits (copies to Linux FS, runs arcium build)
wsl bash /mnt/j/Poker-Arc/scripts/rebuild-circuits.sh

# 3. Update Rust constants (manual — check build output for new values)
#    init_comp_defs.rs: CIRCUIT_LEN_SHUFFLE, WEIGHT_SHUFFLE, output count
#    arcium_deal_callback.rs: HasSize::SIZE, NUM_OUTPUTS, index mapping

# 4. Build Anchor program
wsl bash /mnt/j/Poker-Arc/build-anchor.sh

# 5. Update genesis JSON files with new .arcis bytecode
#    (Required because uploadCircuit() skips existing accounts)
cd backend && npx ts-node --transpile-only ../scripts/update-genesis-circuits.ts

# 6. Restart localnet (picks up new genesis + program)
wsl bash /mnt/j/Poker-Arc/scripts/start-arcium-localnet.sh

# 7. Re-init computation definitions + upload circuit bytecode
cd backend && NODE_PATH=node_modules SOLANA_KEYPAIR=../scripts/localnet-keypair.json \
  npx ts-node --transpile-only ../scripts/arcium-init-circuits.ts

# 8. Verify on-chain bytecode matches local .arcis
cd backend && NODE_PATH=node_modules npx ts-node --transpile-only verify-circuit-data.ts

# 9. Smoke test
cd backend && NODE_PATH=node_modules ARCIUM_CLUSTER_OFFSET=0 ARCIUM_BASE_SEED=arcium \
  npx ts-node --transpile-only smoke-test-arcium-deal.ts
```

### Why Genesis Files Must Be Updated

`@arcium-hq/client`'s `uploadCircuit()` function checks if a raw circuit account already exists with sufficient size — if it does, **it skips the upload**. The `arcium localnet` command pre-seeds accounts from `artifacts/*.json` at genesis. So after a circuit change:

1. Genesis still contains OLD bytecode
2. `uploadCircuit()` sees the account exists → skips
3. On-chain bytecode ≠ local `.arcis` → MPC nodes fail with deserialization error

**Fix:** `scripts/update-genesis-circuits.ts` patches the genesis JSON files with fresh `.arcis` data before localnet restart. We also patched `backend/node_modules/@arcium-hq/client/build/index.cjs` to force re-upload even when accounts exist (look for `FORCE RE-UPLOADING` comments).

---

## Program-Only Change Workflow (no circuit changes)

```bash
# 1. Build program
wsl bash /mnt/j/Poker-Arc/build-anchor.sh

# 2. Restart localnet (genesis programs are immutable)
wsl bash /mnt/j/Poker-Arc/scripts/start-arcium-localnet.sh

# 3. Re-init circuits (computation definitions reference program ID)
cd backend && NODE_PATH=node_modules SOLANA_KEYPAIR=../scripts/localnet-keypair.json \
  npx ts-node --transpile-only ../scripts/arcium-init-circuits.ts
```

---

## Devnet Deployment

```bash
# Build + deploy Anchor program
wsl bash /mnt/j/Poker-Arc/deploy.sh anchor

# Build + deploy STEEL program
wsl bash /mnt/j/Poker-Arc/deploy.sh steel

# Deploy both
wsl bash /mnt/j/Poker-Arc/deploy.sh both
```

### Key Devnet Paths
- **Anchor deployer keypair:** `contracts/auth/deployers/anchor-mini-game-deployer-keypair.json`
- **RPC:** `https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df`

---

## Key Paths
- **Anchor .so:** `target/deploy/fastpoker.so`
- **Circuits source:** `encrypted-ixs/src/lib.rs`
- **Circuit artifacts:** `build/` (.arcis, .idarc, .hash, .weight, .ts)
- **Genesis artifacts:** `artifacts/` (*_raw_circuit_*.json)
- **STEEL .so:** `contracts/target/deploy/poker_program.so`
- **Localnet keypair:** `scripts/localnet-keypair.json` (copy of WSL `~/.config/solana/id.json`)
- **Build scripts:** `scripts/rebuild-circuits.sh`, `build-anchor.sh`
- **Init scripts:** `scripts/arcium-init-circuits.ts`, `scripts/update-genesis-circuits.ts`
- **Verify scripts:** `backend/verify-circuit-data.ts`

## Current Circuit Stats (14-output packed format)

| Circuit | .arcis Size | Weight (ACUs) | Outputs |
|---|---|---|---|
| `shuffle_and_deal` | 12,987,712 | 3,466,015,516 | 14 (9 packed hole + 5 community) |
| `reveal_community` | 327,432 | 241,706,528 | 5 (plaintext u8) |
| `reveal_showdown` | 1,030,504 | 532,983,680 | 18 (plaintext u8) |

### Packed Hole Card Format
- Each player's 2 hole cards packed into `Enc<Shared, u16>`: `card1 * 256 + card2`
- Client unpacks: `card1 = u16 >> 8`, `card2 = u16 & 0xFF`
- Reason: 23 separate outputs (736 bytes) exceeded single-TX callback limit (arx-node v0.8.5 has `multi-tx-callbacks` disabled)
