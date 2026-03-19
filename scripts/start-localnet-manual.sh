#!/bin/bash
# Start localnet with manual arx-node control
# Step 1: arcium localnet --skip-local-arx-nodes (starts validator + genesis only)
# Step 2: Modify docker-compose to use macvlan or host network
# Step 3: Start containers manually
set -e

PROJECT="/mnt/j/Poker-Arc"
WORKSPACE="/tmp/poker-arc-workspace"

# === Environment Setup ===
SOLANA_DIR="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin"
AVM_DIR="$HOME/.avm/bin"
CARGO_DIR="$HOME/.cargo/bin"
export PATH="$SOLANA_DIR:$AVM_DIR:$CARGO_DIR:/usr/bin:/usr/local/bin:$PATH"
source ~/.cargo/env 2>/dev/null || true

# Anchor shim
SHIM_DIR="/tmp/anchor-shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/anchor" << 'SHIMEOF'
#!/bin/bash
if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then
    echo "anchor-cli 0.31.2"
else
    exec "$HOME/.avm/bin/anchor" "$@"
fi
SHIMEOF
chmod +x "$SHIM_DIR/anchor"
export PATH="$SHIM_DIR:$PATH"

echo "=== Environment ==="
echo "  Solana: $(solana --version 2>/dev/null)"
echo "  Arcium: $(arcium --version 2>/dev/null)"
echo "  Anchor: $(anchor --version)"

# === Cleanup ===
echo ""
echo "=== Cleanup ==="
pkill -f solana-test-validator 2>/dev/null || true
sleep 1
docker ps -aq --filter "name=arx" --filter "name=arcium" --filter "name=recovery" 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
docker compose -f "$WORKSPACE/artifacts/docker-compose-arx-env.yml" down 2>/dev/null || true
echo "  Done"

# === Create workspace ===
echo ""
echo "=== Creating workspace ==="
if [ -d "$WORKSPACE" ]; then
    docker run --rm -v "$WORKSPACE":/ws alpine rm -rf /ws/artifacts /ws/build /ws/encrypted-ixs /ws/programs /ws/contracts /ws/target 2>/dev/null || true
    rm -rf "$WORKSPACE" 2>/dev/null || true
fi
mkdir -p "$WORKSPACE"

cp "$PROJECT/Anchor.toml" "$WORKSPACE/"
cp "$PROJECT/Arcium.toml" "$WORKSPACE/"
cp "$PROJECT/Cargo.toml" "$WORKSPACE/" 2>/dev/null || true
cp -r "$PROJECT/encrypted-ixs" "$WORKSPACE/"
cp -r "$PROJECT/build" "$WORKSPACE/"
cp -r "$PROJECT/artifacts" "$WORKSPACE/"

# Clean stale keypairs
rm -f "$WORKSPACE/artifacts/localnet/node_"*.json 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/localnet/node_callback_"*.json 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/localnet/node_bls_"*.json 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/localnet/node_x25519_"*.json 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/localnet/identity_"*.pem 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/localnet/td_"*.pem 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/localnet/td_"*.json 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/trusted_dealer_logs/"*.log 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/arx_node_logs/"*.log 2>/dev/null || true

mkdir -p "$WORKSPACE/contracts/target/deploy"
cp "$PROJECT/contracts/target/deploy/poker_program.so" "$WORKSPACE/contracts/target/deploy/" 2>/dev/null || true
mkdir -p "$WORKSPACE/target/deploy"
cp "$PROJECT/target/deploy/"*.so "$WORKSPACE/target/deploy/" 2>/dev/null || true

# CRITICAL: lib.rs must exist for Anchor workspace parsing
mkdir -p "$WORKSPACE/programs/fastpoker/src"
cp "$PROJECT/programs/fastpoker/Cargo.toml" "$WORKSPACE/programs/fastpoker/" 2>/dev/null || true
cp "$PROJECT/programs/fastpoker/Xargo.toml" "$WORKSPACE/programs/fastpoker/" 2>/dev/null || true
cp "$PROJECT/programs/fastpoker/src/lib.rs" "$WORKSPACE/programs/fastpoker/src/" 2>/dev/null || true
if [ ! -f "$WORKSPACE/programs/fastpoker/src/lib.rs" ]; then
    echo 'use anchor_lang::prelude::*; declare_id!("BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N");' > "$WORKSPACE/programs/fastpoker/src/lib.rs"
