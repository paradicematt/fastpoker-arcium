#!/bin/bash
# Start Arcium localnet with full MPC infrastructure
# Run: wsl bash /mnt/j/Poker-Arc/scripts/start-arcium-localnet.sh
#
# KEY INSIGHT: arcium localnet must run from a native Linux filesystem (ext4),
# NOT from /mnt/j/ (NTFS), because:
# 1. solana-test-validator creates admin.rpc Unix domain socket in the ledger dir
# 2. Unix domain sockets don't work on NTFS in WSL
# 3. arcium CLI checks admin.rpc for node health → fails on NTFS
#
# Solution: Mirror the project to /tmp/poker-arc-workspace and run from there.
set -e

PROJECT="/mnt/j/Poker-Arc"
WORKSPACE="/tmp/poker-arc-workspace"

# === Environment Setup ===
SOLANA_DIR="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin"
AVM_DIR="$HOME/.avm/bin"
CARGO_DIR="$HOME/.cargo/bin"
export PATH="$SOLANA_DIR:$AVM_DIR:$CARGO_DIR:/usr/bin:/usr/local/bin:$PATH"
source ~/.cargo/env 2>/dev/null || true

echo "=== Environment ==="
echo "  Solana: $(solana --version 2>/dev/null || echo 'not found')"
echo "  Arcium: $(arcium --version 2>/dev/null || echo 'not found')"
echo "  Docker: $(docker --version 2>/dev/null || echo 'not found')"

# Install anchor shim that reports 0.31.2 (arcium CLI 0.8.5 hardcodes this check —
# this is a bug: official docs say 0.32.1, and 0.31.2 was never publicly released)
SHIM_DIR="/tmp/anchor-shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/anchor" << 'SHIMEOF'
#!/bin/bash
# Find real anchor binary (skip this shim via PATH manipulation)
REAL_ANCHOR="$HOME/.cargo/bin/anchor"
if [ ! -x "$REAL_ANCHOR" ]; then
    REAL_ANCHOR="$HOME/.avm/bin/anchor"
fi

if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then
    echo "anchor-cli 0.31.2"
elif [ "$1" = "localnet" ]; then
    # CRITICAL: Inject --skip-build so anchor doesn't try to compile.
    # Pre-built .so files are already in target/deploy/.
    # SBF rustc 1.79 can't handle newer crates (indexmap 2.13, proc-macro-crate 3.5).
    # Only add if not already present (arcium --skip-build may already pass it).
    if echo "$@" | grep -q -- '--skip-build'; then
        echo "[anchor-shim] 'anchor localnet' already has --skip-build"
        exec "$REAL_ANCHOR" "$@"
    else
        echo "[anchor-shim] Intercepting 'anchor localnet' → adding --skip-build"
        shift
        exec "$REAL_ANCHOR" localnet --skip-build "$@"
    fi
else
    exec "$REAL_ANCHOR" "$@"
fi
SHIMEOF
chmod +x "$SHIM_DIR/anchor"
export PATH="$SHIM_DIR:$PATH"
echo "  Anchor: $(anchor --version) [shim → real 0.32.1]"

# === Cleanup ===
echo ""
echo "=== Cleaning up ==="
pkill -f solana-test-validator 2>/dev/null || true
sleep 1

# Kill ALL arcium containers: arx-node-*, arcium-trusted-dealer-*, recovery-node-*
ARCIUM_CONTAINERS=$(docker ps -aq --filter "name=arx" --filter "name=arcium" --filter "name=recovery" 2>/dev/null || true)
if [ -n "$ARCIUM_CONTAINERS" ]; then
    docker stop $ARCIUM_CONTAINERS 2>/dev/null || true
    docker rm $ARCIUM_CONTAINERS 2>/dev/null || true
    echo "  Stopped old Arcium Docker containers"
fi
# Also stop via docker-compose if the file exists (catches any stragglers)
if [ -f "$PROJECT/artifacts/docker-compose-arx-env.yml" ]; then
    docker compose -f "$PROJECT/artifacts/docker-compose-arx-env.yml" down 2>/dev/null || true
fi
echo "  Cleanup done."

# === Create native Linux workspace ===
echo ""
echo "=== Creating ext4 workspace at $WORKSPACE ==="
# Clean workspace — Docker creates root-owned files, so use Docker to delete them
if [ -d "$WORKSPACE" ]; then
    docker run --rm -v "$WORKSPACE":/ws alpine rm -rf /ws/artifacts /ws/build /ws/encrypted-ixs /ws/programs /ws/contracts /ws/target 2>/dev/null || true
    rm -rf "$WORKSPACE" 2>/dev/null || true
fi
mkdir -p "$WORKSPACE"

# Copy what arcium localnet needs
cp "$PROJECT/Anchor.toml" "$WORKSPACE/"
cp "$PROJECT/Arcium.toml" "$WORKSPACE/"
cp "$PROJECT/Cargo.toml" "$WORKSPACE/" 2>/dev/null || true
# CRITICAL: Copy pre-pinned Cargo.lock so anchor localnet doesn't resolve fresh
# dependencies that require rustc >= 1.82 (SBF compiler ships 1.79)
cp "$PROJECT/Cargo.lock" "$WORKSPACE/" 2>/dev/null || true