fi

sed -i "s|/mnt/j/Poker-Arc/artifacts/|artifacts/|g" "$WORKSPACE/Anchor.toml"
sed -i "s|/mnt/j/Poker-Arc/||g" "$WORKSPACE/Anchor.toml"
echo "  Workspace ready"

# === Step 1: Start validator + genesis ONLY (no Docker) ===
echo ""
echo "=== Step 1: Starting validator + genesis (--skip-local-arx-nodes) ==="
echo "  This starts the validator and creates genesis accounts but does NOT start Docker containers."
echo "  Press Ctrl+C to stop when you see slot progress."
cd "$WORKSPACE"
arcium localnet --skip-build --skip-local-arx-nodes &
ARCIUM_PID=$!
echo "  arcium localnet PID: $ARCIUM_PID"

# Wait for validator to be ready
echo "  Waiting for validator..."
for i in $(seq 1 60); do
    if curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q "ok"; then
        echo "  Validator healthy after ${i}s"
        break
    fi
    sleep 1
done

# === Step 2: Verify genesis accounts ===
echo ""
echo "=== Step 2: Checking genesis accounts ==="
# Check if node keypairs were generated
ls -la "$WORKSPACE/artifacts/localnet/node_0.json" 2>/dev/null && echo "  node_0 keypair exists" || echo "  ERROR: no node_0 keypair"

# Check docker-compose was generated
ls -la "$WORKSPACE/artifacts/docker-compose-arx-env.yml" 2>/dev/null && echo "  docker-compose exists" || echo "  ERROR: no docker-compose"

# Check on-chain accounts
echo "  Checking Arcium program..."
solana program show arcm3GFBH8FfG8TG1ddxF7dRhKEyD28RnxaXXoGRecJY -u localhost 2>&1 | head -5

echo ""
echo "=== Step 3: Start Docker containers manually ==="
echo "  Modifying docker-compose for host networking..."

# Patch docker-compose: add UDP port 8001 mapping for each node
COMPOSE="$WORKSPACE/artifacts/docker-compose-arx-env.yml"
if [ -f "$COMPOSE" ]; then
    # The issue: QUIC/UDP doesn't work reliably on Docker bridge in WSL2.
    # Workaround: expose UDP 8001 on different host ports, and reconfigure nodes.
    # Actually simpler: just start the compose as-is and see if genesis is the fix.
    echo "  Starting containers..."
    docker compose -f "$COMPOSE" up -d 2>&1
    echo "  Containers started"
    
    echo ""
    echo "=== Step 4: Monitor DKG (10 min) ==="
    START_TIME=$(date +%s)
    while true; do
        ELAPSED=$(( $(date +%s) - START_TIME ))
        if [ $ELAPSED -gt 600 ]; then
            echo "  Timeout after 600s"
            break
        fi
        
        # Check health
        HEALTH=$(curl -s -m 2 http://localhost:9091/health 2>/dev/null)
        if [ -n "$HEALTH" ]; then
            echo "  [${ELAPSED}s] Health: $HEALTH"
            if echo "$HEALTH" | grep -qi "ok"; then
                echo "  DKG COMPLETE! Nodes are healthy."
                break
            fi
        fi
        
        # Check TD progress
        TD_LOG=$(ls -t "$WORKSPACE/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1)
        if [ -n "$TD_LOG" ]; then
            CONN=$(grep -c "Connections established" "$TD_LOG" 2>/dev/null || echo 0)
            if [ "$CONN" -gt 0 ]; then
                echo "  [${ELAPSED}s] TD connections established!"
            fi
        fi
        
        # Check node 0 for DKG
        N0_LOG=$(ls -t "$WORKSPACE/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
        if [ -n "$N0_LOG" ]; then
            DKG=$(grep -c "dkg\|DKG\|key_gen" "$N0_LOG" 2>/dev/null || echo 0)
            if [ "$DKG" -gt 0 ]; then
                echo "  [${ELAPSED}s] Node 0 has DKG activity!"
            fi
        fi
        
        sleep 5
    done
fi

echo ""
echo "=== Status ==="
docker ps --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null
echo ""
echo "arcium localnet PID: $ARCIUM_PID (still running in background)"
echo "To stop: kill $ARCIUM_PID; docker compose -f $COMPOSE down"