# Circuits (encrypted-ixs source + build output)
cp -r "$PROJECT/encrypted-ixs" "$WORKSPACE/"
cp -r "$PROJECT/build" "$WORKSPACE/"

# Artifacts — DO NOT copy old artifacts from the project!
# arcium localnet generates everything fresh: genesis accounts, docker-compose,
# node configs, keypairs, TD identity. Copying stale artifacts causes TD peer ID
# mismatch (docker-compose references old identity, TD generates new one → nodes
# reject with "Peer ID mismatch").
# Only create empty directories that arcium expects.
mkdir -p "$WORKSPACE/artifacts/localnet"
mkdir -p "$WORKSPACE/artifacts/arx_node_logs"
mkdir -p "$WORKSPACE/artifacts/trusted_dealer_logs"

# Program .so files for genesis
mkdir -p "$WORKSPACE/contracts/target/deploy"
cp "$PROJECT/contracts/target/deploy/poker_program.so" "$WORKSPACE/contracts/target/deploy/" 2>/dev/null || true
mkdir -p "$WORKSPACE/target/deploy"
cp "$PROJECT/target/deploy/"*.so "$WORKSPACE/target/deploy/" 2>/dev/null || true

# Programs directory (Anchor.toml references it)
# CRITICAL: lib.rs MUST exist — arcium localnet parses the Anchor workspace
# and silently skips genesis account creation if it can't find the program source.
mkdir -p "$WORKSPACE/programs/fastpoker/src"
cp "$PROJECT/programs/fastpoker/Cargo.toml" "$WORKSPACE/programs/fastpoker/" 2>/dev/null || true
cp "$PROJECT/programs/fastpoker/Xargo.toml" "$WORKSPACE/programs/fastpoker/" 2>/dev/null || true
cp "$PROJECT/programs/fastpoker/src/lib.rs" "$WORKSPACE/programs/fastpoker/src/" 2>/dev/null || true
# Fallback: create minimal dummy if copy failed (e.g. file too large or missing)
if [ ! -f "$WORKSPACE/programs/fastpoker/src/lib.rs" ]; then
    echo 'use anchor_lang::prelude::*; declare_id!("BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N");' > "$WORKSPACE/programs/fastpoker/src/lib.rs"
    echo "  Created dummy lib.rs for Anchor workspace parsing"
fi

# Fix absolute paths in Anchor.toml
sed -i "s|/mnt/j/Poker-Arc/artifacts/|artifacts/|g" "$WORKSPACE/Anchor.toml"
sed -i "s|/mnt/j/Poker-Arc/||g" "$WORKSPACE/Anchor.toml"

echo "  Workspace ready."

# === Start Localnet ===
echo ""
echo "=== Starting Arcium Localnet ==="
echo "  Working dir: $WORKSPACE (ext4 — UDS will work)"
echo "  This starts: validator + Arcium MXE program + 4 Docker nodes + DKG"
echo "  Timeout: 120s (from Arcium.toml)"
echo ""

# === FIX: Docker container → host networking in WSL2 ===
# Arx containers are on arx_network (172.20.0.0/16). Configs use host.docker.internal
# which resolves to 172.17.0.1 (default bridge gateway). Containers on arx_network can't
# reach the default bridge directly.
#
# Fix: connect each container to the default bridge as a second network.
# Then host.docker.internal (172.17.0.1) is reachable via docker0.
# Inter-node P2P stays on arx_network (172.20.0.x addresses route via arx_network iface).
# No config patching needed — original host.docker.internal works.

cd "$WORKSPACE"
arcium localnet --skip-build &
ARCIUM_PID=$!

# Wait for Docker containers to start (means arcium finished generating configs)
echo "  Waiting for Docker containers to start..."
for i in $(seq 1 180); do
    RUNNING=$(docker ps --filter "name=arx-node" --format "{{.Names}}" 2>/dev/null | wc -l)
    if [ "$RUNNING" -ge 4 ]; then
        echo "  All 4 Docker node containers detected"
        break
    fi
    sleep 1
done

# Also wait for TD
for i in $(seq 1 30); do
    TD_UP=$(docker ps --filter "name=trusted-dealer" --format "{{.Names}}" 2>/dev/null | wc -l)
    if [ "$TD_UP" -ge 1 ]; then
        echo "  Trusted dealer container detected"
        break
    fi
    sleep 1
done

# Connect all containers to the default bridge (adds docker0 as second interface).
# This lets them reach host.docker.internal (172.17.0.1) for validator RPC.
echo "  Connecting containers to default bridge for host validator access..."
for CONTAINER in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1 artifacts-arcium-trusted-dealer-1; do
    docker network connect bridge "$CONTAINER" 2>/dev/null && echo "    $CONTAINER → bridge ✓" || echo "    $CONTAINER → bridge (skip/already)"
done
echo "  Done. Waiting for DKG (timeout=${LOCALNET_TIMEOUT:-600}s)..."

# Wait for arcium localnet to finish (DKG completion or timeout)
wait $ARCIUM_PID
EXIT_CODE=$?
exit $EXIT_CODE
